import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { ModelProviderProxy } from "@/provider/proxy.js";
import { RouterPolicy } from "@/provider/router.js";
import type { ChatCompletionChunk, ProviderConfig } from "@/provider/types.js";

function mockUpstream(handler: (body: string, res: import("node:http").ServerResponse) => void): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => handler(Buffer.concat(chunks).toString(), res));
    });
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as { port: number }).port, close: () => new Promise<void>((r) => server.close(() => r())) }));
  });
}

describe("RouterPolicy — alias + fallback chain", () => {
  const a: ProviderConfig = { provider: "p", model: "model-a", baseUrl: "http://a/v1", apiKey: "k" };
  const b: ProviderConfig = { provider: "p", model: "model-b", baseUrl: "http://b/v1", apiKey: "k" };

  it("resolves exact alias, then wildcard", () => {
    const r = new RouterPolicy({ routes: [{ match: "fast", config: a }, { match: "*", config: b }] });
    expect(r.resolve("fast").model).toBe("model-a");
    expect(r.resolve("unknown").model).toBe("model-b");
  });

  it("chain = primary + fallback, deduped", () => {
    const r = new RouterPolicy({ routes: [{ match: "*", config: a }], fallback: [b, a] });
    const chain = r.chain("x");
    expect(chain.map((c) => c.model)).toEqual(["model-a", "model-b"]);
  });

  it("single() degenerate", () => {
    expect(RouterPolicy.single(a).resolve().model).toBe("model-a");
  });

  it("no-wildcard route falls back to first route; empty routes throws", () => {
    const r = new RouterPolicy({ routes: [{ match: "only", config: a }] });
    expect(r.resolve("nomatch").model).toBe("model-a"); // no "*" → first route
    const empty = new RouterPolicy({ routes: [] });
    expect(() => empty.resolve("x")).toThrow();
  });
});

describe("proxy — session token auth (requireAuth)", () => {
  const proxies: ModelProviderProxy[] = [];
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const p of proxies) await p.stop(); for (const c of closers) await c(); proxies.length = 0; closers.length = 0; });

  function okUpstream() {
    return mockUpstream((_b, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  }

  it("401 without token, 200 with correct token", async () => {
    const up = await okUpstream(); closers.push(up.close);
    const proxy = new ModelProviderProxy({
      config: { provider: "t", model: "m", baseUrl: `http://127.0.0.1:${up.port}/v1`, apiKey: "k" },
      sessionToken: "secret-tok",
      requireAuth: true,
    });
    proxies.push(proxy);
    await proxy.start();
    expect(proxy.sessionToken).toBe("secret-tok");

    const noAuth = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    expect(noAuth.status).toBe(401);

    const withAuth = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer secret-tok" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    expect(withAuth.status).toBe(200);
    expect(await withAuth.text()).toContain("ok");
  });

  it("401 with wrong token; x-api-key also accepted", async () => {
    const up = await okUpstream(); closers.push(up.close);
    const proxy = new ModelProviderProxy({
      config: { provider: "t", model: "m", baseUrl: `http://127.0.0.1:${up.port}/v1`, apiKey: "k" },
      sessionToken: "right", requireAuth: true,
    });
    proxies.push(proxy);
    await proxy.start();

    const wrong = await fetch(`${proxy.baseUrl}/v1/models`, { headers: { Authorization: "Bearer wrong" } });
    expect(wrong.status).toBe(401);

    const viaApiKey = await fetch(`${proxy.baseUrl}/v1/models`, { headers: { "x-api-key": "right" } });
    expect(viaApiKey.status).toBe(200);
  });

  it("no enforcement when requireAuth is off (default)", async () => {
    const proxy = new ModelProviderProxy({ config: { provider: "t", model: "m", baseUrl: "http://unused", apiKey: "k" } });
    proxies.push(proxy);
    await proxy.start();
    const res = await fetch(`${proxy.baseUrl}/v1/models`); // no auth header
    expect(res.status).toBe(200);
  });

  it("RouterPolicy fallback: primary upstream fails before first chunk → fallback serves the request", async () => {
    const bad = await mockUpstream((_b, res) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "boom" } })); });
    closers.push(bad.close);
    const good = await okUpstream(); closers.push(good.close);

    const primary: ProviderConfig = { provider: "p", model: "primary", baseUrl: `http://127.0.0.1:${bad.port}/v1`, apiKey: "k" };
    const fallback: ProviderConfig = { provider: "p", model: "fallback", baseUrl: `http://127.0.0.1:${good.port}/v1`, apiKey: "k" };
    const proxy = new ModelProviderProxy({
      config: primary,
      router: new RouterPolicy({ routes: [{ match: "*", config: primary }], fallback: [fallback] }),
    });
    proxies.push(proxy);
    await proxy.start();

    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("ok"); // served by fallback
  });
});
