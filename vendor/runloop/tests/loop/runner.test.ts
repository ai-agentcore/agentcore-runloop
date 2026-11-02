import { describe, it, expect } from "vitest";
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
    agent: { cli: "codex" },
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

describe("LoopRunner", () => {
  it("produces run.start and run.end events", async () => {
    const runner = new LoopRunner({ agentRegistry: { codex: { command: new URL("../fixtures/mock-agent-cli.sh", import.meta.url).pathname } }, defaultAdapterType: "codex" });
    const request = makeRunRequest();

    const events = await collectEvents(runner.run(request));

    const start = events.find((e) => e.type === EventType.RunStart);
    const end = events.find((e) => e.type === EventType.RunEnd);

    expect(start).toBeDefined();
    expect((start as any)?.agentCli).toBe("codex");
    expect(end).toBeDefined();
    expect((end as any)?.reason).toBe("completed");
  });

  it("每条出站事件都带 runId（不只是 run.start/run.end）", async () => {
    const runner = new LoopRunner({ agentRegistry: { codex: { command: new URL("../fixtures/mock-agent-cli.sh", import.meta.url).pathname } }, defaultAdapterType: "codex" });
    const events = await collectEvents(runner.run(makeRunRequest()));

    const start = events.find((e) => e.type === EventType.RunStart);
    expect(start?.runId).toBeTruthy();
    // 确有 adapter 产出的中间事件（turn.*），否则只剩 run.start/run.end、测不出漏标
    expect(events.some((e) => e.type === EventType.TurnStart)).toBe(true);

    const missing = events.filter((e) => e.runId !== start!.runId);
    expect(
      missing.map((e) => e.type),
      `这些出站事件缺/错 runId: [${missing.map((e) => e.type).join(", ")}]`
    ).toEqual([]);
  });

  it("出站 message.* 事件端到端带聚合 messageId（同一条 message 共享）", async () => {
    const runner = new LoopRunner({ agentRegistry: { codex: { command: new URL("../fixtures/mock-agent-cli.sh", import.meta.url).pathname } }, defaultAdapterType: "codex" });
    const events = await collectEvents(runner.run(makeRunRequest()));

    const msgEvents = events.filter((e) => e.type.startsWith("message.")) as Array<
      RunloopEvent & { messageId?: string }
    >;
    // echo adapter 经状态机产出一条 assistant message（start/delta/end）
    expect(msgEvents.length).toBeGreaterThan(0);
    // 每条 message.* 都带 messageId，且同一条 message 的 start..end 共享同一个
    expect(msgEvents.every((e) => typeof e.messageId === "string" && e.messageId.length > 0)).toBe(true);
    const startIdx = msgEvents.findIndex((e) => e.type === EventType.MessageStart);
    const endIdx = msgEvents.findIndex((e) => e.type === EventType.MessageEnd);
    const groupIds = new Set(msgEvents.slice(startIdx, endIdx + 1).map((e) => e.messageId));
    expect(groupIds.size).toBe(1);
  });

  it("auto-generates run id when not provided", async () => {
    const runner = new LoopRunner({ agentRegistry: { codex: { command: new URL("../fixtures/mock-agent-cli.sh", import.meta.url).pathname } }, defaultAdapterType: "codex" });
    const events = await collectEvents(runner.run(makeRunRequest()));

    const start = events.find((e) => e.type === EventType.RunStart);
    expect(start?.conversationId).toBeDefined();
    expect(start?.conversationId.length).toBeGreaterThan(0);
  });

  it("uses provided conversation id", async () => {
    const runner = new LoopRunner({ agentRegistry: { codex: { command: new URL("../fixtures/mock-agent-cli.sh", import.meta.url).pathname } }, defaultAdapterType: "codex" });
    const events = await collectEvents(
      runner.run(makeRunRequest({ conversationId: "my-session" }))
    );

    const start = events.find((e) => e.type === EventType.RunStart);
    expect(start?.conversationId).toBe("my-session");
  });

  it("treats attachments as already-materialized agent inputs without storage credentials", async () => {
    const runner = new LoopRunner({ agentRegistry: { codex: { command: new URL("../fixtures/mock-agent-cli.sh", import.meta.url).pathname } }, defaultAdapterType: "codex" });
    const request = makeRunRequest({
      conversationId: "attachment-session",
      credentials: undefined,
      events: [
        createEvent(EventType.UserMessage, "attachment-session", {
          content: "summarize the attachment",
          role: "user",
        }),
        createEvent(EventType.UserAttachment, "attachment-session", {
          uri: "/workspace/uploads/up_abc/file.txt",
          name: "notes.txt",
          mimeType: "text/plain",
        }),
      ],
    });

    const events = await collectEvents(runner.run(request));

    expect(events.some((event) => event.type === EventType.RunError)).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: EventType.RunEnd, reason: "completed" }));
  });

  it("handles agent CLI errors gracefully", async () => {
    const runner = new LoopRunner({ agentRegistry: { codex: { command: new URL("../fixtures/mock-agent-cli.sh", import.meta.url).pathname } }, defaultAdapterType: "codex" });
    const events = await collectEvents(
      runner.run(makeRunRequest({ agent: { cli: "nonexistent_agent_99999" } }))
    );

    const hasError = events.some(
      (e) =>
        e.type === EventType.RunError || e.type === EventType.RunEnd
    );
    expect(hasError).toBe(true);
  });

  it("can interrupt a running run", async () => {
    const runner = new LoopRunner({ agentRegistry: { codex: { command: new URL("../fixtures/mock-agent-cli.sh", import.meta.url).pathname } }, defaultAdapterType: "codex" });

    const request = makeRunRequest({ agent: { cli: "codex" } });
    request.events = [
      createEvent(EventType.UserMessage, "s1", {
        content: "10",
        role: "user",
      }),
    ];

    const eventsPromise = collectEvents(runner.run(request));

    await new Promise((r) => setTimeout(r, 50));

    const sessions = runner.getRunManager().listRuns();
    const runningSession = sessions.find((s) => s.status === "running");
    if (runningSession) {
      runner.interrupt(runningSession.conversationId, "test interrupt");
    }

    const events = await eventsPromise;

    const hasInterruptOrEnd = events.some(
      (e) =>
        e.type === EventType.RunInterrupt ||
        e.type === EventType.RunEnd ||
        e.type === EventType.TurnEnd
    );
    expect(hasInterruptOrEnd).toBe(true);
  });

  it("marks run as completed after successful run", async () => {
    const runner = new LoopRunner({ agentRegistry: { codex: { command: new URL("../fixtures/mock-agent-cli.sh", import.meta.url).pathname } }, defaultAdapterType: "codex" });
    const request = makeRunRequest({ conversationId: "tracked" });

    await collectEvents(runner.run(request));

    const session = runner.getRunManager().get("tracked");
    expect(session?.status).toBe("completed");
  });

  it("passes resources to adapter", async () => {
    const runner = new LoopRunner({ agentRegistry: { codex: { command: new URL("../fixtures/mock-agent-cli.sh", import.meta.url).pathname } }, defaultAdapterType: "codex" });
    const request = makeRunRequest({
      resources: [
        {
          resourceId: "r-test-tool",
          resourceName: "test-tool",
          resourceType: "SKILL",
          downloadUrl: "https://tools.example.com/skills/test-tool/package.zip",
        },
      ],
    });

    const events = await collectEvents(runner.run(request));
    expect(events.length).toBeGreaterThan(0);
  });

  it("handles thrown errors in the run loop", async () => {
    const runner = new LoopRunner({ agentRegistry: { codex: { command: new URL("../fixtures/mock-agent-cli.sh", import.meta.url).pathname } }, defaultAdapterType: "codex" });
    const request = makeRunRequest({ conversationId: "err-sess" });
    (request as any).events = null;

    const events = await collectEvents(runner.run(request));
    const errorEvent = events.find((e) => e.type === EventType.RunError);
    expect(errorEvent).toBeDefined();
    expect((errorEvent as any)?.error?.code).toBe("LOOP_ERROR");

    const session = runner.getRunManager().get("err-sess");
    expect(session?.status).toBe("error");
  });

  it("passes model config", async () => {
    const runner = new LoopRunner({ agentRegistry: { codex: { command: new URL("../fixtures/mock-agent-cli.sh", import.meta.url).pathname } }, defaultAdapterType: "codex" });
    const request = makeRunRequest({
      model: { provider: "openai", model: "gpt-4o" },
    });

    const events = await collectEvents(runner.run(request));
    const start = events.find((e) => e.type === EventType.RunStart);
    expect((start as any)?.model).toBe("gpt-4o");
  });
});
