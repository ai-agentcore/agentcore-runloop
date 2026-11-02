import type {
  NonMcpResources,
  McpToolDescriptor,
  McpToolResult,
  ToolCallContext,
} from "./types.js";
import type { Resource } from "../types/resources.js";
import { extractOperations, deriveAgentEndpoint, type OpenapiOperation } from "./openapi.js";
import { callSubAgent } from "../sidecar/sub-agent-caller.js";
import { callOpenapiTool } from "../sidecar/openapi-caller.js";
import { callDownstreamMcpTool } from "../sidecar/mcp-proxy.js";
import { SHELL_TOOL_NAME, executeShell } from "../sidecar/shell-exec.js";
import { isFileTool, executeFileTool } from "../sidecar/file-tools.js";
import { isSkillTool, executeSkillTool } from "../sidecar/skill-tools.js";
import { isImageTool } from "../sidecar/image-tools.js";
import { createEvent } from "../events/factory.js";
import { EventType } from "../types/events.js";
import { envNonNegativeInt } from "../util/env.js";
import { nanoid } from "nanoid";
import { withToolEvents } from "./tool-events.js";

/** 下游 MCP 工具调用超时（毫秒）。默认 0 = 不限时；env AGENTCORE_MCP_TOOL_TIMEOUT_MS 可设上限兜底挂死的下游。 */
const MCP_TOOL_TIMEOUT_MS = envNonNegativeInt("AGENTCORE_MCP_TOOL_TIMEOUT_MS", 0);

/**
 * 把工具名净化成 codex 的「不动点」：codex 暴露 MCP 工具给模型时会用
 * `sanitize_responses_api_tool_name()` 把 `[a-zA-Z0-9_]` 之外的字符（含连字符）全替换成 `_`
 * （见 codex-rs/core/src/mcp_connection_manager.rs，超 64 字符还会 SHA-1 截断）。
 * 我们提前净化，使 codex 的净化成为恒等变换——工具名在 prompt / 模型 tool list / mcp_tool_call /
 * 事件 / 断言全程一致，不在 codex 那层悄悄漂移。
 * ⚠ 有损：连字符与下划线净化后无法区分（潜在碰撞）；超 64 字符会被 codex 哈希（暂未处理，名字应保持短）。
 */
export function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** 委派动作段：统一命名下子 agent 工具 = `agent__<资源名>__delegate`（AD-029）。 */
const DELEGATE_ACTION = "delegate";

/**
 * 溯源 resourceType → 工具名首段的 type token（短小写，AD-029 统一格式 `<type>__<name>__<op>`）。
 * AGENT→`agent` / MCP→`mcp` / FUNCTIONCALL→`function` / SANDBOX(_TEMPLATE)→`sandbox` /
 * KNOWLEDGE_BASE→`kb` / MEMORY→`memory` / SKILL→`skill`；未知类型回落净化后的小写原值。
 * 把 type 编进工具名 → 名字仍是 `(type, resourceName, op)` 的纯函数、完全可预测、可在 prompt 里硬引用。
 */
function resourceTypeToken(resourceType: string): string {
  switch (resourceType) {
    case "AGENT": return "agent";
    case "MCP": return "mcp";
    case "FUNCTIONCALL": return "function";
    case "SANDBOX":
    case "SANDBOX_TEMPLATE": return "sandbox";
    case "KNOWLEDGE_BASE": return "kb";
    case "MEMORY": return "memory";
    case "SKILL": return "skill";
    default: return sanitizeToolName(resourceType.toLowerCase());
  }
}

/**
 * codex 把 MCP 工具暴露给模型时会拼 `mcp__<server>__` 前缀（server=agentcore，共 15 字符），
 * 工具名 + 该前缀超 64 字符会被 codex SHA-1 截断 → 破坏往返路由（L-044）。故我方名字预算 = 64 - 15 = 49。
 */
const CODEX_NS_PREFIX_LEN = "mcp__agentcore__".length;
const MAX_TOOL_NAME_LEN = 64 - CODEX_NS_PREFIX_LEN;

