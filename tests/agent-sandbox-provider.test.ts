import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ create: vi.fn(), connect: vi.fn() }));
vi.mock("e2b", () => {
  class CommandExitError extends Error {
    constructor(
      readonly result: { exitCode: number; stdout: string; stderr: string },
    ) { super("command failed"); }
    get exitCode() { return this.result.exitCode; }
    get stdout() { return this.result.stdout; }
    get stderr() { return this.result.stderr; }
  }
  return {
    Sandbox: class { static create = sdk.create; static connect = sdk.connect; },
    CommandExitError,
    FileType: { FILE: "file", DIR: "dir", SYMLINK: "symlink" },
  };
});

import { CommandExitError } from "e2b";
import { AgentSandboxProvider } from "../src/sandbox/agent-sandbox-provider.js";
import type { SandboxConfig } from "../src/config.js";

const config: SandboxConfig = {
  credential: "sandbox-key", apiUrl: "https://api.example.com", domain: "example.com",
  template: "tpl-v1", root: "/workspace", timeoutMs: 60_000,
  commandTimeoutMs: 10_000, requestTimeoutMs: 5_000, allowInternetAccess: false,
};

function fakeSandbox() {
  const files = {
    makeDir: vi.fn(async () => true),
    exists: vi.fn(async () => false),
    getInfo: vi.fn(async (path: string) => ({ path, name: "file", type: path === "/workspace" ? "dir" : "file", size: 3 })),
    write: vi.fn(async () => ({ path: "", name: "", type: "file" })),
    read: vi.fn(async (_path: string, opts?: { format?: string }): Promise<string | Uint8Array> => (
      opts?.format === "bytes" ? new Uint8Array([1, 2, 3]) : "one\ntwo\nthree"
    )),
    remove: vi.fn(async () => {}),
  };
  const handle = {
    pid: 9, wait: vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "" })),
    kill: vi.fn(async () => true),
  };
  const commands = { run: vi.fn(async (_command: string, options?: { background?: boolean }) => options?.background ? handle : ({ exitCode: 0, stdout: "a.ts\nb.js\n", stderr: "" })) };
  return {
    sandboxId: "sbx-1", files, commands, handle,
    isRunning: vi.fn(async () => true), setTimeout: vi.fn(async () => {}), kill: vi.fn(async () => true),
  };
}

beforeEach(() => { vi.clearAllMocks(); });

