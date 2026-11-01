import { describe, it, expect } from "vitest";
import { executeShell, sanitizeShellEnv, SHELL_TOOL_DESCRIPTOR, SHELL_TOOL_NAME } from "../../src/sidecar/shell-exec.js";

function payload(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

describe("executeShell", () => {
  it("rejects empty / whitespace command", async () => {
    const r = await executeShell("   ");
    expect(r.isError).toBe(true);
    expect(payload(r as never)).toEqual({ error: "command is required" });
  });

  it("runs a command and captures stdout with exit_code 0", async () => {
    const r = await executeShell("echo hello-shell");
    expect(r.isError).toBe(false);
    const p = payload(r as never);
    expect(p.stdout).toContain("hello-shell");
    expect(p.exit_code).toBe(0);
  });

  it("captures stderr and non-zero exit_code (isError stays false)", async () => {
    const r = await executeShell("echo oops >&2; exit 3");
    expect(r.isError).toBe(false);
    const p = payload(r as never);
    expect(p.stderr).toContain("oops");
    expect(p.exit_code).toBe(3);
  });

  it("runs in the provided cwd", async () => {
    const r = await executeShell("pwd", { cwd: "/tmp" });
    expect(payload(r as never).stdout).toContain("/tmp");
  });

  it("sanitizeShellEnv strips *_KEY/_SECRET/_TOKEN/PASSWORD/CREDENTIAL, keeps functional vars (C1)", () => {
    const env = sanitizeShellEnv({
      PATH: "/usr/bin", HOME: "/home/x", LANG: "C",
      OPENAI_API_KEY: "sk", AGENTCORE_DEFAULT_MODEL_API_KEY: "k", ACCESS_KEY_ID: "ak",
      ALIBABA_CLOUD_ACCESS_KEY_SECRET: "s", X_TENANT_TOKEN: "t", DB_PASSWORD: "p", MY_CREDENTIAL: "c",
    } as never);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/x");
    expect(env.LANG).toBe("C");
    for (const leaked of ["OPENAI_API_KEY", "AGENTCORE_DEFAULT_MODEL_API_KEY", "ACCESS_KEY_ID", "ALIBABA_CLOUD_ACCESS_KEY_SECRET", "X_TENANT_TOKEN", "DB_PASSWORD", "MY_CREDENTIAL"]) {
      expect(env[leaked]).toBeUndefined();
    }
  });

  it("executeShell default env does not expose runloop secrets to the spawned bash (C1)", async () => {
    process.env.AGENTCORE_TEST_LEAK_TOKEN = "must-not-leak";
    try {
      const r = await executeShell('echo "[$AGENTCORE_TEST_LEAK_TOKEN]"');
      const p = payload(r as never);
      expect(p.stdout).toContain("[]"); // 变量被剔除 → 空
      expect(p.stdout).not.toContain("must-not-leak");
    } finally {
      delete process.env.AGENTCORE_TEST_LEAK_TOKEN;
    }
  });

  it("caps stdout by bytes, not chars (L5): large output stays within 64KiB", async () => {
    // 产出 ~200KB 输出（远超 64KiB 上限）。按字节封顶后 stdout 字节数应 ≤ 64KiB。
    const r = await executeShell("yes A | head -c 200000");
    const p = payload(r as never);
    expect(Buffer.byteLength(p.stdout as string, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect((p.stdout as string).length).toBeGreaterThan(0);
  });

  it("caps stderr by bytes, not chars (L5): large stderr stays within 64KiB", async () => {
    // 对称覆盖 stderr 的字节截断分支（L5 给 stderr 也加了封顶，但此前只测了 stdout）。
    const r = await executeShell("yes B | head -c 200000 >&2");
    const p = payload(r as never);
    expect(Buffer.byteLength(p.stderr as string, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect((p.stderr as string).length).toBeGreaterThan(0);
  });

  it("kills on timeout → isError, exit_code 124, error message", async () => {
    const r = await executeShell("sleep 5", { timeoutMs: 50 });
    expect(r.isError).toBe(true);
    const p = payload(r as never);
    expect(p.exit_code).toBe(124);
    expect(String(p.error)).toContain("timeout");
  });

  it("reports spawn error (invalid cwd) as isError", async () => {
    const r = await executeShell("echo x", { cwd: "/nonexistent-dir-xyz-12345" });
    expect(r.isError).toBe(true);
    expect(payload(r as never)).toHaveProperty("error");
  });

  it("exposes a stable descriptor name", () => {
    expect(SHELL_TOOL_NAME).toBe("bash");
    expect(SHELL_TOOL_DESCRIPTOR.name).toBe("bash");
    expect(SHELL_TOOL_DESCRIPTOR.inputSchema.required).toContain("command");
  });
});
