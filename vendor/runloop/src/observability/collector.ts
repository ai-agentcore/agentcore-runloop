
import { MetricsRegistry, type Counter, type Gauge, type Histogram } from "./registry.js";

const NS = "agentcore_runloop";

// HTTP 时延桶（秒）：标准 web 请求量级。
const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
// agent 执行时延桶（秒）：run / tool 可能跑很久，桶范围拉到 10 分钟。
const AGENT_BUCKETS = [0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600];

export interface HttpObservation {
  method: string;
  route: string;
  statusClass: string;
  errorType: string;
  durationSeconds: number;
}

export interface RunObservation {
  agentCli: string;
  status: string;
  errorType: string;
  durationSeconds?: number;
}

export interface ToolCallObservation {
  toolType: string;
  status: string;
  errorType: string;
  durationSeconds?: number;
}

export interface UsageObservation {
  agentCli: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

export class MetricsCollector {
  private httpRequests: Counter;
  private httpDuration: Histogram;
  private events: Counter;
  private runs: Counter;
  private runDuration: Histogram;
  private toolCalls: Counter;
  private toolDuration: Histogram;
  private turns: Counter;
  private activeRuns: Gauge;
  private llmTokens: Counter;
  private llmCostUsd: Counter;

  constructor(registry: MetricsRegistry) {
    this.httpRequests = registry.counter(
      `${NS}_http_requests_total`,
      "Total HTTP requests handled by runloop.",
      ["method", "route", "status_class", "error_type"],
    );
    this.httpDuration = registry.histogram(
      `${NS}_http_request_duration_seconds`,
      "HTTP request duration in seconds.",
      ["method", "route", "status_class"],
      HTTP_BUCKETS,
    );
    this.events = registry.counter(
      `${NS}_events_total`,
      "Total runloop events emitted, by event type.",
      ["event_type"],
    );
    this.runs = registry.counter(
      `${NS}_runs_total`,
      "Total agent runs, by agent CLI and terminal status.",
      ["agent_cli", "status", "error_type"],
    );
    this.runDuration = registry.histogram(
      `${NS}_run_duration_seconds`,
      "Agent run duration in seconds (run.start to run.end).",
      ["agent_cli", "status"],
      AGENT_BUCKETS,
    );
    this.toolCalls = registry.counter(
      `${NS}_tool_calls_total`,
      "Total tool calls, by tool type and status.",
      ["tool_type", "status", "error_type"],
    );
    this.toolDuration = registry.histogram(
      `${NS}_tool_call_duration_seconds`,
      "Tool call duration in seconds (toolcall.start to toolresult.end).",
      ["tool_type", "status"],
      AGENT_BUCKETS,
    );
    this.turns = registry.counter(`${NS}_turns_total`, "Total completed agent turns.");
    this.activeRuns = registry.gauge(`${NS}_active_runs`, "Number of in-flight agent runs.");
    this.llmTokens = registry.counter(
      `${NS}_llm_tokens_total`,
      "Total LLM tokens consumed, by agent CLI, model and token kind (input/output/cache_read/cache_write).",
      ["agent_cli", "model", "kind"],
    );
    this.llmCostUsd = registry.counter(
      `${NS}_llm_cost_usd_total`,
      "Total LLM cost in USD as reported by the agent CLI, by agent CLI and model.",
      ["agent_cli", "model"],
    );
  }

  observeHttp(o: HttpObservation): void {
    this.httpRequests.inc({
      method: o.method,
      route: o.route,
      status_class: o.statusClass,
      error_type: o.errorType,
    });
    this.httpDuration.observe(
      { method: o.method, route: o.route, status_class: o.statusClass },
      o.durationSeconds,
    );
  }

  observeEvent(eventType: string): void {
    this.events.inc({ event_type: eventType });
  }

  observeRun(o: RunObservation): void {
    this.runs.inc({ agent_cli: o.agentCli, status: o.status, error_type: o.errorType });
    if (o.durationSeconds != null) {
      this.runDuration.observe({ agent_cli: o.agentCli, status: o.status }, o.durationSeconds);
    }
  }

  observeToolCall(o: ToolCallObservation): void {
    this.toolCalls.inc({ tool_type: o.toolType, status: o.status, error_type: o.errorType });
    if (o.durationSeconds != null) {
      this.toolDuration.observe({ tool_type: o.toolType, status: o.status }, o.durationSeconds);
    }
  }

  observeTurn(): void {
    this.turns.inc();
  }

  observeUsage(o: UsageObservation): void {
    const base = { agent_cli: o.agentCli, model: o.model };
    // Counter.inc 已忽略非有限值；token 字段缺省时跳过，避免凭空记 0 序列。
    if (o.inputTokens != null) this.llmTokens.inc({ ...base, kind: "input" }, o.inputTokens);
    if (o.outputTokens != null) this.llmTokens.inc({ ...base, kind: "output" }, o.outputTokens);
    if (o.cacheReadTokens != null)
      this.llmTokens.inc({ ...base, kind: "cache_read" }, o.cacheReadTokens);
    if (o.cacheWriteTokens != null)
      this.llmTokens.inc({ ...base, kind: "cache_write" }, o.cacheWriteTokens);
    if (o.costUsd != null) this.llmCostUsd.inc(base, o.costUsd);
  }

  incActiveRuns(): void {
    this.activeRuns.inc();
  }

  decActiveRuns(): void {
    this.activeRuns.dec();
  }
}

export interface Metrics {
  registry: MetricsRegistry;
  collector: MetricsCollector;
}

export function createMetrics(): Metrics {
  const registry = new MetricsRegistry();
  const collector = new MetricsCollector(registry);
  return { registry, collector };
}
