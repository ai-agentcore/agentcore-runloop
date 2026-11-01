import type { RunloopEvent } from "../types/events.js";

export function serializeSSE(event: RunloopEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function parseSSE(raw: string): RunloopEvent[] {
  const events: RunloopEvent[] = [];
  const blocks = raw.split("\n\n").filter(Boolean);

  for (const block of blocks) {
    const lines = block.split("\n");
    const dataLine = lines.find((l) => l.startsWith("data: "));
    if (dataLine) {
      const json = dataLine.slice(6);
      events.push(JSON.parse(json) as RunloopEvent);
    }
  }

  return events;
}
