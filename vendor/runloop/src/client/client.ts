// 此文件由 scripts/generate-client-ts.ts 从 spec/openapi.json 自动生成，请勿手动编辑。
import type { RunloopEvent } from "./events";

// ── 请求/响应类型 ──────────────────────────────────

export interface RunRequest {
  /** Conversation ID — stable across multiple runs in the same conversation. Decides the workspace directory. Auto-generated if omitted. */
  conversationId?: string;
  /** Run ID — unique identifier for this specific /v1/run invocation. Auto-generated if omitted. Used for tracing and logging. */
  runId?: string;
  /** Full event history. New user message + all previous events for replay. */
  events: InputEvent[];
  model?: ModelConfig;
  agent?: AgentConfig;
  /** Unified flat platform resource list. Each item = 溯源(resourceId/resourceName/resourceType) + 调用方式(protocol + mcpConfig|openapiConfig) + 鉴权(auth). See Resource schema. */
  resources?: Resource[];
  /** Client-declared, client-executed tools (= chat-completions tools / ag-ui frontend tools). Calling one pauses the run (tool_pending) until the client feeds back a toolresult on the next run. */
  clientTools?: ClientTool[];
  /** 平台凭证（AK/SK，可带 STS securityToken）。条件必填：仅当存在 auth.mode=agentrun 资源、或有 SKILL/SANDBOX 资源（agentrun 数据面下载/调用）时必填；全外部工具（auth.mode=none）场景可省略。 */
  credentials?: Credentials;
  /** Extra HTTP headers forwarded to downstream agentrun resource calls (global default; merged with per-resource headers, resource-level wins). Runloop's own signing/required headers always win. */
  headers?: Record<string, string>;
  hitl?: HitlConfig;
  features?: Features;
}

/** Agent CLI runtime configuration — how to launch the agent CLI, where, with what environment / prompt / limits. */
export interface AgentConfig {
  /** Registered agent CLI name. */
  cli?: string;
  /** Working directory override (defaults to the conversation workspace). */
  cwd?: string;
  /** Environment variables injected into the agent CLI process. Runloop's required vars (OPENAI_API_KEY=proxy token, CODEX_HOME, NO_PROXY, dropped-privilege HOME/USER) always win; still filtered by the dropped-privilege env allowlist (cannot smuggle secrets into the non-root codex). */
  env?: Record<string, string>;
  /** User-provided instructions appended after the built-in Super Agent system prompt. */
  systemPrompt?: string;
  /** Maximum loop turns before auto-stop. */
  maxTurns?: number;
  /** Timeout in milliseconds before auto-interrupt. */
  timeoutMs?: number;
}

/** Human-in-the-Loop approval configuration (switch + static rules). AD-026. */
export interface HitlConfig {
  /** Master switch (default off). */
  enabled?: boolean;
  /** Static rules: a tool call whose name matches a rule with action 'ask' is force-suspended for approval. */
  rules?: HitlRule[];
  clientCapabilities?: HitlClientCapabilities;
}

/** Client HITL capability declaration (AD-026 F1/F3). runloop uses it to (F1) only let the model trigger the listed interaction kinds, and to pick the surface per suspend: native event / map to client tool / NL. Safety main-track confirm + NL floor are not gated by F1. */
export interface HitlClientCapabilities {
  /** F1: interaction kinds the client supports and the model is allowed to trigger. Kinds not listed are not exposed to the model (except safety main-track confirm and the NL floor). */
  interactions?: "confirm" | "input" | "choice"[];
  /** Client can consume native toolcall.suspend events directly; when true, listed interaction kinds are delivered as native events. */
  nativeHitl?: boolean;
  /** Optional explicit interaction-kind -> client tool name map for deterministic rendering, e.g. {"choice":"super_agent_choices"}. When an interaction has no explicit mapping and nativeHitl is false, runloop maps it to a suitable client tool (or NL) via a dedicated pure-HITL LLM call (F3). */
  renderTools?: Record<string, string>;
}

