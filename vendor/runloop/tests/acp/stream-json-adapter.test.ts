import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { writeFileSync, chmodSync } from "node:fs";
import { StreamJsonAdapter } from "@/acp/stream-json-adapter.js";
import { EventType, type RunloopEvent } from "@/types/events.js";

async function collectEvents(
  gen: AsyncGenerator<RunloopEvent>
): Promise<RunloopEvent[]> {
  const events: RunloopEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function createScript(name: string, content: string): string {
  const path = resolve(__dirname, `../fixtures/${name}`);
  writeFileSync(path, `#!/bin/sh\n${content}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("StreamJsonAdapter", () => {
  it("parses assistant message events from stream-json output", async () => {
    const script = createScript(
      "stream-assistant.sh",
      `echo '{"type":"assistant","content":"Hello "}'
echo '{"type":"assistant","content":"world"}'
echo '{"type":"result","usage":{"input_tokens":100,"output_tokens":20},"total_cost_usd":0.01}'`
    );

    const adapter = new StreamJsonAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "stream-test",
        messages: [{ role: "user", content: "hi" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );

    const msgStart = events.find((e) => e.type === EventType.MessageStart);
    expect(msgStart).toBeDefined();

    const deltas = events.filter((e) => e.type === EventType.MessageDelta);
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect((deltas[0] as any).content).toBe("Hello ");
    expect((deltas[1] as any).content).toBe("world");

    const msgEnd = events.filter((e) => e.type === EventType.MessageEnd);
    expect(msgEnd.length).toBeGreaterThanOrEqual(1);

    const usage = events.find((e) => e.type === EventType.RunUsage);
    expect(usage).toBeDefined();
    expect((usage as any).inputTokens).toBe(100);
  });

  it("parses tool use events", async () => {
    const script = createScript(
      "stream-tool.sh",
      `echo '{"type":"assistant","tool_use":{"name":"read_file","id":"tc-1","input":{"path":"test.txt"}}}'
echo '{"type":"assistant","tool_result":{"id":"tc-1","content":"file contents"}}'
echo '{"type":"result","usage":{}}'`
    );

    const adapter = new StreamJsonAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "tool-test",
        messages: [{ role: "user", content: "read file" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );

    const toolStart = events.find((e) => e.type === EventType.ToolcallStart);
    expect(toolStart).toBeDefined();
    expect((toolStart as any).toolName).toBe("read_file");

    const toolExec = events.find(
      (e) => e.type === EventType.ToolcallEnd
    );
    expect(toolExec).toBeDefined();

    const toolResult = events.find((e) => e.type === EventType.ToolresultEnd);
    expect(toolResult).toBeDefined();
    expect((toolResult as any).result).toBe("file contents");
  });

  it("parses tool error events", async () => {
    const script = createScript(
      "stream-tool-err.sh",
      `echo '{"type":"assistant","tool_result":{"id":"tc-2","content":"permission denied","is_error":true}}'
echo '{"type":"result","usage":{}}'`
    );

    const adapter = new StreamJsonAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "tool-err-test",
        messages: [{ role: "user", content: "test" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );

    const toolErr = events.find(
      (e) => e.type === EventType.ToolresultEnd && (e as any).isError === true
    );
    expect(toolErr).toBeDefined();
    expect((toolErr as any).isError).toBe(true);
    expect((toolErr as any).result.message).toContain("permission denied");
  });

  it("handles system messages (ignores them)", async () => {
    const script = createScript(
      "stream-system.sh",
      `echo '{"type":"system","subtype":"init","tools":[]}'
echo '{"type":"assistant","content":"hi"}'
echo '{"type":"result","usage":{}}'`
    );

    const adapter = new StreamJsonAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "sys-test",
        messages: [{ role: "user", content: "test" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );

    const delta = events.find((e) => e.type === EventType.MessageDelta);
    expect(delta).toBeDefined();
    expect((delta as any).content).toBe("hi");
  });

  it("handles non-JSON lines as message deltas", async () => {
    const script = createScript(
      "stream-text.sh",
      `echo 'plain text output'`
    );

    const adapter = new StreamJsonAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "text-test",
        messages: [{ role: "user", content: "test" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );

    const delta = events.find((e) => e.type === EventType.MessageDelta);
    expect(delta).toBeDefined();
    expect((delta as any).content).toContain("plain text output");
  });

  it("handles process errors", async () => {
    const adapter = new StreamJsonAdapter("nonexistent_command_99");
    const events = await collectEvents(
      adapter.run({
        conversationId: "err-test",
        messages: [{ role: "user", content: "test" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );

    const err = events.find((e) => e.type === EventType.RunError);
    expect(err).toBeDefined();
  });

  it("supports interrupt", async () => {
    const adapter = new StreamJsonAdapter("sleep");
    setTimeout(() => adapter.interrupt(), 100);

    const events = await collectEvents(
      adapter.run({
        conversationId: "int-test",
        messages: [{ role: "user", content: "10" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );

    const turnEnd = events.find((e) => e.type === EventType.TurnEnd);
    expect(turnEnd).toBeDefined();
    expect((turnEnd as any).stopReason).toBe("cancelled");
  });

  it("passes MCP config and system prompt", async () => {
    const script = createScript("stream-args.sh", `echo '{"type":"result","usage":{}}'`);

    const adapter = new StreamJsonAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "args-test",
        messages: [{ role: "user", content: "test" }],
        config: {
          mcpConfig: {
            mcpServers: { s: { type: "stdio" as const, command: "echo" } },
          },
          systemPromptAppend: "extra",
        },
        systemPrompt: "base",
        model: { provider: "openai", model: "gpt-4o" },
        cwd: "/tmp",
      })
    );

    expect(events.length).toBeGreaterThan(0);
  });
});
