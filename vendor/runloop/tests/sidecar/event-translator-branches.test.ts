import { describe, it, expect } from "vitest";
import { translateChildEvent } from "@/sidecar/event-translator.js";

const OPTS = { conversationId: "root", parentToolCallId: "d-1" };

describe("translateChildEvent — branch coverage", () => {
  it("runloop: skips run lifecycle + run.usage", () => {
    for (const t of ["run.start", "run.end", "run.interrupt", "run.error", "run.usage"]) {
      expect(translateChildEvent({ type: t, conversationId: "c", id: "x", timestamp: 1 }, "runloop", OPTS)).toEqual([]);
    }
  });

  it("runloop: empty type → []", () => {
    expect(translateChildEvent({ conversationId: "c" }, "runloop", OPTS)).toEqual([]);
  });

  it("ag-ui: unknown type → [] (default branch)", () => {
    expect(translateChildEvent({ type: "SOMETHING_WEIRD" }, "ag-ui", OPTS)).toEqual([]);
    expect(translateChildEvent({}, "ag-ui", OPTS)).toEqual([]);
  });

  it("ag-ui: lifecycle events suppressed", () => {
    expect(translateChildEvent({ type: "RUN_STARTED" }, "ag-ui", OPTS)).toEqual([]);
    expect(translateChildEvent({ type: "run_finished" }, "ag-ui", OPTS)).toEqual([]);
  });

  it("ag-ui: text + tool events translate with parentToolCallId", () => {
    const start = translateChildEvent({ type: "TEXT_MESSAGE_START" }, "ag-ui", OPTS);
    expect(start[0].type).toBe("message.start");
    expect((start[0] as { parentToolCallId?: string }).parentToolCallId).toBe("d-1");

    const args = translateChildEvent({ type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: "{}" }, "ag-ui", OPTS);
    expect(args[0].type).toBe("toolcall.delta");
    expect((args[0] as { chunk?: string }).chunk).toBe("{}");

    const end = translateChildEvent({ type: "TOOL_CALL_END", toolCallId: "t1", result: "ok" }, "ag-ui", OPTS);
    expect(end[0].type).toBe("toolresult.end");
  });

  it("chat-completions: content delta + finish stop + empty choices", () => {
    const delta = translateChildEvent({ choices: [{ delta: { content: "hi" } }] }, "chat-completions", OPTS);
    expect(delta[0].type).toBe("message.delta");

    const fin = translateChildEvent({ choices: [{ delta: {}, finish_reason: "stop" }] }, "chat-completions", OPTS);
    expect(fin[0].type).toBe("message.end");

    expect(translateChildEvent({ choices: [] }, "chat-completions", OPTS)).toEqual([]);
    expect(translateChildEvent({}, "chat-completions", OPTS)).toEqual([]);
  });

  it("unknown protocol → []", () => {
    expect(translateChildEvent({ type: "x" }, "bogus" as never, OPTS)).toEqual([]);
  });

  it("ag-ui: 字段缺省/snake_case 变体 → 各 ?? 默认分支", () => {
    // TEXT_MESSAGE_CONTENT 无 delta → "" ；TEXT_MESSAGE_END → message.end
    expect((translateChildEvent({ type: "TEXT_MESSAGE_CONTENT" }, "ag-ui", OPTS)[0] as { content?: string }).content).toBe("");
    expect(translateChildEvent({ type: "TEXT_MESSAGE_END" }, "ag-ui", OPTS)[0].type).toBe("message.end");
    // TOOL_CALL_START：snake_case tool_call_id/name 命中；以及全缺 → ""
    const s1 = translateChildEvent({ type: "TOOL_CALL_START", tool_call_id: "t9", name: "fn" }, "ag-ui", OPTS)[0] as { toolCallId?: string; toolName?: string };
    expect(s1).toMatchObject({ toolCallId: "t9", toolName: "fn" });
    const s2 = translateChildEvent({ type: "TOOL_CALL_START" }, "ag-ui", OPTS)[0] as { toolCallId?: string; toolName?: string };
    expect(s2).toMatchObject({ toolCallId: "", toolName: "" });
    // TOOL_CALL_ARGS snake_case + 无 delta；TOOL_CALL_END snake_case + 无 result
    expect((translateChildEvent({ type: "TOOL_CALL_ARGS", tool_call_id: "t9" }, "ag-ui", OPTS)[0] as { chunk?: string }).chunk).toBe("");
    expect((translateChildEvent({ type: "TOOL_CALL_END", tool_call_id: "t9" }, "ag-ui", OPTS)[0] as { result?: string }).result).toBe("");
    // REASONING_MESSAGE_CONTENT 无 delta → ""
    expect((translateChildEvent({ type: "REASONING_MESSAGE_CONTENT" }, "ag-ui", OPTS)[0] as { content?: string }).content).toBe("");
  });

  it("ag-ui CUSTOM：hitl 带 value.prompt（透 prompt）；无 name（179 ?? \"\"）→ 非 hitl", () => {
    const withPrompt = translateChildEvent({ type: "CUSTOM", name: "runloop.hitl_request", value: { prompt: "确认？" } }, "ag-ui", OPTS);
    expect(withPrompt[0].type).toBe("toolcall.suspend");
    expect((withPrompt[0] as { prompt?: string }).prompt).toBe("确认？");
    // 无 name → name "" → 非 hitl 分支（不产 suspend）
    const noName = translateChildEvent({ type: "CUSTOM" }, "ag-ui", OPTS);
    expect(noName.every((e) => e.type !== "toolcall.suspend")).toBe(true);
  });

  it("ag-ui INTERRUPT/CUSTOM HITL with no value → default toolName + default options", () => {
    const intr = translateChildEvent({ type: "INTERRUPT" }, "ag-ui", OPTS);
    expect(intr[0].type).toBe("toolcall.suspend");
    expect((intr[0] as { toolName?: string; options?: unknown[] }).toolName).toBe("interrupt");
    expect((intr[0] as { options?: unknown[] }).options).toHaveLength(2);

    const cust = translateChildEvent({ type: "CUSTOM", name: "x.interrupt" }, "ag-ui", OPTS);
    expect(cust[0].type).toBe("toolcall.suspend");
    expect((cust[0] as { options?: unknown[] }).options).toHaveLength(2);
  });
});