export interface HitlRule {
  /** Glob pattern: 'db_drop_*', '*', 'exact_name'. */
  toolPattern: string;
  action: "block" | "ask" | "allow";
  reason?: string;
}

/** Client-declared, client-executed tool. */
export interface ClientTool {
  name: string;
  description?: string;
  /** JSON Schema for the tool inputs. */
  parameters?: Record<string, unknown>;
}

/** Input event. Open object — all extra fields (toolCallId, result, parentToolCallId, command, args, selectedOptionId, reason, options, role, ...) are preserved for event-sourced replay / HITL resume / nested delegation. */
export interface InputEvent {
  /** Event type. Use 'user.message' for new user input. */
  type: string;
  /** Auto-generated if omitted */
  id?: string;
  /** Auto-filled if omitted */
  timestamp?: number;
  /** Message content (for user.message) */
  content?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface InterruptRequest {
  conversationId: string;
  reason?: string;
}

export interface Credentials {
  /** Platform access key ID */
  accessKeyId: string;
  /** Platform access key secret */
  accessKeySecret: string;
  /** STS temporary security token */
  securityToken?: string;
  /** Platform account ID */
  accountId?: string;
  /** Region (e.g. cn-hangzhou) */
  region?: string;
}

export interface ModelConfig {
  provider: string;
  model: string;
  /** Required at runtime — agent CLI must not call upstream LLM directly */
  baseUrl?: string;
  /** Required at runtime — used by ModelProviderProxy */
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
}

export type ResourceTypeEnum = "FUNCTIONCALL" | "SKILL" | "AGENT" | "SANDBOX" | "SANDBOX_TEMPLATE" | "MCP" | "KNOWLEDGE_BASE" | "MEMORY";

export type ProtocolEnum = "mcp" | "openapi" | "ag-ui" | "chat-completions" | "runloop" | "a2a";

/** 纯标准 MCP server 连接配置（protocol=mcp 时用）——可直接喂标准 MCP client，**不含任何 runloop 私有字段**。stdio 用 command/args/env；http·sse 用 url/headers。静态工具清单是 runloop 扩展、不属 MCP 标准，见 Resource.toolManifest。 */
export interface McpConfig {
  transport?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** 调用鉴权方式。none(默认)=只透传 headers、runloop 不签；agentrun=runloop 用 credentials 按 AGENTRUN4-HMAC-SHA256 / Agentrun-Authorization 自动签名（agentrun 数据面）。 */
export interface ResourceAuth {
  mode?: "none" | "agentrun";
}

/** 统一资源（扁平）。三轴：① 溯源 resourceId/resourceName/resourceType（agentrun 概念 + 业务处理开关）；② 调用方式 protocol（mcp→mcpConfig / 其余→openapiConfig）；③ 鉴权 auth。约束（运行时校验）：protocol=mcp ⇒ 须带 mcpConfig，否则 ⇒ 须带 openapiConfig。 */
export interface Resource {
  /** = agentrun 资源 id（稳定唯一，immutable；溯源/引用/幂等）。resourceType=SANDBOX 时为运行中实例 id（直接用）；=SANDBOX_TEMPLATE 时为模板 id（runloop 懒创建实例+回收）。 */
  resourceId: string;
  /** 逻辑名——用于生成暴露给模型的工具名、注入提示词。 */
  resourceName: string;
  resourceType: ResourceTypeEnum;
  /** 工具描述/提示词。 */
  description?: string;
  protocol: ProtocolEnum;
  mcpConfig?: McpConfig;
  /** 标准 OpenAPI 文档（protocol≠mcp 时用，格式同 openapi.json）。每个 operation=一个工具、operationId=工具名（必须存在且唯一）；inputSchema 从 operation 的 parameters/requestBody 派生。runloop 据 resourceType 特殊处理：AGENT/SKILL 单 operation 直接用、多 operation 须含保留 operationId（AGENT=invoke、SKILL=download）；SANDBOX/SANDBOX_TEMPLATE 多 operation=多工具、全部共享（懒创建出的）实例 serverUrl。 */
  openapiConfig?: Record<string, unknown>;
  auth?: ResourceAuth;
  /** 资源级附加 header —— openapi/委派下游 HTTP 调用的**调用时供给通道**。典型是外部鉴权密钥（Bearer/apikey）：OpenAPI 的 securitySchemes 只声明鉴权方案、**密钥值故意留给调用方在此供给**（不写进 openapiConfig 文档），这正是本字段存在的理由、非 openapiConfig 的冗余。非密常量 header（如固定 X-Tenant）也可改写进 openapiConfig 的 const 参数。与顶层 headers 合并、资源级优先、runloop 签名/必备 header 最高优先；MCP 连接自身 header 用 mcpConfig.headers。 */
  headers?: Record<string, string>;
  /** 静态工具清单（可选，**runloop 扩展、非 MCP 标准**，故置于标准 mcpConfig 之外）。仅 protocol=mcp 用——codex 只连 runloop 单个进程内 agentrun-mcp 聚合器，下游 MCP server 都被它聚合/代理；MCP 工具发现本是运行时 round-trip（连下游→initialize→tools/list），慢下游拖慢 agent 首 token。声明此清单后聚合器**立刻把工具呈现给 agent**（首 token 不等下游启动），首次实际调用才**懒连**下游转发、并用真实 tools/list **校正**（self-heal）。缺省则聚合器启动时连下游 tools/list 发现（首 token 等下游）。protocol≠mcp 不用此字段——openapiConfig 的 operations 已自描述工具。 */
  toolManifest?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
  /** 子 agent（protocol=ag-ui/a2a/runloop 等委派目标）是否**服务端自管会话/历史**。`true`=该 agent 按 threadId 在服务端保存自己的会话（含挂起的 HITL）——runloop 多次委派/HITL resume 传**一致的 threadId**、只下发**增量** messages（最新一轮 + 审批决策）。`false`/缺省=无服务端会话（无状态 agent）——runloop 每次下发**完整** messages（原始任务 + 子轨迹 + 审批决策）+ resume 标识，让其自行重建。仅影响委派类资源（AGENT）。来源：平台 protocolSettings[ag-ui].config.serverManagesHistory（前端可标）。 */
  serverManagesHistory?: boolean;
}

/** 灰度/实验/内部控制开关（如 toolBridge）。业务配置（hitl/agent/model/resources 等）不进 features。 */
export interface Features {
  /** 内部控制开关：runloop 把非 mcp 资源（openapi 工具 / 委派 / 沙箱）经进程内 agentrun-mcp 聚合器暴露给 agent CLI 的桥接方式。`mcp`=codex 原生 MCP 调用（默认）；`cli`=`.tools/agentrun` shell 隧道（降级，特定场景保效果用）。缺省 `mcp`。 */
  toolBridge?: "mcp" | "cli";
  /** 命令执行（shell）的归属：`true`（**默认**）=关掉 agent CLI 内建 shell，执行改走 runloop 自有的 `shell` MCP 工具（统一过 HITL 主轨闸门、可审计、后端可换远端隔离沙箱）；`false`=用 agent CLI 内建 shell（如 codex 的 exec_command，自带流式 / write_stdin）。缺省 `true`（走我们的 MCP）。运维可用 env `AGENTCORE_EXEC_VIA_MCP=0` 作为全局 kill-switch（仅当请求未显式指定时生效）。 */
  execViaMcp?: boolean;
  [key: string]: unknown;
}

export interface HealthResponse {
  status?: "ok" | "degraded" | "error";
  version?: string;
  activeRuns?: number;
}

export interface RunInfo {
  conversationId?: string;
  status?: "idle" | "running" | "interrupted" | "completed" | "error";
  eventCount?: number;
}

export interface ErrorResponse {
  error?: string;
  details?: Record<string, unknown>[];
}

export interface InitializeResponse {
  status: "ok";
  /** Time taken to pre-warm in milliseconds */
  elapsedMs: number;
}

// ── SSE 解析器 ────────────────────────────────────

export interface SSEFrame {
  event?: string;
  data: string;
  id?: string;
}

async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<SSEFrame, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const onAbort = () => { reader.cancel().catch(() => {}); };
  if (signal) {
    if (signal.aborted) { reader.cancel().catch(() => {}); return; }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sepIdx: number;
      while ((sepIdx = buffer.indexOf("\n\n")) !== -1 || (sepIdx = buffer.indexOf("\r\n\r\n")) !== -1) {
        const sepLen = buffer.startsWith("\r\n", sepIdx) ? 4 : 2;
        const raw = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + sepLen);
        const frame = parseFrame(raw);
        if (frame !== null) yield frame;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      const frame = parseFrame(buffer);
      if (frame !== null) yield frame;
    }
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

function parseFrame(raw: string): SSEFrame | null {
  const lines = raw.split(/\r?\n/);
  let event: string | undefined;
  let id: string | undefined;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event": event = value; break;
      case "id": id = value; break;
      case "data": dataLines.push(value); break;
    }
  }
  if (dataLines.length === 0) return null;
  return { event, id, data: dataLines.join("\n") };
}

