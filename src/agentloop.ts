import { performance } from "node:perf_hooks";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  createEntryInvocation,
  createExecuteToolInvocation,
  createInvokeAgentInvocation,
  createLLMInvocation,
  createReactStepInvocation,
  ExtendedTelemetryHandler,
  type EntryInvocation,
  type ExecuteToolInvocation,
  type InvokeAgentInvocation,
  type LLMInvocation,
  type OutputMessage,
  type ReactStepInvocation,
} from "@loongsuite/otel-util-genai";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { RunloopEvent } from "../vendor/runloop/src/types/events.js";
import type { StartupTiming } from "./startup-timing.js";

const OTLP_HTTP_PATH = "/apm/trace/opentelemetry/v1/traces";
const SAFE_ERROR_TYPE = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const DEFAULT_EXPORT_TIMEOUT_MS = 3_000;
const DEFAULT_FLUSH_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_CONTENT_LENGTH = 8_192;

export interface AgentLoopConfig {
  enabled: boolean;
  disabledReason?: string;
  endpoint?: string;
  environment: string;
  licenseKey?: string;
  project?: string;
  serviceName: string;
  serviceVersion: string;
  workspace?: string;
  captureContent: boolean;
  maxContentLength: number;
  exportTimeoutMs: number;
  flushTimeoutMs: number;
}

export interface AgentLoopRunInput {
  conversationId: string;
  runId: string;
  userId: string;
  model?: string;
  input?: string;
}

export interface AgentLoopRunObservation {
  observe(event: RunloopEvent): void;
  finish(reason?: string): void;
}

export interface AgentLoopTelemetry {
  readonly state: "enabled" | "disabled" | "degraded";
  readonly reason?: string;
  startRun(input: AgentLoopRunInput): AgentLoopRunObservation;
  recordStartupTiming?(timing: StartupTiming): boolean;
  shutdown(): Promise<void>;
}

type SafeLog = (code: string, detail?: Record<string, string | number | boolean>) => void;

function safeLog(code: string, detail: Record<string, string | number | boolean> = {}): void {
  try {
    console.warn(JSON.stringify({
      service: "agentcore-runloop",
      component: "agentloop",
      code,
      ...detail,
    }));
  } catch {
    // Observability must never affect the application, including its logging path.
  }
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalText(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value || undefined;
}

function enabledValue(raw: string | undefined): boolean | undefined {
  if (raw === undefined || !raw.trim()) return undefined;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(value)) return true;
  if (["0", "false", "off", "no"].includes(value)) return false;
  return undefined;
}

