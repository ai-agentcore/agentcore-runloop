import { describe, it, expect } from "vitest";
import { defaultHitlOptions } from "@/hitl/default-options.js";
import { matchReplyToOption } from "@/hitl/match.js";

describe("defaultHitlOptions（嵌套 HITL 默认审批选项 + NL 触发词）", () => {
  it("产出 approve(allow_once)/reject(reject_once)，各带 matchWords", () => {
    const opts = defaultHitlOptions();
    expect(opts.map((o) => o.optionId)).toEqual(["approve", "reject"]);
    expect(opts[0].kind).toBe("allow_once");
    expect(opts[1].kind).toBe("reject_once");
    expect(opts[0].matchWords.length).toBeGreaterThan(0);
    expect(opts[1].matchWords.length).toBeGreaterThan(0);
  });

  it("常见中英文确认/拒绝词都能确定性匹配到正确 option（NL resume 可命中）", () => {
    const opts = defaultHitlOptions();
    for (const w of ["好的", "是", "可以", "同意", "yes", "ok"]) {
      expect(matchReplyToOption(w, opts), `affirmative "${w}"`).toBe("approve");
    }
    for (const w of ["取消", "不要", "否", "拒绝", "no", "cancel"]) {
      expect(matchReplyToOption(w, opts), `negative "${w}"`).toBe("reject");
    }
  });

  it("返回独立数组（多次调用不共享可变引用）", () => {
    const a = defaultHitlOptions();
    const b = defaultHitlOptions();
    expect(a).not.toBe(b);
    a[0].matchWords.push("__mutated__");
    expect(b[0].matchWords).not.toContain("__mutated__");
  });
});
