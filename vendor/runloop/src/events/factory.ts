import { nanoid } from "nanoid";
import type { RunloopEvent } from "../types/events.js";

export function createEvent(
  type: string,
  conversationId: string,
  data: Record<string, unknown> = {}
): RunloopEvent {
  return {
    id: nanoid(),
    type,
    timestamp: Date.now(),
    conversationId,
    ...data,
  } as RunloopEvent;
}

export function isInputEvent(event: RunloopEvent): boolean {
  return event.type.startsWith("user.");
}

export function isOutputEvent(event: RunloopEvent): boolean {
  return !isInputEvent(event);
}

export function filterByType(
  events: RunloopEvent[],
  type: string
): RunloopEvent[] {
  return events.filter((e) => e.type === type);
}