/**
 * 客户端工具（消费通道 2）模型侧名前缀（AD-029）：模型侧暴露 `client__<sanitize(声明名)>`，外发事件
 * 还原为声明名。**单一权威定义**——mcp/server.ts（暴露名）与 loop/prompt-builder.ts（系统提示词引用名）
 * 都从这里 import，避免两处各自 `"client__"` 硬编码、改名漂移致「暴露名 ≠ 提示词名」模型调错工具（评审 P1-3）。
 */
export const CLIENT_TOOL_PREFIX = "client__";

/** 确定性 FNV-1a 32-bit → base36（无 Date/random，replay 安全；不产生 `__`）。 */
function fnv1aBase36(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * 超过 codex 名字预算时哈希压缩（用户选定方案）：保留可读 head + `_<hash>`，确定性、≤ 预算、不含 `__`。
 * 不超长则原样返回。压缩后的名字仍是「名字单一权威」的一部分，提示词/路由/事件全程一致。
 */
export function compressToolName(name: string, maxLen = MAX_TOOL_NAME_LEN): string {
  if (name.length <= maxLen) return name;
  const hash = fnv1aBase36(name);
  const headLen = Math.max(1, maxLen - hash.length - 1);
  const head = name.slice(0, headLen).replace(/_+$/, "");
  return `${head}_${hash}`;
}

/** 压缩前的原始统一名 `<type>__<净化资源名>__<净化动作>`（AD-029），名字唯一权威的拼装规则。 */
function rawToolName(resourceType: string, resourceName: string, action: string): string {
  return `${resourceTypeToken(resourceType)}__${sanitizeToolName(resourceName)}__${sanitizeToolName(action)}`;
}

/**
 * 工具最终名（== buildToolIndex 产出的同款名）：`<type>__<name>__<op>` 净化 + 超预算哈希压缩。
 * 供 e2e/测试「预测运行时工具名」复用同一套逻辑，避免与 buildToolIndex 漂移（AD-029 教训 #3）。
 */
export function toolNameFor(resourceType: string, resourceName: string, action: string): string {
  return compressToolName(rawToolName(resourceType, resourceName, action));
}

interface McpManifestEntry {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * 解析后的工具：净化/消歧后的最终名 + 描述符 + 调用目标（kind 区分分发路径）+ 来源类别。
 * 这是名字的**唯一权威**——descriptor 生成、handleToolCall 路由、提示词渲染都从这里取，
 * 不再各自重算（杜绝三处净化逻辑漂移）。
 */
export type ResolvedTool = {
  /** 最终名（= codex 看到的名；超预算时是压缩名）。路由/descriptor 用它。 */
  name: string;
  /** 压缩前的原始统一名 `<type>__<name>__<op>`（外发事件还原用；未压缩时 == name）。 */
  rawName: string;
  descriptor: McpToolDescriptor;
  category: keyof NonMcpResources;
  /** 原始来源（错误信息用）。 */
  source: string;
} & (
  | { kind: "delegate"; agent: Resource }
  | { kind: "openapi"; resource: Resource; op: OpenapiOperation }
  | { kind: "mcp"; server: Resource; entry: McpManifestEntry }
);

/**
 * 构建工具索引（名字的单一权威）。**严格统一命名**（AD-029）：每个工具名 = `<type>__<净化资源名>__<动作>`
 * （分隔符 `__`），与「当前还加载了哪些别的资源」无关 → 完全可预测、可在 prompt 里硬引用。
 * - subAgents（AGENT）→ `agent__<资源名>__delegate`
 * - tools / sandboxes（openapi）→ `<type>__<资源名>__<净化 operationId>`（type=function/sandbox/kb/memory）
 * - mcpServers（下游 MCP 聚合）→ `mcp__<资源名>__<净化 toolManifest 名>`
 * 解决「同类型多实例」：两个 MEMORY 用同套 OpenAPI（operationId 都叫 `search`）→
 * `memory__memA__search` / `memory__memB__search`，互不覆盖。
 * 两步收尾：
 * 1. **哈希压缩**：名字超 codex 预算（49，见 MAX_TOOL_NAME_LEN）→ `compressToolName` 截断 + `_<hash>`。
 * 2. **碰撞检测**：压缩后仍重名（资源名+动作净化后相同，如 `my-bot` vs `my_bot`；或极少数 hash 撞）
 *    → 抛错，让整个 run 明确失败可定位，而非静默路由到错误资源。
 */
/**
 * buildToolIndex 结果缓存（评审 P2-1）：索引是 resources 的纯函数，一次 run 内 handleToolCall /
 * findResolvedTool / resolveToolTarget / collectDelegationToolNames / buildOutboundNameMap / 提示词渲染
 * 会各调 N 次、重复重建。按 resources 对象身份缓存（WeakMap，随 resources 被回收自动清理、无需失效逻辑）。
 * 假设 resources 一经构建即不可变（convertResources 产出后不改），故同一对象的索引恒等。
 */
const toolIndexCache = new WeakMap<NonMcpResources, ResolvedTool[]>();

export function buildToolIndex(resources: NonMcpResources): ResolvedTool[] {
  const cached = toolIndexCache.get(resources);
  if (cached) return cached;
  // 分配式 Omit：保留判别联合的各 kind 成员（裸 Omit<union> 会塌成公共字段）。
  type Producer = (ResolvedTool extends infer T ? (T extends ResolvedTool ? Omit<T, "name"> : never) : never) & {
    /** 压缩前的统一名（错误信息更可读）。 */
    rawName: string;
  };
  const producers: Producer[] = [];
  // 统一命名（AD-029）：`<type>__<净化资源名>__<净化动作>`（rawToolName），分隔符 `__`。
  const qualify = rawToolName;

  for (const a of resources.subAgents) {
    const rawName = qualify(a.resourceType, a.resourceName, DELEGATE_ACTION);
    producers.push({
      rawName,
      category: "subAgents",
      source: `AGENT "${a.resourceName}"`,
      kind: "delegate",
      agent: a,
      descriptor: {
        name: rawName,
        description: a.description ?? `Delegate task to sub-agent: ${a.resourceName}`,
        inputSchema: {
          type: "object",
          properties: { task: { type: "string", description: "Task description for the sub-agent" } },
          required: ["task"],
        },
      },
    });
  }

  for (const [list, category] of [
    [resources.tools, "tools"],
    [resources.sandboxes, "sandboxes"],
  ] as Array<[Resource[], keyof NonMcpResources]>) {
    for (const r of list) {
      for (const op of extractOperations(r.openapiConfig as Record<string, unknown> | undefined)) {
        const rawName = qualify(r.resourceType, r.resourceName, op.operationId);
        producers.push({
          rawName,
          category,
          source: `${r.resourceType} "${r.resourceName}".${op.operationId}`,
          kind: "openapi",
          resource: r,
          op,
          descriptor: {
            name: rawName,
            description: op.description ?? r.description ?? `${r.resourceName}.${op.operationId}`,
            inputSchema: op.inputSchema,
          },
        });
      }
    }
  }

  // 下游 MCP server（聚合）：从 toolManifest 静态清单注册工具（首 token 不等下游连接）。
  for (const m of resources.mcpServers ?? []) {
    for (const t of (m.toolManifest as McpManifestEntry[] | undefined) ?? []) {
      const rawName = qualify(m.resourceType, m.resourceName, t.name);
      producers.push({
        rawName,
        category: "mcpServers",
        source: `MCP "${m.resourceName}".${t.name}`,
        kind: "mcp",
        server: m,
        entry: t,
        descriptor: {
          name: rawName,
          description: t.description ?? `${m.resourceName}.${t.name}`,
          inputSchema: (t.inputSchema as Record<string, unknown> | undefined) ?? { type: "object", properties: {} },
        },
      });
    }
  }

  const seen = new Map<string, string>();
  const resolved: ResolvedTool[] = [];
  for (const p of producers) {
    const name = compressToolName(p.rawName);
    const prev = seen.get(name);
    if (prev !== undefined) {
      throw new Error(
        `Tool name collision: "${name}"（统一名 "${p.rawName}"）produced by both [${prev}] and [${p.source}]，` +
          `资源名+动作净化后仍相同、无法区分。请重命名其中一个资源/operation` +
          `（注意 '-' 与 '_' 净化后不可区分）。`,
      );
    }
    seen.set(name, p.source);
    const { rawName, ...rest } = p;
    resolved.push({ ...rest, name, rawName, descriptor: { ...p.descriptor, name } } as ResolvedTool);
  }
  toolIndexCache.set(resources, resolved);
  return resolved;
}

/**
 * 按最终名（codex 用的压缩名，实时调用）**或**原始名（外发事件/HITL 历史回放）匹配工具——两者皆可路由。
 * 压缩纯为满足 codex 64 字符线限（内部），但外发事件/存进上游历史的工具名是原始名，回放回来需按原始名查到。
 */
export function findResolvedTool(resources: NonMcpResources, name: string): ResolvedTool | undefined {
  const idx = buildToolIndex(resources);
  return idx.find((t) => t.name === name) ?? idx.find((t) => t.rawName === name);
}

/**
 * 外发事件工具名还原表：压缩名 → 原始 `<type>__<name>__<op>`（仅收录被压缩、二者不等的项；常态为空）。
 * 由 runner 在外发出口（emitNormalized）对事件 toolName 做还原，使「压缩仅限内部逻辑」。
 */
export function buildOutboundNameMap(resources: NonMcpResources): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of buildToolIndex(resources)) {
    if (t.name !== t.rawName) map.set(t.name, t.rawName);
  }
  return map;
}

