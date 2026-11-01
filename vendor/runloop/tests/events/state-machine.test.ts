import { describe, it, expect } from "vitest";
import { EventStateMachine } from "@/events/state-machine.js";
import { EventType } from "@/types/events.js";

function types(events: Array<{ type: string }>): string[] {
  return events.map((e) => e.type);
}

describe("EventStateMachine", () => {
  describe("textDelta", () => {
    it("emits message.start + message.delta from IDLE", () => {
      const sm = new EventStateMachine("s1");
      const events = sm.textDelta("hello");
      expect(types(events)).toEqual([EventType.MessageStart, EventType.MessageDelta]);
      expect(sm.currentState).toBe("MESSAGE_OPEN");
    });

    it("emits only message.delta when MESSAGE_OPEN", () => {
      const sm = new EventStateMachine("s1");
      sm.textDelta("first");
      const events = sm.textDelta("second");
      expect(types(events)).toEqual([EventType.MessageDelta]);
      expect((events[0] as any).content).toBe("second");
    });
  });

  describe("textComplete", () => {
    it("emits start + delta + end from IDLE", () => {
      const sm = new EventStateMachine("s1");
      const events = sm.textComplete("full text");
      expect(types(events)).toEqual([
        EventType.MessageStart,
        EventType.MessageDelta,
        EventType.MessageEnd,
      ]);
      expect(sm.currentState).toBe("IDLE");
    });

    it("closes existing message first from MESSAGE_OPEN", () => {
      const sm = new EventStateMachine("s1");
      sm.textDelta("partial");
      const events = sm.textComplete("full text");
      expect(types(events)).toEqual([
        EventType.MessageEnd,
        EventType.MessageStart,
        EventType.MessageDelta,
        EventType.MessageEnd,
      ]);
      expect(sm.currentState).toBe("IDLE");
    });
  });

  describe("toolCallStart", () => {
    it("emits toolcall.start from IDLE", () => {
      const sm = new EventStateMachine("s1");
      const events = sm.toolCallStart("tc-1", "exec_command");
      expect(types(events)).toEqual([EventType.ToolcallStart]);
      expect(sm.currentState).toBe("TOOL_ACTIVE");
    });

    it("auto-closes message before toolcall from MESSAGE_OPEN", () => {
      const sm = new EventStateMachine("s1");
      sm.textDelta("thinking...");
      const events = sm.toolCallStart("tc-1", "exec_command");
      expect(types(events)).toEqual([EventType.MessageEnd, EventType.ToolcallStart]);
      expect(sm.currentState).toBe("TOOL_ACTIVE");
    });
  });

  describe("tool lifecycle", () => {
    it("toolCallResult transitions to IDLE", () => {
      const sm = new EventStateMachine("s1");
      sm.toolCallStart("tc-1", "read_file");
      const events = sm.toolCallResult("tc-1", "file contents");
      expect(types(events)).toEqual([EventType.ToolresultEnd]);
      expect(sm.currentState).toBe("IDLE");
    });

    it("toolCallError transitions to IDLE (merged into toolresult.end isError)", () => {
      const sm = new EventStateMachine("s1");
      sm.toolCallStart("tc-1", "read_file");
      const events = sm.toolCallError("tc-1", { code: "NOT_FOUND", message: "file not found" });
      expect(types(events)).toEqual([EventType.ToolresultEnd]);
      expect((events[0] as any).isError).toBe(true);
      expect((events[0] as any).result).toEqual({ code: "NOT_FOUND", message: "file not found" });
      expect(sm.currentState).toBe("IDLE");
    });

    it("toolCallExecuting emits without state change", () => {
      const sm = new EventStateMachine("s1");
      sm.toolCallStart("tc-1", "exec_command");
      const events = sm.toolCallExecuting("tc-1", { cmd: "ls" });
      expect(types(events)).toEqual([EventType.ToolcallEnd]);
      expect(sm.currentState).toBe("TOOL_ACTIVE");
    });

    it("toolCallOutputDelta emits without state change", () => {
      const sm = new EventStateMachine("s1");
      sm.toolCallStart("tc-1", "delegate");
      const events = sm.toolCallOutputDelta("tc-1", "hello");
      expect(types(events)).toEqual([EventType.ToolresultDelta]);
      expect((events[0] as any).delta).toBe("hello");
      expect(sm.currentState).toBe("TOOL_ACTIVE");
    });

    it("toolCallArgs emits without state change", () => {
      const sm = new EventStateMachine("s1");
      sm.toolCallStart("tc-1", "exec_command");
      const events = sm.toolCallArgs("tc-1", '{"cmd":');
      expect(types(events)).toEqual([EventType.ToolcallDelta]);
    });
  });

  describe("flush", () => {
    it("returns empty from IDLE", () => {
      const sm = new EventStateMachine("s1");
      expect(sm.flush()).toEqual([]);
    });

    it("closes open message from MESSAGE_OPEN", () => {
      const sm = new EventStateMachine("s1");
      sm.textDelta("partial");
      const events = sm.flush();
      expect(types(events)).toEqual([EventType.MessageEnd]);
      expect(sm.currentState).toBe("IDLE");
    });

    it("returns empty from TOOL_ACTIVE", () => {
      const sm = new EventStateMachine("s1");
      sm.toolCallStart("tc-1", "exec_command");
      expect(sm.flush()).toEqual([]);
      expect(sm.currentState).toBe("TOOL_ACTIVE");
    });
  });

  describe("usage", () => {
    it("passes through as stateless event", () => {
      const sm = new EventStateMachine("s1");
      const events = sm.usage({ inputTokens: 100, outputTokens: 10 });
      expect(types(events)).toEqual([EventType.RunUsage]);
    });
  });

  describe("full sequences", () => {
    it("text → tool → text → tool → flush", () => {
      const sm = new EventStateMachine("s1");
      const all: string[] = [];

      all.push(...types(sm.textDelta("hello ")));
      all.push(...types(sm.textDelta("world")));
      all.push(...types(sm.toolCallStart("tc-1", "exec_command")));
      all.push(...types(sm.toolCallExecuting("tc-1", { cmd: "ls" })));
      all.push(...types(sm.toolCallResult("tc-1", "files")));
      all.push(...types(sm.textDelta("based on results")));
      all.push(...types(sm.textDelta(", here is")));
      all.push(...types(sm.toolCallStart("tc-2", "read_file")));
      all.push(...types(sm.toolCallResult("tc-2", "content")));
      all.push(...types(sm.textDelta("final answer")));
      all.push(...types(sm.flush()));

      expect(all).toEqual([
        // text segment 1
        EventType.MessageStart,
        EventType.MessageDelta,   // "hello "
        EventType.MessageDelta,   // "world"
        // tool 1 (auto-close message)
        EventType.MessageEnd,
        EventType.ToolcallStart,
        EventType.ToolcallEnd,
        EventType.ToolresultEnd,
        // text segment 2
        EventType.MessageStart,
        EventType.MessageDelta,   // "based on results"
        EventType.MessageDelta,   // ", here is"
        // tool 2 (auto-close message)
        EventType.MessageEnd,
        EventType.ToolcallStart,
        EventType.ToolresultEnd,
        // text segment 3
        EventType.MessageStart,
        EventType.MessageDelta,   // "final answer"
        // flush (close trailing message)
        EventType.MessageEnd,
      ]);
    });

    it("codex scenario: proxy streaming → item.completed tool_call → streaming → flush", () => {
      const sm = new EventStateMachine("s1");
      const all: string[] = [];

      // proxy delta streaming
      all.push(...types(sm.textDelta("让我")));
      all.push(...types(sm.textDelta("检查一下")));
      // codex switches to tool call (item.completed type=tool_call)
      all.push(...types(sm.toolCallStart("tc-1", "exec_command")));
      all.push(...types(sm.toolCallExecuting("tc-1", { cmd: ".tools/agentrun call delegate" })));
      all.push(...types(sm.toolCallResult("tc-1", '{"type":"delegation_request"}')));
      // codex produces text again
      all.push(...types(sm.textDelta("子 Agent 返回了")));
      // another tool call
      all.push(...types(sm.toolCallStart("tc-2", "exec_command")));
      all.push(...types(sm.toolCallResult("tc-2", '{"type":"delegation_request"}')));
      // final text
      all.push(...types(sm.textDelta("请确认")));
      all.push(...types(sm.flush()));

      // Verify message.start/end are strictly paired
      let openCount = 0;
      for (const t of all) {
        if (t === EventType.MessageStart) openCount++;
        if (t === EventType.MessageEnd) openCount--;
        expect(openCount).toBeGreaterThanOrEqual(0);
        expect(openCount).toBeLessThanOrEqual(1);
      }
      expect(openCount).toBe(0);
    });
  });

  describe("reasoning（与 message 对称、互斥）", () => {
    it("reasoningDelta 从 IDLE → reasoning.start + reasoning.delta", () => {
      const sm = new EventStateMachine("s1");
      expect(types(sm.reasoningDelta("想..."))).toEqual([EventType.ReasoningStart, EventType.ReasoningDelta]);
      expect(sm.currentState).toBe("REASONING_OPEN");
      expect(types(sm.reasoningDelta("再想"))).toEqual([EventType.ReasoningDelta]);
    });

    it("reasoningDelta 时若 message open → 先关 message", () => {
      const sm = new EventStateMachine("s1");
      sm.textDelta("hi");
      expect(types(sm.reasoningDelta("think"))).toEqual([EventType.MessageEnd, EventType.ReasoningStart, EventType.ReasoningDelta]);
    });

    it("textDelta 时若 reasoning open → 先关 reasoning（不泄进 message）", () => {
      const sm = new EventStateMachine("s1");
      sm.reasoningDelta("think");
      expect(types(sm.textDelta("answer"))).toEqual([EventType.ReasoningEnd, EventType.MessageStart, EventType.MessageDelta]);
    });

    it("reasoningComplete → start+delta+end 一气呵成（先关开着的文本流）", () => {
      const sm = new EventStateMachine("s1");
      sm.textDelta("hi");
      expect(types(sm.reasoningComplete("done"))).toEqual([
        EventType.MessageEnd, EventType.ReasoningStart, EventType.ReasoningDelta, EventType.ReasoningEnd,
      ]);
      expect(sm.currentState).toBe("IDLE");
    });

    it("toolCallStart / flush 关掉打开的 reasoning", () => {
      const sm1 = new EventStateMachine("s1");
      sm1.reasoningDelta("t");
      expect(types(sm1.toolCallStart("tc-1", "x"))).toEqual([EventType.ReasoningEnd, EventType.ToolcallStart]);

      const sm2 = new EventStateMachine("s1");
      sm2.reasoningDelta("t");
      expect(types(sm2.flush())).toEqual([EventType.ReasoningEnd]);
    });

    it("reasoning.start/end 严格成对", () => {
      const sm = new EventStateMachine("s1");
      const all = [
        ...sm.reasoningDelta("a"), ...sm.reasoningDelta("b"),
        ...sm.textDelta("ans"),            // 关 reasoning、开 message
        ...sm.reasoningComplete("more"),   // 关 message、一次性 reasoning
        ...sm.toolCallStart("tc", "x"),
        ...sm.flush(),
      ].map((e) => e.type);
      let open = 0;
      for (const t of all) {
        if (t === EventType.ReasoningStart) open++;
        if (t === EventType.ReasoningEnd) open--;
        expect(open).toBeGreaterThanOrEqual(0);
        expect(open).toBeLessThanOrEqual(1);
      }
      expect(open).toBe(0);
    });
  });
});
