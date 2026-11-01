import { describe, expect, it, vi, afterEach } from "vitest";
import { callWebSearch } from "@/sidecar/web-caller.js";

describe("callWebSearch", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns error when URL is empty", async () => {
    const result = JSON.parse(await callWebSearch("test", "", ""));
    expect(result.error).toContain("not configured");
  });

  it("sends POST with Bearer auth and returns search results", async () => {
    const mockResponse = {
      result: { search_result: [{ title: "T", link: "http://x", snippet: "S", content: "C", position: 1 }] },
      usage: { search_count: 1 },
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const result = JSON.parse(await callWebSearch("hello", "https://search.example.com", "sk-test"));
    expect(result.result.search_result).toHaveLength(1);
    expect(result.result.search_result[0].title).toBe("T");

    const [url, opts] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://search.example.com");
    expect((opts as RequestInit).method).toBe("POST");
    expect((opts as RequestInit).headers).toMatchObject({ Authorization: "Bearer sk-test" });
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.query).toBe("hello");
    expect(body.history).toEqual([]);
  });

  it("omits Authorization header when apiKey is empty", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: { search_result: [] } }),
    } as Response);

    await callWebSearch("q", "https://search.example.com", "");
    const headers = (vi.mocked(fetch).mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("returns error on non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => "forbidden",
    } as Response);

    const result = JSON.parse(await callWebSearch("q", "https://x.com", "key"));
    expect(result.error).toContain("403");
    expect(result.detail).toBe("forbidden");
  });

  it("returns error on timeout", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(
      () => new Promise((_, reject) => {
        const err = new DOMException("aborted", "AbortError");
        setTimeout(() => reject(err), 10);
      }),
    );

    const result = JSON.parse(await callWebSearch("q", "https://x.com", "key", 5));
    expect(result.error).toContain("timed out");
  });

  it("returns error on network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = JSON.parse(await callWebSearch("q", "https://x.com", "key"));
    expect(result.error).toContain("ECONNREFUSED");
  });
});
