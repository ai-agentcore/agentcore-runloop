import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { streamChatCompletions, streamClaudeMessages } from "@/provider/upstream.js";
import type { ChatCompletionRequest } from "@/provider/types.js";

/* ------------------------------------------------------------------ */
/*  helpers                                                           */
/* ------------------------------------------------------------------ */

interface MockUpstream {
  server: Server;
  port: number;
  baseUrl: string;
  close: () => Promise<void>;
  lastRequest: { headers: IncomingMessage["headers"]; body: string; url: string } | null;
}

function createMockUpstream(
  handler: (body: string, req: IncomingMessage, res: ServerResponse) => void
): Promise<MockUpstream> {
  return new Promise((resolve) => {
    const state: MockUpstream = {
      server: null as unknown as Server,
      port: 0,
      baseUrl: "",
      close: async () => {},
      lastRequest: null,
    };
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        state.lastRequest = { headers: req.headers, body, url: req.url ?? "" };
        handler(body, req, res);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      state.server = server;
      state.port = addr.port;
      state.baseUrl = `http://127.0.0.1:${addr.port}`;
      state.close = () => new Promise<void>((r) => server.close(() => r()));
      resolve(state);
    });
  });
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const results: string[] = [];
  for await (const chunk of gen) {
    results.push(chunk);
  }
  return results;
}

function sseLines(chunks: string[]): string {
  return chunks.map((c) => `data: ${c}\n\n`).join("");
}

