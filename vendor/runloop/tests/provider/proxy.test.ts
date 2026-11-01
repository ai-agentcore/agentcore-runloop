import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import { ModelProviderProxy } from "@/provider/proxy.js";

function createMockUpstream(
  handler: (body: string, res: import("node:http").ServerResponse) => void
): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => handler(Buffer.concat(chunks).toString(), res));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        server,
        port: addr.port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe("ModelProviderProxy", () => {
  const proxies: ModelProviderProxy[] = [];
  const upstreams: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    for (const p of proxies) await p.stop();
    for (const u of upstreams) await u.close();
    proxies.length = 0;
    upstreams.length = 0;
  });

  it("proxies chat completions requests", async () => {
    const upstream = await createMockUpstream((body, res) => {
      const parsed = JSON.parse(body);
      expect(parsed.model).toBe("test-model");
      expect(parsed.stream).toBe(true);
      expect(parsed.messages).toHaveLength(1);
      expect(parsed.messages[0].content).toBe("hello");

      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          model: "test-model",
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          model: "test-model",
          choices: [{ index: 0, delta: { content: "world" }, finish_reason: null }],
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          model: "test-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
    upstreams.push(upstream);

    const proxy = new ModelProviderProxy({
      config: {
        provider: "test",
        model: "test-model",
        baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
        apiKey: "test-key",
      },
    });
    proxies.push(proxy);
    await proxy.start();

    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "ignored",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"content":"world"');
    expect(text).toContain("[DONE]");
  });

  it("translates responses API to chat completions", async () => {
    const upstream = await createMockUpstream((body, res) => {
      const parsed = JSON.parse(body);
      expect(parsed.model).toBe("qwen-max");
      expect(parsed.messages[0].role).toBe("system");
      expect(parsed.messages[0].content).toBe("you are helpful");
      expect(parsed.messages[1].role).toBe("user");
      expect(parsed.messages[1].content).toBe("hi");

      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          model: "qwen-max",
          choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          model: "qwen-max",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          model: "qwen-max",
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })}\n\n`
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
    upstreams.push(upstream);

    const proxy = new ModelProviderProxy({
      config: {
        provider: "dashscope",
        model: "qwen-max",
        baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
        apiKey: "sk-test",
      },
    });
    proxies.push(proxy);
    await proxy.start();

    const res = await fetch(`${proxy.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen-max",
        instructions: "you are helpful",
        input: "hi",
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("response.created");
    expect(text).toContain("response.output_text.delta");
    expect(text).toContain('"delta":"hello"');
    expect(text).toContain("response.completed");
  });

  it("does not emit text deltas for prewarm requests (empty input)", async () => {
    const upstream = await createMockUpstream((_body, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          model: "qwen-max",
          choices: [{ index: 0, delta: { content: "prewarm greeting" }, finish_reason: null }],
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          model: "qwen-max",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
    upstreams.push(upstream);

    const proxy = new ModelProviderProxy({
      config: {
        provider: "dashscope",
        model: "qwen-max",
        baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
        apiKey: "sk-test",
      },
    });
    proxies.push(proxy);
    await proxy.start();

    const deltas: string[] = [];
    proxy.onTextDelta((c) => deltas.push(c));

    const res = await fetch(`${proxy.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen-max",
        instructions: "you are helpful",
        input: [],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    // codex CLI 仍然拿到完整 responses 流
    expect(text).toContain("response.created");
    expect(text).toContain("response.completed");
    // 但 prewarm 文本不注入主 SSE 事件流
    expect(deltas.join("")).toBe("");
  });

  it("translates claude messages to chat completions", async () => {
    const upstream = await createMockUpstream((body, res) => {
      const parsed = JSON.parse(body);
      expect(parsed.model).toBe("qwen-max");
      expect(parsed.messages[0].role).toBe("system");
      expect(parsed.messages[1].role).toBe("user");

      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          model: "qwen-max",
          choices: [{ index: 0, delta: { content: "bonjour" }, finish_reason: null }],
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          model: "qwen-max",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })}\n\n`
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
    upstreams.push(upstream);

    const proxy = new ModelProviderProxy({
      config: {
        provider: "dashscope",
        model: "qwen-max",
        baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
        apiKey: "sk-test",
      },
    });
    proxies.push(proxy);
    await proxy.start();

    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-3",
        system: "be brief",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 100,
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("message_start");
    expect(text).toContain("content_block_delta");
    expect(text).toContain("bonjour");
    expect(text).toContain("message_stop");
  });

  it("returns model list", async () => {
    const proxy = new ModelProviderProxy({
      config: {
        provider: "test",
        model: "my-model",
        baseUrl: "http://unused",
        apiKey: "unused",
      },
    });
    proxies.push(proxy);
    await proxy.start();

    const res = await fetch(`${proxy.baseUrl}/v1/models`);
    const data = await res.json();
    expect(data.data[0].id).toBe("my-model");
  });

  it("handles upstream errors", async () => {
    const upstream = await createMockUpstream((_body, res) => {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "rate limited" } }));
    });
    upstreams.push(upstream);

    const proxy = new ModelProviderProxy({
      config: {
        provider: "test",
        model: "test-model",
        baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
        apiKey: "test-key",
      },
    });
    proxies.push(proxy);
    await proxy.start();

    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });

    const text = await res.text();
    expect(text).toContain("rate limited");
  });

  it("overrides model in upstream request", async () => {
    let receivedModel = "";
    const upstream = await createMockUpstream((body, res) => {
      receivedModel = JSON.parse(body).model;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: [DONE]\n\n");
      res.end();
    });
    upstreams.push(upstream);

    const proxy = new ModelProviderProxy({
      config: {
        provider: "test",
        model: "actual-model",
        baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
        apiKey: "key",
      },
    });
    proxies.push(proxy);
    await proxy.start();

    await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "client-model",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });

    expect(receivedModel).toBe("actual-model");
  });

  it("handles WebSocket responses API", async () => {
    const upstream = await createMockUpstream((body, res) => {
      const parsed = JSON.parse(body);
      expect(parsed.model).toBe("qwen-max");
      expect(parsed.messages[0].role).toBe("system");
      expect(parsed.messages[0].content).toBe("be concise");
      expect(parsed.messages[1].role).toBe("user");
      expect(parsed.messages[1].content).toBe("hello ws");

      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          model: "qwen-max",
          choices: [{ index: 0, delta: { content: "hi from ws" }, finish_reason: null }],
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          model: "qwen-max",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          model: "qwen-max",
          choices: [],
          usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
        })}\n\n`
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
    upstreams.push(upstream);

    const proxy = new ModelProviderProxy({
      config: {
        provider: "dashscope",
        model: "qwen-max",
        baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
        apiKey: "sk-test",
      },
    });
    proxies.push(proxy);
    await proxy.start();

    const messages: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/v1/responses`);
      ws.on("open", () => {
        ws.send(JSON.stringify({
          model: "qwen-max",
          instructions: "be concise",
          input: "hello ws",
          stream: true,
        }));
      });
      ws.on("message", (data) => {
        const msg = data.toString();
        messages.push(msg);
        if (msg.includes('"type":"response.completed"')) {
          ws.close();
        }
      });
      ws.on("close", () => resolve());
      ws.on("error", reject);
    });

    const allMessages = messages.join("\n");
    expect(allMessages).toContain('"type":"response.created"');
    expect(allMessages).toContain('"type":"response.output_text.delta"');
    expect(allMessages).toContain('"delta":"hi from ws"');
    expect(allMessages).toContain('"type":"response.completed"');
    expect(allMessages).toContain('"input_tokens":8');
    expect(allMessages).toContain('"output_tokens":3');
  });

  it("handles WebSocket tool calls", async () => {
    const upstream = await createMockUpstream((_body, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          model: "qwen-max",
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: "tc-1", type: "function", function: { name: "read_file", arguments: "" } }],
            },
            finish_reason: null,
          }],
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          model: "qwen-max",
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"path":"test.txt"}' } }],
            },
            finish_reason: null,
          }],
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          model: "qwen-max",
          choices: [{ index: 0, delta: { tool_calls: [] }, finish_reason: "tool_calls" }],
        })}\n\n`
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
    upstreams.push(upstream);

    const proxy = new ModelProviderProxy({
      config: {
        provider: "dashscope",
        model: "qwen-max",
        baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
        apiKey: "sk-test",
      },
    });
    proxies.push(proxy);
    await proxy.start();

    const messages: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/v1/responses`);
      ws.on("open", () => {
        ws.send(JSON.stringify({
          model: "qwen-max",
          input: "read test.txt",
          tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
        }));
      });
      ws.on("message", (data) => {
        const msg = data.toString();
        messages.push(msg);
        if (msg.includes('"type":"response.completed"')) {
          ws.close();
        }
      });
      ws.on("close", () => resolve());
      ws.on("error", reject);
    });

    const allMessages = messages.join("\n");
    expect(allMessages).toContain('"type":"response.created"');
    expect(allMessages).toContain('"type":"response.output_item.added"');
    expect(allMessages).toContain('"name":"read_file"');
    expect(allMessages).toContain('"call_id":"tc-1"');
    expect(allMessages).toContain('"arguments":"{\\"path\\":\\"test.txt\\"}"');
    expect(allMessages).toContain('"type":"response.completed"');
  });

  it("rejects WebSocket on non-responses path", async () => {
    const proxy = new ModelProviderProxy({
      config: {
        provider: "test",
        model: "test-model",
        baseUrl: "http://unused",
        apiKey: "unused",
      },
    });
    proxies.push(proxy);
    await proxy.start();

    await expect(new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/v1/chat/completions`);
      ws.on("open", () => resolve());
      ws.on("error", reject);
    })).rejects.toThrow();
  });

  it("translates claude messages with array system prompt", async () => {
    let receivedMessages: unknown[] = [];
    const upstream = await createMockUpstream((body, res) => {
      const parsed = JSON.parse(body);
      receivedMessages = parsed.messages;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          model: "qwen-max",
          choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
        })}\n\n`
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
    upstreams.push(upstream);

    const proxy = new ModelProviderProxy({
      config: {
        provider: "dashscope",
        model: "qwen-max",
        baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
        apiKey: "sk-test",
      },
    });
    proxies.push(proxy);
    await proxy.start();

    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-3",
        system: [
          { type: "text", text: "prompt1" },
          { type: "text", text: "prompt2" },
        ],
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 100,
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    // Consume the full response to ensure the upstream request completes
    await res.text();
    expect(receivedMessages[0]).toMatchObject({
      role: "system",
      content: "prompt1\nprompt2",
    });
  });

  it("translates claude messages with array content blocks", async () => {
    let receivedMessages: unknown[] = [];
    const upstream = await createMockUpstream((body, res) => {
      const parsed = JSON.parse(body);
      receivedMessages = parsed.messages;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          model: "qwen-max",
          choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
        })}\n\n`
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
    upstreams.push(upstream);

    const proxy = new ModelProviderProxy({
      config: {
        provider: "dashscope",
        model: "qwen-max",
        baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
        apiKey: "sk-test",
      },
    });
    proxies.push(proxy);
    await proxy.start();

    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-3",
        system: "be brief",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hello" },
              { type: "image", source: { type: "base64", data: "..." } },
              { type: "text", text: " world" },
            ],
          },
        ],
        max_tokens: 100,
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    // Consume the full response to ensure the upstream request completes
    await res.text();
    // Only text blocks are joined; image blocks are filtered out
    expect(receivedMessages[1]).toMatchObject({
      role: "user",
      content: "hello world",
    });
  });

  it("returns 404 for unknown endpoint", async () => {
    const proxy = new ModelProviderProxy({
      config: {
        provider: "test",
        model: "test-model",
        baseUrl: "http://unused",
        apiKey: "unused",
      },
    });
    proxies.push(proxy);
    await proxy.start();

    const res = await fetch(`${proxy.baseUrl}/v1/unknown`);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error.message).toContain("Unknown endpoint");
  });

  it("returns 501 for non-streaming chat completions", async () => {
    const proxy = new ModelProviderProxy({
      config: {
        provider: "test",
        model: "test-model",
        baseUrl: "http://unused",
        apiKey: "unused",
      },
    });
    proxies.push(proxy);
    await proxy.start();

    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    });

    expect(res.status).toBe(501);
    const data = await res.json();
    expect(data.error.message).toContain("Non-streaming not implemented");
  });

  it("updateConfig changes provider config", async () => {
    const proxy = new ModelProviderProxy({
      config: {
        provider: "test",
        model: "old-model",
        baseUrl: "http://unused",
        apiKey: "unused",
      },
    });
    proxies.push(proxy);
    await proxy.start();

    // Verify initial model
    let res = await fetch(`${proxy.baseUrl}/v1/models`);
    let data = await res.json();
    expect(data.data[0].id).toBe("old-model");

    // Update config
    proxy.updateConfig({ model: "new-model" });

    // Verify model list reflects updated config
    res = await fetch(`${proxy.baseUrl}/v1/models`);
    data = await res.json();
    expect(data.data[0].id).toBe("new-model");
    expect(data.models).toEqual([]);
  });

  it("onTextDelta unsubscribe removes listener", async () => {
    const upstream = await createMockUpstream((_body, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          model: "test-model",
          choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          model: "test-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
    upstreams.push(upstream);

    const proxy = new ModelProviderProxy({
      config: {
        provider: "test",
        model: "test-model",
        baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
        apiKey: "test-key",
      },
    });
    proxies.push(proxy);
    await proxy.start();

    const deltas: string[] = [];
    const unsubscribe = proxy.onTextDelta((c) => deltas.push(c));

    // Unsubscribe before making request
    unsubscribe();

    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    await res.text();

    // Listener should NOT have been called after unsubscribe
    expect(deltas).toEqual([]);
  });

  it("emits text deltas for non-prewarm responses requests", async () => {
    const upstream = await createMockUpstream((_body, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          model: "test-model",
          choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          model: "test-model",
          choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }],
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          model: "test-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
    upstreams.push(upstream);

    const proxy = new ModelProviderProxy({
      config: {
        provider: "test",
        model: "test-model",
        baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
        apiKey: "test-key",
      },
    });
    proxies.push(proxy);
    await proxy.start();

    const deltas: string[] = [];
    proxy.onTextDelta((c) => deltas.push(c));

    // Use responses endpoint with a non-empty string input (not prewarm)
    const res = await fetch(`${proxy.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test-model",
        input: "hi there",
        stream: true,
      }),
    });
    await res.text();

    expect(deltas).toEqual(["hello", " world"]);
  });

  it("stops cleanly when server is null", async () => {
    const proxy = new ModelProviderProxy({
      config: {
        provider: "test",
        model: "test-model",
        baseUrl: "http://unused",
        apiKey: "unused",
      },
    });
    // Do NOT call proxy.start() — server is null
    // stop() should resolve without error
    await expect(proxy.stop()).resolves.toBeUndefined();
  });

  it("handles upstream error in responses endpoint", async () => {
    const upstream = await createMockUpstream((_body, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "internal server error" } }));
    });
    upstreams.push(upstream);

    const proxy = new ModelProviderProxy({
      config: {
        provider: "test",
        model: "test-model",
        baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
        apiKey: "test-key",
      },
    });
    proxies.push(proxy);
    await proxy.start();

    const res = await fetch(`${proxy.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test-model",
        input: "hello",
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    // Should contain an error event from the catch block
    expect(text).toContain("error");
    expect(text).toContain("Upstream 500");
  });

  it("handles upstream error in claude messages endpoint", async () => {
    const upstream = await createMockUpstream((_body, res) => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad gateway" } }));
    });
    upstreams.push(upstream);

    const proxy = new ModelProviderProxy({
      config: {
        provider: "test",
        model: "test-model",
        baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
        apiKey: "test-key",
      },
    });
    proxies.push(proxy);
    await proxy.start();

    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-3",
        system: "be brief",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 100,
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    // Should contain a Claude-format error event
    expect(text).toContain("event: error");
    expect(text).toContain("api_error");
    expect(text).toContain("Upstream 502");
  });

  it("handles responses with no content generated", async () => {
    const upstream = await createMockUpstream((_body, res) => {
      // Return an empty stream — no choices, just usage then DONE
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: [DONE]\n\n");
      res.end();
    });
    upstreams.push(upstream);

    const proxy = new ModelProviderProxy({
      config: {
        provider: "test",
        model: "test-model",
        baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
        apiKey: "test-key",
      },
    });
    proxies.push(proxy);
    await proxy.start();

    const res = await fetch(`${proxy.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test-model",
        input: "hello",
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("No content generated");
    // Should still have response.created and response.completed
    expect(text).toContain("response.created");
    expect(text).toContain("response.completed");
  });

  it("handles models endpoint with query string", async () => {
    const proxy = new ModelProviderProxy({
      config: {
        provider: "test",
        model: "my-model",
        baseUrl: "http://unused",
        apiKey: "unused",
      },
    });
    proxies.push(proxy);
    await proxy.start();

    const res = await fetch(`${proxy.baseUrl}/v1/models?client_version=1.0`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.data[0].id).toBe("my-model");
    expect(data.models).toEqual([]);
  });

  it("handles models sub-path", async () => {
    const proxy = new ModelProviderProxy({
      config: {
        provider: "test",
        model: "my-model",
        baseUrl: "http://unused",
        apiKey: "unused",
      },
    });
    proxies.push(proxy);
    await proxy.start();

    const res = await fetch(`${proxy.baseUrl}/v1/models/my-model`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.data[0].id).toBe("my-model");
  });

  it("exercises all logging branches with debug mode", async () => {
    const upstream = await createMockUpstream((_body, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      // content delta
      res.write(`data: ${JSON.stringify({
        id: "c1", object: "chat.completion.chunk", model: "m",
        choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
      })}\n\n`);
      // tool_call with id
      res.write(`data: ${JSON.stringify({
        id: "c1", object: "chat.completion.chunk", model: "m",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "tc-1", type: "function", function: { name: "read", arguments: "" } }] }, finish_reason: null }],
      })}\n\n`);
      // tool_call args only (no id)
      res.write(`data: ${JSON.stringify({
        id: "c1", object: "chat.completion.chunk", model: "m",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":1}' } }] }, finish_reason: null }],
      })}\n\n`);
      // finish_reason
      res.write(`data: ${JSON.stringify({
        id: "c1", object: "chat.completion.chunk", model: "m",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`);
      // usage chunk (no choices)
      res.write(`data: ${JSON.stringify({
        id: "c1", object: "chat.completion.chunk", model: "m",
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
    upstreams.push(upstream);

    const proxy = new ModelProviderProxy({
      config: {
        provider: "test",
        model: "m",
        baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
        apiKey: "key",
      },
    });
    proxies.push(proxy);
    await proxy.start();

    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
        tools: [{ type: "function", function: { name: "read", parameters: {} } }],
      }),
    });

    expect(res.status).toBe(200);
    await res.text();
  });

  it("logging truncates long input and message content", async () => {
    const longInput = "x".repeat(600);
    const upstream = await createMockUpstream((_body, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        id: "c1", object: "chat.completion.chunk", model: "m",
        choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        id: "c1", object: "chat.completion.chunk", model: "m",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
    upstreams.push(upstream);

    const proxy = new ModelProviderProxy({
      config: {
        provider: "test",
        model: "m",
        baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
        apiKey: "key",
      },
    });
    proxies.push(proxy);
    await proxy.start();

    const res = await fetch(`${proxy.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "m",
        input: longInput,
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    await res.text();
  });

  it("returns 500 when handleRequest throws", async () => {
    const proxy = new ModelProviderProxy({
      config: {
        provider: "test",
        model: "test-model",
        baseUrl: "http://unused",
        apiKey: "unused",
      },
    });
    proxies.push(proxy);
    await proxy.start();

    // Send malformed JSON to /v1/chat/completions to trigger JSON.parse error
    // inside handleChatCompletions, which propagates to the catch block
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-valid-json",
    });

    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error.message).toBeTruthy();
  });

  it("WS previous_response_id preserves conversation history", async () => {
    // 模拟 codex 的两轮 WS 交互：
    // 第 1 轮：user message → 模型返回 tool call
    // 第 2 轮：function_call_output + previous_response_id → 模型应该看到完整对话历史
    const upstreamRequests: { messages: unknown[] }[] = [];
    let requestCount = 0;

    const upstream = await createMockUpstream((body, res) => {
      const parsed = JSON.parse(body);
      upstreamRequests.push({ messages: parsed.messages });
      requestCount++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });

      if (requestCount === 1) {
        // 第 1 轮：返回 tool call
        res.write(`data: ${JSON.stringify({
          id: "c1", object: "chat.completion.chunk", model: "test",
          choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "exec_command", arguments: "" } }] }, finish_reason: null }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          id: "c1", object: "chat.completion.chunk", model: "test",
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd":"date"}' } }] }, finish_reason: null }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          id: "c1", object: "chat.completion.chunk", model: "test",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          id: "c1", object: "chat.completion.chunk", model: "test",
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
          choices: [],
        })}\n\n`);
      } else {
        // 第 2 轮：返回文本
        res.write(`data: ${JSON.stringify({
          id: "c2", object: "chat.completion.chunk", model: "test",
          choices: [{ index: 0, delta: { role: "assistant", content: "Today is Tuesday" }, finish_reason: null }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          id: "c2", object: "chat.completion.chunk", model: "test",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          id: "c2", object: "chat.completion.chunk", model: "test",
          usage: { prompt_tokens: 150, completion_tokens: 10, total_tokens: 160 },
          choices: [],
        })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
    upstreams.push(upstream);

    const proxy = new ModelProviderProxy({
      config: {
        provider: "test",
        model: "test-model",
        baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
        apiKey: "sk-test",
      },
    });
    proxies.push(proxy);
    await proxy.start();

    let round1ResponseId = "";
    let round = 1;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/v1/responses`);
      ws.on("open", () => {
        ws.send(JSON.stringify({
          type: "response.create",
          model: "test-model",
          instructions: "You are a helpful assistant.",
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "What day is today?" }] },
          ],
          tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
        }));
      });
      ws.on("message", (data) => {
        const msg = data.toString();
        if (msg.includes('"type":"response.created"')) {
          const parsed = JSON.parse(msg);
          if (round === 1) round1ResponseId = parsed.response.id;
        }
        if (msg.includes('"type":"response.completed"')) {
          if (round === 1) {
            round = 2;
            ws.send(JSON.stringify({
              type: "response.create",
              model: "test-model",
              instructions: "You are a helpful assistant.",
              previous_response_id: round1ResponseId,
              input: [
                { type: "function_call_output", call_id: "call-1", output: "Tuesday June 3 2026" },
              ],
              tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
            }));
          } else {
            ws.close();
          }
        }
      });
      ws.on("close", () => resolve());
      ws.on("error", reject);
    });

    // 验证：第 2 轮的上游请求必须包含完整对话历史
    expect(upstreamRequests).toHaveLength(2);

    // 第 1 轮上游：system + user
    const r1 = upstreamRequests[0].messages as { role: string; content?: string }[];
    expect(r1.some(m => m.role === "system")).toBe(true);
    expect(r1.some(m => m.role === "user" && m.content?.includes("What day"))).toBe(true);

    // 第 2 轮上游：system + user + assistant(tool_call) + tool(result)
    const r2 = upstreamRequests[1].messages as { role: string; content?: string; tool_call_id?: string }[];
    const r2Roles = r2.map(m => m.role);
    expect(r2Roles).toContain("system");
    expect(r2Roles).toContain("user");       // 原始用户消息必须在
    expect(r2Roles).toContain("assistant");   // 第 1 轮 assistant 的 tool call
    expect(r2Roles).toContain("tool");        // tool result
    expect(r2.find(m => m.role === "tool")?.content).toContain("Tuesday");
  });
});
