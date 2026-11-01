import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  createAgentLoopTelemetry,
  loadAgentLoopConfig,
  normalizeAgentLoopEndpoint,
} from "../src/agentloop.js";
import type { RunloopEvent } from "../vendor/runloop/src/types/events.js";

const completeEnv = {
  AGENTCORE_AGENTLOOP_ENDPOINT: "trace.example.com",
  AGENTCORE_AGENTLOOP_LICENSE_KEY: "test-only-license",
  AGENTCORE_AGENTLOOP_PROJECT: "trace-project",
  AGENTCORE_AGENTLOOP_WORKSPACE: "agentloop-workspace",
  AGENTCORE_AGENTLOOP_SERVICE_NAME: "agentcore-codex",
  AGENTCORE_AGENTLOOP_SERVICE_VERSION: "v0.1.0",
  AGENTCORE_AGENTLOOP_ENVIRONMENT: "production",
};

function event(type: RunloopEvent["type"], data: Record<string, unknown> = {}, timestamp = Date.now()): RunloopEvent {
  return { id: `${type}-${timestamp}`, type, timestamp, conversationId: "conversation-1", runId: "run-1", ...data } as RunloopEvent;
}

afterEach(() => vi.restoreAllMocks());

describe("AgentLoop configuration", () => {
  it("auto-enables only for complete configuration and builds the official HTTP traces path", () => {
    expect(loadAgentLoopConfig(completeEnv)).toMatchObject({
      enabled: true,
      endpoint: "https://trace.example.com/apm/trace/opentelemetry/v1/traces",
      captureContent: false,
    });
    expect(normalizeAgentLoopEndpoint("https://trace.example.com/custom/traces"))
      .toBe("https://trace.example.com/custom/traces");
  });

  it("fails open for partial, disabled, insecure, and malformed observability settings", () => {
    expect(loadAgentLoopConfig({ AGENTCORE_AGENTLOOP_ENDPOINT: "trace.example.com" }))
      .toMatchObject({ enabled: false, disabledReason: expect.stringContaining("missing_") });
    expect(loadAgentLoopConfig({ ...completeEnv, AGENTCORE_AGENTLOOP_ENABLED: "false" }))
      .toMatchObject({ enabled: false, disabledReason: "explicitly_disabled" });
    expect(loadAgentLoopConfig({ ...completeEnv, AGENTCORE_AGENTLOOP_ENDPOINT: "http://trace.example.com" }))
      .toMatchObject({ enabled: false, disabledReason: "insecure_endpoint" });
    expect(() => loadAgentLoopConfig({ ...completeEnv, AGENTCORE_AGENTLOOP_ENDPOINT: "://" })).not.toThrow();
  });

  it("normalizes safe endpoint variants and bounds optional tuning", () => {
    expect(normalizeAgentLoopEndpoint("trace.example.com/?token=secret#fragment"))
      .toBe("https://trace.example.com/apm/trace/opentelemetry/v1/traces");
    expect(normalizeAgentLoopEndpoint("http://127.0.0.1:4318", true))
      .toBe("http://127.0.0.1:4318/apm/trace/opentelemetry/v1/traces");
    expect(() => normalizeAgentLoopEndpoint("https://user:pass@trace.example.com"))
      .toThrow("credentials_in_endpoint");

    expect(loadAgentLoopConfig({
      ...completeEnv,
      AGENTCORE_AGENTLOOP_CAPTURE_CONTENT: "yes",
      AGENTCORE_AGENTLOOP_MAX_CONTENT_LENGTH: "16",
      AGENTCORE_AGENTLOOP_EXPORT_TIMEOUT_MS: "invalid",
      AGENTCORE_AGENTLOOP_FLUSH_TIMEOUT_MS: "-1",
    })).toMatchObject({
      enabled: true,
      captureContent: true,
      maxContentLength: 16,
      exportTimeoutMs: 3_000,
      flushTimeoutMs: 2_000,
    });
  });

  it("keeps disabled telemetry completely inert and safely logs the reason", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const telemetry = createAgentLoopTelemetry(loadAgentLoopConfig({}));
    const observation = telemetry.startRun({ conversationId: "c", runId: "r", userId: "u" });
    expect(() => observation.observe(event("run.start"))).not.toThrow();
    expect(() => observation.finish()).not.toThrow();
    await expect(telemetry.shutdown()).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('"code":"disabled"'));
  });
});

