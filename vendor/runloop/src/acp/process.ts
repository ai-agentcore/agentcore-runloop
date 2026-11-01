import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

export interface AgentProcessOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** 降权运行：以该 uid/gid spawn 子进程（需本进程为 root）。 */
  uid?: number;
  gid?: number;
  /** true 时 env 直接作为子进程环境（不并入 process.env），用于降权时剔除平台密钥。 */
  replaceEnv?: boolean;
  timeout?: number;
  closeStdin?: boolean;
  /**
   * 若提供，则把它作为子进程 stdin 一次性写入后立即 end（发 EOF）。用于把 prompt 经 stdin 传给
   * codex（`codex exec -`）——新版 codex（≥0.142）会把多词的 positional PROMPT 按空白拆成多个参数、
   * 报 "unexpected argument"，经 stdin 传入彻底规避此问题（L-054）。优先级高于 closeStdin。
   */
  stdinData?: string;
}

export class AgentProcess extends EventEmitter {
  private process: ChildProcess | null = null;
  private _exited = false;
  private _killed = false;

  get exited(): boolean {
    return this._exited;
  }

  spawn(options: AgentProcessOptions): void {
    const useStdinPipe = options.stdinData !== undefined;
    const proc = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.replaceEnv
        ? (options.env ?? {})
        : { ...process.env, ...options.env },
      stdio: [useStdinPipe ? "pipe" : options.closeStdin ? "ignore" : "pipe", "pipe", "pipe"],
      ...(options.uid !== undefined ? { uid: options.uid } : {}),
      ...(options.gid !== undefined ? { gid: options.gid } : {}),
    });

    this.process = proc;

    // 把 prompt 经 stdin 一次性喂入后立即 end（EOF），让 codex 开始执行（L-014：stdin 为 pipe 且不关
    // 会阻塞等待输入）。stdin 的 error（如进程提前退出致 EPIPE）忽略，避免未捕获异常拖垮进程。
    if (useStdinPipe && proc.stdin) {
      proc.stdin.on("error", () => {});
      proc.stdin.write(options.stdinData!);
      proc.stdin.end();
    }

    let stdoutBuffer = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) {
          // 纵深兜底（H9）：stdout 监听器同步执行，下游 line→event 翻译抛出（如畸形 JSON）会中断本
          // chunk 剩余行、丢弃后续合法事件，甚至成进程级未捕获异常。吞掉单行异常并转一条 stderr 提示
          // （adapter 仅记日志、不翻译成事件），保证单条坏行不拖垮整个 adapter。
          try {
            this.emit("stdout", line);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.emit("stderr", `[runloop] stdout listener error, line skipped: ${msg}\n`);
          }
        }
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      this.emit("stderr", chunk.toString());
    });

    let exitCode: number | null = null;
    let errored = false;
    let exitEmitted = false;
    const emitExit = (code: number | null) => {
      if (exitEmitted || errored) return;
      exitEmitted = true;
      if (stdoutBuffer.trim()) {
        this.emit("stdout", stdoutBuffer);
      }
      this.emit("exit", code);
    };

    // 自然退出：等 close（stdio 流耗尽）再发 exit，避免 exit 早于最后一批 stdout
    // data 导致丢末尾输出。被 kill 时：进程的孤儿子进程可能仍持有 stdout 管道
    // 使 close 迟迟不来，故立即在 exit 发出，保证中断能及时收尾。
    proc.on("exit", (code) => {
      this._exited = true;
      exitCode = code;
      if (this._killed) emitExit(code);
    });

    proc.on("close", (code) => {
      this._exited = true;
      emitExit(exitCode ?? code);
    });

    proc.on("error", (err) => {
      this._exited = true;
      errored = true;
      this.emit("error", err);
    });

    if (options.timeout) {
      setTimeout(() => {
        if (!this._exited) {
          this.kill();
        }
      }, options.timeout);
    }
  }

  write(data: string): void {
    if (this.process?.stdin?.writable) {
      this.process.stdin.write(data + "\n");
    }
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.process && !this._exited) {
      this._killed = true;
      this.process.kill(signal);
    }
  }
}
