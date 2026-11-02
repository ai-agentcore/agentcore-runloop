import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Credentials, Resource } from "../types/resources.js";
import type { McpToolResult } from "../mcp/types.js";
import { assertOutboundAllowed } from "./ssrf.js";
import { logResourceRequest, logResourceResponse, type ResourceCallLogger } from "./resource-log.js";

/**
 * 本模块用 MCP SDK 的 Client + StreamableHTTPClientTransport 连下游 server、转发 tools/call、tools/list。
 */

interface McpProxyOptions {
  /** 顶层 request.headers（全局，铺底；与 mcpConfig.headers 合并，资源级优先）。 */
  globalHeaders?: Record<string, string>;
  timeout?: number;
  /** 资源调用日志器（记录下游 MCP tools/call 的请求/响应内容）。 */
  log?: ResourceCallLogger;
}

function downstreamUrl(resource: Resource): string {
  const mc = resource.mcpConfig as { url?: string } | undefined;
  return mc?.url ?? "";
}

function downstreamTransportKind(resource: Resource): "stdio" | "http" | "sse" | undefined {
  return (resource.mcpConfig as { transport?: "stdio" | "http" | "sse" } | undefined)?.transport;
}

async function withClient<T>(
  resource: Resource,
  credentials: Credentials | undefined,
  opts: McpProxyOptions | undefined,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const url = downstreamUrl(resource);
  if (!url) throw new Error("mcp resource has no mcpConfig.url");

  await assertOutboundAllowed(url);
  const headers = { ...(opts?.globalHeaders ?? {}), ...((resource.mcpConfig as { headers?: Record<string, string> } | undefined)?.headers ?? {}) };

  const transportOpts: ConstructorParameters<typeof StreamableHTTPClientTransport>[1] = {
    requestInit: { headers },
  };
  // 按 mcpConfig.transport 选客户端：`sse` → 已弃用但仍广泛存在的 SSE transport（GET 建流 + 单独 POST 回发）；
  // 早期恒用 StreamableHTTP，导致对 `transport:"sse"` 的 `/sse` 端点发 POST → 服务器 `Cannot POST /sse`、工具静默丢失。
  const kind = downstreamTransportKind(resource);
  if (kind === "stdio") {
    throw new Error("mcp transport 'stdio' not supported by the in-process aggregator (need command/args, no url)");
  }
  const client = new Client({ name: "runloop-aggregator", version: "1.0.0" });
  const transport: Transport =
    kind === "sse"
      ? new SSEClientTransport(new URL(url), transportOpts)
      : new StreamableHTTPClientTransport(new URL(url), transportOpts);
  try {
    // honor opts.timeout（R3）：慢/挂住的下游不应无界阻塞（尤其启动期 discoverDownstreamTools，
    // 否则拖垮整个 run 启动，与 best-effort/non-fatal 语义矛盾）。未设 timeout 时不限时（如工具调用）。
    const run = (async () => {
      await client.connect(transport);
      return await fn(client);
    })();
    const timeoutMs = opts?.timeout;
    if (!timeoutMs || timeoutMs <= 0) return await run;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error(`mcp downstream timeout after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      return await Promise.race([run, guard]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * 转发一次 tools/call 给下游 MCP server。`toolName` 必须是**下游的原始工具名**（非净化名）。
 * 失败（无 url / 缺 credentials / 连接或调用异常）返回 isError 的 McpToolResult。
 */
export async function callDownstreamMcpTool(
  resource: Resource,
  toolName: string,
  args: Record<string, unknown>,
  credentials: Credentials | undefined,
  opts?: McpProxyOptions,
): Promise<McpToolResult> {
  // 记录下游 MCP tools/call 出站请求（下游 url + 原始工具名 + 参数）。
  logResourceRequest(opts?.log, {
    target: "mcp",
    toolName,
    method: "tools/call",
    url: downstreamUrl(resource),
    body: JSON.stringify(args ?? {}),
  });
  const startedAt = Date.now();
  try {
    const result = await withClient(resource, credentials, opts, async (client) => {
      const res = (await client.callTool({ name: toolName, arguments: args })) as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      const content = (res.content ?? []).map((c) => ({
        type: "text" as const,
        text: c.type === "text" && typeof c.text === "string" ? c.text : JSON.stringify(c),
      }));
      return {
        content: content.length > 0 ? content : [{ type: "text" as const, text: JSON.stringify(res) }],
        isError: res.isError === true,
      };
    });
    logResourceResponse(opts?.log, {
      target: "mcp",
      toolName,
      ok: !result.isError,
      durationMs: Date.now() - startedAt,
      body: result.content?.[0]?.text,
    });
    return result;
  } catch (err) {
    logResourceResponse(opts?.log, {
      target: "mcp",
      toolName,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
      isError: true,
    };
  }
}

/** 懒连后用真实 tools/list 校正清单（self-heal）：返回下游真实工具列表（name/description/inputSchema）。 */
export async function listDownstreamMcpTools(
  resource: Resource,
  credentials: Credentials | undefined,
  opts?: McpProxyOptions,
): Promise<Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>> {
  return withClient(resource, credentials, opts, async (client) => {
    const res = (await client.listTools()) as {
      tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
    };
    return res.tools ?? [];
  });
}
