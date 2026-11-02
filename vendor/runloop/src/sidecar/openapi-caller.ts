import type { Credentials, Resource } from "../types/resources.js";
import type { OpenapiOperation } from "../mcp/openapi.js";
import { joinUrl } from "../mcp/openapi.js";
import { assertOutboundAllowed, SsrfBlockedError } from "./ssrf.js";
import { logResourceRequest, logResourceResponse, type ResourceCallLogger } from "./resource-log.js";
import { envPositiveInt } from "../util/env.js";

/** GET/DELETE/HEAD 把 args 放 query，其余放 JSON body。 */
const QUERY_METHODS = new Set(["get", "delete", "head"]);

/** OpenAPI/FunctionCall 工具调用默认超时（非流式 HTTP）。env AGENTCORE_OPENAPI_TIMEOUT_MS 可覆盖（毫秒，正整数）。 */
const DEFAULT_OPENAPI_TIMEOUT_MS = 600_000; // 10min

export interface OpenapiCallOptions {
  /** 全局与资源级 headers 合并，资源级优先。 */
  globalHeaders?: Record<string, string>;
  timeout?: number;
  /** HITL execute-on-resume 的下游幂等键（H5）：带 x-idempotency-key 头，让支持的下游去重（exactly-once）。 */
  idempotencyKey?: string;
  /** 资源调用日志器（记录 openapi 工具的出站请求/响应内容，便于排查上游错误）。 */
  log?: ResourceCallLogger;
  /** 工具名（仅用于日志关联，便于把请求/响应对到具体工具）。 */
  toolName?: string;
}

/**
 * 调用一个 openapi 工具 operation —— 把 echo 换成真实 HTTP：
 * - URL = serverUrl + path（serverUrl 为空 → 无端点，返回错误）
 * - method 来自 operation；GET/DELETE/HEAD → args 进 query，其余 → JSON body
 * - header 优先级：globalHeaders 铺底 → resource.headers
 *
 * 失败（无端点 / 缺 credentials / HTTP 非 2xx / 超时）返回 `{"error":...}` JSON 字符串，由调用方标 isError。
 */
export async function callOpenapiTool(
  resource: Resource,
  op: OpenapiOperation,
  args: Record<string, unknown>,
  credentials: Credentials | undefined,
  opts?: OpenapiCallOptions,
): Promise<string> {
  let url = joinUrl(op.serverUrl, op.path);
  if (!url) {
    return JSON.stringify({ error: "openapi tool has no endpoint (empty serverUrl and path)" });
  }

  const method = op.method.toUpperCase();
  const useQuery = QUERY_METHODS.has(op.method);
  let body = "";
  if (useQuery) {
    const u = new URL(url);
    for (const [k, v] of Object.entries(args ?? {})) {
      u.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
    }
    url = u.toString();
  } else {
    body = JSON.stringify(args ?? {});
  }

  const baseHeaders: Record<string, string> = {
    ...(opts?.globalHeaders ?? {}),
    ...(resource.headers ?? {}),
    ...(opts?.idempotencyKey ? { "x-idempotency-key": opts.idempotencyKey } : {}),
  };

  const finalUrl = url;
  const headers = { "content-type": "application/json", ...baseHeaders };
  try {
    await assertOutboundAllowed(url);
  } catch (err) {
    if (err instanceof SsrfBlockedError) return JSON.stringify({ error: `blocked outbound target: ${err.message}` });
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts?.timeout ?? envPositiveInt("AGENTCORE_OPENAPI_TIMEOUT_MS", DEFAULT_OPENAPI_TIMEOUT_MS),
  );
  // 记录 openapi 出站请求（method + 实际 URL + body）。
  logResourceRequest(opts?.log, { target: "openapi", toolName: opts?.toolName, method, url: finalUrl, body: useQuery ? undefined : body });
  const startedAt = Date.now();
  try {
    const resp = await fetch(finalUrl, {
      method,
      headers,
      body: useQuery ? undefined : body,
      signal: controller.signal,
      redirect: "error", // 不跟随重定向：可信 URL 也不应被 302 跳到内网/元数据（H1）。
    });
    const text = await resp.text().catch(() => "");
    logResourceResponse(opts?.log, {
      target: "openapi",
      toolName: opts?.toolName,
      status: resp.status,
      ok: resp.ok,
      durationMs: Date.now() - startedAt,
      body: text, // 含上游 error body：不回灌模型（H1），但落日志供排查（Logger 会脱敏密钥类键）。
    });
    if (!resp.ok) {
      // 不把上游 error body 回灌模型（提示注入/信息泄露，H1）：只回状态码。详情已落上面的 resource response 日志。
      return JSON.stringify({ error: `tool returned ${resp.status}` });
    }
    return text || JSON.stringify({ result: "ok", status: resp.status });
  } catch (err) {
    const timedOut = (err as Error).name === "AbortError";
    logResourceResponse(opts?.log, {
      target: "openapi",
      toolName: opts?.toolName,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: timedOut ? "openapi tool call timed out" : String(err),
    });
    if (timedOut) {
      return JSON.stringify({ error: "openapi tool call timed out" });
    }
    return JSON.stringify({ error: String(err) });
  } finally {
    clearTimeout(timer);
  }
}
