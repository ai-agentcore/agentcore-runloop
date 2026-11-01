import { describe, it, expect } from "vitest";
import { serializeSSE, parseSSE } from "@/events/serializer.js";
import { createEvent } from "@/events/factory.js";
import { EventType } from "@/types/events.js";

describe("serializeSSE", () => {
  it("serializes an event to SSE format", () => {
    const event = createEvent(EventType.MessageDelta, "s1", {
      content: "hello",
    });
    const sse = serializeSSE(event);

    expect(sse).toContain("event: message.delta\n");
    expect(sse).toContain("data: ");
    expect(sse).toContain('"content":"hello"');
    expect(sse.endsWith("\n\n")).toBe(true);
  });

  it("includes all event fields in data", () => {
    const event = createEvent(EventType.RunStart, "s1", {
      agentCli: "qodercli",
    });
    const sse = serializeSSE(event);
    const data = JSON.parse(sse.split("data: ")[1].trim());

    expect(data.id).toBe(event.id);
    expect(data.type).toBe("run.start");
    expect(data.conversationId).toBe("s1");
    expect(data.agentCli).toBe("qodercli");
  });
});

describe("parseSSE", () => {
  it("parses SSE text back to events", () => {
    const event1 = createEvent(EventType.MessageDelta, "s1", {
      content: "hi",
    });
    const event2 = createEvent(EventType.MessageEnd, "s1");

    const raw = serializeSSE(event1) + serializeSSE(event2);
    const parsed = parseSSE(raw);

    expect(parsed).toHaveLength(2);
    expect(parsed[0].type).toBe("message.delta");
    expect(parsed[1].type).toBe("message.end");
  });

  it("returns empty array for empty input", () => {
    expect(parseSSE("")).toEqual([]);
  });

  it("handles blocks without data lines", () => {
    const raw = "event: heartbeat\n\n";
    const parsed = parseSSE(raw);
    expect(parsed).toEqual([]);
  });

  it("roundtrips an event", () => {
    const event = createEvent(EventType.ToolcallStart, "s1", {
      toolCallId: "tc-1",
      toolName: "read_file",
    });
    const serialized = serializeSSE(event);
    const [parsed] = parseSSE(serialized);

    expect(parsed.id).toBe(event.id);
    expect(parsed.type).toBe(event.type);
    expect(parsed.conversationId).toBe(event.conversationId);
    expect((parsed as any).toolCallId).toBe("tc-1");
    expect((parsed as any).toolName).toBe("read_file");
  });
});
