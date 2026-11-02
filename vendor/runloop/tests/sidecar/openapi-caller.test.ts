import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callOpenapiTool } from "@/sidecar/openapi-caller.js";
import { __setSsrfLookupForTest } from "@/sidecar/ssrf.js";
import type { OpenapiOperation } from "@/mcp/openapi.js";
import type { Resource, Credentials } from "@/types/resources.js";

// SSRF 守卫对非 agentrun URL 会做 DNS 解析；注入假解析器返公网 IP（TEST-NET-3），避免单测依赖真实网络。
beforeEach(() => __setSsrfLookupForTest(async () => [{ address: "203.0.113.1" }]));

const CREDS: Credentials = {
  accessKeyId: "ak",
  accessKeySecret: "sk",
  accountId: "1234567890123456",
  region: "cn-hangzhou",
};

function op(over: Partial<OpenapiOperation> = {}): OpenapiOperation {
  return {
    operationId: "getWeather",
    method: "post",
    path: "/weather",
    serverUrl: "https://api.example.com",
    inputSchema: { type: "object" },
    ...over,
  };
}

function resource(over: Partial<Resource> = {}): Resource {
  return {
    resourceId: "fc-1",
    resourceName: "getWeather",
    resourceType: "FUNCTIONCALL",
    protocol: "openapi",
    ...over,
  } as Resource;
}

function mockFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy as unknown as typeof fetch);
  return spy;
}

afterEach(() => { vi.unstubAllGlobals(); __setSsrfLookupForTest(null); });

describe("callOpenapiTool", () => {
  it("POST: args → JSON body, merges global + resource headers, mode=none 不签名", async () => {
    const spy = mockFetch(() => new Response("ok-body", { status: 200 }));
    const out = await callOpenapiTool(
      resource({ headers: { "X-Api-Key": "k" }, auth: { mode: "none" } }),
      op(),
      { city: "hz" },
      CREDS,
      { globalHeaders: { "X-Trace": "t" } },
    );
    expect(out).toBe("ok-body");
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("https://api.example.com/weather");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ city: "hz" }));
    expect(init.headers).toMatchObject({ "X-Trace": "t", "X-Api-Key": "k", "content-type": "application/json" });
    // mode=none 不应有签名头
    expect((init.headers as Record<string, string>)["Agentrun-Authorization"]).toBeUndefined();
  });

  it("GET: args → query string，无 body", async () => {
    const spy = mockFetch(() => new Response("[]", { status: 200 }));
    await callOpenapiTool(resource(), op({ method: "get", path: "/search" }), { q: "x", n: 3 }, CREDS);
    const [url, init] = spy.mock.calls[0];
    expect(url).toContain("https://api.example.com/search?");
    expect(url).toContain("q=x");
    expect(url).toContain("n=3");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });



  it("HTTP 非 2xx → 只回状态码，不回灌上游 body（H1）", async () => {
    mockFetch(() => new Response("boom", { status: 500 }));
    const out = JSON.parse(await callOpenapiTool(resource(), op(), {}, CREDS));
    expect(out.error).toContain("500");
    // 上游 error body 不再经 tool result 喂回模型（提示注入/信息泄露）。
    expect(out.detail).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("boom");
  });

  it("SSRF：mode=none 指向私网/环回 → 拦截，不发请求（H1）", async () => {
    __setSsrfLookupForTest(async () => [{ address: "169.254.169.254" }]); // 云元数据
    const spy = mockFetch(() => new Response("should-not-reach", { status: 200 }));
    const out = JSON.parse(await callOpenapiTool(resource({ auth: { mode: "none" } }), op(), {}, CREDS));
    expect(out.error).toContain("blocked outbound target");
    expect(spy).not.toHaveBeenCalled();
  });


  it("fetch 抛错 → error 字符串", async () => {
    mockFetch(() => { throw new Error("ECONNREFUSED"); });
    const out = JSON.parse(await callOpenapiTool(resource(), op(), {}, CREDS));
    expect(out.error).toContain("ECONNREFUSED");
  });

  it("无端点（serverUrl 与 path 皆空）→ error", async () => {
    const spy = mockFetch(() => new Response("x"));
    const out = await callOpenapiTool(resource(), op({ serverUrl: "", path: "" }), {}, CREDS);
    expect(JSON.parse(out).error).toMatch(/no endpoint/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("空响应体 → 返回 ok 占位", async () => {
    mockFetch(() => new Response("", { status: 200 }));
    const out = JSON.parse(await callOpenapiTool(resource(), op(), {}, CREDS));
    expect(out.result).toBe("ok");
  });

  it("超时 → timed out", async () => {
    mockFetch((_url, init) => new Promise((_res, rej) => {
      (init.signal as AbortSignal).addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const out = JSON.parse(await callOpenapiTool(resource(), op(), {}, CREDS, { timeout: 10 }));
    expect(out.error).toMatch(/timed out/);
  });
});
