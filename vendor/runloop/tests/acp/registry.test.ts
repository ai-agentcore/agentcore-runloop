import { describe, it, expect } from "vitest";
import { AgentCliRegistry, validateAgentCli } from "@/acp/registry.js";
describe("Codex registry", () => {
  it("contains only Codex", () => {
    const registry = new AgentCliRegistry();
    expect(registry.listRegistered()).toEqual(["codex"]);
    expect(registry.resolve("codex")?.adapterType).toBe("codex");
    expect(registry.resolve("missing")).toBeUndefined();
  });
  it("allows a deployment-owned Codex binary override", () => {
    const registry = new AgentCliRegistry({ codex: { command: "/opt/codex", adapterType: "codex" } });
    expect(registry.resolve("codex")?.command).toBe("/opt/codex");
  });
  it("rejects unsupported registrations", () => {
    expect(() => new AgentCliRegistry({ other: { command: "other" } })).toThrow(/codex/);
    expect(() => new AgentCliRegistry().register("other", { command: "other" })).toThrow(/codex/);
  });
  it.each(["claude-code", "qodercli", "codex-acp", "/bin/sh", "codex;id", ""])("rejects %s", (name) => {
    expect(validateAgentCli(name)).toBe(false);
  });
});
