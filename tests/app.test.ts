import { afterEach, describe, expect, it, vi } from "vitest";
import { lstat, mkdtemp, mkdir, readFile, realpath, writeFile, symlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type Runner } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { Manifest, Runtime } from "../src/runtime.js";
import { installSkills, skillSlug } from "../src/workspace.js";
import { assertOutboundAllowed, registerTrustedOutboundUrl } from "../vendor/runloop/src/sidecar/ssrf.js";
import type { RunRequest } from "../vendor/runloop/src/types/api.js";
import type { RunloopEvent } from "../vendor/runloop/src/types/events.js";
import type { StsBroker } from "../src/sts-broker.js";
import type { AgentLoopTelemetry } from "../src/agentloop.js";

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function temp() { const dir = await mkdtemp(join(tmpdir(), "agentcore-test-")); dirs.push(dir); return dir; }
const manifest: Manifest = { model: { connection: "managed", name: "qwen" }, tools: [{ name: "echo", inputSchema: { type: "object" } }], skills: [] };
async function fixture(overrides = {}, agentLoop?: AgentLoopTelemetry) {
  const config = { ...loadConfig({ AGENTCORE_MOCK: "true", AGENTCORE_WORKSPACES_DIR: await temp(), AGENTCORE_EXECUTION: "tools-only" }), ...overrides };
  if (config.execution === "local" && !config.workdir) config.workdir = await temp();
  const seen: RunRequest[] = [];
  const runner: Runner = {
    resolveCliCommand: name => { if (name === "evil") throw new Error(); return name; },
    initialize: vi.fn(async () => ({ elapsedMs: 1 })), interrupt: vi.fn(() => true),
    async *run(request) {
      seen.push(request);
      yield { id: "start", timestamp: 1, conversationId: request.conversationId!, runId: request.runId, type: "run.start", agentCli: "codex" };
      yield { id: "end", timestamp: 2, conversationId: request.conversationId!, runId: request.runId, type: "run.end", reason: "completed" };
    },
  };
  const runtime = { manifest: vi.fn(async () => manifest) } as unknown as Runtime;
  const internalToken = "internal-test-token".repeat(4);
  return { ...createApp(config, { runner, runtime, internalToken, agentLoop }), config, seen, runtime, internalToken };
}
function runRequest(body: unknown) { return new Request("http://local/v1/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
const input = { conversationId: "conversation-1", events: [{ type: "user.message", content: "hello" }] };

describe("AgentCore runtime boundary", () => {
  it("routes startup timings to AgentLoop without duplicate fallback logs", async () => {
    const recordStartupTiming = vi.fn(() => true);
    const agentLoop = {
      state: "enabled" as const,
      recordStartupTiming,
      startRun: () => ({ observe: vi.fn(), finish: vi.fn() }),
      shutdown: async () => {},
    } satisfies AgentLoopTelemetry;
    const timingLog = vi.spyOn(console, "info").mockImplementation(() => {});
    const test = await fixture({}, agentLoop);
    expect((await test.app.request("/initialize", { method: "POST" })).status).toBe(200);
    expect(recordStartupTiming).toHaveBeenCalledWith(expect.objectContaining({
      phase: "runner_initialize", status: "ok", durationMs: expect.any(Number),
    }));
    expect(timingLog).not.toHaveBeenCalledWith(expect.stringContaining("agent_startup_timing"));
  });

  it("keeps requests healthy when every observability hook throws", async () => {
    const agentLoop = {
      state: "degraded" as const,
      startRun: () => ({
        observe: () => { throw new Error("observe failed"); },
        finish: () => { throw new Error("finish failed"); },
      }),
      shutdown: async () => { throw new Error("shutdown failed"); },
    } satisfies AgentLoopTelemetry;
    const test = await fixture({}, agentLoop);
    const response = await test.app.request(runRequest(input));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("run.end");
  });

  it("defaults to local execution, accepts workdir without a mode override, and honors explicit tools-only", async () => {
    const env = { AGENTCORE_MOCK: "true" };
    expect(loadConfig(env).execution).toBe("local");
    expect(loadConfig({ ...env, AGENTCORE_EXECUTION: "tools-only" }).execution).toBe("tools-only");
    const workdir = await temp();
    expect(loadConfig({ ...env, AGENTCORE_WORKDIR: workdir })).toMatchObject({ execution: "local", workdir });
  });
  it("accepts an absolute local workdir without touching storage during startup", async () => {
    const workdir = await temp(), runtime = await temp();
    const env = { AGENTCORE_MOCK: "true", AGENTCORE_EXECUTION: "local", AGENTCORE_WORKDIR: workdir, AGENTCORE_WORKSPACES_DIR: runtime };
    expect(loadConfig(env)).toMatchObject({ workdir, workspacesDir: runtime });
    expect(loadConfig({ ...env, AGENTCORE_WORKDIR: " " })).toHaveProperty("workdir", join(tmpdir(), "agentcore-user-work"));
    const file = join(workdir, "file"); await writeFile(file, "content");
    const created = join(workdir, "created-root");
    expect(loadConfig({ ...env, AGENTCORE_WORKDIR: created })).toHaveProperty("workdir", created);
    await expect(stat(created)).rejects.toMatchObject({ code: "ENOENT" });
    const linked = join(workdir, "linked-root"); await symlink(created, linked);
    expect(loadConfig({ ...env, AGENTCORE_WORKDIR: linked })).toHaveProperty("workdir", linked);
    for (const invalid of ["relative/path"]) {
      expect(() => loadConfig({ ...env, AGENTCORE_WORKDIR: invalid })).toThrow(/AGENTCORE_WORKDIR/);
    }
    expect(() => loadConfig({ ...env, AGENTCORE_EXECUTION: "tools-only" })).toThrow(/AGENTCORE_EXECUTION=local/);
  });
  it("validates a separate OSS artifact root for local publishing", async () => {
    const workdir = await temp(), artifactRoot = await temp();
    expect(loadConfig({ AGENTCORE_MOCK: "true", AGENTCORE_WORKDIR: workdir, AGENTCORE_ARTIFACT_ROOT: artifactRoot }))
      .toMatchObject({ workdir, artifactRoot });
    expect(loadConfig({ AGENTCORE_MOCK: "true", AGENTCORE_ARTIFACT_ROOT: artifactRoot }))
      .toMatchObject({ workdir: join(tmpdir(), "agentcore-user-work"), artifactRoot });
    expect(() => loadConfig({ AGENTCORE_MOCK: "true", AGENTCORE_WORKDIR: workdir, AGENTCORE_ARTIFACT_ROOT: "relative" })).toThrow(/absolute/);
    expect(() => loadConfig({ AGENTCORE_MOCK: "true", AGENTCORE_WORKDIR: workdir, AGENTCORE_ARTIFACT_ROOT: workdir })).toThrow(/must differ/);
  });
  it("uses default or explicit uid beneath the mounted root and rejects symlink user roots", async () => {
    const root = await temp();
    const fallback = await fixture({ execution: "local" as const, workdir: root });
    await (await fallback.app.request(runRequest(input))).text();
    expect(fallback.seen[0].agent?.cwd).toBe(join(root, "default", input.conversationId));

    const explicit = await fixture({ execution: "local" as const, workdir: root });
    await (await explicit.app.request(runRequest({ ...input, conversationId: "session_2", uid: "user-2" }))).text();
    expect(explicit.seen[0].agent?.cwd).toBe(join(root, "user-2", "session_2"));

    const outside = await temp();
    await symlink(outside, join(root, "linked-user"));
    const linked = await fixture({ execution: "local" as const, workdir: root });
    expect((await linked.app.request(runRequest({ ...input, uid: "linked-user" }))).status).toBe(503);
    expect(linked.seen).toHaveLength(0);
  });
  it("creates a missing configured root lazily and contains storage failure to the request", async () => {
    const mountedParent = await temp();
    const configuredRoot = join(mountedParent, "users");
    const ready = await fixture({ execution: "local" as const, workdir: configuredRoot });
    expect(await stat(configuredRoot).then(() => true, () => false)).toBe(false);
    expect((await ready.app.request(runRequest({ ...input, uid: "lazy-user" }))).status).toBe(200);
    expect((await stat(join(configuredRoot, "lazy-user", input.conversationId))).isDirectory()).toBe(true);

    const unavailableRoot = join(mountedParent, "missing-parent", "users");
    const unavailable = await fixture({ execution: "local" as const, workdir: unavailableRoot });
    const response = await unavailable.app.request(runRequest(input));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "WORKSPACE_NOT_READY", error: expect.stringContaining("root-parent-stat:ENOENT") });
    expect((await unavailable.app.request("/readyz")).status).toBe(200);
  });
  it("follows a deployment-controlled symlink mount parent but still rejects a symlink configured root", async () => {
    const actualMount = await temp();
    const mountNamespace = await temp();
    const linkedMount = join(mountNamespace, "data");
    await symlink(actualMount, linkedMount, "dir");

    const configuredRoot = join(linkedMount, "users");
    const compatible = await fixture({ execution: "local" as const, workdir: configuredRoot });
    const response = await compatible.app.request(runRequest({ ...input, uid: "oss-user" }));
    expect(response.status).toBe(200);
    expect(compatible.seen[0].agent?.cwd).toBe(join(configuredRoot, "oss-user", input.conversationId));
    expect((await stat(join(actualMount, "users", "oss-user", input.conversationId))).isDirectory()).toBe(true);

    const actualRoot = join(actualMount, "actual-users");
    await mkdir(actualRoot);
    const linkedRoot = join(linkedMount, "linked-users");
    await symlink(actualRoot, linkedRoot, "dir");
    const unsafe = await fixture({ execution: "local" as const, workdir: linkedRoot });
    const unsafeResponse = await unsafe.app.request(runRequest(input));
    expect(unsafeResponse.status).toBe(503);
    expect(await unsafeResponse.json()).toMatchObject({ code: "WORKSPACE_NOT_READY", error: expect.stringContaining("root-validate:UNSAFE_PATH") });
    expect(unsafe.seen).toHaveLength(0);
  });
  it.each(["/v1/run", "/ag-ui/agent", "/invocations", "/"])("uses a default user/session directory below the deployed root at %s without overwriting root files", async route => {
    const workdir = await temp(), skillRoot = await temp();
    await writeFile(join(workdir, "AGENTS.md"), "existing user instructions");
    await mkdir(join(workdir, ".agents/skills/user-skill"), { recursive: true });
    await writeFile(join(workdir, ".agents/skills/user-skill/SKILL.md"), "user-owned skill");
    await writeFile(join(skillRoot, "script.py"), "print(1)");
    await writeFile(join(skillRoot, "SKILL.md"), "---\nname: managed\n---\nread script.py\n");
    const f = await fixture({ execution: "local", workdir });
    vi.mocked(f.runtime.manifest).mockResolvedValue({ ...manifest, skills: [{ name: "managed", root: skillRoot, description: "useful", instruction: "read script.py" }] });
    const body = route === "/v1/run" ? input : { threadId: input.conversationId, runId: "wd-run", state: {}, tools: [], context: [], messages: [{ id: "u", role: "user", content: "hello" }], forwardedProps: { agent: { cwd: "/wrong" } } };
    await (await f.app.request(route, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } })).text();
    const expectedCwd = join(workdir, "default", input.conversationId);
    expect(f.seen[0].agent?.cwd).toBe(expectedCwd);
    const skillPath = join(f.config.workspacesDir, input.conversationId, ".agents/skills", skillSlug("managed"), "SKILL.md");
    expect(f.seen[0].agent?.systemPrompt).toContain(skillPath);
    expect(f.seen[0].agent?.systemPrompt).toContain(expectedCwd);
    expect(await readFile(join(workdir, "AGENTS.md"), "utf8")).toBe("existing user instructions");
    expect(await readFile(join(workdir, ".agents/skills/user-skill/SKILL.md"), "utf8")).toBe("user-owned skill");
    await expect(readFile(join(workdir, ".runloop/codex-home/config.toml"))).rejects.toThrow();
  });
  it("reads a multiline deployment system prompt and treats blank values as unset", () => {
    const env = { AGENTCORE_MOCK: "true", AGENTCORE_SYSTEM_PROMPT: "  你是研发助手。\n请用中文回答。  " };
    expect(loadConfig(env)).toHaveProperty("systemPrompt", "你是研发助手。\n请用中文回答。");
    expect(loadConfig({ ...env, AGENTCORE_SYSTEM_PROMPT: " \n " })).toHaveProperty("systemPrompt", undefined);
    expect(loadConfig({ AGENTCORE_MOCK: "true" })).toHaveProperty("systemPrompt", undefined);
  });
  it.each(["/v1/run", "/ag-ui/agent", "/invocations", "/"])("applies deployment instructions at %s and keeps request instructions as a supplement", async route => {
    const f = await fixture({ systemPrompt: "部署提示词：研发助手\n始终使用中文。" });
    const body = route === "/v1/run" ? { ...input, agent: { systemPrompt: "请求补充：保持简洁" } } : {
      threadId: "prompt-test", runId: "prompt-run", state: {}, tools: [], context: [],
      forwardedProps: { systemPrompt: "must-not-override", agent: { systemPrompt: "must-not-override" } },
      messages: [{ id: "s1", role: "system", content: "请求补充：保持简洁" }, { id: "u1", role: "user", content: "hello" }],
    };
    const response = await f.app.request(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    await response.text();
    const prompt = f.seen[0].agent?.systemPrompt ?? "";
    expect(prompt).toContain("部署提示词：研发助手\n始终使用中文。");
    expect(prompt).toContain("请求补充：保持简洁");
    expect(prompt.indexOf("部署提示词")).toBeLessThan(prompt.indexOf("请求补充"));
    expect(prompt).not.toContain("must-not-override");
  });
  it("keeps process readiness independent from managed resource discovery and validates control requests", async () => {
    const f = await fixture();
    vi.mocked(f.runtime.manifest).mockImplementation(() => new Promise(() => {}));
    const readiness = await Promise.race([
      f.app.request("/readyz"),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("readiness blocked on resource discovery")), 50)),
    ]);
    expect(readiness.status).toBe(200);
    expect(f.runtime.manifest).not.toHaveBeenCalled();
    expect((await f.app.request("/v1/interrupt", { method: "POST", body: "invalid" })).status).toBe(400);
    expect((await f.app.request("/v1/run", { method: "POST", body: "invalid" })).status).toBe(400);
    f.active.add("active");
    expect((await (await f.app.request("/v1/runs")).json() as { runs: unknown[] }).runs).toEqual([{ conversationId: "active", status: "running" }]);
    expect((await (await f.app.request("/health")).json() as { activeRuns: number }).activeRuns).toBe(1);
  });
  it("loads managed resources only through explicit initialization or a run", async () => {
    const f = await fixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const timingLog = vi.spyOn(console, "info").mockImplementation(() => {});
    expect(f.runtime.manifest).not.toHaveBeenCalled();
    expect((await f.app.request("/initialize", { method: "POST" })).status).toBe(200);
    expect(f.runtime.manifest).toHaveBeenCalledTimes(1);
    expect(f.runner.initialize).toHaveBeenCalledWith("codex");
    vi.mocked(f.runtime.manifest).mockRejectedValueOnce(Object.assign(new Error("unavailable"), {
      code: "InvalidResource", statusCode: 404, requestId: "initialize-request-1",
    }));
    expect((await f.app.request("/initialize", { method: "POST" })).status).toBe(503);
    const logs = log.mock.calls.flat().join("\n");
    expect(logs).toContain('"event":"resource_initialization_failed"');
    expect(logs).toContain('"code":"InvalidResource"');
    expect(logs).not.toContain("unavailable");
    expect(timingLog.mock.calls.flat().join("\n")).toContain('"phase":"runner_initialize"');
  });
  it("returns optional resource degradation without failing initialization", async () => {
    const f = await fixture();
    vi.mocked(f.runtime.manifest).mockResolvedValue({
      ...manifest,
      resourceWarnings: [{
        kind: "mcp", resource: "slow-search", code: "RESOURCE_TIMEOUT",
        diagnostics: { errorType: "McpDiscoveryTimeoutError", code: "MCP_DISCOVERY_TIMEOUT" },
      }],
    });
    const response = await f.app.request("/initialize", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok", resourceStatus: "degraded",
      resourceWarnings: [expect.objectContaining({ resource: "slow-search", code: "RESOURCE_TIMEOUT" })],
    });
  });
  it("shares CLI initialization while required resource failures retry", async () => {
    const f = await fixture();
    vi.mocked(f.runtime.manifest).mockRejectedValueOnce(new Error("warmup failed"));
    await expect(f.initialize()).rejects.toThrow("warmup failed");
    await expect(f.initialize()).resolves.toMatchObject({ resourceStatus: "ready" });
    expect(f.runtime.manifest).toHaveBeenCalledTimes(2);
    expect(f.runner.initialize).toHaveBeenCalledTimes(1);
  });
  it("uses server-owned native sandbox policy only for local execution", async () => {
    const root = await temp();
    const f = await fixture({ execution: "local", workdir: root });
    await (await f.app.request(runRequest({ ...input, uid: "user-a" }))).text();
    expect(f.seen[0].features?.execViaMcp).toBe(false);
    expect(f.seen[0].localSandbox).toEqual({ userRoot: join(await realpath(root), "user-a"), readRoots: [] });
    expect((await f.app.request(runRequest({ ...input, localSandbox: { userRoot: "/" } }))).status).toBe(400);
    expect((await f.app.request(runRequest({ ...input, agent: { cli: "qodercli" } }))).status).toBe(400);
  });

  it("prepares local Codex Skills and rejects alternative engines", async () => {
    const root = await temp(); await writeFile(join(root, "script.py"), "print(1)");
    await writeFile(join(root, "SKILL.md"), "---\nname: managed\n---\nread script.py\n");
    const f = await fixture({ execution: "local" as const });
    const skill = { name: "managed", root, description: "useful", instruction: "read script.py" };
    vi.mocked(f.runtime.manifest).mockResolvedValue({ ...manifest, skills: [skill] });
    await (await f.app.request(runRequest({ ...input, runId: "my-run", agent: { cli: "codex", systemPrompt: "user instructions", timeoutMs: 10 } }))).text();
    expect(f.seen[0].agent?.systemPrompt).toContain("user instructions");
    const installedRoot = join(f.config.workspacesDir, input.conversationId, ".agents/skills", skillSlug("managed"));
    expect(f.seen[0].agent?.systemPrompt).toContain(`${installedRoot}/SKILL.md`);
    expect(f.seen[0].agent?.systemPrompt).toContain(`Resolve every relative file or script path against ${JSON.stringify(installedRoot)}`);
    expect(await readFile(join(f.config.workspacesDir, input.conversationId, ".agents/skills", skillSlug("managed"), "script.py"), "utf8")).toBe("print(1)");
    expect((await f.app.request(runRequest({ ...input, agent: { cli: "evil" } }))).status).toBe(400);
  });
  it("generates IDs and guides tools-only Skills without local installation", async () => {
    const f = await fixture();
    vi.mocked(f.runtime.manifest).mockResolvedValue({ ...manifest, tools: [], skills: [{ name: "read", root: "/not-needed", description: "read-only", instruction: "text" }] });
    const response = await f.app.request(runRequest({ events: input.events }));
    await response.text();
    expect(response.headers.get("X-Conversation-Id")).toMatch(/^[a-f0-9-]+$/);
    expect(f.seen[0].agent?.systemPrompt).toContain("load_skills and read_skill_file");
    expect(f.seen[0].resources).toEqual([]);
  });
  it("can construct the actual runtime and runtime without starting a run", async () => {
    const { config } = await fixture();
    const { app } = createApp(config);
    expect((await app.request("/health")).status).toBe(200);
  });
  it("injects SDK-backed model and MCP, streams events, and releases the conversation", async () => {
    const f = await fixture();
    const response = await f.app.request(runRequest(input));
    const text = await response.text();
    expect(response.headers.get("X-Conversation-Id")).toBe(input.conversationId);
    expect(text).toContain("event: run.start"); expect(text).toContain("event: run.end");
    expect(f.seen[0].model).toMatchObject({ provider: "openai-compatible", model: "qwen", baseUrl: "http://127.0.0.1:8080/model/v1" });
    expect(f.seen[0].resources?.[0].toolManifest).toEqual(manifest.tools);
    expect(f.seen[0].credentials).toBeUndefined(); expect(text).not.toContain(f.internalToken);
    expect(f.active.size).toBe(0);
  });
  it("registers scoped artifact publishing and tells the agent to publish final files", async () => {
    const workdir = await temp(), artifactRoot = await temp();
    const f = await fixture({ execution: "local" as const, workdir, artifactRoot });
    await (await f.app.request(runRequest({ ...input, uid: "user-7" }))).text();
    const resource = f.seen[0].resources?.[0];
    expect(resource?.toolManifest).toContainEqual(expect.objectContaining({ name: "publish_artifact" }));
    expect(resource?.mcpConfig).toMatchObject({ headers: {
      "X-AgentCore-UID": "user-7",
      "X-AgentCore-Conversation-Id": input.conversationId,
    } });
    expect(f.seen[0].agent?.systemPrompt).toContain("call publish_artifact");
    expect(f.seen[0].agent?.systemPrompt).toContain("Do not write to the OSS mount directly");
  });
  it.each([{ conversationId: "../escape" }, { conversationId: "/tmp/escape" }, { model: { provider: "x", model: "x", baseUrl: "http://evil" } }, { credentials: {} }, { resources: [] }, { agent: { env: { TOKEN: "x" } } }, { agent: { cwd: "/" } }, { agent: { timeoutMs: -1 } }, { features: { execViaMcp: false } }])("rejects user-controlled runtime policy %j", async override => {
    const { app } = await fixture(); expect((await app.request(runRequest({ ...input, ...override }))).status).toBe(400);
  });
  it("caps timeout and rejects unsupported engines in tools-only mode", async () => {
    const f = await fixture({ timeoutMs: 100 });
    await (await f.app.request(runRequest({ ...input, agent: { timeoutMs: 999 } }))).text();
    expect(f.seen[0].agent?.timeoutMs).toBe(100);
    expect((await f.app.request(runRequest({ ...input, agent: { cli: "qodercli" } }))).status).toBe(400);
  });
  it("reserves a conversation during async preparation, returns 409, recovers after failure", async () => {
    const f = await fixture();
    let reject!: (reason?: unknown) => void;
    vi.mocked(f.runtime.manifest).mockImplementationOnce(() => new Promise((_resolve, r) => { reject = r; }));
    const first = f.app.request(runRequest(input));
    await vi.waitFor(() => expect(f.active.size).toBe(1));
    expect((await f.app.request(runRequest(input))).status).toBe(409);
    reject(new Error("secret detail"));
    const failed = await first; expect(failed.status).toBe(503); expect(await failed.text()).not.toContain("secret detail");
    expect(f.active.size).toBe(0);
    expect((await f.app.request("/readyz")).status).toBe(200);
  });
  it("protects execution endpoints and leaves health public", async () => {
    const f = await fixture({ apiToken: "api-secret" });
    expect((await f.app.request(runRequest(input))).status).toBe(401);
    expect((await f.app.request("/initialize", { method: "POST" })).status).toBe(401);
    expect((await f.app.request("/healthz")).status).toBe(200);
    expect((await f.app.request("/v1/runs", { headers: { Authorization: "Bearer api-secret" } })).status).toBe(200);
    expect((await f.app.request("/v1/interrupt", { method: "POST", headers: { Authorization: "Bearer api-secret", "Content-Type": "application/json" }, body: JSON.stringify({ conversationId: "c1" }) })).status).toBe(200);
    expect(f.runner.interrupt).toHaveBeenCalledWith("c1", undefined);
  });
  it("exposes the separately HMAC-authenticated STS broker without applying the run Bearer token", async () => {
    const config = {
      keyId: "chat",
      secret: Buffer.from("11".repeat(32), "hex"),
      durationSeconds: 900,
    };
    const handler = Object.assign(vi.fn(async () => new Response("scoped-sts", { status: 200 })), { close: vi.fn() }) as StsBroker;
    const base = await fixture({ apiToken: "run-secret", stsBroker: config });
    const { app } = createApp(base.config, { runner: base.runner, runtime: base.runtime, stsBroker: handler });
    const response = await app.request("/v1/sts", { method: "POST", body: "{}" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("scoped-sts");
    expect(handler).toHaveBeenCalledOnce();
  });
  it("cancels the CLI when the caller disconnects", async () => {
    const f = await fixture();
    let finish!: () => void;
    const held = new Promise<void>(r => { finish = r; });
    f.runner.run = async function* (): AsyncGenerator<RunloopEvent> {
      yield { id: "start", timestamp: 1, conversationId: input.conversationId, type: "run.start", agentCli: "codex" };
      await held;
    };
    const response = await f.app.request(runRequest(input));
    const reader = response.body!.getReader(); await reader.read(); await reader.cancel();
    expect(f.runner.interrupt).toHaveBeenCalledWith(input.conversationId, "client_disconnected");
    finish(); await vi.waitFor(() => expect(f.active.size).toBe(0));
  });
});

