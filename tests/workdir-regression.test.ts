import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LoopRunner } from "../vendor/runloop/src/loop/runner.js";
import { CodexAdapter } from "../vendor/runloop/src/acp/codex-adapter.js";

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

it.each([false, true])("runs real MCP file/shell tools in the same cwd as the agent (fixed=%s)", async fixed => {
  vi.stubEnv("AGENTCORE_REMOTE_SHELL", "0");
  vi.stubEnv("AGENTCORE_LOG_LEVEL", "error");
  const root = await mkdtemp(join(tmpdir(), "workdir-regression-")); dirs.push(root);
  const workspacesDir = join(root, "runtime"), workspace = join(workspacesDir, "wd-test"), mounted = join(root, "mounted");
  await mkdir(workspace, { recursive: true }); await mkdir(mounted);
  const expected = fixed ? mounted : workspace;
  await writeFile(join(workspace, "mounted.txt"), fixed ? "wrong-session-root" : "fixture-file-read-ok");
  await writeFile(join(mounted, "mounted.txt"), "fixture-file-read-ok");
  const observed: Record<string, unknown> = {};
  vi.spyOn(CodexAdapter.prototype, "run").mockImplementation(async function* (params) {
    observed.cwd = params.cwd; observed.workspace = params.workspaceDir;
    const client = new Client({ name: "workdir-regression", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(params.config.mcpConfig.mcpServers.agentcore.url!)));
      observed.tools = (await client.listTools()).tools.map(t => t.name);
      observed.read = await client.callTool({ name: "read_file", arguments: { file_path: "mounted.txt" } });
      observed.write = await client.callTool({ name: "write_file", arguments: { file_path: "created.txt", content: "before" } });
      observed.edit = await client.callTool({ name: "edit_file", arguments: { file_path: "created.txt", old_string: "before", new_string: "after" } });
      observed.pwd = await client.callTool({ name: "bash", arguments: { command: "pwd" } });
      observed.glob = await client.callTool({ name: "glob", arguments: { pattern: "*.txt" } });
    } finally { await client.close(); }
  });
  const runner = new LoopRunner({ workspacesDir });
  const events = [];
  for await (const event of runner.run({ conversationId: "wd-test", model: { provider: "openai-compatible", model: "fixture", baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture-only" }, agent: { cli: "codex", ...(fixed ? { cwd: mounted } : {}) }, features: { execViaMcp: true, toolBridge: "mcp" }, events: [{ type: "user.message", content: "Inspect mounted files" }] })) events.push(event);
  expect(events.at(-1)).toMatchObject({ type: "run.end", reason: "completed" });
  expect(observed.cwd).toBe(expected); expect(observed.workspace).toBe(workspace);
  expect(observed.tools).toEqual(expect.arrayContaining(["bash", "read_file", "write_file", "edit_file", "grep", "glob"]));
  expect(JSON.stringify(observed.read)).toContain("fixture-file-read-ok");
  expect(JSON.stringify(observed.pwd)).toContain(await realpath(expected));
  expect(JSON.stringify(observed.glob)).toContain("mounted.txt");
  expect(await readFile(join(expected, "created.txt"), "utf8")).toBe("after");
});
