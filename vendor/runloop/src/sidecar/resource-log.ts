import type { Logger } from "../util/logger.js";

/**
 * 资源调用（子 agent 委派 / openapi 工具 / 下游 MCP）的出站请求与响应日志。
 *
 * 动机：此前只有 `tool call`(toolName+args) / `tool result`(toolName+isError) 两条日志，**看不到实际打到
 * 下游的 URL、请求体、响应状态码与响应体**——子 agent 404（缺协议子路径）时只能靠推断，无法直接定位。
 * 这里在三个资源调用器（callSubAgent / callOpenapiTool / callDownstreamMcpTool）统一记录请求/响应内容。
 *
 * apiKey/secret/token 等键。
 */

/** 资源调用日志的最小 logger 接口（避免与 pino Logger 强耦合，便于测试注入 / 缺省关闭）。 */
export type ResourceCallLogger = Pick<Logger, "info" | "warn" | "error" | "debug">;

/** 单条日志 body 上限（字符）；超出截断并标注原始长度。 */
export const MAX_BODY_LOG = 2000;

/** 截断过长字符串用于日志，标注原始长度。 */
export function truncateForLog(s: string | undefined, max = MAX_BODY_LOG): string | undefined {
  if (s == null) return undefined;
  return s.length > max ? `${s.slice(0, max)}…(${s.length} chars total)` : s;
}

export type ResourceTarget = "subagent" | "openapi" | "mcp" | "sandbox";

export interface ResourceRequestFields {
  target: ResourceTarget;
  toolName?: string;
  /** 委派协议（subagent）：ag-ui / chat-completions / runloop / a2a。 */
  protocol?: string;
  method: string;
  url: string;
  body?: string;
}

export interface ResourceResponseFields {
  target: ResourceTarget;
  toolName?: string;
  /** 出站端点（可选；带上后可直接按 URL 归类响应——如沙箱 `/processes/cmd` 算执行耗时、`/files` 算文件 IO）。 */
  url?: string;
  status?: number;
  ok?: boolean;
  durationMs?: number;
  /** 响应体（截断）。失败时这里就是排障关键（如 404 的 `{"detail":"Not Found"}`）。 */
  body?: string;
  /** 网络/异常错误（非 HTTP 响应）。 */
  error?: string;
}

/** 记录一次资源调用的出站请求（method + URL + body）。 */
export function logResourceRequest(log: ResourceCallLogger | undefined, fields: ResourceRequestFields): void {
  log?.info("resource request", { ...fields, body: truncateForLog(fields.body) });
}

/** 记录一次资源调用的响应（status + ok + body / error）；失败（非 2xx 或异常）落 warn 便于检索。 */
export function logResourceResponse(log: ResourceCallLogger | undefined, fields: ResourceResponseFields): void {
  const out = { ...fields, body: truncateForLog(fields.body) };
  if (fields.error || fields.ok === false) log?.warn("resource response", out);
  else log?.info("resource response", out);
}
