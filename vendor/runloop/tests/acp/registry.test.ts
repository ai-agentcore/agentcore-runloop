import { describe, it, expect } from "vitest";
import { AgentCliRegistry, validateAgentCli } from "@/acp/registry.js";

/* ------------------------------------------------------------------ */
/*  AgentCliRegistry                                                  */
/* ------------------------------------------------------------------ */

describe("AgentCliRegistry", () => {
  it("has default entries for qodercli, codex-acp, codex, and claude-code", () => {
    const reg = new AgentCliRegistry();
    expect(reg.isRegistered("qodercli")).toBe(true);
    expect(reg.isRegistered("codex-acp")).toBe(true);
    expect(reg.isRegistered("codex")).toBe(true);
    expect(reg.isRegistered("claude-code")).toBe(true);
  });

  it("resolve returns the correct entry for a default CLI", () => {
    const reg = new AgentCliRegistry();
    const entry = reg.resolve("codex");
    expect(entry).toBeDefined();
    expect(entry!.command).toBe("codex");
    expect(entry!.adapterType).toBe("codex");
  });

  it("resolve returns correct entry for qodercli with defaultArgs", () => {
    const reg = new AgentCliRegistry();
    const entry = reg.resolve("qodercli");
    expect(entry).toBeDefined();
    expect(entry!.command).toBe("qodercli");
    expect(entry!.adapterType).toBe("acp-server");
    expect(entry!.defaultArgs).toEqual(["--acp"]);
  });

  it("resolve returns undefined for unknown CLI name", () => {
    const reg = new AgentCliRegistry();
    expect(reg.resolve("nonexistent")).toBeUndefined();
  });

  it("isRegistered returns false for unknown CLI", () => {
    const reg = new AgentCliRegistry();
    expect(reg.isRegistered("does-not-exist")).toBe(false);
  });

  it("listRegistered returns all registered keys", () => {
    const reg = new AgentCliRegistry();
    const keys = reg.listRegistered();
    expect(keys).toContain("qodercli");
    expect(keys).toContain("codex-acp");
    expect(keys).toContain("codex");
    expect(keys).toContain("claude-code");
    expect(keys).toHaveLength(4);
  });

  it("register adds a new entry", () => {
    const reg = new AgentCliRegistry();
    reg.register("custom-cli", { command: "my-cli", adapterType: "cli" });
    expect(reg.isRegistered("custom-cli")).toBe(true);
    expect(reg.resolve("custom-cli")).toEqual({ command: "my-cli", adapterType: "cli" });
    expect(reg.listRegistered()).toHaveLength(5);
  });

  it("register overrides an existing entry", () => {
    const reg = new AgentCliRegistry();
    const original = reg.resolve("codex");
    reg.register("codex", { command: "codex-v2", adapterType: "acp-server", defaultArgs: ["--new"] });
    const updated = reg.resolve("codex");
    expect(updated).not.toEqual(original);
    expect(updated!.command).toBe("codex-v2");
    expect(updated!.adapterType).toBe("acp-server");
    expect(updated!.defaultArgs).toEqual(["--new"]);
    // Total count unchanged
    expect(reg.listRegistered()).toHaveLength(4);
  });

  it("constructor accepts additional entries", () => {
    const reg = new AgentCliRegistry({
      "my-agent": { command: "agent-bin", adapterType: "stream-json" },
    });
    expect(reg.isRegistered("my-agent")).toBe(true);
    expect(reg.resolve("my-agent")!.command).toBe("agent-bin");
    // Default entries still present
    expect(reg.isRegistered("codex")).toBe(true);
    expect(reg.listRegistered()).toHaveLength(5);
  });

  it("additional entries in constructor override defaults", () => {
    const reg = new AgentCliRegistry({
      codex: { command: "codex-custom", adapterType: "cli" },
    });
    expect(reg.resolve("codex")!.command).toBe("codex-custom");
    expect(reg.resolve("codex")!.adapterType).toBe("cli");
    expect(reg.listRegistered()).toHaveLength(4);
  });
});

/* ------------------------------------------------------------------ */
/*  validateAgentCli                                                  */
/* ------------------------------------------------------------------ */

describe("validateAgentCli", () => {
  it("accepts simple valid names", () => {
    expect(validateAgentCli("codex")).toBe(true);
    expect(validateAgentCli("qodercli")).toBe(true);
    expect(validateAgentCli("claude-code")).toBe(true);
    expect(validateAgentCli("my_agent_v2")).toBe(true);
  });

  it("rejects absolute paths starting with /", () => {
    expect(validateAgentCli("/usr/bin/evil")).toBe(false);
    expect(validateAgentCli("/tmp/hack")).toBe(false);
  });

  it("rejects relative paths starting with ./", () => {
    expect(validateAgentCli("./local-script")).toBe(false);
    expect(validateAgentCli("./bin/run")).toBe(false);
  });

  it("rejects parent-directory traversal starting with ..", () => {
    expect(validateAgentCli("../escape")).toBe(false);
    expect(validateAgentCli("..")).toBe(false);
  });

  it("rejects names containing space", () => {
    expect(validateAgentCli("name with space")).toBe(false);
    expect(validateAgentCli("cmd arg")).toBe(false);
  });

  it("rejects names containing semicolon (command chaining)", () => {
    expect(validateAgentCli("cmd;rm -rf /")).toBe(false);
    expect(validateAgentCli("safe;unsafe")).toBe(false);
  });

  it("rejects names containing pipe", () => {
    expect(validateAgentCli("cmd|cat /etc/passwd")).toBe(false);
    expect(validateAgentCli("a|b")).toBe(false);
  });

  it("rejects names containing ampersand", () => {
    expect(validateAgentCli("cmd&bg")).toBe(false);
    expect(validateAgentCli("a&&b")).toBe(false);
  });
});
