import { describe, it, expect } from "vitest";
import { createMetrics, type MetricsCollector } from "@/observability/collector.js";
import { instrumentEventStream } from "@/observability/events.js";
import type { RunloopEvent } from "@/types/events.js";

function ev(type: string, fields: Record<string, unknown> = {}, timestamp = 0): RunloopEvent {
  return { id: "e", type, timestamp, conversationId: "c", ...fields } as RunloopEvent;
}

describe("instrumentEventStream", () => {
  it("derives event/tool/turn/run metrics from a full stream", () => {
    const { registry, collector } = createMetrics();
    const observe = instrumentEventStream(collector);

    observe(ev("run.start", { agentCli: "codex" }, 1_000));
    observe(ev("toolcall.start", { toolCallId: "t1", toolName: "mcp__agentcore__bash" }, 2_000));
    observe(ev("toolresult.end", { toolCallId: "t1", isError: false }, 4_000));
    observe(ev("turn.end", { turnIndex: 0 }, 5_000));
    observe(
      ev(
        "run.usage",
        { model: "qwen3.7-max", inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, costUsd: 0.02 },
        6_000,
      ),
    );
    observe(ev("run.end", { reason: "completed" }, 7_000));

    const out = registry.render();
    expect(out).toContain('agentrun_runloop_events_total{event_type="run.start"} 1');
    expect(out).toContain('agentrun_runloop_tool_calls_total{tool_type="exec",status="success",error_type="none"} 1');
    // tool duration 4000-2000 = 2s → falls in le="2" bucket
    expect(out).toContain('agentrun_runloop_tool_call_duration_seconds_bucket{tool_type="exec",status="success",le="2"} 1');
    expect(out).toContain("agentrun_runloop_turns_total 1");
    // usage derived from run.usage, with agentCli carried over from run.start
    expect(out).toContain(
      'agentrun_runloop_llm_tokens_total{agent_cli="codex",model="qwen3.7-max",kind="input"} 100',
    );
    expect(out).toContain(
      'agentrun_runloop_llm_tokens_total{agent_cli="codex",model="qwen3.7-max",kind="output"} 20',
    );
    expect(out).toContain(
      'agentrun_runloop_llm_cost_usd_total{agent_cli="codex",model="qwen3.7-max"} 0.02',
    );
    expect(out).toContain('agentrun_runloop_runs_total{agent_cli="codex",status="success",error_type="none"} 1');
    // run duration 7000-1000 = 6s
    expect(out).toContain('agentrun_runloop_run_duration_seconds_sum{agent_cli="codex",status="success"} 6');
    // active runs back to 0
    expect(out).toContain("agentrun_runloop_active_runs 0");
  });

  it("captures run.error code into the run's error_type label", () => {
    const { registry, collector } = createMetrics();
    const observe = instrumentEventStream(collector);
    observe(ev("run.start", { agentCli: "codex" }, 0));
    observe(ev("run.error", { error: { code: "LOOP_ERROR", message: "boom" } }, 1_000));
    observe(ev("run.end", { reason: "error" }, 2_000));
    expect(registry.render()).toContain(
      'agentrun_runloop_runs_total{agent_cli="codex",status="error",error_type="loop_error"} 1',
    );
  });

  it("tolerates toolresult.end without a matching toolcall.start", () => {
    const { registry, collector } = createMetrics();
    const observe = instrumentEventStream(collector);
    observe(ev("toolresult.end", { toolCallId: "orphan", isError: true }, 100));
    const out = registry.render();
    expect(out).toContain('agentrun_runloop_tool_calls_total{tool_type="unknown",status="failure",error_type="tool_error"} 1');
    // no duration histogram without a start
    expect(out).not.toContain("agentrun_runloop_tool_call_duration_seconds_count");
  });

  it("emits run counter without duration when run.start is absent", () => {
    const { registry, collector } = createMetrics();
    const observe = instrumentEventStream(collector);
    observe(ev("run.end", { reason: "completed" }, 5_000));
    const out = registry.render();
    expect(out).toContain('agentrun_runloop_runs_total{agent_cli="unknown",status="success",error_type="none"} 1');
    expect(out).not.toContain("agentrun_runloop_run_duration_seconds_count");
  });

  it("never throws even if the collector throws", () => {
    const throwing = {
      observeEvent() {
        throw new Error("collector blew up");
      },
    } as unknown as MetricsCollector;
    const observe = instrumentEventStream(throwing);
    expect(() => observe(ev("run.start", {}, 0))).not.toThrow();
  });
});
