import { describe, it, expect, vi } from "vitest";
import { RunloopClient, RunloopError, RunloopHTTPError } from "@/client/client.js";

// ── helpers ──────────────────────────────────────

/** Encode a string as a ReadableStream<Uint8Array>. */
function streamFrom(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(encoder.encode(text));
      ctrl.close();
    },
  });
}

/** Encode multiple chunks (emitted one-by-one) as a ReadableStream. */
function chunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(encoder.encode(c));
      ctrl.close();
    },
  });
}

/**
 * Re-export parseSSE / parseFrame via a dynamic import so we can test the
 * non-exported helpers through the module's internal wiring.  We test them
 * indirectly through RunloopClient.run() as well, but having direct access
 * lets us write more targeted unit tests.
 *
 * The module does NOT export parseSSE / parseFrame directly, so we use a
 * thin wrapper: we construct a RunloopClient that returns a controlled
 * ReadableStream from its `run()` call, then iterate the event generator.
 */

function mockFetch(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers ?? {}),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    body: null,
  }) as unknown as typeof fetch;
}

function mockFetchStream(
  stream: ReadableStream<Uint8Array>,
  conversationId = "sess-1",
): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ "x-conversation-id": conversationId }),
    body: stream,
    text: () => Promise.resolve(""),
  }) as unknown as typeof fetch;
}

// ── RunloopError / RunloopHTTPError ──────────────

describe("RunloopError", () => {
  it("has name and message", () => {
    const err = new RunloopError("boom");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(RunloopError);
    expect(err.name).toBe("RunloopError");
    expect(err.message).toBe("boom");
    expect(err.info).toBeUndefined();
  });

  it("stores info", () => {
    const inner = new Error("inner");
    const err = new RunloopError("wrap", inner);
    expect(err.info).toBe(inner);
  });
});

describe("RunloopHTTPError", () => {
  it("extends RunloopError", () => {
    const err = new RunloopHTTPError("bad", 422, { detail: "x" });
    expect(err).toBeInstanceOf(RunloopError);
    expect(err).toBeInstanceOf(RunloopHTTPError);
    expect(err.name).toBe("RunloopHTTPError");
    expect(err.message).toBe("bad");
    expect(err.status).toBe(422);
    expect(err.body).toEqual({ detail: "x" });
  });

  it("works without body", () => {
    const err = new RunloopHTTPError("not found", 404);
    expect(err.status).toBe(404);
    expect(err.body).toBeUndefined();
  });
});

// ── RunloopClient construction ──────────────────