describe("AgentSandboxProvider", () => {
  it("creates and reconnects with deployment-owned credentials", async () => {
    const sandbox = fakeSandbox();
    sdk.create.mockResolvedValue(sandbox);
    sdk.connect.mockResolvedValue(sandbox);
    const credential = vi.fn(async () => "secret");
    const provider = new AgentSandboxProvider(config, credential);
    const created = await provider.create("user-1", "conversation-1");
    expect(created.id).toBe("sbx-1");
    expect(sdk.create).toHaveBeenCalledWith("tpl-v1", expect.objectContaining({
      apiKey: "secret", apiUrl: config.apiUrl, domain: config.domain,
      allowInternetAccess: false,
      metadata: expect.objectContaining({ agentcore_template: "tpl-v1", agentcore_conversation: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    }));
    expect((sdk.create.mock.calls[0][1].metadata.agentcore_tenant as string)).toMatch(/^[a-f0-9]{64}$/);
    expect(await created.isRunning()).toBe(true);
    await created.setTimeout(30_000);
    await created.kill();
    expect(sandbox.setTimeout).toHaveBeenCalledWith(30_000);
    expect(sandbox.kill).toHaveBeenCalled();
    expect((await provider.connect("sbx-1")).id).toBe("sbx-1");
    expect(sdk.connect).toHaveBeenCalledWith("sbx-1", expect.objectContaining({ apiKey: "secret" }));
    expect(credential).toHaveBeenCalledTimes(2);
  });

  it("mounts a configured Volume by name at sandbox creation", async () => {
    const sandbox = fakeSandbox();
    sdk.create.mockResolvedValue(sandbox);
    const resolveMetadata = vi.fn(async () => ({
      "fc.sandbox.auth.role": "acs:ram::123456789:role/sandbox-volume",
      "fc.sandbox.network.vpc": JSON.stringify({
        vpcId: "vpc-1", securityGroupId: "sg-1", vSwitchIds: ["vsw-1"],
      }),
    }));
    const close = vi.fn();
    const provider = new AgentSandboxProvider({
      ...config,
      root: "/mnt/sandbox",
      volumeName: "agent-sandbox-nas",
      volumeMountPath: "/mnt/sandbox",
    }, async () => "secret", { resolveMetadata, close });
    await provider.create("user-1", "conversation-1");
    expect(resolveMetadata).toHaveBeenCalledWith("agent-sandbox-nas", undefined);
    expect(sdk.create).toHaveBeenCalledWith("tpl-v1", expect.objectContaining({
      volumeMounts: { "/mnt/sandbox": "agent-sandbox-nas" },
      metadata: expect.objectContaining({
        "fc.sandbox.auth.role": "acs:ram::123456789:role/sandbox-volume",
        "fc.sandbox.network.vpc": JSON.stringify({
          vpcId: "vpc-1", securityGroupId: "sg-1", vSwitchIds: ["vsw-1"],
        }),
      }),
    }));
    provider.close();
    expect(close).toHaveBeenCalled();
  });

  it("converts an opaque E2B SandboxError into safe creation diagnostics", async () => {
    const upstream = new Error(
      '400: {"code":"InvalidParameter.Volume","message":"requires executionRoleArn",' +
      '"requestId":"sandbox-request-7","secret":"must-not-escape"}',
    );
    upstream.name = "SandboxError";
    sdk.create.mockRejectedValueOnce(upstream);
    const provider = new AgentSandboxProvider(config, async () => "secret");
    const error = await provider.create("user-1", "conversation-1").then(() => undefined, cause => cause);
    expect(error).toMatchObject({
      name: "SandboxError",
      code: "InvalidParameter.Volume",
      status: 400,
      requestId: "sandbox-request-7",
      message: "Agent Sandbox creation failed",
    });
    expect(JSON.stringify({
      name: error.name, code: error.code, status: error.status, requestId: error.requestId, message: error.message,
    })).not.toContain("must-not-escape");
  });

  it.each([
    ["requires executionRoleArn", "SandboxError", "EXECUTION_ROLE_REQUIRED"],
    ["volume belongs to another team", "SandboxError", "VOLUME_TEAM_MISMATCH"],
    ["invalid vSwitch configuration", "SandboxError", "VPC_CONFIGURATION_INVALID"],
    ["volume mount failed", "SandboxError", "VOLUME_MOUNT_FAILED"],
    ["template is unavailable", "SandboxError", "TEMPLATE_ERROR"],
    ["quota exceeded", "SandboxError", "RATE_LIMITED"],
    ["unauthorized", "AuthenticationError", "AUTHENTICATION_FAILED"],
    ["deadline", "TimeoutError", "TIMEOUT"],
    ["opaque backend failure", "SandboxError", "SANDBOX_CREATE_FAILED"],
  ])("classifies a safe sandbox creation hint for %s", async (message, name, code) => {
    const upstream = new Error(message);
    upstream.name = name;
    sdk.create.mockRejectedValueOnce(upstream);
    const provider = new AgentSandboxProvider(config, async () => "secret");
    await expect(provider.create("user-1", "conversation-1")).rejects.toMatchObject({ name, code });
  });

  it("maps shell and file tools into a contained conversation workspace", async () => {
    const sandbox = fakeSandbox();
    sdk.create.mockResolvedValue(sandbox);
    const provider = new AgentSandboxProvider(config, async () => "secret");
    const handle = await provider.create("user-1", "conversation-1");
    const workspace = provider.workspace(handle, "conversation-1");
    expect(workspace.root).toBe("/workspace");
    await workspace.ensureReady();
    expect(sandbox.files.makeDir).toHaveBeenCalledWith(workspace.root);

    expect(await workspace.execBackend.shell("echo ok")).toMatchObject({ isError: false });
    expect(sandbox.commands.run).toHaveBeenCalledWith("echo ok", expect.objectContaining({ background: true, cwd: workspace.root }));
    expect(await workspace.execBackend.file("read_file", { file_path: "a.txt", offset: 2, limit: 1 }))
      .toMatchObject({ content: [{ text: expect.stringContaining("two") }] });
    expect(await workspace.execBackend.file("write_file", { file_path: "a.txt", content: "next" })).toMatchObject({ isError: false });
    expect(await workspace.execBackend.file("edit_file", { file_path: "a.txt", old_string: "two", new_string: "2" })).toMatchObject({ isError: false });
    expect(await workspace.execBackend.file("grep", { pattern: "needle", path: "." })).toMatchObject({ isError: false });
    expect(await workspace.execBackend.file("glob", { pattern: "*.ts", path: "." })).toMatchObject({ isError: false });
    expect(await workspace.execBackend.file("read_file", { file_path: "../../etc/passwd" })).toMatchObject({ isError: true });
    expect(await workspace.execBackend.file("unknown", {})).toBeNull();

    await workspace.writeFile("binary.dat", new Uint8Array([1, 2, 3]));
    await workspace.writeFiles([
      { path: "skills/one.txt", content: "one" },
      { path: "skills/two.bin", content: new Uint8Array([2, 3]) },
    ]);
    expect(sandbox.files.write).toHaveBeenLastCalledWith([
      { path: "/workspace/skills/one.txt", data: "one" },
      { path: "/workspace/skills/two.bin", data: expect.any(ArrayBuffer) },
    ]);
    await expect(workspace.writeFiles([
      { path: "safe.txt", content: "safe" },
      { path: "../../escape", content: "unsafe" },
    ])).rejects.toThrow(/escapes/);
    expect(await workspace.readFile("binary.dat")).toEqual(new Uint8Array([1, 2, 3]));
    expect(await workspace.getInfo("binary.dat")).toMatchObject({ type: "file", size: 3 });
    sandbox.files.getInfo.mockResolvedValueOnce({ type: "dir", size: 0 } as never);
    expect(await workspace.getInfo("directory")).toMatchObject({ type: "dir" });
    sandbox.files.getInfo.mockResolvedValueOnce({ type: "symlink", size: 0, symlinkTarget: "/tmp" } as never);
    expect(await workspace.getInfo("link")).toMatchObject({ type: "symlink", symlinkTarget: "/tmp" });
    await workspace.remove("binary.dat");
  });

  it("covers validation and bounded-search branches without leaking SDK errors", async () => {
    const sandbox = fakeSandbox();
    sdk.create.mockResolvedValue(sandbox);
    const provider = new AgentSandboxProvider(config, async () => "secret");
    const workspace = provider.workspace(await provider.create("user-1", "conversation-1"), "conversation-1");
    const backend = workspace.execBackend;

    expect(await backend.file("read_file", {})).toMatchObject({ isError: true });
    expect(await backend.file("write_file", {})).toMatchObject({ isError: true });
    expect(await backend.file("edit_file", {})).toMatchObject({ isError: true });
    expect(await backend.file("edit_file", { file_path: "a", old_string: "" })).toMatchObject({ isError: true });
    sandbox.files.read.mockResolvedValueOnce("unchanged");
    expect(await backend.file("edit_file", { file_path: "a", old_string: "missing" })).toMatchObject({ isError: true });
    sandbox.files.read.mockResolvedValueOnce("x x");
    expect(await backend.file("edit_file", { file_path: "a", old_string: "x" })).toMatchObject({ isError: true });
    sandbox.files.read.mockResolvedValueOnce("x x");
    expect(await backend.file("edit_file", { file_path: "a", old_string: "x", replace_all: true })).toMatchObject({ isError: false });
    expect(await backend.file("grep", {})).toMatchObject({ isError: true });
    expect(await backend.file("glob", {})).toMatchObject({ isError: true });
    await backend.file("grep", { pattern: "it's", ignore_case: true });
    const many = Array.from({ length: 205 }, (_, index) => `line-${index}`).join("\n");
    sandbox.commands.run.mockResolvedValueOnce({ exitCode: 0, stdout: many, stderr: "" } as never);
    expect(await backend.file("grep", { pattern: "x" })).toMatchObject({ content: [{ text: expect.stringContaining('"truncated":true') }] });
    sandbox.commands.run.mockResolvedValueOnce({ exitCode: 0, stdout: `${workspace.root}/a.ts\nother.ts\n`, stderr: "" } as never);
    expect(await backend.file("glob", { pattern: "*.ts" })).toMatchObject({ isError: false });
    expect(await backend.file("bash", {})).toMatchObject({ isError: true });

    sandbox.files.read.mockRejectedValueOnce(new Error("secret SDK response"));
    const failed = await backend.file("read_file", { file_path: "a" });
    expect(failed).toMatchObject({ isError: true });
    expect(failed!.content[0].text).not.toContain("secret");
    await backend.interrupt?.();
    await expect(workspace.writeFile("../../escape", "x")).rejects.toThrow(/escapes/);
    await workspace.writeFile("text.txt", "text");
    await workspace.writeFile("stream.txt", new ReadableStream({ start(controller) { controller.close(); } }));
  });

  it("returns command exits but sanitizes SDK failures and interrupts active commands", async () => {
    const sandbox = fakeSandbox();
    sdk.create.mockResolvedValue(sandbox);
    const provider = new AgentSandboxProvider(config, async () => "secret");
    const workspace = provider.workspace(await provider.create("user-1", "conversation-1"), "conversation-1");
    sandbox.commands.run.mockRejectedValueOnce(new CommandExitError({ exitCode: 7, stdout: "out", stderr: "bad" }) as never);
    expect(await workspace.execBackend.shell("false")).toMatchObject({ isError: false, content: [{ text: expect.stringContaining('"exit_code":7') }] });
    sandbox.commands.run.mockRejectedValueOnce(new Error("secret upstream body"));
    const failed = await workspace.execBackend.shell("boom");
    expect(failed).toMatchObject({ isError: true });
    expect(failed.content[0].text).not.toContain("secret");

    let finish!: (value: { exitCode: number; stdout: string; stderr: string }) => void;
    sandbox.handle.wait.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = workspace.execBackend.shell("sleep 10");
    await vi.waitFor(() => expect(sandbox.handle.wait).toHaveBeenCalled());
    await workspace.execBackend.interrupt?.();
    expect(sandbox.handle.kill).toHaveBeenCalled();
    finish({ exitCode: 137, stdout: "", stderr: "killed" });
    await pending;
  });

  it("rejects unsafe workspace state and foreign handles", async () => {
    const sandbox = fakeSandbox();
    sandbox.files.getInfo.mockResolvedValueOnce({ type: "symlink", symlinkTarget: "/tmp", size: 0 } as never);
    sdk.create.mockResolvedValue(sandbox);
    const provider = new AgentSandboxProvider(config, async () => "secret");
    const handle = await provider.create("user-1", "conversation-1");
    await expect(provider.workspace(handle, "conversation-1").ensureReady()).rejects.toThrow(/unsafe/);
    sandbox.files.getInfo.mockResolvedValueOnce({ type: "file", size: 0 } as never);
    await expect(provider.workspace(handle, "conversation-1").ensureReady()).rejects.toThrow(/unsafe/);
    expect(() => provider.workspace({ id: "foreign" } as never, "conversation-1")).toThrow(/Unsupported/);
  });
});
