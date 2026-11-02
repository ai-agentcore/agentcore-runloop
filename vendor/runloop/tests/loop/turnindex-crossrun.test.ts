import { describe, it, expect } from "vitest";
import { LoopRunner } from "@/loop/runner.js";
import { EventType, type RunloopEvent } from "@/types/events.js";
import type { RunRequest } from "@/types/api.js";

async function collect(gen: AsyncGenerator<RunloopEvent>): Promise<RunloopEvent[]> {
  const out: RunloopEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("turnIndex cross-run continuation (doc-vs-code)", () => {
  it("starts the new run's turnIndex from last history turn.end.turnIndex + 1", async () => {
    const runner = new LoopRunner({ agentRegistry: { codex: { command: new URL("../fixtures/mock-agent-cli.sh", import.meta.url).pathname } }, defaultAdapterType: "codex" });
    const req: RunRequest = {
      agent: { cli: "codex" },
      events: [
        { type: "user.message", content: "first" },
        { type: "turn.end", turnIndex: 2, stopReason: "end_turn" },
        { type: "user.message", content: "second" },
      ] as never,
      model: { provider: "t", model: "m", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" },
      credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
    };
    const events = await collect(runner.run(req));
    const firstTurnStart = events.find((e) => e.type === EventType.TurnStart) as RunloopEvent & { turnIndex?: number };
    expect(firstTurnStart?.turnIndex).toBe(3);
  });

  it("starts at 0 when history has no turn.end", async () => {
    const runner = new LoopRunner({ agentRegistry: { codex: { command: new URL("../fixtures/mock-agent-cli.sh", import.meta.url).pathname } }, defaultAdapterType: "codex" });
    const req: RunRequest = {
      agent: { cli: "codex" },
      events: [{ type: "user.message", content: "hi" }] as never,
      model: { provider: "t", model: "m", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" },
      credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
    };
    const events = await collect(runner.run(req));
    const firstTurnStart = events.find((e) => e.type === EventType.TurnStart) as RunloopEvent & { turnIndex?: number };
    expect(firstTurnStart?.turnIndex).toBe(0);
  });
});
