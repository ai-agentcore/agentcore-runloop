import { describe, it, expect } from "vitest";
import {
  classifyToolType,
  httpErrorType,
  httpStatusClass,
  normalizeErrorCode,
  normalizeHttpPath,
  normalizeModel,
  runStatusFromReason,
  toolStatus,
} from "@/observability/labels.js";

describe("labels", () => {
  it("runStatusFromReason maps spec reasons to bounded statuses", () => {
    expect(runStatusFromReason("completed")).toBe("success");
    expect(runStatusFromReason("error")).toBe("error");
    expect(runStatusFromReason("interrupted")).toBe("interrupted");
    expect(runStatusFromReason("timeout")).toBe("timeout");
    expect(runStatusFromReason("hitl_pending")).toBe("suspended");
    expect(runStatusFromReason("tool_pending")).toBe("suspended");
    expect(runStatusFromReason("weird")).toBe("unknown");
  });

  it("normalizeErrorCode lowercases and defaults to none", () => {
    expect(normalizeErrorCode("LOOP_ERROR")).toBe("loop_error");
    expect(normalizeErrorCode("")).toBe("none");
    expect(normalizeErrorCode(undefined)).toBe("none");
  });

  it("toolStatus reflects isError", () => {
    expect(toolStatus(true)).toBe("failure");
    expect(toolStatus(false)).toBe("success");
    expect(toolStatus(undefined)).toBe("success");
  });

  it("classifyToolType maps names to a bounded set", () => {
    expect(classifyToolType("")).toBe("unknown");
    expect(classifyToolType(undefined)).toBe("unknown");
    expect(classifyToolType("bash")).toBe("exec");
    expect(classifyToolType("read_file")).toBe("file");
    expect(classifyToolType("write_file")).toBe("file");
    expect(classifyToolType("request_confirmation")).toBe("hitl");
    expect(classifyToolType("request_user_input")).toBe("hitl");
    expect(classifyToolType("my_bot_delegate")).toBe("subagent");
    expect(classifyToolType("delegate_to_bot")).toBe("subagent");
    expect(classifyToolType("calc_invoke")).toBe("platform");
  });

  it("classifyToolType strips codex namespace prefix", () => {
    expect(classifyToolType("mcp__agentcore__bash")).toBe("exec");
    expect(classifyToolType("mcp__agentcore__read_file")).toBe("file");
    expect(classifyToolType("mcp__agentcore__my_bot_delegate")).toBe("subagent");
    expect(classifyToolType("mcp__agentcore__calc_invoke")).toBe("platform");
  });

  it("classifyToolType only strips mcp__agentcore__, not AD-029 type prefixes (L-054)", () => {
    // AD-029 的 MCP 型工具名本身以 mcp__<资源>__ 起头，不能被贪婪剥成动作段（mcp__calc__bash → bash → exec 误判）。
    expect(classifyToolType("mcp__calc__add")).toBe("platform");
    expect(classifyToolType("mcp__calc__bash")).toBe("platform");
    expect(classifyToolType("agent__my_bot__delegate")).toBe("subagent");
    expect(classifyToolType("mcp__agentcore__mcp__leida__get_news")).toBe("platform");
  });

  it("httpStatusClass buckets by hundreds", () => {
    expect(httpStatusClass(200)).toBe("2xx");
    expect(httpStatusClass(404)).toBe("4xx");
    expect(httpStatusClass(503)).toBe("5xx");
    expect(httpStatusClass(0)).toBe("0");
    expect(httpStatusClass(NaN)).toBe("0");
  });

  it("httpErrorType maps status to bounded error categories", () => {
    expect(httpErrorType(200)).toBe("none");
    expect(httpErrorType(NaN)).toBe("none");
    expect(httpErrorType(401)).toBe("auth");
    expect(httpErrorType(403)).toBe("auth");
    expect(httpErrorType(404)).toBe("not_found");
    expect(httpErrorType(429)).toBe("rate_limited");
    expect(httpErrorType(503)).toBe("upstream_unavailable");
    expect(httpErrorType(400)).toBe("invalid_request");
    expect(httpErrorType(500)).toBe("internal_error");
  });

  it("normalizeModel lowercases valid ids and guards against high cardinality", () => {
    expect(normalizeModel("Qwen3.7-Max")).toBe("qwen3.7-max");
    expect(normalizeModel("gpt-5")).toBe("gpt-5");
    expect(normalizeModel("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(normalizeModel("provider/model:v1")).toBe("provider/model:v1");
    // empty → unknown
    expect(normalizeModel("")).toBe("unknown");
    expect(normalizeModel(undefined)).toBe("unknown");
    expect(normalizeModel(null)).toBe("unknown");
    // too long → other
    expect(normalizeModel("a".repeat(65))).toBe("other");
    // illegal characters (spaces / leading punctuation) → other
    expect(normalizeModel("free text prompt leaked")).toBe("other");
    expect(normalizeModel("-leading-dash")).toBe("other");
  });

  it("normalizeHttpPath replaces id-like segments", () => {
    expect(normalizeHttpPath("/v1/run")).toBe("/v1/run");
    expect(normalizeHttpPath("/v1/runs/12345")).toBe("/v1/runs/:id");
    expect(normalizeHttpPath("/x/deadbeefdeadbeef")).toBe("/x/:id");
    expect(normalizeHttpPath("/x/abc123def456ghi")).toBe("/x/:id");
    expect(normalizeHttpPath("/health")).toBe("/health");
  });
});
