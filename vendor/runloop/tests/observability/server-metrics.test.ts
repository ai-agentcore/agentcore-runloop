import { describe, it, expect, afterEach } from "vitest";
import { createApp } from "@/server/index.js";
import { LoopRunner } from "@/loop/runner.js";

const KEYS = [
  "AGENTCORE_METRICS_ENABLED",
  "AGENTCORE_METRICS_PATH",
  "AGENTCORE_METRICS_HTTP_ENABLED",
  "AGENTCORE_METRICS_EVENTS_ENABLED",
] as const;

function appWithEnv(env: Record<string, string>) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  const runner = new LoopRunner({ allowUnregisteredAgents: true, defaultAdapterType: "cli" });
  const app = createApp(runner);
  // restore immediately — createApp已读取完env
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  return app;
}

describe("createApp metrics endpoint", () => {
  afterEach(() => {
    for (const k of KEYS) delete process.env[k];
  });

  it("exposes /metrics with Prometheus text when enabled", async () => {
    const app = appWithEnv({ AGENTCORE_METRICS_ENABLED: "true" });
    const res = await app.request("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  it("returns 404 for /metrics when disabled (default)", async () => {
    const app = appWithEnv({});
    const res = await app.request("/metrics");
    expect(res.status).toBe(404);
  });

  it("honors a custom metrics path", async () => {
    const app = appWithEnv({ AGENTCORE_METRICS_ENABLED: "1", AGENTCORE_METRICS_PATH: "/internal/metrics" });
    expect((await app.request("/internal/metrics")).status).toBe(200);
    expect((await app.request("/metrics")).status).toBe(404);
  });

  it("HTTP RED records show up after a request when enabled", async () => {
    const app = appWithEnv({ AGENTCORE_METRICS_ENABLED: "true" });
    await app.request("/health");
    const body = await (await app.request("/metrics")).text();
    expect(body).toContain('agentrun_runloop_http_requests_total{method="GET",route="/health"');
  });

  it("can disable HTTP middleware but keep the endpoint", async () => {
    const app = appWithEnv({ AGENTCORE_METRICS_ENABLED: "true", AGENTCORE_METRICS_HTTP_ENABLED: "false" });
    await app.request("/health");
    const body = await (await app.request("/metrics")).text();
    expect(body).not.toContain("agentrun_runloop_http_requests_total");
  });

  it("derives run/event metrics from a real SSE run when enabled", async () => {
    const app = appWithEnv({ AGENTCORE_METRICS_ENABLED: "true" });
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
    // 必须排空 SSE 流，事件 observer 才会跑完整个 run。
    await drain(res.body);

    const body = await (await app.request("/metrics")).text();
    expect(body).toContain('agentrun_runloop_events_total{event_type="run.start"} 1');
    expect(body).toContain("agentrun_runloop_runs_total{agent_cli=\"echo\"");
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
