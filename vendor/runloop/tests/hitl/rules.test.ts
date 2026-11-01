import { describe, it, expect } from "vitest";
import { evaluateStaticRules } from "@/hitl/rules.js";
import type { HitlConfig } from "@/types/resources.js";

describe("evaluateStaticRules", () => {
  it("allows all when hitl is undefined", () => {
    const result = evaluateStaticRules("any_tool", {});
    expect(result.action).toBe("allow");
  });

  it("allows all when hitl is disabled", () => {
    const result = evaluateStaticRules("any_tool", {}, { enabled: false });
    expect(result.action).toBe("allow");
  });

  it("allows when no rules match", () => {
    const hitl: HitlConfig = {
      enabled: true,
      rules: [{ toolPattern: "dangerous_*", action: "block" }],
    };
    const result = evaluateStaticRules("safe_tool", {}, hitl);
    expect(result.action).toBe("allow");
  });

  it("blocks on exact match", () => {
    const hitl: HitlConfig = {
      enabled: true,
      rules: [
        {
          toolPattern: "rm_files",
          action: "block",
          reason: "Destructive operation",
        },
      ],
    };
    const result = evaluateStaticRules("rm_files", {}, hitl);
    expect(result.action).toBe("block");
    expect(result.reason).toBe("Destructive operation");
    expect(result.rule).toBe("rm_files");
  });

  it("matches wildcard prefix patterns", () => {
    const hitl: HitlConfig = {
      enabled: true,
      rules: [{ toolPattern: "admin_*", action: "ask" }],
    };
    const result = evaluateStaticRules("admin_delete_user", {}, hitl);
    expect(result.action).toBe("ask");
  });

  it("matches global wildcard", () => {
    const hitl: HitlConfig = {
      enabled: true,
      rules: [{ toolPattern: "*", action: "ask" }],
    };
    const result = evaluateStaticRules("any_tool", {}, hitl);
    expect(result.action).toBe("ask");
  });

  it("uses first matching rule", () => {
    const hitl: HitlConfig = {
      enabled: true,
      rules: [
        { toolPattern: "deploy_*", action: "block" },
        { toolPattern: "*", action: "allow" },
      ],
    };
    const result = evaluateStaticRules("deploy_prod", {}, hitl);
    expect(result.action).toBe("block");
  });

  it("allows when hitl enabled but no rules defined", () => {
    const hitl: HitlConfig = { enabled: true };
    const result = evaluateStaticRules("any_tool", {}, hitl);
    expect(result.action).toBe("allow");
  });

  it("allows when hitl enabled with empty rules", () => {
    const hitl: HitlConfig = { enabled: true, rules: [] };
    const result = evaluateStaticRules("any_tool", {}, hitl);
    expect(result.action).toBe("allow");
  });
});
