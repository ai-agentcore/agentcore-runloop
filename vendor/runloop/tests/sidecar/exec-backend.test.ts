import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RemoteSandboxBackend } from "@/sidecar/exec-backend.js";
import type { Credentials, Resource } from "@/types/resources.js";
import type { SandboxProvisioner } from "@/sidecar/sandbox-provisioner.js";

const CREDS: Credentials = { accessKeyId: "ak", accessKeySecret: "sk", accountId: "1234567890123456", region: "cn-hangzhou" };

function sandbox(extra: Partial<Resource> = {}): Resource {
  return {
    resourceId: "sbx-1", resourceName: "py", resourceType: "SANDBOX", protocol: "openapi",
    openapiConfig: { servers: [{ url: "https://1234567890123456.agentrun-data.cn-hangzhou.aliyuncs.com" }] },
    ...extra,
  } as Resource;
}

let calls: Array<{ url: string; method: string; body?: string }>;
let responses: Array<{ body: unknown; ok: boolean; status: number }>;
const dirs: string[] = [];
function nextRes(body: unknown, ok = true, status = 200) { responses.push({ body, ok, status }); }
function parse(r: { content: Array<{ text: string }> }) { return JSON.parse(r.content[0].text); }

beforeEach(() => {
  calls = [];
  responses = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { method: string; body?: string }) => {
    calls.push({ url, method: init.method, body: init.body });
    const r = responses.shift() ?? { body: {}, ok: true, status: 200 };
    return { ok: r.ok, status: r.status, text: async () => JSON.stringify(r.body) } as never;
  }));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const d of dirs) { try { await rm(d, { recursive: true, force: true }); } catch {} }
  dirs.length = 0;
});

