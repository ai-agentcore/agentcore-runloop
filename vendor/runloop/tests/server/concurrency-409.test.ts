import { describe, it, expect } from "vitest";
import { createApp } from "@/server/index.js";
import { LoopRunner } from "@/loop/runner.js";

describe("POST /v1/run — concurrency 409 (L-029)", () => {
  it("rejects a second run for a conversationId that already has a running run", async () => {
    const runner = new LoopRunner({ allowUnregisteredAgents: true, defaultAdapterType: "cli" });
    const app = createApp(runner);

    // simulate an in-flight run for conv-x
    const state = runner.getRunManager().create("conv-x");
    state.status = "running";

    const res = await app.request("/v1/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: "conv-x",
        agent: { cli: "echo" },
        events: [{ type: "user.message", content: "hi" }],
        model: { provider: "test", model: "m", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" },
        credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
      }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(String(body.error)).toContain("conv-x");
  });

  it("allows a run for a conversationId with no running run", async () => {
    const runner = new LoopRunner({ allowUnregisteredAgents: true, defaultAdapterType: "cli" });
    const app = createApp(runner);
    const res = await app.request("/v1/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: "conv-fresh",
        agent: { cli: "echo" },
        events: [{ type: "user.message", content: "hi" }],
        model: { provider: "test", model: "m", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" },
        credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
      }),
    });
    expect(res.status).toBe(200);
  });
});
