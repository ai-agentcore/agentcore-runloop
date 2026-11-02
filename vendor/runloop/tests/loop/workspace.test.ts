import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { rm, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { LoopRunner } from "@/loop/runner.js";
import { EventType, type RunloopEvent } from "@/types/events.js";
import { createEvent } from "@/events/factory.js";
import type { RunRequest } from "@/types/api.js";

const MOCK_PWD_PATH = resolve(__dirname, "../fixtures/mock-pwd.sh");

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

describe("LoopRunner - workspaces", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const d of dirs) {
      try { await rm(d, { recursive: true, force: true }); } catch {}
    }
    dirs.length = 0;
  });

  it("creates session workspace directory", async () => {
    const workspacesDir = await mkdtemp(join(tmpdir(), "runloop-ws-test-"));
    dirs.push(workspacesDir);

    const runner = new LoopRunner({
      agentRegistry: { codex: { command: new URL("../fixtures/mock-agent-cli.sh", import.meta.url).pathname } },
      defaultAdapterType: "codex",
      workspacesDir,
    });

    const request = makeRunRequest({ conversationId: "ws-test-1" });
    await collectEvents(runner.run(request));

    const sessionDir = join(workspacesDir, "ws-test-1");
    expect(existsSync(sessionDir)).toBe(true);
  });

  it("isolates workspaces between sessions", async () => {
    const workspacesDir = await mkdtemp(join(tmpdir(), "runloop-ws-test-"));
    dirs.push(workspacesDir);

    const runner = new LoopRunner({
      agentRegistry: { codex: { command: new URL("../fixtures/mock-agent-cli.sh", import.meta.url).pathname } },
      defaultAdapterType: "codex",
      workspacesDir,
    });

    await collectEvents(runner.run(makeRunRequest({ conversationId: "session-a" })));
    await collectEvents(runner.run(makeRunRequest({ conversationId: "session-b" })));

    expect(existsSync(join(workspacesDir, "session-a"))).toBe(true);
    expect(existsSync(join(workspacesDir, "session-b"))).toBe(true);

    const entries = readdirSync(workspacesDir);
    expect(entries).toContain("session-a");
    expect(entries).toContain("session-b");
  });

  it("creates .runloop temp dir inside workspace", async () => {
    const workspacesDir = await mkdtemp(join(tmpdir(), "runloop-ws-test-"));
    dirs.push(workspacesDir);

    const runner = new LoopRunner({
      agentRegistry: { codex: { command: new URL("../fixtures/mock-agent-cli.sh", import.meta.url).pathname } },
      defaultAdapterType: "codex",
      workspacesDir,
    });

    await collectEvents(runner.run(makeRunRequest({ conversationId: "ws-tmp" })));

    const runloopDir = join(workspacesDir, "ws-tmp", ".runloop");
    expect(existsSync(runloopDir)).toBe(true);
  });

  it("preserves workspace files after session ends", async () => {
    const workspacesDir = await mkdtemp(join(tmpdir(), "runloop-ws-test-"));
    dirs.push(workspacesDir);

    const runner = new LoopRunner({
      agentRegistry: { codex: { command: new URL("../fixtures/mock-agent-cli.sh", import.meta.url).pathname } },
      defaultAdapterType: "codex",
      workspacesDir,
    });

    await collectEvents(runner.run(makeRunRequest({ conversationId: "persist" })));

    const sessionDir = join(workspacesDir, "persist");
    const runloopDir = join(sessionDir, ".runloop");
    expect(existsSync(sessionDir)).toBe(true);
    expect(existsSync(runloopDir)).toBe(true);
  });

  it("uses workspace as default cwd", async () => {
    const workspacesDir = await mkdtemp(join(tmpdir(), "runloop-ws-test-"));
    dirs.push(workspacesDir);

    const runner = new LoopRunner({
      defaultAdapterType: "codex",
      workspacesDir,
      agentRegistry: { codex: { command: MOCK_PWD_PATH } },
    });

    const request = makeRunRequest({
      conversationId: "cwd-test",
      agent: { cli: "codex" },
    });
    const events = await collectEvents(runner.run(request));

    const deltas = events
      .filter((e) => e.type === EventType.MessageDelta)
      .map((e) => (e as any).content)
      .join("");

    const expectedDir = realpathSync(join(workspacesDir, "cwd-test"));
    expect(deltas.trim()).toBe(expectedDir);
  });

  it("request.cwd overrides workspace cwd", async () => {
    const workspacesDir = await mkdtemp(join(tmpdir(), "runloop-ws-test-"));
    dirs.push(workspacesDir);

    const runner = new LoopRunner({
      defaultAdapterType: "codex",
      workspacesDir,
      agentRegistry: { codex: { command: MOCK_PWD_PATH } },
    });

    const request = makeRunRequest({
      conversationId: "cwd-override",
      agent: { cli: "codex", cwd: "/tmp" },
    });
    const events = await collectEvents(runner.run(request));

    const deltas = events
      .filter((e) => e.type === EventType.MessageDelta)
      .map((e) => (e as any).content)
      .join("");

    expect(deltas.trim()).not.toContain("cwd-override");
  });

  it("does not create workspace when workspacesDir not set", async () => {
    const runner = new LoopRunner({
      agentRegistry: { codex: { command: new URL("../fixtures/mock-agent-cli.sh", import.meta.url).pathname } },
      defaultAdapterType: "codex",
    });

    const request = makeRunRequest({ conversationId: "no-ws" });
    const events = await collectEvents(runner.run(request));

    expect(events.some((e) => e.type === EventType.RunEnd)).toBe(true);
  });
});
