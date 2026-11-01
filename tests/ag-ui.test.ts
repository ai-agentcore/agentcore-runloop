import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type Runner } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { RuntimeInitializationError, type Runtime } from "../src/runtime.js";
import type { RunRequest } from "../vendor/runloop/src/types/api.js";
import type { RunloopEvent } from "../vendor/runloop/src/types/events.js";
import { AgUiInputSchema, AgUiStream } from "../src/ag-ui.js";
import { compressEvents } from "../vendor/runloop/src/events/compress.js";

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
const payload = { threadId: "thread-direct-demo", runId: "run-direct-demo", messages: [{ id: "message-direct-demo", role: "user", content: "Introduce yourself in one sentence." }], tools: [], context: [], state: {}, forwardedProps: {} };
async function fixture(events: object[] = [
  { type: "run.start", agentCli: "codex" },
  { type: "message.start", messageId: "a1", role: "assistant" },
  { type: "message.delta", messageId: "a1", content: "Hello from Codex." },
  { type: "message.end", messageId: "a1" },
  { type: "run.end", reason: "completed" },
], apiToken?: string, configOverrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "agui-test-")); dirs.push(dir);
  const config = { ...loadConfig({ AGENTCORE_MOCK: "true", AGENTCORE_WORKSPACES_DIR: dir }), apiToken, ...configOverrides };
  const seen: RunRequest[] = [];
  const runner: Runner = {
    resolveCliCommand: name => name, initialize: async () => ({ elapsedMs: 0 }), interrupt: vi.fn(() => true),
    async *run(request) { seen.push(request); for (const [i, e] of events.entries()) yield { id: `e${i}`, timestamp: i, conversationId: request.conversationId, ...e } as RunloopEvent; },
  };
  const runtime = { manifest: vi.fn(async () => ({ model: { connection: "managed", name: "qwen" }, tools: [], skills: [] })) } as unknown as Runtime;
  return { ...createApp(config, { runner, runtime, internalToken: "internal-test-token".repeat(4) }), seen, runtime };
}
function post(body: unknown = payload, headers = {}) { return { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }; }
async function decode(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
  expect(response.headers.get("x-accel-buffering")).toBe("no");
  return (await response.text()).split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => JSON.parse(l.slice(5)));
}
it.each(["/ag-ui/agent", "/invocations", "/"])("accepts the deployed AG-UI request at %s", async route => {
  const f = await fixture();
  const response = await f.app.request(route, post());
  const events = await decode(response);
  expect(events.map(e => e.type)).toEqual([
    "RUN_STARTED", "STATE_SNAPSHOT",
    "THINKING_TEXT_MESSAGE_START", "THINKING_TEXT_MESSAGE_CONTENT", "THINKING_TEXT_MESSAGE_END",
    "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "RUN_FINISHED",
  ]);
  expect(events[0]).toMatchObject({ threadId: payload.threadId, runId: payload.runId });
  expect(events.at(-1)).toMatchObject({ threadId: payload.threadId, runId: payload.runId });
  expect(events[3]).toMatchObject({ messageId: "a1", delta: "Hello from Codex." });
  expect(events[6]).toMatchObject({ messageId: "a1", delta: "Hello from Codex." });
  expect(f.seen[0]).toMatchObject({ conversationId: payload.threadId, runId: payload.runId, events: [{ type: "user.message", content: payload.messages[0].content }] });
  expect(f.active.size).toBe(0);
});

