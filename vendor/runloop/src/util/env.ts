/**
 * 环境变量解析小工具（集中收口，避免各模块重复实现）。
 */

/**
 * 读取一个正整数环境变量；未设置 / 非有限数 / 非正数时回落到 fallback。
 * 用于各类超时/上限的 env 覆盖（毫秒、字节数等，语义均为正整数）。
 */
export function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 读取一个非负整数环境变量（允许 0，常用于「0 = 不限时/不限量」的开关型上限）；
 * 未设置 / 非有限数 / 负数时回落到 fallback。
 */
export function envNonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
