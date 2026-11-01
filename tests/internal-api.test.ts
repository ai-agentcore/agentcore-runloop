import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInternalApi } from "../src/internal-api.js";
import { loadConfig } from "../src/config.js";
import type { Manifest, Runtime } from "../src/runtime.js";
import { sessionWorkdir } from "../src/session-workspace.js";

const token = "internal-secret";
const manifest: Manifest = {
  model: { connection: "managed", name: "fixture-model" },
  tools: [{ name: "echo", description: "echo", inputSchema: { type: "object" } }],
  skills: [],
};

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function temp() { const dir = await mkdtemp(join(tmpdir(), "agentcore-internal-")); dirs.push(dir); return dir; }

function fixture(configOverrides = {}) {
  const completion = vi.fn(async () => ({ id: "response", choices: [] }));
  const stream = vi.fn(async function* () {
    yield { id: "chunk-1", choices: [{ delta: { content: "hello" } }] };
    yield { id: "chunk-2", choices: [{ finish_reason: "stop" }] };
  });
  const callTool = vi.fn(async () => "tool-ok");
  const runtime = {
    manifest: vi.fn(async () => manifest),
    completion,
    stream,
    callTool,
    credential: vi.fn(async () => "fixture-key"),
    close: vi.fn(async () => {}),
  } as Runtime;
  const config = { ...loadConfig({ AGENTCORE_MOCK: "true", AGENTCORE_MODEL_ENABLE_THINKING: "false" }), ...configOverrides };
  const app = createInternalApi(config, runtime, token);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return { app, runtime, completion, stream, callTool, headers };
}