describe("AgentLoop run observation", () => {
  it("emits an Agent insight span tree with tokens and tools without capturing content by default", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    const logs: string[] = [];
    const telemetry = createAgentLoopTelemetry(loadAgentLoopConfig(completeEnv), {
      provider,
      log: code => logs.push(code),
    });
    expect(telemetry.state).toBe("enabled");

    const observation = telemetry.startRun({
      conversationId: "conversation-1",
      runId: "run-1",
      userId: "user-1",
      model: "qwen-plus",
      input: "secret prompt",
    });
    const start = Date.now();
    observation.observe(event("run.start", { agentCli: "codex", model: "qwen-plus" }, start));
    observation.observe(event("turn.start", { turnIndex: 0 }, start + 1));
    observation.observe(event("message.delta", { content: "secret answer" }, start + 2));
    observation.observe(event("toolcall.start", { toolCallId: "tool-1", toolName: "search" }, start + 3));
    observation.observe(event("toolcall.end", { toolCallId: "tool-1", args: { secret: true } }, start + 4));
    observation.observe(event("toolresult.end", { toolCallId: "tool-1", result: "secret result" }, start + 5));
    observation.observe(event("run.usage", { inputTokens: 12, outputTokens: 8 }, start + 6));
    observation.observe(event("turn.end", { turnIndex: 0, stopReason: "end_turn" }, start + 7));
    observation.observe(event("run.end", { reason: "completed" }, start + 8));
    observation.finish();
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    expect(spans.map(span => span.attributes["gen_ai.span.kind"])).toEqual(expect.arrayContaining([
      "ENTRY", "AGENT", "STEP", "LLM", "TOOL",
    ]));
    expect(new Set(spans.map(span => span.spanContext().traceId)).size).toBe(1);
    const byKind = new Map(spans.map(span => [span.attributes["gen_ai.span.kind"], span]));
    expect(byKind.get("AGENT")?.attributes).toMatchObject({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "agentcore-codex",
      "gen_ai.usage.input_tokens": 12,
      "gen_ai.usage.output_tokens": 8,
    });
    expect(byKind.get("TOOL")?.attributes).toMatchObject({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "search",
    });
    const serialized = JSON.stringify(spans.map(span => span.attributes));
    expect(serialized).not.toContain("secret prompt");
    expect(serialized).not.toContain("secret answer");
    expect(serialized).not.toContain("secret result");
    expect(logs).toContain("enabled");
    await provider.shutdown();
  });

  it("appends first-start timing spans without resource contents", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    const telemetry = createAgentLoopTelemetry(loadAgentLoopConfig(completeEnv), { provider, log: vi.fn() });
    expect(telemetry.recordStartupTiming?.({
      phase: "mcp", durationMs: 123.4, status: "timeout", resourceKind: "mcp", resource: "repo-search",
      errorType: "McpDiscoveryTimeoutError", errorCode: "MCP_DISCOVERY_TIMEOUT",
    })).toBe(true);
    await provider.forceFlush();
    const span = exporter.getFinishedSpans().find(item => item.name === "agentcore.startup.mcp");
    expect(span?.attributes).toMatchObject({
      "agentcore.startup.phase": "mcp", "agentcore.startup.duration_ms": 123.4,
      "agentcore.startup.status": "timeout", "agentcore.startup.cold_start": true,
      "agentcore.resource.name": "repo-search", "error.code": "MCP_DISCOVERY_TIMEOUT",
    });
    expect(span?.status.code).toBe(2);
    await provider.shutdown();
  });

  it("contains initialization failures and returns a no-op observer", () => {
    const log = vi.fn();
    const provider = {} as NodeTracerProvider;
    const telemetry = createAgentLoopTelemetry(loadAgentLoopConfig(completeEnv), { provider, log });
    expect(telemetry.state).toBe("disabled");
    expect(() => telemetry.startRun({ conversationId: "c", runId: "r", userId: "u" })).not.toThrow();
    expect(log).toHaveBeenCalledWith("initialization_failed");
  });

  it("captures bounded content and closes failed, incomplete, and nested lifecycle paths", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    const telemetry = createAgentLoopTelemetry(loadAgentLoopConfig({
      ...completeEnv,
      AGENTCORE_AGENTLOOP_CAPTURE_CONTENT: "true",
      AGENTCORE_AGENTLOOP_MAX_CONTENT_LENGTH: "16",
    }), { provider, log: vi.fn() });
    const observation = telemetry.startRun({
      conversationId: "conversation-content",
      runId: "run-content",
      userId: "user-content",
      input: "a prompt that is longer than sixteen characters",
    });
    const start = Date.now();
    observation.observe(event("turn.start", { turnIndex: 0 }, start));
    observation.observe(event("message.delta", { content: "a response that is longer than sixteen characters" }, start + 1));
    observation.observe(event("run.usage", {
      inputTokens: 3,
      outputTokens: 4,
      cacheReadTokens: 5,
      cacheWriteTokens: 6,
    }, start + 2));
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    observation.observe(event("toolcall.start", { toolCallId: "failed", toolName: "write_file" }, start + 3));
    observation.observe(event("toolcall.end", { toolCallId: "failed", args: circular }, start + 4));
    observation.observe(event("toolresult.end", {
      toolCallId: "failed",
      result: { private: "result" },
      isError: true,
    }, start + 5));
    observation.observe(event("toolresult.end", { toolCallId: "missing", result: "ignored" }, start + 6));
    observation.observe(event("toolcall.start", { toolCallId: "incomplete", toolName: "bash" }, start + 7));
    observation.observe(event("turn.start", { turnIndex: 1 }, start + 8));
    observation.observe(event("run.error", {
      error: { code: "bad code with spaces", message: "must not be exported" },
    }, start + 9));
    observation.observe(event("message.delta", { content: "ignored after end" }, start + 10));
    observation.finish("already ended");
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    expect(spans.some(span => span.status.code === 2)).toBe(true);
    const serializedAttributes = JSON.stringify(spans.map(span => span.attributes));
    expect(serializedAttributes).toContain("truncated");
    expect(serializedAttributes).toContain("[unserializable]");
    expect(serializedAttributes).not.toContain("must not be exported");
    const agent = spans.find(span => span.attributes["gen_ai.span.kind"] === "AGENT");
    expect(agent?.attributes).toMatchObject({
      "gen_ai.usage.input_tokens": 3,
      "gen_ai.usage.output_tokens": 4,
    });
    await provider.shutdown();
  });

  it("finishes interrupted and externally closed runs and contains shutdown failures", async () => {
    const logs: string[] = [];
    const provider = new NodeTracerProvider();
    const telemetry = createAgentLoopTelemetry(loadAgentLoopConfig(completeEnv), {
      provider,
      log: code => logs.push(code),
    });
    const interrupted = telemetry.startRun({ conversationId: "c1", runId: "r1", userId: "u1" });
    interrupted.observe(event("run.interrupt", { reason: "cancelled" }));
    interrupted.finish();
    const incomplete = telemetry.startRun({ conversationId: "c2", runId: "r2", userId: "u2" });
    incomplete.finish("caller stopped observation");

    vi.spyOn(provider, "forceFlush").mockRejectedValueOnce(new Error("flush failed"));
    vi.spyOn(provider, "shutdown").mockRejectedValueOnce(new Error("shutdown failed"));
    await expect(telemetry.shutdown()).resolves.toBeUndefined();
    expect(logs.filter(code => code === "telemetry_shutdown_failed")).toHaveLength(2);
  });

  it("contains default OTLP exporter failures without affecting the run", async () => {
    vi.spyOn(OTLPTraceExporter.prototype, "export").mockImplementation((_spans, callback) => {
      callback({ code: 1 });
    });
    vi.spyOn(OTLPTraceExporter.prototype, "shutdown").mockRejectedValue(new Error("shutdown failed"));
    const log = vi.fn();
    const telemetry = createAgentLoopTelemetry(loadAgentLoopConfig(completeEnv), { log });
    const observation = telemetry.startRun({ conversationId: "c", runId: "r", userId: "u" });
    observation.observe(event("run.end", { reason: "completed" }));

    await expect(telemetry.shutdown()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("export_failed", { spanCount: 2 });
    expect(log).toHaveBeenCalledWith("exporter_shutdown_failed");
  });
});
