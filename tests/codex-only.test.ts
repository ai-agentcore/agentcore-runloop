import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { LoopRunner } from "../vendor/runloop/src/loop/runner.js";
import { AgentCliRegistry } from "../vendor/runloop/src/acp/registry.js";
import { ResourceSchema } from "../vendor/runloop/src/types/resources.js";

describe("Codex-only distribution", () => {
  it("registers only the supported Harness", () => {
    expect(new AgentCliRegistry().listRegistered()).toEqual(["codex"]);
  });
  it.each(["qodercli", "claude-code", "codex-acp"])("rejects unsupported deployment CLI %s", (cli) => {
    expect(() => loadConfig({ AGENTCORE_MOCK: "true", AGENTCORE_AGENT_CLI: cli })).toThrow(/codex/i);
  });
  it("cannot bypass the supported CLI through the old escape hatch", () => {
    const runner = new LoopRunner({ allowUnregisteredAgents: true } as never);
    expect(() => runner.resolveCliCommand("claude")).toThrow(/codex/i);
  });
  it("rejects legacy platform authentication while accepting header-based resources", () => {
    const resource = { resourceId: "tool", resourceName: "tool", resourceType: "MCP", protocol: "mcp", mcpConfig: { url: "https://tools.example.com/mcp", transport: "http" } };
    expect(ResourceSchema.safeParse({ ...resource, auth: { mode: "none" } }).success).toBe(true);
    expect(ResourceSchema.safeParse({ ...resource, auth: { mode: "agentrun" } }).success).toBe(false);
  });
});
