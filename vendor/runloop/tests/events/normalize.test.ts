import { describe, it, expect } from "vitest";
import { normalizeInputEvents } from "@/events/normalize.js";
import { EventType } from "@/types/events.js";

describe("normalizeInputEvents", () => {
  const conversationId = "test-session-1";

  it("normalizes UserMessage with content and role", () => {
    const events = normalizeInputEvents(
      [{ type: EventType.UserMessage, content: "hello" }],
      conversationId,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: EventType.UserMessage,
      content: "hello",
      role: "user",
      conversationId,
    });
  });

  it("normalizes UserAttachment with uri, mimeType, and name", () => {
    const events = normalizeInputEvents(
      [
        {
          type: EventType.UserAttachment,
          uri: "file:///tmp/test.png",
          mimeType: "image/png",
          name: "test.png",
        },
      ],
      conversationId,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: EventType.UserAttachment,
      uri: "file:///tmp/test.png",
      mimeType: "image/png",
      name: "test.png",
      conversationId,
    });
  });

  it("normalizes UserAttachment with optional fields omitted", () => {
    const events = normalizeInputEvents(
      [{ type: EventType.UserAttachment, uri: "file:///tmp/data.csv" }],
      conversationId,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: EventType.UserAttachment,
      uri: "file:///tmp/data.csv",
      conversationId,
    });
  });

  it("normalizes UserCommand with command, targetEventId, and payload", () => {
    const events = normalizeInputEvents(
      [
        {
          type: EventType.UserCommand,
          command: "approve",
          targetEventId: "evt-123",
          payload: { reason: "looks good" },
        },
      ],
      conversationId,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: EventType.UserCommand,
      command: "approve",
      targetEventId: "evt-123",
      payload: { reason: "looks good" },
      conversationId,
    });
  });

  it("normalizes UserCommand with optional fields omitted", () => {
    const events = normalizeInputEvents(
      [{ type: EventType.UserCommand, command: "interrupt" }],
      conversationId,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: EventType.UserCommand,
      command: "interrupt",
      conversationId,
    });
  });

  it("passes through unknown event types via default case", () => {
    const events = normalizeInputEvents(
      [
        {
          type: "message.delta" as any,
          content: "streamed text",
          extra: "field",
        },
      ],
      conversationId,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "message.delta",
      content: "streamed text",
      extra: "field",
      conversationId,
    });
  });

  it("auto-generates id and timestamp when not provided", () => {
    const before = Date.now();
    const events = normalizeInputEvents(
      [{ type: EventType.UserMessage, content: "auto" }],
      conversationId,
    );
    const after = Date.now();

    expect(events[0].id).toBeTruthy();
    expect(typeof events[0].id).toBe("string");
    expect(events[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(events[0].timestamp).toBeLessThanOrEqual(after);
  });

  it("preserves provided id and timestamp", () => {
    const events = normalizeInputEvents(
      [
        {
          type: EventType.UserMessage,
          content: "preset",
          id: "custom-id",
          timestamp: 1700000000000,
        },
      ],
      conversationId,
    );

    expect(events[0].id).toBe("custom-id");
    expect(events[0].timestamp).toBe(1700000000000);
  });

  it("preserves metadata when provided", () => {
    const events = normalizeInputEvents(
      [
        {
          type: EventType.UserMessage,
          content: "with meta",
          metadata: { source: "test", priority: 1 },
        },
      ],
      conversationId,
    );

    expect((events[0] as any).metadata).toEqual({
      source: "test",
      priority: 1,
    });
  });

  it("does not include metadata key when not provided", () => {
    const events = normalizeInputEvents(
      [{ type: EventType.UserMessage, content: "no meta" }],
      conversationId,
    );

    expect(Object.keys(events[0])).not.toContain("metadata");
  });

  it("normalizes multiple events in order", () => {
    const events = normalizeInputEvents(
      [
        { type: EventType.UserMessage, content: "first" },
        { type: EventType.UserAttachment, uri: "file:///a.txt" },
        { type: EventType.UserCommand, command: "deny" },
      ],
      conversationId,
    );

    expect(events).toHaveLength(3);
    expect(events[0].type).toBe(EventType.UserMessage);
    expect(events[1].type).toBe(EventType.UserAttachment);
    expect(events[2].type).toBe(EventType.UserCommand);
    events.forEach((e) => expect(e.conversationId).toBe(conversationId));
  });
});
