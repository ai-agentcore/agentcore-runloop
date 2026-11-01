import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CodexAdapter } from "../vendor/runloop/src/acp/codex-adapter.js";
import { AgentProcess } from "../vendor/runloop/src/acp/process.js";
import { AgentCliRegistry } from "../vendor/runloop/src/acp/registry.js";

afterEach(() => vi.restoreAllMocks());

// Codex 0.155 treats the old { mode: "api-key" } file as ChatGPT auth,
// causing a user-settings request to delay the first model request by 5s.
it.each([undefined, "session-proxy-fixture"])("selects API-key auth with only the proxy token (token=%s)", async providerToken => {
  let auth: unknown;
  let apiKey: string | undefined;
  vi.spyOn(AgentProcess.prototype, "spawn").mockImplementation(function (this: AgentProcess, options) {
    auth = JSON.parse(readFileSync(join(options.env!.CODEX_HOME, "auth.json"), "utf8"));
    apiKey = options.env!.OPENAI_API_KEY;
    queueMicrotask(() => this.emit("exit", 0));
  });
  const adapter = new CodexAdapter("fixture-codex");
  for await (const _ of adapter.run({
    conversationId: "auth-regression",
    messages: [{ role: "user", content: "hi" }],
    config: { mcpConfig: { mcpServers: {} }, systemPromptAppend: "" },
    providerBaseUrl: "http://127.0.0.1:12345",
    providerToken,
    model: { provider: "fixture", model: "fixture", apiKey: "upstream-fixture-must-stay-out" },
  })) { /* consume */ }
  expect(auth).toEqual({ auth_mode: "apikey", OPENAI_API_KEY: providerToken ?? "runloop-proxy" });
  expect(apiKey).toBe(providerToken ?? "runloop-proxy");
});

it("uses the same API-key auth format for Codex prewarm", () => {
  const prewarm = new AgentCliRegistry().resolve("codex")!.prewarm!;
  expect(JSON.parse(prewarm.configFiles!["auth.json"])).toEqual({
    auth_mode: "apikey", OPENAI_API_KEY: prewarm.env!.OPENAI_API_KEY,
  });
});
