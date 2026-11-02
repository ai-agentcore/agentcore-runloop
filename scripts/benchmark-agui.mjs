import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

export const PROMPT = "Reply with exactly BENCH_OK. Do not use tools.";

/** Client-observed timings, not model token timings. Never return credentials or response bodies. */
export async function measureRun({ url, key, phase, index, timeoutMs = 120000, fetchImpl = fetch }) {
  const threadId = `bench-${randomUUID()}`;
  const start = performance.now();
  const result = {
    index, phase, startedAt: new Date().toISOString(), status: null,
    headersMs: null, firstEventMs: null, firstTextMs: null, firstAnswerMs: null,
    finishedMs: null, elapsedMs: null, success: false, answerMatches: false,
    eventCounts: {}, outputChars: 0,
  };
  let answer = "";
  let runError = false;
  let buffer = "";
  function consume(block) {
    const data = block.split(/\r?\n/).filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    let event;
    try { event = JSON.parse(data); }
    catch { result.parseErrors = (result.parseErrors ?? 0) + 1; return; }
    if (!event || typeof event !== "object") { result.parseErrors = (result.parseErrors ?? 0) + 1; return; }
    const type = /^[A-Z_]+$/.test(event.type ?? "") ? event.type : "UNKNOWN";
    const elapsed = performance.now() - start;
    result.firstEventMs ??= elapsed;
    result.eventCounts[type] = (result.eventCounts[type] ?? 0) + 1;
    if (["THINKING_TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_CONTENT"].includes(type) && typeof event.delta === "string" && event.delta.length) {
      result.firstTextMs ??= elapsed;
      if (type === "TEXT_MESSAGE_CONTENT") {
        result.firstAnswerMs ??= elapsed;
        answer += event.delta;
      }
    }
    if (type === "RUN_FINISHED") result.finishedMs ??= elapsed;
    if (type === "RUN_ERROR") runError = true;
  }
  try {
    const response = await fetchImpl(url, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", "X-AgentCore-Session-ID": threadId, "x-api-key": key },
      body: JSON.stringify({ threadId, runId: `run-${randomUUID()}`, messages: [{ id: randomUUID(), role: "user", content: PROMPT }], tools: [], context: [], state: {}, forwardedProps: {} }),
    });
    result.status = response.status;
    result.headersMs = performance.now() - start;
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      result.failureType = "HTTP_ERROR";
      return result;
    }
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let separator;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        consume(buffer.slice(0, separator.index));
        buffer = buffer.slice(separator.index + separator[0].length);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
    result.outputChars = answer.length;
    result.answerMatches = answer.trim() === "BENCH_OK";
    result.success = result.finishedMs !== null && !runError && !result.parseErrors && result.answerMatches;
    if (!result.success) result.failureType = "INVALID_COMPLETION";
  } catch (error) {
    result.failureType = ["TimeoutError", "AbortError"].includes(error.name) ? error.name : "REQUEST_FAILED";
  } finally { result.elapsedMs = performance.now() - start; }
  return result;
}

export async function runBenchmark({ url, key, sequential = 10, pairs = 0, timeoutMs = 120000, measure = measureRun }) {
  const results = [];
  for (let index = 0; index < sequential; index++) {
    const result = await measure({ url, key, phase: "sequential", index, timeoutMs });
    results.push(result);
    if (!result.success) return { stoppedOnFailure: true, results };
  }
  for (let pair = 0; pair < pairs; pair++) {
    const startIndex = results.length;
    const batch = await Promise.all([0, 1].map(offset => measure({ url, key, phase: "concurrency-2", index: startIndex + offset, timeoutMs })));
    results.push(...batch);
    if (batch.some(result => !result.success)) return { stoppedOnFailure: true, results };
  }
  return { stoppedOnFailure: false, results };
}

function integer(value, fallback, min, max) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error("Invalid benchmark request count");
  return number;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.AGENTCORE_BENCHMARK_URL;
  const key = process.env.AGENTCORE_BENCHMARK_API_KEY;
  try {
    if (!url || !key) throw new Error("Missing benchmark configuration");
    const endpoint = new URL(url);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) throw new Error("An HTTPS endpoint without embedded credentials is required");
    const sequential = integer(process.env.AGENTCORE_BENCHMARK_REQUESTS, 10, 1, 30);
    const pairs = integer(process.env.AGENTCORE_BENCHMARK_PAIRS, 0, 0, 3);
    const report = await runBenchmark({ url, key, sequential, pairs });
    console.log(JSON.stringify({ prompt: PROMPT, requested: { sequential, pairs }, ...report }, null, 2));
    if (report.results.some(result => !result.success)) process.exitCode = 1;
  } catch {
    console.error("Benchmark could not run. Check AGENTCORE_BENCHMARK_URL, AGENTCORE_BENCHMARK_API_KEY and request counts.");
    process.exitCode = 1;
  }
}
