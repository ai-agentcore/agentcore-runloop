import { test } from "node:test";
import assert from "node:assert/strict";
import { measureRun, runBenchmark } from "./benchmark-agui.mjs";

test("split CRLF SSE frames preserve activity/final-answer timing and do not double count text", async () => {
  const frames = [
    { type: "RUN_STARTED" },
    { type: "THINKING_TEXT_MESSAGE_CONTENT", delta: "BENCH_OK" },
    { type: "TEXT_MESSAGE_CONTENT", delta: "BENCH_OK" },
    { type: "RUN_FINISHED" },
  ].map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join("");
  const bytes = new TextEncoder().encode(frames);
  const fetchImpl = async (_url, options) => {
    assert.equal(options.redirect, "error");
    assert.equal(JSON.parse(options.body).threadId, options.headers["X-AgentCore-Session-ID"]);
    return new Response(new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    } }));
  };
  const result = await measureRun({ url: "https://example.com", key: "fixture-private-key", fetchImpl });
  assert.equal(result.success, true);
  assert.equal(result.outputChars, 8);
  assert.ok(result.firstEventMs <= result.firstTextMs);
  assert.ok(result.firstTextMs <= result.firstAnswerMs);
  assert.ok(result.firstAnswerMs <= result.finishedMs);
  assert.ok(!JSON.stringify(result).includes("fixture-private-key"));
});

test("HTTP 200 with RUN_ERROR or incomplete SSE is a failure", async () => {
  for (const events of [[{ type: "RUN_ERROR", message: "private upstream detail" }], [{ type: "TEXT_MESSAGE_CONTENT", delta: "BENCH_OK" }]]) {
    const fetchImpl = async () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
    const result = await measureRun({ url: "https://example.com", key: "test", fetchImpl });
    assert.equal(result.success, false);
    assert.ok(!JSON.stringify(result).includes("private upstream detail"));
  }
});

test("HTTP failures do not expose the upstream body and stop subsequent phases", async () => {
  const fetchImpl = async () => new Response("private upstream detail", { status: 502 });
  const result = await measureRun({ url: "https://example.com", key: "test", fetchImpl });
  assert.equal(result.status, 502);
  assert.equal(result.success, false);
  assert.ok(result.elapsedMs !== null);
  assert.ok(!JSON.stringify(result).includes("private upstream detail"));
  let calls = 0;
  const report = await runBenchmark({ sequential: 10, pairs: 3, measure: async () => { calls++; return result; } });
  assert.equal(calls, 1);
  assert.equal(report.stoppedOnFailure, true);
});
