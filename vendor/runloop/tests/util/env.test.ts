import { describe, it, expect, afterEach } from "vitest";
import { envPositiveInt, envNonNegativeInt } from "@/util/env.js";

const KEY = "AGENTCORE_TEST_ENV_INT";

afterEach(() => {
  delete process.env[KEY];
});

describe("envPositiveInt", () => {
  it("未设置 → fallback", () => {
    expect(envPositiveInt(KEY, 42)).toBe(42);
  });

  it("合法正整数 → 解析值", () => {
    process.env[KEY] = "1500";
    expect(envPositiveInt(KEY, 42)).toBe(1500);
  });

  it("0 / 负数 / 非数字 → fallback（必须正数）", () => {
    for (const v of ["0", "-5", "abc", ""]) {
      process.env[KEY] = v;
      expect(envPositiveInt(KEY, 42), v).toBe(42);
    }
  });
});

describe("envNonNegativeInt", () => {
  it("未设置 → fallback", () => {
    expect(envNonNegativeInt(KEY, 7)).toBe(7);
  });

  it("0 合法 → 0（开关型上限：0=不限）", () => {
    process.env[KEY] = "0";
    expect(envNonNegativeInt(KEY, 7)).toBe(0);
  });

  it("正整数 → 解析值；负数 / 非数字 → fallback", () => {
    process.env[KEY] = "300000";
    expect(envNonNegativeInt(KEY, 7)).toBe(300000);
    for (const v of ["-1", "x", ""]) {
      process.env[KEY] = v;
      expect(envNonNegativeInt(KEY, 7), v).toBe(7);
    }
  });
});
