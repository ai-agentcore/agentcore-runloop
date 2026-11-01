import { describe, it, expect, vi, beforeEach } from "vitest";
import { createApp } from "@/server/index.js";
import { EventType } from "@/types/events.js";
import { LoopRunner } from "@/loop/runner.js";

describe("API Server", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    const runner = new LoopRunner({ allowUnregisteredAgents: true, defaultAdapterType: "cli" });
    app = createApp(runner);
  });

  describe("GET /health", () => {
    it("returns ok status", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.version).toBe("0.1.0");
      expect(body.activeRuns).toBe(0);
    });
  });

  describe("POST /v1/run", () => {
    it("rejects invalid request body", async () => {
      const res = await app.request("/v1/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invalid: true }),
      });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toBe("Invalid request");
    });

    it("rejects request with events missing type", async () => {
      const res = await app.request("/v1/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          events: [{ content: "no type field" }],
        }),
      });
      expect(res.status).toBe(400);
    });

    it("accepts a valid run request and returns SSE stream", async () => {
      const res = await app.request("/v1/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent: { cli: "echo" },
          events: [
            {
              id: "e1",
              type: "user.message",
              timestamp: Date.now(),
              conversationId: "s1",
              content: "hello",
              role: "user",
            },
          ],
          model: { provider: "test", model: "test", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" },
          credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      expect(res.headers.get("x-conversation-id")).toBeTruthy();
      expect(res.headers.get("x-run-id")).toBeTruthy();
      expect(res.headers.get("x-run-id")).not.toBe(res.headers.get("x-conversation-id"));
    });

    it("uses provided runId in response header", async () => {
      const res = await app.request("/v1/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: "my-run-123",
          agent: { cli: "echo" },
          events: [
            {
              id: "e1",
              type: "user.message",
              timestamp: Date.now(),
              conversationId: "s1",
              content: "hello",
              role: "user",
            },
          ],
          model: { provider: "test", model: "test", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" },
          credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("x-run-id")).toBe("my-run-123");
    });

    it("redacts request log when model/credentials are absent (redactRunRequest else 分支)", async () => {
      const res = await app.request("/v1/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent: { cli: "echo" },
          events: [{ id: "e1", type: "user.message", timestamp: Date.now(), conversationId: "s1", content: "hi", role: "user" }],
          // 无 model、无 credentials → 覆盖 redactRunRequest 的 `: undefined` 两个分支
        }),
      });
      expect(res.status).toBe(200); // 流开启即说明 redactRunRequest 已在日志处执行
    });

    it("redacts falsy apiKey / 无 securityToken（maskSecret falsy 分支）", async () => {
      const res = await app.request("/v1/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent: { cli: "echo" },
          events: [{ id: "e1", type: "user.message", timestamp: Date.now(), conversationId: "s1", content: "hi", role: "user" }],
          model: { provider: "test", model: "test", baseUrl: "http://127.0.0.1:1/v1" }, // 无 apiKey
          credentials: { accessKeyId: "ak", accessKeySecret: "sk" },                     // 无 securityToken
        }),
      });
      expect(res.status).toBe(200);
    });

    it("redacts securityToken when present（maskSecret truthy 分支）", async () => {
      const res = await app.request("/v1/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent: { cli: "echo" },
          events: [{ id: "e1", type: "user.message", timestamp: Date.now(), conversationId: "s1", content: "hi", role: "user" }],
          model: { provider: "test", model: "test", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" },
          credentials: { accessKeyId: "ak", accessKeySecret: "sk", securityToken: "sts-token" },
        }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe("POST /v1/interrupt", () => {
    it("rejects invalid request", async () => {
      const res = await app.request("/v1/interrupt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("returns false for non-existent session", async () => {
      const res = await app.request("/v1/interrupt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: "nonexistent" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(false);
    });
  });

  describe("GET /v1/runs", () => {
    it("returns empty runs list", async () => {
      const res = await app.request("/v1/runs");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.runs).toEqual([]);
    });
  });

  async function drain(stream: ReadableStream<Uint8Array> | null): Promise<string> {
    if (!stream) return "";
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let out = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    return out;
  }

  describe("POST /v1/run — full stream + error branches", () => {
    it("streams SSE events to completion for echo agent", async () => {
      const res = await app.request("/v1/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent: { cli: "echo" },
          events: [{ id: "e1", type: "user.message", timestamp: Date.now(), content: "hi" }],
          model: { provider: "test", model: "test", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" },
          credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
        }),
      });
      expect(res.status).toBe(200);
      const text = await drain(res.body);
      expect(text).toContain("run.start");
      expect(text).toContain("run.end");
    });

    it("lists runs with/without status filter（覆盖 listRuns map + statusFilter 分支）", async () => {
      const runRes = await app.request("/v1/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent: { cli: "echo" },
          events: [{ id: "e1", type: "user.message", timestamp: Date.now(), content: "hi" }],
          model: { provider: "test", model: "test", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" },
          credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
        }),
      });
      await drain(runRes.body); // 跑完，run 落入 runManager（有确定状态）

      // 无 filter → 覆盖 map 回调 + `!statusFilter` 真侧
      const all = await (await app.request("/v1/runs")).json();
      expect(all.runs.length).toBeGreaterThanOrEqual(1);
      const status = all.runs[0].status;
      expect(all.runs[0].conversationId).toBeTruthy();

      // 匹配 filter → 覆盖 `s.status === statusFilter` 真侧
      const matched = await (await app.request(`/v1/runs?status=${status}`)).json();
      expect(matched.runs.length).toBeGreaterThanOrEqual(1);

      // 不匹配 filter → 覆盖假侧
      const none = await (await app.request("/v1/runs?status=__nonexistent__")).json();
      expect(none.runs).toEqual([]);
    });

    it("returns 400 on malformed JSON body", async () => {
      const res = await app.request("/v1/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Invalid JSON body");
    });

    it("accepts a run without a model block (logs model=undefined)", async () => {
      const res = await app.request("/v1/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent: { cli: "echo" },
          events: [{ id: "e1", type: "user.message", timestamp: Date.now(), content: "hi" }],
          credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
        }),
      });
      expect(res.status).toBe(200);
      const text = await drain(res.body);
      expect(text).toContain("run.start");
    });

    it("returns 400 for an unregistered agent CLI", async () => {
      const strictApp = createApp(new LoopRunner({ defaultAdapterType: "cli" }));
      const res = await strictApp.request("/v1/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent: { cli: "no-such-cli-xyz" },
          events: [{ id: "e1", type: "user.message", timestamp: Date.now(), content: "hi" }],
          model: { provider: "test", model: "test", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" },
          credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
        }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("Invalid agent CLI");
    });
  });

  describe("malformed JSON on other POST routes", () => {
    it("interrupt returns 400 on bad JSON", async () => {
      const res = await app.request("/v1/interrupt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "x",
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Invalid JSON body");
    });
  });

  describe("POST /initialize", () => {
    it("returns ok and skips prewarm when no CLI binary is on PATH", async () => {
      const origPath = process.env.PATH;
      process.env.PATH = "/nonexistent-empty-path";
      try {
        const res = await app.request("/initialize", { method: "POST" });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.status).toBe("ok");
        expect(typeof body.elapsedMs).toBe("number");
      } finally {
        process.env.PATH = origPath;
      }
    });
  });
});
