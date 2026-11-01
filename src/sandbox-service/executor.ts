import { spawn } from "node:child_process";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, sep } from "node:path";
import { localSandboxConfig, localSandboxOverrides, verifyLocalSandbox } from "../../vendor/runloop/src/acp/local-sandbox.js";
import { sessionWorkdir } from "../session-workspace.js";
import type { SandboxConfig } from "./config.js";

export interface ExecutionResult { stdout: Buffer; stderr: Buffer; exitCode: number | null; timedOut: boolean; truncated: boolean }
export interface Executor {
  initialize(): Promise<void>;
  run(command: string[], input?: Buffer, timeoutMs?: number, maxOutput?: number): Promise<ExecutionResult>;
  close(): Promise<void>;
}

/** No agent, inference, credentials or direct unsandboxed file-operation path. */
export class NativeExecutor implements Executor {
  private initialization?: Promise<void>;
  private home?: string;
  private cwd = "";
  private cli = "";
  private args: string[] = [];
  private env: NodeJS.ProcessEnv = {};
  private stopping = false;
  private running = false;
  private kill?: () => void;
  private finished?: Promise<ExecutionResult>;
  constructor(private readonly config: SandboxConfig) {}

  initialize(): Promise<void> {
    if (this.stopping) return Promise.reject(new Error("SERVICE_STOPPING"));
    if (!this.initialization) {
      this.initialization = this.prepare().catch(async () => {
        if (this.home) await rm(this.home, { recursive: true, force: true });
        this.initialization = undefined;
        throw new Error("SANDBOX_UNAVAILABLE");
      });
    }
    return this.initialization;
  }

  private async prepare(): Promise<void> {
    const candidates = this.config.cli.includes("/") ? [this.config.cli]
      : (process.env.PATH ?? "").split(delimiter).map(path => join(path, this.config.cli));
    for (const candidate of candidates) {
      try { await access(candidate); this.cli = await realpath(candidate); break; } catch { /* Next candidate. */ }
    }
    if (!this.cli) throw new Error("CLI_UNAVAILABLE");
    this.cwd = await realpath(await sessionWorkdir(this.config.root, this.config.uid, this.config.sessionId));
    this.home = await mkdtemp(join(tmpdir(), "agentcore-sandbox-control-"));
    await writeFile(join(this.home, "config.toml"), "");
    const nodeRoot = dirname(await realpath(process.execPath));
    const lines = await localSandboxConfig({ userRoot: this.cwd, readRoots: [nodeRoot] }, this.cwd, this.cli);
    // A configured data mount must not accidentally fall under an executable read grant.
    for (const line of lines.filter(value => value.endsWith(' = "read"') && !value.startsWith('":minimal"'))) {
      const root = JSON.parse(line.slice(0, line.indexOf(" = "))) as string;
      const rel = relative(root, this.cwd);
      if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep))) {
        throw new Error("UNSAFE_RUNTIME_OVERLAP");
      }
    }
    const overrides = localSandboxOverrides(lines);
    // The CLI itself also receives a clean environment; shell_environment_policy alone
    // does not sanitize a standalone `codex sandbox -- command` invocation.
    this.env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: join(this.cwd, ".agentcore-tmp"), CODEX_HOME: this.home,
      TMPDIR: join(this.cwd, ".agentcore-tmp"), LANG: "C.UTF-8" };
    this.args = ["sandbox", "-P", "agentcore_local", "-C", this.cwd,
      ...overrides.flatMap(value => ["-c", value]), "--"];
    await verifyLocalSandbox(this.cli, this.cwd, overrides, this.env, {});
  }

  async run(command: string[], input?: Buffer, timeoutMs = 30000, maxOutput = 1024 * 1024): Promise<ExecutionResult> {
    await this.initialize();
    if (this.stopping) throw new Error("SERVICE_STOPPING");
    if (this.running) throw new Error("SANDBOX_BUSY");
    this.running = true;
    this.finished = new Promise<ExecutionResult>((resolve, reject) => {
      // Node's "pipe" stdio uses Unix socketpairs on Linux. With native network
      // denial, Node programs inside the sandbox may silently lose stream output
      // on inherited sockets. This fixed trusted wrapper presents real pipes to
      // Codex, drains both streams, and preserves argv and the exit status. It
      // never evaluates caller text; the requested command still enters Codex.
      const transport = '"$@" > >(cat) 2> >(cat >&2); code=$?; wait; exit "$code"';
      const child = spawn("/bin/bash", ["-c", transport, "agentcore-native-io", this.cli, ...this.args, ...command], {
        cwd: this.cwd, env: this.env, detached: true, stdio: ["pipe", "pipe", "pipe"],
      });
      const kill = () => {
        if (child.pid) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already gone. */ }
        }
      };
      this.kill = kill;
      let timedOut = false, truncated = false, bytes = 0;
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      const capture = (target: Buffer[], chunk: Buffer) => {
        const remaining = Math.max(0, maxOutput - bytes);
        target.push(chunk.subarray(0, remaining));
        bytes += Math.min(chunk.length, remaining);
        if (chunk.length > remaining) { truncated = true; kill(); }
      };
      child.stdout.on("data", chunk => capture(stdout, chunk));
      child.stderr.on("data", chunk => capture(stderr, chunk));
      child.stdin.on("error", () => {});
      child.stdin.end(input);
      const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
      child.once("error", () => { clearTimeout(timer); reject(new Error("SANDBOX_EXEC_FAILED")); });
      child.once("close", code => {
        clearTimeout(timer);
        kill(); // Reap descendants still in this group after a normally exiting command.
        resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: code, timedOut, truncated });
      });
    });
    try { return await this.finished; }
    finally { this.running = false; this.kill = undefined; }
  }

  async close(): Promise<void> {
    this.stopping = true;
    await this.initialization?.catch(() => {});
    this.kill?.();
    await this.finished?.catch(() => {});
    if (this.home) await rm(this.home, { recursive: true, force: true });
  }
}