/**
 * 解析一个工具名的**执行端点/描述符签名**（HITL 审批绑定用，H5）。资源型工具返回能标识"打到哪"的
 * 稳定字符串（openapi: method+serverUrl+path；委派: 子 agent endpoint；MCP: 下游 url+工具名）。
 * 内置 bash/file/skill（非 resources）或未知名 → 返回 ""（无端点可绑，只绑 toolName）。
 */
export function resolveToolTarget(name: string, resources: NonMcpResources): string {
  const tool = findResolvedTool(resources, name);
  if (!tool) return "";
  switch (tool.kind) {
    case "openapi":
      return `openapi:${tool.op.method}:${tool.op.serverUrl}${tool.op.path}`;
    case "delegate":
      return `delegate:${deriveAgentEndpoint(tool.agent)}`;
    case "mcp":
      return `mcp:${(tool.server.mcpConfig as { url?: string } | undefined)?.url ?? ""}:${tool.entry.name}`;
    default:
      return "";
  }
}

/** 委派工具名集合（下游识别「这是委派」用的权威来源，取代按字符串前缀猜）。 */
export function collectDelegationToolNames(resources: NonMcpResources): Set<string> {
  return new Set(
    buildToolIndex(resources)
      .filter((t) => t.kind === "delegate")
      .map((t) => t.name),
  );
}