// ── 错误类型 ──────────────────────────────────────
export class RunloopError extends Error {
  constructor(message: string, public readonly info?: unknown) {
    super(message);
    this.name = "RunloopError";
  }
}
export class RunloopHTTPError extends RunloopError {
  constructor(message: string, public readonly status: number, public readonly body?: unknown) {
    super(message);
    this.name = "RunloopHTTPError";
  }
}

// ── RunloopClient ────────────────────────────────

export interface RunloopClientOptions {
  /** 服务端 URL，如 http://localhost:3000 */
  baseUrl: string;
  /** 附加到每个请求的 headers */
  headers?: Record<string, string>;
  /** 自定义 fetch 实现 */
  fetch?: typeof fetch;
}

export interface RunResult {
  /** 从 X-Conversation-Id header 获取的会话 ID */
  conversationId: string;
  /** 从 X-Run-Id header 获取的本次请求 ID */
  runId: string;
  /** 事件异步迭代器 */
  events: AsyncIterable<RunloopEvent>;
}

export class RunloopClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: RunloopClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.headers = { ...(opts.headers ?? {}) };
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** GET /health */
  async health(): Promise<HealthResponse> {
    return this.json("GET", "/health");
  }

  /** GET /v1/runs */
  async listRuns(): Promise<{ runs: RunInfo[] }> {
    return this.json("GET", "/v1/runs");
  }

  /** POST /v1/interrupt */
  async interrupt(req: InterruptRequest): Promise<{ success: boolean }> {
    return this.json("POST", "/v1/interrupt", req);
  }

  /** POST /v1/run — 返回 SSE 事件流 */
  async run(req: RunRequest, opts?: { signal?: AbortSignal }): Promise<RunResult> {
    const response = await this.fetchImpl(this.url("/v1/run"), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", ...this.headers },
      body: JSON.stringify(req),
      signal: opts?.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new RunloopHTTPError(`POST /v1/run failed: ${response.status}`, response.status, text);
    }
    if (!response.body) throw new RunloopError("server returned no response body");
    const conversationId = response.headers.get("x-conversation-id") ?? "";
    const runId = response.headers.get("x-run-id") ?? "";
    const stream = response.body;
    const events = (async function* (): AsyncGenerator<RunloopEvent, void, void> {
      for await (const frame of parseSSE(stream, opts?.signal)) {
        if (!frame.data || frame.data === "") continue;
        try {
          yield JSON.parse(frame.data) as RunloopEvent;
        } catch { /* skip non-JSON frames (heartbeat etc) */ }
      }
    })();
    return { conversationId, runId, events };
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private async json<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(this.url(path), {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        accept: "application/json",
        ...this.headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let parsed: unknown;
    try { parsed = text.length === 0 ? null : JSON.parse(text); } catch { throw new RunloopError(`${method} ${path}: invalid JSON response`); }
    if (!response.ok) throw new RunloopHTTPError(`${method} ${path} failed: ${response.status}`, response.status, parsed);
    return parsed as T;
  }
}