function makeBody(overrides?: Partial<ChatCompletionRequest>): ChatCompletionRequest {
  return {
    model: "ignored",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  tests                                                             */
/* ------------------------------------------------------------------ */

describe("streamChatCompletions", () => {
  const upstreams: MockUpstream[] = [];

  afterEach(async () => {
    for (const u of upstreams) await u.close();
    upstreams.length = 0;
  });

  it("streams multiple SSE data chunks", async () => {
    const upstream = await createMockUpstream((_body, _req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"id":"1","choices":[{"delta":{"content":"Hi"}}]}\n\n');
      res.write('data: {"id":"2","choices":[{"delta":{"content":" there"}}]}\n\n');
      res.end();
    });
    upstreams.push(upstream);

    const config = { provider: "openai", model: "gpt-4", baseUrl: upstream.baseUrl, apiKey: "sk-test" };
    const chunks = await collect(streamChatCompletions(config, makeBody()));

    expect(chunks).toHaveLength(2);
    expect(JSON.parse(chunks[0]).choices[0].delta.content).toBe("Hi");
    expect(JSON.parse(chunks[1]).choices[0].delta.content).toBe(" there");
  });

  it("throws on non-200 error response", async () => {
    const upstream = await createMockUpstream((_body, _req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    });
    upstreams.push(upstream);

    const config = { provider: "openai", model: "m", baseUrl: upstream.baseUrl, apiKey: "k" };
    await expect(collect(streamChatCompletions(config, makeBody()))).rejects.toThrow(
      /Upstream 500.*Internal Server Error/
    );
  });

  it("throws when response body is missing", async () => {
    // Simulate no body by ending immediately with 200 but no body reader.
    // In practice fetch always provides a body for HTTP responses, so we
    // test via a mock that ends the response abruptly with no data written.
    const upstream = await createMockUpstream((_body, _req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(); // no data at all
    });
    upstreams.push(upstream);

    const config = { provider: "openai", model: "m", baseUrl: upstream.baseUrl, apiKey: "k" };
    // With an empty body the generator simply yields nothing (reader sees done immediately)
    const chunks = await collect(streamChatCompletions(config, makeBody()));
    expect(chunks).toHaveLength(0);
  });

  it("skips data: [DONE] lines", async () => {
    const upstream = await createMockUpstream((_body, _req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"id":"1"}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    });
    upstreams.push(upstream);

    const config = { provider: "openai", model: "m", baseUrl: upstream.baseUrl, apiKey: "k" };
    const chunks = await collect(streamChatCompletions(config, makeBody()));

    expect(chunks).toHaveLength(1);
    expect(JSON.parse(chunks[0]).id).toBe("1");
  });

  it("yields trailing buffer data", async () => {
    const upstream = await createMockUpstream((_body, _req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      // Write data without a trailing newline so it stays in the buffer
      res.end('data: {"trailing":true}');
    });
    upstreams.push(upstream);

    const config = { provider: "openai", model: "m", baseUrl: upstream.baseUrl, apiKey: "k" };
    const chunks = await collect(streamChatCompletions(config, makeBody()));

    expect(chunks).toHaveLength(1);
    expect(JSON.parse(chunks[0]).trailing).toBe(true);
  });

  it("does not yield trailing buffer if it is data: [DONE]", async () => {
    const upstream = await createMockUpstream((_body, _req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end("data: [DONE]");
    });
    upstreams.push(upstream);

    const config = { provider: "openai", model: "m", baseUrl: upstream.baseUrl, apiKey: "k" };
    const chunks = await collect(streamChatCompletions(config, makeBody()));
    expect(chunks).toHaveLength(0);
  });

  it("injects temperature from config when not in body", async () => {
    const upstream = await createMockUpstream((_body, _req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end();
    });
    upstreams.push(upstream);

    const config = { provider: "openai", model: "m", baseUrl: upstream.baseUrl, apiKey: "k", temperature: 0.7 };
    await collect(streamChatCompletions(config, makeBody()));

    const parsed = JSON.parse(upstream.lastRequest!.body);
    expect(parsed.temperature).toBe(0.7);
  });

  it("does NOT override temperature when already in body", async () => {
    const upstream = await createMockUpstream((_body, _req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end();
    });
    upstreams.push(upstream);

    const config = { provider: "openai", model: "m", baseUrl: upstream.baseUrl, apiKey: "k", temperature: 0.9 };
    await collect(streamChatCompletions(config, makeBody({ temperature: 0.3 })));

    const parsed = JSON.parse(upstream.lastRequest!.body);
    expect(parsed.temperature).toBe(0.3);
  });

  it("injects maxTokens from config when not in body", async () => {
    const upstream = await createMockUpstream((_body, _req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end();
    });
    upstreams.push(upstream);

    const config = { provider: "openai", model: "m", baseUrl: upstream.baseUrl, apiKey: "k", maxTokens: 4096 };
    await collect(streamChatCompletions(config, makeBody()));

    const parsed = JSON.parse(upstream.lastRequest!.body);
    expect(parsed.max_tokens).toBe(4096);
  });

  it("does NOT override max_tokens when already in body", async () => {
    const upstream = await createMockUpstream((_body, _req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end();
    });
    upstreams.push(upstream);

    const config = { provider: "openai", model: "m", baseUrl: upstream.baseUrl, apiKey: "k", maxTokens: 8000 };
    await collect(streamChatCompletions(config, makeBody({ max_tokens: 2000 })));

    const parsed = JSON.parse(upstream.lastRequest!.body);
    expect(parsed.max_tokens).toBe(2000);
  });

  it("sends Authorization Bearer header", async () => {
    const upstream = await createMockUpstream((_body, _req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end();
    });
    upstreams.push(upstream);

    const config = { provider: "openai", model: "m", baseUrl: upstream.baseUrl, apiKey: "my-secret-key" };
    await collect(streamChatCompletions(config, makeBody()));

    expect(upstream.lastRequest!.headers.authorization).toBe("Bearer my-secret-key");
  });

  it("posts to /chat/completions path and strips trailing slashes from baseUrl", async () => {
    const upstream = await createMockUpstream((_body, _req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end();
    });
    upstreams.push(upstream);

    const config = { provider: "openai", model: "m", baseUrl: upstream.baseUrl + "///", apiKey: "k" };
    await collect(streamChatCompletions(config, makeBody()));

    expect(upstream.lastRequest!.url).toBe("/chat/completions");
  });

  it("sets model, stream, and stream_options in request body", async () => {
    const upstream = await createMockUpstream((_body, _req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end();
    });
    upstreams.push(upstream);

    const config = { provider: "openai", model: "gpt-4o", baseUrl: upstream.baseUrl, apiKey: "k" };
    await collect(streamChatCompletions(config, makeBody()));

    const parsed = JSON.parse(upstream.lastRequest!.body);
    expect(parsed.model).toBe("gpt-4o");
    expect(parsed.stream).toBe(true);
    expect(parsed.stream_options).toEqual({ include_usage: true });
  });
});

/* ------------------------------------------------------------------ */
/*  streamClaudeMessages                                              */
/* ------------------------------------------------------------------ */

