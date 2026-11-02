import { describe, expect, it } from "vitest";
import { createDefaultRegistry } from "@/loop/prompts/index.js";

describe("createDefaultRegistry", () => {
  const registry = createDefaultRegistry();

  it("registers super-agent prompt", () => {
    expect(registry.has("agentcore-agent")).toBe(true);
    const rendered = registry.render("agentcore-agent");
    expect(rendered).toContain("Alibaba Cloud AgentCore");
    expect(rendered).toContain("Never approve");
  });

  it("registers sub-agent-coordination prompt", () => {
    expect(registry.has("sub-agent-coordination")).toBe(true);
    expect(registry.render("sub-agent-coordination")).toContain("sub-agents");
  });

  it("registers model operational prompts", () => {
    expect(registry.has("model/default")).toBe(true);
    expect(registry.has("model/qwen")).toBe(true);
    expect(registry.render("model/default")).toContain("工作规约");
  });

  it("lists all registered prompts", () => {
    const all = registry.list();
    expect(all.length).toBeGreaterThanOrEqual(4);
  });

  it("model prompts carry no codex private content", () => {
    expect(registry.render("model/qwen")).not.toContain("Codex");
  });
});
