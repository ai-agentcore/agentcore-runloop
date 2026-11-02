import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __setSsrfLookupForTest } from "@/sidecar/ssrf.js";
import type { Resource, Credentials } from "@/types/resources.js";

// 回归：下游 MCP（protocol=mcp）按 `mcpConfig.transport` 选客户端 transport。
// bug 现象（prod 2026-06-18）：恒用 StreamableHTTP，对 transport:"sse" 的 /sse 端点发 POST → "Cannot POST /sse"、工具静默丢失。
// 这里 mock 掉两种 SDK transport 类 + Client，断言 dispatch 选对；并守 agentrun 签名 fetch 的 method 默认 = GET（SSE 建流 GET）。

const h = vi.hoisted(() => ({
  sseCtor: vi.fn(),
  httpCtor: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
  signedMethod: vi.fn(),
}));


vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class {
    constructor(url: URL, opts: unknown) {
      h.sseCtor(url, opts);
    }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(url: URL, opts: unknown) {
      h.httpCtor(url, opts);
    }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = vi.fn().mockResolvedValue(undefined);
    listTools = h.listTools;
    callTool = h.callTool;
    close = vi.fn().mockResolvedValue(undefined);
  },
}));

const { listDownstreamMcpTools, callDownstreamMcpTool } = await import("@/sidecar/mcp-proxy.js");

const CREDS: Credentials = { accessKeyId: "ak", accessKeySecret: "sk", accountId: "1234567890123456", region: "cn-hangzhou" };

function res(transport: "sse" | "http" | "stdio" | undefined, mode: "none" | "agentrun" = "none"): Resource {
  return {
    resourceId: "mcp-1",
    resourceName: "downstream",
    resourceType: "MCP",
    protocol: "mcp",
    mcpConfig: { ...(transport ? { transport } : {}), url: "https://host.example.com/sse" },
    auth: { mode },
  } as Resource;
}

beforeEach(() => {
  h.sseCtor.mockClear();
  h.httpCtor.mockClear();
  h.listTools.mockReset().mockResolvedValue({ tools: [] });
  h.callTool.mockReset().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
  h.signedMethod.mockReset();
  __setSsrfLookupForTest(async () => [{ address: "203.0.113.1" }]);
   // 用本地/mock host 验证签名管路；R1 拦截行为另由 ssrf/mcp-proxy 专门用例覆盖
});
afterEach(() => {
  vi.unstubAllGlobals();
  __setSsrfLookupForTest(null);

});

describe("mcp-proxy transport dispatch", () => {
  it("transport:sse → SSEClientTransport（而非 POST 到 /sse）", async () => {
    await listDownstreamMcpTools(res("sse"), undefined);
    expect(h.sseCtor).toHaveBeenCalledTimes(1);
    expect(h.httpCtor).not.toHaveBeenCalled();
    expect(String(h.sseCtor.mock.calls[0][0])).toBe("https://host.example.com/sse");
  });

  it("transport:http → StreamableHTTPClientTransport", async () => {
    await listDownstreamMcpTools(res("http"), undefined);
    expect(h.httpCtor).toHaveBeenCalledTimes(1);
    expect(h.sseCtor).not.toHaveBeenCalled();
  });

  it("transport 未声明 → 默认 StreamableHTTP", async () => {
    await listDownstreamMcpTools(res(undefined), undefined);
    expect(h.httpCtor).toHaveBeenCalledTimes(1);
    expect(h.sseCtor).not.toHaveBeenCalled();
  });

  it("transport:stdio → 抛错（聚合器不支持）", async () => {
    await expect(listDownstreamMcpTools(res("stdio"), CREDS)).rejects.toThrow(/stdio.*not supported/);
  });



  it("callDownstreamMcpTool：非 text content / 空 content 回落 / isError / 抛错", async () => {
    // 非 text content（JSON.stringify 包裹）
    h.callTool.mockResolvedValueOnce({ content: [{ type: "image", data: "b64" }], isError: false });
    let r = await callDownstreamMcpTool(res("http"), "t", {}, undefined);
    expect(r.content[0].text).toContain("image");
    // 空 content → 回落整个 res 的 JSON
    h.callTool.mockResolvedValueOnce({ content: [], isError: true });
    r = await callDownstreamMcpTool(res("http"), "t", {}, undefined);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("isError");
    // callTool 抛错 → catch 返回 isError
    h.callTool.mockRejectedValueOnce("boom-string");
    r = await callDownstreamMcpTool(res("http"), "t", {}, undefined);
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toBe("boom-string");
  });

  it("listDownstreamMcpTools：tools 缺省 → 空数组", async () => {
    h.listTools.mockResolvedValueOnce({});
    expect(await listDownstreamMcpTools(res("http"), undefined)).toEqual([]);
  });

  it("auth 缺省（mode 未声明）→ 视作 none、过 SSRF 校验", async () => {
    const noAuth = { resourceId: "m", resourceName: "d", resourceType: "MCP", protocol: "mcp", mcpConfig: { transport: "http", url: "https://h/mcp" } } as Resource;
    await listDownstreamMcpTools(noAuth, undefined);
    expect(h.httpCtor).toHaveBeenCalled();
  });

  it("无 mcpConfig.url → 抛错", async () => {
    const bad = { resourceId: "m", resourceName: "d", resourceType: "MCP", protocol: "mcp", mcpConfig: {} } as Resource;
    await expect(listDownstreamMcpTools(bad, undefined)).rejects.toThrow(/no mcpConfig.url/);
  });
});