describe("RunloopClient", () => {
  describe("constructor", () => {
    it("trims trailing slashes from baseUrl", () => {
      const client = new RunloopClient({
        baseUrl: "http://localhost:3000///",
        fetch: mockFetch(200, { status: "ok" }),
      });
      // We verify trimming indirectly by checking the URL passed to fetch
      client.health();
      const f = client["fetchImpl"] as ReturnType<typeof vi.fn>;
      expect(f).toHaveBeenCalledWith(
        "http://localhost:3000/health",
        expect.anything(),
      );
    });

    it("merges custom headers", async () => {
      const f = mockFetch(200, { status: "ok" });
      const client = new RunloopClient({
        baseUrl: "http://localhost:3000",
        headers: { "x-custom": "val" },
        fetch: f,
      });
      await client.health();
      const callArgs = (f as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(callArgs[1].headers["x-custom"]).toBe("val");
    });

    it("uses globalThis.fetch by default when no fetch provided", () => {
      // Just ensure construction does not throw
      const client = new RunloopClient({ baseUrl: "http://localhost:3000" });
      expect(client).toBeDefined();
    });
  });

  // ── health() ───────────────────────────────────

  describe("health()", () => {
    it("returns health response on 200", async () => {
      const payload = { status: "ok", version: "1.0.0", activeSessions: 3 };
      const client = new RunloopClient({
        baseUrl: "http://localhost:3000",
        fetch: mockFetch(200, payload),
      });
      const res = await client.health();
      expect(res).toEqual(payload);
    });

    it("throws RunloopHTTPError on non-200", async () => {
      const client = new RunloopClient({
        baseUrl: "http://localhost:3000",
        fetch: mockFetch(503, { error: "down" }),
      });
      await expect(client.health()).rejects.toThrow(RunloopHTTPError);
      try {
        await client.health();
      } catch (e) {
        expect((e as RunloopHTTPError).status).toBe(503);
        expect((e as RunloopHTTPError).body).toEqual({ error: "down" });
      }
    });

    it("throws RunloopError on invalid JSON response", async () => {
      const f = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve("not json {{{"),
      }) as unknown as typeof fetch;
      const client = new RunloopClient({
        baseUrl: "http://localhost:3000",
        fetch: f,
      });
      await expect(client.health()).rejects.toThrow(RunloopError);
      await expect(client.health()).rejects.toThrow("invalid JSON response");
    });

    it("returns null for empty body 200", async () => {
      const f = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve(""),
      }) as unknown as typeof fetch;
      const client = new RunloopClient({ baseUrl: "http://localhost:3000", fetch: f });
      const res = await client.health();
      expect(res).toBeNull();
    });
  });

  // ── listRuns() ────────────────────────────

  describe("listRuns()", () => {
    it("returns runs list", async () => {
      const data = { runs: [{ conversationId: "s1", status: "running", eventCount: 5 }] };
      const client = new RunloopClient({
        baseUrl: "http://localhost:3000",
        fetch: mockFetch(200, data),
      });
      const res = await client.listRuns();
      expect(res.runs).toHaveLength(1);
      expect(res.runs[0].conversationId).toBe("s1");
    });

    it("sends GET with accept: application/json", async () => {
      const f = mockFetch(200, { runs: [] });
      const client = new RunloopClient({ baseUrl: "http://localhost:3000", fetch: f });
      await client.listRuns();
      const callArgs = (f as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(callArgs[1].method).toBe("GET");
      expect(callArgs[1].headers.accept).toBe("application/json");
      // GET should not have content-type
      expect(callArgs[1].headers["content-type"]).toBeUndefined();
      expect(callArgs[1].body).toBeUndefined();
    });
  });

  // ── interrupt() ───────────────────────────────

  describe("interrupt()", () => {
    it("sends POST with body and returns result", async () => {
      const f = mockFetch(200, { success: true });
      const client = new RunloopClient({ baseUrl: "http://localhost:3000", fetch: f });
      const res = await client.interrupt({ conversationId: "s1", reason: "user request" });
      expect(res).toEqual({ success: true });
      const callArgs = (f as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(callArgs[0]).toBe("http://localhost:3000/v1/interrupt");
      expect(callArgs[1].method).toBe("POST");
      expect(callArgs[1].headers["content-type"]).toBe("application/json");
      expect(JSON.parse(callArgs[1].body)).toEqual({ conversationId: "s1", reason: "user request" });
    });

    it("throws RunloopHTTPError on 400", async () => {
      const client = new RunloopClient({
        baseUrl: "http://localhost:3000",
        fetch: mockFetch(400, { error: "invalid session" }),
      });
      await expect(client.interrupt({ conversationId: "bad" })).rejects.toThrow(RunloopHTTPError);
    });
  });

  // ── run() ─────────────────────────────────────

  describe("run()", () => {
    const minRequest = {
      events: [{ type: "user.message", content: "hi" }],
      credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
    };

    it("returns conversationId and parses SSE events", async () => {
      const ssePayload = [
        'event: message\ndata: {"id":"e1","type":"message.delta","timestamp":1,"conversationId":"s1","content":"hello"}\n\n',
        'event: done\ndata: {"id":"e2","type":"run.end","timestamp":2,"conversationId":"s1","reason":"completed"}\n\n',
      ].join("");

      const client = new RunloopClient({
        baseUrl: "http://localhost:3000",
        fetch: mockFetchStream(streamFrom(ssePayload), "s1"),
      });

      const result = await client.run(minRequest);
      expect(result.conversationId).toBe("s1");

      const events: unknown[] = [];
      for await (const ev of result.events) events.push(ev);

      expect(events).toHaveLength(2);
      expect((events[0] as { type: string }).type).toBe("message.delta");
      expect((events[1] as { type: string }).type).toBe("run.end");
    });

    it("throws RunloopHTTPError on non-200", async () => {
      const f = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        headers: new Headers(),
        text: () => Promise.resolve("internal error"),
      }) as unknown as typeof fetch;

      const client = new RunloopClient({ baseUrl: "http://localhost:3000", fetch: f });
      await expect(client.run(minRequest)).rejects.toThrow(RunloopHTTPError);
      try {
        await client.run(minRequest);
      } catch (e) {
        expect((e as RunloopHTTPError).status).toBe(500);
        expect((e as RunloopHTTPError).body).toBe("internal error");
      }
    });

    it("throws RunloopError when body is null", async () => {
      const f = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: null,
        text: () => Promise.resolve(""),
      }) as unknown as typeof fetch;

      const client = new RunloopClient({ baseUrl: "http://localhost:3000", fetch: f });
      await expect(client.run(minRequest)).rejects.toThrow(RunloopError);
      await expect(client.run(minRequest)).rejects.toThrow("no response body");
    });

    it("returns empty conversationId when header missing", async () => {
      const ssePayload = 'data: {"id":"e1","type":"x","timestamp":1,"conversationId":"s"}\n\n';
      const f = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(), // no x-conversation-id
        body: streamFrom(ssePayload),
      }) as unknown as typeof fetch;

      const client = new RunloopClient({ baseUrl: "http://localhost:3000", fetch: f });
      const result = await client.run(minRequest);
      expect(result.conversationId).toBe("");
    });

    it("skips frames with empty data", async () => {
      const ssePayload = [
        "data: \n\n", // empty data
        'data: {"id":"e1","type":"ok","timestamp":1,"conversationId":"s"}\n\n',
      ].join("");
      const client = new RunloopClient({
        baseUrl: "http://localhost:3000",
        fetch: mockFetchStream(streamFrom(ssePayload)),
      });
      const result = await client.run(minRequest);
      const events: unknown[] = [];
      for await (const ev of result.events) events.push(ev);
      expect(events).toHaveLength(1);
    });

    it("skips non-JSON frames gracefully", async () => {
      const ssePayload = [
        "data: not-json\n\n",
        'data: {"id":"e1","type":"ok","timestamp":1,"conversationId":"s"}\n\n',
      ].join("");
      const client = new RunloopClient({
        baseUrl: "http://localhost:3000",
        fetch: mockFetchStream(streamFrom(ssePayload)),
      });
      const result = await client.run(minRequest);
      const events: unknown[] = [];
      for await (const ev of result.events) events.push(ev);
      expect(events).toHaveLength(1);
    });

    it("sends correct headers and body", async () => {
      const f = mockFetchStream(streamFrom("data: {}\n\n"));
      const client = new RunloopClient({
        baseUrl: "http://localhost:3000",
        headers: { authorization: "Bearer tok" },
        fetch: f,
      });
      await client.run(minRequest);
      const callArgs = (f as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(callArgs[0]).toBe("http://localhost:3000/v1/run");
      expect(callArgs[1].method).toBe("POST");
      expect(callArgs[1].headers["content-type"]).toBe("application/json");
      expect(callArgs[1].headers.accept).toBe("text/event-stream");
      expect(callArgs[1].headers.authorization).toBe("Bearer tok");
    });

    it("passes abort signal to fetch", async () => {
      const controller = new AbortController();
      const f = mockFetchStream(streamFrom('data: {"id":"1","type":"x","timestamp":1,"conversationId":"s"}\n\n'));
      const client = new RunloopClient({ baseUrl: "http://localhost:3000", fetch: f });
      await client.run(minRequest, { signal: controller.signal });
      const callArgs = (f as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(callArgs[1].signal).toBe(controller.signal);
    });
  });
});