/**
 * 暴露给模型的 MCP 工具描述符（= 工具索引的 descriptor 视图）。
 * - subAgents（AGENT）→ `agent__<资源名>__delegate` 工具
 * - tools / sandboxes（openapi）→ 每 operation 一个工具（`<type>__<资源名>__<operationId>`）
 * - skills（SKILL）→ 不暴露（安装期下载解包）
 */
export function buildToolDescriptors(resources: NonMcpResources): McpToolDescriptor[] {
  return buildToolIndex(resources).map((t) => t.descriptor);
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolCallContext,
): Promise<McpToolResult> {
  // Delegation retains its streaming/nested-HITL lifecycle and call ID.
  if (!ctx.emitToolLifecycle || findResolvedTool(ctx.resources, name)?.kind === "delegate") {
    return dispatchToolCall(name, args, ctx);
  }
  return withToolEvents(name, args, ctx, () => dispatchToolCall(name, args, ctx));
}

async function dispatchToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolCallContext
): Promise<McpToolResult> {
  if (isImageTool(name)) {
    return ctx.imageTools
      ? ctx.imageTools.call(name, args)
      : { isError: true, content: [{ type: "text", text: "image tools are disabled" }] };
  }
  // 内置 `shell` 执行工具（Option B）：执行从 codex 内建 shell 剥离到这条统一工具路径，
  // 与平台资源工具走同一个 handleToolCall → sidecar.gatedExecute（HITL 主轨）。
  // ctx.execBackend 注入（系统实例 + Sandbox）→ 路由到隔离沙箱数据面；否则走本地 bash。
  if (name === SHELL_TOOL_NAME) {
    if (ctx.execBackend) return ctx.execBackend.shell(String(args.command ?? ""));
    return executeShell(String(args.command ?? ""), { cwd: ctx.workdir });
  }

  // 内置文件/检索工具（read_file/write_file/edit_file/grep/glob，与 shell 同路径、同闸门）。
  if (isFileTool(name)) {
    if (ctx.execBackend) return (await ctx.execBackend.file(name, args))!;
    return (await executeFileTool(name, args, { cwd: ctx.workdir }))!;
  }

  // 内置 skill 读取工具（get_skill，只读本地 .agents/skills/，与 shell/文件能力无关）。
  if (isSkillTool(name)) {
    return (await executeSkillTool(name, args, { skills: ctx.resources.skills, workdir: ctx.workdir }))!;
  }

  // 按工具索引（名字单一权威）匹配并分发——压缩名（codex 实时调用）或原始名（HITL resume 历史回放）皆可。
  const tool = findResolvedTool(ctx.resources, name);
  if (!tool) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
      isError: true,
    };
  }

  if (tool.kind === "delegate") {
    return handleDelegation(tool.agent, name, args, ctx);
  }

  if (tool.kind === "openapi") {
    const r = tool.resource;
    // 真实 HTTP 调用：按 operation 拼 URL/method、args→body/query、auth.mode 签名/透传（见 openapi-caller）。
    const result = await callOpenapiTool(r, tool.op, args, ctx.credentials, { globalHeaders: ctx.headers, idempotencyKey: ctx.idempotencyKey, log: ctx.log, toolName: name });
    return { content: [{ type: "text", text: result }], isError: result.startsWith('{"error"') };
  }

  // 下游 MCP server（聚合代理）：懒连下游转发原始工具名（非消歧后的名）。
  return await callDownstreamMcpTool(tool.server, tool.entry.name, args, ctx.credentials, { globalHeaders: ctx.headers, log: ctx.log, timeout: MCP_TOOL_TIMEOUT_MS });
}

