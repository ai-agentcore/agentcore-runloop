import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { RunloopMcpServer } from "../vendor/runloop/src/mcp/server.js";
import { SidecarServer } from "../vendor/runloop/src/sidecar/server.js";
import { CodexAdapter } from "../vendor/runloop/src/acp/codex-adapter.js";
import { LoopRunner } from "../vendor/runloop/src/loop/runner.js";
import * as fileTools from "../vendor/runloop/src/sidecar/file-tools.js";
import type { McpToolResult, NonMcpResources } from "../vendor/runloop/src/mcp/types.js";
import type { RunloopEvent } from "../vendor/runloop/src/types/events.js";
import { AgUiStream } from "../src/ag-ui.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const resources = (): NonMcpResources => ({ tools: [], skills: [], subAgents: [], sandboxes: [], mcpServers: [] });
const args = { pattern: "TODO", path: "src" };

it("sends grep start through AG-UI before file search returns", async () => {
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  const result: McpToolResult = { content: [{ type: "text", text: "found" }], isError: false };
  const events: RunloopEvent[] = [];
  const stream = new AgUiStream({ threadId: "thread", runId: "run", messages: [], tools: [], context: [], state: {}, forwardedProps: {} });
  const ui: Array<{ type: string }> = [];
  const emit = (event: RunloopEvent) => { events.push(event); ui.push(...stream.push(event)); };
  const search = vi.spyOn(fileTools, "executeFileTool").mockImplementationOnce(async () => {
    expect(ui.map(event => event.type)).toEqual(["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"]);
    expect(events[0]).toMatchObject({ toolName: "grep" });
    await waiting;
    return result;
  });
  const config = resources();
  const sidecar = new SidecarServer({ resources: config, conversationId: "thread", emit, execShell: true });
  sidecar.enableToolEvents();
  const server = new RunloopMcpServer({ resources: config, conversationId: "thread", emit,
    extraTools: fileTools.FILE_TOOL_DESCRIPTORS,
    executeTool: (name, input) => sidecar.gatedExecute(name, input) });
  expect(server.enableToolEvents().has("grep")).toBe(true);
  try {
    const pending = server.handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "grep", arguments: args } });
    await vi.waitFor(() => expect(search).toHaveBeenCalledOnce());
    expect(events.some(event => event.type === "toolresult.end")).toBe(false);
    finish();
    expect((await pending).result).toEqual(result);
    expect(events.map(event => event.type)).toEqual(["toolcall.start", "toolcall.end", "toolresult.end"]);
    expect(new Set(events.map(event => (event as { toolCallId: string }).toolCallId)).size).toBe(1);
    expect(ui.at(-1)?.type).toBe("TOOL_CALL_RESULT");
  } finally { finish(); await server.stop(); }
});

it.each(["ask", "block"] as const)("keeps the %s gate authoritative without executing grep", async action => {
  const search = vi.spyOn(fileTools, "executeFileTool");
  const events: RunloopEvent[] = [];
  const sidecar = new SidecarServer({ resources: resources(), conversationId: "thread", emit: event => events.push(event),
    execShell: true, hitl: { enabled: true, rules: [{ toolPattern: "grep", action }] } });
  sidecar.enableToolEvents();
  await sidecar.gatedExecute("grep", args);
  expect(search).not.toHaveBeenCalled();
  expect(events.map(event => event.type)).toEqual([
    "toolcall.start", "toolcall.end", action === "ask" ? "toolcall.suspend" : "toolresult.end",
  ]);
  expect(new Set(events.map(event => (event as { toolCallId: string }).toolCallId)).size).toBe(1);
});

it("does not emit duplicate lifecycle events during approval resume", async () => {
  const search = vi.spyOn(fileTools, "executeFileTool").mockResolvedValueOnce({ content: [{ type: "text", text: "found" }] });
  const events: RunloopEvent[] = [];
  const sidecar = new SidecarServer({ resources: resources(), conversationId: "thread", emit: event => events.push(event), execShell: true });
  sidecar.enableToolEvents();
  await sidecar.executeTool("grep", args, { idempotencyKey: "approved-call" });
  expect(search).toHaveBeenCalledOnce();
  // The resume resolver owns the approved call's original ID and events.
  expect(events).toEqual([]);
});

it.each([false, true])("closes a failed call safely (throws=%s)", async throws => {
  vi.spyOn(fileTools, "executeFileTool").mockImplementationOnce(async () => {
    if (throws) throw new Error("private implementation details");
    return { content: [{ type: "text", text: "search failed" }], isError: true };
  });
  const events: RunloopEvent[] = [];
  const server = new RunloopMcpServer({ resources: resources(), conversationId: "thread", emit: event => events.push(event),
    extraTools: fileTools.FILE_TOOL_DESCRIPTORS });
  server.enableToolEvents();
  try {
    const pending = server.handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "grep", arguments: args } });
    if (throws) {
      await expect(pending).rejects.toThrow("private implementation details");
    } else {
      await expect(pending).resolves.toMatchObject({ result: { isError: true } });
    }
    expect(events.map(event => event.type)).toEqual(["toolcall.start", "toolcall.end", "toolresult.end"]);
    expect(events.at(-1)).toMatchObject({ isError: true });
    expect(JSON.stringify(events)).not.toContain("private implementation details");
  } finally { await server.stop(); }
});

it("wakes the runner stream during a pending MCP call without waiting for CLI output", async () => {
  vi.stubEnv("AGENTCORE_REMOTE_SHELL", "0");
  vi.stubEnv("AGENTCORE_LOG_LEVEL", "error");
  const root = await mkdtemp(join(tmpdir(), "runloop-tool-events-"));
  roots.push(root);
  await mkdir(join(root, "cwd"));
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  let result: unknown;
  vi.spyOn(fileTools, "executeFileTool").mockImplementationOnce(async () => {
    await waiting;
    return { content: [{ type: "text", text: "found" }] };
  });
  vi.spyOn(CodexAdapter.prototype, "run").mockImplementation(async function* (params) {
    expect(params.serverToolNames?.has("grep")).toBe(true);
    const client = new Client({ name: "tool-events-fixture", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(params.config.mcpConfig.mcpServers.agentcore.url!)));
      result = await client.callTool({ name: "grep", arguments: args });
    } finally { await client.close(); }
  });
  const events: RunloopEvent[] = [];
  const runner = new LoopRunner({ workspacesDir: root });
  try {
    for await (const event of runner.run({ conversationId: "tool-events", resources: [],
      model: { provider: "openai-compatible", model: "fixture", baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture-only" },
      agent: { cli: "codex", cwd: join(root, "cwd") }, features: { execViaMcp: true, toolBridge: "mcp" },
      events: [{ type: "user.message", content: "Search the source" }] })) {
      events.push(event);
      if (event.type === "toolcall.start") {
        expect(result).toBeUndefined();
        finish();
      }
    }
    const calls = events.filter(event => event.type.startsWith("tool"));
    expect(calls.map(event => event.type)).toEqual(["toolcall.start", "toolcall.end", "toolresult.end"]);
    expect(new Set(calls.map(event => (event as { toolCallId: string }).toolCallId)).size).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "run.end", reason: "completed" });
  } finally { finish(); }
});