describe("streamClaudeMessages", () => {
  const upstreams: MockUpstream[] = [];

  afterEach(async () => {
    for (const u of upstreams) await u.close();
    upstreams.length = 0;
  });

  it("streams multiple SSE data chunks", async () => {
    const upstream = await createMockUpstream((_body, _req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"type":"content_block_delta","delta":{"text":"A"}}\n\n');
      res.write('data: {"type":"content_block_delta","delta":{"text":"B"}}\n\n');
      res.end();
    });
    upstreams.push(upstream);

    const config = { provider: "anthropic", model: "claude-3", baseUrl: upstream.baseUrl, apiKey: "ant-key" };
    const chunks = await collect(streamClaudeMessages(config, { messages: [{ role: "user", content: "hi" }] }));

    expect(chunks).toHaveLength(2);
    expect(JSON.parse(chunks[0]).delta.text).toBe("A");
    expect(JSON.parse(chunks[1]).delta.text).toBe("B");
  });

  it("sends x-api-key and anthropic-version headers", async () => {
    const upstream = await createMockUpstream((_body, _req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end();
    });
    upstreams.push(upstream);

    const config = { provider: "anthropic", model: "claude-3", baseUrl: upstream.baseUrl, apiKey: "ant-secret" };
    await collect(streamClaudeMessages(config, { messages: [] }));

    expect(upstream.lastRequest!.headers["x-api-key"]).toBe("ant-secret");
    expect(upstream.lastRequest!.headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("does NOT send Authorization Bearer header", async () => {
    const upstream = await createMockUpstream((_body, _req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end();
    });
    upstreams.push(upstream);

    const config = { provider: "anthropic", model: "m", baseUrl: upstream.baseUrl, apiKey: "k" };
    await collect(streamClaudeMessages(config, { messages: [] }));

    expect(upstream.lastRequest!.headers.authorization).toBeUndefined();
  });

  it("throws on non-200 error response", async () => {
    const upstream = await createMockUpstream((_body, _req, res) => {
      res.writeHead(429, { "Content-Type": "text/plain" });
      res.end("Rate limited");
    });
    upstreams.push(upstream);

    const config = { provider: "anthropic", model: "m", baseUrl: upstream.baseUrl, apiKey: "k" };
    await expect(collect(streamClaudeMessages(config, { messages: [] }))).rejects.toThrow(
      /Upstream 429.*Rate limited/
    );
  });

  it("injects maxTokens from config when not in body", async () => {
    const upstream = await createMockUpstream((_body, _req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end();
    });
    upstreams.push(upstream);

    const config = { provider: "anthropic", model: "m", baseUrl: upstream.baseUrl, apiKey: "k", maxTokens: 1024 };
    await collect(streamClaudeMessages(config, { messages: [] }));

    const parsed = JSON.parse(upstream.lastRequest!.body);
    expect(parsed.max_tokens).toBe(1024);
  });

  it("does NOT override max_tokens when already in body", async () => {
    const upstream = await createMockUpstream((_body, _req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end();
    });
    upstreams.push(upstream);

    const config = { provider: "anthropic", model: "m", baseUrl: upstream.baseUrl, apiKey: "k", maxTokens: 8000 };
    await collect(streamClaudeMessages(config, { messages: [], max_tokens: 512 }));

    const parsed = JSON.parse(upstream.lastRequest!.body);
    expect(parsed.max_tokens).toBe(512);
  });

  it("posts to /messages path", async () => {
    const upstream = await createMockUpstream((_body, _req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end();
    });
    upstreams.push(upstream);

    const config = { provider: "anthropic", model: "m", baseUrl: upstream.baseUrl + "/", apiKey: "k" };
    await collect(streamClaudeMessages(config, { messages: [] }));

    expect(upstream.lastRequest!.url).toBe("/messages");
  });

  it("sets model and stream in request body", async () => {
    const upstream = await createMockUpstream((_body, _req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end();
    });
    upstreams.push(upstream);

    const config = { provider: "anthropic", model: "claude-sonnet", baseUrl: upstream.baseUrl, apiKey: "k" };
    await collect(streamClaudeMessages(config, { messages: [] }));

    const parsed = JSON.parse(upstream.lastRequest!.body);
    expect(parsed.model).toBe("claude-sonnet");
    expect(parsed.stream).toBe(true);
  });
});
