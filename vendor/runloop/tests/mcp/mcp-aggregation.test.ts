import { describe, it, expect, afterEach, vi } from "vitest";
import { AgentrunMcpServer } from "@/mcp/server.js";
import type { NonMcpResources } from "@/mcp/types.js";
import type { Resource } from "@/types/resources.js";

/**
 * 确认 runloop 对 `protocol:mcp` 资源（下游 MCP，由进程内 agentrun-mcp 聚合器代理）的两件事：
 *   1. 识别 tools —— 聚合器 tools/list 是否暴露下游 MCP 的工具。
 *   2. 正确调用 —— 聚合器 tools/call 是否透传到下游 MCP 并取回结果。
 *
 * mock 手法：AgentrunMcpServer 本身就是个标准 MCP server，故用它当「下游 MCP」（暴露一个 openapi calc 工具），
 * 再用另一个 AgentrunMcpServer 当「聚合器」，其 resources.mcpServers 指向下游。全程进程内 HTTP，不需 codex/模型/AR token。
 */

/** 下游 MCP server 暴露的工具：openapi calc（被调用时做一次 openapi HTTP，测试里 stub 掉）。下游暴露名 = `function__calc__calc`。 */
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
} as Resource;
const DOWNSTREAM_RESOURCES: NonMcpResources = { tools: [CALC], skills: [], subAgents: [], sandboxes: [], mcpServers: [] };

/** 指向本地下游 server 的 mcp 资源（聚合代理目标）。withManifest=true 带静态工具清单。 */
function mcpResource(baseUrl: string, withManifest: boolean): Resource {
  return {
    resourceId: "mcp-1",
    resourceName: "downstream",
    resourceType: "MCP",
    protocol: "mcp",
    mcpConfig: { transport: "http", url: `${baseUrl}/mcp` },
    auth: { mode: "none" },
    ...(withManifest ? { toolManifest: [{ name: "function__calc__calc", description: "算" }] } : {}),
  } as Resource;
}

function aggResources(mcp: Resource): NonMcpResources {
  return { tools: [], skills: [], subAgents: [], sandboxes: [], mcpServers: [mcp] };
}

/** stub fetch：本地 127.0.0.1（聚合器↔下游 server）放行，其余（下游工具的 openapi 上游）返回受控响应。 */
function stubUpstream(body: unknown) {
  const realFetch = globalThis.fetch;
  const spy = vi.fn((url: string | URL, init?: RequestInit) => {
    if (String(url).includes("127.0.0.1")) return realFetch(url as never, init);
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  });
  vi.stubGlobal("fetch", spy as unknown as typeof fetch);
}

async function listToolNames(agg: AgentrunMcpServer): Promise<string[]> {
  const r = await agg.handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  return ((r.result as { tools?: Array<{ name: string }> })?.tools ?? []).map((t) => t.name);
}

async function callTool(agg: AgentrunMcpServer, name: string, args: Record<string, unknown>) {
  const r = await agg.handleJsonRpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  return r.result as { content: Array<{ text: string }>; isError?: boolean };
}

describe("MCP 聚合：下游 MCP 工具的识别与调用", () => {
  const servers: AgentrunMcpServer[] = [];
  const spawn = async (resources: NonMcpResources) => {
    const s = new AgentrunMcpServer({ resources });
    await s.start();
    servers.push(s);
    return s;
  };

  afterEach(async () => {
    vi.unstubAllGlobals();
    while (servers.length) await servers.pop()!.stop();
  });

  it("识别 tools（含 toolManifest）：聚合器 tools/list 暴露下游 MCP 工具", async () => {
    const downstream = await spawn(DOWNSTREAM_RESOURCES);
    const agg = await spawn(aggResources(mcpResource(downstream.baseUrl, true)));

    const names = await listToolNames(agg);
    expect(names).toContain("mcp__downstream__function__calc__calc");
  });

  it("正确调用（含 toolManifest）：聚合器 tools/call 透传到下游 MCP 并取回结果", async () => {
    stubUpstream({ ok: true, expr: "2+2" });
    const downstream = await spawn(DOWNSTREAM_RESOURCES);
    const agg = await spawn(aggResources(mcpResource(downstream.baseUrl, true)));

    const res = await callTool(agg, "mcp__downstream__function__calc__calc", { expr: "2+2" });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text).ok).toBe(true);
  });

  // 上游真实下发的 protocol:mcp 资源（如 github / knowledgebase-bailian）**不带 toolManifest**。
  // AD-027 契约：「无清单→聚合器启动时连下游 tools/list 发现」。已接线 discoverDownstreamTools（mcp/server.ts）：
  // start() 时对无 manifest 的下游连 tools/list 写回 toolManifest → 工具对 codex/模型可见可调（修复"codex 没读 MCP 数据"）。
  it(
    "识别 tools（无 toolManifest，上游真实形态）：聚合器启动时运行时发现并暴露下游工具",
    async () => {
      const downstream = await spawn(DOWNSTREAM_RESOURCES);
      const agg = await spawn(aggResources(mcpResource(downstream.baseUrl, false)));

      const names = await listToolNames(agg);
      expect(names.some((n) => n.includes("function__calc__calc"))).toBe(true);
    },
  );
});