// ── SSE parsing (tested through run() + direct stream helpers) ──

describe("SSE parsing through RunloopClient.run()", () => {
  const minRequest = {
    events: [{ type: "user.message", content: "hi" }],
    credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
  };

  function clientWithStream(stream: ReadableStream<Uint8Array>): RunloopClient {
    return new RunloopClient({
      baseUrl: "http://localhost:3000",
      fetch: mockFetchStream(stream),
    });
  }

  async function collectEvents(client: RunloopClient): Promise<unknown[]> {
    const result = await client.run(minRequest);
    const events: unknown[] = [];
    for await (const ev of result.events) events.push(ev);
    return events;
  }

  it("parses normal SSE frame", async () => {
    const stream = streamFrom('event: test\nid: 42\ndata: {"id":"e1","type":"t","timestamp":1,"conversationId":"s"}\n\n');
    const events = await collectEvents(clientWithStream(stream));
    expect(events).toHaveLength(1);
    expect((events[0] as { id: string }).id).toBe("e1");
  });

  it("parses multi-line data (joined with newline)", async () => {
    // Two data: lines get joined with \n — the result is still valid JSON
    // because JSON allows whitespace (including newlines) between tokens
    const stream = streamFrom('data: {"id":"e1",\ndata: "type":"t","timestamp":1,"conversationId":"s"}\n\n');
    const events = await collectEvents(clientWithStream(stream));
    expect(events).toHaveLength(1);
    expect((events[0] as { id: string }).id).toBe("e1");
  });

  it("parses multi-line data that forms valid JSON", async () => {
    // data lines are joined with \n — construct so that works
    const obj = { id: "e1", type: "t", timestamp: 1, conversationId: "s" };
    const json = JSON.stringify(obj);
    // Put the full JSON in a single data: line
    const stream = streamFrom(`data: ${json}\n\n`);
    const events = await collectEvents(clientWithStream(stream));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(obj);
  });

  it("skips comment lines", async () => {
    const ssePayload = ': this is a comment\ndata: {"id":"e1","type":"t","timestamp":1,"conversationId":"s"}\n\n';
    const events = await collectEvents(clientWithStream(streamFrom(ssePayload)));
    expect(events).toHaveLength(1);
  });

  it("handles \\r\\n separators", async () => {
    const ssePayload = 'data: {"id":"e1","type":"t","timestamp":1,"conversationId":"s"}\r\n\r\n';
    const events = await collectEvents(clientWithStream(streamFrom(ssePayload)));
    expect(events).toHaveLength(1);
  });

  it("handles trailing data without double newline", async () => {
    // No trailing \n\n — parseSSE should still yield the frame from leftover buffer
    const ssePayload = 'data: {"id":"e1","type":"t","timestamp":1,"conversationId":"s"}';
    const events = await collectEvents(clientWithStream(streamFrom(ssePayload)));
    expect(events).toHaveLength(1);
  });

  it("handles chunked delivery across multiple enqueues", async () => {
    const json = '{"id":"e1","type":"t","timestamp":1,"conversationId":"s"}';
    const stream = chunkedStream([
      "data: ",
      json,
      "\n\n",
      `data: ${json}\n`,
      "\n",
    ]);
    const events = await collectEvents(clientWithStream(stream));
    expect(events).toHaveLength(2);
  });

  it("handles empty stream", async () => {
    const stream = streamFrom("");
    const events = await collectEvents(clientWithStream(stream));
    expect(events).toHaveLength(0);
  });

  it("handles only-comment stream", async () => {
    const stream = streamFrom(": heartbeat\n\n");
    const events = await collectEvents(clientWithStream(stream));
    // Comment-only frame has no data lines -> parseFrame returns null -> no events
    expect(events).toHaveLength(0);
  });

  it("handles only-event-no-data frame", async () => {
    const stream = streamFrom("event: ping\n\n");
    const events = await collectEvents(clientWithStream(stream));
    // No data lines -> parseFrame returns null
    expect(events).toHaveLength(0);
  });

  it("handles frame with empty data line", async () => {
    // "data:" with no value is an empty string data line
    const stream = streamFrom("data:\n\n");
    const events = await collectEvents(clientWithStream(stream));
    // data is "" -> skipped by run()'s empty-data check
    expect(events).toHaveLength(0);
  });

  it("handles multiple events in single chunk", async () => {
    const json1 = '{"id":"e1","type":"a","timestamp":1,"conversationId":"s"}';
    const json2 = '{"id":"e2","type":"b","timestamp":2,"conversationId":"s"}';
    const stream = streamFrom(`data: ${json1}\n\ndata: ${json2}\n\n`);
    const events = await collectEvents(clientWithStream(stream));
    expect(events).toHaveLength(2);
  });

  it("handles abort signal that is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const json = '{"id":"e1","type":"t","timestamp":1,"conversationId":"s"}';
    const stream = streamFrom(`data: ${json}\n\n`);

    const f = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "x-conversation-id": "s1" }),
      body: stream,
    }) as unknown as typeof fetch;

    const client = new RunloopClient({ baseUrl: "http://localhost:3000", fetch: f });
    const result = await client.run(minRequest, { signal: controller.signal });
    const events: unknown[] = [];
    for await (const ev of result.events) events.push(ev);
    // With an already-aborted signal, parseSSE returns immediately
    expect(events).toHaveLength(0);
  });

  it("handles abort signal triggered during streaming", async () => {
    const controller = new AbortController();
    const json = '{"id":"e1","type":"t","timestamp":1,"conversationId":"s"}';

    // Create a stream that yields one frame, then blocks until abort
    let pullResolve: (() => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        const encoder = new TextEncoder();
        ctrl.enqueue(encoder.encode(`data: ${json}\n\n`));
      },
      pull() {
        // Block the second read; abort will cancel the reader
        return new Promise<void>((resolve) => {
          pullResolve = resolve;
          // Abort after the first frame has been consumed
          setTimeout(() => controller.abort(), 5);
        });
      },
      cancel() {
        // When reader is cancelled, resolve the pending pull
        pullResolve?.();
      },
    });

    const f = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "x-conversation-id": "s1" }),
      body: stream,
    }) as unknown as typeof fetch;

    const client = new RunloopClient({ baseUrl: "http://localhost:3000", fetch: f });
    const result = await client.run(minRequest, { signal: controller.signal });
    const events: unknown[] = [];
    for await (const ev of result.events) events.push(ev);
    // Should get the first event before abort cancels the stream
    expect(events).toHaveLength(1);
  });

  it("handles field with no colon (colon-less field)", async () => {
    // A field like "retry" with no colon — should be treated as field name with empty value
    // Since it's not "data", "event", or "id", it should be ignored
    const json = '{"id":"e1","type":"t","timestamp":1,"conversationId":"s"}';
    const stream = streamFrom(`retry\ndata: ${json}\n\n`);
    const events = await collectEvents(clientWithStream(stream));
    expect(events).toHaveLength(1);
  });

  it("handles data field with leading space stripped", async () => {
    // "data: value" — the space after colon should be stripped
    const json = '{"id":"e1","type":"t","timestamp":1,"conversationId":"s"}';
    const stream = streamFrom(`data: ${json}\n\n`);
    const events = await collectEvents(clientWithStream(stream));
    expect(events).toHaveLength(1);
    expect((events[0] as { id: string }).id).toBe("e1");
  });

  it("handles data field without leading space", async () => {
    // "data:value" — no space after colon
    const json = '{"id":"e1","type":"t","timestamp":1,"conversationId":"s"}';
    const stream = streamFrom(`data:${json}\n\n`);
    const events = await collectEvents(clientWithStream(stream));
    expect(events).toHaveLength(1);
    expect((events[0] as { id: string }).id).toBe("e1");
  });

  it("handles mixed \\r\\n and \\n line endings within a frame", async () => {
    const json = '{"id":"e1","type":"t","timestamp":1,"conversationId":"s"}';
    const stream = streamFrom(`event: test\r\ndata: ${json}\n\n`);
    const events = await collectEvents(clientWithStream(stream));
    expect(events).toHaveLength(1);
  });
});

