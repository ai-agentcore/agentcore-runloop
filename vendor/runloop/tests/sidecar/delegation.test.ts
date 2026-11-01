import { describe, it, expect } from "vitest";
import { isDelegationCommand } from "@/sidecar/delegation.js";

// 严格统一命名后委派工具名 = `agent__<资源名>__delegate`，按权威名集合判定（非 `delegate_to_` 前缀）。
const DELEGATION_NAMES = new Set(["agent__super_agent_search__delegate", "agent__bot__delegate", "agent__child__delegate"]);

describe("isDelegationCommand", () => {
  it("matches a real delegation exec command (bash-wrapped, with args)", () => {
    expect(isDelegationCommand(
      `/bin/bash -lc ".tools/agentrun call agent__super_agent_search__delegate '{\\"task\\":\\"hi\\"}'"`,
      DELEGATION_NAMES,
    )).toBe(true);
  });

  it("matches plain (unwrapped) delegation call", () => {
    expect(isDelegationCommand(`.tools/agentrun call agent__bot__delegate '{"task":"x"}'`, DELEGATION_NAMES)).toBe(true);
  });

  it("does NOT match non-delegation agentrun tool calls (sidecar doesn't own their lifecycle)", () => {
    // sandbox/kb/memory/functioncall 的 exec 卡片必须保留，否则客户端看不到——它们不在委派名集合里
    expect(isDelegationCommand(`.tools/agentrun call sandbox__sb1__sandbox_sb1_exec '{"command":"ls"}'`, DELEGATION_NAMES)).toBe(false);
    expect(isDelegationCommand(`.tools/agentrun call kb__docs__kb_retrieve_docs '{"query":"q"}'`, DELEGATION_NAMES)).toBe(false);
    expect(isDelegationCommand(`.tools/agentrun call function__calc__calc '{"expr":"1+1"}'`, DELEGATION_NAMES)).toBe(false);
  });

  it("does NOT false-positive on commands that mention the marker as prose (C2)", () => {
    // 解析「call 后紧跟的工具名」并查集合，prose/帮助文本/list 子命令都不命中。
    expect(isDelegationCommand(`cat AGENTS.md`, DELEGATION_NAMES)).toBe(false);
    expect(isDelegationCommand(`echo "用法: .tools/agentrun call <tool> '{...}'"`, DELEGATION_NAMES)).toBe(false);
    expect(isDelegationCommand(`ls -la /tmp`, DELEGATION_NAMES)).toBe(false);
    expect(isDelegationCommand(`.tools/agentrun list`, DELEGATION_NAMES)).toBe(false);
  });
});
