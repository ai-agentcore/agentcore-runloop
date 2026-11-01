import { describe, it, expect } from "vitest";
import { createApp } from "@/server/index.js";
import { LoopRunner } from "@/loop/runner.js";

describe("Conversation ID and Run ID in response headers", () => {
  it("returns X-Conversation-Id and X-Run-Id headers on /v1/run", async () => {
    const runner = new LoopRunner({ allowUnregisteredAgents: true, defaultAdapterType: "cli" });
    const app = createApp(runner);

    const res = await app.request("/v1/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: { cli: "echo" },
        model: { provider: "t", model: "t", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" },
        credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
        events: [{ type: "user.message", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Conversation-Id")).toBeDefined();
    expect(res.headers.get("X-Conversation-Id")!.length).toBeGreaterThan(0);
    expect(res.headers.get("X-Run-Id")).toBeDefined();
    expect(res.headers.get("X-Run-Id")!.length).toBeGreaterThan(0);
  });

  it("uses provided conversationId and runId in headers", async () => {
    const runner = new LoopRunner({ allowUnregisteredAgents: true, defaultAdapterType: "cli" });
    const app = createApp(runner);

    const res = await app.request("/v1/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: "my-conv-123",
        runId: "my-run-456",
        agent: { cli: "echo" },
        model: { provider: "t", model: "t", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" },
        credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
        events: [{ type: "user.message", content: "hello" }],
      }),
    });

    expect(res.headers.get("X-Conversation-Id")).toBe("my-conv-123");
    expect(res.headers.get("X-Run-Id")).toBe("my-run-456");
  });

  it("run.start event contains conversationId", async () => {
    const runner = new LoopRunner({ allowUnregisteredAgents: true, defaultAdapterType: "cli" });
    const app = createApp(runner);

    const res = await app.request("/v1/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: "header-test",
        agent: { cli: "echo" },
        model: { provider: "t", model: "t", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" },
        credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
        events: [{ type: "user.message", content: "hello" }],
      }),
    });

    const body = await res.text();
    const firstDataLine = body
      .split("\n")
      .find((l) => l.startsWith("data: "));
    const firstEvent = JSON.parse(firstDataLine!.slice(6));

    expect(res.headers.get("X-Conversation-Id")).toBe("header-test");
    expect(firstEvent.conversationId).toBe("header-test");
  });
});