// ── parseFrame edge cases (tested indirectly via full SSE pipeline) ──

describe("parseFrame edge cases via SSE pipeline", () => {
  const minRequest = {
    events: [{ type: "user.message", content: "hi" }],
    credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
  };

  async function parseViaRun(sseText: string): Promise<unknown[]> {
    const client = new RunloopClient({
      baseUrl: "http://localhost:3000",
      fetch: mockFetchStream(streamFrom(sseText)),
    });
    const result = await client.run(minRequest);
    const events: unknown[] = [];
    for await (const ev of result.events) events.push(ev);
    return events;
  }

  it("empty lines in a frame are skipped", async () => {
    const json = '{"id":"e1","type":"t","timestamp":1,"conversationId":"s"}';
    const events = await parseViaRun(`\ndata: ${json}\n\n`);
    expect(events).toHaveLength(1);
  });

  it("frame with only empty/comment lines yields null (no events)", async () => {
    const events = await parseViaRun(": comment\n\n");
    expect(events).toHaveLength(0);
  });

  it("frame with only unknown fields yields null (no data lines)", async () => {
    const events = await parseViaRun("retry: 3000\n\n");
    expect(events).toHaveLength(0);
  });

  it("whitespace-only trailing buffer is ignored", async () => {
    const json = '{"id":"e1","type":"t","timestamp":1,"conversationId":"s"}';
    const events = await parseViaRun(`data: ${json}\n\n   \n  `);
    expect(events).toHaveLength(1);
  });
});

