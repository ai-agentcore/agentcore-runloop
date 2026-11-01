import { describe, it, expect, afterEach, vi } from "vitest";
import { StaticHitlPhrasing, OpenAIHitlPhrasing } from "@/hitl/phrasing.js";

afterEach(() => vi.unstubAllGlobals());

describe("StaticHitlPhrasing", () => {
  const p = new StaticHitlPhrasing();

  it("默认 zh：prompt 含工具名，词表含中文肯定/否定词", async () => {
    const out = await p.phrase({ toolName: "drop_db", reason: "static_rule" });
    expect(out.prompt).toContain("drop_db");
    expect(out.affirmativeWords).toContain("是");
    expect(out.affirmativeWords).toContain("可以");
    expect(out.negativeWords).toContain("否");
    expect(out.negativeWords).toContain("取消");
  });

  it("locale=en：prompt 走英文，词表含英文 yes/no", async () => {
    const out = await p.phrase({ toolName: "drop_db", reason: "static_rule", locale: "en-US" });
    expect(out.prompt.toLowerCase()).toContain("drop_db");
    expect(out.affirmativeWords).toContain("yes");
    expect(out.negativeWords).toContain("no");
  });
});

describe("OpenAIHitlPhrasing", () => {
  function stubFetch(content: string, status = 200) {
    const spy = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status }),
      ),
    );
    vi.stubGlobal("fetch", spy as unknown as typeof fetch);
    return spy;
  }

  it("解析模型返回的 JSON {prompt, affirmativeWords, negativeWords}", async () => {
    stubFetch(JSON.stringify({
      prompt: "是否允许删除数据库 drop_db？",
      affirmativeWords: ["允许删除", "确认"],
      negativeWords: ["别删", "取消"],
    }));
    const p = new OpenAIHitlPhrasing({ model: "m", baseUrl: "https://up", apiKey: "k" });
    const out = await p.phrase({ toolName: "drop_db", reason: "static_rule" });
    expect(out.prompt).toContain("drop_db");
    // 模型词 + 静态默认词并集（保证常见确认/拒绝词恒命中），去重
    expect(out.affirmativeWords).toContain("允许删除");
    expect(out.affirmativeWords).toContain("是"); // 静态默认仍在
    expect(out.negativeWords).toContain("别删");
    expect(out.negativeWords).toContain("否");
    expect(new Set(out.affirmativeWords).size).toBe(out.affirmativeWords.length); // 去重
  });

  it("out-of-band 调用：打 /chat/completions、temperature 0", async () => {
    const spy = stubFetch(JSON.stringify({ prompt: "x", affirmativeWords: ["是"], negativeWords: ["否"] }));
    const p = new OpenAIHitlPhrasing({ model: "m", baseUrl: "https://up", apiKey: "k" });
    await p.phrase({ toolName: "t", reason: "static_rule" });
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain("/chat/completions");
    expect(JSON.parse(init.body as string).temperature).toBe(0);
  });

  it("模型返回非法 JSON → 回落静态（prompt 含工具名 + 默认词表）", async () => {
    stubFetch("这不是 JSON");
    const p = new OpenAIHitlPhrasing({ model: "m", baseUrl: "https://up", apiKey: "k" });
    const out = await p.phrase({ toolName: "drop_db", reason: "static_rule" });
    expect(out.prompt).toContain("drop_db");
    expect(out.affirmativeWords).toContain("是");
    expect(out.negativeWords).toContain("否");
  });

  it("HTTP 错误 → 回落静态", async () => {
    stubFetch("err", 500);
    const p = new OpenAIHitlPhrasing({ model: "m", baseUrl: "https://up", apiKey: "k" });
    const out = await p.phrase({ toolName: "drop_db", reason: "static_rule" });
    expect(out.prompt).toContain("drop_db");
    expect(out.affirmativeWords.length).toBeGreaterThan(0);
  });

  it("JSON 合法但缺 affirmativeWords/negativeWords → 仅这两字段回落静态、保留模型 prompt", async () => {
    stubFetch(JSON.stringify({ prompt: "模型给的提问 drop_db", affirmativeWords: [], negativeWords: undefined }));
    const p = new OpenAIHitlPhrasing({ model: "m", baseUrl: "https://up", apiKey: "k" });
    const out = await p.phrase({ toolName: "drop_db", reason: "static_rule" });
    expect(out.prompt).toBe("模型给的提问 drop_db"); // 模型 prompt 保留
    expect(out.affirmativeWords).toContain("是"); // 词表回落静态
    expect(out.negativeWords).toContain("否");
  });
});
