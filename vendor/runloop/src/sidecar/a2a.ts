/**
 * A2A（Agent2Agent）协议的纯逻辑：请求体构造、JSON-RPC 信封解包、parts 文本提取、TaskState 判定、
 * 错误提取。不依赖 RunloopEvent——事件翻译在 event-translator.ts 的 translateA2aEvent 里做、复用本文件助手。
 *
 * runloop 走 A2A 的 **JSON-RPC over HTTP+SSE 绑定**（与已有 ag-ui/chat-completions 委派一致：HTTP POST +
 * text/event-stream）。委派调用发 `message/stream`，SSE 每条 data 是 JSON-RPC 响应信封
 * `{jsonrpc,id,result:<event>}`（或错误信封 `{jsonrpc,id,error}`）。result 是四种事件之一：
 * Message(role agent) / Task / TaskStatusUpdateEvent(kind:"status-update") / TaskArtifactUpdateEvent(kind:"artifact-update")。
 * 文本统一从 parts 的 `text` 字段取（kind:"text"）。TaskState 用 JSON 绑定的 kebab-case，同时兼容 gRPC 大写枚举。
 */
import { nanoid } from "nanoid";

/** JSON-RPC `message/stream` 请求体（A2A 委派初始调用）。 */
export function buildA2aRequestBody(task: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: nanoid(),
    method: "message/stream",
    params: {
      message: {
        role: "user",
        parts: [{ kind: "text", text: task }],
        messageId: nanoid(),
        kind: "message",
      },
    },
  });
}

/**
 * A2A 委派的 HITL resume 续接（input-required 后用户已给出审批决策）。续发 `message/stream`，把审批
 * 决策作为一条 user 文本消息，并带上原 task 的 taskId（从挂起事件里取）让 A2A server 继续同一任务。
 */
export function buildA2aResumeBody(resumeEvents: unknown[]): string {
  const events = (resumeEvents as Array<Record<string, unknown>>) ?? [];
  const resolve = events.find((e) => e.type === "user.command" && e.command === "resolve");
  const suspend = events.find((e) => e.type === "toolcall.suspend");
  const taskId = suspend?.toolCallId as string | undefined;
  // input-required 的真实输入优先：resolve.payload.input（用户给 A2A agent 的具体输入）；
  // 否则回落到审批决策文本（approve/reject 等）；无 resolve 则 continue。
  const payloadInput = (resolve?.payload as { input?: unknown } | undefined)?.input;
  const answer = typeof payloadInput === "string" && payloadInput.trim()
    ? payloadInput
    : resolve
    ? `[HITL 审批结果] ${((resolve.selectedOptionId as string) ?? "").trim()}`.trim()
    : "continue";
  const message: Record<string, unknown> = {
    role: "user",
    parts: [{ kind: "text", text: answer }],
    messageId: nanoid(),
    kind: "message",
    ...(taskId ? { taskId } : {}),
  };
  return JSON.stringify({ jsonrpc: "2.0", id: nanoid(), method: "message/stream", params: { message } });
}

/**
 * 委派端点是否为 A2A AgentCard URL（`.well-known/agent-card.json` 或旧 `.well-known/agent.json`）。
 * 是则 callSubAgent 先抓 card 解析出真正的 service endpoint，再发 message/stream（agent-card 发现）。
 */
export function isA2aCardUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname;
    return path.endsWith("/agent-card.json") || path.endsWith("/agent.json");
  } catch {
    return /\/agent(-card)?\.json($|\?)/.test(url);
  }
}

/**
 * 从 A2A AgentCard 取 service endpoint：优先顶层 `url`，兼容 `additionalInterfaces[].url`（新版多传输）
 * 与 `endpoints[].uri`。取不到返回 undefined。
 */
export function extractA2aCardEndpoint(card: unknown): string | undefined {
  if (!card || typeof card !== "object") return undefined;
  const c = card as Record<string, unknown>;
  if (typeof c.url === "string" && c.url) return c.url;
  const ifaces = c.additionalInterfaces;
  if (Array.isArray(ifaces)) {
    const hit = ifaces.find((i) => i && typeof (i as { url?: unknown }).url === "string");
    if (hit) return (hit as { url: string }).url;
  }
  const eps = c.endpoints;
  if (Array.isArray(eps)) {
    const hit = eps.find((e) => e && typeof (e as { uri?: unknown }).uri === "string");
    if (hit) return (hit as { uri: string }).uri;
  }
  return undefined;
}

export function chooseA2aServiceEndpoint(card: unknown, _cardUrl: string, _authMode: string): string | undefined {
  return extractA2aCardEndpoint(card);
}

