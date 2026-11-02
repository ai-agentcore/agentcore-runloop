import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createMetrics } from "@/observability/collector.js";
import { metricsHandler, metricsHttpMiddleware } from "@/observability/http.js";

describe("metricsHttpMiddleware", () => {
  it("records RED metrics for handled requests", async () => {
    const { registry, collector } = createMetrics();
    const app = new Hono();
    app.use(metricsHttpMiddleware(collector, "/metrics"));
    app.get("/v1/runs", (c) => c.json({ ok: true }));
    app.get("/missing", (c) => c.json({ e: 1 }, 404));

    await app.request("/v1/runs");
    await app.request("/missing");

    const out = registry.render();
    expect(out).toContain('agentcore_runloop_http_requests_total{method="GET",route="/v1/runs",status_class="2xx",error_type="none"} 1');
    expect(out).toContain('agentcore_runloop_http_requests_total{method="GET",route="/missing",status_class="4xx",error_type="not_found"} 1');
  });

  it("does not measure the scrape endpoint itself", async () => {
    const { registry, collector } = createMetrics();
    const app = new Hono();
    app.use(metricsHttpMiddleware(collector, "/metrics"));
    app.get("/metrics", metricsHandler(registry));

    await app.request("/metrics");
    // No http_requests_total series should exist for the scrape.
    expect(registry.render()).not.toContain("agentcore_runloop_http_requests_total");
  });

  it("metricsHandler returns Prometheus text content-type", async () => {
    const { registry, collector } = createMetrics();
    collector.observeEvent("run.start");
    const app = new Hono();
    app.get("/metrics", metricsHandler(registry));
    const res = await app.request("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain('agentcore_runloop_events_total{event_type="run.start"} 1');
  });
});
