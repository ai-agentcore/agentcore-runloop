import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { NativeExecutor } from "../src/sandbox-service/executor.js";
import { verifyLocalSandbox } from "../vendor/runloop/src/acp/local-sandbox.js";

vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), spawn: vi.fn() }));
vi.mock("../vendor/runloop/src/acp/local-sandbox.js", async importOriginal => ({ ...await importOriginal<typeof import("../vendor/runloop/src/acp/local-sandbox.js")>(), verifyLocalSandbox: vi.fn().mockResolvedValue(undefined) }));
const roots: string[] = [];
const executors: NativeExecutor[] = [];
afterEach(async () => {
  await Promise.all(executors.splice(0).map(e => e.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
  vi.mocked(verifyLocalSandbox).mockResolvedValue(undefined);
});
async function fixture(cli = process.execPath) {
  const root = await mkdtemp(join(tmpdir(), "sandbox-executor-unit-")); roots.push(root);
  const executor = new NativeExecutor({ root, uid: "alice", sessionId: "one", cli, host: "127.0.0.1", port: 8080, token: "secret" });
  executors.push(executor);
  return { executor, root };
}
function child() {
  const c = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 123456789 });
  vi.mocked(spawn).mockReturnValue(c as unknown as ReturnType<typeof spawn>);
  vi.spyOn(process, "kill").mockImplementation(() => { queueMicrotask(() => c.emit("close", null)); return true; });
  return c;
}
it("pins only session writes, uses a clean environment and shares initialization", async () => {
  const { executor, root } = await fixture();
  await Promise.all([executor.initialize(), executor.initialize()]);
  const args = vi.mocked(verifyLocalSandbox).mock.calls.at(-1)!;
  expect(args[2].find(v => v.startsWith("permissions="))).toContain('/alice/one" = "write"');
  expect(args[2].join(" ")).not.toContain(`${JSON.stringify(root)} = "write"`);
  const c = child();
  const running = executor.run(["/bin/echo", "hello"], Buffer.from("input"));
  await new Promise(resolve => setImmediate(resolve));
  expect(c.stdin.read()?.toString()).toBe("input");
  c.stdout.write(Buffer.from([0, 255])); c.stderr.write("oops"); c.emit("close", 3);
  const result = await running;
  expect(result.stdout).toEqual(Buffer.from([0, 255])); expect(result.exitCode).toBe(3);
  const opts = vi.mocked(spawn).mock.calls.at(-1)![2]!;
  expect(opts.env?.AGENTCORE_RUNLOOP_API_TOKEN).toBeUndefined();
  expect(opts.env?.HOME).toContain("/alice/one/.agentcore-tmp");
  expect(opts.detached).toBe(true);
});
it("rejects overlap and terminates on timeout", async () => {
  const { executor } = await fixture(); await executor.initialize(); const c = child();
  const running = executor.run(["/bin/sleep", "1"], undefined, 20);
  await new Promise(resolve => setTimeout(resolve, 5));
  await expect(executor.run(["true"])).rejects.toThrow("SANDBOX_BUSY");
  expect((await running).timedOut).toBe(true);
  expect(process.kill).toHaveBeenCalledWith(-c.pid, "SIGKILL");
});
it("bounds output and sanitizes spawn errors", async () => {
  const { executor } = await fixture(); await executor.initialize(); const c = child();
  const running = executor.run(["echo"], undefined, 1000, 3);
  await new Promise(resolve => setImmediate(resolve));
  c.stdout.write("123456");
  const result = await running;
  expect(result.stdout.toString()).toBe("123"); expect(result.truncated).toBe(true);
  const failed = executor.run(["missing"]);
  await new Promise(resolve => setImmediate(resolve));
  c.emit("error", new Error("private credential"));
  await expect(failed).rejects.toThrow("SANDBOX_EXEC_FAILED");
});
it("fails closed and retries initialization only after failure", async () => {
  const { executor } = await fixture();
  vi.mocked(verifyLocalSandbox).mockRejectedValueOnce(new Error("private detail"));
  await expect(executor.run(["true"])).rejects.toThrow("SANDBOX_UNAVAILABLE");
  await expect(executor.initialize()).resolves.toBeUndefined();
  await executor.close();
  await expect(executor.initialize()).rejects.toThrow("SERVICE_STOPPING");
});
it("rejects unavailable CLI without falling back", async () => {
  const { executor } = await fixture("missing-cli-unique-for-test");
  await expect(executor.initialize()).rejects.toThrow("SANDBOX_UNAVAILABLE");
});
it("stops active operations on shutdown", async () => {
  const { executor } = await fixture(); await executor.initialize(); child();
  const running = executor.run(["sleep"]);
  await new Promise(resolve => setImmediate(resolve));
  await executor.close();
  await expect(running).resolves.toMatchObject({ exitCode: null });
});
