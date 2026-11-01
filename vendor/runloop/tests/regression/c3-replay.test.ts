import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { writeFileSync, chmodSync } from "node:fs";
import { CliAgentAdapter } from "@/acp/adapter.js";
import { EventType, type RunloopEvent } from "@/types/events.js";
import type { CompressedMessage } from "@/events/compress.js";

function createEchoArgsScript(): string {
  const path = resolve(__dirname, "../fixtures/echo-all-args.sh");
  writeFileSync(
    path,
    `#!/usr/bin/env bash
# Write last arg (the transcript) to a temp file for length-safe output
last_arg="\${@: -1}"
printf '%s' "$last_arg"
`
  );
  chmodSync(path, 0o755);
  return path;
}

async function collectEvents(
  gen: AsyncGenerator<RunloopEvent>
): Promise<RunloopEvent[]> {
  const events: RunloopEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe("C3: Event replay completeness", () => {
  it("passes full conversation context to CLI, not just last user message", async () => {
    const script = createEchoArgsScript();
    const adapter = new CliAgentAdapter(script);

    const messages: CompressedMessage[] = [
      { role: "system", content: "[Summary] User discussed file operations" },
      { role: "user", content: "Read the config file" },
      { role: "assistant", content: "Here is the config..." },
      { role: "user", content: "Now update the port to 8080" },
    ];

    const events = await collectEvents(
      adapter.run({
        conversationId: "replay-test",
        messages,
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );

    const deltas = events.filter((e) => e.type === EventType.MessageDelta);
    expect(deltas.length).toBeGreaterThan(0);
    const fullContent = deltas.map((e) => (e as any).content).join("");

    expect(fullContent).toContain("Summary");
    expect(fullContent).toContain("Read the config");
    expect(fullContent).toContain("update the port");
  });
});
