import { describe, it, expect } from "vitest";
import { compressEvents } from "@/events/compress.js";
import { createApp } from "@/server/index.js";
import { LoopRunner } from "@/loop/runner.js";
import type { RunloopEvent } from "@/types/events.js";

function ev(type: string, extra: Record<string, unknown> = {}): RunloopEvent {
  return { id: extra.id as string ?? "x", type, timestamp: 1, conversationId: "c", ...extra } as RunloopEvent;
}

describe("compress — user.attachment (L-035)", () => {
  it("renders attachment as a text reference into the user turn", () => {
    const msgs = compressEvents([
      ev("user.message", { content: "look at this", role: "user" }),
      ev("user.attachment", { uri: "https://x/img.png", name: "img.png", mimeType: "image/png" }),
    ]);
    const user = msgs.find((m) => m.role === "user");
    expect(user?.content).toContain("look at this");
    expect(user?.content).toContain("[Attachment: img.png (image/png)]");
    expect(user?.content).toContain("https://x/img.png");
  });

  it("attachment-only turn still produces a user message", () => {
    const msgs = compressEvents([ev("user.attachment", { uri: "s3://b/k", role: undefined })]);
    expect(msgs.some((m) => m.role === "user" && m.content.includes("s3://b/k"))).toBe(true);
  });
});

describe("server — traceId resolution (AD-022) + /v1/runs status filter", () => {
  function makeApp() {
    const runner = new LoopRunner({ allowUnregisteredAgents: true, defaultAdapterType: "cli" });
    return { runner, app: createApp(runner) };
  }

  it("resolves traceId from x-fc-request-id and echoes X-Trace-Id", async () => {
    const { app } = makeApp();
    const res = await app.request("/v1/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-fc-request-id": "fc-trace-123" },
      body: JSON.stringify({
        conversationId: "conv-trace",
        agent: { cli: "echo" },
        events: [{ type: "user.message", content: "hi" }],
        model: { provider: "t", model: "m", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" },
        credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
      }),
    });
    expect(res.headers.get("x-trace-id")).toBe("fc-trace-123");
  });

  it("x-trace-id takes precedence over x-fc-request-id", async () => {
    const { app } = makeApp();
    const res = await app.request("/v1/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-trace-id": "primary", "x-fc-request-id": "fallback" },
      body: JSON.stringify({
        conversationId: "conv-trace2",
        agent: { cli: "echo" },
        events: [{ type: "user.message", content: "hi" }],
        model: { provider: "t", model: "m", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" },
        credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
      }),
    });
    expect(res.headers.get("x-trace-id")).toBe("primary");
  });

  it("GET /v1/runs?status=running filters by status", async () => {
    const { runner, app } = makeApp();
    runner.getRunManager().create("r-run").status = "running";
    runner.getRunManager().create("r-done").status = "completed";

    const all = await (await app.request("/v1/runs")).json();
    expect(all.runs.length).toBe(2);

    const running = await (await app.request("/v1/runs?status=running")).json();
    expect(running.runs).toHaveLength(1);
    expect(running.runs[0].conversationId).toBe("r-run");
    expect(running.runs[0].status).toBe("running");
  });
});

describe("RunManager — finished-run reaping", () => {
  it("evicts oldest finished runs beyond the cap, keeps running ones", async () => {
    const { RunManager } = await import("@/loop/run.js");
    const mgr = new RunManager(2);
    const live = mgr.create("live"); live.status = "running";
    const a = mgr.create("a"); a.status = "running"; mgr.complete("a");
    const b = mgr.create("b"); b.status = "running"; mgr.setError("b");
    const c = mgr.create("c"); c.status = "running"; mgr.interrupt("c"); // finished now {a,b,c} > 2 → evict oldest (a)
    expect(mgr.get("a")).toBeUndefined();
    expect(mgr.get("b")).toBeDefined();
    expect(mgr.get("c")).toBeDefined();
    expect(mgr.get("live")).toBeDefined();
  });
});
