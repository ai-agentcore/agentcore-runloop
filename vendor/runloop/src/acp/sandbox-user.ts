// Agent CLI（codex）降权运行支持。
//
// 安全模型（AD-025）：每个 FC 实例独立、跨租户隔离，唯一要防的是「用户任务从实例里偷平台共享密钥」。
// 让 codex 以非 root 用户（默认 `coder`）运行 + 干净的 env 白名单，即可让 root 的 runloop 进程持有的
// 密钥（/proc/<runloop>/mem、/proc/<runloop>/environ）对 codex 不可读，且非 root 无 CAP_NET_RAW 无法抓包。
//
// 仅当本进程是 root（生产容器）时才降权；开发/测试（非 root）不降权，行为与原先一致。

import { readFileSync } from "node:fs";
import { chown, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface AgentUser {
  name: string;
  uid: number;
  gid: number;
  home: string;
}

/** 解析 /etc/passwd 文本，取指定用户的 uid/gid/home（导出供测试）。 */
export function parsePasswd(content: string, name: string): AgentUser | null {
  for (const line of content.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const f = line.split(":");
    if (f[0] === name) {
      const uid = Number(f[2]);
      const gid = Number(f[3]);
      if (!Number.isFinite(uid) || !Number.isFinite(gid)) return null;
      return { name, uid, gid, home: f[5] || `/home/${name}` };
    }
  }
  return null;
}

function lookupUser(name: string): AgentUser | null {
  try {
    return parsePasswd(readFileSync("/etc/passwd", "utf8"), name);
  } catch {
    return null;
  }
}

/**
 * 决定是否把 agent CLI 降权到非 root 用户运行；返回目标用户或 null（不降权）。
 * - `AGENTCORE_DROP_PRIVILEGE=0|false|off` 显式关闭。
 * - 仅当本进程为 root 才能 setuid 到别的用户；非 root（开发/测试）一律返回 null。
 * - 目标用户名取 `AGENTCORE_AGENT_USER`（默认 `coder`），需存在于 /etc/passwd。
 */
export function resolveAgentUser(opts?: { user?: string; enabled?: string }): AgentUser | null {
  const enabled = opts?.enabled ?? process.env.AGENTCORE_DROP_PRIVILEGE ?? "auto";
  if (enabled === "0" || enabled === "false" || enabled === "off") return null;

  const getuid = (process as NodeJS.Process & { getuid?: () => number }).getuid;
  if (typeof getuid !== "function" || getuid() !== 0) return null;

  const name = opts?.user ?? process.env.AGENTCORE_AGENT_USER ?? "coder";
  return lookupUser(name);
}

// 非密钥、agent CLI 运行所需的 env 键（含装包工具的境内镜像配置）。
const ENV_ALLOWLIST = [
  "PATH", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "TMPDIR",
  "GOPROXY", "GOSUMDB", "GOTOOLCHAIN", "GOPATH", "GOBIN", "GOFLAGS",
  "MAMBA_ROOT_PREFIX", "CONDARC", "npm_config_registry",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "CURL_CA_BUNDLE",
];

/**
 * 为降权后的 agent CLI 构造干净 env：白名单基础变量 + 强制 HOME/USER + 适配器自身 env 覆盖。
 * 平台密钥（任何不在白名单里的 *_KEY/_SECRET/_TOKEN/credentials 等）一律不进入，
 * 杜绝 codex 用 `printenv` / 继承 env 偷到 runloop 持有的密钥。
 */
export function buildSandboxEnv(
  adapterEnv: Record<string, string>,
  user: AgentUser,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_ALLOWLIST) {
    const v = source[k];
    if (v !== undefined) env[k] = v;
  }
  env.HOME = user.home;
  env.USER = user.name;
  env.LOGNAME = user.name;
  if (!env.PATH) env.PATH = "/usr/local/bin:/usr/bin:/bin";
  // 适配器自身的 env（CODEX_HOME / OPENAI_API_KEY 占位 / OPENAI_BASE_URL / NO_PROXY 等）优先生效
  return { ...env, ...adapterEnv };
}

/** 递归 chown，让降权用户能读写工作区 / CODEX_HOME（best-effort，失败忽略）。 */
export async function chownRecursive(path: string, uid: number, gid: number): Promise<void> {
  await chown(path, uid, gid).catch(() => {});
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(path, e.name);
    if (e.isDirectory() && !e.isSymbolicLink()) {
      await chownRecursive(p, uid, gid);
    } else {
      await chown(p, uid, gid).catch(() => {});
    }
  }
}
