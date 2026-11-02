import { describe, it, expect, afterEach } from "vitest";
import { resolve } from "node:path";
import { writeFileSync, chmodSync, existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "@/acp/codex-adapter.js";
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

describe("CodexAdapter", () => {
  it("parses codex JSONL output into events", async () => {
    const script = createScript(
      "mock-codex.sh",
      `echo '{"type":"thread.started","thread_id":"t1"}'
echo '{"type":"turn.started"}'
echo '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"PONG"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":50,"output_tokens":10,"reasoning_output_tokens":5}}'`
    );

    const adapter = new CodexAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "codex-test",
        messages: [{ role: "user", content: "say PONG" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );

    const turnStart = events.find((e) => e.type === EventType.TurnStart);
    expect(turnStart).toBeDefined();

    const msgStart = events.find((e) => e.type === EventType.MessageStart);
    expect(msgStart).toBeDefined();

    const delta = events.find((e) => e.type === EventType.MessageDelta);
    expect(delta).toBeDefined();
    expect((delta as any).content).toBe("PONG");

    const msgEnd = events.find((e) => e.type === EventType.MessageEnd);
    expect(msgEnd).toBeDefined();

    const usage = events.find((e) => e.type === EventType.RunUsage);
    expect(usage).toBeDefined();
    expect((usage as any).inputTokens).toBe(100);
    expect((usage as any).outputTokens).toBe(10);
    expect((usage as any).cacheReadTokens).toBe(50);

    const turnEnd = events.find((e) => e.type === EventType.TurnEnd);
    expect(turnEnd).toBeDefined();
    expect((turnEnd as any).stopReason).toBe("end_turn");
  });

  it("parses tool call events", async () => {
    const script = createScript(
      "mock-codex-tool.sh",
      `echo '{"type":"thread.started","thread_id":"t1"}'
echo '{"type":"turn.started"}'
echo '{"type":"item.completed","item":{"id":"tc-1","type":"tool_call","name":"read_file","arguments":"{\\"path\\":\\"test.txt\\"}"}}'
echo '{"type":"item.completed","item":{"id":"tr-1","type":"tool_result","call_id":"tc-1","output":"file contents"}}'
echo '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Done"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":200,"output_tokens":30}}'`
    );

    const adapter = new CodexAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "codex-tool-test",
        messages: [{ role: "user", content: "read file" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );

    const toolStart = events.find((e) => e.type === EventType.ToolcallStart);
    expect(toolStart).toBeDefined();
    expect((toolStart as any).toolName).toBe("read_file");

    const toolExec = events.find((e) => e.type === EventType.ToolcallEnd);
    expect(toolExec).toBeDefined();
    expect((toolExec as any).args).toEqual({ path: "test.txt" });

    const toolResult = events.find((e) => e.type === EventType.ToolresultEnd);
    expect(toolResult).toBeDefined();
    expect((toolResult as any).result).toBe("file contents");
  });

  it("parses command_execution items into tool events", async () => {
    const script = createScript(
      "mock-codex-exec.sh",
      `echo '{"type":"thread.started","thread_id":"t1"}'
echo '{"type":"turn.started"}'
echo '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"ls -la /tmp","aggregated_output":"total 0","exit_code":0,"status":"completed"}}'
echo '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Done"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":200,"output_tokens":30}}'`
    );

    const adapter = new CodexAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "codex-exec-test",
        messages: [{ role: "user", content: "call tool" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );

    const toolStart = events.find((e) => e.type === EventType.ToolcallStart);
    expect(toolStart).toBeDefined();
    expect((toolStart as any).toolName).toBe("exec_command");

    const toolExec = events.find((e) => e.type === EventType.ToolcallEnd);
    expect(toolExec).toBeDefined();
    expect((toolExec as any).args.cmd).toContain("ls -la");

    const toolResult = events.find((e) => e.type === EventType.ToolresultEnd);
    expect(toolResult).toBeDefined();
    expect((toolResult as any).result).toContain("total 0");
    expect((toolResult as any).isError).toBe(false);
  });


  it("suppresses mcp_tool_call card for client tools (消费通道 2)；非客户端工具仍渲染", async () => {
    // 客户端工具的权威 toolcall.start/end 由 runloop-mcp server 经 ctx.emit 发；adapter 抑制 codex 自产的
    // 重复 mcp_tool_call 卡片（matchesQualifiedName，同委派，AD-026 增补）。三个 mcp_tool_call 覆盖判定全分支：
    //  ① 裸名命中（rawName === name）→ 抑制；② 全限定名精确命中（rawName === `mcp__agentcore__name`）→ 抑制；③ 非客户端工具 → 仍渲染。
    const script = createScript(
      "mock-codex-clienttool.sh",
      `echo '{"type":"thread.started","thread_id":"t1"}'
echo '{"type":"turn.started"}'
echo '{"type":"item.completed","item":{"id":"item_0","type":"mcp_tool_call","tool":"get_user_location","arguments":{},"result":{"status":"tool_pending"}}}'
echo '{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","tool":"mcp__agentcore__get_user_location","arguments":{},"result":{"status":"tool_pending"}}}'
echo '{"type":"item.completed","item":{"id":"item_2","type":"mcp_tool_call","tool":"mcp__agentcore__real_tool","arguments":{"x":1},"result":{"ok":true}}}'
echo '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":10}}'`
    );

    const adapter = new CodexAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "codex-clienttool-test",
        messages: [{ role: "user", content: "where am i" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
        // 净化名集合（与 MCP server 暴露名一致）；codex 全限定名 mcp__agentcore__<name> 精确等于 → 命中抑制。
        clientToolNames: new Set(["get_user_location"]),
      })
    );

    // 两个客户端工具卡片都被抑制 → 流里没有 get_user_location 的 toolcall.start
    const starts = events.filter((e) => e.type === EventType.ToolcallStart) as Array<RunloopEvent & { toolName?: string }>;
    expect(starts.some((e) => e.toolName === "get_user_location")).toBe(false);
    // 非客户端工具 real_tool 不被抑制，正常渲染 toolcall.start
    expect(starts.some((e) => e.toolName === "real_tool")).toBe(true);
  });

  it("does NOT suppress a tool whose qualified name merely ends with __<setname> (P1-1 精确匹配)", async () => {
    // 评审 P1-1 回归：集合含短名 `exec`；rawName `mcp__agentcore__sandbox__mybox__exec` 以 `__exec` 结尾，
    // 但不是聚合器全限定名 `mcp__agentcore__exec` → 精确匹配下**不**抑制（旧 endsWith(`__exec`) 会误抑制正常工具卡片）。
    const script = createScript(
      "mock-codex-suffix.sh",
      `echo '{"type":"thread.started","thread_id":"t1"}'
echo '{"type":"turn.started"}'
echo '{"type":"item.completed","item":{"id":"item_0","type":"mcp_tool_call","tool":"mcp__agentcore__sandbox__mybox__exec","arguments":{},"result":{"ok":true}}}'
echo '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'`
    );

    const adapter = new CodexAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "codex-suffix-test",
        messages: [{ role: "user", content: "run" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
        delegationToolNames: new Set(["exec"]),
      })
    );

    // 剥聚合器前缀 `mcp__agentcore__` 后 = `sandbox__mybox__exec`，不被误抑制、正常渲染 toolcall.start。
    const starts = events.filter((e) => e.type === EventType.ToolcallStart) as Array<RunloopEvent & { toolName?: string }>;
    expect(starts.some((e) => e.toolName === "sandbox__mybox__exec")).toBe(true);
  });

  it("restores AD-029 MCP tool names without eating the type/resource segment (L-054)", async () => {
    // codex 的 mcp_tool_call item.tool 可能是裸 runloop 名（`mcp__calc__add`，server 在别处），
    // 也可能带聚合器前缀（`mcp__agentcore__mcp__leida__get_news`）。只剥 `mcp__agentcore__`，
    // 不能贪婪剥 `mcp__<任意>__`（否则 `mcp__calc__add` 被吃成 `add`）。
    const script = createScript(
      "mock-codex-mcp-name.sh",
      `echo '{"type":"item.completed","item":{"id":"i0","type":"mcp_tool_call","tool":"mcp__calc__add","arguments":{},"result":"r"}}'
echo '{"type":"item.completed","item":{"id":"i1","type":"mcp_tool_call","tool":"mcp__agentcore__mcp__leida__get_news","arguments":{},"result":"r"}}'
echo '{"type":"turn.completed","usage":{}}'`,
    );
    const adapter = new CodexAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "codex-mcp-name",
        messages: [{ role: "user", content: "go" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      }),
    );
    const names = events
      .filter((e) => e.type === EventType.ToolcallStart)
      .map((e) => (e as any).toolName);
    // 裸 runloop 名原样保留（不被吃成 add）；带聚合器前缀的只剥 `mcp__agentcore__`。
    expect(names).toContain("mcp__calc__add");
    expect(names).toContain("mcp__leida__get_news");
    expect(names).not.toContain("add");
  });

  it("handles process errors", async () => {
    const adapter = new CodexAdapter("nonexistent_codex_99");
    const events = await collectEvents(
      adapter.run({
        conversationId: "codex-err",
        messages: [{ role: "user", content: "test" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );

    const err = events.find((e) => e.type === EventType.RunError);
    expect(err).toBeDefined();
  });

  it("supports interrupt", async () => {
    const adapter = new CodexAdapter("sleep");
    setTimeout(() => adapter.interrupt(), 100);

    const events = await collectEvents(
      adapter.run({
        conversationId: "codex-int",
        messages: [{ role: "user", content: "10" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );

    const turnEnd = events.find((e) => e.type === EventType.TurnEnd);
    expect(turnEnd).toBeDefined();
    expect((turnEnd as any).stopReason).toBe("cancelled");
  });

  it("passes model and cwd", async () => {
    const script = createScript("mock-codex-args.sh", `echo '{"type":"turn.completed","usage":{}}'`);

    const adapter = new CodexAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "codex-args",
        messages: [{ role: "user", content: "test" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
        model: { provider: "openai", model: "o3" },
        cwd: "/tmp",
      })
    );

    expect(events.length).toBeGreaterThan(0);
  });

  it("handles non-JSON lines as message delta", async () => {
    const script = createScript("mock-codex-text.sh", `echo "plain output"`);

    const adapter = new CodexAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "codex-text",
        messages: [{ role: "user", content: "test" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );

    const delta = events.find((e) => e.type === EventType.MessageDelta);
    expect(delta).toBeDefined();
  });

  it("handles codex error events", async () => {
    const script = createScript(
      "mock-codex-error.sh",
      `echo '{"type":"thread.started","thread_id":"t1"}'
echo '{"type":"turn.started"}'
echo '{"type":"error","message":"model not supported"}'
echo '{"type":"turn.failed","error":{"message":"model not supported"}}'`
    );

    const adapter = new CodexAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "codex-error-test",
        messages: [{ role: "user", content: "test" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );

    const errors = events.filter((e) => e.type === EventType.RunError);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect((errors[0] as any).error.code).toBe("CODEX_ERROR");
    expect((errors[0] as any).error.message).toContain("model not supported");
  });

  it("writes systemPrompt into model_instructions_file (system#1), not developer_instructions; disables AGENTS.md", async () => {
    const script = createScript(
      "mock-codex-sysprompt.sh",
      `cat "$CODEX_HOME/config.toml"
echo "---FILE---"
cat "$CODEX_HOME/model-instructions.md"
echo '{"type":"turn.completed","usage":{}}'`
    );

    const adapter = new CodexAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "codex-sysprompt",
        messages: [{ role: "user", content: "test" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
        systemPrompt: "You are a helpful assistant",
        providerBaseUrl: "http://127.0.0.1:9999",
      })
    );

    const output = events
      .filter((e) => e.type === EventType.MessageDelta)
      .map((e) => (e as any).content)
      .join("");
    // 系统提示词进 model_instructions_file（system#1），不再写 developer_instructions（system#2）。
    expect(output).toContain("model_instructions_file =");
    expect(output).toContain("You are a helpful assistant");
    expect(output).not.toContain("developer_instructions");
    // codex 不再读 workspace AGENTS.md（消除 user#1）。
    expect(output).toContain("project_doc_max_bytes = 0");

    const turnEnd = events.find((e) => e.type === EventType.TurnEnd);
    expect(turnEnd).toBeDefined();
  });

  it("does not write instructions when systemPrompt is absent", async () => {
    const script = createScript(
      "mock-codex-no-sysprompt.sh",
      `echo '{"type":"turn.completed","usage":{}}'`
    );

    const adapter = new CodexAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "codex-no-sysprompt",
        messages: [{ role: "user", content: "test" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );

    const turnEnd = events.find((e) => e.type === EventType.TurnEnd);
    expect(turnEnd).toBeDefined();
  });

  it("combines systemPrompt and systemPromptAppend", async () => {
    const script = createScript(
      "mock-codex-combined.sh",
      `cat "$CODEX_HOME/config.toml"
echo "---FILE---"
cat "$CODEX_HOME/model-instructions.md"
echo '{"type":"turn.completed","usage":{}}'`
    );

    const adapter = new CodexAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "codex-combined",
        messages: [{ role: "user", content: "test" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "Extra context" },
        systemPrompt: "Base instructions",
        providerBaseUrl: "http://127.0.0.1:9999",
      })
    );

    const output = events
      .filter((e) => e.type === EventType.MessageDelta)
      .map((e) => (e as any).content)
      .join("");
    expect(output).toContain("Base instructions");
    expect(output).toContain("Extra context");
  });

  it("handles streaming items", async () => {
    const script = createScript(
      "mock-codex-stream.sh",
      `echo '{"type":"item.streaming","item":{"text":"hel"}}'
echo '{"type":"item.streaming","item":{"text":"lo"}}'
echo '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"hello"}}'
echo '{"type":"turn.completed","usage":{}}'`
    );

    const adapter = new CodexAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "codex-stream",
        messages: [{ role: "user", content: "test" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );

    const deltas = events.filter((e) => e.type === EventType.MessageDelta);
    expect(deltas.length).toBeGreaterThanOrEqual(2);
  });

  it("translates codex reasoning → reasoning.*（流式 + completed，不泄进 message）", async () => {
    const script = createScript(
      "mock-codex-reasoning.sh",
      `echo '{"type":"item.streaming","item":{"type":"reasoning","text":"think-a"}}'
echo '{"type":"item.streaming","item":{"type":"reasoning","text":"think-b"}}'
echo '{"type":"item.completed","item":{"id":"r0","type":"reasoning","text":"think-ab"}}'
echo '{"type":"item.streaming","item":{"text":"answer"}}'
echo '{"type":"item.completed","item":{"id":"m0","type":"agent_message","text":"answer"}}'
echo '{"type":"turn.completed","usage":{}}'`
    );
    const adapter = new CodexAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "codex-reasoning",
        messages: [{ role: "user", content: "test" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );
    expect(events.some((e) => e.type === EventType.ReasoningStart)).toBe(true);
    expect(events.filter((e) => e.type === EventType.ReasoningDelta).length).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.type === EventType.ReasoningEnd)).toBe(true);
    // reasoning 文本不泄进 message 正文；正文是 answer
    const msg = events.filter((e) => e.type === EventType.MessageDelta).map((e) => (e as { content?: string }).content ?? "").join("");
    expect(msg).not.toContain("think");
    expect(msg).toContain("answer");
  });

  it("maintains strict message.start/end pairing across text→tool→text transitions", async () => {
    const script = createScript(
      "mock-codex-interleave.sh",
      `echo '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"Let me check."}}'
echo '{"type":"item.completed","item":{"id":"tc-1","type":"tool_call","name":"exec_command","arguments":"{\\"cmd\\":\\"ls\\"}"}}'
echo '{"type":"item.completed","item":{"id":"tr-1","type":"tool_result","call_id":"tc-1","output":"files"}}'
echo '{"type":"item.completed","item":{"id":"m2","type":"agent_message","text":"Here are the results."}}'
echo '{"type":"item.completed","item":{"id":"tc-2","type":"tool_call","name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}}'
echo '{"type":"item.completed","item":{"id":"tr-2","type":"tool_result","call_id":"tc-2","output":"content"}}'
echo '{"type":"item.completed","item":{"id":"m3","type":"agent_message","text":"Done."}}'
echo '{"type":"turn.completed","usage":{"input_tokens":500,"output_tokens":100}}'`
    );

    const adapter = new CodexAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "codex-interleave",
        messages: [{ role: "user", content: "test" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );

    const types = events.map((e) => e.type);

    // message.start/end must be strictly paired
    let openMessages = 0;
    for (const t of types) {
      if (t === EventType.MessageStart) openMessages++;
      if (t === EventType.MessageEnd) openMessages--;
      expect(openMessages).toBeGreaterThanOrEqual(0);
      expect(openMessages).toBeLessThanOrEqual(1);
    }
    expect(openMessages).toBe(0);

    // tool_call.start must never appear while message is open
    let msgOpen = false;
    for (const t of types) {
      if (t === EventType.MessageStart) msgOpen = true;
      if (t === EventType.MessageEnd) msgOpen = false;
      if (t === EventType.ToolcallStart) {
        expect(msgOpen).toBe(false);
      }
    }

    // Should have 3 message segments and 2 tool calls
    expect(types.filter((t) => t === EventType.MessageStart).length).toBe(3);
    expect(types.filter((t) => t === EventType.MessageEnd).length).toBe(3);
    expect(types.filter((t) => t === EventType.ToolcallStart).length).toBe(2);
  });

  it("uses workspaceDir when provided", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "runloop-test-workspace-"));
    const script = createScript(
      "mock-codex-workspace.sh",
      `echo '{"type":"turn.completed","usage":{}}'`
    );

    const adapter = new CodexAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "codex-workspace",
        messages: [{ role: "user", content: "test" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
        workspaceDir,
      })
    );

    expect(existsSync(join(workspaceDir, ".runloop"))).toBe(true);

    const turnEnd = events.find((e) => e.type === EventType.TurnEnd);
    expect(turnEnd).toBeDefined();

    // cleanup
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("handles empty lines in codex output", async () => {
    const script = createScript(
      "mock-codex-empty-lines.sh",
      `echo ''
echo '  '
echo '{"type":"turn.completed","usage":{}}'`
    );

    const adapter = new CodexAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "codex-empty-lines",
        messages: [{ role: "user", content: "test" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );

    // Empty and whitespace-only lines should not produce message deltas
    const deltas = events.filter((e) => e.type === EventType.MessageDelta);
    expect(deltas.length).toBe(0);

    const turnEnd = events.find((e) => e.type === EventType.TurnEnd);
    expect(turnEnd).toBeDefined();
  });

  it("handles tool_call with object arguments (not string)", async () => {
    const script = createScript(
      "mock-codex-obj-args.sh",
      `echo '{"type":"thread.started","thread_id":"t1"}'
echo '{"type":"turn.started"}'
echo '{"type":"item.completed","item":{"id":"tc-1","type":"tool_call","name":"my_tool","arguments":{"key":"value"}}}'
echo '{"type":"turn.completed","usage":{}}'`
    );

    const adapter = new CodexAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "codex-obj-args",
        messages: [{ role: "user", content: "test" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );

    const toolExec = events.find((e) => e.type === EventType.ToolcallEnd);
    expect(toolExec).toBeDefined();
    expect((toolExec as any).args).toEqual({ key: "value" });

    const toolStart = events.find((e) => e.type === EventType.ToolcallStart);
    expect(toolStart).toBeDefined();
    expect((toolStart as any).toolName).toBe("my_tool");
  });

  it("handles tool_call with malformed JSON args → {raw} fallback, stream still completes (H9)", async () => {
    const script = createScript(
      "mock-codex-bad-args.sh",
      `echo '{"type":"thread.started","thread_id":"t1"}'
echo '{"type":"turn.started"}'
echo '{"type":"item.completed","item":{"id":"tc-1","type":"tool_call","name":"my_tool","arguments":"{}invalid"}}'
echo '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"done"}}'
echo '{"type":"turn.completed","usage":{}}'`
    );

    const adapter = new CodexAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "codex-bad-args",
        messages: [{ role: "user", content: "test" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );

    // 畸形 args 不再抛出逸出监听器：降级为 { raw }。
    const toolExec = events.find((e) => e.type === EventType.ToolcallEnd);
    expect(toolExec).toBeDefined();
    expect((toolExec as any).args).toEqual({ raw: "{}invalid" });
    // 该行之后的事件（assistant message + turn end）仍正常产出，流没被坏行中断。
    expect(events.some((e) => e.type === EventType.MessageDelta && (e as any).content === "done")).toBe(true);
    expect(events.some((e) => e.type === EventType.TurnEnd)).toBe(true);
  });

  it("includes assistant messages in transcript", async () => {
    const script = createScript(
      "mock-codex-transcript.sh",
      `# transcript 现经 stdin 传入（codex \`exec -\`），cat 出来以便检查
cat
echo '{"type":"turn.completed","usage":{}}'`
    );

    const adapter = new CodexAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "codex-transcript",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi there" },
          { role: "user", content: "bye" },
        ],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );

    // transcript 经 stdin 传入、被 mock 的 cat 回显到 stdout；非 JSON 行 → message delta
    const output = events
      .filter((e) => e.type === EventType.MessageDelta)
      .map((e) => (e as any).content)
      .join("");
    expect(output).toContain("[Assistant]");
    expect(output).toContain("hi there");
    expect(output).toContain("hello");
    expect(output).toContain("bye");
  });

  it("writes MCP server config to config.toml", async () => {
    const script = createScript(
      "mock-codex-mcp-config.sh",
      `cat "$CODEX_HOME/config.toml"
echo '{"type":"turn.completed","usage":{}}'`
    );

    const adapter = new CodexAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "codex-mcp-config",
        messages: [{ role: "user", content: "test" }],
        config: {
          mcpConfig: {
            mcpServers: {
              "my-url-server": { url: "http://localhost:8080/mcp" },
              "my-cmd-server": { command: "node", args: ["server.js", "--port", "9090"] },
            },
          },
          systemPromptAppend: "",
        },
        providerBaseUrl: "http://127.0.0.1:9999",
      })
    );

    const output = events
      .filter((e) => e.type === EventType.MessageDelta)
      .map((e) => (e as any).content)
      .join("");

    expect(output).toContain("[mcp_servers.my-url-server]");
    expect(output).toContain('url = "http://localhost:8080/mcp"');
    expect(output).toContain("[mcp_servers.my-cmd-server]");
    expect(output).toContain('command = "node"');
    expect(output).toContain('args = ["server.js", "--port", "9090"]');
  });

  it("disables codex built-in shell (shell_tool = false) only when execViaMcp", async () => {
    const mk = (name: string) =>
      createScript(name, `cat "$CODEX_HOME/config.toml"\necho '{"type":"turn.completed","usage":{}}'`);
    const cfg = { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" };
    const collect = async (execViaMcp?: boolean) => {
      const events = await collectEvents(
        new CodexAdapter(mk(`mock-codex-shelltool-${execViaMcp}.sh`)).run({
          conversationId: `codex-shelltool-${execViaMcp}`,
          messages: [{ role: "user", content: "test" }],
          config: cfg,
          providerBaseUrl: "http://127.0.0.1:9999",
          execViaMcp,
        })
      );
      return events
        .filter((e) => e.type === EventType.MessageDelta)
        .map((e) => (e as any).content)
        .join("");
    };

    expect(await collect(true)).toContain("shell_tool = false");
    expect(await collect(false)).not.toContain("shell_tool = false");
    expect(await collect(undefined)).not.toContain("shell_tool = false");
  });

  it("always disables codex plugin marketplace (plugins = false) to stop per-session git clone of $CODEX_HOME/.tmp/plugins", async () => {
    const script = createScript(
      "mock-codex-plugins.sh",
      `cat "$CODEX_HOME/config.toml"\necho '{"type":"turn.completed","usage":{}}'`
    );
    const events = await collectEvents(
      new CodexAdapter(script).run({
        conversationId: "codex-plugins-off",
        messages: [{ role: "user", content: "test" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
        providerBaseUrl: "http://127.0.0.1:9999",
      })
    );
    const configToml = events
      .filter((e) => e.type === EventType.MessageDelta)
      .map((e) => (e as any).content)
      .join("");
    expect(configToml).toContain("plugins = false");
  });

  it("disables codex native multi_agent/goals tools and pins request_user_input safe-degrade (AD-030)", async () => {
    const script = createScript(
      "mock-codex-native-tools-off.sh",
      `cat "$CODEX_HOME/config.toml"\necho '{"type":"turn.completed","usage":{}}'`
    );
    const events = await collectEvents(
      new CodexAdapter(script).run({
        conversationId: "codex-native-tools-off",
        messages: [{ role: "user", content: "test" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
        providerBaseUrl: "http://127.0.0.1:9999",
      })
    );
    const configToml = events
      .filter((e) => e.type === EventType.MessageDelta)
      .map((e) => (e as any).content)
      .join("");
    // multi_agent=false 去掉 spawn_agent/wait_agent/multi_agent_v1__*；goals=false 去掉 create_goal/get_goal/update_goal
    expect(configToml).toContain("multi_agent = false");
    expect(configToml).toContain("goals = false");
    // request_user_input 无法从列表移除（codex 写死），此 flag=false 钉住调用时安全报错（非 ServerRequest 挂起）
    expect(configToml).toContain("default_mode_request_user_input = false");
  });

  it("writes codexModelPrompt to model_instructions_file", async () => {
    const script = createScript(
      "mock-codex-model-prompt.sh",
      `cat "$CODEX_HOME/config.toml"
echo "---FILE---"
cat "$CODEX_HOME/model-instructions.md"
echo '{"type":"turn.completed","usage":{}}'`
    );

    const adapter = new CodexAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "codex-model-prompt",
        messages: [{ role: "user", content: "test" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
        modelInstructions: "You are Codex, a coding agent based on GPT-5.",
        providerBaseUrl: "http://127.0.0.1:9999",
      })
    );

    const output = events
      .filter((e) => e.type === EventType.MessageDelta)
      .map((e) => (e as any).content)
      .join("");
    expect(output).toContain("model_instructions_file =");
    expect(output).toContain("model-instructions.md");
    expect(output).toContain("You are Codex, a coding agent based on GPT-5.");
  });

  it("merges codex base + our systemPrompt into system#1 (ours last), no developer_instructions", async () => {
    const script = createScript(
      "mock-codex-prompt-order.sh",
      `cat "$CODEX_HOME/config.toml"
echo "---FILE---"
cat "$CODEX_HOME/model-instructions.md"
echo '{"type":"turn.completed","usage":{}}'`
    );

    const adapter = new CodexAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "codex-prompt-order",
        messages: [{ role: "user", content: "test" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
        systemPrompt: "Super agent prompt",
        modelInstructions: "Codex base instructions",
        providerBaseUrl: "http://127.0.0.1:9999",
      })
    );

    const output = events
      .filter((e) => e.type === EventType.MessageDelta)
      .map((e) => (e as any).content)
      .join("");
    // codex 操作规约 + 我们的系统提示词都进 model_instructions_file（system#1），无 developer_instructions。
    expect(output).toContain("model_instructions_file =");
    expect(output).not.toContain("developer_instructions");
    const codexIdx = output.indexOf("Codex base instructions");
    const oursIdx = output.indexOf("Super agent prompt");
    expect(codexIdx).toBeGreaterThan(-1);
    expect(oursIdx).toBeGreaterThan(-1);
    // 我们的提示词在 codex 操作规约之后，以在指令优先级上覆盖 codex 身份。
    expect(codexIdx).toBeLessThan(oursIdx);
  });

  it("sets OPENAI_API_KEY from model when no providerBaseUrl", async () => {
    const script = createScript(
      "mock-codex-apikey.sh",
      `echo "KEY:$OPENAI_API_KEY"
echo "BASE:$OPENAI_BASE_URL"
echo '{"type":"turn.completed","usage":{}}'`
    );

    const adapter = new CodexAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "codex-apikey",
        messages: [{ role: "user", content: "test" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
        model: { provider: "openai", model: "gpt-4", apiKey: "sk-test-key-123", baseUrl: "https://custom.api.com/v1" },
      })
    );

    const output = events
      .filter((e) => e.type === EventType.MessageDelta)
      .map((e) => (e as any).content)
      .join("");

    expect(output).toContain("KEY:sk-test-key-123");
    expect(output).toContain("BASE:https://custom.api.com/v1");
  });

  it("respects abort signal", async () => {
    const script = createScript(
      "mock-codex-abort.sh",
      `sleep 10
echo '{"type":"turn.completed","usage":{}}'`
    );

    const controller = new AbortController();
    const adapter = new CodexAdapter(script);

    setTimeout(() => controller.abort(), 100);

    const events = await collectEvents(
      adapter.run({
        conversationId: "codex-abort",
        messages: [{ role: "user", content: "test" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
        signal: controller.signal,
      })
    );

    const turnEnd = events.find((e) => e.type === EventType.TurnEnd);
    expect(turnEnd).toBeDefined();
    expect((turnEnd as any).stopReason).toBe("cancelled");
  });

  it("logs stderr via logger", async () => {
    const script = createScript(
      "mock-codex-stderr.sh",
      `echo "stderr output" >&2
echo '{"type":"turn.completed","usage":{}}'`
    );

    const logDir = mkdtempSync(join(tmpdir(), "codex-log-stderr-"));
    const adapter = new CodexAdapter(script, { logger: { logDir, level: "debug" } });
    const events = await collectEvents(
      adapter.run({
        conversationId: "codex-stderr",
        messages: [{ role: "user", content: "test" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );

    const turnEnd = events.find((e) => e.type === EventType.TurnEnd);
    expect(turnEnd).toBeDefined();

    const { closeAllLogStreams } = await import("@/util/logger.js");
    await closeAllLogStreams();
    const logContent = readFileSync(join(logDir, "runloop.log"), "utf-8");
    expect(logContent).toContain("stderr");
    rmSync(logDir, { recursive: true, force: true });
  });

  it("logs spawn command via logger", async () => {
    const script = createScript(
      "mock-codex-debug-spawn.sh",
      `echo '{"type":"turn.completed","usage":{}}'`
    );

    const logDir = mkdtempSync(join(tmpdir(), "codex-log-spawn-"));
    const adapter = new CodexAdapter(script, { logger: { logDir } });
    await collectEvents(
      adapter.run({
        conversationId: "codex-debug-spawn",
        messages: [{ role: "user", content: "test" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );

    const { closeAllLogStreams } = await import("@/util/logger.js");
    await closeAllLogStreams();
    const logContent = readFileSync(join(logDir, "runloop.log"), "utf-8");
    expect(logContent).toContain("spawn");
    rmSync(logDir, { recursive: true, force: true });
  });

  it("exercises item.completed fallback branches (no item / unhandled / fallbacks / plan / mcp variants)", async () => {
    // 一条覆盖多分支的脚本：每个 item.completed 触发 mapCodexEvent 里不同的 ?? 兜底/事件类型分支。
    const script = createScript(
      "mock-codex-branches.sh",
      `echo '{"type":"item.completed"}'
echo '{"type":"item.completed","item":{"type":"unknown_xyz","foo":"bar"}}'
echo '{"type":"item.completed","item":{"type":"tool_call"}}'
echo '{"type":"item.completed","item":{"type":"function_call","input":{"a":1}}}'
echo '{"type":"item.completed","item":{"type":"command_execution","exit_code":2,"output":"oops"}}'
echo '{"type":"item.completed","item":{"type":"tool_result","id":"x1","text":"viatext"}}'
echo '{"type":"item.completed","item":{"type":"function_call_output","call_id":"y1","output":"o"}}'
echo '{"type":"item.completed","item":{"type":"mcp_tool_call","name":"viaName","input":"badjson{","status":"failed"}}'
echo '{"type":"item.completed","item":{"type":"mcp_tool_call","args":{"z":9},"output":"out","status":"ok"}}'
echo '{"type":"item.completed","item":{"type":"update_plan","plan":[{"content":"step1","status":"in_progress","priority":"high"},{"step":"step2","status":"weird"}]}}'
echo '{"type":"item.streaming","item":{"type":"x"},"text":"fromdata"}'
echo '{"type":"item.streaming"}'
echo '{"type":"turn.completed","usage":{}}'`
    );

    const adapter = new CodexAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "codex-branches",
        messages: [{ role: "user", content: "test" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );

    // command_execution exit_code != 0 → toolresult isError true
    const execResult = events.find(
      (e) => e.type === EventType.ToolresultEnd && (e as any).result === "oops",
    );
    expect(execResult).toBeDefined();
    expect((execResult as any).isError).toBe(true);

    // tool_result via id + text fallbacks
    expect(
      events.some((e) => e.type === EventType.ToolresultEnd && (e as any).result === "viatext"),
    ).toBe(true);

    // mcp_tool_call with missing tool/name → "unknown"；name 提供 → "viaName"
    const starts = events.filter((e) => e.type === EventType.ToolcallStart) as Array<any>;
    expect(starts.some((e) => e.toolName === "viaName")).toBe(true);
    expect(starts.some((e) => e.toolName === "unknown")).toBe(true);

    // mcp_tool_call status "failed" → isError true；malformed string input → {raw}
    const failed = events.find(
      (e) => e.type === EventType.ToolresultEnd && (e as any).isError === true && (e as any).result === "",
    );
    expect(failed).toBeDefined();
    const rawArgsExec = events.find(
      (e) => e.type === EventType.ToolcallEnd && (e as any).args?.raw === "badjson{",
    );
    expect(rawArgsExec).toBeDefined();

    // plan.update 提取
    const plan = events.find((e) => e.type === EventType.PlanUpdate) as any;
    expect(plan).toBeDefined();
    expect(plan.entries[0]).toEqual({ content: "step1", status: "in_progress", priority: "high" });
    // 非法 status 归一为 pending；step 字段映射到 content
    expect(plan.entries[1]).toEqual({ content: "step2", status: "pending" });

    // item.streaming 用 data.text 兜底
    expect(
      events.some((e) => e.type === EventType.MessageDelta && (e as any).content === "fromdata"),
    ).toBe(true);

    expect(events.some((e) => e.type === EventType.TurnEnd)).toBe(true);
  });

  it("handles error/turn.failed fallbacks (Reconnecting suppressed, missing message defaults)", async () => {
    const script = createScript(
      "mock-codex-error-fallbacks.sh",
      `echo '{"type":"error","message":"Reconnecting to upstream"}'
echo '{"type":"error"}'
echo '{"type":"turn.failed"}'
echo '{"type":"turn.completed","usage":{}}'`
    );

    const adapter = new CodexAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "codex-error-fallbacks",
        messages: [{ role: "user", content: "test" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );

    const errors = events.filter((e) => e.type === EventType.RunError) as Array<any>;
    // Reconnecting 被静默跳过（L-024）：不应出现该消息
    expect(errors.some((e) => e.error.message.includes("Reconnecting"))).toBe(false);
    // error 无 message → "Unknown codex error"
    expect(errors.some((e) => e.error.code === "CODEX_ERROR" && e.error.message === "Unknown codex error")).toBe(true);
    // turn.failed 无 error → "Turn failed"
    expect(errors.some((e) => e.error.code === "CODEX_TURN_FAILED" && e.error.message === "Turn failed")).toBe(true);
  });

  it("translates non-streamed reasoning via item.summary fallback", async () => {
    const script = createScript(
      "mock-codex-reasoning-summary.sh",
      `echo '{"type":"item.completed","item":{"id":"r0","type":"reasoning","summary":"summarized thought"}}'
echo '{"type":"turn.completed","usage":{}}'`
    );
    const adapter = new CodexAdapter(script);
    const events = await collectEvents(
      adapter.run({
        conversationId: "codex-reasoning-summary",
        messages: [{ role: "user", content: "test" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );
    const reasoning = events
      .filter((e) => e.type === EventType.ReasoningDelta)
      .map((e) => (e as any).content)
      .join("");
    expect(reasoning).toContain("summarized thought");
  });

  it("cleans up onStreamDelta unsubscribe in finally block", async () => {
    const script = createScript(
      "mock-codex-stream-cleanup.sh",
      `sleep 0.1
echo '{"type":"turn.completed","usage":{}}'`
    );

    let unsubscribeCalled = false;
    let capturedListener: ((content: string) => void) | null = null;
    const adapter = new CodexAdapter(script);

    const gen = adapter.run({
      conversationId: "codex-stream-cleanup",
      messages: [{ role: "user", content: "test" }],
      config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      onStreamDelta: (listener) => {
        capturedListener = listener;
        // Invoke the listener to cover the callback path (line 74-76)
        setTimeout(() => listener("streamed text"), 50);
        return () => {
          unsubscribeCalled = true;
        };
      },
    });

    const events = await collectEvents(gen);

    const turnEnd = events.find((e) => e.type === EventType.TurnEnd);
    expect(turnEnd).toBeDefined();
    expect(unsubscribeCalled).toBe(true);

    // Verify the streamed text was emitted as message delta
    const deltas = events.filter((e) => e.type === EventType.MessageDelta);
    const hasStreamedText = deltas.some((e) => (e as any).content === "streamed text");
    expect(hasStreamedText).toBe(true);
  });
});