it("streams narration as activity and promotes only the completed final message to an answer", () => {
  const stream = new AgUiStream(AgUiInputSchema.parse(payload));
  const push = (event: object) => stream.push({ id: "e", timestamp: 1, conversationId: "c", ...event } as RunloopEvent);

  expect(push({ type: "message.start", messageId: "progress" })).toEqual([]);
  expect(push({ type: "message.delta", messageId: "progress", content: "I will inspect the workspace." })).toEqual([
    { type: "THINKING_TEXT_MESSAGE_START", messageId: "progress" },
    { type: "THINKING_TEXT_MESSAGE_CONTENT", messageId: "progress", delta: "I will inspect the workspace." },
  ]);
  expect(push({ type: "message.end", messageId: "progress" })).toEqual([
    { type: "THINKING_TEXT_MESSAGE_END", messageId: "progress" },
  ]);
  expect(push({ type: "toolcall.start", toolCallId: "inspect", toolName: "grep" })).toEqual([
    { type: "TOOL_CALL_START", toolCallId: "inspect", toolCallName: "grep" },
  ]);

  push({ type: "toolcall.end", toolCallId: "inspect", args: {} });
  push({ type: "toolresult.end", toolCallId: "inspect", result: "ok" });
  expect(push({ type: "message.delta", messageId: "answer", content: "Inspection complete." })).toEqual([
    { type: "THINKING_TEXT_MESSAGE_START", messageId: "answer" },
    { type: "THINKING_TEXT_MESSAGE_CONTENT", messageId: "answer", delta: "Inspection complete." },
  ]);
  expect(push({ type: "run.end", reason: "completed" })).toEqual([
    { type: "THINKING_TEXT_MESSAGE_END", messageId: "answer" },
    { type: "TEXT_MESSAGE_START", messageId: "answer", role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "answer", delta: "Inspection complete." },
    { type: "TEXT_MESSAGE_END", messageId: "answer" },
    { type: "RUN_FINISHED", threadId: payload.threadId, runId: payload.runId },
  ]);
});

it("derives a user/session cwd from trusted forwarded uid and defaults missing uid", async () => {
  const root = await mkdtemp(join(tmpdir(), "agui-storage-")); dirs.push(root);
  const explicit = await fixture(undefined, undefined, { execution: "local", workdir: root });
  await decode(await explicit.app.request("/ag-ui/agent", post({ ...payload, forwardedProps: { uid: "user_1" } })));
  expect(explicit.seen[0].agent?.cwd).toBe(join(root, "user_1", payload.threadId));
  expect((await stat(join(root, "user_1", payload.threadId))).isDirectory()).toBe(true);

  const fallback = await fixture(undefined, undefined, { execution: "local", workdir: root });
  await decode(await fallback.app.request("/ag-ui/agent", post(payload)));
  expect(fallback.seen[0].agent?.cwd).toBe(join(root, "default", payload.threadId));
});

it("maps trusted AG-UI message attachments to Runloop user.attachment events", async () => {
  const root = await mkdtemp(join(tmpdir(), "agui-attachment-workspace-")); dirs.push(root);
  const f = await fixture(undefined, undefined, { execution: "local", workdir: root });
  const attachment = {
    id: "up_abc", name: "photo.png", mimeType: "image/png", size: 3,
    uri: "attachment:up_abc", etag: '"etag-1"', region: "legacy-storage-metadata",
  };
  const downloadUrl = "https://files.example.com/download/signed-object?signature=test";
  vi.stubGlobal("fetch", vi.fn(async () => new Response("png", { headers: {
    "Content-Length": "3", ETag: attachment.etag, "Content-Type": attachment.mimeType,
  } })));
  await decode(await f.app.request("/ag-ui/agent", post({
    ...payload,
    messages: [{ id: "message-direct-demo", role: "user", content: "看看图片", attachments: [attachment] }],
    forwardedProps: { uid: "user_1", attachmentDownloads: [{ uri: attachment.uri, url: downloadUrl }] },
  })));
  expect(f.seen[0].events).toEqual([
    { type: "user.message", content: "看看图片" },
    { type: "user.attachment", id: attachment.id, uri: join(root, "user_1", payload.threadId, "uploads/up_abc/photo.png"), etag: attachment.etag, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size },
  ]);
  expect(await readFile(join(root, "user_1", payload.threadId, "uploads/up_abc/photo.png"), "utf8")).toBe("png");
});