describe("RemoteSandboxBackend（远端沙箱执行后端）", () => {
  it("shell → POST /processes/cmd，返回 {stdout,stderr,exit_code}", async () => {
    nextRes({ result: { exitCode: 0, stdout: "ok", stderr: "" } });
    const r = await new RemoteSandboxBackend(sandbox(), CREDS).shell("echo ok");
    expect(parse(r)).toEqual({ stdout: "ok", stderr: "", exit_code: 0 });
    expect(calls[0].url).toContain("/sandboxes/sbx-1/processes/cmd");
  });

  it("shell：空命令 → 错误，不发请求", async () => {
    const r = await new RemoteSandboxBackend(sandbox(), CREDS).shell("   ");
    expect(r.isError).toBe(true);
    expect(calls.length).toBe(0);
  });

  it("read_file → GET /files；write_file → POST /files", async () => {
    const be = new RemoteSandboxBackend(sandbox(), CREDS);
    nextRes({ content: "line1\nline2\nline3" });
    const rd = await be.file("read_file", { file_path: "/a", offset: 2, limit: 1 });
    expect(parse(rd!)).toEqual({ content: "line2" });

    nextRes({});
    const wr = await be.file("write_file", { file_path: "/b", content: "x" });
    expect(parse(wr!)).toMatchObject({ ok: true });
    expect(calls[1].method).toBe("POST");
  });

  it("edit_file → 读+替换+写；old_string 缺失/不唯一各自报错", async () => {
    const be = new RemoteSandboxBackend(sandbox(), CREDS);
    nextRes({ content: "foo bar foo" });            // read
    nextRes({});                                     // write
    const ok = await be.file("edit_file", { file_path: "/a", old_string: "bar", new_string: "baz" });
    expect(parse(ok!)).toMatchObject({ ok: true, replaced: 1 });
    expect(JSON.parse(calls[1].body!).content).toBe("foo baz foo");

    nextRes({ content: "foo foo" });
    const notUnique = await be.file("edit_file", { file_path: "/a", old_string: "foo", new_string: "x" });
    expect(notUnique!.isError).toBe(true);

    nextRes({ content: "abc" });
    const notFound = await be.file("edit_file", { file_path: "/a", old_string: "zzz", new_string: "x" });
    expect(notFound!.isError).toBe(true);
  });

  it("grep → 经沙箱 shell grep，解析行；glob → find + 本地正则过滤", async () => {
    const be = new RemoteSandboxBackend(sandbox(), CREDS);
    nextRes({ result: { exitCode: 0, stdout: "src/a.ts:3:TODO x\nsrc/b.ts:9:TODO y\n", stderr: "" } });
    const g = await be.file("grep", { pattern: "TODO", path: "src" });
    expect(parse(g!)).toEqual({ matches: ["src/a.ts:3:TODO x", "src/b.ts:9:TODO y"], count: 2, truncated: false });
    // 排除 .git/node_modules + head 封顶 + 单引号包裹 pattern（H7/H8）。
    const grepCmd = JSON.parse(calls[0].body!).command as string;
    expect(grepCmd).toContain("grep -rnE");
    expect(grepCmd).toContain("--exclude-dir=.git");
    expect(grepCmd).toContain("--exclude-dir=node_modules");
    expect(grepCmd).toContain("| head -n");
    expect(grepCmd).toContain("'TODO'");

    nextRes({ result: { exitCode: 0, stdout: "src/a.ts\nsrc/b.js\nsrc/c.ts\n", stderr: "" } });
    const gl = await be.file("glob", { pattern: "**/*.ts", path: "src" });
    expect(parse(gl!)).toEqual({ files: ["a.ts", "c.ts"], count: 2 });
    const findCmd = JSON.parse(calls[1].body!).command as string;
    expect(findCmd).toContain("-not -path '*/node_modules/*'");
    expect(findCmd).toContain("| head -n");
  });

  it("grep/glob：path 经 resolveRemotePath 锚到 remote cwd（与 read/write 一致，H8）", async () => {
    const be = new RemoteSandboxBackend(sandbox(), CREDS, undefined, "/workspace");
    nextRes({ result: { exitCode: 0, stdout: "", stderr: "" } });
    await be.file("grep", { pattern: "x", path: "src" });
    expect(JSON.parse(calls[0].body!).command).toContain("'/workspace/src'");
    nextRes({ result: { exitCode: 0, stdout: "/workspace/src/a.ts\n", stderr: "" } });
    const gl = await be.file("glob", { pattern: "**/*.ts", path: "src" });
    // root 解析为 /workspace/src，find 输出剥前缀后得相对路径
    expect(parse(gl!)).toEqual({ files: ["a.ts"], count: 1 });
  });

  it("grep：结果超 MAX_MATCHES 截断 + truncated 标记（H7）", async () => {
    const be = new RemoteSandboxBackend(sandbox(), CREDS);
    const lines = Array.from({ length: 250 }, (_, i) => `f.ts:${i}:TODO`).join("\n");
    nextRes({ result: { exitCode: 0, stdout: lines, stderr: "" } });
    const g = parse((await be.file("grep", { pattern: "TODO" }))!);
    expect(g.count).toBe(200);
    expect(g.truncated).toBe(true);
  });

  it("file()：非执行/文件工具名 → 返回 null（让调用方继续分发）", async () => {
    const r = await new RemoteSandboxBackend(sandbox(), CREDS).file("some_platform_tool", {});
    expect(r).toBeNull();
  });

  it("缺 credentials → shell 报错（远端执行需要凭证）", async () => {
    const r = await new RemoteSandboxBackend(sandbox(), undefined).shell("echo hi");
    expect(r.isError).toBe(true);
    expect(parse(r).error).toMatch(/credentials/);
  });

  it("SANDBOX 无 openapiConfig.servers → 据 credentials.accountId 推导数据面 endpoint", async () => {
    nextRes({ result: { exitCode: 0, stdout: "", stderr: "" } });
    await new RemoteSandboxBackend(sandbox({ openapiConfig: undefined }), CREDS).shell("x");
    // 推导出的 host 仍是该账号的数据面（-ram 改写）
    expect(calls[0].url).toContain("1234567890123456");
    expect(calls[0].url).toContain("/sandboxes/sbx-1/processes/cmd");
  });

  it("SANDBOX 无 servers 且无 accountId → 报错", async () => {
    const r = await new RemoteSandboxBackend(sandbox({ openapiConfig: undefined }), { accessKeyId: "a", accessKeySecret: "b" } as Credentials).shell("x");
    expect(r.isError).toBe(true);
    expect(parse(r).error).toMatch(/endpoint/);
  });

  it("SANDBOX_TEMPLATE → 经 provisioner 懒创建实例（取 sandboxId/endpoint）", async () => {
    const provisioner = { ensureInstance: vi.fn(async () => ({ sandboxId: "sbx-99", endpoint: "https://inst.agentrun-data.cn-hangzhou.aliyuncs.com" })) } as unknown as SandboxProvisioner;
    const tpl = sandbox({ resourceType: "SANDBOX_TEMPLATE", resourceId: "tpl-1", openapiConfig: undefined });
    nextRes({ result: { exitCode: 0, stdout: "", stderr: "" } });
    await new RemoteSandboxBackend(tpl, CREDS, provisioner).shell("x");
    expect(provisioner.ensureInstance).toHaveBeenCalledTimes(1);
    expect(calls[0].url).toContain("/sandboxes/sbx-99/processes/cmd");
  });

  it("SANDBOX_TEMPLATE 无 provisioner → 报错", async () => {
    const tpl = sandbox({ resourceType: "SANDBOX_TEMPLATE", resourceId: "tpl-1" });
    const r = await new RemoteSandboxBackend(tpl, CREDS).shell("x");
    expect(r.isError).toBe(true);
    expect(parse(r).error).toMatch(/provisioner/i);
  });

  it("file('bash') 误入 → default 分支报错（bash 应走 shell()，非 file()）", async () => {
    const r = await new RemoteSandboxBackend(sandbox(), CREDS).file("bash", { command: "x" });
    expect(r!.isError).toBe(true);
    expect(parse(r!).error).toMatch(/unknown file tool/);
  });

  it("底层 fetch 抛异常 → 工具返回 isError（外层 catch 兜底）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const r = await new RemoteSandboxBackend(sandbox(), CREDS).file("read_file", { file_path: "/a" });
    expect(r!.isError).toBe(true);
    expect(parse(r!).error).toMatch(/network down/);
  });

  it("openapiConfig.servers[0].url 非法 URL → originOf 原样返回，最终 fetch 失败报错", async () => {
    const r = await new RemoteSandboxBackend(sandbox({ openapiConfig: { servers: [{ url: "not-a-url" }] } }), CREDS).shell("x");
    expect(r.isError).toBe(true);
  });

  it("从 openapiConfig 解析数据面 operation：上游改路径 → backend 自动跟随（exec → /run、read → /cat）", async () => {
    const cfg = {
      servers: [{ url: "https://1234567890123456.agentrun-data.cn-hangzhou.aliyuncs.com" }],
      paths: {
        "/sandboxes/{id}/run": { post: { operationId: "exec" } },
        "/sandboxes/{id}/cat": { get: { operationId: "read_file" } },
      },
    };
    const be = new RemoteSandboxBackend(sandbox({ openapiConfig: cfg }), CREDS);
    nextRes({ result: { exitCode: 0, stdout: "ok", stderr: "" } });
    await be.shell("echo ok");
    expect(calls[0].url).toContain("/sandboxes/sbx-1/run");
    expect(calls[0].url).not.toContain("/processes/cmd");
    nextRes({ content: "x" });
    await be.file("read_file", { file_path: "/a" });
    expect(calls[1].url).toContain("/sandboxes/sbx-1/cat?path=%2Fa");
  });

  it("openapiConfig 无 operation（paths 空/缺）→ 回退默认路径（向后兼容今天的空 paths 下发）", async () => {
    const be = new RemoteSandboxBackend(sandbox({ openapiConfig: { servers: [{ url: "https://1234567890123456.agentrun-data.cn-hangzhou.aliyuncs.com" }], paths: {} } }), CREDS);
    nextRes({ result: { exitCode: 0, stdout: "", stderr: "" } });
    await be.shell("x");
    expect(calls[0].url).toContain("/sandboxes/sbx-1/processes/cmd");
  });

  it("bridge 懒解析只发生一次（多次调用复用）", async () => {
    const provisioner = { ensureInstance: vi.fn(async () => ({ sandboxId: "sbx-99", endpoint: "https://inst.agentrun-data.cn-hangzhou.aliyuncs.com" })) } as unknown as SandboxProvisioner;
    const tpl = sandbox({ resourceType: "SANDBOX_TEMPLATE", resourceId: "tpl-1", openapiConfig: undefined });
    const be = new RemoteSandboxBackend(tpl, CREDS, provisioner);
    nextRes({ result: { exitCode: 0, stdout: "", stderr: "" } });
    nextRes({ result: { exitCode: 0, stdout: "", stderr: "" } });
    await be.shell("a");
    await be.shell("b");
    expect(provisioner.ensureInstance).toHaveBeenCalledTimes(1);
  });

  it("cwd：relative read_file 路径锚到 remote cwd；绝对路径原样；shell 传 cwd", async () => {
    const be = new RemoteSandboxBackend(sandbox(), CREDS, undefined, "/workspace");
    nextRes({ content: "x" });
    await be.file("read_file", { file_path: "rel/a.txt" });
    expect(calls[0].url).toContain("path=%2Fworkspace%2Frel%2Fa.txt");

    nextRes({ content: "y" });
    await be.file("read_file", { file_path: "/abs/b.txt" });
    expect(calls[1].url).toContain("path=%2Fabs%2Fb.txt");

    nextRes({ result: { exitCode: 0, stdout: "", stderr: "" } });
    await be.shell("ls");
    expect(JSON.parse(calls[2].body!)).toMatchObject({ command: "ls", cwd: "/workspace" });
  });

  it("initEnvironment：把本地 .agents/skills 同步进沙箱（remote cwd 下），返回文件数", async () => {
    const ws = await mkdtemp(join(tmpdir(), "rs-ws-"));
    dirs.push(ws);
    const sdir = join(ws, ".agents", "skills", "foo");
    await mkdir(sdir, { recursive: true });
    await writeFile(join(sdir, "SKILL.md"), "# foo");
    await writeFile(join(sdir, "run.sh"), "echo hi");

    nextRes({}); nextRes({}); nextRes({}); // mkdir(父目录) + 两个文件各一次 writeFile
    const be = new RemoteSandboxBackend(sandbox(), CREDS, undefined, "/workspace");
    const n = await be.initEnvironment({ localWorkspaceDir: ws });
    expect(n).toBe(2);
    // L9：先对父目录 mkdir（writeFile 的 createDir 在多级子目录不可靠），且在 writeFile 之前。
    const mkdirCalls = calls.filter((c) => c.url.includes("/filesystem/mkdir"));
    expect(mkdirCalls.length).toBe(1);
    expect(JSON.parse(mkdirCalls[0].body!)).toMatchObject({ path: "/workspace/.agents/skills/foo", parents: true });
    const mkdirIdx = calls.findIndex((c) => c.url.includes("/filesystem/mkdir"));
    const firstWriteIdx = calls.findIndex((c) => c.url.endsWith("/files"));
    expect(mkdirIdx).toBeLessThan(firstWriteIdx);
    const written = calls.filter((c) => c.url.endsWith("/files")).map((c) => JSON.parse(c.body!).path).sort();
    expect(written).toEqual(["/workspace/.agents/skills/foo/SKILL.md", "/workspace/.agents/skills/foo/run.sh"]);
  });

  it("initEnvironment：无 .agents/skills 目录 → 返回 0、不发请求", async () => {
    const ws = await mkdtemp(join(tmpdir(), "rs-ws-"));
    dirs.push(ws);
    const be = new RemoteSandboxBackend(sandbox(), CREDS, undefined, "/workspace");
    expect(await be.initEnvironment({ localWorkspaceDir: ws })).toBe(0);
    expect(calls.length).toBe(0);
  });

  // ── Change B：沙箱内直接下载 skill（option b，默认链路；二进制安全、不经本地盘） ──
  const skillResource = (name: string): Resource => ({
    resourceId: name, resourceName: name, resourceType: "SKILL", protocol: "openapi",
    description: "test skill",
    openapiConfig: {
      servers: [{ url: "https://1234567890123456.funagent-data-pre.cn-hangzhou.aliyuncs.com" }],
      paths: { [`/skills/${name}/download`]: { get: { operationId: "download" } } },
    },
  } as Resource);

  it("downloadSkillsIntoSandbox：每个 skill 在沙箱内 curl 下载 + 解包到 remote cwd 下的 .agents/skills/<slug>", async () => {
    nextRes({ result: { exitCode: 0, stdout: "", stderr: "" } });
    const be = new RemoteSandboxBackend(sandbox(), CREDS, undefined, "/workspace");
    const n = await be.downloadSkillsIntoSandbox([skillResource("travel")]);
    expect(n).toBe(1);
    // 经 /processes/cmd 跑下载脚本；命令体含 curl + 锚到 remote cwd 的 skill 目录 + 签名头。
    expect(calls[0].url).toContain("/sandboxes/sbx-1/processes/cmd");
    const cmd = JSON.parse(calls[0].body!).command as string;
    expect(cmd).toContain("curl");
    expect(cmd).toContain("/workspace/.agents/skills/travel");
    expect(cmd).toContain("Agentrun-Authorization:");
    expect(cmd).toContain("python3");
  });

  it("downloadSkillsIntoSandbox：脚本退出码非 0 → best-effort 不计数（不抛）", async () => {
    nextRes({ result: { exitCode: 1, stdout: "", stderr: "curl: (22)" } });
    const be = new RemoteSandboxBackend(sandbox(), CREDS, undefined, "/workspace");
    expect(await be.downloadSkillsIntoSandbox([skillResource("travel")])).toBe(0);
  });

  it("downloadSkillsIntoSandbox：skill 缺 downloadUrl → 跳过、不发请求", async () => {
    const be = new RemoteSandboxBackend(sandbox(), CREDS, undefined, "/workspace");
    const noUrl = { resourceId: "x", resourceName: "x", resourceType: "SKILL", protocol: "openapi" } as Resource;
    expect(await be.downloadSkillsIntoSandbox([noUrl])).toBe(0);
    expect(calls.length).toBe(0);
  });

  it("downloadSkillsIntoSandbox：空列表 → 0、不发请求", async () => {
    const be = new RemoteSandboxBackend(sandbox(), CREDS, undefined, "/workspace");
    expect(await be.downloadSkillsIntoSandbox([])).toBe(0);
    expect(calls.length).toBe(0);
  });

  it("downloadSkillsIntoSandbox：缺 credentials → 抛错（沙箱内下载需凭证签名）", async () => {
    const be = new RemoteSandboxBackend(sandbox(), undefined, undefined, "/workspace");
    await expect(be.downloadSkillsIntoSandbox([skillResource("travel")])).rejects.toThrow(/credentials/);
  });

  it("downloadSkillsIntoSandbox：非 agentrun host 的 downloadUrl → SSRF 拦截、best-effort 不计数（不抛）", async () => {
    const evil = {
      resourceId: "e", resourceName: "evil", resourceType: "SKILL", protocol: "openapi",
      openapiConfig: {
        servers: [{ url: "https://attacker.example.com" }],
        paths: { "/skills/evil/download": { get: { operationId: "download" } } },
      },
    } as Resource;
    nextRes({ result: { exitCode: 0, stdout: "", stderr: "" } });
    const be = new RemoteSandboxBackend(sandbox(), CREDS, undefined, "/workspace");
    expect(await be.downloadSkillsIntoSandbox([evil])).toBe(0);
    // SSRF 在拼命令前拦截 → 不会发出下载命令。
    expect(calls.length).toBe(0);
  });

  // ── 分支补全：file 工具各错误/默认分支 ──
  it("read_file：无 offset/limit 整文返回；缺 file_path → 报错", async () => {
    const be = new RemoteSandboxBackend(sandbox(), CREDS);
    nextRes({ content: "a\nb\nc" });
    expect(parse((await be.file("read_file", { file_path: "/a" }))!)).toEqual({ content: "a\nb\nc" });
    expect((await be.file("read_file", {}))!.isError).toBe(true);
  });

  it("read_file：仅 limit（offset 默认 1）/仅 offset（limit 默认到末尾）", async () => {
    const be = new RemoteSandboxBackend(sandbox(), CREDS);
    nextRes({ content: "l1\nl2\nl3\nl4" });
    expect(parse((await be.file("read_file", { file_path: "/a", limit: 2 }))!)).toEqual({ content: "l1\nl2" });
    nextRes({ content: "l1\nl2\nl3\nl4" });
    expect(parse((await be.file("read_file", { file_path: "/a", offset: 3 }))!)).toEqual({ content: "l3\nl4" });
  });

  it("write_file：缺 file_path → 报错；content 缺省 → 写空串", async () => {
    const be = new RemoteSandboxBackend(sandbox(), CREDS);
    expect((await be.file("write_file", {}))!.isError).toBe(true);
    nextRes({});
    await be.file("write_file", { file_path: "/b" });
    expect(JSON.parse(calls[0].body!).content).toBe("");
  });

  it("edit_file：缺 file_path / 缺 old_string → 报错；replace_all 多处替换", async () => {
    const be = new RemoteSandboxBackend(sandbox(), CREDS);
    expect((await be.file("edit_file", { old_string: "x", new_string: "y" }))!.isError).toBe(true);
    expect((await be.file("edit_file", { file_path: "/a", new_string: "y" }))!.isError).toBe(true); // 缺 old_string（return 在 read 前，不消费响应）
    nextRes({ content: "foo foo foo" }); // read
    nextRes({});                          // write
    const r = await be.file("edit_file", { file_path: "/a", old_string: "foo", new_string: "X", replace_all: true });
    expect(parse(r!)).toMatchObject({ ok: true, replaced: 3 });
    expect(JSON.parse(calls[1].body!).content).toBe("X X X");
  });

  it("grep：缺 pattern → 报错；ignore_case → -rnEi", async () => {
    const be = new RemoteSandboxBackend(sandbox(), CREDS);
    expect((await be.file("grep", {}))!.isError).toBe(true);
    nextRes({ result: { exitCode: 1, stdout: "", stderr: "" } });
    await be.file("grep", { pattern: "x", ignore_case: true });
    expect(JSON.parse(calls[0].body!).command).toContain("grep -rnEi");
  });

  it("glob：缺 pattern → 报错；path 默认 '.'；find 输出非 root 前缀原样保留（211 false 分支）", async () => {
    const be = new RemoteSandboxBackend(sandbox(), CREDS);
    expect((await be.file("glob", {}))!.isError).toBe(true);
    nextRes({ result: { exitCode: 0, stdout: "./a.ts\nweird.ts\n", stderr: "" } });
    const r = parse((await be.file("glob", { pattern: "**/*.ts" }))!);
    expect(r.files).toContain("weird.ts");
  });

  it("resolveTarget：region 缺省回落 cn-hangzhou（无 servers，据 accountId 推导）", async () => {
    nextRes({ result: { exitCode: 0, stdout: "", stderr: "" } });
    const creds = { accessKeyId: "a", accessKeySecret: "b", accountId: "1234567890123456" } as Credentials; // 无 region
    await new RemoteSandboxBackend(sandbox({ openapiConfig: undefined }), creds).shell("x");
    expect(calls[0].url).toContain("1234567890123456");
  });

  it("SANDBOX_TEMPLATE：provisioner 返回 null → 报错", async () => {
    const provisioner = { ensureInstance: vi.fn(async () => null) } as unknown as SandboxProvisioner;
    const tpl = sandbox({ resourceType: "SANDBOX_TEMPLATE", resourceId: "tpl-1", openapiConfig: undefined });
    const r = await new RemoteSandboxBackend(tpl, CREDS, provisioner).shell("x");
    expect(r.isError).toBe(true);
    expect(parse(r).error).toMatch(/未返回实例/);
  });

  it("非 Error 抛出 → catch 用 String(e)（111/220 分支）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw "string-error"; }));
    const be = new RemoteSandboxBackend(sandbox(), CREDS);
    expect((await be.shell("x")).isError).toBe(true);
    expect((await be.file("read_file", { file_path: "/a" }))!.isError).toBe(true);
  });
});
