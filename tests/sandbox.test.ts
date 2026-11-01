import { describe, expect, it, vi } from "vitest";

const sandboxSdk = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("e2b", () => ({
  Sandbox: class { static create = sandboxSdk.create; },
  CommandExitError: class extends Error {},
  FileType: { FILE: "file", DIR: "dir" },
}));

import { loadConfig } from "../src/config.js";
import { createApp, type Runner } from "../src/app.js";
import type { Runtime } from "../src/runtime.js";
import type { RunRequest } from "../vendor/runloop/src/types/api.js";
import type { ExecBackend } from "../vendor/runloop/src/sidecar/exec-backend.js";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncSkillsToSandbox } from "../src/sandbox/skill-sync.js";
import { LazySandboxExecution } from "../src/sandbox/lazy-execution.js";
import {
  SandboxManager,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxWorkspace,
} from "../src/sandbox/manager.js";

function workspace(): SandboxWorkspace {
  return {
    root: "/workspace",
    execBackend: { shell: vi.fn(), file: vi.fn(), interrupt: vi.fn() } as never,
    ensureReady: vi.fn(async () => {}),
    ensureDirectory: vi.fn(async () => {}),
    exists: vi.fn(async () => false),
    writeFile: vi.fn(async () => {}),
    writeFiles: vi.fn(async () => {}),
    readFile: vi.fn(async () => new Uint8Array()),
    getInfo: vi.fn(async () => ({ type: "file" as const, size: 0 })),
    remove: vi.fn(async () => {}),
  };
}

function handle(id: string): SandboxHandle {
  return { id, isRunning: vi.fn(async () => true), setTimeout: vi.fn(async () => {}), kill: vi.fn(async () => {}) };
}

describe("Agent Sandbox configuration", () => {
  it("requires deployment-owned Agent Sandbox settings and permits an Agent-side workdir", () => {
    const base = {
      AGENTCORE_MOCK: "true",
      AGENTCORE_EXECUTION: "sandbox",
      AGENTCORE_SANDBOX_CREDENTIAL: "sandbox-key",
      AGENTCORE_SANDBOX_API_URL: "https://api.cn-hangzhou.sandbox.aliyuncs.com",
      AGENTCORE_SANDBOX_DOMAIN: "cn-hangzhou.sandbox.aliyuncs.com",
      AGENTCORE_SANDBOX_TEMPLATE: "agentcore-runloop-v1",
    };
    expect(loadConfig(base)).toMatchObject({
      execution: "sandbox",
      sandbox: {
        credential: "sandbox-key",
        apiUrl: base.AGENTCORE_SANDBOX_API_URL,
        domain: base.AGENTCORE_SANDBOX_DOMAIN,
        template: "agentcore-runloop-v1",
        root: "/workspace",
      },
    });
    expect(loadConfig({ ...base, AGENTCORE_SANDBOX_CREDENTIAL: "" }).sandbox)
      .toMatchObject({ credential: "AGENT_SANDBOX_API_KEY" });
    expect(loadConfig({ ...base, AGENTCORE_SANDBOX_CREDENTIAL: "", AGENTCORE_SANDBOX_API_KEY: "secret" }).sandbox)
      .toMatchObject({ credential: "AGENT_SANDBOX_API_KEY", apiKey: "secret" });
    expect(() => loadConfig({ ...base, AGENTCORE_SANDBOX_API_URL: "http://insecure" })).toThrow(/HTTPS/);
    expect(loadConfig({ ...base, AGENTCORE_WORKDIR: "/tmp/local" })).toMatchObject({
      execution: "sandbox",
      workdir: "/tmp/local",
      sandbox: { root: "/workspace" },
    });
    expect(() => loadConfig({ ...base, AGENTCORE_WORKDIR: "relative" })).toThrow(/absolute/);
  });

  it("validates an optional sandbox volume mount without changing the unmounted default", () => {
    const base = {
      AGENTCORE_MOCK: "true",
      AGENTCORE_EXECUTION: "sandbox",
      AGENTCORE_SANDBOX_CREDENTIAL: "sandbox-key",
      AGENTCORE_SANDBOX_API_URL: "https://api.cn-hangzhou.sandbox.aliyuncs.com",
      AGENTCORE_SANDBOX_DOMAIN: "cn-hangzhou.sandbox.aliyuncs.com",
      AGENTCORE_SANDBOX_TEMPLATE: "code-interpreter-v1",
    };
    expect(loadConfig(base).sandbox).toMatchObject({ root: "/workspace" });
    expect(loadConfig({
      ...base,
      AGENTCORE_SANDBOX_VOLUME_NAME: "agent-sandbox-nas",
      AGENTCORE_SANDBOX_VOLUME_MOUNT_PATH: "/mnt/sandbox",
      AGENTCORE_SANDBOX_TEAM_ID: "team-123",
    }).sandbox).toMatchObject({
      root: "/mnt/sandbox",
      volumeName: "agent-sandbox-nas",
      volumeMountPath: "/mnt/sandbox",
      teamId: "team-123",
    });
    expect(() => loadConfig({ ...base, AGENTCORE_SANDBOX_VOLUME_NAME: "agent-sandbox-nas" }))
      .toThrow(/VOLUME_NAME.*VOLUME_MOUNT_PATH/);
    expect(() => loadConfig({ ...base, AGENTCORE_SANDBOX_VOLUME_MOUNT_PATH: "/mnt/sandbox" }))
      .toThrow(/VOLUME_NAME.*VOLUME_MOUNT_PATH/);
    expect(() => loadConfig({
      ...base,
      AGENTCORE_SANDBOX_VOLUME_NAME: "agent-sandbox-nas",
      AGENTCORE_SANDBOX_VOLUME_MOUNT_PATH: "/",
    })).toThrow(/VOLUME_MOUNT_PATH/);
    expect(() => loadConfig({
      ...base,
      AGENTCORE_SANDBOX_VOLUME_NAME: "agent-sandbox-nas",
      AGENTCORE_SANDBOX_VOLUME_MOUNT_PATH: "/mnt/sandbox",
      AGENTCORE_SANDBOX_ROOT: "/tmp/outside",
    })).toThrow(/SANDBOX_ROOT.*volume mount/);
    expect(() => loadConfig({ ...base, AGENTCORE_SANDBOX_TEAM_ID: "invalid/team" }))
      .toThrow(/SANDBOX_TEAM_ID/);
  });
});

