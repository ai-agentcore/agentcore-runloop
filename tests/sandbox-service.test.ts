import { describe, expect, it, vi } from "vitest";
import { createSandboxApp } from "../src/sandbox-service/app.js";
import { loadSandboxConfig } from "../src/sandbox-service/config.js";
import type { ExecutionResult, Executor } from "../src/sandbox-service/executor.js";

const token = "test-secret-".repeat(4);
const auth = { Authorization: `Bearer ${token}` };
function fixture() {
  const result: ExecutionResult = { stdout: Buffer.from("ok"), stderr: Buffer.alloc(0), exitCode: 0, timedOut: false, truncated: false };
  const executor: Executor = { initialize: vi.fn().mockResolvedValue(undefined), run: vi.fn().mockResolvedValue(result), close: vi.fn() };
  return { app: createSandboxApp(token, executor), executor, result };
}
describe("pure sandbox HTTP service", () => {
  it("starts without model configuration and requires deployment identity and authentication", () => {
    const env = { AGENTCORE_RUNLOOP_API_TOKEN: token, AGENTCORE_WORKDIR: "/workspace", AGENTCORE_SANDBOX_UID: "alice", AGENTCORE_SANDBOX_SESSION_ID: "s1" };
    expect(loadSandboxConfig(env)).toMatchObject({ port: 8080, cli: "codex", uid: "alice" });
    for (const patch of [{ AGENTCORE_WORKDIR: "/" }, { AGENTCORE_WORKDIR: "/usr/data" }, { AGENTCORE_WORKDIR: "relative" }, { AGENTCORE_SANDBOX_UID: "../other" }, { AGENTCORE_SANDBOX_SESSION_ID: "" }, { AGENTCORE_RUNLOOP_API_TOKEN: "short" }, { AGENTCORE_PORT: "0" }]) {
      expect(() => loadSandboxConfig({ ...env, ...patch })).toThrow("INVALID_SANDBOX_CONFIGURATION");
    }
    expect(() => loadSandboxConfig()).toThrow();
  });
  it("authenticates before invoking the executor and sanitizes readiness failures", async () => {
    const { app, executor } = fixture();
    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/readyz")).status).toBe(200);
    vi.mocked(executor.initialize).mockRejectedValue(new Error("secret stack path"));
    const failed = await app.request("/readyz");
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("secret");
    for (const header of [undefined, "Bearer wrong", `Bearer ${"x".repeat(token.length)}`]) {
      expect((await app.request("/v1/exec", { method: "POST", headers: header ? { Authorization: header } : {} })).status).toBe(401);
    }
    expect(executor.run).not.toHaveBeenCalled();
    expect((await app.request("/ag-ui/agent", { method: "POST" })).status).toBe(404);
  });
  it("validates commands and rejects identity, cwd, environment and permissions overrides", async () => {
    const { app, executor } = fixture();
    for (const body of ["{", JSON.stringify({}), JSON.stringify({ command: "a\0b" }), ...["uid", "cwd", "env", "permissions"].map(key => JSON.stringify({ command: "true", [key]: "escape" })), JSON.stringify({ command: "true", timeoutMs: 60001 })]) {
      expect((await app.request("/v1/exec", { method: "POST", headers: auth, body })).status).toBe(400);
    }
    const response = await app.request("/v1/exec", { method: "POST", headers: auth, body: JSON.stringify({ command: "/bin/echo", args: ["ok"] }) });
    expect(await response.json()).toMatchObject({ stdout: "ok", exitCode: 0, truncated: false });
    expect(executor.run).toHaveBeenCalledWith(["/bin/echo", "ok"], undefined, 30000);
    vi.mocked(executor.run).mockRejectedValue(new Error("SANDBOX_BUSY"));
    expect((await app.request("/v1/exec", { method: "POST", headers: auth, body: '{"command":"true"}' })).status).toBe(409);
  });
  it("routes binary file operations through the sandbox and rejects unsafe paths", async () => {
    const { app, executor, result } = fixture();
    result.stdout = Buffer.from([0, 255, 2]);
    for (const path of ["/etc/passwd", "../secret", "a/../../b", "a\\b", "a\0b", ""]) {
      expect((await app.request(`/v1/files?path=${encodeURIComponent(path)}`, { headers: auth })).status).toBe(400);
    }
    expect((await app.request("/v1/files", { headers: auth })).status).toBe(400);
    const response = await app.request("/v1/files?path=result.bin", { headers: auth });
    expect(Buffer.from(await response.arrayBuffer())).toEqual(result.stdout);
    expect(executor.run).toHaveBeenLastCalledWith(expect.arrayContaining(["read", "result.bin"]), undefined, 30000, 8 * 1024 * 1024);
    const uploaded = await app.request("/v1/files?path=input.bin", { method: "PUT", headers: auth, body: new Uint8Array([0, 255]) });
    expect(uploaded.status).toBe(201);
    expect(executor.run).toHaveBeenLastCalledWith(expect.arrayContaining(["write", "input.bin"]), Buffer.from([0, 255]), 30000, 8 * 1024 * 1024);
    for (const patch of [{ exitCode: 1 }, { exitCode: 0, truncated: true }, { truncated: false, timedOut: true }]) {
      Object.assign(result, patch);
      expect((await app.request("/v1/files?path=x", { headers: auth })).status).toBe(422);
    }
    expect((await app.request("/v1/files?path=x", { method: "PUT", headers: auth, body: new Uint8Array(8 * 1024 * 1024 + 1) })).status).toBe(413);
  });
  it("bounds directory operations and returns only safe failures", async () => {
    const { app, result } = fixture();
    result.stdout = Buffer.from('[]');
    expect(await (await app.request("/v1/directories", { headers: auth })).json()).toEqual([]);
    expect((await app.request("/v1/directories?path=..", { headers: auth })).status).toBe(400);
    for (const patch of [{ exitCode: 1 }, { exitCode: 0, truncated: true }, { truncated: false, timedOut: true }]) {
      Object.assign(result, patch);
      expect((await app.request("/v1/directories", { headers: auth })).status).toBe(422);
    }
  });
});
