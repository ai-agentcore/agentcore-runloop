import type { HitlConfig } from "../types/resources.js";

export interface HitlDecision {
  action: "allow" | "block" | "ask";
  reason?: string;
  rule?: string;
}

/**
 * HITL 主轨静态规则评估（AD-026）。命中 action:"ask" 的工具调用强制挂起待审批。
 * 配置来自顶层 `hitl:{ enabled, rules }`（不再在 features）。
 */
export function evaluateStaticRules(
  toolName: string,
  _args: Record<string, unknown>,
  hitl?: HitlConfig
): HitlDecision {
  if (!hitl?.enabled) {
    return { action: "allow" };
  }

  const rules = hitl.rules ?? [];

  for (const rule of rules) {
    if (matchToolPattern(toolName, rule.toolPattern)) {
      return {
        action: rule.action,
        reason: rule.reason,
        rule: rule.toolPattern,
      };
    }
  }

  return { action: "allow" };
}

function matchToolPattern(toolName: string, pattern: string): boolean {
  if (pattern === "*") return true;

  if (pattern.endsWith("*")) {
    return toolName.startsWith(pattern.slice(0, -1));
  }

  return toolName === pattern;
}
