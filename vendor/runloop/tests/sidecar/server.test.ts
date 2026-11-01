import { describe, it, expect, afterEach, vi } from "vitest";
import { SidecarServer } from "@/sidecar/server.js";
import type { NonMcpResources } from "@/mcp/types.js";

/**
 * openapi 工具现在走真实 HTTP（callOpenapiTool → fetch）。stub global.fetch：
 * - 本地 sidecar（127.0.0.1）请求放行到原始 fetch（测试发给 sidecar 的 /call、/tools、/health）；
 * - 上游 openapi 端点请求返回受控 Response（工具结果即该响应体）。
 * 返回 spy 供断言 url/method/body。
 */
const realFetch = globalThis.fetch;
function stubUpstreamFetch(responseBody: unknown, status = 200) {
  const spy = vi.fn((url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("127.0.0.1") || u.includes("localhost")) return realFetch(url as never, init);
    const text = typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody);
    return Promise.resolve(new Response(text, { status }));
  });
  vi.stubGlobal("fetch", spy as unknown as typeof fetch);
  return spy;
}

const RESOURCES: NonMcpResources = {
  tools: [
    {
      resourceId: "fc1", resourceName: "calc", resourceType: "FUNCTIONCALL", protocol: "openapi", description: "Calculator",
      openapiConfig: {
        openapi: "3.0.0",
        servers: [{ url: "https://api.calc" }],
        paths: { "/calc": { post: { operationId: "calc", requestBody: { content: { "application/json": { schema: { type: "object", properties: { expr: { type: "string" } } } } } } } } },
      },
    },
  ],
  skills: [
    {
      resourceId: "sk1", resourceName: "review", resourceType: "SKILL", protocol: "openapi", description: "Code review",
      openapiConfig: {
        openapi: "3.0.0",
        servers: [{ url: "https://acct-ram.agentrun-data.cn-hangzhou.aliyuncs.com" }],
        paths: { "/skills/review/download": { get: { operationId: "download" } } },
      },
    },
  ],
  subAgents: [
    {
      resourceId: "ag1", resourceName: "bot", resourceType: "AGENT", protocol: "ag-ui", description: "Helper",
      // no invoke operation → deriveAgentEndpoint returns "" → delegation_request (not delegation_result)
      openapiConfig: { openapi: "3.0.0", paths: {} },
    },
  ],
  sandboxes: [
    {
      resourceId: "sbr1", resourceName: "py-sandbox", resourceType: "SANDBOX", protocol: "openapi",
      openapiConfig: {
        openapi: "3.0.0",
        servers: [{ url: "https://data.example/sandboxes/sb1" }],
        paths: { "/contexts/execute": { post: { operationId: "sandbox_sb1_exec" } } },
      },
    },
  ],
};

const EMPTY: NonMcpResources = {
  tools: [],
  skills: [],
  subAgents: [],
  sandboxes: [],
};

