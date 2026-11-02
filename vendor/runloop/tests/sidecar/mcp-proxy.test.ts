import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { callDownstreamMcpTool, listDownstreamMcpTools } from "@/sidecar/mcp-proxy.js";
import { RunloopMcpServer } from "@/mcp/server.js";
import { __setSsrfLookupForTest } from "@/sidecar/ssrf.js";
import type { NonMcpResources } from "@/mcp/types.js";
import type { Resource, Credentials } from "@/types/resources.js";

// 下游 MCP 测试连本地 127.0.0.1 server；SSRF 守卫对非 agentrun URL 会拦私网，注入假解析器返公网 IP 放行。
// none 模式：lookup 注入公网 IP 让本地 127.0.0.1 mock 通过 assertOutboundAllowed；
// agentrun 模式：关掉域名白名单（R1）以连本地 mock（拦截行为另由专门用例覆盖，不削弱生产）。
beforeEach(() => {
  __setSsrfLookupForTest(async () => [{ address: "203.0.113.1" }]);

});
afterEach(() => {
  __setSsrfLookupForTest(null);

});

const CREDS: Credentials = { accessKeyId: "ak", accessKeySecret: "sk", accountId: "1234567890123456", region: "cn-hangzhou" };

/** 下游 MCP server 暴露的一个 openapi 工具（被调用时做一次 openapi HTTP，测试里 stub 掉）。 */
const CALC: Resource = {
  resourceId: "fc-calc",
  resourceName: "calc",
  resourceType: "FUNCTIONCALL",
  protocol: "openapi",
  openapiConfig: {
    openapi: "3.0.0",
    servers: [{ url: "https://api.example.com" }],
    paths: { "/calc": { post: { operationId: "calc" } } },
  },
};
const DOWNSTREAM: NonMcpResources = { tools: [CALC], skills: [], subAgents: [], sandboxes: [], mcpServers: [] };

/** 指向本地下游 server 的 mcp 资源（聚合代理目标）。 */
function mcpResource(baseUrl: string, mode: "none" | "agentrun" = "none"): Resource {
  return {
    resourceId: "mcp-1",
    resourceName: "downstream",
    resourceType: "MCP",
    protocol: "mcp",
    mcpConfig: { transport: "http", url: `${baseUrl}/mcp` },
    auth: { mode },
    toolManifest: [{ name: "function__calc__calc", description: "算" }],
  } as Resource;
}

/** stub fetch：本地 127.0.0.1（proxy↔下游 server）放行，其余（下游工具的 openapi 上游）返回受控响应。 */
function stubUpstream(body: unknown) {
  const realFetch = globalThis.fetch;
  const spy = vi.fn((url: string | URL, init?: RequestInit) => {
    if (String(url).includes("127.0.0.1")) return realFetch(url as never, init);
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  });
  vi.stubGlobal("fetch", spy as unknown as typeof fetch);
  return spy;
}

describe("mcp-proxy（聚合代理下游 MCP）", () => {
  let server: RunloopMcpServer;
  afterEach(async () => {
    vi.unstubAllGlobals();
    if (server) await server.stop();
  });

  it("callDownstreamMcpTool: 连下游、转发 tools/call、透传结果（mode=none）", async () => {
    stubUpstream({ ok: true, expr: "2+2" });
    server = new RunloopMcpServer({ resources: DOWNSTREAM });
    await server.start();

    const res = await callDownstreamMcpTool(mcpResource(server.baseUrl), "function__calc__calc", { expr: "2+2" }, undefined);
    expect(res.isError).toBe(false);
    const data = JSON.parse(res.content[0].text);
    expect(data.ok).toBe(true);
  });


  it("listDownstreamMcpTools: self-heal 用——返回下游真实工具清单", async () => {
    stubUpstream({ ok: true });
    server = new RunloopMcpServer({ resources: DOWNSTREAM });
    await server.start();

    const tools = await listDownstreamMcpTools(mcpResource(server.baseUrl), undefined);
    expect(tools.map((t) => t.name)).toContain("function__calc__calc");
  });


  it("opts.timeout：下游挂住（接受连接但不响应）→ 超时 isError，不无界阻塞（R3）", async () => {
    const hang: Server = createServer(() => { /* 永不响应 */ });
    await new Promise<void>((r) => hang.listen(0, "127.0.0.1", () => r()));
    const port = (hang.address() as { port: number }).port;
    try {
      const res = await callDownstreamMcpTool(
        mcpResource(`http://127.0.0.1:${port}/mcp`), "function__calc__calc", {}, undefined, { timeout: 200 },
      );
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/timeout/i);
    } finally {
      hang.close();
    }
  });

  it("无 mcpConfig.url → isError", async () => {
    const bad = { resourceId: "x", resourceName: "x", resourceType: "MCP", protocol: "mcp", mcpConfig: {} } as Resource;
    const res = await callDownstreamMcpTool(bad, "calc", {}, undefined);
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toMatch(/no mcpConfig.url/);
  });

});
