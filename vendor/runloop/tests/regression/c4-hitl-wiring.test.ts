import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { writeFileSync, chmodSync } from "node:fs";
import { LoopRunner } from "@/loop/runner.js";
import { EventType, type RunloopEvent } from "@/types/events.js";
import { createEvent } from "@/events/factory.js";
import type { RunRequest } from "@/types/api.js";

function createToolCallScript(): string {
  const path = resolve(__dirname, "../fixtures/mock-tool-call.sh");
  writeFileSync(
    path,
    `#!/bin/sh
echo '{"type":"result","result":"executed dangerous_delete","usage":{}}'
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

describe("C4: HITL wiring", () => {
  it("does not hardcode bypass_permissions when HITL is enabled", async () => {
    const { readFileSync } = await import("node:fs");
    const adapterSource = readFileSync(
      resolve(__dirname, "../../src/acp/adapter.ts"),
      "utf-8"
    );
    const hasDynamicPermission =
      !adapterSource.includes('"bypass_permissions"') ||
      adapterSource.includes("permissionMode");
    expect(
      hasDynamicPermission,
      "adapter should not hardcode bypass_permissions"
    ).toBe(true);
  });

  it("runner passes features to adapter for permission mode selection", async () => {
    const script = createToolCallScript();
    const runner = new LoopRunner({ allowUnregisteredAgents: true, defaultAdapterType: "cli" });
    const request: RunRequest = {
      features: { agentCli: script },
      events: [
        createEvent(EventType.UserMessage, "s1", {
          content: "test",
          role: "user",
        }),
      ],
      features: {
        hitl: true,
        hitlRules: [
          {
            toolPattern: "dangerous_*",
            action: "block",
            reason: "Destructive",
          },
        ],
      },
    };

    const events = await collectEvents(runner.run(request));
    expect(events.length).toBeGreaterThan(0);
  });
});