describe("SidecarServer", () => {
  let server: SidecarServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
    vi.unstubAllGlobals();
  });

  it("starts on a random port and exposes baseUrl", async () => {
    server = new SidecarServer({ resources: EMPTY });
    const port = await server.start();
    expect(port).toBeGreaterThan(0);
    expect(server.port).toBe(port);
    expect(server.baseUrl).toBe(`http://127.0.0.1:${port}`);
  });

  it("stops cleanly even when not started", async () => {
    server = new SidecarServer({ resources: EMPTY });
    await expect(server.stop()).resolves.toBeUndefined();
    server = null;
  });

  it("GET /health returns ok", async () => {
    server = new SidecarServer({ resources: EMPTY });
    await server.start();

    const res = await fetch(`${server.baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });

  it("remoteExecSandbox 注入 → bash 工具路由到隔离沙箱数据面（不在本地执行）", async () => {
    const fetchSpy = stubUpstreamFetch({ result: { exitCode: 0, stdout: "remote-ok", stderr: "" } });
    const sb = {
      resourceId: "sbx-7", resourceName: "py", resourceType: "SANDBOX", protocol: "openapi",
      openapiConfig: { servers: [{ url: "https://1234567890123456.agentrun-data.cn-hangzhou.aliyuncs.com" }] },
    };
    server = new SidecarServer({
      resources: EMPTY,
      credentials: { accessKeyId: "ak", accessKeySecret: "sk", accountId: "1234567890123456", region: "cn-hangzhou" },
      remoteExecSandbox: sb as never,
    });
    await server.start();

    const r = await server.gatedExecute("bash", { command: "echo hi" });
    expect(JSON.parse(r.content[0].text)).toMatchObject({ stdout: "remote-ok", exit_code: 0 });
    // 命令打到了沙箱数据面 /processes/cmd（远端），而非本地 bash。
    const cmdCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes("/sandboxes/sbx-7/processes/cmd"));
    expect(cmdCall).toBeTruthy();
  });

  it("initRemoteSandbox（有 Sandbox + SKILL）→ 在沙箱内 curl 下载解包 skill（Change B / option b）", async () => {
    const fetchSpy = stubUpstreamFetch({ result: { exitCode: 0, stdout: "", stderr: "" } });
    const sb = {
      resourceId: "sbx-9", resourceName: "py", resourceType: "SANDBOX", protocol: "openapi",
      openapiConfig: { servers: [{ url: "https://1234567890123456.agentrun-data.cn-hangzhou.aliyuncs.com" }] },
    };
    server = new SidecarServer({
      resources: { ...EMPTY, skills: RESOURCES.skills }, // 含 SKILL "review"（download operation）
      credentials: { accessKeyId: "ak", accessKeySecret: "sk", accountId: "1234567890123456", region: "cn-hangzhou" },
      remoteExecSandbox: sb as never,
    });
    await server.start();

    await server.initRemoteSandbox({ localWorkspaceDir: "/tmp/ignored" });
    // 经沙箱 /processes/cmd 跑 curl 下载脚本（不经本地盘、不经数据面 writeFile）。
    const cmdCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes("/sandboxes/sbx-9/processes/cmd"));
    expect(cmdCall).toBeTruthy();
    const cmd = JSON.parse((cmdCall![1] as { body: string }).body).command as string;
    expect(cmd).toContain("curl");
    expect(cmd).toContain(".agents/skills/review");
    expect(cmd).toContain("Agentrun-Authorization:");
    // 不经数据面 writeFile（POST /files）落盘——option b 是沙箱内直发下载。
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).endsWith("/files"))).toBe(false);
  });

  it("listTools：get_skill 仅零执行态（无 execShell）注入；有 execShell 不注入（与 buildExtraTools 一致，Change A）", () => {
    // 无 execShell + 有 SKILL → 注入 get_skill（读 skill 正文的唯一通道）。
    const noShell = new SidecarServer({ resources: { ...EMPTY, skills: RESOURCES.skills } });
    expect(noShell.listTools().map((t) => t.name)).toContain("get_skill");
    // 有 execShell（本地/沙箱执行）+ 有 SKILL → 不注入 get_skill（skill 走标准 read_file/bash）。
    const withShell = new SidecarServer({ resources: { ...EMPTY, skills: RESOURCES.skills }, execShell: true });
    expect(withShell.listTools().map((t) => t.name)).not.toContain("get_skill");
  });

  it("GET /tools returns tool descriptors", async () => {
    server = new SidecarServer({ resources: RESOURCES });
    await server.start();

    const res = await fetch(`${server.baseUrl}/tools`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const names = body.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("function__calc__calc");
    // SKILL 不暴露为模型工具（安装期下载解包，不进 tool list）
    expect(names).not.toContain("review");
    expect(names).toContain("agent__bot__delegate");
    expect(names).toContain("sandbox__py_sandbox__sandbox_sb1_exec");
  });

  it("GET /tools returns empty list for empty resources", async () => {
    server = new SidecarServer({ resources: EMPTY });
    await server.start();

    const res = await fetch(`${server.baseUrl}/tools`);
    const body = await res.json();
    expect(body.tools).toEqual([]);
  });

  it("POST /call invokes a function call tool (real HTTP, fetch stubbed)", async () => {
    const spy = stubUpstreamFetch({ ok: true, computed: 4 });
    server = new SidecarServer({ resources: RESOURCES });
    await server.start();

    const res = await fetch(`${server.baseUrl}/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "function__calc__calc", args: { expr: "2+2" } }),
    });
    expect(res.status).toBe(200);
    const result = await res.json();
    const data = JSON.parse(result.content[0].text);
    expect(data.ok).toBe(true);
    expect(data.computed).toBe(4);
    // 上游被调到正确的 operation（path /calc，body 含 args）
    const upstream = spy.mock.calls.find((c) => !String(c[0]).includes("127.0.0.1"))!;
    expect(String(upstream[0])).toBe("https://api.calc/calc");
    expect((upstream[1] as RequestInit).body).toBe(JSON.stringify({ expr: "2+2" }));
  });

  it("POST /call invokes a sandbox tool (real HTTP, fetch stubbed)", async () => {
    const spy = stubUpstreamFetch({ stdout: "1" });
    server = new SidecarServer({ resources: RESOURCES });
    await server.start();

    const res = await fetch(`${server.baseUrl}/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "sandbox__py_sandbox__sandbox_sb1_exec", args: { code: "print(1)" } }),
    });
    expect(res.status).toBe(200);
    const result = await res.json();
    const data = JSON.parse(result.content[0].text);
    expect(data.stdout).toBe("1");
    const upstream = spy.mock.calls.find((c) => !String(c[0]).includes("127.0.0.1"))!;
    expect(String(upstream[0])).toContain("/contexts/execute");
    expect((upstream[1] as RequestInit).body).toBe(JSON.stringify({ code: "print(1)" }));
  });

  it("POST /call returns error for skill name (skills are not callable tools)", async () => {
    server = new SidecarServer({ resources: RESOURCES });
    await server.start();

    // SKILL 不暴露为工具：用 skill 的 resourceName 调用 → Unknown tool
    const res = await fetch(`${server.baseUrl}/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "review", args: { input: "code" } }),
    });
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown tool");
  });

  it("POST /call returns error for unknown tool", async () => {
    server = new SidecarServer({ resources: RESOURCES });
    await server.start();

    const res = await fetch(`${server.baseUrl}/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "nonexistent", args: {} }),
    });
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown tool");
  });

  it("POST /call defaults args to {} when omitted", async () => {
    const spy = stubUpstreamFetch({ ok: true });
    server = new SidecarServer({ resources: RESOURCES });
    await server.start();

    const res = await fetch(`${server.baseUrl}/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "function__calc__calc" }),
    });
    expect(res.status).toBe(200);
    const result = await res.json();
    const data = JSON.parse(result.content[0].text);
    expect(data.ok).toBe(true);
    // args 省略 → 默认 {} 进 body
    const upstream = spy.mock.calls.find((c) => !String(c[0]).includes("127.0.0.1"))!;
    expect((upstream[1] as RequestInit).body).toBe(JSON.stringify({}));
  });

  it("POST /call tolerates trailing extra braces from shell escaping", async () => {
    const spy = stubUpstreamFetch({ ok: true });
    server = new SidecarServer({ resources: RESOURCES });
    await server.start();

    const res = await fetch(`${server.baseUrl}/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"name":"function__calc__calc","args":{"expr":"1+1"}}}',
    });
    expect(res.status).toBe(200);
    const result = await res.json();
    const data = JSON.parse(result.content[0].text);
    expect(data.ok).toBe(true);
    // 容错解析后正确把 args 传给上游
    const upstream = spy.mock.calls.find((c) => !String(c[0]).includes("127.0.0.1"))!;
    expect((upstream[1] as RequestInit).body).toBe(JSON.stringify({ expr: "1+1" }));
  });

  it("POST /call returns 400 for invalid JSON", async () => {
    server = new SidecarServer({ resources: RESOURCES });
    await server.start();

    const res = await fetch(`${server.baseUrl}/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json-at-all",
    });
    expect(res.status).toBe(400);
    const result = await res.json();
    expect(result.error).toBeDefined();
  });

  it("returns 404 for unknown routes", async () => {
    server = new SidecarServer({ resources: EMPTY });
    await server.start();

    const res = await fetch(`${server.baseUrl}/unknown`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not found");
  });

  it("returns 404 for wrong method on known route", async () => {
    server = new SidecarServer({ resources: EMPTY });
    await server.start();

    const res = await fetch(`${server.baseUrl}/health`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("passes credentials and conversationId to tool call context", async () => {
    server = new SidecarServer({
      resources: RESOURCES,
      credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
      conversationId: "sess-1",
    });
    await server.start();

    const res = await fetch(`${server.baseUrl}/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "agent__bot__delegate", args: { task: "hello" } }),
    });
    expect(res.status).toBe(200);
    const result = await res.json();
    const data = JSON.parse(result.content[0].text);
    expect(data.type).toBe("delegation_request");
    expect(data.agent).toBe("bot");
  });

  it("handles query string in URL without breaking routing", async () => {
    server = new SidecarServer({ resources: EMPTY });
    await server.start();

    const res = await fetch(`${server.baseUrl}/health?v=1`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});
