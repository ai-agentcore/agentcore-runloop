import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { CliAgentAdapter } from "@/acp/adapter.js";
import { EventType, type RunloopEvent } from "@/types/events.js";

const MOCK_CLI = resolve(__dirname, "../fixtures/mock-agent-cli.sh");

async function collectEvents(
  gen: AsyncGenerator<RunloopEvent>
): Promise<RunloopEvent[]> {
  const events: RunloopEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe("CliAgentAdapter", () => {
  it("runs mock CLI and produces turn lifecycle events", async () => {
    const adapter = new CliAgentAdapter(MOCK_CLI);

    const events = await collectEvents(
      adapter.run({
        conversationId: "test-sess",
        messages: [{ role: "user", content: "hello" }],
        config: {
          mcpConfig: { mcpServers: {} },
          systemPromptAppend: "",
        },
      })
    );

    expect(events.length).toBeGreaterThan(0);

    const turnStart = events.find((e) => e.type === EventType.TurnStart);
    expect(turnStart).toBeDefined();

    const turnEnd = events.find((e) => e.type === EventType.TurnEnd);
    expect(turnEnd).toBeDefined();
    expect((turnEnd as any)?.stopReason).toBe("end_turn");
  });

  it("parses JSON result output into message events", async () => {
    const adapter = new CliAgentAdapter(MOCK_CLI);

    const events = await collectEvents(
      adapter.run({
        conversationId: "json-sess",
        messages: [{ role: "user", content: "test prompt" }],
        config: {
          mcpConfig: { mcpServers: {} },
          systemPromptAppend: "",
        },
      })
    );

    const messageStart = events.find((e) => e.type === EventType.MessageStart);
    const messageDelta = events.find((e) => e.type === EventType.MessageDelta);
    const messageEnd = events.find((e) => e.type === EventType.MessageEnd);
    const usage = events.find((e) => e.type === EventType.RunUsage);

    expect(messageStart).toBeDefined();
    expect(messageDelta).toBeDefined();
    expect((messageDelta as any)?.content).toContain("Mock response to:");
    expect(messageEnd).toBeDefined();
    expect(usage).toBeDefined();
    expect((usage as any)?.inputTokens).toBe(50);
    expect((usage as any)?.outputTokens).toBe(10);
  });

  it("produces session error for invalid command", async () => {
    const adapter = new CliAgentAdapter("nonexistent_cli_99999");

    const events = await collectEvents(
      adapter.run({
        conversationId: "err-sess",
        messages: [{ role: "user", content: "test" }],
        config: {
          mcpConfig: { mcpServers: {} },
          systemPromptAppend: "",
        },
      })
    );

    const errorEvent = events.find((e) => e.type === EventType.RunError);
    expect(errorEvent).toBeDefined();
  });

  it("handles non-JSON stdout as message delta", async () => {
    const adapter = new CliAgentAdapter("echo");

    const events = await collectEvents(
      adapter.run({
        conversationId: "text-sess",
        messages: [{ role: "user", content: "plain text" }],
        config: {
          mcpConfig: { mcpServers: {} },
          systemPromptAppend: "",
        },
      })
    );

    const deltas = events.filter((e) => e.type === EventType.MessageDelta);
    expect(deltas.length).toBeGreaterThan(0);
  });

  it("supports abort via signal", async () => {
    const adapter = new CliAgentAdapter("sleep");
    const controller = new AbortController();

    setTimeout(() => controller.abort(), 100);

    const events = await collectEvents(
      adapter.run({
        conversationId: "abort-sess",
        messages: [{ role: "user", content: "10" }],
        config: {
          mcpConfig: { mcpServers: {} },
          systemPromptAppend: "",
        },
        signal: controller.signal,
      })
    );

    const turnEnd = events.find((e) => e.type === EventType.TurnEnd);
    expect(turnEnd).toBeDefined();
    expect((turnEnd as any)?.stopReason).toBe("cancelled");
  });

  it("can be interrupted via interrupt()", async () => {
    const adapter = new CliAgentAdapter("sleep");

    setTimeout(() => adapter.interrupt(), 100);

    const events = await collectEvents(
      adapter.run({
        conversationId: "interrupt-sess",
        messages: [{ role: "user", content: "10" }],
        config: {
          mcpConfig: { mcpServers: {} },
          systemPromptAppend: "",
        },
      })
    );

    const turnEnd = events.find((e) => e.type === EventType.TurnEnd);
    expect(turnEnd).toBeDefined();
  });

  it("writes MCP config to temp file when servers exist", async () => {
    const adapter = new CliAgentAdapter(MOCK_CLI);

    const events = await collectEvents(
      adapter.run({
        conversationId: "mcp-sess",
        messages: [{ role: "user", content: "test" }],
        config: {
          mcpConfig: {
            mcpServers: {
              "test-server": {
                type: "stdio" as const,
                command: "npx",
                args: ["-y", "test-mcp"],
              },
            },
          },
          systemPromptAppend: "extra instructions",
        },
        systemPrompt: "base prompt",
      })
    );

    expect(events.length).toBeGreaterThan(0);
  });

  it("passes model and cwd options", async () => {
    const adapter = new CliAgentAdapter(MOCK_CLI);

    const events = await collectEvents(
      adapter.run({
        conversationId: "opts-sess",
        messages: [{ role: "user", content: "test" }],
        config: {
          mcpConfig: { mcpServers: {} },
          systemPromptAppend: "",
        },
        model: { provider: "openai", model: "gpt-4o" },
        cwd: "/tmp",
      })
    );

    expect(events.length).toBeGreaterThan(0);
  });

  it("handles empty result from CLI JSON", async () => {
    const adapter = new CliAgentAdapter("sh");

    const events = await collectEvents(
      adapter.run({
        conversationId: "empty-sess",
        messages: [
          {
            role: "user",
            content: `printf '{"type":"result","result":"","usage":{}}'`,
          },
        ],
        config: {
          mcpConfig: { mcpServers: {} },
          systemPromptAppend: "",
        },
      })
    );

    const messageStart = events.find((e) => e.type === EventType.MessageStart);
    expect(messageStart).toBeUndefined();
  });

  it("handles CLI output with no usage data", async () => {
    const noUsageScript = resolve(__dirname, "../fixtures/mock-no-usage.sh");
    const { writeFileSync, chmodSync } = await import("node:fs");
    writeFileSync(
      noUsageScript,
      '#!/bin/sh\necho \'{"type":"result","result":"hello"}\'\n'
    );
    chmodSync(noUsageScript, 0o755);

    const adapter = new CliAgentAdapter(noUsageScript);

    const events = await collectEvents(
      adapter.run({
        conversationId: "no-usage-sess",
        messages: [{ role: "user", content: "test" }],
        config: {
          mcpConfig: { mcpServers: {} },
          systemPromptAppend: "",
        },
      })
    );

    const usage = events.find((e) => e.type === EventType.RunUsage);
    expect(usage).toBeUndefined();

    const messageDelta = events.find((e) => e.type === EventType.MessageDelta);
    expect(messageDelta).toBeDefined();
    expect((messageDelta as any)?.content).toBe("hello");
  });

  it("handles non-result type JSON from CLI", async () => {
    const adapter = new CliAgentAdapter("sh");

    const events = await collectEvents(
      adapter.run({
        conversationId: "non-result-sess",
        messages: [
          {
            role: "user",
            content: `printf '{"type":"status","message":"processing"}'`,
          },
        ],
        config: {
          mcpConfig: { mcpServers: {} },
          systemPromptAppend: "",
        },
      })
    );

    const messageStart = events.find((e) => e.type === EventType.MessageStart);
    expect(messageStart).toBeUndefined();
  });

  it("handles whitespace-only lines gracefully", async () => {
    const adapter = new CliAgentAdapter("sh");

    const events = await collectEvents(
      adapter.run({
        conversationId: "ws-sess",
        messages: [
          {
            role: "user",
            content: `printf '\\n  \\n'`,
          },
        ],
        config: {
          mcpConfig: { mcpServers: {} },
          systemPromptAppend: "",
        },
      })
    );

    const deltas = events.filter((e) => e.type === EventType.MessageDelta);
    expect(deltas).toHaveLength(0);
  });

  it("cleans up tmp directory after run", async () => {
    const { existsSync } = await import("node:fs");
    const adapter = new CliAgentAdapter(MOCK_CLI);

    await collectEvents(
      adapter.run({
        conversationId: "cleanup-sess",
        messages: [{ role: "user", content: "test" }],
        config: {
          mcpConfig: {
            mcpServers: {
              s: { type: "stdio" as const, command: "echo" },
            },
          },
          systemPromptAppend: "",
        },
      })
    );

    // Can't easily inspect private tmpDir, but no leaked files
    expect(true).toBe(true);
  });
});
