import { describe, it, expect } from "vitest";
import { compressEvents } from "@/events/compress.js";
import { createEvent } from "@/events/factory.js";
import { EventType, type RunloopEvent } from "@/types/events.js";

function makeUserMessage(conversationId: string, content: string): RunloopEvent {
  return createEvent(EventType.UserMessage, conversationId, { content, role: "user" });
}

function makeMessageStart(conversationId: string): RunloopEvent {
  return createEvent(EventType.MessageStart, conversationId, { role: "assistant" });
}

function makeMessageDelta(conversationId: string, content: string): RunloopEvent {
  return createEvent(EventType.MessageDelta, conversationId, { content });
}

function makeMessageEnd(conversationId: string): RunloopEvent {
  return createEvent(EventType.MessageEnd, conversationId, {});
}

function makeToolCallStart(conversationId: string, toolName: string, toolCallId: string): RunloopEvent {
  return createEvent(EventType.ToolcallStart, conversationId, { toolName, toolCallId });
}

function makeToolCallResult(conversationId: string, toolCallId: string, result: unknown): RunloopEvent {
  return createEvent(EventType.ToolresultEnd, conversationId, { toolCallId, result });
}

describe("compressEvents", () => {
  it("returns empty array for empty input", () => {
    expect(compressEvents([])).toEqual([]);
  });

  it("converts a simple user-assistant turn", () => {
    const events: RunloopEvent[] = [
      makeUserMessage("s1", "hello"),
      makeMessageStart("s1"),
      makeMessageDelta("s1", "hi "),
      makeMessageDelta("s1", "there"),
      makeMessageEnd("s1"),
    ];

    const messages = compressEvents(events);
    expect(messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
  });

  it("handles multiple turns", () => {
    const events: RunloopEvent[] = [
      makeUserMessage("s1", "first"),
      makeMessageDelta("s1", "response 1"),
      makeUserMessage("s1", "second"),
      makeMessageDelta("s1", "response 2"),
    ];

    const messages = compressEvents(events);
    expect(messages).toHaveLength(4);
    expect(messages[0]).toEqual({ role: "user", content: "first" });
    expect(messages[1]).toEqual({ role: "assistant", content: "response 1" });
    expect(messages[2]).toEqual({ role: "user", content: "second" });
    expect(messages[3]).toEqual({ role: "assistant", content: "response 2" });
  });

  it("includes tool calls in output when enabled", () => {
    const events: RunloopEvent[] = [
      makeUserMessage("s1", "search for files"),
      makeToolCallStart("s1", "file_search", "tc-1"),
      makeToolCallResult("s1", "tc-1", "found 3 files"),
      makeMessageDelta("s1", "done"),
    ];

    const messages = compressEvents(events, { includeToolResults: true });
    const assistantMsg = messages.find((m) => m.role === "assistant");
    expect(assistantMsg?.content).toContain("[Tool: file_search]");
    expect(assistantMsg?.content).toContain("found 3 files");
  });

  it("client tool resume：客户端回传的 toolresult.end 折进 transcript（消费通道 2）", () => {
    // run-2 历史的真实形态：run-1 调了 client tool 并以 tool_pending 收尾（toolcall.start/end +
    // turn.end{tool_pending} + run.end），客户端执行后**直接追加 toolresult.end**（无新 user.message）。
    // compressEvents 必须把该 toolresult 折回同 turn 的工具调用——这是 client tool resume「零 execute-on-resume」
    // 续跑的依据（中间的 turn.end/run.end 不应打断折叠）。
    const events: RunloopEvent[] = [
      makeUserMessage("s1", "我在哪个城市"),
      makeToolCallStart("s1", "get_user_location", "ct-1"),
      createEvent(EventType.ToolcallEnd, "s1", { toolCallId: "ct-1", args: {} }),
      createEvent(EventType.TurnEnd, "s1", { stopReason: "tool_pending", turnIndex: 0 }),
      createEvent(EventType.RunEnd, "s1", { reason: "tool_pending" }),
      makeToolCallResult("s1", "ct-1", { city: "杭州" }), // 客户端执行后回传
    ];
    const messages = compressEvents(events, { includeToolResults: true });
    const assistantMsg = messages.find((m) => m.role === "assistant");
    expect(assistantMsg?.content).toContain("[Tool: get_user_location]");
    expect(assistantMsg?.content).toContain("杭州");
  });

  it("excludes tool calls when disabled", () => {
    const events: RunloopEvent[] = [
      makeUserMessage("s1", "search"),
      makeToolCallStart("s1", "file_search", "tc-1"),
      makeToolCallResult("s1", "tc-1", "found"),
      makeMessageDelta("s1", "done"),
    ];

    const messages = compressEvents(events, { includeToolResults: false });
    const assistantMsg = messages.find((m) => m.role === "assistant");
    expect(assistantMsg?.content).not.toContain("[Tool:");
  });

  it("summarizes early turns when exceeding preserveLastNTurns", () => {
    const events: RunloopEvent[] = [];
    for (let i = 0; i < 10; i++) {
      events.push(makeUserMessage("s1", `question ${i}`));
      events.push(makeMessageDelta("s1", `answer ${i}`));
    }

    const messages = compressEvents(events, { preserveLastNTurns: 3 });

    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("[Earlier conversation summary]");
    expect(messages[0].content).toContain("Turn 1");

    const userMessages = messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(3);
  });

  it("does not summarize when turns <= preserveLastNTurns", () => {
    const events: RunloopEvent[] = [
      makeUserMessage("s1", "one"),
      makeMessageDelta("s1", "1"),
      makeUserMessage("s1", "two"),
      makeMessageDelta("s1", "2"),
    ];

    const messages = compressEvents(events, { preserveLastNTurns: 5 });
    expect(messages.every((m) => m.role !== "system")).toBe(true);
  });

  it("respects maxMessages limit", () => {
    const events: RunloopEvent[] = [];
    for (let i = 0; i < 20; i++) {
      events.push(makeUserMessage("s1", `q${i}`));
      events.push(makeMessageDelta("s1", `a${i}`));
    }

    const messages = compressEvents(events, {
      maxMessages: 5,
      preserveLastNTurns: 10,
    });
    expect(messages.length).toBeLessThanOrEqual(5);
  });

  it("handles user-only events", () => {
    const events: RunloopEvent[] = [makeUserMessage("s1", "hello")];
    const messages = compressEvents(events);
    expect(messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("truncates long user messages in summary", () => {
    const longMsg = "a".repeat(200);
    const events: RunloopEvent[] = [];
    for (let i = 0; i < 8; i++) {
      events.push(makeUserMessage("s1", i === 0 ? longMsg : `q${i}`));
      events.push(makeMessageDelta("s1", `a${i}`));
    }

    const messages = compressEvents(events, { preserveLastNTurns: 2 });
    const summary = messages[0].content;
    expect(summary).toContain("...");
  });

  // 回归：client tool（如 super_agent_confirm）跨 run resume —— 历史以 toolresult.end 收尾时，
  // 旧实现把结果折进「过去的 assistant 轮」、整段以 assistant 自述收尾，没有"工具已返回、请继续"的
  // 新输入信号，导致 codex+qwen 从原始请求重新决策、重复调用同一 client tool（无限确认循环，
  // 预发 70cdd43d 实证）。修复：continuationHint 开启时，于续跑点追加一条延续提示消息。
  describe("continuationHint（client-tool resume 续跑信号）", () => {
    it("历史以工具结果收尾时追加延续提示（不以 assistant 自述收尾）", () => {
      const events: RunloopEvent[] = [
        makeUserMessage("s1", "删除数据库"),
        makeMessageStart("s1"),
        makeMessageDelta("s1", "这是高风险操作，我需要先确认你的意图。"),
        makeMessageEnd("s1"),
        makeToolCallStart("s1", "super_agent_confirm", "ct-1"),
        makeToolCallResult("s1", "ct-1", '{"action":"confirm"}'),
      ];
      const messages = compressEvents(events, { continuationHint: true });
      const last = messages[messages.length - 1];
      expect(last.role).toBe("user");
      expect(last.content).toContain("super_agent_confirm");
      expect(last.content).toContain("confirm");
      expect(last.content).toMatch(/继续|不要重复/);
    });

    it("正常以 assistant 文本收尾时不追加延续提示", () => {
      const events: RunloopEvent[] = [
        makeUserMessage("s1", "search"),
        makeToolCallStart("s1", "file_search", "tc-1"),
        makeToolCallResult("s1", "tc-1", "found 3"),
        makeMessageDelta("s1", "done"),
      ];
      const messages = compressEvents(events, { continuationHint: true });
      expect(messages[messages.length - 1].role).toBe("assistant");
    });

    it("默认不开 continuationHint（向后兼容，不追加提示）", () => {
      const events: RunloopEvent[] = [
        makeUserMessage("s1", "x"),
        makeToolCallStart("s1", "t", "tc-1"),
        makeToolCallResult("s1", "tc-1", "r"),
      ];
      const messages = compressEvents(events);
      expect(messages[messages.length - 1].role).toBe("assistant");
    });

    it("空历史 + continuationHint 不报错、不追加", () => {
      expect(compressEvents([], { continuationHint: true })).toEqual([]);
    });

    it("最后一轮仅有工具调用、无结果/无文本时不追加延续提示", () => {
      const events: RunloopEvent[] = [
        makeUserMessage("s1", "x"),
        makeToolCallStart("s1", "t", "tc-1"),
      ];
      const messages = compressEvents(events, { continuationHint: true });
      expect(messages.every((m) => !m.content.includes("继续执行后续步骤"))).toBe(true);
    });

    it("孤儿 toolresult（无对应 toolcall.start）延续提示用 toolCallId 兜底", () => {
      const events: RunloopEvent[] = [
        makeUserMessage("s1", "x"),
        makeToolCallResult("s1", "orphan-tc", "ok"),
      ];
      const messages = compressEvents(events, { continuationHint: true });
      const last = messages[messages.length - 1];
      expect(last.role).toBe("user");
      expect(last.content).toContain("orphan-tc");
    });
  });
});
