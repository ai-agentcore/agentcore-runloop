import { describe, it, expect } from "vitest";
import { normalizeReply, matchReplyToOption } from "@/hitl/match.js";

describe("normalizeReply", () => {
  it("去空格与标点", () => {
    expect(normalizeReply(" 好 的 。")).toBe("好的");
    expect(normalizeReply("Yes!")).toBe("yes");
    expect(normalizeReply("可以，执行")).toBe("可以执行");
  });
  it("全角→半角 + 小写归一", () => {
    expect(normalizeReply("ＹＥＳ")).toBe("yes");
    expect(normalizeReply("ＯＫ！")).toBe("ok");
  });
  it("空/纯空白 → 空串", () => {
    expect(normalizeReply("   ")).toBe("");
    expect(normalizeReply("")).toBe("");
  });
});

describe("matchReplyToOption", () => {
  const options = [
    { optionId: "approve", matchWords: ["是", "可以", "好的", "执行", "继续"] },
    { optionId: "reject", matchWords: ["否", "不", "不要", "拒绝", "取消"] },
  ];

  it("归一化后完全相等 → 命中肯定选项", () => {
    expect(matchReplyToOption("好的。", options)).toBe("approve");
    expect(matchReplyToOption(" 是 ", options)).toBe("approve");
    expect(matchReplyToOption("执行", options)).toBe("approve");
  });

  it("归一化后完全相等 → 命中否定选项", () => {
    expect(matchReplyToOption("取消", options)).toBe("reject");
    expect(matchReplyToOption("不要！", options)).toBe("reject");
  });

  it("有任何多余内容（非完全相等）→ null（应重问）", () => {
    expect(matchReplyToOption("好的不要了", options)).toBeNull();
    expect(matchReplyToOption("我觉得可以吧", options)).toBeNull();
    expect(matchReplyToOption("是的", options)).toBeNull(); // 词表里只有"是"，不含"是的"
  });

  it("空/纯空白回复 → null", () => {
    expect(matchReplyToOption("   ", options)).toBeNull();
    expect(matchReplyToOption("", options)).toBeNull();
  });

  it("option 无 matchWords → null", () => {
    expect(matchReplyToOption("是", [{ optionId: "approve" }])).toBeNull();
  });

  it("同一词命中多个 option（冲突）→ null", () => {
    const conflicting = [
      { optionId: "a", matchWords: ["好"] },
      { optionId: "b", matchWords: ["好"] },
    ];
    expect(matchReplyToOption("好", conflicting)).toBeNull();
  });
});
