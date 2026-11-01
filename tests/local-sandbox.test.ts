import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localSandboxConfig, localSandboxOverrides } from "../vendor/runloop/src/acp/local-sandbox.js";
import { SidecarServer } from "../vendor/runloop/src/sidecar/server.js";
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
it("creates a restricted user policy without shared tmp or full disk access", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-policy-")); dirs.push(root);
  const userRoot = join(root, "user-a"), cwd = join(userRoot, "session");
  await mkdir(cwd, { recursive: true });
  const config = await localSandboxConfig({ userRoot, readRoots: [] }, cwd, process.execPath);
  const overrides = localSandboxOverrides(config);
  expect(config).toContain(`${JSON.stringify(await realpath(userRoot))} = "write"`);
  expect(config).toContain('":minimal" = "read"');
  expect(config).not.toContain('"/" = "read"');
  expect(config).not.toContain('"/tmp" = "write"');
  expect(config).toContain('enabled = false');
  expect(overrides).toContain('approval_policy="never"');
  expect(overrides.find(value => value.startsWith('permissions='))).toContain('network={ enabled = false }');
  await expect(localSandboxConfig({ userRoot, readRoots: [] }, root, process.execPath)).rejects.toThrow("escapes user root");
  await expect(localSandboxConfig({ userRoot, readRoots: [] }, cwd, "missing-native-cli")).rejects.toThrow("unavailable");
});
it("blocks direct and resumed MCP execution when native execution owns files and shell", async () => {
  const server = new SidecarServer({ resources: { tools: [], skills: [], subAgents: [], sandboxes: [], mcpServers: [] }, execShell: false });
  for (const name of ["bash", "read_file", "write_file", "edit_file", "grep", "glob"]) {
    expect(await server.gatedExecute(name, { command: "touch /tmp/must-not-run", file_path: "/etc/passwd" })).toMatchObject({ isError: true });
    expect(await server.executeTool(name, { command: "touch /tmp/must-not-run", file_path: "/etc/passwd" })).toMatchObject({ isError: true });
  }
});

it("rejects execution when the OS sandbox preflight fails", async () => {
  const { verifyLocalSandbox } = await import("../vendor/runloop/src/acp/local-sandbox.js");
  await expect(verifyLocalSandbox(process.execPath, process.cwd(), [], {}, {}))
    .rejects.toThrow("LOCAL_SANDBOX_UNAVAILABLE");
});

it("grants read-only access to Skill projections and rejects a symlinked temp directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-skill-policy-")); dirs.push(root);
  const cwd = join(root, "user", "session");
  const skill = join(root, "sdk-skill");
  const projection = join(root, "skill-projection");
  await mkdir(cwd, { recursive: true });
  await mkdir(skill);
  await symlink(skill, projection, "dir");
  const policy = { userRoot: join(root, "user"), readRoots: [projection] };
  const config = await localSandboxConfig(policy, cwd, process.execPath);
  expect(config).toContain(`${JSON.stringify(projection)} = "read"`);
  expect(config).toContain(`${JSON.stringify(await realpath(skill))} = "read"`);
  expect(config).toContain('inherit = "none"');
  await rm(join(cwd, ".agentcore-tmp"), { recursive: true });
  await symlink(skill, join(cwd, ".agentcore-tmp"), "dir");
  await expect(localSandboxConfig(policy, cwd, process.execPath)).rejects.toThrow("symlink");
});

it("starts local Codex without bypass and with pinned user permissions", async () => {
  const native = await import("../vendor/runloop/src/acp/local-sandbox.js");
  const { CodexAdapter } = await import("../vendor/runloop/src/acp/codex-adapter.js");
  const { AgentProcess } = await import("../vendor/runloop/src/acp/process.js");
  const preflight = vi.spyOn(native, "verifyLocalSandbox").mockResolvedValue();
  const root = await mkdtemp(join(tmpdir(), "native-adapter-")); dirs.push(root);
  const cwd = join(root, "session"); await mkdir(cwd);
  const spawn = vi.spyOn(AgentProcess.prototype, "spawn").mockImplementation(function (this: InstanceType<typeof AgentProcess>) {
    queueMicrotask(() => this.emit("exit", 0));
  });
  for await (const _event of new CodexAdapter(process.execPath).run({
    conversationId: "test", messages: [{ role: "user", content: "hello" }], cwd,
    config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
    localSandbox: { userRoot: root, readRoots: [] },
  })) { /* drain */ }
  expect(preflight).toHaveBeenCalledOnce();
  expect(spawn).toHaveBeenCalledOnce();
  const args = spawn.mock.calls[0][0].args;
  expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(args).toContain('approval_policy="never"');
  expect(args).toContain('features.shell_tool=true');
  const disabledSkills = args.find(value => value.startsWith("skills.config="))!;
  for (const name of ["imagegen", "openai-docs", "plugin-creator", "review-agent", "skill-creator", "skill-installer"]) {
    expect(disabledSkills).toContain(`/skills/.system/${name}/SKILL.md`);
  }
  expect(disabledSkills.match(/enabled=false/g)).toHaveLength(6);
  expect(disabledSkills).not.toContain("pptx");
  expect(args.find(value => value.startsWith("permissions="))).toContain(await realpath(root));
});

it("uses a preflight executable present on both Linux and macOS", async () => {
  const { writeFile, chmod } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "preflight-cli-")); dirs.push(root);
  const cli = join(root, "cli");
  await writeFile(cli, '#!/bin/sh\nfor arg do last="$arg"; done\nexec "$last"\n');
  await chmod(cli, 0o700);
  const { verifyLocalSandbox } = await import("../vendor/runloop/src/acp/local-sandbox.js");
  await expect(verifyLocalSandbox(cli, root, [], {}, {})).resolves.toBeUndefined();
});
