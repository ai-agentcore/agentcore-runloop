import { describe, it, expect } from "vitest";
import { MergeNormalizer } from "@/events/merge-normalizer.js";
import { createEvent } from "@/events/factory.js";
import { EventType, type RunloopEvent } from "@/types/events.js";

/**
 * MergeNormalizer 作为聚合 id 的唯一权威：同一条 message 的 start/delta/end 共享一个 `messageId`，
 * 同一段 reasoning 的 start/delta/end 共享一个 `reasoningId`（含归一化器自己补出的 start/end）。
 * 结构不变量见 tests/regression/subagent-lifecycle-merge.test.ts；本文件聚焦 id 聚合。
 */
describe("MergeNormalizer 聚合 id 盖戳", () => {
  const sid = "sess-1";
  const N = () => new MergeNormalizer(sid);
  const flat = (norm: MergeNormalizer, events: RunloopEvent[]): RunloopEvent[] =>
    events.flatMap((e) => norm.normalize(e));
  const mid = (e: RunloopEvent) => (e as { messageId?: string }).messageId;
  const rid = (e: RunloopEvent) => (e as { reasoningId?: string }).reasoningId;

  it("同一条 message 的 start/delta/delta/end 共享一个 messageId", () => {
    const out = flat(N(), [
      createEvent(EventType.MessageStart, sid, { role: "assistant" }),
      createEvent(EventType.MessageDelta, sid, { content: "a" }),
      createEvent(EventType.MessageDelta, sid, { content: "b" }),
      createEvent(EventType.MessageEnd, sid, {}),
    ]);
    const ids = out.map(mid);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toMatch(/^msg-/);
    expect(ids.every((i) => i === ids[0])).toBe(true);
  });

  it("两条独立 message 拿到不同 messageId", () => {
    const out = flat(N(), [
      createEvent(EventType.MessageStart, sid, { role: "assistant" }),
      createEvent(EventType.MessageDelta, sid, { content: "a" }),
      createEvent(EventType.MessageEnd, sid, {}),
      createEvent(EventType.MessageStart, sid, { role: "assistant" }),
      createEvent(EventType.MessageDelta, sid, { content: "b" }),
      createEvent(EventType.MessageEnd, sid, {}),
    ]);
    const first = out.slice(0, 3).map(mid);
    const second = out.slice(3).map(mid);
    expect(new Set(first).size).toBe(1);
    expect(new Set(second).size).toBe(1);
    expect(first[0]).not.toBe(second[0]);
  });

  it("孤儿 delta：补出的 message.start 与该 delta 共享同一个新 messageId", () => {
    // 委派后裸 delta（无 start）——归一化器补 start，二者必须同 id。
    const out = flat(N(), [
      createEvent(EventType.MessageDelta, sid, { content: "orphan" }),
    ]);
    expect(out.map((e) => e.type)).toEqual([EventType.MessageStart, EventType.MessageDelta]);
    expect(mid(out[0])).toBe(mid(out[1]));
    expect(mid(out[0])).toMatch(/^msg-/);
  });

  it("tool_call.start 触发补出的 message.end 沿用打开 message 的 messageId", () => {
    const out = flat(N(), [
      createEvent(EventType.MessageStart, sid, { role: "assistant" }),
      createEvent(EventType.MessageDelta, sid, { content: "calling..." }),
      createEvent(EventType.ToolcallStart, sid, { toolCallId: "t1", toolName: "x" }),
    ]);
    const start = out.find((e) => e.type === EventType.MessageStart)!;
    const end = out.find((e) => e.type === EventType.MessageEnd)!;
    expect(mid(end)).toBe(mid(start)); // 补出的 end 属于同一条 message
  });

  it("跨流双 start：补出的 end 属于上一条、新 start 拿新 id", () => {
    const out = flat(N(), [
      createEvent(EventType.MessageStart, sid, { role: "assistant" }), // 流A
      createEvent(EventType.MessageDelta, sid, { content: "parent" }),
      createEvent(EventType.MessageStart, sid, { role: "assistant" }), // 流B 在 A 未关时又 start
      createEvent(EventType.MessageDelta, sid, { content: "child" }),
      createEvent(EventType.MessageEnd, sid, {}),
    ]);
    // 序列：startA, deltaA, endA(补), startB, deltaB, endB
    const idA = mid(out[0]);
    expect(mid(out[1])).toBe(idA);
    expect(mid(out[2])).toBe(idA); // 补出的 end 属于 A
    const idB = mid(out[3]);
    expect(idB).not.toBe(idA);
    expect(mid(out[4])).toBe(idB);
    expect(mid(out[5])).toBe(idB);
  });

  it("flush() 补出的 message.end 沿用打开 message 的 messageId", () => {
    const norm = N();
    const out = flat(norm, [
      createEvent(EventType.MessageStart, sid, { role: "assistant" }),
      createEvent(EventType.MessageDelta, sid, { content: "no end" }),
    ]);
    const flushed = norm.flush();
    expect(flushed).toHaveLength(1);
    expect(mid(flushed[0])).toBe(mid(out[0]));
  });

  it("同一段 reasoning 的 start/delta/end 共享一个 reasoningId，不同段不同 id", () => {
    const out = flat(N(), [
      createEvent(EventType.ReasoningStart, sid, {}),
      createEvent(EventType.ReasoningDelta, sid, { content: "think" }),
      createEvent(EventType.ReasoningEnd, sid, {}),
      createEvent(EventType.ReasoningStart, sid, {}),
      createEvent(EventType.ReasoningDelta, sid, { content: "again" }),
      createEvent(EventType.ReasoningEnd, sid, {}),
    ]);
    const seg1 = out.slice(0, 3).map(rid);
    const seg2 = out.slice(3).map(rid);
    expect(new Set(seg1).size).toBe(1);
    expect(seg1[0]).toMatch(/^rsn-/);
    expect(new Set(seg2).size).toBe(1);
    expect(seg1[0]).not.toBe(seg2[0]);
  });

  it("message 与 reasoning 的聚合 id 互相独立（不同命名空间）", () => {
    const out = flat(N(), [
      createEvent(EventType.ReasoningStart, sid, {}),
      createEvent(EventType.ReasoningDelta, sid, { content: "t" }),
      createEvent(EventType.ReasoningEnd, sid, {}),
      createEvent(EventType.MessageStart, sid, { role: "assistant" }),
      createEvent(EventType.MessageDelta, sid, { content: "answer" }),
      createEvent(EventType.MessageEnd, sid, {}),
    ]);
    // reasoning 段无 messageId，message 段无 reasoningId
    for (const e of out.slice(0, 3)) {
      expect(rid(e)).toMatch(/^rsn-/);
      expect(mid(e)).toBeUndefined();
    }
    for (const e of out.slice(3)) {
      expect(mid(e)).toMatch(/^msg-/);
      expect(rid(e)).toBeUndefined();
    }
  });

  it("非 message/reasoning 事件不被盖 id", () => {
    const out = flat(N(), [
      createEvent(EventType.ToolcallStart, sid, { toolCallId: "t1", toolName: "x" }),
      createEvent(EventType.ToolresultEnd, sid, { toolCallId: "t1", result: "r" }),
    ]);
    for (const e of out) {
      expect(mid(e)).toBeUndefined();
      expect(rid(e)).toBeUndefined();
    }
  });
});