/** 子 agent 委派：委派层拥有完整语义生命周期（start → output_delta* → result），全程共享一个 toolCallId。 */
async function handleDelegation(
  agent: Resource,
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolCallContext,
): Promise<McpToolResult> {
  const task = (args.task as string) ?? "";
  const endpoint = deriveAgentEndpoint(agent);
  if (!endpoint || !ctx.credentials) {
    return textResult({
      type: "delegation_request",
      agent: agent.resourceName,
      description: agent.description,
      task,
    });
  }

  const delegationId = ctx.toolCallId ?? `delegate-${nanoid()}`;
  const canEmit = ctx.emit && ctx.conversationId;
  if (canEmit) {
    ctx.emit!(createEvent(EventType.ToolcallStart, ctx.conversationId!, {
      toolCallId: delegationId,
      toolName,
    }));
    ctx.emit!(createEvent(EventType.ToolcallEnd, ctx.conversationId!, {
      toolCallId: delegationId,
      args: { task },
    }));
  }

  let result: string;
  let isError = false;
  try {
    result = await callSubAgent(agent, task, ctx.credentials, {
      emit: ctx.emit,
      conversationId: ctx.conversationId,
      toolCallId: delegationId,
      // 超时走 callSubAgent 默认：总时长 1h 硬顶 + 5min 空闲断开（env 可覆盖）。
      globalHeaders: ctx.headers,
      log: ctx.log,
    });
  } catch (err) {
    isError = true;
    result = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }

  // 子 agent 触发 HITL（嵌套向上透传，AD-026）：委派本轮不产 toolresult，通知 runner 立即挂起本轮。
  if (!isError && result.startsWith('{"__hitl_suspended"')) {
    ctx.onSuspend?.();
    return textResult({ type: "delegation_pending", agent: agent.resourceName, task });
  }
  // callSubAgent 失败时不抛异常而返回 {"error":...} 字符串（HTTP 非 2xx / 空 body / 超时等）。
  if (!isError && result.startsWith('{"error"')) isError = true;
  if (canEmit) {
    ctx.emit!(createEvent(EventType.ToolresultEnd, ctx.conversationId!, {
      toolCallId: delegationId,
      result,
      isError,
    }));
  }
  // isError 与上面的 toolresult.end 事件一致：委派失败（404/超时等）时返回的 McpToolResult 也标 isError，
  // 否则 `tool result` 日志会误报 isError:false、codex 也会把失败当成功。
  return { ...textResult({ type: "delegation_result", agent: agent.resourceName, task, result }), isError };
}

function textResult(data: Record<string, unknown>): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}
