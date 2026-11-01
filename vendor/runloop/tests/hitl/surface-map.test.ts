import { describe, it, expect, afterEach, vi } from "vitest";
import { StaticHitlSurfaceMapper, OpenAIHitlSurfaceMapper } from "@/hitl/surface-map.js";

/**
 * F3 纯 HITL LLM 映射（AD-026 增补）：把一个已产出的 suspend 映射到「最适合渲染它的客户端工具」。
 * out-of-band（仿 judge.ts/phrasing.ts）：独立 LLM 调用、只含 HITL 提示词、不碰 codex transcript、失败回落静态。
 */
afterEach(() => vi.unstubAllGlobals());

describe("StaticHitlSurfaceMapper", () => {
  const m = new StaticHitlSurfaceMapper();
  const tools = [
    { name: "super_agent_confirm", description: "请用户确认操作" },
    { name: "super_agent_choices", description: "让用户在多个选项中选择" },
    { name: "super_agent_form", description: "收集表单输入" },
  ];

  it("confirm → 选名字含 confirm 的工具", async () => {
    const out = await m.map({ prompt: "确认吗？", kind: "confirm", clientTools: tools });
    expect(out.toolName).toBe("super_agent_confirm");
  });

  it("choice → 选名字含 choice/choices/select 的工具", async () => {
    const out = await m.map({ prompt: "选一个", kind: "choice", options: ["A", "B", "C"], clientTools: tools });
    expect(out.toolName).toBe("super_agent_choices");
  });

  it("input → 无静态匹配规则 → 空（回落 NL）", async () => {
    const out = await m.map({ prompt: "请输入邮箱", kind: "input", clientTools: tools });
    expect(out.toolName).toBeUndefined();
  });

  it("无匹配工具 → 空", async () => {
    const out = await m.map({ prompt: "确认吗？", kind: "confirm", clientTools: [{ name: "weather", description: "查天气" }] });
    expect(out.toolName).toBeUndefined();
  });

  it("无 client tools → 空", async () => {
    const out = await m.map({ prompt: "确认吗？", kind: "confirm" });
    expect(out.toolName).toBeUndefined();
  });
});

describe("OpenAIHitlSurfaceMapper", () => {
  const tools = [
    { name: "super_agent_confirm", description: "请用户确认操作" },
    { name: "super_agent_choices", description: "让用户在多个选项中选择" },
  ];

  function stubFetch(content: string, status = 200) {
    const spy = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status })),
    );
    vi.stubGlobal("fetch", spy as unknown as typeof fetch);
    return spy;
  }

  it("解析模型返回的 {toolName}，且名字必须在 clientTools 内", async () => {
    stubFetch(JSON.stringify({ toolName: "super_agent_choices" }));
    const m = new OpenAIHitlSurfaceMapper({ model: "m", baseUrl: "https://up", apiKey: "k" });
    const out = await m.map({ prompt: "选一个", kind: "choice", options: ["A", "B"], clientTools: tools });
    expect(out.toolName).toBe("super_agent_choices");
  });

  it("out-of-band：打 /chat/completions、temperature 0", async () => {
    const spy = stubFetch(JSON.stringify({ toolName: "super_agent_confirm" }));
    const m = new OpenAIHitlSurfaceMapper({ model: "m", baseUrl: "https://up", apiKey: "k" });
    await m.map({ prompt: "确认吗？", kind: "confirm", clientTools: tools });
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain("/chat/completions");
    expect(JSON.parse(init.body as string).temperature).toBe(0);
  });

  it("模型明确返回空 toolName → 空（回落 NL，不再静态兜底）", async () => {
    stubFetch(JSON.stringify({ toolName: "" }));
    const m = new OpenAIHitlSurfaceMapper({ model: "m", baseUrl: "https://up", apiKey: "k" });
    const out = await m.map({ prompt: "请输入邮箱", kind: "input", clientTools: tools });
    expect(out.toolName).toBeUndefined();
  });

  it("模型返回不存在的工具名 → 回落静态映射", async () => {
    stubFetch(JSON.stringify({ toolName: "nonexistent_tool" }));
    const m = new OpenAIHitlSurfaceMapper({ model: "m", baseUrl: "https://up", apiKey: "k" });
    // kind=confirm + 含 confirm 的工具 → 静态兜底选中 super_agent_confirm
    const out = await m.map({ prompt: "确认吗？", kind: "confirm", clientTools: tools });
    expect(out.toolName).toBe("super_agent_confirm");
  });

  it("HTTP 错误 → 回落静态映射", async () => {
    stubFetch("err", 500);
    const m = new OpenAIHitlSurfaceMapper({ model: "m", baseUrl: "https://up", apiKey: "k" });
    const out = await m.map({ prompt: "选一个", kind: "choice", clientTools: tools });
    expect(out.toolName).toBe("super_agent_choices");
  });

  it("非法 JSON → 回落静态映射", async () => {
    stubFetch("这不是 JSON");
    const m = new OpenAIHitlSurfaceMapper({ model: "m", baseUrl: "https://up", apiKey: "k" });
    const out = await m.map({ prompt: "确认吗？", kind: "confirm", clientTools: tools });
    expect(out.toolName).toBe("super_agent_confirm");
  });

  it("无 client tools → 直接空、不调模型", async () => {
    const spy = stubFetch(JSON.stringify({ toolName: "x" }));
    const m = new OpenAIHitlSurfaceMapper({ model: "m", baseUrl: "https://up", apiKey: "k" });
    const out = await m.map({ prompt: "确认吗？", kind: "confirm", clientTools: [] });
    expect(out.toolName).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });
});
