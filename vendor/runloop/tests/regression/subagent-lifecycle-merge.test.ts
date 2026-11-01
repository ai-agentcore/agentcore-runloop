import { describe, it, expect } from "vitest";
import { MergeNormalizer } from "@/events/merge-normalizer.js";
import { createEvent } from "@/events/factory.js";
import { EventType, type RunloopEvent } from "@/types/events.js";

/**
 * 回归守护：子 agent 委派的根本修复（委派层拥有生命周期 + 合并点归一化）。
 *
 * 背景：sidecar 在 adapter 的 message 仍打开时注入 toolcall.start（委派执行期间），
 * 两条流互不知道对方的 message 状态。MergeNormalizer 在合并点强制满足协议不变量：
 * toolcall.start 之前 message 必须关闭。
 *
 * 守护对象：tests/e2e/events/event-sequence.test.ts 的 assertEventSequence 不变量，
 * 在跨流（adapter + sidecar）合并时仍然成立。
 */
describe("regression: sub-agent lifecycle merge normalization", () => {
  const sid = "sess-1";
  const N = () => new MergeNormalizer(sid);
  const flat = (norm: MergeNormalizer, events: RunloopEvent[]): RunloopEvent[] =>
    events.flatMap((e) => norm.normalize(e));

  it("injects message.end before a toolcall.start that arrives while a message is open", () => {
    const norm = N();
    const out = flat(norm, [
      createEvent(EventType.MessageStart, sid, { role: "assistant" }),
      createEvent(EventType.MessageDelta, sid, { content: "calling sub-agent..." }),
      // sidecar 在 message 仍打开时注入委派 start
      createEvent(EventType.ToolcallStart, sid, { toolCallId: "delegate-1", toolName: "delegate_to_x" }),
      createEvent(EventType.ToolresultDelta, sid, { toolCallId: "delegate-1", delta: "hi" }),
      createEvent(EventType.ToolresultEnd, sid, { toolCallId: "delegate-1", result: "done", isError: false }),
    ]);

    const types = out.map((e) => e.type);
    // start 之前必须先出现 message.end
    const startIdx = types.indexOf(EventType.ToolcallStart);
    expect(types[startIdx - 1]).toBe(EventType.MessageEnd);
    assertInvariant(out);
  });

  it("does not double-close when the adapter already closed the message", () => {
    const norm = N();
    const out = flat(norm, [
      createEvent(EventType.MessageStart, sid, { role: "assistant" }),
      createEvent(EventType.MessageDelta, sid, { content: "text" }),
      createEvent(EventType.MessageEnd, sid, {}), // adapter 自己关了
      createEvent(EventType.ToolcallStart, sid, { toolCallId: "t1", toolName: "exec" }),
    ]);
    // 只有一条 message.end，没有补多余的
    expect(out.filter((e) => e.type === EventType.MessageEnd)).toHaveLength(1);
    assertInvariant(out);
  });

  it("drops a stray message.end that races in after the message was already closed", () => {
    const norm = N();
    const out = flat(norm, [
      createEvent(EventType.MessageStart, sid, { role: "assistant" }),
      createEvent(EventType.ToolcallStart, sid, { toolCallId: "t1", toolName: "x" }), // 触发补 end
      createEvent(EventType.ToolresultEnd, sid, { toolCallId: "t1", result: "r" }),
      createEvent(EventType.MessageEnd, sid, {}), // adapter 迟到的真实 end —— 应被丢弃
    ]);
    // 全程恰好一条 message.end（归一化器补的那条），迟到的被丢弃
    expect(out.filter((e) => e.type === EventType.MessageEnd)).toHaveLength(1);
    assertInvariant(out);
  });

  it("synthesizes message.start for orphan delta after a delegation (C1 prod regression)", () => {
    // 复刻线上 e2e-59a035d0 序列：文本 → 委派（sidecar 注入生命周期）→ 委派后文本经 proxy
    // 以裸 message.delta 发出（adapter 的 sm 因 exec 卡片被抑制而停在 MESSAGE_OPEN）→ 末尾真实
    // message.end。归一化器必须为孤儿 delta 补 message.start，并让真实 end 正确收尾。
    const norm = N();
    const out = flat(norm, [
      createEvent(EventType.MessageStart, sid, { role: "assistant" }),
      createEvent(EventType.MessageDelta, sid, { content: "现在调用子 agent" }),
      // sidecar 注入委派生命周期（message 仍打开 → 触发补 end）
      createEvent(EventType.ToolcallStart, sid, { toolCallId: "delegate-1", toolName: "delegate_to_x" }),
      createEvent(EventType.ToolcallEnd, sid, { toolCallId: "delegate-1", args: { task: "t" } }),
      createEvent(EventType.ToolresultDelta, sid, { toolCallId: "delegate-1", delta: "stream" }),
      createEvent(EventType.ToolresultEnd, sid, { toolCallId: "delegate-1", result: "r" }),
      // 委派后裸 delta（无 message.start）
      createEvent(EventType.MessageDelta, sid, { content: "报告：" }),
      createEvent(EventType.MessageDelta, sid, { content: "..." }),
      // adapter 末尾 flush 的真实 message.end
      createEvent(EventType.MessageEnd, sid, {}),
    ]);
    // 不变量必须成立：无孤儿 delta、无未闭合 message
    assertInvariant(out);
    // 委派后那段文本被正确包成一个完整 message
    const types = out.map((e) => e.type);
    const lastToolResult = types.lastIndexOf(EventType.ToolresultEnd);
    const tail = types.slice(lastToolResult + 1);
    expect(tail).toEqual([
      EventType.MessageStart, // 归一化器补的
      EventType.MessageDelta,
      EventType.MessageDelta,
      EventType.MessageEnd,   // 真实 end，正确收尾（不被丢弃）
    ]);
  });

  it("auto-closes an open message when a new message.start arrives (cross-stream race, #2 prod regression)", () => {
    // execViaMcp 默认开后委派暴露：adapter 父 message 仍打开时，sidecar 注入的嵌套 child message.start
    // 到达合并点（两条流互不知道对方 message 状态）。归一化器必须先补 message.end 关掉上一条，
    // 否则裸双 message.start → 上游 `message.start while already open` 不变量崩（线上 execViaMcp=true 同样命中）。
    const norm = N();
    const out = flat(norm, [
      createEvent(EventType.MessageStart, sid, { role: "assistant" }), // 流A 打开
      createEvent(EventType.MessageDelta, sid, { content: "parent" }),
      createEvent(EventType.MessageStart, sid, { role: "assistant" }), // 流B 在流A 未关时又 start
      createEvent(EventType.MessageDelta, sid, { content: "child" }),
      createEvent(EventType.MessageEnd, sid, {}),
    ]);
    assertInvariant(out);
    expect(out.map((e) => e.type)).toEqual([
      EventType.MessageStart,
      EventType.MessageDelta,
      EventType.MessageEnd, // 归一化器在第二个 start 前补的
      EventType.MessageStart,
      EventType.MessageDelta,
      EventType.MessageEnd,
    ]);
  });

  it("flush() closes an open message before run.end (L10): orphan child message at stream end", () => {
    // 子 agent（ag-ui 仅 TEXT_MESSAGE_END 才发 MessageEnd / chat-completions 仅 stop 才关）漏发
    // message-end，孤儿 child message 一路开到 run 结束。runner 在 emitEnd 前调 flush 补 message.end，
    // 否则流末未闭合 message 触发自身契约（assertInvariant 的 "ended with unclosed message"）。
    const norm = N();
    const out = flat(norm, [
      createEvent(EventType.MessageStart, sid, { role: "assistant" }),
      createEvent(EventType.MessageDelta, sid, { content: "child text, no end" }),
      // 子 agent 漏发 message.end，流到此结束
    ]);
    expect(norm.isMessageOpen).toBe(true);
    const flushed = norm.flush();
    expect(flushed.map((e) => e.type)).toEqual([EventType.MessageEnd]);
    expect(norm.isMessageOpen).toBe(false);
    // flush 后整条流（含补出的 end）满足不变量
    assertInvariant([...out, ...flushed]);
    // 幂等：已闭合再 flush 不再补
    expect(norm.flush()).toEqual([]);
  });

  it("passes a normal message→tool→message flow through unchanged", () => {
    const norm = N();
    const input = [
      createEvent(EventType.MessageStart, sid, { role: "assistant" }),
      createEvent(EventType.MessageDelta, sid, { content: "a" }),
      createEvent(EventType.MessageEnd, sid, {}),
      createEvent(EventType.ToolcallStart, sid, { toolCallId: "t1", toolName: "x" }),
      createEvent(EventType.ToolresultEnd, sid, { toolCallId: "t1", result: "r" }),
      createEvent(EventType.MessageStart, sid, { role: "assistant" }),
      createEvent(EventType.MessageDelta, sid, { content: "b" }),
      createEvent(EventType.MessageEnd, sid, {}),
    ];
    const out = flat(norm, input);
    expect(out).toHaveLength(input.length); // 无增删
    assertInvariant(out);
  });
});

/** 复刻 tests/e2e/events/event-sequence.test.ts 的核心不变量。 */
function assertInvariant(events: RunloopEvent[]): void {
  let open = false;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type === EventType.MessageStart) {
      expect(open, `message.start at ${i} while already open`).toBe(false);
      open = true;
    } else if (e.type === EventType.MessageEnd) {
      expect(open, `message.end at ${i} while no message open`).toBe(true);
      open = false;
    } else if (e.type === EventType.ToolcallStart) {
      expect(open, `toolcall.start at ${i} while message still open`).toBe(false);
    }
  }
  expect(open, "ended with unclosed message").toBe(false);
}
