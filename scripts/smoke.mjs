import assert from "node:assert/strict";

const base = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:8080";
const headers = { "Content-Type": "application/json" };
if (process.env.AGENTCORE_RUNLOOP_API_TOKEN) {
  headers.Authorization = `Bearer ${process.env.AGENTCORE_RUNLOOP_API_TOKEN}`;
}

const response = await fetch(`${base}/v1/run`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    events: [{ type: "user.message", content: "Reply with a short fixture response." }],
    agent: { cli: "codex", timeoutMs: 30000 },
  }),
  signal: AbortSignal.timeout(45000),
});
assert.equal(response.status, 200, await response.clone().text());

const lines = (await response.text()).split(/\r?\n/);
const events = lines
  .filter(line => line.startsWith("data: "))
  .map(line => JSON.parse(line.slice(6)));
assert(!events.some(event => event.type === "run.error"), "Unexpected runtime error");
assert.equal(events.at(-1)?.reason, "completed");

const text = events
  .filter(event => event.type === "message.delta")
  .map(event => event.content)
  .join("");
assert(text.includes("Fixture AgentCore response."), "Pure Node fixture model response was not observed");
console.log(JSON.stringify({
  result: "passed",
  engine: "real codex",
  platform: "in-process node fixture",
  eventCount: events.length,
  text,
}, null, 2));
