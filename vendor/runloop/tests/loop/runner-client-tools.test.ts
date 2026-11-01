import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LoopRunner } from "@/loop/runner.js";
import { EventType, type RunloopEvent } from "@/types/events.js";
import { createEvent } from "@/events/factory.js";
import type { AgentAdapter, AgentRunParams } from "@/acp/adapter.js";
import type { RunRequest } from "@/types/api.js";

async function collect(gen: AsyncGenerator<RunloopEvent>): Promise<RunloopEvent[]> {
  const out: RunloopEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

function baseReq(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    agent: { cli: "echo" },
    events: [{ type: "user.message", content: "我在哪个城市" } as never],
    model: { provider: "test", model: "m", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" },
    credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
    clientTools: [{ name: "get_user_location", description: "返回用户城市", parameters: { type: "object", properties: {} } }],
    ...overrides,
  };
}

/**
 * Mock adapter：模拟「模型调用客户端工具」——读 config.mcpConfig 的 agentrun-mcp url，用真实 MCP client
 * 发 tools/call 调 get_user_location（触发 onToolPending → 置 toolPending + abort），随后 yield 一个事件让
 * runner 的 in-loop abort 屏障命中 tool_pending 分支。覆盖 runner 的 client-tool 注入 + 暂停屏障全链路。
 */
function makeClientToolAdapter(toolName: string): AgentAdapter {
  return {
    async *run(params: AgentRunParams): AsyncGenerator<RunloopEvent> {
      const url = (params.config as { mcpConfig?: { mcpServers?: Record<string, { url?: string }> } }).mcpConfig?.mcpServers?.agentcore?.url;
      if (!url) throw new Error("agentrun mcp url missing — client tool 未注入");
      const client = new Client({ name: "test-cli", version: "0.0.1" });
      const transport = new StreamableHTTPClientTransport(new URL(url));
      await client.connect(transport);
      await client.callTool({ name: toolName, arguments: {} }); // → onToolPending → abort
      await client.close();
      // abort 已发生；yield 一个事件让 runner 的 in-loop 屏障检查命中 tool_pending。
      yield createEvent(EventType.MessageStart, params.conversationId, { role: "assistant" });
    },
  };
}

describe("LoopRunner — client tools（tool_pending 屏障）", () => {
  it("模型调客户端工具 → run.end{tool_pending}，emit toolcall.start，本轮无 toolresult", async () => {
    const runner = new LoopRunner({ allowUnregisteredAgents: true, defaultAdapterType: "cli" });
    // 注入 mock adapter（createAdapter 私有，运行时替换）。
    // codex 调用模型侧暴露名（client__ 前缀）；MCP server 外发事件还原成声明名 get_user_location。
    (runner as unknown as { createAdapter: () => AgentAdapter }).createAdapter = () =>
      makeClientToolAdapter("client__get_user_location");

    const events = await collect(runner.run(baseReq()));

    const end = events[events.length - 1] as RunloopEvent & { reason?: string };
    expect(end.type).toBe(EventType.RunEnd);
    expect(end.reason).toBe("tool_pending");
    // MCP server 发了权威 toolcall.start（净化名）
    const start = events.find((e) => e.type === EventType.ToolcallStart && (e as { toolName?: string }).toolName === "get_user_location");
    expect(start, "应 emit get_user_location 的 toolcall.start").toBeDefined();
    expect((start as { toolCallId?: string }).toolCallId).toMatch(/^ct-/);
    // 本轮不产 toolresult（结果由客户端下次 run 回传）
    expect(events.some((e) => e.type === EventType.ToolresultEnd)).toBe(false);
    // turn.end{tool_pending} 也应出现
    const turnEnd = events.find((e) => e.type === EventType.TurnEnd) as RunloopEvent & { stopReason?: string };
    expect(turnEnd?.stopReason).toBe("tool_pending");
  });

  it("声明 clientTools 但模型未调用 → 正常完成（MCP server 仍起、不影响）", async () => {
    const runner = new LoopRunner({ allowUnregisteredAgents: true, defaultAdapterType: "cli" });
    // adapter 不调任何工具，直接产一条消息并结束。
    (runner as unknown as { createAdapter: () => AgentAdapter }).createAdapter = () => ({
      async *run(params: AgentRunParams): AsyncGenerator<RunloopEvent> {
        yield createEvent(EventType.MessageStart, params.conversationId, { role: "assistant" });
        yield createEvent(EventType.MessageDelta, params.conversationId, { content: "你好" });
        yield createEvent(EventType.MessageEnd, params.conversationId, {});
      },
    });
    const events = await collect(runner.run(baseReq()));
    const end = events[events.length - 1] as RunloopEvent & { reason?: string };
    expect(end.reason).toBe("completed");
  });
});
