import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { nanoid } from "nanoid";
import type { NonMcpResources, ToolCallContext, McpToolResult, McpToolDescriptor } from "../mcp/types.js";
import type { Credentials, HitlConfig, Resource } from "../types/resources.js";
import { RemoteSandboxBackend, type ExecBackend } from "./exec-backend.js";
import { SKILL_TOOL_DESCRIPTORS } from "./skill-tools.js";
import type { RunloopEvent } from "../types/events.js";
import { EventType } from "../types/events.js";
import { createEvent } from "../events/factory.js";
import { buildToolDescriptors, findResolvedTool, handleToolCall, resolveToolTarget } from "../mcp/tool-registry.js";
import { computeBindingHash } from "../hitl/binding.js";
import { SandboxProvisioner, createArSandboxProvisioner } from "./sandbox-provisioner.js";
import { SHELL_TOOL_DESCRIPTOR, SHELL_TOOL_NAME } from "./shell-exec.js";
import { evaluateStaticRules } from "../hitl/rules.js";
import type { LlmJudge } from "../hitl/judge.js";
import { type HitlPhrasing, StaticHitlPhrasing } from "../hitl/phrasing.js";
import { decideHitlSurface, deriveSuspendKind, type HitlClientCapabilitiesView } from "../hitl/surface.js";
import { type HitlSurfaceMapper, StaticHitlSurfaceMapper } from "../hitl/surface-map.js";
import type { ClientTool } from "../types/resources.js";
import { Logger, type LoggerOptions } from "../util/logger.js";
import { ImageTools, IMAGE_TOOL_DESCRIPTORS, type ImageCredentialProvider } from "./image-tools.js";
import { withToolEvents } from "../mcp/tool-events.js";

interface GateResult {
  result: McpToolResult;
  /** Pending interactions already own their start/end/suspend events. */
  pending: boolean;
}

/**
 * HITL ask 原语（AD-026 增补：单一 schema-驱动 ask 原语）。模型侧**只暴露这一个** HITL 触发工具，
 * 由 `responseSchema` 一字段驱动确认/多选/取值三形态——省略=是非确认（吸收旧 request_confirmation）、
 * 带 enum=多选、带 type/对象=取值/结构化输入。
 */
export const REQUEST_USER_INPUT_TOOL = "request_user_input";

/** HITL ask 原语描述符（sidecar `/tools` 与 MCP server tools/list 共用，单一定义） */
export const REQUEST_USER_INPUT_DESCRIPTOR: McpToolDescriptor = {
  name: REQUEST_USER_INPUT_TOOL,
  description:
    "向用户提问并暂停本轮、等用户回复后再继续（HITL ask 原语）。" +
    "当你需要用户确认某操作、在若干选项中选择、或提供一个缺失的值时调用本工具，不要用纯文本提问、也不要擅自替用户决定。" +
    "用 responseSchema 表达想要的回复形态：省略 responseSchema = 是非确认（用户答同意/拒绝）；" +
    "responseSchema 带 enum（如 {\"enum\":[\"A\",\"B\"]}）= 让用户在选项中选一个；" +
    "responseSchema 带 type（如 {\"type\":\"string\"}）= 让用户填写一个值。",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "展示给用户的提问文本" },
      responseSchema: {
        type: "object",
        description: "期望回复的 JSON Schema（可选）：省略=是非确认；带 enum=多选；带 type=取值。",
      },
    },
    required: ["prompt"],
  },
};

/**
 * 旧版二元确认元工具名（HITL 辅轨，AD-026）。已被单一 ask 原语 `request_user_input` 吸收——
 * 语义 = 无 responseSchema 的 request_user_input。**保留为向后兼容别名**：模型侧不再暴露它，
 * 但 sidecar/resume 仍按辅轨识别这个名字（旧客户端/历史事件可能仍用它）。
 */
export const REQUEST_CONFIRMATION_TOOL = "request_confirmation";

