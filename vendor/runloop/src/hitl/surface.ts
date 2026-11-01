/**
 * HITL 呈现选择（AD-026 增补 · 触发 ⊥ 呈现 两层模型）。
 *
 * 一个 toolcall.suspend 已被「触发层」产出后，「呈现层」决定它怎么递给人——**在 runloop、由
 * `hitl.clientCapabilities` 配置驱动**（不在 super_agent）：① 客户端声明能原生消费该交互形态 → 原生事件；
 * ② 否则客户端有 client tool 可渲染 → 映射到 client tool（能确定就确定、确定不了交给 F3 的纯 HITL LLM 调用）；
 * ③ 否则 → 自然语言兜底（永远可用的地板）。
 *
 * 本模块是**纯函数**——只做确定性决策；needsLlm 的模糊映射交由 src/hitl/surface-map.ts（F3）。
 * 运行时 runloop **恒发全表征**（options + prompt + matchWords + responseSchema），surface 只是「建议怎么呈现」，
 * 客户端/bridge 仍可按需自行选择，NL 永远兜底。
 */

/** 交互形态（与 hitl.clientCapabilities.interactions 同枚举）。 */
export type HitlInteractionKind = "confirm" | "input" | "choice";

/** decideHitlSurface 消费的 suspend 视图（最小结构化字段，与 ToolcallSuspend 事件 / AskSuspendFields 兼容）。 */
export interface SurfaceSuspendView {
  /** AG-UI 交互语义类别（tool_call/input_required/confirmation），缺省按 options/responseSchema 推断。 */
  interactionKind?: string;
  /** 候选选项（仅用其数量判定 confirm vs choice）。 */
  options?: ReadonlyArray<unknown>;
  /** 期望回复结构；带 enum ⇒ choice。 */
  responseSchema?: Record<string, unknown>;
}

/** 客户端 HITL 能力声明视图（结构化解耦 generated 类型，向后兼容字段可缺省）。 */
export interface HitlClientCapabilitiesView {
  /** F1：客户端声明支持、且允许模型触发的交互形态。 */
  interactions?: string[];
  /** 客户端能直接消费原生 toolcall.suspend 事件。 */
  nativeHitl?: boolean;
  /** 交互形态 → 客户端工具名 的显式映射（确定性渲染），如 {"choice":"super_agent_choices"}。 */
  renderTools?: Record<string, string>;
}

export type HitlSurfaceMode = "native" | "client_tool" | "nl";

export interface HitlSurfaceDecision {
  mode: HitlSurfaceMode;
  /** mode=client_tool 且能确定目标工具时给出（renderTools 显式映射或 F3 选定）。 */
  toolName?: string;
  /** mode=client_tool 但目标工具需 F3 纯 HITL LLM 调用决定（无显式映射）。 */
  needsLlm?: boolean;
}

function hasEnum(schema?: Record<string, unknown>): boolean {
  return Array.isArray(schema?.enum) && (schema!.enum as unknown[]).length > 0;
}

/**
 * 从 suspend 推交互形态：
 *  - interactionKind=input_required → input（取值，优先级最高）；
 *  - options 多于 2 个 或 responseSchema 带 enum → choice（多选）；
 *  - 否则 → confirm（二元确认，缺省）。
 */
export function deriveSuspendKind(suspend: SurfaceSuspendView): HitlInteractionKind {
  if (suspend.interactionKind === "input_required") return "input";
  if ((suspend.options?.length ?? 0) > 2 || hasEnum(suspend.responseSchema)) return "choice";
  return "confirm";
}

/**
 * 呈现选择（确定性部分）。决策顺序（AD-026 增补 §3）：
 *  1. capabilities 缺省（undefined）→ native（向后兼容、现行为）；
 *  2. kind ∈ interactions 且 nativeHitl → native；
 *  3. renderTools[kind] 存在 → client_tool + toolName（确定性映射）；
 *  4. 有 client tool 渲染能力（renderTools 非空）但当前 kind 无显式映射、非 native → client_tool + needsLlm（交 F3）；
 *  5. 其余 → nl。
 *
 * 「有 client tool」的信号 = `renderTools` 非空对象（客户端声明了 client-tool 渲染能力）；renderTools 缺省/空 ⇒
 * 无该能力 ⇒ 落到 NL。真正可选的客户端工具清单在调用 F3 mapper 时单独提供（见 surface-map.ts）。
 */
export function decideHitlSurface(
  suspend: SurfaceSuspendView,
  capabilities?: HitlClientCapabilitiesView,
): HitlSurfaceDecision {
  if (!capabilities) return { mode: "native" };

  const kind = deriveSuspendKind(suspend);
  const interactions = capabilities.interactions ?? [];
  if (interactions.includes(kind) && capabilities.nativeHitl) return { mode: "native" };

  const renderTools = capabilities.renderTools;
  const explicit = renderTools?.[kind];
  if (typeof explicit === "string" && explicit.length > 0) {
    return { mode: "client_tool", toolName: explicit };
  }
  if (renderTools && Object.keys(renderTools).length > 0) {
    return { mode: "client_tool", needsLlm: true };
  }
  return { mode: "nl" };
}