function post(path: string, body: unknown, headers: Record<string, string>) {
  return new Request(`http://local${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

describe("in-process AgentCore HTTP adapters", () => {
  it("protects model and MCP endpoints with an internal token", async () => {
    const f = fixture();
    expect((await f.app.request(post("/model/v1/chat/completions", { messages: [] }, { "Content-Type": "application/json" }))).status).toBe(401);
    expect((await f.app.request(post("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, { "Content-Type": "application/json" }))).status).toBe(401);
  });

  it("forwards completions while enforcing the deployment thinking policy", async () => {
    const f = fixture();
    const response = await f.app.request(post("/model/v1/chat/completions", {
      model: "fixture-model",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.2,
      reasoning_effort: "high",
      enable_thinking: true,
    }, f.headers));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "response" });
    expect(f.completion).toHaveBeenCalledWith(
      [{ role: "user", content: "hello" }],
      { temperature: 0.2, enable_thinking: false },
      expect.any(AbortSignal),
    );
  });

  it("streams OpenAI chunks and terminates with DONE", async () => {
    const f = fixture();
    const response = await f.app.request(post("/model/v1/chat/completions", {
      model: "fixture-model",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    }, f.headers));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"id":"chunk-1"');
    expect(text).toContain('"id":"chunk-2"');
    expect(text).toContain("data: [DONE]");
  });

  it("validates model requests and sanitizes SDK failures", async () => {
    const f = fixture();
    expect((await f.app.request(post("/model/v1/chat/completions", {}, f.headers))).status).toBe(400);
    expect((await f.app.request(post("/model/v1/chat/completions", { model: "other", messages: [] }, f.headers))).status).toBe(400);
    expect((await f.app.request(post("/model/v1/chat/completions", { messages: [], api_key: "bad" }, f.headers))).status).toBe(400);
    f.completion.mockRejectedValueOnce(new Error("secret"));
    const failed = await f.app.request(post("/model/v1/chat/completions", { messages: [] }, f.headers));
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain("secret");
    f.stream.mockImplementationOnce(async function* () { throw new Error("secret"); });
    expect((await f.app.request(post("/model/v1/chat/completions", { messages: [], stream: true }, f.headers))).status).toBe(502);
    f.stream.mockImplementationOnce(async function* () {});
    expect((await f.app.request(post("/model/v1/chat/completions", { messages: [], stream: true }, f.headers))).status).toBe(502);
  });

  it("implements MCP initialization, discovery and calls", async () => {
    const f = fixture();
    const initialize = await f.app.request(post("/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, f.headers));
    expect(await initialize.json()).toMatchObject({ result: { protocolVersion: "2025-06-18", serverInfo: { name: "agentcore-node-runtime" } } });
    const fallback = await f.app.request(post("/mcp", { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "old" } }, f.headers));
    expect(await fallback.json()).toMatchObject({ result: { protocolVersion: "2025-03-26" } });
    const listed = await f.app.request(post("/mcp", { jsonrpc: "2.0", id: 3, method: "tools/list" }, f.headers));
    expect(await listed.json()).toMatchObject({ result: { tools: manifest.tools } });
    const called = await f.app.request(post("/mcp", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } }, f.headers));
    expect(await called.json()).toMatchObject({ result: { content: [{ text: "tool-ok" }], isError: false } });
    expect(f.callTool).toHaveBeenCalledWith("echo", { text: "hi" });
  });

  it("publishes with server-provided user/session headers instead of tool arguments", async () => {
    const workdir = await temp(), artifactRoot = await temp();
    const workspace = await sessionWorkdir(workdir, "user-9", "conversation-9");
    await writeFile(join(workspace, "final.txt"), "final");
    const f = fixture({ workdir, artifactRoot, execution: "local" });
    const headers = { ...f.headers, "X-AgentCore-UID": "user-9", "X-AgentCore-Conversation-Id": "conversation-9" };
    const listed = await f.app.request(post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, headers));
    expect(await listed.json()).toMatchObject({ result: { tools: expect.arrayContaining([expect.objectContaining({ name: "publish_artifact" })]) } });
    const called = await f.app.request(post("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/call", params: {
      name: "publish_artifact", arguments: { source_path: "final.txt", uid: "attacker" },
    } }, headers));
    const destination = join(artifactRoot, "user-9", "conversation-9", "final.txt");
    const body = await called.json() as { result: { structuredContent: { artifact: { id: string; path: string } }; isError: boolean } };
    expect(body).toMatchObject({ result: { structuredContent: { artifact: { path: expect.stringMatching(/^\/f\/f_[A-Za-z0-9_-]{22}$/) } }, isError: false } });
    expect(body.result.structuredContent.artifact.path).toBe(`/f/${body.result.structuredContent.artifact.id}`);
    expect(JSON.stringify(body)).not.toContain(artifactRoot);
    expect(await readFile(destination, "utf8")).toBe("final");
    expect(f.callTool).not.toHaveBeenCalled();
  });

  it("never uses the Agent-side workdir as the sandbox artifact source", async () => {
    const workdir = await temp(), artifactRoot = await temp();
    const workspace = await sessionWorkdir(workdir, "user-9", "conversation-9");
    await writeFile(join(workspace, "final.txt"), "must-not-be-read-locally");
    const f = fixture({ workdir, artifactRoot, execution: "sandbox" });
    const headers = { ...f.headers, "X-AgentCore-UID": "user-9", "X-AgentCore-Conversation-Id": "conversation-9" };
    const called = await f.app.request(post("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/call", params: {
      name: "publish_artifact", arguments: { source_path: "final.txt" },
    } }, headers));
    expect(await called.json()).toMatchObject({
      result: { content: [{ text: "tool-ok" }], isError: false },
    });
    expect(f.callTool).toHaveBeenCalledWith("publish_artifact", { source_path: "final.txt" });
  });

  it("returns an actionable safe code when artifact publishing fails", async () => {
    const workdir = await temp(), artifactRoot = await temp();
    const f = fixture({ workdir, artifactRoot, execution: "local" });
    const headers = { ...f.headers, "X-AgentCore-UID": "user-9", "X-AgentCore-Conversation-Id": "conversation-9", "X-Request-Id": "request-9" };
    const failed = await f.app.request(post("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/call", params: {
      name: "publish_artifact", arguments: { source_path: "missing.svg" },
    } }, headers));
    const body = await failed.json();
    expect(body).toMatchObject({ result: { content: [{ type: "text", text: "Artifact publish failed (SOURCE_NOT_FOUND): source file does not exist" }], isError: true } });
    expect(JSON.stringify(body)).not.toContain(workdir);
  });

  it("handles MCP notifications, invalid requests and tool errors", async () => {
    const f = fixture();
    expect((await f.app.request(post("/mcp", { jsonrpc: "2.0", method: "ping" }, f.headers))).status).toBe(202);
    expect(await (await f.app.request(post("/mcp", { bad: true }, f.headers))).json()).toMatchObject({ error: { code: -32600 } });
    expect(await (await f.app.request(post("/mcp", { jsonrpc: "2.0", id: 1, method: "ping", params: [] }, f.headers))).json()).toMatchObject({ error: { code: -32602 } });
    expect(await (await f.app.request(post("/mcp", { jsonrpc: "2.0", id: 2, method: "unknown" }, f.headers))).json()).toMatchObject({ error: { code: -32601 } });
    expect(await (await f.app.request(post("/mcp", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: 1 } }, f.headers))).json()).toMatchObject({ error: { code: -32602 } });
    f.callTool.mockRejectedValueOnce(new Error("secret"));
    const failed = await f.app.request(post("/mcp", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "echo", arguments: {} } }, f.headers));
    expect(await failed.json()).toMatchObject({ result: { isError: true } });
    expect((await f.app.request("/mcp", { method: "GET", headers: f.headers })).status).toBe(405);
    expect((await f.app.request("/mcp", { method: "DELETE", headers: f.headers })).status).toBe(200);
  });
});
