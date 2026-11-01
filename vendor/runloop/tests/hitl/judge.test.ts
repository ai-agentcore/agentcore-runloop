import { describe, it, expect, vi } from "vitest";
import { OpenAILlmJudge, StaticLlmJudge } from "@/hitl/judge.js";

describe("StaticLlmJudge", () => {
  it("returns default action", async () => {
    const judge = new StaticLlmJudge("allow");
    const result = await judge.evaluate({
      toolName: "test",
      args: {},
    });
    expect(result.action).toBe("allow");
    expect(result.reason).toBe("static judge");
  });

  it("defaults to ask", async () => {
    const judge = new StaticLlmJudge();
    const result = await judge.evaluate({
      toolName: "test",
      args: {},
    });
    expect(result.action).toBe("ask");
  });

  it("can be configured to block", async () => {
    const judge = new StaticLlmJudge("block");
    const result = await judge.evaluate({
      toolName: "test",
      args: {},
    });
    expect(result.action).toBe("block");
  });
});

describe("OpenAILlmJudge", () => {
  it("returns ask on network error", async () => {
    const judge = new OpenAILlmJudge({
      provider: "openai",
      model: "gpt-4o-mini",
      baseUrl: "http://localhost:99999",
      timeoutMs: 1000,
    });

    const result = await judge.evaluate({
      toolName: "dangerous_tool",
      args: { target: "production" },
    });

    expect(result.action).toBe("ask");
    expect(result.reason).toContain("LLM judge failed");
  });

  it("returns ask on non-ok response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    const judge = new OpenAILlmJudge({
      provider: "openai",
      model: "gpt-4o-mini",
      baseUrl: "http://localhost:3999",
    });

    const result = await judge.evaluate({
      toolName: "test",
      args: {},
    });

    expect(result.action).toBe("ask");
    expect(result.reason).toContain("API error: 500");
    globalThis.fetch = originalFetch;
  });

  it("parses ALLOW response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ALLOW - this is safe" } }],
      }),
    });

    const judge = new OpenAILlmJudge({
      provider: "openai",
      model: "gpt-4o-mini",
      baseUrl: "http://mock",
    });

    const result = await judge.evaluate({
      toolName: "read_file",
      args: { path: "readme.md" },
    });

    expect(result.action).toBe("allow");
    globalThis.fetch = originalFetch;
  });

  it("parses BLOCK response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "BLOCK - destructive operation" } }],
      }),
    });

    const judge = new OpenAILlmJudge({
      provider: "openai",
      model: "gpt-4o-mini",
      baseUrl: "http://mock",
    });

    const result = await judge.evaluate({
      toolName: "rm_rf",
      args: { path: "/" },
    });

    expect(result.action).toBe("block");
    globalThis.fetch = originalFetch;
  });

  it("parses ambiguous response as ask", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "I'm not sure about this" } }],
      }),
    });

    const judge = new OpenAILlmJudge({
      provider: "openai",
      model: "gpt-4o-mini",
      baseUrl: "http://mock",
    });

    const result = await judge.evaluate({
      toolName: "unknown_tool",
      args: {},
    });

    expect(result.action).toBe("ask");
    globalThis.fetch = originalFetch;
  });

  it("includes context in prompt when provided", async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: string | undefined;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
      capturedBody = opts.body;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "ALLOW" } }],
        }),
      };
    });

    const judge = new OpenAILlmJudge({
      provider: "openai",
      model: "gpt-4o-mini",
      baseUrl: "http://mock",
      apiKey: "test-key",
    });

    await judge.evaluate({
      toolName: "deploy",
      args: { env: "staging" },
      context: "User is deploying to staging environment",
    });

    expect(capturedBody).toContain("Context:");
    expect(capturedBody).toContain("staging");
    globalThis.fetch = originalFetch;
  });

  it("handles empty choices", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [] }),
    });

    const judge = new OpenAILlmJudge({
      provider: "openai",
      model: "gpt-4o-mini",
      baseUrl: "http://mock",
    });

    const result = await judge.evaluate({
      toolName: "test",
      args: {},
    });

    expect(result.action).toBe("ask");
    globalThis.fetch = originalFetch;
  });
});