it("rejects unsafe forwarded uid", async () => {
  const f = await fixture();
  const events = await decode(await f.app.request("/ag-ui/agent", post({ ...payload, forwardedProps: { uid: "../other" } })));
  expect(events).toEqual([expect.objectContaining({ type: "RUN_ERROR", code: "INVALID_REQUEST" })]);
  expect(f.seen).toHaveLength(0);
});

it("replays text, tool results, instructions and context without accepting client runtime configuration", async () => {
  const f = await fixture();
  const messages = [
    { id: "s", role: "system", content: "Speak Chinese" }, { id: "d", role: "developer", content: "Be concise" },
    { id: "u", role: "user", content: [{ type: "text", text: "First" }, { type: "text", text: "question" }] },
    { id: "a", role: "assistant", content: "Checking", toolCalls: [{ id: "t", type: "function", function: { name: "managed_echo", arguments: '{"text":"hello"}' } }] },
    { id: "t-result", role: "tool", toolCallId: "t", content: "already-executed-result" },
    { id: "a2", role: "assistant", content: null, toolCalls: [{ id: "t2", type: "function", function: { name: "managed_echo", arguments: "{}" } }] },
    { id: "t-result2", role: "tool", toolCallId: "t2", content: "second-result" },
    { id: "u2", role: "user", content: "Continue" },
  ];
  const stream = await decode(await f.app.request("/ag-ui/agent", post({
    ...payload, messages, state: { selected: 1 },
    context: [{ description: "reference", value: "untrusted data" }],
    tools: [{ name: "client-shell", description: "ignored", parameters: {} }],
    forwardedProps: { model: { apiKey: "evil" }, agent: { cwd: "/", env: { TOKEN: "evil" } } },
  })));
  expect(stream[1]).toMatchObject({ type: "STATE_SNAPSHOT", snapshot: { selected: 1 } });
  const req = f.seen[0];
  expect(req.agent?.systemPrompt).toContain("Speak Chinese\n\nBe concise");
  expect(req.agent?.cwd).toBe(join(tmpdir(), "agentcore-user-work", "default", payload.threadId));
  expect(req.agent).not.toHaveProperty("env");
  expect(req.model?.model).toBe("qwen"); expect(req.clientTools).toBeUndefined();
  const replay = compressEvents(req.events as RunloopEvent[]);
  expect(replay.map(m => m.content).join("\n")).toContain("Reference context:");
  expect(replay.map(m => m.content).join("\n")).toContain("[Tool: managed_echo] → already-executed-result");
  expect(replay.at(-1)).toEqual({ role: "user", content: "Continue" });
});

