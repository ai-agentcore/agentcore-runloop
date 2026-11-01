import { afterEach, expect, it, vi } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { ModelProviderProxy } from "../vendor/runloop/src/provider/proxy.js";
import { CodexAdapter } from "../vendor/runloop/src/acp/codex-adapter.js";
import { AgentProcess } from "../vendor/runloop/src/acp/process.js";
import { LoopRunner } from "../vendor/runloop/src/loop/runner.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.useRealTimers(); for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); });

async function connect() {
  let resolveRequest!: (res: ServerResponse) => void;
  const requested = new Promise<ServerResponse>(r => { resolveRequest = r; });
  const server = createServer((req, res) => { req.resume(); req.on("end", () => resolveRequest(res)); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  const proxy = new ModelProviderProxy({ config: { provider: "test", model: "test", apiKey: "fixture", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` } });
  await proxy.start(); cleanup.push(() => proxy.stop());
  const ws = new WebSocket(proxy.baseUrl.replace("http", "ws") + "/v1/responses");
  await once(ws, "open"); cleanup.push(async () => { ws.terminate(); });
  const events: Record<string, unknown>[] = [];
  ws.on("message", d => events.push(JSON.parse(d.toString())));
  ws.send(JSON.stringify({ model: "test", input: "hello", stream: true }));
  return { ws, proxy, res: await requested, events };
}

it.each([false, true])("keeps a model request alive beyond 30s, then closes only an idle connection (streaming=%s)", async streaming => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { ws, res, events } = await connect();
  if (streaming) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"choices":[{"index":0,"delta":{"content":"first "},"finish_reason":null}]}\n\n');
    await vi.waitFor(() => expect(events.some(e => e.type === "response.output_text.delta")).toBe(true));
  }
  await vi.advanceTimersByTimeAsync(31_000);
  expect(ws.readyState).toBe(WebSocket.OPEN);
  if (!streaming) res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end('data: {"choices":[{"index":0,"delta":{"content":"late reply"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  await vi.waitFor(() => expect(events.some(e => e.type === "response.completed")).toBe(true));
  expect(events.some(e => e.type === "response.output_text.delta" && e.delta === "late reply")).toBe(true);
  await vi.advanceTimersByTimeAsync(31_000);
  await vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED));
});

it.each([false, true])("cancels upstream and suppresses late text after disconnect (started=%s)", async started => {
  const { ws, proxy, res } = await connect();
  const deltas: string[] = []; proxy.onTextDelta(text => deltas.push(text));
  if (started) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write('data: {"choices":[]}\n\n'); }
  let closed = false; res.on("close", () => { closed = true; });
  ws.terminate();
  await vi.waitFor(() => expect(closed).toBe(true));
  expect(deltas).toEqual([]);
});

it("lets the run deadline own Codex lifetime instead of a hidden five-minute timer", async () => {
  const controller = new AbortController();
  const spawn = vi.spyOn(AgentProcess.prototype, "spawn").mockImplementation(function (this: AgentProcess) {
    queueMicrotask(() => this.emit("exit", 0));
  });
  const adapter = new CodexAdapter("fixture-codex");
  for await (const _ of adapter.run({ conversationId: "timer-test", messages: [{ role: "user", content: "hi" }], config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" }, signal: controller.signal })) { /* consume */ }
  expect(spawn.mock.calls[0][0].timeout).toBeUndefined();
});

it.each([undefined, 1])("reports a run timeout even if Codex exits zero and maxTurns=%s", async maxTurns => {
  vi.spyOn(AgentProcess.prototype, "spawn").mockImplementation(() => {});
  vi.spyOn(AgentProcess.prototype, "kill").mockImplementation(function (this: AgentProcess) { queueMicrotask(() => this.emit("exit", 0)); });
  const runner = new LoopRunner();
  const events = [];
  for await (const e of runner.run({ agent: { cli: "codex", timeoutMs: 200, maxTurns }, events: [{ type: "user.message", content: "hi" }], model: { provider: "test", model: "test", apiKey: "fixture", baseUrl: "http://127.0.0.1:1/v1" } })) events.push(e);
  expect(events.at(-1)).toMatchObject({ type: "run.end", reason: "timeout" });
  expect(events.some(e => e.type === "run.end" && e.reason === "completed")).toBe(false);
});

it("does not start a CLI after the run has already been cancelled", async () => {
  const controller = new AbortController(); controller.abort("timeout");
  const spawn = vi.spyOn(AgentProcess.prototype, "spawn").mockImplementation(function (this: AgentProcess) {
    queueMicrotask(() => this.emit("exit", 0));
  });
  const adapter = new CodexAdapter("fixture-codex");
  const events = [];
  for await (const e of adapter.run({ conversationId: "cancelled-test", messages: [], config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" }, signal: controller.signal })) events.push(e);
  expect(spawn).not.toHaveBeenCalled();
  expect(events.at(-1)).toMatchObject({ type: "turn.end", stopReason: "cancelled" });
});