/** request_confirmation 描述符（向后兼容保留；不再注入到工具列表，由 REQUEST_USER_INPUT_DESCRIPTOR 取代）。 */
export const REQUEST_CONFIRMATION_DESCRIPTOR: McpToolDescriptor = {
  name: REQUEST_CONFIRMATION_TOOL,
  description: "请求用户确认后再继续。当你判断某操作需要人工确认时调用本工具，调用后本轮会挂起等待用户审批。",
  inputSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "需要确认的原因" },
      detail: { type: "string", description: "操作详情（可选）" },
    },
    required: ["reason"],
  },
};

/** ask 原语集合（辅轨）：单一 request_user_input + 向后兼容别名 request_confirmation。 */
function isAskPrimitive(name: string): boolean {
  return name === REQUEST_USER_INPUT_TOOL || name === REQUEST_CONFIRMATION_TOOL;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 从 responseSchema 提取枚举值（兼容 {enum:[...]} 与 {type,enum:[...]}）。无/空枚举返回 undefined。 */
function extractEnumValues(schema?: Record<string, unknown>): string[] | undefined {
  const e = schema?.enum;
  return Array.isArray(e) && e.length > 0 ? e.map((v) => String(v)) : undefined;
}

interface AskSuspendFields {
  prompt: string;
  options: Array<{ optionId: string; label: string; kind: string; matchWords?: string[] }>;
  interactionKind?: "confirmation" | "input_required";
  responseSchema?: Record<string, unknown>;
}

/**
 * 由 ask 原语（request_user_input / 别名 request_confirmation）的 args 派生 suspend 的交互形态
 * （AD-026 增补 · 单一 schema-驱动 ask 原语）：
 *  - 无 responseSchema → 二元确认：interactionKind=confirmation，approve/reject + 肯定/否定 matchWords；
 *  - responseSchema 带 enum → 多选：每个枚举值一个 option（matchWords=该值），carry responseSchema，
 *    **不设 input_required**——多选有 options、靠 matchWords 匹配枚举值（区别于取值通道）；
 *  - responseSchema 无 enum（{type:...}/对象）→ 取值：interactionKind=input_required、options 空、
 *    carry responseSchema（复用现有 input_required 通道）。
 * prompt 由模型提供（args.prompt）优先，缺省回落 phrasing。非 ask 原语（主轨静态规则/judge）维持二元 approve/reject。
 */
function deriveAskSuspendFields(
  name: string,
  args: Record<string, unknown>,
  phr: { prompt: string; affirmativeWords: string[]; negativeWords: string[] },
): AskSuspendFields {
  const binaryOptions = [
    { optionId: "approve", label: "允许这一次", kind: "allow_once", matchWords: phr.affirmativeWords },
    { optionId: "reject", label: "拒绝", kind: "reject_once", matchWords: phr.negativeWords },
  ];
  // 主轨（静态规则/judge）：维持二元 approve/reject，prompt 用 phrasing 生成。
  if (!isAskPrimitive(name)) return { prompt: phr.prompt, options: binaryOptions };

  // ask 原语：prompt 由模型提供（args.prompt）优先，缺省回落 phrasing。
  const modelPrompt = typeof args.prompt === "string" && args.prompt.trim() ? args.prompt.trim() : undefined;
  const prompt = modelPrompt ?? phr.prompt;
  const schema = isPlainObject(args.responseSchema) ? args.responseSchema : undefined;
  const enumValues = extractEnumValues(schema);

  if (enumValues) {
    // 多选：每个枚举值一个 option（matchWords=该值）；carry responseSchema；不设 input_required。
    return {
      prompt,
      responseSchema: schema,
      options: enumValues.map((v) => ({ optionId: v, label: v, kind: "allow_once", matchWords: [v] })),
    };
  }
  if (schema) {
    // 取值/结构化输入：input_required、options 空、carry responseSchema。
    return { prompt, responseSchema: schema, interactionKind: "input_required", options: [] };
  }
  // 缺省（无 responseSchema）：二元确认（吸收 request_confirmation）。
  return { prompt, interactionKind: "confirmation", options: binaryOptions };
}

export interface SidecarServerOptions {
  resources: NonMcpResources;
  credentials?: Credentials;
  emit?: (event: RunloopEvent) => void;
  conversationId?: string;
  /** HITL 配置（主轨静态规则）；enabled 时辅轨 ask 原语 request_user_input 也可用 */
  hitl?: HitlConfig;
  /** 透传到下游 agentrun 资源调用的全局 header */
  headers?: Record<string, string>;
  /** HITL 挂起屏障回调：sidecar 决定挂起后通知 runner 立即中断 codex */
  onSuspend?: () => void;
  /** 沙箱实例编排（SANDBOX_TEMPLATE 懒创建/回收）；缺省时若有 SANDBOX_TEMPLATE 资源则自建真实 AR provisioner，测试可注入 mock。 */
  sandboxProvisioner?: SandboxProvisioner;
  /** HITL 第三轨（AD-004 三层）：静态规则放行时再问 LLM judge（reason:llm_judge） */
  llmJudge?: LlmJudge;
  /** HITL NL 降级措辞服务（AD-026 增补）：suspend 时生成 prompt + 肯定/否定触发词；缺省走静态模板兜底（无模型调用）。 */
  phrasing?: HitlPhrasing;
  /**
   * F3 纯 HITL LLM 映射（AD-026 增补）：呈现选择判定 needsLlm 时，把 suspend 映射到最适合渲染的客户端工具；
   * 缺省走静态映射兜底（无模型调用）。
   */
  surfaceMapper?: HitlSurfaceMapper;
  /** 客户端声明、客户端执行的工具（消费通道 2）：F3 surface 映射的候选工具（name + description）。 */
  clientTools?: ClientTool[];
  /** 会话级粘性授权（Phase 2 allow_always/reject_always，从历史派生）：toolName 集合 */
  grantedAllow?: Set<string>;
  grantedReject?: Set<string>;
  /** Option B：暴露内置 `shell` 执行工具（codex 内建 shell 关闭后，执行改走本工具）。 */
  execShell?: boolean;
  imageCredentialProvider?: ImageCredentialProvider;
  imageCredentialName?: string;
  /** 内置 `shell` 工具的执行工作目录（通常为会话 workspace）。 */
  workdir?: string;
  /**
   * 系统实例远端执行（AGENTCORE_REMOTE_SHELL）：注入此 Sandbox 资源后，bash/文件工具一律打到该隔离沙箱数据面
   * （不在本地 fs 落地）。未设 → 走本地后端（workdir）。
   */
  remoteExecSandbox?: Resource;
  /** 沙箱内运行目录（复用 request.agent.cwd）：远端 bash 的 cwd / 相对文件路径基址 / skill 同步根。 */
  remoteExecCwd?: string;
  /** Deployment-owned execution backend (for example Alibaba Cloud Agent Sandbox via E2B). */
  execBackend?: ExecBackend;
  logger?: LoggerOptions;
}

/**
 * Sidecar HTTP server — 进程内启动，暴露简单 REST API 供 workspace 内的 CLI 脚本调用。
 * 类似 k8s sidecar：与主进程同生命周期，不跨网络，只监听 127.0.0.1。
 */
export class SidecarServer {
  private server: Server | null = null;
  private _port = 0;
  private readonly resources: NonMcpResources;
  private readonly ctx: ToolCallContext;
  private readonly hitl?: HitlConfig;
  private readonly onSuspend?: () => void;
  private readonly llmJudge?: LlmJudge;
  private readonly phrasing: HitlPhrasing;
  private readonly surfaceMapper: HitlSurfaceMapper;
  private readonly clientCapabilities?: HitlClientCapabilitiesView;
  private readonly clientTools: ClientTool[];
  private readonly grantedAllow: Set<string>;
  private readonly grantedReject: Set<string>;
  private readonly sandboxProvisioner?: SandboxProvisioner;
  private readonly execShell: boolean;
  private readonly remoteBackend?: RemoteSandboxBackend;
  private readonly log: Logger;

  constructor(options: SidecarServerOptions) {
    this.resources = options.resources;
    this.hitl = options.hitl;
    this.onSuspend = options.onSuspend;
    this.llmJudge = options.llmJudge;
    this.phrasing = options.phrasing ?? new StaticHitlPhrasing();
    // F3 呈现映射：缺省静态映射兜底（无模型调用）；clientCapabilities 从 hitl 配置读取（呈现选择权威）。
    this.surfaceMapper = options.surfaceMapper ?? new StaticHitlSurfaceMapper();
    this.clientCapabilities = options.hitl?.clientCapabilities;
    this.clientTools = options.clientTools ?? [];
    this.grantedAllow = options.grantedAllow ?? new Set();
    this.grantedReject = options.grantedReject ?? new Set();
    this.log = new Logger("agentrun", options.logger ?? {});
    // 仅当存在 SANDBOX_TEMPLATE 资源时才建 provisioner（避免无谓的 AR client）；可注入 mock。
    const hasTemplate = options.resources.sandboxes.some((s) => s.resourceType === "SANDBOX_TEMPLATE");
    this.sandboxProvisioner = options.sandboxProvisioner ?? (hasTemplate ? createArSandboxProvisioner(this.log) : undefined);
    this.execShell = options.execShell ?? false;
    // 系统实例远端执行：bash/文件工具改打隔离沙箱数据面（密钥不外泄）；未设则走本地后端。
    // cwd 复用 request.agent.cwd（remoteExecCwd）作沙箱内运行目录 / skill 同步根。
    this.remoteBackend = options.remoteExecSandbox
      ? new RemoteSandboxBackend(options.remoteExecSandbox, options.credentials, this.sandboxProvisioner, options.remoteExecCwd, this.log)
      : undefined;
    const execBackend = options.execBackend ?? this.remoteBackend;
    this.ctx = {
      resources: options.resources,
      credentials: options.credentials,
      emit: options.emit,
      conversationId: options.conversationId,
      headers: options.headers,
      onSuspend: options.onSuspend,
      sandboxProvisioner: this.sandboxProvisioner,
      workdir: options.workdir,
      execBackend,
      imageTools: options.imageCredentialProvider && options.workdir && !execBackend
        ? new ImageTools(options.workdir, options.imageCredentialProvider, options.imageCredentialName)
        : undefined,
      log: this.log, // 资源调用器（子 agent/openapi/下游 MCP）据此记录出站请求/响应内容
    };
  }

  /**
   * 执行一个工具（绕过 HITL 闸门）——供 HITL execute-on-resume 用：审批通过后用历史 args 代执行真实 op。
   * 一次性 approval capability 的具体化：直接 handleToolCall，不再过 ask 规则（否则会再次挂起）。
   */
  async executeTool(name: string, args: Record<string, unknown>, opts?: { idempotencyKey?: string }): Promise<McpToolResult> {
    if (!this.execShell && (name === SHELL_TOOL_NAME || ["read_file", "write_file", "edit_file", "grep", "glob"].includes(name))) {
      return { isError: true, content: [{ type: "text", text: "Local MCP execution is disabled" }] };
    }
    // 下游幂等键（H5）：execute-on-resume 传 conversationId:suspendEventId，让支持的下游按 key 去重（exactly-once）。
    // The resume resolver owns the approved call's original ID and result event.
    const ctx = { ...this.ctx, emitToolLifecycle: false, idempotencyKey: opts?.idempotencyKey };
    return handleToolCall(name, args, ctx);
  }

  enableToolEvents(): void {
    this.ctx.emitToolLifecycle = true;
  }

  /** 工具的审批绑定哈希（H5）：toolName + 当前 resources 解析出的执行端点签名。suspend 记录、resume 校验。 */
  bindingHashFor(name: string): string {
    return computeBindingHash(name, resolveToolTarget(name, this.ctx.resources));
  }

  /**
   * 呈现选择（AD-026 增补 · 触发 ⊥ 呈现）：按 hitl.clientCapabilities 配置选定该 suspend 怎么递给人。
   * decideHitlSurface 给出确定性决策；needsLlm（有 client tool 渲染能力但当前 kind 无显式映射）时再调
   * F3 surfaceMapper（注入则用、否则静态兜底）定具体工具——选不到则回落 nl。
   */
  private async resolveSurface(ask: AskSuspendFields): Promise<{ surface: "native" | "client_tool" | "nl"; renderTool?: string }> {
    const decision = decideHitlSurface(ask, this.clientCapabilities);
    if (decision.mode !== "client_tool") return { surface: decision.mode };
    if (decision.toolName) return { surface: "client_tool", renderTool: decision.toolName };
    // needsLlm：交 F3 映射。无合适工具 → nl 兜底。
    const mapped = await this.surfaceMapper.map({
      prompt: ask.prompt,
      kind: deriveSuspendKind(ask),
      options: ask.options.map((o) => o.label),
      clientTools: this.clientTools.map((t) => ({ name: t.name, description: t.description })),
    });
    return mapped.toolName ? { surface: "client_tool", renderTool: mapped.toolName } : { surface: "nl" };
  }

  /**
   * 带 HITL 主轨闸门的工具执行（AD-026）：先过 maybeSuspend（静态规则/辅轨/judge + 粘性授权），
   * 命中即返回 pending 结果（已 emit suspend 事件 + 通知 runner 中断）；否则正常 handleToolCall。
   * 这是**唯一**对外的"受闸门保护"的执行入口——sidecar `.tools/agentrun` 与进程内 MCP server 共用它，
   * 保证无论 codex 经 shell 还是原生 MCP 调用，主轨拦截都生效。
   */
  async gatedExecute(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (!this.execShell && (name === SHELL_TOOL_NAME || ["read_file", "write_file", "edit_file", "grep", "glob"].includes(name))) {
      return { isError: true, content: [{ type: "text", text: "Local MCP execution is disabled" }] };
    }
    const gate = await this.maybeSuspend(name, args);
    if (gate?.pending) return gate.result;
    if (gate) return withToolEvents(name, args, this.ctx, async () => gate.result);
    return handleToolCall(name, args, this.ctx);
  }

  /**
   * 工具清单（buildToolDescriptors + HITL 辅轨 ask 原语 request_user_input）。
   * sidecar `/tools` 与 MCP server 的 tools/list 共用，保证两路暴露的工具集合一致。
   */
  listTools(): McpToolDescriptor[] {
    const tools: McpToolDescriptor[] = buildToolDescriptors(this.resources);
    if (this.ctx.imageTools) tools.push(...IMAGE_TOOL_DESCRIPTORS);
    if (this.execShell) tools.push(SHELL_TOOL_DESCRIPTOR);
    // skill 读取工具 get_skill：仅**零执行态（无 shell，!execShell）**注入，作为读 skill 正文的唯一通道。
    // 有 shell（execShell）时 skill 已落盘/同步进沙箱，模型用标准 read_file/bash 读，不透出 get_skill
    // （与 buildExtraTools 的门控一致，见 src/loop/extra-tools.ts / Change A）。
    if (!this.execShell && (this.resources.skills ?? []).length > 0) tools.push(...SKILL_TOOL_DESCRIPTORS);
    // HITL 辅轨：暴露单一 ask 原语 request_user_input（吸收旧 request_confirmation）。
    if (this.hitl?.enabled) tools.push(REQUEST_USER_INPUT_DESCRIPTOR);
    return tools;
  }

  /**
   * 会话级远端环境初始化（仅有 Sandbox）：让沙箱内 read_file/bash 能读取并执行 skill。
   * **默认链路（Change B / option b）**：在沙箱内直接 curl 下载 + 解包 skill（二进制安全、不经本地盘）。
   * 旧链路 `RemoteSandboxBackend.initEnvironment`（本地解包 → 数据面 text writeFile 同步）作为死代码保留——
   * 它对二进制不安全（utf8 同步损坏），仅在需回退时手动切回。best-effort——失败仅警告、不阻断 run。
   */
  async initRemoteSandbox(_opts: { localWorkspaceDir: string }): Promise<void> {
    if (!this.remoteBackend) return;
    try {
      const n = await this.remoteBackend.downloadSkillsIntoSandbox(this.resources.skills ?? []);
      this.log.info("remote sandbox skills downloaded", { skills: n });
    } catch (err) {
      this.log.warn("remote sandbox skill download failed (non-fatal)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** HITL 辅轨是否启用（runner 据此给 MCP server 传 extraTools）。 */
  get hitlEnabled(): boolean {
    return !!this.hitl?.enabled;
  }

  /**
   * HITL 嵌套审批向下转发（AD-026）：把审批沿委派链转发给对应子 agent（runloop 协议），
   * 由子 agent 在自己帧里 execute-on-resume。**父层永不代执行子层 op**——这里只是 resume 调用子 agent。
   * 返回委派 toolresult（子 agent 恢复后的输出）。
   */
  async forwardNestedResolution(input: {
    delegationToolCallId?: string;
    delegationToolName?: string;
    childHistory: RunloopEvent[];
    suspendToolCallId: string;
    selectedOptionId: string;
    payload?: Record<string, unknown>;
    /** 原始委派任务——无状态子 agent（serverManagesHistory=false）重建完整 messages 用，置于子帧最前。 */
    delegationTask?: string;
  }): Promise<{ nestedResult?: unknown; delegationResult?: unknown; isError?: boolean; reSuspended?: boolean; childEvents?: RunloopEvent[] }> {
    // 按权威工具索引把委派工具名映射回子 agent（取代按 `delegate_to_` 前缀裸剥——严格统一命名后名字无固定前缀）。
    // 用 findResolvedTool（两头通）：历史里的 delegationToolName 是**还原后的原始名**（rawName），而工具索引的
    // t.name 是**压缩后的 wire 名**——长资源名（如真实部署的 agent 名）触发哈希压缩时二者不等，按 t.name 严格匹配
    // 会落空 → 嵌套 HITL 向下转发误判 forwarded_no_child（本地短名不压缩故掩盖，真实部署长名暴露）。
    const resolved = input.delegationToolName
      ? findResolvedTool(this.resources, input.delegationToolName)
      : undefined;
    const agent = resolved?.kind === "delegate" ? resolved.agent : undefined;
    if (!agent || !this.ctx.credentials) {
      return { delegationResult: { status: "forwarded_no_child", delegation: input.delegationToolName }, isError: true };
    }
    const { callSubAgent } = await import("./sub-agent-caller.js");
    // 子帧 events：去掉父级注入的 parentToolCallId/conversationId（还原成子 agent 自己的视角）+ 续接 resolve 命令。
    // 原始委派任务置于最前（父历史里子帧切片只有冒泡的 suspend、缺原始任务）——无状态子 agent 据此重建完整 messages；
    // 服务端自管会话的子 agent 走增量、buildAgUiResumeBody 会丢弃 messages，故此前置项对其无副作用。
    const childEvents: Record<string, unknown>[] = [];
    if (input.delegationTask) {
      childEvents.push({ type: "user.message", content: input.delegationTask });
    }
    for (const e of input.childHistory) {
      const { parentToolCallId: _p, conversationId: _c, ...rest } = e as Record<string, unknown>;
      childEvents.push(rest);
    }
    childEvents.push({
      type: "user.command",
      command: "resolve",
      toolCallId: input.suspendToolCallId,
      selectedOptionId: input.selectedOptionId,
      ...(input.payload ? { payload: input.payload } : {}),
    });
    // 收集子 agent resume 的翻译后事件（带 parentToolCallId=委派 id、conversationId=父会话）——
    // 多轮嵌套（P3）：子 agent resume 后又挂起时，把新子 suspend 透传回父流。emit 同时使 callSubAgent
    // 能检测到二次 suspend（无 emit 则当文本累积、检测不到）。正常完成时 collected 丢弃、返回文本不变。
    const collected: RunloopEvent[] = [];
    // 超时走 callSubAgent 默认：总时长 1h 硬顶 + 5min 空闲断开（env 可覆盖）。
    const result = await callSubAgent(agent, "", this.ctx.credentials, {
      resumeEvents: childEvents,
      emit: (e) => collected.push(e),
      toolCallId: input.delegationToolCallId,
      conversationId: this.ctx.conversationId,
      globalHeaders: this.ctx.headers,
      log: this.ctx.log, // 记录向下 resume 的出站请求/响应（含 interruptId）——之前没传 log，嵌套 HITL resume 链路在日志里不可见。
    });
    // 子 agent resume 后又挂起（__hitl_suspended）→ 多轮嵌套：透传新子 suspend、标记 reSuspended（委派未完成）。
    let suspended = false;
    try { suspended = Boolean((JSON.parse(result) as { __hitl_suspended?: boolean }).__hitl_suspended); } catch { /* 非 JSON = 普通文本结果 */ }
    if (suspended) {
      return { nestedResult: { status: "resolved_by_child" }, reSuspended: true, childEvents: collected };
    }
    return { nestedResult: { status: "resolved_by_child" }, delegationResult: result, isError: result.startsWith('{"error"') };
  }

  get port(): number { return this._port; }
  get baseUrl(): string { return `http://127.0.0.1:${this._port}`; }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer(async (req, res) => {
        try {
          await this.handleHttp(req, res);
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: String(err) }));
          }
        }
      });
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address();
        if (addr && typeof addr === "object") {
          this._port = addr.port;
          this.log.info("sidecar started", { baseUrl: this.baseUrl });
          resolve(this._port);
        } else {
          reject(new Error("Failed to get server address"));
        }
      });
      this.server.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    this.log.info("sidecar stopping", { port: this._port });
    // 会话结束：回收所有懒创建的沙箱实例（best-effort，不阻断关闭）。
    await this.sandboxProvisioner?.recycleAll(this.ctx.credentials).catch(() => {});
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /**
   * 判定一次工具调用是否需 HITL 挂起。挂起时产出 toolcall.start→end→suspend 三事件（共享 toolCallId），
   * 通知 runner 中断 codex（硬执行屏障），并返回 pending 结果给 .tools/agentrun（codex 随即被 kill）。
   * 返回 null 表示无需挂起、照常执行。
   */
  private async maybeSuspend(name: string, args: Record<string, unknown>): Promise<GateResult | null> {
    if (!this.hitl?.enabled) return null;

    // Phase 2 会话级粘性授权（从历史派生）：always-allow 直接放行；always-reject 直接拒绝（不挂起）。
    if (this.grantedAllow.has(name)) return null;
    if (this.grantedReject.has(name)) {
      return {
        pending: false,
        result: {
          content: [{ type: "text", text: JSON.stringify({ status: "denied_by_user", reason: "session policy: reject_always", hint: "操作未执行；用户已对该工具设为始终拒绝" }) }],
          isError: true,
        },
      };
    }

    // 三层判定（AD-004）：辅轨 ask 原语 → 静态规则 → LLM judge。命中 ask/block 即挂起。
    let reason: "static_rule" | "model_request" | "llm_judge";
    let blocked = false; // action:"block" = 硬拒（区别于 ask 的挂起待批）
    if (isAskPrimitive(name)) {
      reason = "model_request";
    } else {
      const staticDecision = evaluateStaticRules(name, args, this.hitl);
      if (staticDecision.action === "block") {
        reason = "static_rule";
        blocked = true;
      } else if (staticDecision.action === "ask") {
        reason = "static_rule";
      } else if (this.llmJudge) {
        const judged = await this.llmJudge.evaluate({ toolName: name, args });
        if (judged.action === "block") {
          reason = "llm_judge";
          blocked = true;
        } else if (judged.action === "ask") {
          reason = "llm_judge";
        } else {
          return null; // judge 放行
        }
      } else {
        return null; // 静态放行、无 judge
      }
    }

    // 硬拒：不挂起、不执行、不给批准选项，直接返回 denied 结果（区别于 ask 的 suspend+approve）。
    if (blocked) {
      this.log.info("hitl blocked", { name, reason });
      return {
        pending: false,
        result: {
          content: [{ type: "text", text: JSON.stringify({ status: "blocked_by_policy", reason, hint: "该工具被 HITL 策略禁止（block），未执行；请换方案或回问用户" }) }],
          isError: true,
        },
      };
    }

    const toolCallId = `hitl-${nanoid()}`;
    const cid = this.ctx.conversationId;

    if (this.ctx.emit && cid) {
      // NL 降级措辞（AD-026 增补）：out-of-band 生成 prompt + 肯定/否定触发词（缺省静态兜底），
      // 持久化进 suspend payload，供纯文本上游降级提问 + resume 时确定性匹配。
      const phr = await this.phrasing.phrase({ toolName: name, args, reason });
      // ask 原语（辅轨）按 args.responseSchema 派生确认/多选/取值形态；主轨维持二元 approve/reject。
      const ask = deriveAskSuspendFields(name, args, phr);
      // 呈现选择（config 驱动 + F3 LLM 映射）：标记建议怎么递给人（native / client_tool+renderTool / nl）。
      const { surface, renderTool } = await this.resolveSurface(ask);
      this.ctx.emit(createEvent(EventType.ToolcallStart, cid, { toolCallId, toolName: name }));
      this.ctx.emit(createEvent(EventType.ToolcallEnd, cid, { toolCallId, args }));
      this.ctx.emit(createEvent(EventType.ToolcallSuspend, cid, {
        toolCallId,
        toolName: name,
        args,
        bindingHash: this.bindingHashFor(name), // 审批绑定（H5）：记录批准时的执行端点签名
        reason,
        prompt: ask.prompt,
        ...(ask.interactionKind ? { interactionKind: ask.interactionKind } : {}),
        ...(ask.responseSchema ? { responseSchema: ask.responseSchema } : {}),
        surface,
        ...(renderTool ? { renderTool } : {}),
        options: ask.options,
      }));
    }

    this.log.info("hitl suspend", { name, toolCallId, reason });
    // 硬执行屏障：通知 runner 立即中断 codex（不能仅靠这条 HTTP 响应停住 codex）。
    if (this.onSuspend) this.onSuspend();

    return {
      pending: true,
      result: {
        content: [{ type: "text", text: JSON.stringify({ status: "hitl_pending", toolCallId, message: "awaiting user approval" }) }],
        isError: false,
      },
    };
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this._port}`);
    const path = url.pathname;

    this.log.info("http request", { method: req.method, path });

    if (req.method === "GET" && path === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (req.method === "GET" && path === "/tools") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ tools: this.listTools() }));
      return;
    }

    if (req.method === "POST" && path === "/call") {
      const body = await readBody(req);
      this.log.info("call body raw", { body: body.slice(0, 500) });
      try {
        let jsonBody = body.trim();
        // codex exec_command 的 shell 转义可能在 JSON 末尾多出 }，容错处理
        while (jsonBody.endsWith("}}")) {
          try { JSON.parse(jsonBody); break; } catch { jsonBody = jsonBody.slice(0, -1); }
        }
        this.log.info("call body parsed", { body: jsonBody.slice(0, 500) });
        const { name, args } = JSON.parse(jsonBody);
        this.log.info("tool call", { name, args });

        // HITL 主轨闸门（AD-026）+ 执行，统一走 gatedExecute（与 MCP server 共用同一道闸）。
        const result = await this.gatedExecute(name, args ?? {});
        this.log.info("tool result", { name, isError: result.isError ?? false, content: result.content[0]?.text?.slice(0, 200) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        this.log.error("call error", { error: String(err), body: body.slice(0, 200) });
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}
