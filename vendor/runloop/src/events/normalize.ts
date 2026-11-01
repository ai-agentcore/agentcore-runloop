import { nanoid } from "nanoid";
import { EventType, type InputEvent, type RunloopEvent } from "../types/events.js";

export function normalizeInputEvents(
  events: InputEvent[],
  conversationId: string
): RunloopEvent[] {
  return events.map((e) => normalizeOne(e, conversationId));
}

function normalizeOne(event: InputEvent, conversationId: string): RunloopEvent {
  const base = {
    id: event.id ?? nanoid(),
    timestamp: event.timestamp ?? Date.now(),
    conversationId,
    ...(event.metadata ? { metadata: event.metadata } : {}),
  };

  const raw = event as Record<string, unknown>;

  switch (event.type) {
    case EventType.UserMessage:
      return { ...base, type: event.type, content: (raw.content as string), role: "user" as const } as RunloopEvent;
    case EventType.UserAttachment:
      return { ...base, type: event.type, uri: raw.uri as string, mimeType: raw.mimeType as string | undefined, name: raw.name as string | undefined } as RunloopEvent;
    case EventType.UserCommand:
      // 保留 HITL resolve 全部字段（toolCallId/selectedOptionId/审计字段等），不剥离
      return { ...raw, ...base, type: event.type, command: raw.command as string } as RunloopEvent;
    default:
      return { ...raw, ...base } as RunloopEvent;
  }
}