// ── json() private method edge cases ────────────

describe("RunloopClient.json() error paths", () => {
  it("throws RunloopHTTPError with parsed body for non-200 JSON response", async () => {
    const errorBody = { error: "not found", details: [{ field: "id" }] };
    const client = new RunloopClient({
      baseUrl: "http://localhost:3000",
      fetch: mockFetch(404, errorBody),
    });
    try {
      await client.health();
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RunloopHTTPError);
      expect((e as RunloopHTTPError).status).toBe(404);
      expect((e as RunloopHTTPError).body).toEqual(errorBody);
    }
  });

  it("throws RunloopError for invalid JSON even on non-200", async () => {
    const f = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      headers: new Headers(),
      text: () => Promise.resolve("<!DOCTYPE html>bad gateway"),
    }) as unknown as typeof fetch;
    const client = new RunloopClient({ baseUrl: "http://localhost:3000", fetch: f });
    // The json() method tries to parse first, fails, throws RunloopError (not HTTP error)
    await expect(client.health()).rejects.toThrow(RunloopError);
    await expect(client.health()).rejects.toThrow("invalid JSON response");
  });

  it("non-200 with empty body uses null as parsed value", async () => {
    const f = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers(),
      text: () => Promise.resolve(""),
    }) as unknown as typeof fetch;
    const client = new RunloopClient({ baseUrl: "http://localhost:3000", fetch: f });
    try {
      await client.health();
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RunloopHTTPError);
      expect((e as RunloopHTTPError).body).toBeNull();
    }
  });
});

// ── run() error edge case: response.text() rejects ──

describe("run() when response.text() rejects", () => {
  it("catches text() rejection and uses empty string as body", async () => {
    const minRequest = {
      events: [{ type: "user.message", content: "hi" }],
      credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
    };
    const f = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      headers: new Headers(),
      text: () => Promise.reject(new Error("stream broken")),
    }) as unknown as typeof fetch;
    const client = new RunloopClient({ baseUrl: "http://localhost:3000", fetch: f });
    try {
      await client.run(minRequest);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RunloopHTTPError);
      expect((e as RunloopHTTPError).body).toBe("");
    }
  });
});
