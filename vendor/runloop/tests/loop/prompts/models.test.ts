import { describe, expect, it } from "vitest";
import {
  MODEL_BASE_PROMPT,
  modelPrompts,
  selectModelPrompt,
  renderModelPrompt,
} from "@/loop/prompts/models/index.js";

describe("MODEL_BASE_PROMPT", () => {
  it("是面向我们环境的通用规约，不含 codex 私有内容", () => {
    expect(MODEL_BASE_PROMPT).toContain("工作规约");
    expect(MODEL_BASE_PROMPT).not.toContain("Codex");
    expect(MODEL_BASE_PROMPT).not.toContain("GPT-5");
    expect(MODEL_BASE_PROMPT).not.toContain("apply_patch");
  });
});

describe("selectModelPrompt", () => {
  it("未知/缺省模型只用通用 base（default 族）", () => {
    const p = selectModelPrompt(undefined);
    expect(p.name).toBe("model/default");
    expect(p.template).toBe(MODEL_BASE_PROMPT);

    const u = selectModelPrompt("some-unknown-model");
    expect(u.name).toBe("model/default");
    expect(u.template).toBe(MODEL_BASE_PROMPT);
  });

  it("qwen 系列在 base 之上追加补充（前缀匹配 + 大小写不敏感）", () => {
    for (const name of ["qwen", "qwen3.7-max", "QWEN3.8-MAX"]) {
      const p = selectModelPrompt(name);
      expect(p.name).toBe("model/qwen");
      expect(p.template.startsWith(MODEL_BASE_PROMPT)).toBe(true);
      expect(p.template).toContain("针对当前模型的补充");
      expect(p.template).toContain("默认用中文回复");
    }
  });

  it("补充段绝不复述身份/codex 内容", () => {
    const p = selectModelPrompt("qwen3.7-max");
    expect(p.template).not.toContain("Codex");
  });
});

describe("renderModelPrompt", () => {
  it("渲染后无残留模板变量", () => {
    const rendered = renderModelPrompt(selectModelPrompt("qwen3.7-max"));
    expect(rendered).not.toMatch(/\{\{\s*\w+\s*\}\}/);
    expect(rendered).toContain("工作规约");
  });
});

describe("modelPrompts", () => {
  it("含 default 与各已知模型族，名字唯一", () => {
    const names = modelPrompts.map((p) => p.name);
    expect(names).toContain("model/default");
    expect(names).toContain("model/qwen");
    expect(new Set(names).size).toBe(names.length);
  });
});
