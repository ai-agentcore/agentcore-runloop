import { describe, it, expect } from "vitest";
import { createEvent, isInputEvent, isOutputEvent, filterByType } from "@/events/factory.js";
import { EventType, type RunloopEvent } from "@/types/events.js";

describe("createEvent", () => {
  it("creates an event with generated id and timestamp", () => {
    const event = createEvent(EventType.UserMessage, "sess-1", {
      content: "hello",
      role: "user",
    });

    expect(event.id).toBeDefined();
    expect(event.id.length).toBeGreaterThan(0);
    expect(event.type).toBe("user.message");
    expect(event.conversationId).toBe("sess-1");
    expect(event.timestamp).toBeGreaterThan(0);
    expect((event as any).content).toBe("hello");
    expect((event as any).role).toBe("user");
  });

  it("creates different ids for each event", () => {
    const e1 = createEvent(EventType.MessageDelta, "s1", { content: "a" });
    const e2 = createEvent(EventType.MessageDelta, "s1", { content: "b" });
    expect(e1.id).not.toBe(e2.id);
  });

  it("creates event with default empty data", () => {
    const event = createEvent(EventType.MessageEnd, "s1");
    expect(event.type).toBe("message.end");
    expect(event.conversationId).toBe("s1");
  });
});

describe("isInputEvent", () => {
  it("returns true for user.message events", () => {
    const event = createEvent(EventType.UserMessage, "s1", {
      content: "hi",
      role: "user",
    });
    expect(isInputEvent(event)).toBe(true);
  });

  it("returns true for user.command events", () => {
    const event = createEvent(EventType.UserCommand, "s1", {
      command: "resolve",
    });
    expect(isInputEvent(event)).toBe(true);
  });

  it("returns true for user.attachment events", () => {
    const event = createEvent(EventType.UserAttachment, "s1", {
      uri: "file://test.txt",
    });
    expect(isInputEvent(event)).toBe(true);
  });

  it("returns false for assistant events", () => {
    const event = createEvent(EventType.MessageDelta, "s1", {
      content: "hi",
    });
    expect(isInputEvent(event)).toBe(false);
  });

  it("returns false for run events", () => {
    const event = createEvent(EventType.RunStart, "s1", {
      agentCli: "test",
    });
    expect(isInputEvent(event)).toBe(false);
  });
});

describe("isOutputEvent", () => {
  it("returns true for non-user events", () => {
    const event = createEvent(EventType.MessageDelta, "s1", {
      content: "hi",
    });
    expect(isOutputEvent(event)).toBe(true);
  });

  it("returns false for user events", () => {
    const event = createEvent(EventType.UserMessage, "s1", {
      content: "hi",
      role: "user",
    });
    expect(isOutputEvent(event)).toBe(false);
  });
});

describe("filterByType", () => {
  it("filters events by type", () => {
    const events: RunloopEvent[] = [
      createEvent(EventType.UserMessage, "s1", {
        content: "hi",
        role: "user",
      }),
      createEvent(EventType.MessageDelta, "s1", { content: "hello" }),
      createEvent(EventType.UserMessage, "s1", {
        content: "bye",
        role: "user",
      }),
      createEvent(EventType.MessageEnd, "s1"),
    ];

    const filtered = filterByType(events, EventType.UserMessage);
    expect(filtered).toHaveLength(2);
    expect(filtered[0].type).toBe("user.message");
    expect(filtered[1].type).toBe("user.message");
  });

  it("returns empty array when no match", () => {
    const events: RunloopEvent[] = [
      createEvent(EventType.MessageDelta, "s1", { content: "hi" }),
    ];
    const filtered = filterByType(events, EventType.ToolcallStart);
    expect(filtered).toHaveLength(0);
  });
});
