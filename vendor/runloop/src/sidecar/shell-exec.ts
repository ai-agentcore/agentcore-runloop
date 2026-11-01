// 内置 `shell` 执行工具（Option B 实验，AD-027 演进方向）。
//
// 背景：codex 是 thick CLI，内建本地 shell（`exec_command`）。云上多租下「推理层暖+持密钥」与
// 「执行层每会话隔离+无密钥」诉求相反。本工具把执行从 codex 内建 shell 剥离，改为一个走 runloop
// 自有工具逻辑（handleToolCall → sidecar.gatedExecute 主轨闸门）的 MCP 工具：
//   - codex 侧用 `[features] shell_tool = false` 关掉内建 shell（见 codex-adapter）；
//   - 模型改调本 `shell` 工具，执行经我们这条统一路径（可被 HITL 拦截、可日志、可换远端沙箱后端）。
// 当前实现：本地 `bash -lc` 在 workspace cwd 执行（与 codex 原行为等价，但路由权回到我们手里）。
// 后续：把 executeShell 的后端从「本地 spawn」换成「打到每会话隔离沙箱」即得到真正的 shell/agent 分离，
// 模型与上游协议完全无感（工具名/契约不变）。

import { spawn } from "node:child_process";
import type { McpToolDescriptor, McpToolResult } from "../mcp/types.js";
import { envPositiveInt } from "../util/env.js";

/** 暴露给模型的内置执行工具名（MCP/snake，对齐业界；经 codex namespace → `mcp__agentcore__bash`）。 */
export const SHELL_TOOL_NAME = "bash";

/** 工具描述符（sidecar `/tools` 与 MCP server tools/list 共用，单一定义）。 */
export const SHELL_TOOL_DESCRIPTOR: McpToolDescriptor = {
  name: SHELL_TOOL_NAME,
  description:
    "在执行环境中运行一条 shell 命令（bash -lc），返回 stdout/stderr/exit_code。" +
    "装依赖、构建、跑脚本、git 等用本工具；读写文件/检索优先用 read_file/write_file/edit_file/grep/glob。",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的 shell 命令（经 bash -lc 运行）" },
    },
    required: ["command"],
  },
};

/** 单条命令 stdout/stderr 各自的截断上限，避免超大输出撑爆模型上下文。 */
const MAX_OUTPUT_BYTES = 64 * 1024;
/** 本地 bash 执行默认超时。env AGENTCORE_SHELL_TIMEOUT_MS 可覆盖（毫秒，正整数）——构建/安装等长命令留足时间。 */
const DEFAULT_TIMEOUT_MS = envPositiveInt("AGENTCORE_SHELL_TIMEOUT_MS", 3_600_000); // 1h

// 敏感 env 键名模式（C1）：本地 executeShell 由不可信模型构造命令、在 runloop 本进程内 spawn，
// AD-025 的 buildSandboxEnv 白名单只作用于 codex 子进程、挡不住这里。默认从 process.env 剔除这些键，
// 防 `printenv` 读出 runloop 持有的上游/系统密钥（用户实例本地执行模式）。
const SECRET_ENV_PATTERN = /(_KEY|_SECRET|_TOKEN|SECRET|PASSWORD|CREDENTIAL|ACCESS_?KEY)/i;

/** 从 env 源剔除敏感键，保留其余（PATH/HOME/LANG 等功能性变量），供本地 shell 使用。 */
export function sanitizeShellEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined || SECRET_ENV_PATTERN.test(k)) continue;
    out[k] = v;
  }
  return out;
}

export interface ShellExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * 执行一条 shell 命令并归一化为 McpToolResult。
 * - 正常结束（含非零退出码）→ isError=false，由模型据 exit_code 自行判断；
 * - spawn 失败 / 超时 → isError=true。
 */
export function executeShell(command: string, opts: ShellExecOptions = {}): Promise<McpToolResult> {
  return new Promise((resolve) => {
    if (!command.trim()) {
      resolve({ content: [{ type: "text", text: JSON.stringify({ error: "command is required" }) }], isError: true });
      return;
    }
    const child = spawn("bash", ["-lc", command], {
      cwd: opts.cwd ?? process.cwd(),
      env: opts.env ?? sanitizeShellEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    // 按**字节**封顶（L5）：旧代码用 stdout.length（UTF-16 字符数）判断但常量名是 _BYTES，中文等多字节
    // 截断尺寸不准；且 `if(length<MAX)` 通过后整块 chunk 追加，单 chunk 可任意大、内存峰值不受约束。
    // 改为达上限即停止追加（达到时 subarray 到剩余配额，可能切断末尾多字节字符，可接受）。
    child.stdout.on("data", (c: Buffer) => {
      if (stdoutBytes >= MAX_OUTPUT_BYTES) return;
      const slice = c.length > MAX_OUTPUT_BYTES - stdoutBytes ? c.subarray(0, MAX_OUTPUT_BYTES - stdoutBytes) : c;
      stdout += slice.toString();
      stdoutBytes += slice.length;
    });
    child.stderr.on("data", (c: Buffer) => {
      if (stderrBytes >= MAX_OUTPUT_BYTES) return;
      const slice = c.length > MAX_OUTPUT_BYTES - stderrBytes ? c.subarray(0, MAX_OUTPUT_BYTES - stderrBytes) : c;
      stderr += slice.toString();
      stderrBytes += slice.length;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }], isError: true });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const payload: Record<string, unknown> = {
        stdout: stdout.slice(0, MAX_OUTPUT_BYTES),
        stderr: stderr.slice(0, MAX_OUTPUT_BYTES),
        exit_code: timedOut ? 124 : code ?? 0,
      };
      if (timedOut) payload.error = `timeout after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`;
      resolve({ content: [{ type: "text", text: JSON.stringify(payload) }], isError: timedOut });
    });
  });
}
