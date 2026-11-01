import { describe, it, expect } from "vitest";
import { EventType } from "@/client/events.js";

describe("EventType", () => {
  it("has RunStart", () => {
    expect(EventType.RunStart).toBe("run.start");
  });

  it("has RunEnd", () => {
    expect(EventType.RunEnd).toBe("run.end");
  });

  it("has MessageDelta", () => {
    expect(EventType.MessageDelta).toBe("message.delta");
  });

  it("has ToolresultEnd", () => {
    expect(EventType.ToolresultEnd).toBe("toolresult.end");
  });

  it("has ToolcallSuspend", () => {
    expect(EventType.ToolcallSuspend).toBe("toolcall.suspend");
  });

  it("has TurnStart and TurnEnd", () => {
    expect(EventType.TurnStart).toBe("turn.start");
    expect(EventType.TurnEnd).toBe("turn.end");
  });

  it("has RunUsage", () => {
    expect(EventType.RunUsage).toBe("run.usage");
  });

  it("contains all 24 event types (含 reasoning 三件套)", () => {
    const keys = Object.keys(EventType);
    expect(keys).toHaveLength(24);
    expect(EventType.ReasoningStart).toBe("reasoning.start");
    expect(EventType.ReasoningDelta).toBe("reasoning.delta");
    expect(EventType.ReasoningEnd).toBe("reasoning.end");
  });

  it("all values are dot-separated or single-word strings", () => {
    for (const value of Object.values(EventType)) {
      expect(typeof value).toBe("string");
      expect(value).toMatch(/^[a-z_]+(\.[a-z_]+)?$/);
    }
  });
});