export function normalizeAgentLoopEndpoint(raw: string, allowInsecure = false): string {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(candidate);
  if (url.username || url.password) throw new Error("credentials_in_endpoint");
  if (url.protocol !== "https:" && !(allowInsecure && url.protocol === "http:")) {
    throw new Error("insecure_endpoint");
  }
  if (url.pathname === "/" || url.pathname === "") url.pathname = OTLP_HTTP_PATH;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** Parse AgentLoop settings without ever making application configuration fail. */
export function loadAgentLoopConfig(env: NodeJS.ProcessEnv): AgentLoopConfig {
  const endpointRaw = optionalText(env.AGENTCORE_AGENTLOOP_ENDPOINT);
  const licenseKey = optionalText(env.AGENTCORE_AGENTLOOP_LICENSE_KEY);
  const project = optionalText(env.AGENTCORE_AGENTLOOP_PROJECT);
  const workspace = optionalText(env.AGENTCORE_AGENTLOOP_WORKSPACE);
  const serviceName = optionalText(env.AGENTCORE_AGENTLOOP_SERVICE_NAME) ?? "agentcore-runloop";
  const serviceVersion = optionalText(env.AGENTCORE_AGENTLOOP_SERVICE_VERSION) ?? "unknown";
  const environment = optionalText(env.AGENTCORE_AGENTLOOP_ENVIRONMENT) ?? "production";
  const explicitEnabled = enabledValue(env.AGENTCORE_AGENTLOOP_ENABLED);
  const captureContent = enabledValue(env.AGENTCORE_AGENTLOOP_CAPTURE_CONTENT) === true;
  const allowInsecure = enabledValue(env.AGENTCORE_AGENTLOOP_ALLOW_INSECURE) === true;
  const missing = [
    ["endpoint", endpointRaw],
    ["license_key", licenseKey],
    ["project", project],
    ["workspace", workspace],
  ].filter(([, value]) => !value).map(([name]) => name);

  const base = {
    environment,
    licenseKey,
    project,
    serviceName,
    serviceVersion,
    workspace,
    captureContent,
    maxContentLength: positiveInteger(env.AGENTCORE_AGENTLOOP_MAX_CONTENT_LENGTH, DEFAULT_MAX_CONTENT_LENGTH),
    exportTimeoutMs: positiveInteger(env.AGENTCORE_AGENTLOOP_EXPORT_TIMEOUT_MS, DEFAULT_EXPORT_TIMEOUT_MS),
    flushTimeoutMs: positiveInteger(env.AGENTCORE_AGENTLOOP_FLUSH_TIMEOUT_MS, DEFAULT_FLUSH_TIMEOUT_MS),
  };

  if (explicitEnabled === false) return { ...base, enabled: false, disabledReason: "explicitly_disabled" };
  if (missing.length > 0) {
    return { ...base, enabled: false, disabledReason: `missing_${missing.join("_")}` };
  }
  try {
    return { ...base, enabled: true, endpoint: normalizeAgentLoopEndpoint(endpointRaw!, allowInsecure) };
  } catch (error) {
    const reason = error instanceof Error && SAFE_ERROR_TYPE.test(error.message)
      ? error.message
      : "invalid_endpoint";
    return { ...base, enabled: false, disabledReason: reason };
  }
}

class DisabledAgentLoopTelemetry implements AgentLoopTelemetry {
  readonly state = "disabled" as const;
  constructor(readonly reason?: string) {}
  startRun(): AgentLoopRunObservation { return NOOP_RUN; }
  recordStartupTiming(): boolean { return false; }
  async shutdown(): Promise<void> {}
}

const NOOP_RUN: AgentLoopRunObservation = {
  observe() {},
  finish() {},
};

class SafeExporter implements SpanExporter {
  private nextLogAt = 0;
  constructor(private readonly inner: SpanExporter, private readonly log: SafeLog) {}

  export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter["export"]>[1]): void {
    const done: Parameters<SpanExporter["export"]>[1] = result => {
      if (result.code !== 0 && Date.now() >= this.nextLogAt) {
        this.nextLogAt = Date.now() + 60_000;
        this.log("export_failed", { spanCount: spans.length });
      }
      // Treat exporter failures as handled so they never surface into the service path.
      resultCallback({ code: 0 });
    };
    try {
      this.inner.export(spans, done);
    } catch {
      done({ code: 1 });
    }
  }

  async shutdown(): Promise<void> {
    try { await this.inner.shutdown(); } catch { this.log("exporter_shutdown_failed"); }
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[truncated]`;
}

function serialize(value: unknown, max: number): string {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return truncate(text ?? "null", max);
  } catch {
    return "[unserializable]";
  }
}

function outputMessage(content: string, reason: string): OutputMessage[] {
  return [{
    role: "assistant",
    parts: [{ type: "text", content }],
    finishReason: reason,
  }];
}

function safeError(type: string | undefined, message: string) {
  return {
    type: type && SAFE_ERROR_TYPE.test(type) ? type : "AgentLoopObservationError",
    message,
  };
}

class OTelRunObservation implements AgentLoopRunObservation {
  private entry: EntryInvocation;
  private agent: InvokeAgentInvocation;
  private step?: ReactStepInvocation;
  private llm?: LLMInvocation;
  private readonly tools = new Map<string, ExecuteToolInvocation>();
  private output = "";
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private ended = false;

  constructor(
    private readonly handler: ExtendedTelemetryHandler,
    private readonly config: AgentLoopConfig,
    private readonly input: AgentLoopRunInput,
    private readonly log: SafeLog,
  ) {
    const inputMessages = config.captureContent && input.input
      ? [{ role: "user", parts: [{ type: "text" as const, content: truncate(input.input, config.maxContentLength) }] }]
      : undefined;
    this.entry = createEntryInvocation({
      agentName: config.serviceName,
      sessionId: input.conversationId,
      userId: input.userId,
      inputMessages,
      passthroughAttributes: { "runloop.run.id": input.runId },
    });
    this.handler.startEntry(this.entry);
    this.agent = createInvokeAgentInvocation("agentcore", {
      agentName: config.serviceName,
      agentDescription: "AgentCore Runloop execution agent",
      conversationId: input.conversationId,
      requestModel: input.model,
      sessionId: input.conversationId,
      userId: input.userId,
      inputMessages,
      passthroughAttributes: { "runloop.run.id": input.runId },
    });
    this.handler.startInvokeAgent(this.agent, this.entry.contextToken!);
  }

  observe(event: RunloopEvent): void {
    if (this.ended) return;
    try { this.observeUnsafe(event); } catch { this.log("event_observation_failed", { eventType: event.type }); }
  }

  private observeUnsafe(event: RunloopEvent): void {
    switch (event.type) {
      case "turn.start":
        this.closeTurn("stop", event.timestamp);
        this.step = createReactStepInvocation({ round: event.turnIndex + 1 });
        this.handler.startReactStep(this.step, this.agent.contextToken!, event.timestamp);
        this.llm = createLLMInvocation({
          provider: "agentcore",
          operationName: "chat",
          requestModel: this.input.model ?? "unknown",
          agentName: this.config.serviceName,
          sessionId: this.input.conversationId,
          userId: this.input.userId,
        });
        this.handler.startLlm(this.llm, this.step.contextToken!, event.timestamp);
        break;
      case "message.delta":
        if (this.llm && this.llm.monotonicFirstTokenS == null) {
          this.llm.monotonicFirstTokenS = performance.now() / 1_000;
        }
        if (this.config.captureContent && event.content) {
          this.output = truncate(this.output + event.content, this.config.maxContentLength);
        }
        break;
      case "run.usage": {
        const input = event.inputTokens ?? 0;
        const output = event.outputTokens ?? 0;
        this.inputTokens += input;
        this.outputTokens += output;
        this.cacheReadTokens += event.cacheReadTokens ?? 0;
        this.cacheWriteTokens += event.cacheWriteTokens ?? 0;
        if (this.llm) {
          this.llm.inputTokens = (this.llm.inputTokens ?? 0) + input;
          this.llm.outputTokens = (this.llm.outputTokens ?? 0) + output;
          this.llm.totalTokens = (this.llm.inputTokens ?? 0) + (this.llm.outputTokens ?? 0);
          this.llm.usageCacheReadInputTokens = (this.llm.usageCacheReadInputTokens ?? 0) + (event.cacheReadTokens ?? 0);
          this.llm.usageCacheCreationInputTokens = (this.llm.usageCacheCreationInputTokens ?? 0) + (event.cacheWriteTokens ?? 0);
        }
        break;
      }
      case "toolcall.start": {
        const tool = createExecuteToolInvocation(event.toolName, {
          toolCallId: event.toolCallId,
          toolType: "function",
          agentName: this.config.serviceName,
          sessionId: this.input.conversationId,
          userId: this.input.userId,
        });
        this.handler.startExecuteTool(tool, this.step?.contextToken ?? this.agent.contextToken!, event.timestamp);
        this.tools.set(event.toolCallId, tool);
        break;
      }
      case "toolcall.end": {
        const tool = this.tools.get(event.toolCallId);
        if (tool && this.config.captureContent) {
          tool.toolCallArguments = serialize(event.args, this.config.maxContentLength);
        }
        break;
      }
      case "toolresult.end": {
        const tool = this.tools.get(event.toolCallId);
        if (!tool) break;
        if (this.config.captureContent) tool.toolCallResult = serialize(event.result, this.config.maxContentLength);
        if (event.isError) {
          this.handler.failExecuteTool(tool, safeError("ToolError", "Tool execution failed"), event.timestamp);
        } else {
          this.handler.stopExecuteTool(tool, event.timestamp);
        }
        this.tools.delete(event.toolCallId);
        break;
      }
      case "turn.end":
        this.closeTurn(event.stopReason, event.timestamp);
        break;
      case "run.error":
        this.fail(event.error.code, "Agent execution failed", event.timestamp);
        break;
      case "run.interrupt":
        this.fail("AgentInterrupted", "Agent execution was interrupted", event.timestamp);
        break;
      case "run.end":
        if (event.reason === "completed") this.complete(event.timestamp);
        else this.fail(`Run_${event.reason}`, "Agent execution did not complete", event.timestamp);
        break;
    }
  }

  private closeTurn(reason: string, endTime = Date.now()): void {
    for (const [id, tool] of this.tools) {
      if (tool.span?.isRecording()) {
        this.handler.failExecuteTool(tool, safeError("IncompleteToolCall", "Tool execution did not complete"), endTime);
      }
      this.tools.delete(id);
    }
    if (this.llm?.span?.isRecording()) {
      this.llm.finishReasons = [reason];
      if (this.config.captureContent && this.output) this.llm.outputMessages = outputMessage(this.output, reason);
      this.handler.stopLlm(this.llm, endTime);
    }
    if (this.step?.span?.isRecording()) {
      this.step.finishReason = reason;
      this.handler.stopReactStep(this.step, endTime);
    }
    this.llm = undefined;
    this.step = undefined;
  }

  private setFinalValues(reason: string): void {
    this.agent.inputTokens = this.inputTokens;
    this.agent.outputTokens = this.outputTokens;
    this.agent.totalTokens = this.inputTokens + this.outputTokens;
    this.agent.usageCacheReadInputTokens = this.cacheReadTokens;
    this.agent.usageCacheCreationInputTokens = this.cacheWriteTokens;
    this.agent.finishReasons = [reason];
    if (this.config.captureContent && this.output) {
      const messages = outputMessage(this.output, reason);
      this.agent.outputMessages = messages;
      this.entry.outputMessages = messages;
    }
  }

  private complete(endTime = Date.now()): void {
    if (this.ended) return;
    this.closeTurn("stop", endTime);
    this.setFinalValues("stop");
    if (this.agent.span?.isRecording()) this.handler.stopInvokeAgent(this.agent, endTime);
    if (this.entry.span?.isRecording()) this.handler.stopEntry(this.entry, endTime);
    this.ended = true;
  }

  private fail(type: string, message: string, endTime = Date.now()): void {
    if (this.ended) return;
    const error = safeError(type, message);
    for (const [id, tool] of this.tools) {
      if (tool.span?.isRecording()) this.handler.failExecuteTool(tool, error, endTime);
      this.tools.delete(id);
    }
    if (this.llm?.span?.isRecording()) this.handler.failLlm(this.llm, error, endTime);
    if (this.step?.span?.isRecording()) this.handler.failReactStep(this.step, error, endTime);
    this.setFinalValues("error");
    if (this.agent.span?.isRecording()) this.handler.failInvokeAgent(this.agent, error, endTime);
    if (this.entry.span?.isRecording()) this.handler.failEntry(this.entry, error, endTime);
    this.ended = true;
  }

  finish(reason = "stream_closed"): void {
    if (this.ended) return;
    try { this.fail("IncompleteRun", reason === "stream_closed" ? "Agent stream closed" : "Agent observation ended"); }
    catch { this.log("run_observation_close_failed"); this.ended = true; }
  }
}

class OTelAgentLoopTelemetry implements AgentLoopTelemetry {
  readonly state = "enabled" as const;
  constructor(
    private readonly config: AgentLoopConfig,
    private readonly provider: NodeTracerProvider,
    private readonly handler: ExtendedTelemetryHandler,
    private readonly log: SafeLog,
  ) {}

  startRun(input: AgentLoopRunInput): AgentLoopRunObservation {
    try { return new OTelRunObservation(this.handler, this.config, input, this.log); }
    catch { this.log("run_observation_start_failed"); return NOOP_RUN; }
  }

  recordStartupTiming(timing: StartupTiming): boolean {
    try {
      const endedAt = Date.now();
      const tracer = this.provider.getTracer("agentcore-startup", this.config.serviceVersion);
      const span = tracer.startSpan(`agentcore.startup.${timing.phase}`, {
        startTime: endedAt - timing.durationMs,
        attributes: {
          "agentcore.startup.phase": timing.phase,
          "agentcore.startup.duration_ms": timing.durationMs,
          "agentcore.startup.status": timing.status,
          "agentcore.startup.cold_start": true,
          ...(timing.resourceKind ? { "agentcore.resource.kind": timing.resourceKind } : {}),
          ...(timing.resource ? { "agentcore.resource.name": timing.resource } : {}),
          ...(timing.errorType ? { "error.type": timing.errorType } : {}),
          ...(timing.errorCode ? { "error.code": timing.errorCode } : {}),
          ...(timing.errorStatus ? { "error.status_code": timing.errorStatus } : {}),
          ...(timing.errorRequestId ? { "error.request_id": timing.errorRequestId } : {}),
          ...(timing.causeType ? { "error.cause.type": timing.causeType } : {}),
          ...(timing.causeCode ? { "error.cause.code": timing.causeCode } : {}),
          ...(timing.causeStatus ? { "error.cause.status_code": timing.causeStatus } : {}),
          ...(timing.causeRequestId ? { "error.cause.request_id": timing.causeRequestId } : {}),
        },
      });
      span.setStatus({ code: timing.status === "ok" ? SpanStatusCode.OK : SpanStatusCode.ERROR });
      span.end(endedAt);
      return true;
    } catch {
      this.log("startup_timing_failed", { phase: timing.phase });
      return false;
    }
  }

  async shutdown(): Promise<void> {
    const settle = async (operation: Promise<unknown>) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          operation,
          new Promise<void>(resolve => { timer = setTimeout(resolve, this.config.flushTimeoutMs); }),
        ]);
      } catch {
        this.log("telemetry_shutdown_failed");
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    await settle(this.provider.forceFlush());
    await settle(this.provider.shutdown());
  }
}

export function createAgentLoopTelemetry(
  config: AgentLoopConfig,
  options: { log?: SafeLog; provider?: NodeTracerProvider } = {},
): AgentLoopTelemetry {
  const log = options.log ?? safeLog;
  if (!config.enabled) {
    log("disabled", { reason: config.disabledReason ?? "not_configured" });
    return new DisabledAgentLoopTelemetry(config.disabledReason);
  }
  try {
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN ??= "gen_ai_latest_experimental";
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = config.captureContent
      ? "SPAN_ONLY"
      : "NO_CONTENT";
    const resource = new Resource({
      "service.name": config.serviceName,
      "service.version": config.serviceVersion,
      "deployment.environment": config.environment,
      "deployment.environment.name": config.environment,
      "acs.cms.workspace": config.workspace!,
      "acs.arms.service.feature": "genai_app",
      "gen_ai.instrumentation.sdk.name": "loongsuite-genai-utils",
    });
    const provider = options.provider ?? new NodeTracerProvider({ resource });
    if (!options.provider) {
      const exporter = new SafeExporter(new OTLPTraceExporter({
        url: config.endpoint!,
        headers: {
          "x-arms-license-key": config.licenseKey!,
          "x-arms-project": config.project!,
          "x-cms-workspace": config.workspace!,
        },
        timeoutMillis: config.exportTimeoutMs,
      }), log);
      provider.addSpanProcessor(new BatchSpanProcessor(exporter, {
        maxQueueSize: 2_048,
        maxExportBatchSize: 256,
        scheduledDelayMillis: 5_000,
        exportTimeoutMillis: config.exportTimeoutMs,
      }));
      provider.register();
    }
    const handler = new ExtendedTelemetryHandler({ tracerProvider: provider });
    log("enabled", { captureContent: config.captureContent });
    return new OTelAgentLoopTelemetry(config, provider, handler, log);
  } catch {
    log("initialization_failed");
    return new DisabledAgentLoopTelemetry("initialization_failed");
  }
}