describe("SandboxManager", () => {
  it("creates one sandbox per conversation and reuses it across later turns", async () => {
    const firstHandle = handle("sbx-1");
    const secondHandle = handle("sbx-2");
    const close = vi.fn();
    const provider: SandboxProvider = {
      create: vi.fn().mockResolvedValueOnce(firstHandle).mockResolvedValueOnce(secondHandle),
      connect: vi.fn(),
      workspace: vi.fn(() => workspace()),
      close,
    };
    const manager = new SandboxManager(provider, { timeoutMs: 60_000 });

    const first = await manager.acquire("user-1", "conversation-1");
    expect(first.workspace.root).toBe("/workspace");
    manager.close();
    expect(close).toHaveBeenCalled();
    await first.release();
    const second = await manager.acquire("user-1", "conversation-2");
    expect(second.sandboxId).toBe("sbx-2");
    expect(provider.create).toHaveBeenCalledTimes(2);
    await second.release();
    const resumed = await manager.acquire("user-1", "conversation-1");
    expect(resumed.sandboxId).toBe("sbx-1");
    expect(provider.create).toHaveBeenCalledTimes(2);
    expect(firstHandle.isRunning).not.toHaveBeenCalled();
    expect(firstHandle.setTimeout).toHaveBeenCalledTimes(1);
    await resumed.release();
  });

  it("prepares managed content once for a reused conversation sandbox", async () => {
    const provider: SandboxProvider = {
      create: vi.fn(async () => handle("sbx-1")),
      connect: vi.fn(),
      workspace: vi.fn(() => workspace()),
    };
    const manager = new SandboxManager(provider, { timeoutMs: 60_000 });
    const prepare = vi.fn(async () => {});
    const first = await manager.acquire("user", "conversation");
    await first.prepareOnce("skills:v1", prepare);
    await first.release();
    const second = await manager.acquire("user", "conversation");
    await second.prepareOnce("skills:v1", prepare);
    await second.release();
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("serializes one conversation while allowing the same user to run another conversation", async () => {
    const provider: SandboxProvider = {
      create: vi.fn(async (_tenant, conversationId) => handle(`sbx-${conversationId}`)),
      connect: vi.fn(),
      workspace: vi.fn(() => workspace()),
    };
    const manager = new SandboxManager(provider, { timeoutMs: 60_000, healthCheckIntervalMs: 0 });
    const lease = await manager.acquire("user-1", "conversation-1");
    await expect(manager.acquire("user-1", "conversation-1")).rejects.toMatchObject({ code: "USER_SANDBOX_BUSY" });
    const parallel = await manager.acquire("user-1", "conversation-2");
    expect(parallel.sandboxId).toBe("sbx-conversation-2");
    await parallel.release();
    await lease.release();

    const unavailable = new SandboxManager({
      ...provider,
      create: vi.fn(async () => { throw Object.assign(new Error("secret upstream response"), { code: "QuotaExceeded" }); }),
    }, { timeoutMs: 60_000 });
    await expect(unavailable.acquire("user-2", "conversation-1")).rejects.toMatchObject({
      code: "SANDBOX_NOT_READY", reason: "unavailable", stage: "create",
    });
  });

  it("replaces an expired binding, tolerates health errors, and makes release idempotent", async () => {
    const stale = handle("stale");
    vi.mocked(stale.isRunning).mockResolvedValue(false);
    const fresh = handle("fresh");
    const replacement = handle("replacement");
    const provider: SandboxProvider = {
      create: vi.fn().mockResolvedValueOnce(stale).mockResolvedValueOnce(fresh).mockResolvedValueOnce(replacement),
      connect: vi.fn(), workspace: vi.fn(() => workspace()),
    };
    const manager = new SandboxManager(provider, { timeoutMs: 60_000, healthCheckIntervalMs: 0 });
    const first = await manager.acquire("user", "one"); await first.release(); await first.release();
    const second = await manager.acquire("user", "one");
    expect(second.sandboxId).toBe("fresh"); await second.release();
    vi.mocked(fresh.isRunning).mockRejectedValueOnce(new Error("gone"));
    const third = await manager.acquire("user", "one");
    expect(third.sandboxId).toBe("replacement"); await third.release();
    expect(manager.workspace("missing", "none")).toBeUndefined();
  });

  it("classifies SDK timeouts and removes a partially prepared binding", async () => {
    const timedOut = handle("timed-out");
    const timeout = Object.assign(new Error("request timed out"), { name: "TimeoutError" });
    vi.mocked(timedOut.setTimeout).mockRejectedValueOnce(timeout);
    const provider: SandboxProvider = {
      create: vi.fn(async () => timedOut),
      connect: vi.fn(), workspace: vi.fn(() => workspace()),
    };
    const manager = new SandboxManager(provider, { timeoutMs: 60_000 });
    await expect(manager.acquire("user", "conversation")).rejects.toMatchObject({
      code: "SANDBOX_NOT_READY", reason: "timeout",
    });
    expect(manager.workspace("user", "conversation")).toBeUndefined();
    expect(timedOut.kill).toHaveBeenCalledOnce();
  });

  it("batch imports managed Skill trees into the sandbox and rejects links", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-skill-"));
    try {
      await mkdir(join(root, "scripts"));
      await writeFile(join(root, "SKILL.md"), "instructions");
      await writeFile(join(root, "scripts", "run.js"), "console.log(1)");
      const ws = workspace();
      const installed = await syncSkillsToSandbox(ws, [{
        name: "Review Skill", description: "review", instruction: "use it", root,
      }]);
      expect(installed[0].root).toMatch(new RegExp(`${ws.root}/\\.agents/skills/review-skill-[a-f0-9]{8}-[a-f0-9]{12}$`));
      expect(ws.ensureDirectory).not.toHaveBeenCalled();
      expect(ws.writeFiles).toHaveBeenCalledTimes(1);
      expect(ws.writeFiles).toHaveBeenCalledWith(expect.arrayContaining([
        expect.objectContaining({ path: expect.stringMatching(/SKILL\.md$/) }),
        expect.objectContaining({ path: expect.stringMatching(/scripts\/run\.js$/) }),
      ]));
      expect(ws.writeFile).toHaveBeenCalledTimes(1);
      expect(ws.writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/\.agentcore-skillset-[a-f0-9]{64}\.ready\.json$/),
        expect.any(String),
      );
      await symlink(join(root, "SKILL.md"), join(root, "linked"));
      await expect(syncSkillsToSandbox(ws, [{
        name: "Unsafe", description: "unsafe", instruction: "", root,
      }])).rejects.toThrow(/symbolic link/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not publish a Skill ready marker when a batch upload fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-skill-failure-"));
    try {
      await writeFile(join(root, "SKILL.md"), "instructions");
      const ws = workspace();
      vi.mocked(ws.writeFiles).mockRejectedValueOnce(new Error("upload failed"));
      await expect(syncSkillsToSandbox(ws, [{
        name: "Failure", description: "failure", instruction: "", root,
      }])).rejects.toThrow("upload failed");
      expect(ws.writeFile).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("splits a large Skill bundle into bounded file batches", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-skill-batches-"));
    try {
      await Promise.all(Array.from({ length: 257 }, (_, index) => (
        writeFile(join(root, index === 0 ? "SKILL.md" : `file-${index}.txt`), String(index))
      )));
      const ws = workspace();
      await syncSkillsToSandbox(ws, [{
        name: "Large", description: "large", instruction: "", root, version: "v1",
      }]);
      expect(ws.writeFiles).toHaveBeenCalledTimes(2);
      expect(vi.mocked(ws.writeFiles).mock.calls[0][0]).toHaveLength(256);
      expect(vi.mocked(ws.writeFiles).mock.calls[1][0]).toHaveLength(1);
      expect(ws.writeFile).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("LazySandboxExecution", () => {
  it("shares first acquisition, prepares Skills, and delegates the complete execution lifecycle", async () => {
    const skillRoot = await mkdtemp(join(tmpdir(), "sandbox-lazy-skill-"));
    try {
      await writeFile(join(skillRoot, "SKILL.md"), "instructions");
      const ws = workspace();
      vi.mocked(ws.execBackend.shell).mockResolvedValue({ content: [{ type: "text", text: "shell" }], isError: false });
      vi.mocked(ws.execBackend.file).mockResolvedValue({ content: [{ type: "text", text: "file" }], isError: false });
      const provider: SandboxProvider = {
        create: vi.fn(async () => handle("sbx-lazy")),
        connect: vi.fn(),
        workspace: vi.fn(() => ws),
      };
      const manager = new SandboxManager(provider, { timeoutMs: 60_000 });
      const execution = new LazySandboxExecution(
        manager,
        "user",
        "conversation",
        "/workspace",
        [{ name: "Review", description: "review", instruction: "read", root: skillRoot, version: "v1" }],
        { runId: "run", resource: "template" },
      );

      const [first, second] = await Promise.all([execution.workspace(), execution.workspace()]);
      expect(first).toBe(ws);
      expect(second).toBe(ws);
      expect(provider.create).toHaveBeenCalledTimes(1);
      expect(ws.writeFiles).toHaveBeenCalledTimes(1);
      expect(ws.writeFile).toHaveBeenCalledTimes(1);
      expect(execution.skills[0].root).toContain("/workspace/.agents/skills/");
      await expect(execution.shell("pwd")).resolves.toMatchObject({ isError: false });
      await expect(execution.file("read_file", { file_path: "SKILL.md" })).resolves.toMatchObject({ isError: false });
      await execution.interrupt();
      expect(ws.execBackend.interrupt).toHaveBeenCalledOnce();
      await execution.release();
      await execution.release();
    } finally {
      await rm(skillRoot, { recursive: true, force: true });
    }
  });

  it("returns a safe file-tool error when lazy acquisition fails unexpectedly", async () => {
    const manager = {
      acquire: vi.fn(async () => { throw new Error("sensitive provider detail"); }),
    } as unknown as SandboxManager;
    const execution = new LazySandboxExecution(
      manager, "user", "conversation", "/workspace", [], { runId: "run", resource: "template" },
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await execution.file("read_file", { file_path: "notes.txt" });
      expect(result).toMatchObject({ isError: true });
      expect(result?.content[0].text).not.toContain("sensitive provider detail");
    } finally {
      logged.mockRestore();
    }
  });
});

describe("sandbox request boundary", () => {
  it("publishes a final file from the lazily acquired sandbox workspace", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "sandbox-lazy-artifact-"));
    try {
      const ws = workspace();
      vi.mocked(ws.getInfo).mockResolvedValue({ type: "file", size: 2 });
      vi.mocked(ws.readFile).mockResolvedValue(new TextEncoder().encode("ok"));
      const provider: SandboxProvider = {
        create: vi.fn(async () => handle("sbx-publish")),
        connect: vi.fn(),
        workspace: vi.fn(() => ws),
      };
      const manager = new SandboxManager(provider, { timeoutMs: 60_000 });
      let backend: ExecBackend | undefined;
      let published: unknown;
      let app: ReturnType<typeof createApp>["app"];
      const token = "x".repeat(64);
      const runner: Runner = {
        resolveCliCommand: name => name,
        initialize: vi.fn(async () => ({ elapsedMs: 1 })),
        interrupt: vi.fn(() => true),
        setExecutionBackend: (_conversationId, value) => { backend = value; },
        async *run(request) {
          await backend!.shell("true");
          const response = await app.request("/mcp", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "X-AgentCore-UID": "user-1",
              "X-AgentCore-Conversation-Id": "conversation-publish",
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
              name: "publish_artifact", arguments: { source_path: "result.txt" },
            } }),
          });
          published = await response.json();
          yield { id: "end", timestamp: 1, conversationId: request.conversationId!, type: "run.end", reason: "completed" };
        },
      };
      const runtime = {
        manifest: vi.fn(async () => ({ model: { connection: "managed", name: "qwen" }, tools: [], skills: [] })),
      } as unknown as Runtime;
      const config = loadConfig({
        AGENTCORE_MOCK: "true",
        AGENTCORE_EXECUTION: "sandbox",
        AGENTCORE_SANDBOX_CREDENTIAL: "sandbox-key",
        AGENTCORE_SANDBOX_API_URL: "https://api.cn-hangzhou.sandbox.aliyuncs.com",
        AGENTCORE_SANDBOX_DOMAIN: "cn-hangzhou.sandbox.aliyuncs.com",
        AGENTCORE_SANDBOX_TEMPLATE: "agentcore-runloop-v1",
        AGENTCORE_ARTIFACT_ROOT: artifactRoot,
      });
      ({ app } = createApp(config, { runner, runtime, sandboxManager: manager, internalToken: token }));
      const response = await app.request("/v1/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid: "user-1", conversationId: "conversation-publish", events: [{ type: "user.message", content: "publish" }] }),
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(published).toMatchObject({ result: { isError: false } });
      expect(await readFile(join(artifactRoot, "user-1", "conversation-publish", "result.txt"), "utf8")).toBe("ok");
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("keeps pure chat available and reports safe diagnostics only when a tool needs the sandbox", async () => {
    const upstream = Object.assign(new Error("secret response body"), {
      name: "InvalidArgumentError", code: "InvalidTemplate", status: 400, requestId: "sandbox-request-1",
    });
    const provider: SandboxProvider = {
      create: vi.fn(async () => { throw upstream; }),
      connect: vi.fn(), workspace: vi.fn(() => workspace()),
    };
    const manager = new SandboxManager(provider, { timeoutMs: 60_000 });
    let backend: ExecBackend | undefined;
    let toolResult: Awaited<ReturnType<ExecBackend["shell"]>> | undefined;
    const runner: Runner = {
      resolveCliCommand: name => name,
      initialize: vi.fn(async () => ({ elapsedMs: 1 })),
      interrupt: vi.fn(() => true),
      setExecutionBackend: (_conversationId, value) => { backend = value; },
      async *run(request) {
        toolResult = await backend!.shell("pwd");
        yield { id: "end", timestamp: 1, conversationId: request.conversationId!, type: "run.end", reason: "completed" };
      },
    };
    const runtime = {
      manifest: vi.fn(async () => ({ model: { connection: "managed", name: "qwen" }, tools: [], skills: [] })),
    } as unknown as Runtime;
    const config = loadConfig({
      AGENTCORE_MOCK: "true",
      AGENTCORE_EXECUTION: "sandbox",
      AGENTCORE_SANDBOX_CREDENTIAL: "sandbox-key",
      AGENTCORE_SANDBOX_API_URL: "https://api.cn-hangzhou.sandbox.aliyuncs.com",
      AGENTCORE_SANDBOX_DOMAIN: "cn-hangzhou.sandbox.aliyuncs.com",
      AGENTCORE_SANDBOX_TEMPLATE: "missing-template",
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { app } = createApp(config, { runner, runtime, sandboxManager: manager, internalToken: "x".repeat(64) });
      const response = await app.request("/v1/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid: "user-1", conversationId: "conversation-failed", events: [{ type: "user.message", content: "hello" }] }),
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(toolResult).toMatchObject({
        isError: true,
        content: [{ type: "text" }],
      });
      expect(JSON.parse(toolResult!.content[0].text)).toEqual({
        error: "sandbox execution is unavailable",
        code: "SANDBOX_NOT_READY",
        diagnostics: {
          stage: "create",
          reason: "unavailable",
          errorType: "SandboxAcquireError",
          causeType: "InvalidArgumentError",
          causeCode: "InvalidTemplate",
          causeStatus: 400,
          causeRequestId: "sandbox-request-1",
        },
      });
      const output = logged.mock.calls.map(call => String(call[0])).join("\n");
      expect(output).toContain('"event":"sandbox_acquire_failed"');
      expect(output).toContain('"stage":"create"');
      expect(output).toContain('"causeType":"InvalidArgumentError"');
      expect(output).toContain('"causeCode":"InvalidTemplate"');
      expect(output).toContain('"causeStatus":400');
      expect(output).toContain('"causeRequestId":"sandbox-request-1"');
      expect(output).not.toContain("secret response body");
    } finally {
      logged.mockRestore();
    }
  });

  it("does not acquire a sandbox for a pure chat turn even when local fallback is configured", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "sandbox-fallback-"));
    const artifactRoot = await mkdtemp(join(tmpdir(), "sandbox-fallback-artifacts-"));
    try {
      const timeout = Object.assign(new Error("upstream timeout"), { name: "TimeoutError" });
      const provider: SandboxProvider = {
        create: vi.fn(async () => { throw timeout; }),
        connect: vi.fn(),
        workspace: vi.fn(() => workspace()),
      };
      const manager = new SandboxManager(provider, { timeoutMs: 60_000 });
      const seen: RunRequest[] = [];
      const setExecutionBackend = vi.fn();
      const runner: Runner = {
        resolveCliCommand: name => name,
        initialize: vi.fn(async () => ({ elapsedMs: 1 })),
        interrupt: vi.fn(() => true),
        setExecutionBackend,
        async *run(request) {
          seen.push(request);
          yield { id: "end", timestamp: 1, conversationId: request.conversationId!, type: "run.end", reason: "completed" };
        },
      };
      const runtime = {
        manifest: vi.fn(async () => ({ model: { connection: "managed", name: "qwen" }, tools: [], skills: [] })),
      } as unknown as Runtime;
      const config = loadConfig({
        AGENTCORE_MOCK: "true",
        AGENTCORE_EXECUTION: "sandbox",
        AGENTCORE_SANDBOX_CREDENTIAL: "sandbox-key",
        AGENTCORE_SANDBOX_API_URL: "https://api.cn-hangzhou.sandbox.aliyuncs.com",
        AGENTCORE_SANDBOX_DOMAIN: "cn-hangzhou.sandbox.aliyuncs.com",
        AGENTCORE_SANDBOX_TEMPLATE: "agentcore-runloop-v1",
        AGENTCORE_WORKDIR: workdir,
        AGENTCORE_ARTIFACT_ROOT: artifactRoot,
      });
      const { app } = createApp(config, { runner, runtime, sandboxManager: manager, internalToken: "x".repeat(64) });
      const response = await app.request("/v1/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid: "user-1", conversationId: "conversation-fallback", events: [{ type: "user.message", content: "hello" }] }),
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(seen[0].agent?.cwd).toBe("/workspace");
      expect(seen[0].agent?.systemPrompt).toContain("isolated sandbox working directory");
      expect(provider.create).not.toHaveBeenCalled();
      expect(setExecutionBackend).toHaveBeenLastCalledWith("conversation-fallback", undefined);
    } finally {
      await rm(workdir, { recursive: true, force: true });
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when tool acquisition times out even with a configured local workdir", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "sandbox-lazy-fallback-"));
    try {
      const timeout = Object.assign(new Error("upstream timeout"), { name: "TimeoutError" });
      const provider: SandboxProvider = {
        create: vi.fn(async () => { throw timeout; }),
        connect: vi.fn(),
        workspace: vi.fn(() => workspace()),
      };
      const manager = new SandboxManager(provider, { timeoutMs: 60_000 });
      let backend: ExecBackend | undefined;
      let toolResult: Awaited<ReturnType<ExecBackend["shell"]>> | undefined;
      const runner: Runner = {
        resolveCliCommand: name => name,
        initialize: vi.fn(async () => ({ elapsedMs: 1 })),
        interrupt: vi.fn(() => true),
        setExecutionBackend: (_conversationId, value) => { backend = value; },
        async *run(request) {
          toolResult = await backend!.shell("pwd");
          yield { id: "end", timestamp: 1, conversationId: request.conversationId!, type: "run.end", reason: "completed" };
        },
      };
      const runtime = {
        manifest: vi.fn(async () => ({ model: { connection: "managed", name: "qwen" }, tools: [], skills: [] })),
      } as unknown as Runtime;
      const config = loadConfig({
        AGENTCORE_MOCK: "true",
        AGENTCORE_EXECUTION: "sandbox",
        AGENTCORE_SANDBOX_CREDENTIAL: "sandbox-key",
        AGENTCORE_SANDBOX_API_URL: "https://api.cn-hangzhou.sandbox.aliyuncs.com",
        AGENTCORE_SANDBOX_DOMAIN: "cn-hangzhou.sandbox.aliyuncs.com",
        AGENTCORE_SANDBOX_TEMPLATE: "agentcore-runloop-v1",
        AGENTCORE_WORKDIR: workdir,
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { app } = createApp(config, { runner, runtime, sandboxManager: manager, internalToken: "x".repeat(64) });
        const response = await app.request("/v1/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uid: "user-1", conversationId: "conversation-tool-fallback", events: [{ type: "user.message", content: "pwd" }] }),
        });
        expect(response.status).toBe(200);
        await response.text();
        expect(toolResult?.isError).toBe(true);
        expect(JSON.parse(toolResult!.content[0].text).code).toBe("SANDBOX_NOT_READY");
        expect(warn.mock.calls.map(call => String(call[0])).join("\n")).not.toContain('"event":"sandbox_fallback"');
      } finally {
        warn.mockRestore();
      }
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("rejects attachment preparation on timeout without downloading into the local workdir", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "sandbox-attachment-fallback-"));
    try {
      const timeout = Object.assign(new Error("upstream timeout"), { name: "TimeoutError" });
      const provider: SandboxProvider = {
        create: vi.fn(async () => { throw timeout; }),
        connect: vi.fn(),
        workspace: vi.fn(() => workspace()),
      };
      const manager = new SandboxManager(provider, { timeoutMs: 60_000 });
      const seen: RunRequest[] = [];
      const runner: Runner = {
        resolveCliCommand: name => name,
        initialize: vi.fn(async () => ({ elapsedMs: 1 })),
        interrupt: vi.fn(() => true),
        setExecutionBackend: vi.fn(),
        async *run(request) {
          seen.push(request);
          yield { id: "end", timestamp: 1, conversationId: request.conversationId!, type: "run.end", reason: "completed" };
        },
      };
      const runtime = {
        manifest: vi.fn(async () => ({ model: { connection: "managed", name: "qwen" }, tools: [], skills: [] })),
      } as unknown as Runtime;
      const config = loadConfig({
        AGENTCORE_MOCK: "true",
        AGENTCORE_EXECUTION: "sandbox",
        AGENTCORE_SANDBOX_CREDENTIAL: "sandbox-key",
        AGENTCORE_SANDBOX_API_URL: "https://api.cn-hangzhou.sandbox.aliyuncs.com",
        AGENTCORE_SANDBOX_DOMAIN: "cn-hangzhou.sandbox.aliyuncs.com",
        AGENTCORE_SANDBOX_TEMPLATE: "agentcore-runloop-v1",
        AGENTCORE_WORKDIR: workdir,
      });
      vi.stubGlobal("fetch", vi.fn(async () => new Response("png", { headers: {
        "Content-Length": "3", ETag: '"etag-1"', "Content-Type": "image/png",
      } })));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { app } = createApp(config, { runner, runtime, sandboxManager: manager, internalToken: "x".repeat(64) });
        const response = await app.request("/ag-ui/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: "conversation-attachment-fallback",
            runId: "run-attachment-fallback",
            messages: [{
              id: "message-1", role: "user", content: "inspect",
              attachments: [{
                id: "up_abc", uri: "attachment:up_abc", etag: '"etag-1"',
                name: "photo.png", mimeType: "image/png", size: 3,
              }],
            }],
            tools: [], context: [], state: {},
            forwardedProps: {
              uid: "user-1",
              attachmentDownloads: [{
                uri: "attachment:up_abc",
                url: "https://files.example.com/download/photo.png?signature=test",
              }],
            },
          }),
        });
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("ATTACHMENT_NOT_READY");
        expect(seen).toHaveLength(0);
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
        vi.unstubAllGlobals();
      }
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("resolves the sandbox key through the Harness credential provider", async () => {
    const files = {
      makeDir: vi.fn(async () => true),
      getInfo: vi.fn(async () => ({ type: "dir", size: 0 })),
      exists: vi.fn(async () => false),
    };
    const wait = vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "" }));
    sandboxSdk.create.mockResolvedValueOnce({
      sandboxId: "sbx-credential", files, commands: { run: vi.fn(async () => ({ wait, kill: vi.fn() })) },
      isRunning: vi.fn(async () => true), setTimeout: vi.fn(async () => {}), kill: vi.fn(async () => {}),
    });
    let backend: ExecBackend | undefined;
    const runner: Runner = {
      resolveCliCommand: name => name,
      initialize: vi.fn(async () => ({ elapsedMs: 1 })),
      interrupt: vi.fn(() => true),
      setExecutionBackend: (_conversationId, value) => { backend = value; },
      async *run(request) {
        await backend!.shell("echo ok");
        yield { id: "end", timestamp: 1, conversationId: request.conversationId!, type: "run.end", reason: "completed" };
      },
    };
    const credential = vi.fn(async () => "resolved-secret");
    const runtime = {
      credential,
      manifest: vi.fn(async () => ({ model: { connection: "managed", name: "qwen" }, tools: [], skills: [] })),
    } as unknown as Runtime;
    const config = loadConfig({
      AGENTCORE_MOCK: "true",
      AGENTCORE_EXECUTION: "sandbox",
      AGENTCORE_SANDBOX_CREDENTIAL: "sandbox-key",
      AGENTCORE_SANDBOX_API_URL: "https://api.cn-hangzhou.sandbox.aliyuncs.com",
      AGENTCORE_SANDBOX_DOMAIN: "cn-hangzhou.sandbox.aliyuncs.com",
      AGENTCORE_SANDBOX_TEMPLATE: "code-interpreter-v1",
    });
    const { app } = createApp(config, { runner, runtime, internalToken: "x".repeat(64) });
    const response = await app.request("/v1/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid: "user-1", conversationId: "conversation-1", events: [{ type: "user.message", content: "hello" }] }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(credential).toHaveBeenCalledWith("sandbox-key");
    expect(sandboxSdk.create).toHaveBeenCalledWith("code-interpreter-v1", expect.objectContaining({
      apiKey: "resolved-secret",
    }));
  });

  it("prefers a directly injected sandbox key over the credential provider", async () => {
    const sandbox = {
      sandboxId: "sbx-direct-key",
      files: {
        makeDir: vi.fn(async () => true),
        getInfo: vi.fn(async () => ({ type: "dir", size: 0 })),
      },
      commands: { run: vi.fn(async () => ({ wait: vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "" })), kill: vi.fn() })) },
      isRunning: vi.fn(async () => true), setTimeout: vi.fn(async () => {}), kill: vi.fn(async () => {}),
    };
    sandboxSdk.create.mockResolvedValueOnce(sandbox);
    const credential = vi.fn(async () => "credential-secret");
    const runtime = {
      credential,
      manifest: vi.fn(async () => ({ model: { connection: "managed", name: "qwen" }, tools: [], skills: [] })),
    } as unknown as Runtime;
    let backend: ExecBackend | undefined;
    const runner: Runner = {
      resolveCliCommand: name => name,
      initialize: vi.fn(async () => ({ elapsedMs: 1 })),
      interrupt: vi.fn(() => true),
      setExecutionBackend: (_conversationId, value) => { backend = value; },
      async *run(request) {
        await backend!.shell("echo ok");
        yield { id: "end", timestamp: 1, conversationId: request.conversationId!, type: "run.end", reason: "completed" };
      },
    };
    const config = loadConfig({
      AGENTCORE_MOCK: "true",
      AGENTCORE_EXECUTION: "sandbox",
      AGENTCORE_SANDBOX_API_KEY: "direct-secret",
      AGENTCORE_SANDBOX_API_URL: "https://api.cn-hangzhou.sandbox.aliyuncs.com",
      AGENTCORE_SANDBOX_DOMAIN: "cn-hangzhou.sandbox.aliyuncs.com",
      AGENTCORE_SANDBOX_TEMPLATE: "code-interpreter-v1",
    });
    const { app } = createApp(config, { runner, runtime, internalToken: "x".repeat(64) });
    const response = await app.request("/v1/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid: "user-1", conversationId: "direct-key", events: [{ type: "user.message", content: "run" }] }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(credential).not.toHaveBeenCalled();
    expect(sandboxSdk.create).toHaveBeenCalledWith("code-interpreter-v1", expect.objectContaining({
      apiKey: "direct-secret",
    }));
  });

  it("uses the body uid, binds the backend, and releases the conversation lease", async () => {
    const ws = workspace();
    const provider: SandboxProvider = {
      create: vi.fn(async () => handle("sbx-1")),
      connect: vi.fn(),
      workspace: vi.fn(() => ws),
    };
    const manager = new SandboxManager(provider, { timeoutMs: 60_000 });
    const seen: RunRequest[] = [];
    const setExecutionBackend = vi.fn();
    let backend: ExecBackend | undefined;
    const runner: Runner = {
      resolveCliCommand: name => name,
      initialize: vi.fn(async () => ({ elapsedMs: 1 })),
      interrupt: vi.fn(() => true),
      setExecutionBackend(conversationId, value) {
        setExecutionBackend(conversationId, value);
        backend = value;
      },
      async *run(request) {
        seen.push(request);
        await backend!.shell("pwd");
        yield { id: "end", timestamp: 1, conversationId: request.conversationId!, type: "run.end", reason: "completed" };
      },
    };
    const runtime = {
      manifest: vi.fn(async () => ({
        model: { connection: "managed", name: "qwen" },
        tools: [{ name: "echo", description: "echo", inputSchema: { type: "object" } }],
        skills: [],
      })),
    } as unknown as Runtime;
    const config = loadConfig({
      AGENTCORE_MOCK: "true",
      AGENTCORE_EXECUTION: "sandbox",
      AGENTCORE_SANDBOX_CREDENTIAL: "sandbox-key",
      AGENTCORE_SANDBOX_API_URL: "https://api.cn-hangzhou.sandbox.aliyuncs.com",
      AGENTCORE_SANDBOX_DOMAIN: "cn-hangzhou.sandbox.aliyuncs.com",
      AGENTCORE_SANDBOX_TEMPLATE: "agentcore-runloop-v1",
      AGENTCORE_WORKDIR: "/agent/container-content",
    });
    const { app } = createApp(config, { runner, runtime, sandboxManager: manager, internalToken: "x".repeat(64) });
    const body = JSON.stringify({ uid: "user-1", conversationId: "conversation-1", events: [{ type: "user.message", content: "hello" }] });

    const response = await app.request("/v1/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AgentCore-UID": "spoofed-header" },
      body,
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(seen[0].agent?.cwd).toBe(ws.root);
    expect(seen[0].agent?.cwd).not.toBe(config.workdir);
    expect(seen[0].resources?.[0]?.mcpConfig?.headers).toMatchObject({ "X-AgentCore-UID": "user-1" });
    expect(provider.create).toHaveBeenCalledWith("user-1", "conversation-1");
    expect(ws.execBackend.shell).toHaveBeenCalledWith("pwd");
    expect(setExecutionBackend).toHaveBeenCalledWith("conversation-1", expect.any(Object));
    expect(setExecutionBackend).toHaveBeenLastCalledWith("conversation-1", undefined);

    const defaultUidResponse = await app.request("/v1/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: "conversation-default", events: [{ type: "user.message", content: "hello" }] }),
    });
    expect(defaultUidResponse.status).toBe(200);
    await defaultUidResponse.text();
    expect(seen[1].resources?.[0]?.mcpConfig?.headers).toMatchObject({ "X-AgentCore-UID": "default" });

    const next = await manager.acquire("user-1", "conversation-2");
    await next.release();
  });
});
