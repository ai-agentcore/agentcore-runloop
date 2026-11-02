import { describe, it, expect } from "vitest";
import { createMetrics } from "@/observability/collector.js";

describe("MetricsCollector", () => {
  it("observeHttp records counter and duration histogram", () => {
    const { registry, collector } = createMetrics();
    collector.observeHttp({
      method: "POST",
      route: "/v1/run",
      statusClass: "2xx",
      errorType: "none",
      durationSeconds: 0.2,
    });
    const out = registry.render();
    expect(out).toContain(
      'agentcore_runloop_http_requests_total{method="POST",route="/v1/run",status_class="2xx",error_type="none"} 1',
    );
    expect(out).toContain('agentcore_runloop_http_request_duration_seconds_count{method="POST",route="/v1/run",status_class="2xx"} 1');
  });

  it("observeEvent counts by type", () => {
    const { registry, collector } = createMetrics();
    collector.observeEvent("run.start");
    collector.observeEvent("run.start");
    expect(registry.render()).toContain('agentcore_runloop_events_total{event_type="run.start"} 2');
  });

  it("observeRun records counter always and histogram only with duration", () => {
    const { registry, collector } = createMetrics();
    collector.observeRun({ agentCli: "codex", status: "success", errorType: "none", durationSeconds: 3 });
    collector.observeRun({ agentCli: "codex", status: "error", errorType: "loop_error" });
    const out = registry.render();
    expect(out).toContain('agentcore_runloop_runs_total{agent_cli="codex",status="success",error_type="none"} 1');
    expect(out).toContain('agentcore_runloop_runs_total{agent_cli="codex",status="error",error_type="loop_error"} 1');
    expect(out).toContain('agentcore_runloop_run_duration_seconds_count{agent_cli="codex",status="success"} 1');
    // error run had no duration → no histogram series for it
    expect(out).not.toContain('agentcore_runloop_run_duration_seconds_count{agent_cli="codex",status="error"}');
  });

  it("observeToolCall records counter always and histogram only with duration", () => {
    const { registry, collector } = createMetrics();
    collector.observeToolCall({ toolType: "exec", status: "success", errorType: "none", durationSeconds: 0.5 });
    collector.observeToolCall({ toolType: "file", status: "failure", errorType: "tool_error" });
    const out = registry.render();
    expect(out).toContain('agentcore_runloop_tool_calls_total{tool_type="exec",status="success",error_type="none"} 1');
    expect(out).toContain('agentcore_runloop_tool_calls_total{tool_type="file",status="failure",error_type="tool_error"} 1');
    expect(out).toContain('agentcore_runloop_tool_call_duration_seconds_count{tool_type="exec",status="success"} 1');
    expect(out).not.toContain('agentcore_runloop_tool_call_duration_seconds_count{tool_type="file"');
  });

  it("observeTurn and active runs gauge", () => {
    const { registry, collector } = createMetrics();
    collector.observeTurn();
    collector.incActiveRuns();
    collector.incActiveRuns();
    collector.decActiveRuns();
    const out = registry.render();
    expect(out).toContain("agentcore_runloop_turns_total 1");
    expect(out).toContain("agentcore_runloop_active_runs 1");
  });

  it("observeUsage records token kinds and cost", () => {
    const { registry, collector } = createMetrics();
    collector.observeUsage({
      agentCli: "codex",
      model: "qwen3.7-max",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 3,
      costUsd: 0.01,
    });
    const out = registry.render();
    expect(out).toContain(
      'agentcore_runloop_llm_tokens_total{agent_cli="codex",model="qwen3.7-max",kind="input"} 100',
    );
    expect(out).toContain(
      'agentcore_runloop_llm_tokens_total{agent_cli="codex",model="qwen3.7-max",kind="output"} 20',
    );
    expect(out).toContain(
      'agentcore_runloop_llm_tokens_total{agent_cli="codex",model="qwen3.7-max",kind="cache_read"} 5',
    );
    expect(out).toContain(
      'agentcore_runloop_llm_tokens_total{agent_cli="codex",model="qwen3.7-max",kind="cache_write"} 3',
    );
    expect(out).toContain(
      'agentcore_runloop_llm_cost_usd_total{agent_cli="codex",model="qwen3.7-max"} 0.01',
    );
  });

  it("observeUsage skips absent token fields (no zero series)", () => {
    const { registry, collector } = createMetrics();
    collector.observeUsage({ agentCli: "codex", model: "gpt-5", inputTokens: 42 });
    const out = registry.render();
    expect(out).toContain(
      'agentcore_runloop_llm_tokens_total{agent_cli="codex",model="gpt-5",kind="input"} 42',
    );
    // omitted fields produce no series at all
    expect(out).not.toContain('kind="output"');
    expect(out).not.toContain('kind="cache_read"');
    expect(out).not.toContain('kind="cache_write"');
    expect(out).not.toContain("agentcore_runloop_llm_cost_usd_total");
  });
});