describe("platform resource preparation", () => {
  it("projects persistent SDK Skill roots into .agents without copying dependencies", async () => {
    const source = await temp(), target = await temp();
    await mkdir(join(source, "nested")); await writeFile(join(source, "nested", "asset.txt"), "asset");
    await writeFile(join(source, "script.py"), "print('managed')");
    await writeFile(join(source, "SKILL.md"), "---\nname: managed\n---\nUse script.py\n");
    const skill = { name: "中文/skill", root: source, instruction: "Use script.py", description: "managed" };
    const installed = join(target, ".agents/skills", skillSlug(skill.name));
    const installedSkills = await installSkills(target, [skill]);
    expect(installedSkills).toEqual([{ ...skill, root: installed }]);
    expect((await lstat(installed)).isSymbolicLink()).toBe(true);
    expect(await realpath(installed)).toBe(await realpath(source));
    expect(await readFile(join(installed, "nested", "asset.txt"), "utf8")).toBe("asset");
    await writeFile(join(installed, ".dependency-installed"), "persistent");
    await mkdir(join(installed, ".runtime", "bin"), { recursive: true });
    await symlink("../../script.py", join(installed, ".runtime", "bin", "tool"));
    await installSkills(target, [skill]);
    expect(await readFile(join(source, ".dependency-installed"), "utf8")).toBe("persistent");
    expect((await lstat(join(source, ".runtime", "bin", "tool"))).isSymbolicLink()).toBe(true);
    await symlink("/etc/passwd", join(installed, ".runtime", "leak"));
    await expect(installSkills(target, [skill])).rejects.toThrow("unsafe dependency link");
  });
  it("rejects linked Skill roots and separates normalized names", async () => {
    expect(skillSlug("a-b")).not.toBe(skillSlug("a_b"));
    expect(skillSlug("中文")).toMatch(/^skill-/);
    const source = await temp(), target = await temp();
    await writeFile(join(source, "SKILL.md"), "managed");
    const linkedParent = await temp(), linkedRoot = join(linkedParent, "linked-skill");
    await symlink(source, linkedRoot, "dir");
    await expect(installSkills(target, [{ name: "bad", root: linkedRoot, instruction: "", description: "" }])).rejects.toThrow("real directory");
    await symlink("/etc/passwd", join(source, "leak"));
    await expect(installSkills(target, [{ name: "bad-content", root: source, instruction: "", description: "" }])).rejects.toThrow("only allowed in dependency directories");
    const file = join(await temp(), "file"); await writeFile(file, "text");
    await expect(installSkills(target, [{ name: "file", root: file, instruction: "", description: "" }])).rejects.toThrow("real directory");
  });
  it("trusts only the explicitly registered MCP URL", async () => {
    registerTrustedOutboundUrl("http://127.0.0.1:45678/mcp");
    await expect(assertOutboundAllowed("http://127.0.0.1:45678/mcp")).resolves.toBeUndefined();
    await expect(assertOutboundAllowed("http://127.0.0.1:45678/other")).rejects.toThrow();
    expect(() => registerTrustedOutboundUrl("http://127.0.0.1:45678/mcp?x=1")).toThrow();
  });
  it.each([
    { AGENTCORE_EXECUTION: "invalid" },
    { PORT: "0" },
    { PORT: "65536" },
    { AGENTCORE_RUN_TIMEOUT_MS: "invalid" },
    { AGENTCORE_ATTACHMENT_DOWNLOAD_TIMEOUT_MS: "0" },
    { AGENTCORE_MCP_DISCOVERY_TIMEOUT_MS: "0" },
    { AGENTCORE_MCP_INITIAL_WAIT_MS: "-1" },
    { AGENTCORE_MCP_SERVERS: "search", AGENTCORE_MCP_DISCOVERY_TIMEOUTS: "search=0" },
    { AGENTCORE_MCP_SERVERS: "search", AGENTCORE_MCP_DISCOVERY_TIMEOUTS: "search=100,search=200" },
    { AGENTCORE_MCP_SERVERS: "search", AGENTCORE_MCP_DISCOVERY_TIMEOUTS: "repo=100" },
    { AGENTCORE_MODEL_ENABLE_THINKING: "maybe" },
    { AGENTCORE_SKILLS: "review@" },
    { AGENTCORE_MCP_SERVERS: "one,one" },
  ])("rejects invalid deployment configuration %j", override => {
    expect(() => loadConfig({ AGENTCORE_MOCK: "true", ...override })).toThrow();
  });
  it("requires model resources outside fixture mode", () => {
    expect(() => loadConfig({})).toThrow(/AGENTCORE_MODEL_CONNECTION/);
    expect(loadConfig({ AGENTCORE_MODEL_CONNECTION: "mc", AGENTCORE_MODEL_NAME: "model" })).toMatchObject({
      modelConnection: "mc",
      modelName: "model",
      modelEnableThinking: false,
      attachmentDownloadTimeoutMs: 1_800_000,
    });
  });
  it("supports explicit deployment settings and parses resource lists", () => {
    const configured = loadConfig({
      AGENTCORE_MODEL_CONNECTION: "mc",
      AGENTCORE_MODEL_NAME: "model",
      AGENTCORE_MCP_SERVERS: "search,repo",
      AGENTCORE_SKILLS: "review@v1.2.0,report",
      HOST: "0.0.0.0",
      PORT: "9999",
      AGENTCORE_EXECUTION: "local",
      AGENTCORE_AGENT_CLI: "qodercli",
      AGENTCORE_RUNLOOP_API_TOKEN: "api",
      AGENTCORE_RUN_TIMEOUT_MS: "123",
      AGENTCORE_ATTACHMENT_DOWNLOAD_TIMEOUT_MS: "4567",
      AGENTCORE_MCP_DISCOVERY_TIMEOUT_MS: "456",
      AGENTCORE_MCP_INITIAL_WAIT_MS: "321",
      AGENTCORE_MCP_DISCOVERY_TIMEOUTS: "search=1500,repo=30000",
    });
    expect(configured).toMatchObject({
      host: "0.0.0.0",
      port: 9999,
      timeoutMs: 123,
      attachmentDownloadTimeoutMs: 4567,
      mcpDiscoveryTimeoutMs: 456,
      mcpInitialWaitMs: 321,
      mcpDiscoveryTimeouts: { search: 1500, repo: 30000 },
      agentCli: "qodercli",
      execution: "local",
      apiToken: "api",
      mcpServers: ["search", "repo"],
      skills: [{ name: "review", version: "v1.2.0" }, { name: "report" }],
    });
  });
  it("enables STS broker only with complete strong configuration", () => {
    const configured = loadConfig({
      AGENTCORE_MOCK: "true",
      AGENTCORE_STS_BROKER_KEY_ID: "chat",
      AGENTCORE_STS_BROKER_SECRET: "11".repeat(32),
      AGENTCORE_STS_DURATION_SECONDS: "1200",
    });
    expect(configured.stsBroker).toMatchObject({ keyId: "chat", durationSeconds: 1200 });
    expect(configured.stsBroker.secret!.toString("hex")).toBe("11".repeat(32));
    const defaultDuration = loadConfig({
      AGENTCORE_MOCK: "true",
      AGENTCORE_STS_BROKER_KEY_ID: "chat",
      AGENTCORE_STS_BROKER_SECRET: "11".repeat(32),
    });
    expect(defaultDuration.stsBroker).toMatchObject({ keyId: "chat", durationSeconds: 900 });
    expect(loadConfig({ AGENTCORE_MOCK: "true" }).stsBroker).toEqual({ durationSeconds: 900 });
    expect(() => loadConfig({ AGENTCORE_MOCK: "true", AGENTCORE_STS_BROKER_KEY_ID: "chat" })).toThrow(/STS broker configuration/);
    expect(() => loadConfig({
      AGENTCORE_MOCK: "true",
      AGENTCORE_STS_BROKER_KEY_ID: "chat",
      AGENTCORE_STS_BROKER_SECRET: "11".repeat(32),
      AGENTCORE_STS_DURATION_SECONDS: "60",
    })).toThrow(/between 900 and 3600/);
  });
  it("uses the SDK-native persistent Skill workspace when configured", () => {
    const configured = loadConfig({
      AGENTCORE_MOCK: "true",
      AGENTCORE_WORKSPACES_DIR: "/tmp/runloop-internal",
      AGENTCORE_SKILL_WORKSPACE_DIR: "/mnt/agenticfs/shared/.agentcore/skills",
    });
    expect(configured.skillWorkspace).toBe("/mnt/agenticfs/shared/.agentcore/skills");
    expect(loadConfig({ AGENTCORE_MOCK: "true", AGENTCORE_WORKSPACES_DIR: "/tmp/runloop-internal" }).skillWorkspace)
      .toBe("/tmp/runloop-internal/.agentcore-skills");
  });
});
