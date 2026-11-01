import { describe, it, expect } from "vitest";
import { resolve, join } from "node:path";
import { writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { AcpAdapter, AcpServerAdapter } from "@/acp/acp-adapter.js";
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

function createAcpMockScript(name: string, responses: string): string {
  const path = resolve(__dirname, `../fixtures/${name}`);
  writeFileSync(
    path,
    `#!/bin/sh
# Mock ACP agent: reads JSON-RPC from stdin, responds on stdout
${responses}
`
  );
  chmodSync(path, 0o755);
  return path;
}

describe("AcpAdapter", () => {
  it("handles process error for invalid command", async () => {
    const adapter = new AcpAdapter("nonexistent_acp_agent_99");
    const events = await collectEvents(
      adapter.run({
        conversationId: "acp-err",
        messages: [{ role: "user", content: "test" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );

    const hasErrorOrEnd = events.some(
      (e) =>
        e.type === EventType.RunError || e.type === EventType.TurnEnd
    );
    expect(hasErrorOrEnd).toBe(true);
  });

  it("produces turn lifecycle events with mock acp agent", async () => {
    const script = createAcpMockScript(
      "mock-acp-agent.sh",
      `# Read and respond to initialize
read line
echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{}}}'

# Read and respond to session/new
read line
echo '{"jsonrpc":"2.0","id":2,"result":{"conversationId":"mock-session-1"}}'

# Read session/prompt and emit update + response
read line
echo '{"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"message","content":"Hello from ACP"}}'
echo '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}'

# Exit cleanly
exit 0`
    );

    const adapter = new AcpAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "acp-mock",
        messages: [{ role: "user", content: "hello" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );

    const turnStart = events.find((e) => e.type === EventType.TurnStart);
    expect(turnStart).toBeDefined();

    const delta = events.find((e) => e.type === EventType.MessageDelta);
    expect(delta).toBeDefined();
    if (delta) {
      expect((delta as any).content).toBe("Hello from ACP");
    }

    const turnEnd = events.find((e) => e.type === EventType.TurnEnd);
    expect(turnEnd).toBeDefined();
  });

  it("handles tool_call session updates", async () => {
    const script = createAcpMockScript(
      "mock-acp-tool.sh",
      `read line
echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
read line
echo '{"jsonrpc":"2.0","id":2,"result":{"conversationId":"s1"}}'
read line
echo '{"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"tool_call","toolCall":{"toolCallId":"tc-1","name":"read_file","status":"in_progress","kind":"read"}}}'
echo '{"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"tool_call","toolCall":{"toolCallId":"tc-1","name":"read_file","status":"completed","rawOutput":"content"}}}'
echo '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}'
exit 0`
    );

    const adapter = new AcpAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "acp-tool",
        messages: [{ role: "user", content: "read file" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );

    const toolStart = events.find((e) => e.type === EventType.ToolcallStart);
    expect(toolStart).toBeDefined();
    expect((toolStart as any)?.toolName).toBe("read_file");

    const toolResult = events.find((e) => e.type === EventType.ToolresultEnd);
    expect(toolResult).toBeDefined();
  });

  it("handles failed tool calls", async () => {
    const script = createAcpMockScript(
      "mock-acp-tool-fail.sh",
      `read line
echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
read line
echo '{"jsonrpc":"2.0","id":2,"result":{"conversationId":"s1"}}'
read line
echo '{"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"tool_call","toolCall":{"toolCallId":"tc-f","name":"bad_tool","status":"failed","rawOutput":"permission denied"}}}'
echo '{"jsonrpc":"2.0","id":3,"result":{}}'
exit 0`
    );

    const adapter = new AcpAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "acp-fail",
        messages: [{ role: "user", content: "test" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );

    const toolErr = events.find(
      (e) => e.type === EventType.ToolresultEnd && (e as any).isError === true
    );
    expect(toolErr).toBeDefined();
  });

  it("handles plan updates", async () => {
    const script = createAcpMockScript(
      "mock-acp-plan.sh",
      `read line
echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
read line
echo '{"jsonrpc":"2.0","id":2,"result":{"conversationId":"s1"}}'
read line
echo '{"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"plan","entries":[{"content":"Step 1","status":"completed"},{"content":"Step 2","status":"pending"}]}}'
echo '{"jsonrpc":"2.0","id":3,"result":{}}'
exit 0`
    );

    const adapter = new AcpAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "acp-plan",
        messages: [{ role: "user", content: "plan" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );

    const plan = events.find((e) => e.type === EventType.PlanUpdate);
    expect(plan).toBeDefined();
    expect((plan as any).entries).toHaveLength(2);
  });

  it("passes MCP servers to session/new", async () => {
    const script = createAcpMockScript(
      "mock-acp-mcp.sh",
      `read line
echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
read line
echo '{"jsonrpc":"2.0","id":2,"result":{"conversationId":"s1"}}'
read line
echo '{"jsonrpc":"2.0","id":3,"result":{}}'
exit 0`
    );

    const adapter = new AcpAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "acp-mcp",
        messages: [{ role: "user", content: "test" }],
        config: {
          mcpConfig: {
            mcpServers: {
              "my-server": {
                type: "stdio" as const,
                command: "npx",
                args: ["-y", "server"],
                env: { KEY: "val" },
              },
            },
          },
          systemPromptAppend: "extra context",
        },
        systemPrompt: "base prompt",
        cwd: "/tmp",
      })
    );

    expect(events.length).toBeGreaterThan(0);
  });

  it("creates CODEX_HOME with auth.json for codex-acp", () => {
    const adapter = new AcpServerAdapter("codex-acp") as any;
    const { env, extraArgs } = adapter.buildModelConfig(
      { model: "qwen3.7-max", provider: "dashscope" },
      "http://127.0.0.1:12345"
    );

    expect(env.OPENAI_API_KEY).toBe("runloop-proxy");
    expect(env.NO_PROXY).toBe("127.0.0.1,localhost");
    expect(env.CODEX_HOME).toBeDefined();
    expect(existsSync(env.CODEX_HOME)).toBe(true);

    const authJson = JSON.parse(readFileSync(join(env.CODEX_HOME, "auth.json"), "utf-8"));
    expect(authJson).toEqual({ auth_mode: "apikey", OPENAI_API_KEY: "runloop-proxy" });

    const configToml = readFileSync(join(env.CODEX_HOME, "config.toml"), "utf-8");
    expect(configToml).toContain("http://127.0.0.1:12345/v1");

    expect(extraArgs).toContain("-c");
    expect(extraArgs).toContain('openai_base_url="http://127.0.0.1:12345/v1"');
  });

  it("does not create CODEX_HOME for non-codex CLI", () => {
    const adapter = new AcpServerAdapter("qodercli", { defaultArgs: ["--acp"] }) as any;
    const { env } = adapter.buildModelConfig(
      { model: "qwen3.7-max", provider: "dashscope" },
      "http://127.0.0.1:12345"
    );

    expect(env.OPENAI_API_KEY).toBe("runloop-proxy");
    expect(env.CODEX_HOME).toBeUndefined();
  });

  it("sends cancel notification on interrupt", async () => {
    const script = createAcpMockScript(
      "mock-acp-slow.sh",
      `read line
echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
read line
echo '{"jsonrpc":"2.0","id":2,"result":{"conversationId":"s1"}}'
read line
sleep 30`
    );

    const adapter = new AcpAdapter(script);
    setTimeout(() => adapter.interrupt(), 200);

    const events = await collectEvents(
      adapter.run({
        conversationId: "acp-int",
        messages: [{ role: "user", content: "test" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );

    const turnEnd = events.find((e) => e.type === EventType.TurnEnd);
    expect(turnEnd).toBeDefined();
    expect((turnEnd as any).stopReason).toBe("cancelled");
  }, 10_000);
});
