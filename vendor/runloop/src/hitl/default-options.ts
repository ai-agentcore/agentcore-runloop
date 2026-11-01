/**
 * 嵌套 HITL 默认审批选项（AD-026 增补 · 嵌套 NL 通道补全）。
 *
 * 背景：主轨（sidecar `maybeSuspend`）的 suspend 经 phrasing 服务注入了 `matchWords`，NL resume 可命中；
 * 但**嵌套**子 agent（A2A `input-required`/`auth-required`、ag-ui INTERRUPT/CUSTOM）触发的 suspend
 * 由 `event-translator.ts::translateChildEvent` 在 SSE 翻译热路径里同步生成——不经 phrasing（异步模型调用
 * 不能放热路径），早期其默认 `approve/reject` 选项**没有 matchWords** → 真实嵌套 HITL 的 NL 回复（"好的"）
 * 在 `resolvePendingHitl` 里匹配不到任何 option → 重问直至自动拒绝。seeded 测试用带 matchWords 的 seed
 * 掩盖了该缺口；真实首轮触发暴露之。
 *
 * 修复：给嵌套默认选项注入一组**静态 zh∪en 触发词**（复用 phrasing 的 StaticHitlPhrasing 默认词表，
 * 与主轨措辞同源），无异步、确定性、replay 安全。子 agent 若自带 options（ag-ui 透传）则用其自带的。
 */
import { StaticHitlPhrasing } from "./phrasing.js";

/** approve / reject 的默认触发词 = StaticHitlPhrasing 的 zh ∪ en 词表（去重）。 */
const ZH = StaticHitlPhrasing.build({ toolName: "", reason: "model_request" });
const EN = StaticHitlPhrasing.build({ toolName: "", reason: "model_request", locale: "en" });
const AFFIRMATIVE = [...new Set([...ZH.affirmativeWords, ...EN.affirmativeWords])];
const NEGATIVE = [...new Set([...ZH.negativeWords, ...EN.negativeWords])];

export interface DefaultHitlOption {
  optionId: string;
  label: string;
  kind: "allow_once" | "reject_once";
  matchWords: string[];
}

/**
 * 嵌套子 agent HITL 的默认审批选项：`approve`(allow_once) / `reject`(reject_once)，
 * 各带默认 matchWords，保证纯文本上游下 NL resume 可确定性命中（"好的"/"取消" 等）。
 * 每次返回新数组（避免调用方共享可变引用）。
 */
export function defaultHitlOptions(): DefaultHitlOption[] {
  return [
    { optionId: "approve", label: "允许", kind: "allow_once", matchWords: [...AFFIRMATIVE] },
    { optionId: "reject", label: "拒绝", kind: "reject_once", matchWords: [...NEGATIVE] },
  ];
}