it.each([
  { threadId: "../escape" }, { runId: "bad/id" }, { messages: [] },
  { messages: [{ id: "u", role: "user" }] }, { messages: [{ id: "a", role: "assistant" }] },
  { messages: [{ id: "t", role: "tool", content: "result" }] },
  { messages: [{ id: "u", role: "user", content: [{ type: "image", url: "https://example.invalid/image" }] }] },
  { model: { apiKey: "evil" } },
  { messages: [{ id: "a", role: "assistant", toolCalls: [{ id: "t", type: "function", function: { name: "echo", arguments: "not-json" } }] }] },
  { messages: [{ id: "a", role: "assistant", toolCalls: [{ id: "t", type: "function", function: { name: "echo", arguments: "[]" } }] }] },
])("rejects invalid input as an AG-UI error: %j", async override => {
  const f = await fixture();
  const events = await decode(await f.app.request("/ag-ui/agent", post({ ...payload, ...override })));
  expect(events).toEqual([expect.objectContaining({ type: "RUN_ERROR", code: "INVALID_REQUEST" })]);
  expect(f.seen).toHaveLength(0); expect(f.active.size).toBe(0);
});
it("handles malformed JSON and exposes protocol discovery", async () => {
  const f = await fixture();
  expect((await decode(await f.app.request("/ag-ui/agent", { method: "POST", body: "{" })))[0].code).toBe("INVALID_REQUEST");
  expect(await (await f.app.request("/")).json()).toMatchObject({ endpoint: "/ag-ui/agent", protocols: ["ag-ui", "runloop"] });
});
it.each(["/ag-ui/agent", "/invocations", "/"])("protects %s with the same application token", async route => {
  const f = await fixture(undefined, "app-token");
  expect((await f.app.request(route, post())).status).toBe(401);
  expect((await decode(await f.app.request(route, post(payload, { Authorization: "Bearer app-token" })))).at(-1).type).toBe("RUN_FINISHED");
});
it("shares reservations with Runloop and recovers from SDK preparation failures", async () => {
  const f = await fixture();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const preparationError = Object.assign(new Error("sensitive-upstream-detail"), {
    code: "Forbidden.Resource", statusCode: 403, requestId: "resource-request-1",
  });
  let reject!: (error: Error) => void;
  vi.mocked(f.runtime.manifest).mockImplementationOnce(() => new Promise((_r, j) => { reject = j; }));
  const first = f.app.request("/ag-ui/agent", post());
  await vi.waitFor(() => expect(f.active.size).toBe(1));
  expect((await decode(await f.app.request("/ag-ui/agent", post())))[0].code).toBe("THREAD_BUSY");
  expect((await f.app.request("/v1/run", post({ conversationId: payload.threadId, events: [] }))).status).toBe(409);
  reject(preparationError);
  const events = await decode(await first);
  expect(events[0].code).toBe("RESOURCES_NOT_READY"); expect(JSON.stringify(events)).not.toContain("sensitive-upstream-detail");
  expect(events[0].message).toContain("Forbidden.Resource");
  expect(events[0].message).toContain("resource-request-1");
  const logs = log.mock.calls.flat().join("\n");
  expect(logs).toContain('"code":"RESOURCE_MANIFEST_FAILED"');
  expect(logs).toContain('"causeCode":"Forbidden.Resource"');
  expect(f.active.size).toBe(0);
  expect((await decode(await f.app.request("/ag-ui/agent", post()))).at(-1).type).toBe("RUN_FINISHED");
});
it("identifies a required model resource failure without exposing provider details", async () => {
  const f = await fixture();
  vi.mocked(f.runtime.manifest).mockRejectedValueOnce(new RuntimeInitializationError(Object.assign(
    new Error("provider detail"),
    { code: "Forbidden.Model", statusCode: 403, requestId: "model-request-1" },
  )));
  const events = await decode(await f.app.request("/ag-ui/agent", post()));
  expect(events[0]).toMatchObject({
    type: "RUN_ERROR", code: "MODEL_RESOURCE_NOT_READY", message: expect.stringContaining("Forbidden.Model"),
  });
  expect(events[0].message).toContain("model-request-1");
  expect(events[0].message).not.toContain("provider detail");
});
it("streams valid complete arguments and tool results in order", async () => {
  const f = await fixture([
    { type: "toolcall.start", toolCallId: "t", toolName: "managed_echo" },
    { type: "toolcall.delta", toolCallId: "t", chunk: 'partial-untrusted-chunk' },
    { type: "toolcall.end", toolCallId: "t", args: { text: "hello" } },
    { type: "toolresult.end", toolCallId: "t", result: { content: "echo-ok" } },
    { type: "toolcall.start", toolCallId: "t2", toolName: "read_skill_file" },
    { type: "toolresult.end", toolCallId: "t2", result: "permission denied", isError: true },
    { type: "run.end", reason: "completed" },
  ]);
  const events = await decode(await f.app.request("/ag-ui/agent", post()));
  expect(events.slice(2, 6).map(e => e.type)).toEqual(["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT"]);
  expect(events[3].delta).toBe('{"text":"hello"}');
  expect(events[5]).toMatchObject({ role: "tool", toolCallId: "t", content: '{"content":"echo-ok"}' });
  expect(events.find(e => e.type === "TOOL_CALL_RESULT" && e.toolCallId === "t2").content).toBe('{"result":"permission denied","isError":true}');
});
it.each(["timeout", "interrupted", "error", "hitl_pending", "tool_pending"])("reports %s without a successful finish", async reason => {
  const f = await fixture([{ type: "message.delta", content: "partial" }, { type: "run.end", reason }]);
  const events = await decode(await f.app.request("/ag-ui/agent", post()));
  expect(events.at(-2).type).toBe("THINKING_TEXT_MESSAGE_END"); expect(events.at(-1).type).toBe("RUN_ERROR");
  expect(events.some(e => e.type === "RUN_FINISHED")).toBe(false);
});
it("reports one sanitized error even if runtime emits a terminal event afterwards", async () => {
  const f = await fixture([{ type: "run.error", error: { code: "LOOP_ERROR", message: "secret" } }, { type: "run.end", reason: "error" }]);
  const events = await decode(await f.app.request("/ag-ui/agent", post()));
  expect(events.filter(e => e.type === "RUN_ERROR")).toHaveLength(1); expect(JSON.stringify(events)).not.toContain("secret");
});
it("reports thrown and truncated streams and always releases the thread", async () => {
  const f = await fixture([]);
  expect((await decode(await f.app.request("/ag-ui/agent", post()))).at(-1).code).toBe("INCOMPLETE_STREAM");
  f.runner.run = async function* () { throw new Error("secret"); };
  expect((await decode(await f.app.request("/ag-ui/agent", post()))).at(-1).code).toBe("INTERNAL_ERROR");
  expect(f.active.size).toBe(0);
});
it("cancels Codex and releases the thread when AG-UI disconnects", async () => {
  const f = await fixture(); let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  f.runner.run = async function* () { await held; };
  const response = await f.app.request("/ag-ui/agent", post());
  const reader = response.body!.getReader(); await reader.read(); await reader.cancel(); finish();
  await vi.waitFor(() => expect(f.active.size).toBe(0));
  expect(f.runner.interrupt).toHaveBeenCalledWith(payload.threadId, "client_disconnected");
});
it("handles optional message IDs, duplicate boundaries, ignored reasoning and string/null results", () => {
  const stream = new AgUiStream(AgUiInputSchema.parse({ ...payload, state: undefined }));
  const push = (event: object) => stream.push({ id: "e", timestamp: 1, conversationId: "c", ...event } as RunloopEvent);
  expect(stream.start()[1].snapshot).toEqual({});
  expect(push({ type: "message.end" })).toEqual([]);
  expect(push({ type: "message.delta", content: "" })).toEqual([]);
  expect(push({ type: "message.start" })).toEqual([]);
  expect(push({ type: "message.start", messageId: "new" })).toEqual([]);
  expect(push({ type: "reasoning.delta", content: "private" })).toEqual([]);
  expect(push({ type: "toolcall.start", toolCallId: "t", toolName: "echo" })[0].type).toBe("TOOL_CALL_START");
  expect(push({ type: "toolcall.start", toolCallId: "t", toolName: "echo" })).toEqual([]);
  expect(push({ type: "toolcall.end", toolCallId: "absent", args: {} })).toEqual([]);
  expect(push({ type: "toolresult.end", toolCallId: "absent", result: null })).toEqual([]);
  expect(push({ type: "toolresult.end", toolCallId: "t", result: "plain" }).at(-1)?.content).toBe("plain");
  expect(push({ type: "toolresult.end", toolCallId: "t", result: undefined }).at(-1)?.content).toBe("null");
  expect(push({ type: "message.delta", messageId: "delta-only", content: "x" }).map(event => event.type)).toEqual([
    "THINKING_TEXT_MESSAGE_START", "THINKING_TEXT_MESSAGE_CONTENT",
  ]);
  expect(push({ type: "run.end", reason: "completed" }).map(event => event.type)).toEqual([
    "THINKING_TEXT_MESSAGE_END", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "RUN_FINISHED",
  ]);
  expect(push({ type: "message.delta", content: "late" })).toEqual([]); expect(stream.finish()).toEqual([]);
});
