/**
 * HITL 自然语言回复匹配（AD-026 增补 · NL 通道）。
 *
 * 当上游为纯文本通道（无 clientTools）时，HITL 降级为自然语言提问，suspend 事件携带
 * 每个 option 的 i18n 触发词（matchWords，由 phrasing service 一次性生成并持久化）。
 * resume 时用本模块**纯代码、确定性**地把用户回复匹配回某个 optionId——不在 replay 时重跑模型，
 * 保证 event-sourced 幂等（AD-026）。
 *
 * 规则（按用户定调）：归一化后**完全相等**才算命中；任何多余内容一律不命中（→ 重问）。
 */

/** 空白 + Unicode 标点 + 符号（含 CJK 标点）；`u` flag 下 \p{P}/\p{S} 覆盖中英文标点。 */
const STRIP_RE = /[\s\p{P}\p{S}]/gu;

/**
 * 归一化：NFKC（全角→半角等）→ 小写 → 去空白/标点/符号。
 * 例：" 好 的 。" → "好的"；"ＹＥＳ！" → "yes"。
 */
export function normalizeReply(text: string): string {
  if (!text) return "";
  return text.normalize("NFKC").toLowerCase().replace(STRIP_RE, "");
}

export interface MatchableOption {
  optionId: string;
  /** 该选项的 i18n 触发词（归一化后做完全相等比较） */
  matchWords?: string[];
}

/**
 * 把用户自然语言回复匹配到某个 option：归一化后的回复**完全相等**于某 option 的某个
 * 归一化 matchWord 才命中。返回命中的 optionId；以下情形返回 null（语义 = 不匹配，应重问）：
 *  - 回复为空 / 纯空白；
 *  - 无任何完全相等命中（含"有多余内容"，如 "好的不要了"）；
 *  - 同一回复命中了多个不同 option（正反冲突）。
 */
export function matchReplyToOption(reply: string, options: MatchableOption[]): string | null {
  const norm = normalizeReply(reply);
  if (!norm) return null;
  const hit = new Set<string>();
  for (const opt of options) {
    for (const w of opt.matchWords ?? []) {
      if (normalizeReply(w) === norm) {
        hit.add(opt.optionId);
        break;
      }
    }
  }
  return hit.size === 1 ? [...hit][0] : null;
}
