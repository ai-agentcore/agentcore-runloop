import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RemoteSandboxBridge, resolveSandboxOps, SANDBOX_OP_DEFAULTS, type SandboxOps } from "@/sidecar/remote-sandbox.js";
import type { Credentials } from "@/types/resources.js";

const CREDS: Credentials = { accessKeyId: "ak", accessKeySecret: "sk", accountId: "1234567890123456", region: "cn-hangzhou" };
const TARGET = { dataBase: "https://1234567890123456.agentrun-data.cn-hangzhou.aliyuncs.com", sandboxId: "sbx-1" };

let fetchMock: ReturnType<typeof vi.fn>;
const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
const responses: Array<{ body: unknown; ok: boolean; status: number }> = [];

function jsonRes(body: unknown, ok = true, status = 200) {
  return { ok, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
}
/** 入队下一个响应（按 FIFO 出队；空则默认 {}）。 */
function nextRes(body: unknown, ok = true, status = 200) {
  responses.push({ body, ok, status });
}

beforeEach(() => {
  calls.length = 0;
  responses.length = 0;
  fetchMock = vi.fn(async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const r = responses.shift() ?? { body: {}, ok: true, status: 200 };
    return jsonRes(r.body, r.ok, r.status) as never;
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("RemoteSandboxBridge（数据面 REST 客户端）", () => {
  it("executeCommand 打 POST /sandboxes/{id}/processes/cmd，host 改写为 -ram、带签名头，解析 {result:{...}}", async () => {
    nextRes({ status: "completed", result: { exitCode: 0, stdout: "hello\n", stderr: "" } });
    const bridge = new RemoteSandboxBridge(TARGET, CREDS);
    const r = await bridge.executeCommand("echo hello");

    expect(r).toEqual({ exitCode: 0, stdout: "hello\n", stderr: "" });
    expect(calls[0].method).toBe("POST");
    // host 改写 -ram + 正确 path
    expect(calls[0].url).toContain("1234567890123456-ram.agentrun-data.cn-hangzhou.aliyuncs.com");
    expect(calls[0].url).toContain("/sandboxes/sbx-1/processes/cmd");
    expect(calls[0].headers["Agentrun-Authorization"]).toMatch(/^AGENTRUN4-HMAC-SHA256/);
    expect(JSON.parse(calls[0].body!)).toMatchObject({ command: "echo hello" });
  });

  it("executeCommand 兼容旧版平铺响应（exit_code/output/error）", async () => {
    nextRes({ exit_code: 2, output: "out", error: "boom" });
    const r = await new RemoteSandboxBridge(TARGET, CREDS).executeCommand("x");
    expect(r).toEqual({ exitCode: 2, stdout: "out", stderr: "boom" });
  });

  it("executeCommand：显式 exit=0 + error（非致命提示）→ 不把 error 当 stderr，避免误判失败（L2）", async () => {
    nextRes({ exitCode: 0, stdout: "ok", error: "deprecation warning" });
    const r = await new RemoteSandboxBridge(TARGET, CREDS).executeCommand("x");
    expect(r).toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
  });

  it("executeCommand：无显式退出码但有 error → 推断 exit=1 且 error 作 stderr", async () => {
    nextRes({ error: "boom" });
    const r = await new RemoteSandboxBridge(TARGET, CREDS).executeCommand("x");
    expect(r).toEqual({ exitCode: 1, stdout: "", stderr: "boom" });
  });

  it("executeCommand：status≠completed 且 exitCode=0 → 修正为 1", async () => {
    nextRes({ status: "timeout", result: { exitCode: 0, stdout: "", stderr: "" } });
    const r = await new RemoteSandboxBridge(TARGET, CREDS).executeCommand("sleep 999");
    expect(r.exitCode).toBe(1);
  });

  it("readFile 打 GET /files?path=，兼容 {content}/{data}/裸文本", async () => {
    const bridge = new RemoteSandboxBridge(TARGET, CREDS);
    nextRes({ content: "abc" });
    expect(await bridge.readFile("/a.txt")).toBe("abc");
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toContain("/sandboxes/sbx-1/files?path=%2Fa.txt");

    nextRes({ data: "ddd" });
    expect(await bridge.readFile("/b")).toBe("ddd");

    nextRes("plain-text");
    expect(await bridge.readFile("/c")).toBe("plain-text");
  });

  it("writeFile 打 POST /files，body 含 createDir", async () => {
    await new RemoteSandboxBridge(TARGET, CREDS).writeFile("/x.txt", "data");
    expect(calls[0].url).toContain("/sandboxes/sbx-1/files");
    expect(JSON.parse(calls[0].body!)).toEqual({ path: "/x.txt", content: "data", createDir: true });
  });

  it("listDirectory 解析 entries，归一化 type", async () => {
    nextRes({ entries: [{ name: "a", type: "file" }, { name: "d", isDir: true }] });
    const r = await new RemoteSandboxBridge(TARGET, CREDS).listDirectory("/", 2);
    expect(r).toEqual([{ name: "a", type: "file" }, { name: "d", type: "dir" }]);
    expect(calls[0].url).toContain("/filesystem?path=%2F&depth=2");
  });

  it("mkdir 打 POST /filesystem/mkdir，parents=true", async () => {
    await new RemoteSandboxBridge(TARGET, CREDS).mkdir("/p/q");
    expect(JSON.parse(calls[0].body!)).toEqual({ path: "/p/q", parents: true });
  });

  it("HTTP 非 2xx → 抛错（含状态码与 body 片段）", async () => {
    nextRes("not found", false, 404);
    await expect(new RemoteSandboxBridge(TARGET, CREDS).readFile("/x")).rejects.toThrow(/HTTP 404/);
  });

  it("readFile：响应对象无 content/data/raw → JSON.stringify 兜底", async () => {
    nextRes({ weird: 1 });
    expect(await new RemoteSandboxBridge(TARGET, CREDS).readFile("/x")).toBe('{"weird":1}');
  });

  it("listDirectory：兼容 {files:[{path,isDirectory}]} 与非数组兜底为 []", async () => {
    const bridge = new RemoteSandboxBridge(TARGET, CREDS);
    nextRes({ files: [{ path: "/a", isDirectory: true }] });
    expect(await bridge.listDirectory()).toEqual([{ name: "/a", type: "dir" }]);
    nextRes({ nope: true });
    expect(await bridge.listDirectory()).toEqual([]);
  });

  it("空响应体 → 解析为 {}（executeCommand 退化为 exit 0/空输出）", async () => {
    nextRes("");
    const r = await new RemoteSandboxBridge(TARGET, CREDS).executeCommand("noop");
    expect(r).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  // ── spec 驱动 operation（上游 openapiConfig 调整路径 → 自动跟随）──────────────────
  it("用 spec 解析出的 path 调用（exec 改路径）：URL 跟随 spec，不再写死 /processes/cmd", async () => {
    const ops: SandboxOps = {
      ...SANDBOX_OP_DEFAULTS,
      exec: { method: "POST", path: "/sandboxes/{id}/exec" }, // 上游把 /processes/cmd 改成 /exec
    };
    nextRes({ status: "completed", result: { exitCode: 0, stdout: "ok", stderr: "" } });
    await new RemoteSandboxBridge(TARGET, CREDS, undefined, ops).executeCommand("echo ok");
    expect(calls[0].url).toContain("/sandboxes/sbx-1/exec");
    expect(calls[0].url).not.toContain("/processes/cmd");
  });

  it("{sandboxId} 占位也能替换（不止 {id}）", async () => {
    const ops: SandboxOps = { ...SANDBOX_OP_DEFAULTS, read_file: { method: "GET", path: "/v2/sandboxes/{sandboxId}/file" } };
    nextRes({ content: "x" });
    await new RemoteSandboxBridge(TARGET, CREDS, undefined, ops).readFile("/a");
    expect(calls[0].url).toContain("/v2/sandboxes/sbx-1/file?path=%2Fa");
  });

  it("spec method 覆盖：mkdir 改 PUT 时按 PUT 发", async () => {
    const ops: SandboxOps = { ...SANDBOX_OP_DEFAULTS, mkdir: { method: "PUT", path: "/sandboxes/{id}/dir" } };
    await new RemoteSandboxBridge(TARGET, CREDS, undefined, ops).mkdir("/p");
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toContain("/sandboxes/sbx-1/dir");
  });
});

describe("resolveSandboxOps（从 openapiConfig 解析数据面 operation）", () => {
  it("undefined / 空 → 全部回退默认", () => {
    expect(resolveSandboxOps(undefined)).toEqual(SANDBOX_OP_DEFAULTS);
    expect(resolveSandboxOps({})).toEqual(SANDBOX_OP_DEFAULTS);
  });

  it("canonical operationId（exec/read_file/...）→ 用 spec 的 {method,path}", () => {
    const cfg = {
      servers: [{ url: "https://h" }],
      paths: {
        "/sb/{id}/run": { post: { operationId: "exec" } },
        "/sb/{id}/cat": { get: { operationId: "read_file" } },
        "/sb/{id}/put": { post: { operationId: "write_file" } },
        "/sb/{id}/ls": { get: { operationId: "list_directory" } },
        "/sb/{id}/md": { post: { operationId: "mkdir" } },
      },
    };
    expect(resolveSandboxOps(cfg)).toEqual({
      exec: { method: "POST", path: "/sb/{id}/run" },
      read_file: { method: "GET", path: "/sb/{id}/cat" },
      write_file: { method: "POST", path: "/sb/{id}/put" },
      list_directory: { method: "GET", path: "/sb/{id}/ls" },
      mkdir: { method: "POST", path: "/sb/{id}/md" },
    });
  });

  it("@agentrun/sdk 风格别名（cmd/readFile/writeFile/listFiles/makeDir）也被接受", () => {
    const cfg = {
      servers: [{ url: "https://h" }],
      paths: {
        "/x/cmd": { post: { operationId: "cmd" } },
        "/x/rf": { get: { operationId: "readFile" } },
        "/x/wf": { post: { operationId: "writeFile" } },
        "/x/lf": { get: { operationId: "listFiles" } },
        "/x/mk": { post: { operationId: "makeDir" } },
      },
    };
    expect(resolveSandboxOps(cfg)).toEqual({
      exec: { method: "POST", path: "/x/cmd" },
      read_file: { method: "GET", path: "/x/rf" },
      write_file: { method: "POST", path: "/x/wf" },
      list_directory: { method: "GET", path: "/x/lf" },
      mkdir: { method: "POST", path: "/x/mk" },
    });
  });

  it("部分声明 → 已声明用 spec、未声明回退默认（混合）", () => {
    const cfg = { servers: [{ url: "https://h" }], paths: { "/only/exec": { post: { operationId: "exec" } } } };
    const ops = resolveSandboxOps(cfg);
    expect(ops.exec).toEqual({ method: "POST", path: "/only/exec" });
    expect(ops.read_file).toEqual(SANDBOX_OP_DEFAULTS.read_file);
    expect(ops.mkdir).toEqual(SANDBOX_OP_DEFAULTS.mkdir);
  });

  it("同一 path 上 GET+POST 两个 operation（read_file/write_file 共用 /files）分别解析", () => {
    const cfg = {
      servers: [{ url: "https://h" }],
      paths: { "/sb/{id}/files": { get: { operationId: "read_file" }, post: { operationId: "write_file" } } },
    };
    const ops = resolveSandboxOps(cfg);
    expect(ops.read_file).toEqual({ method: "GET", path: "/sb/{id}/files" });
    expect(ops.write_file).toEqual({ method: "POST", path: "/sb/{id}/files" });
  });

  it("canonical 与别名同时存在 → canonical 优先", () => {
    const cfg = {
      servers: [{ url: "https://h" }],
      paths: {
        "/canon": { post: { operationId: "exec" } },
        "/alias": { post: { operationId: "cmd" } },
      },
    };
    expect(resolveSandboxOps(cfg).exec).toEqual({ method: "POST", path: "/canon" });
  });
});

describe("RemoteSandboxBridge（数据面 REST 客户端·补充）", () => {
  // 资源调用日志：沙箱数据面请求/响应可见（端点不可达时这条日志直接给出试图打的 URL，正是本次 prod 排查缺口）。
  it("logs the sandbox request URL and surfaces fetch failure with the attempted URL", async () => {
    const logs: Array<{ level: string; msg: string; fields: Record<string, unknown> }> = [];
    const log = {
      info: (msg: string, f?: Record<string, unknown>) => logs.push({ level: "info", msg, fields: f ?? {} }),
      warn: (msg: string, f?: Record<string, unknown>) => logs.push({ level: "warn", msg, fields: f ?? {} }),
      error: (msg: string, f?: Record<string, unknown>) => logs.push({ level: "error", msg, fields: f ?? {} }),
      debug: (msg: string, f?: Record<string, unknown>) => logs.push({ level: "debug", msg, fields: f ?? {} }),
    };
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(new RemoteSandboxBridge(TARGET, CREDS, log).executeCommand("echo hi")).rejects.toThrow(/fetch failed/);

    const req = logs.find((l) => l.msg === "resource request");
    expect(req!.fields).toMatchObject({ target: "sandbox", method: "POST" });
    expect(String(req!.fields.url)).toContain("/sandboxes/sbx-1/processes/cmd"); // 未签名的原始数据面 URL
    const resp = logs.find((l) => l.msg === "resource response");
    expect(resp!.level).toBe("warn");
    expect(resp!.fields.target).toBe("sandbox");
    expect(String(resp!.fields.error)).toContain("fetch failed");
    expect(String(resp!.fields.error)).toContain("/sandboxes/sbx-1/processes/cmd"); // 错误里带上 URL
  });
});
