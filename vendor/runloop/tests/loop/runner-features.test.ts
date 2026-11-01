import { describe, it, expect, afterEach } from "vitest";
import { LoopRunner } from "@/loop/runner.js";
import { EventType, type RunloopEvent } from "@/types/events.js";
import { createEvent } from "@/events/factory.js";
import type { RunRequest } from "@/types/api.js";

async function collectEvents(
  gen: AsyncGenerator<RunloopEvent>
): Promise<RunloopEvent[]> {
  const events: RunloopEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function makeRunRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    agent: { cli: "echo" },
    events: [
      createEvent(EventType.UserMessage, "s1", {
        content: "hello",
        role: "user",
      }),
    ],
    model: {
      provider: "test",
      model: "test-model",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "test-key",
    },
    credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
    ...overrides,
  };
}

describe("LoopRunner - maxTurns", () => {
  it("stops after maxTurns limit", async () => {
    const runner = new LoopRunner({ allowUnregisteredAgents: true, defaultAdapterType: "cli" });
    const request = makeRunRequest({
      agent: { cli: "echo", maxTurns: 1 },
    });

    const events = await collectEvents(runner.run(request));

    const turnEnds = events.filter((e) => e.type === EventType.TurnEnd);
    const runEnd = events.find((e) => e.type === EventType.RunEnd);

    expect(turnEnds).toHaveLength(1);
    expect(runEnd).toBeDefined();
    expect((runEnd as any)?.reason).toBe("completed");
  });

  it("allows unlimited turns when maxTurns not set", async () => {
    const runner = new LoopRunner({ allowUnregisteredAgents: true, defaultAdapterType: "cli" });
    const request = makeRunRequest();

    const events = await collectEvents(runner.run(request));
    const runEnd = events.find((e) => e.type === EventType.RunEnd);
    expect(runEnd).toBeDefined();
  });
});

describe("LoopRunner - timeout", () => {
  it("interrupts session after timeout", async () => {
    const runner = new LoopRunner({ allowUnregisteredAgents: true, defaultAdapterType: "cli" });
    const request = makeRunRequest({
      agent: { cli: "sleep", timeoutMs: 200 },
    });
    request.events = [
      createEvent(EventType.UserMessage, "s1", {
        content: "10",
        role: "user",
      }),
    ];

    const events = await collectEvents(runner.run(request));

    const hasInterruptOrEnd = events.some(
      (e) =>
        e.type === EventType.RunInterrupt ||
        e.type === EventType.TurnEnd
    );
    expect(hasInterruptOrEnd).toBe(true);
  });
});

describe("LoopRunner - adapter selection", () => {
  it("uses default cli adapter", async () => {
    const runner = new LoopRunner({ allowUnregisteredAgents: true, defaultAdapterType: "cli" });
    const events = await collectEvents(runner.run(makeRunRequest()));
    expect(events.length).toBeGreaterThan(0);
  });

  it("uses stream-json adapter when configured", async () => {
    const runner = new LoopRunner({ defaultAdapterType: "stream-json", allowUnregisteredAgents: true, });
    const events = await collectEvents(runner.run(makeRunRequest()));
    expect(events.length).toBeGreaterThan(0);
  });

  it("supports per-request adapter override", async () => {
    const runner = new LoopRunner({ allowUnregisteredAgents: true, defaultAdapterType: "cli" });
    const request = makeRunRequest();
    (request as any).adapterType = "stream-json";

    const events = await collectEvents(runner.run(request));
    expect(events.length).toBeGreaterThan(0);
  });
});

describe("LoopRunner - constructor options", () => {
  it("accepts llmJudge option", async () => {
    const { StaticLlmJudge } = await import("@/hitl/judge.js");
    const runner = new LoopRunner({
      llmJudge: new StaticLlmJudge("allow"),
    });
    expect(runner).toBeDefined();
  });
});

describe("LoopRunner - 预发 model 凭证默认值（AGENTCORE_ENV）", () => {
  const saved = {
    env: process.env.AGENTCORE_ENV,
    base: process.env.AGENTCORE_DEFAULT_MODEL_BASE_URL,
    key: process.env.AGENTCORE_DEFAULT_MODEL_API_KEY,
  };
  afterEach(() => {
    if (saved.env === undefined) delete process.env.AGENTCORE_ENV; else process.env.AGENTCORE_ENV = saved.env;
    if (saved.base === undefined) delete process.env.AGENTCORE_DEFAULT_MODEL_BASE_URL; else process.env.AGENTCORE_DEFAULT_MODEL_BASE_URL = saved.base;
    if (saved.key === undefined) delete process.env.AGENTCORE_DEFAULT_MODEL_API_KEY; else process.env.AGENTCORE_DEFAULT_MODEL_API_KEY = saved.key;
  });

  function reqNoCreds(): RunRequest {
    const r = makeRunRequest();
    r.model = { provider: "openai-compatible", model: "qwen" }; // 故意不传 baseUrl/apiKey
    return r;
  }
  const requiredErr = (e: RunloopEvent) =>
    e.type === EventType.RunError && /baseUrl and model.apiKey are required/.test((e as any).error?.message ?? "");

  it("预发 + 配了默认 env → 缺 baseUrl/apiKey 也能跑（不报 required 错）", async () => {
    process.env.AGENTCORE_ENV = "pre";
    process.env.AGENTCORE_DEFAULT_MODEL_BASE_URL = "http://127.0.0.1:1/v1";
    process.env.AGENTCORE_DEFAULT_MODEL_API_KEY = "test-default-key";
    const runner = new LoopRunner({ allowUnregisteredAgents: true, defaultAdapterType: "cli" });
    const events = await collectEvents(runner.run(reqNoCreds()));
    expect(events.some(requiredErr)).toBe(false);
  });

  it("非预发环境 → 缺 baseUrl/apiKey 仍报 required 错（线上不注入默认）", async () => {
    delete process.env.AGENTCORE_ENV;
    process.env.AGENTCORE_DEFAULT_MODEL_BASE_URL = "http://127.0.0.1:1/v1";
    process.env.AGENTCORE_DEFAULT_MODEL_API_KEY = "test-default-key";
    const runner = new LoopRunner({ allowUnregisteredAgents: true, defaultAdapterType: "cli" });
    const events = await collectEvents(runner.run(reqNoCreds()));
    expect(events.some(requiredErr)).toBe(true);
  });
});
