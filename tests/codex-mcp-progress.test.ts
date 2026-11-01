import { afterEach, expect, it, vi } from "vitest";
import { CodexAdapter } from "../vendor/runloop/src/acp/codex-adapter.js";
import type { AgentRunParams } from "../vendor/runloop/src/acp/adapter.js";
import { AgentProcess } from "../vendor/runloop/src/acp/process.js";
import type { RunloopEvent } from "../vendor/runloop/src/types/events.js";

afterEach(() => vi.restoreAllMocks());
const params: AgentRunParams = {
  conversationId: "mcp-progress", messages: [{ role: "user", content: "Search the source" }],
  config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
};
const toolCall = {
  id: "search-1", type: "mcp_tool_call", arguments: {}, status: "in_progress",
  tool: "mcp__agentcore__mcp__search__query",
};
function emit(process: AgentProcess, type: string, item: Record<string, unknown>) {
  process.emit("stdout", JSON.stringify({ type, item }));
}

it("reports a pending MCP call before completion without duplicate events", async () => {
  let process!: AgentProcess;
  vi.spyOn(AgentProcess.prototype, "spawn").mockImplementation(function (this: AgentProcess) {
    process = this;
    queueMicrotask(() => {
      emit(this, "item.started", toolCall);
      emit(this, "item.updated", toolCall);
    });
  });
  const events: RunloopEvent[] = [];
  const result = { content: [{ type: "text", text: "ready" }], structured_content: { created: true } };
  for await (const event of new CodexAdapter("fixture-codex").run(params)) {
    events.push(event);
    // Release completion only after the consumer sees the pending call.
    if (event.type === "toolcall.end" && event.toolCallId === toolCall.id) {
      expect(events.some(entry => entry.type === "toolresult.end")).toBe(false);
      emit(process, "item.completed", { ...toolCall, status: "completed", result });
      process.emit("exit", 0);
    }
  }
  expect(events.filter(event => event.type.startsWith("tool"))).toEqual([
    expect.objectContaining({ type: "toolcall.start", toolCallId: toolCall.id, toolName: "mcp__search__query" }),
    expect.objectContaining({ type: "toolcall.end", toolCallId: toolCall.id, args: {} }),
    expect.objectContaining({ type: "toolresult.end", toolCallId: toolCall.id, result, isError: false }),
  ]);
});

it.each([false, true])("preserves completion fallback, late arguments and per-run IDs (early=%s)", async early => {
  vi.spyOn(AgentProcess.prototype, "spawn").mockImplementation(function (this: AgentProcess) {
    queueMicrotask(() => {
      if (early) {
        emit(this, "item.started", { ...toolCall, arguments: undefined });
        emit(this, "item.updated", { ...toolCall, arguments: '{"name":' });
      }
      emit(this, "item.completed", { ...toolCall, arguments: '{"name":"example"}', status: "failed", result: "failed" });
      this.emit("exit", 0);
    });
  });
  const adapter = new CodexAdapter("fixture-codex");
  for (let run = 0; run < 2; run++) {
    const events: RunloopEvent[] = [];
    for await (const event of adapter.run(params)) events.push(event);
    expect(events.filter(event => event.type.startsWith("tool"))).toEqual([
      expect.objectContaining({ type: "toolcall.start", toolCallId: toolCall.id }),
      expect.objectContaining({ type: "toolcall.end", toolCallId: toolCall.id, args: { name: "example" } }),
      expect.objectContaining({ type: "toolresult.end", toolCallId: toolCall.id, result: "failed", isError: true }),
    ]);
  }
});

it("leaves delegated and client tool lifecycles to the server at every event stage", async () => {
  const toolNames = ["agent__helper__delegate", "client__confirm", "mcp__search__query", "grep"];
  vi.spyOn(AgentProcess.prototype, "spawn").mockImplementation(function (this: AgentProcess) {
    queueMicrotask(() => {
      for (const tool of toolNames) {
        for (const type of ["item.started", "item.updated", "item.completed"]) {
          emit(this, type, { ...toolCall, id: tool, tool: `mcp__agentcore__${tool}` });
        }
      }
      this.emit("exit", 0);
    });
  });
  const events: RunloopEvent[] = [];
  for await (const event of new CodexAdapter("fixture-codex").run({
    ...params, delegationToolNames: new Set([toolNames[0]]), clientToolNames: new Set([toolNames[1]]),
    serverToolNames: new Set(toolNames.slice(2)),
  })) events.push(event);
  expect(events.filter(event => event.type.startsWith("tool"))).toEqual([]);
});
