import { describe, it, expect } from "vitest";
import { writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { CodexAdapter } from "@/acp/codex-adapter.js";
import { EventType, type RunloopEvent } from "@/types/events.js";

function createScript(name: string, content: string): string {
  const path = resolve(__dirname, `../fixtures/${name}`);
  writeFileSync(path, `#!/bin/sh\n${content}\n`);
  chmodSync(path, 0o755);
  return path;
}

async function collect(gen: AsyncGenerator<RunloopEvent>): Promise<RunloopEvent[]> {
  const out: RunloopEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("CodexAdapter — plan.update extraction (L-039)", () => {
  it("translates a codex todo_list item into a plan.update event", async () => {
    const script = createScript(
      "mock-codex-plan.sh",
      `echo '{"type":"item.completed","item":{"id":"p1","type":"todo_list","items":[{"content":"step A","status":"completed"},{"content":"step B","status":"in_progress"},{"content":"step C","status":"pending"}]}}'
echo '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"planned"}}'
echo '{"type":"turn.completed","usage":{}}'`
    );

    const events = await collect(
      new CodexAdapter(script).run({
        conversationId: "codex-plan",
        messages: [{ role: "user", content: "plan it" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
      })
    );

    const plan = events.find((e) => e.type === EventType.PlanUpdate) as RunloopEvent & { entries?: Array<{ content: string; status: string }> };
    expect(plan).toBeDefined();
    expect(plan.entries).toHaveLength(3);
    expect(plan.entries![0]).toMatchObject({ content: "step A", status: "completed" });
    expect(plan.entries![1]).toMatchObject({ content: "step B", status: "in_progress" });
    expect(plan.entries![2]).toMatchObject({ content: "step C", status: "pending" });
  });
});

describe("CodexAdapter — agent.env injection (档1)", () => {
  it("injects params.env into the codex process", async () => {
    // mock codex echoes the injected env var back as an agent_message
    const script = createScript(
      "mock-codex-env.sh",
      `echo "{\\"type\\":\\"item.completed\\",\\"item\\":{\\"type\\":\\"agent_message\\",\\"text\\":\\"ENV=$AGENTCORE_TEST_VAR\\"}}"
echo '{"type":"turn.completed","usage":{}}'`
    );

    const events = await collect(
      new CodexAdapter(script).run({
        conversationId: "codex-env",
        messages: [{ role: "user", content: "echo env" }],
        config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
        env: { AGENTCORE_TEST_VAR: "injected-value" },
      })
    );

    const delta = events.find((e) => e.type === EventType.MessageDelta) as RunloopEvent & { content?: string };
    expect(delta?.content).toContain("injected-value");
  });
});
