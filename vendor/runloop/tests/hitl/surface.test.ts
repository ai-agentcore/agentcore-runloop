import { describe, it, expect } from "vitest";
import { decideHitlSurface, deriveSuspendKind, type HitlClientCapabilitiesView, type SurfaceSuspendView } from "@/hitl/surface.js";

/**
 * 呈现选择纯函数（AD-026 增补 · 触发 ⊥ 呈现 两层模型）：
 * decideHitlSurface(suspend, capabilities) → { mode, toolName?, needsLlm? }。
 * F1/F3 决策的「确定性」部分；needsLlm 的模糊映射交由 surface-map.ts（F3）兜底。
 */
describe("deriveSuspendKind", () => {
  it("interactionKind=input_required → input", () => {
    expect(deriveSuspendKind({ interactionKind: "input_required" })).toBe("input");
  });

  it("options 多于 2 个 → choice", () => {
    expect(deriveSuspendKind({ options: [{ optionId: "a" }, { optionId: "b" }, { optionId: "c" }] })).toBe("choice");
  });

  it("responseSchema 带 enum → choice（即便 options ≤ 2）", () => {
    expect(deriveSuspendKind({ options: [{ optionId: "A" }, { optionId: "B" }], responseSchema: { enum: ["A", "B"] } })).toBe("choice");
  });

  it("二元（confirmation + 2 options）→ confirm", () => {
    expect(deriveSuspendKind({ interactionKind: "confirmation", options: [{ optionId: "approve" }, { optionId: "reject" }] })).toBe("confirm");
  });

  it("无任何字段 → confirm（缺省）", () => {
    expect(deriveSuspendKind({})).toBe("confirm");
  });

  it("input_required 优先于 options 计数（即便 options 多于 2）", () => {
    expect(deriveSuspendKind({ interactionKind: "input_required", options: [{ optionId: "a" }, { optionId: "b" }, { optionId: "c" }] })).toBe("input");
  });
});

describe("decideHitlSurface", () => {
  const confirmSuspend: SurfaceSuspendView = { interactionKind: "confirmation", options: [{ optionId: "approve" }, { optionId: "reject" }] };
  const choiceSuspend: SurfaceSuspendView = { responseSchema: { enum: ["回滚", "热修", "灰度"] }, options: [{ optionId: "回滚" }, { optionId: "热修" }, { optionId: "灰度" }] };
  const inputSuspend: SurfaceSuspendView = { interactionKind: "input_required", options: [] };

  it("capabilities 缺省（undefined）→ native（向后兼容、现行为）", () => {
    expect(decideHitlSurface(confirmSuspend, undefined)).toEqual({ mode: "native" });
    expect(decideHitlSurface(choiceSuspend, undefined)).toEqual({ mode: "native" });
    expect(decideHitlSurface(inputSuspend, undefined)).toEqual({ mode: "native" });
  });

  it("kind ∈ interactions 且 nativeHitl → native", () => {
    const caps: HitlClientCapabilitiesView = { interactions: ["confirm", "choice"], nativeHitl: true };
    expect(decideHitlSurface(confirmSuspend, caps)).toEqual({ mode: "native" });
    expect(decideHitlSurface(choiceSuspend, caps)).toEqual({ mode: "native" });
  });

  it("nativeHitl=true 但 kind 未声明 → 不 native（落到 renderTools / nl）", () => {
    const caps: HitlClientCapabilitiesView = { interactions: ["confirm"], nativeHitl: true };
    // choice 未声明、无 renderTools → nl
    expect(decideHitlSurface(choiceSuspend, caps)).toEqual({ mode: "nl" });
  });

  it("声明了 kind 但 nativeHitl=false → 不 native（无 renderTools → nl）", () => {
    const caps: HitlClientCapabilitiesView = { interactions: ["confirm"], nativeHitl: false };
    expect(decideHitlSurface(confirmSuspend, caps)).toEqual({ mode: "nl" });
  });

  it("renderTools[kind] 存在 → client_tool + toolName（确定性映射）", () => {
    const caps: HitlClientCapabilitiesView = { renderTools: { choice: "super_agent_choices" } };
    expect(decideHitlSurface(choiceSuspend, caps)).toEqual({ mode: "client_tool", toolName: "super_agent_choices" });
  });

  it("native 优先于 renderTools（kind 既声明又有映射 → native）", () => {
    const caps: HitlClientCapabilitiesView = { interactions: ["choice"], nativeHitl: true, renderTools: { choice: "super_agent_choices" } };
    expect(decideHitlSurface(choiceSuspend, caps)).toEqual({ mode: "native" });
  });

  it("有 renderTools 但当前 kind 无显式映射、非 native → client_tool + needsLlm（交给 F3 LLM）", () => {
    const caps: HitlClientCapabilitiesView = { renderTools: { choice: "super_agent_choices" } };
    // confirm 无映射，但客户端声明了 client-tool 渲染能力（renderTools 非空）→ needsLlm
    expect(decideHitlSurface(confirmSuspend, caps)).toEqual({ mode: "client_tool", needsLlm: true });
  });

  it("renderTools 为空对象 → 不视为有 client tool → nl", () => {
    const caps: HitlClientCapabilitiesView = { renderTools: {} };
    expect(decideHitlSurface(confirmSuspend, caps)).toEqual({ mode: "nl" });
  });

  it("空 capabilities 对象（无任何声明）→ nl（既非 native 也无 render tool）", () => {
    expect(decideHitlSurface(confirmSuspend, {})).toEqual({ mode: "nl" });
  });

  it("renderTools[kind] 为空串 → 视为无映射（落到 needsLlm，因 renderTools 非空）", () => {
    const caps: HitlClientCapabilitiesView = { renderTools: { confirm: "" } };
    expect(decideHitlSurface(confirmSuspend, caps)).toEqual({ mode: "client_tool", needsLlm: true });
  });
});
