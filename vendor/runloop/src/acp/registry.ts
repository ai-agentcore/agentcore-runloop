/** Codex subprocess warmup configuration. */
export interface PrewarmSpec {
  /** 预热命令的参数（如 codex 的 `exec --json ... -m prewarm "echo hi"`）。 */
  args: string[];
  /** 写入 home 目录的配置文件（相对路径 → 内容），spawn 前落盘。 */
  configFiles?: Record<string, string>;
  /** 指向 home 目录的环境变量名（如 codex 的 `CODEX_HOME`）。 */
  homeEnvVar?: string;
  /** 额外注入预热进程的 env。 */
  env?: Record<string, string>;
}

export interface AgentCliEntry {
  command: string;
  adapterType?: "codex";
  /** 预热规格（可选）；缺省则该 CLI 不预热。 */
  prewarm?: PrewarmSpec;
}

const DEFAULT_REGISTRY: Record<string, AgentCliEntry> = {
  codex: {
    command: "codex",
    adapterType: "codex",
    prewarm: {
      // prompt 用单词 "hi"（不带空格）：新版 codex（≥0.142）把多词 positional PROMPT 按空白拆成多个参数、
      // 报 "unexpected argument"（L-054）。预热只为暖 codex 二进制/JIT，单词即可。
      args: ["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-m", "prewarm", "hi"],
      // plugins = false：预热时也别 git clone 插件市场（拖慢 /initialize；与会话级配置一致）。
      configFiles: { "config.toml": "[features]\napps = false\nplugins = false\n", "auth.json": JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "prewarm" }) },
      homeEnvVar: "CODEX_HOME",
      env: { OPENAI_API_KEY: "prewarm" },
    },
  },
};

export class AgentCliRegistry {
  private entries: Map<string, AgentCliEntry>;

  constructor(additionalEntries?: Record<string, AgentCliEntry>) {
    this.entries = new Map(Object.entries(DEFAULT_REGISTRY));
    if (additionalEntries) {
      for (const [name, entry] of Object.entries(additionalEntries)) {
        this.register(name, entry);
      }
    }
  }

  resolve(name: string): AgentCliEntry | undefined {
    return this.entries.get(name);
  }

  isRegistered(name: string): boolean {
    return this.entries.has(name);
  }

  listRegistered(): string[] {
    return Array.from(this.entries.keys());
  }

  register(name: string, entry: AgentCliEntry): void {
    if (name !== "codex" || (entry.adapterType && entry.adapterType !== "codex")) {
      throw new Error("Only codex is supported");
    }
    this.entries.set(name, entry);
  }
}

export function validateAgentCli(name: string): boolean {
  return name === "codex";
}