/** 解包 JSON-RPC `result` 信封；无信封时原样返回（容错 + 便于直接喂未包裹的 A2A 事件测试）。 */
export function unwrapA2aResult(event: Record<string, unknown>): Record<string, unknown> {
  const r = event.result;
  return r && typeof r === "object" ? (r as Record<string, unknown>) : event;
}

/**
 * 把 A2A parts 数组渲染为文本（runloop 的 message.delta content 是字符串，故多模态 part 转文本表征）：
 * - text part → 原文
 * - file part → `[file: <name> (<mimeType>) <uri|inline>]`（**不 dump base64 bytes**——可能巨大；只给引用）
 * - data part → 紧凑 JSON
 * 非数组 / 无可识别内容的 part → 空串。
 */
export function a2aPartsText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts.map(a2aPartText).join("");
}

/** 单个 part → 文本表征（见 a2aPartsText）。 */
function a2aPartText(p: unknown): string {
  if (!p || typeof p !== "object") return "";
  const part = p as Record<string, unknown>;
  if (typeof part.text === "string") return part.text;
  // file part：引用 name/mimeType/uri（仅 inline bytes 时标注 inline、不输出 base64）。
  const file = part.file as Record<string, unknown> | undefined;
  if (file && typeof file === "object") {
    const name = (typeof file.name === "string" && file.name) || "file";
    const mime = typeof file.mimeType === "string" ? file.mimeType : undefined;
    const loc = typeof file.uri === "string" ? file.uri : file.bytes !== undefined ? "inline" : undefined;
    const desc = [name, mime ? `(${mime})` : "", loc ?? ""].filter(Boolean).join(" ");
    return `[file: ${desc}]`;
  }
  // data part → 紧凑 JSON。
  if ("data" in part && part.data !== undefined) {
    try {
      return JSON.stringify(part.data);
    } catch {
      return "";
    }
  }
  return "";
}

/** A2A Message 对象（含 parts）里的文本。 */
export function a2aMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  return a2aPartsText((message as { parts?: unknown }).parts);
}

/** input-required / auth-required（需要人介入 → 嵌套 HITL）。兼容 JSON kebab-case 与 gRPC 大写枚举。 */
export function isA2aInputRequired(state?: string): boolean {
  return (
    state === "input-required" ||
    state === "auth-required" ||
    state === "TASK_STATE_INPUT_REQUIRED" ||
    state === "TASK_STATE_AUTH_REQUIRED"
  );
}

/** completed（成功终态 → 关闭 message）。 */
export function isA2aCompleted(state?: string): boolean {
  return state === "completed" || state === "TASK_STATE_COMPLETED";
}

/** failed / rejected / canceled（失败终态 → 交 extractA2aError）。 */
export function isA2aFailed(state?: string): boolean {
  return (
    state === "failed" ||
    state === "rejected" ||
    state === "canceled" ||
    state === "TASK_STATE_FAILED" ||
    state === "TASK_STATE_REJECTED" ||
    state === "TASK_STATE_CANCELED"
  );
}

/**
 * 提取 A2A 事件的助手文本（= translateA2aEvent 会发成 message.delta 的那段文本）。供无 emit 的
 * 旧式调用路径（如嵌套 resume 转发）累积返回文本用。message / artifact-update / status-update(非终态).message
 * 取文本；input-required / 失败终态 / task 快照 → 空串（与翻译器一致、不把这些当助手文本）。
 */
export function extractA2aText(event: Record<string, unknown>): string {
  const a2a = unwrapA2aResult(event);
  const kind = (a2a.kind as string) ?? (a2a.type as string);
  if (kind === "message") return a2aPartsText(a2a.parts);
  if (kind === "artifact-update") {
    return a2aPartsText((a2a.artifact as { parts?: unknown } | undefined)?.parts);
  }
  if (kind === "status-update") {
    const status = a2a.status as Record<string, unknown> | undefined;
    const state = status?.state as string | undefined;
    if (isA2aInputRequired(state) || isA2aFailed(state)) return "";
    return a2aMessageText(status?.message);
  }
  return "";
}

/**
 * 从 A2A SSE 事件提取错误信息（非错误返回 undefined）。覆盖 JSON-RPC error 信封与 task/status-update
 * 的失败终态；与 ag-ui/runloop 的 extractChildError 对齐（HTTP 200 + SSE 内报错的常规形态，H10）。
 */
export function extractA2aError(event: Record<string, unknown>): string | undefined {
  if (event.jsonrpc && event.error && typeof event.error === "object") {
    const err = event.error as { message?: string; code?: number };
    return err.message ?? `a2a error ${err.code ?? "unknown"}`;
  }
  const a2a = unwrapA2aResult(event);
  const status = a2a.status as Record<string, unknown> | undefined;
  const state = status?.state as string | undefined;
  if (isA2aFailed(state)) {
    return a2aMessageText(status?.message) || `sub-agent task ${state}`;
  }
  return undefined;
}
