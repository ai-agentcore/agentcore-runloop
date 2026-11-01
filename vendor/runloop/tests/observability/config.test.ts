import { describe, it, expect } from "vitest";
import { configFromEnv } from "@/observability/config.js";

describe("configFromEnv", () => {
  it("defaults: disabled, /metrics, http+events on", () => {
    const c = configFromEnv({});
    expect(c).toEqual({
      enabled: false,
      path: "/metrics",
      httpEnabled: true,
      eventsEnabled: true,
    });
  });

  it("parses truthy enabled variants", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on"]) {
      expect(configFromEnv({ AGENTCORE_METRICS_ENABLED: v }).enabled).toBe(true);
    }
    for (const v of ["0", "false", "no", "", "  "]) {
      expect(configFromEnv({ AGENTCORE_METRICS_ENABLED: v }).enabled).toBe(false);
    }
  });

  it("honors path override and falls back on blank", () => {
    expect(configFromEnv({ AGENTCORE_METRICS_PATH: "/m" }).path).toBe("/m");
    expect(configFromEnv({ AGENTCORE_METRICS_PATH: "  " }).path).toBe("/metrics");
  });

  it("http/events flags default true and can be disabled", () => {
    expect(configFromEnv({ AGENTCORE_METRICS_HTTP_ENABLED: "false" }).httpEnabled).toBe(false);
    expect(configFromEnv({ AGENTCORE_METRICS_EVENTS_ENABLED: "0" }).eventsEnabled).toBe(false);
  });
});
