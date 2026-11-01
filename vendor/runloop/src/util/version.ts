import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 运行时版本信息 —— 启动时打印，便于在 SLS / 日志里一眼确认跑的是哪个版本。
 *
 * `tag` 是最关心的：部署镜像 tag（= git short-sha，AD-028）。运行进程读 env `AGENTCORE_TAG`，该 env 有两个来源（同一 sha）：
 *   ① **镜像 baked**：Dockerfile `ARG AGENTCORE_TAG` → `ENV AGENTCORE_TAG`（make image / `docker build --build-arg` 注入）—— 镜像自描述版本；
 *   ② **FC 部署 env**：deploy yaml 的 environmentVariables.AGENTCORE_TAG（覆盖 ①，格式无关、稳）。
 * 本地 `make dev`（无 docker、无 env）→ 回落 `unknown`（语义上就是「非部署构建」）。
 * `version` 为 package.json 的 semver（始终可读）。
 */
export interface VersionInfo {
  /** 部署镜像 tag（git short-sha，AGENTCORE_TAG）；本地/未注入为 "unknown"。 */
  tag: string;
  /** package.json 的 version（semver）。 */
  version: string;
  /** Node.js 运行时版本。 */
  node: string;
  /** 部署环境（pre/staging/prod 等，AGENTCORE_ENV）；未设为 undefined。 */
  env?: string;
}

/** 解析版本信息。env 每次现读（部署期不变、但便于测试）；package.json 读取结果缓存（唯一 fs 开销）。 */
export function getVersionInfo(): VersionInfo {
  const env = process.env.AGENTCORE_ENV?.trim();
  return {
    tag: process.env.AGENTCORE_TAG?.trim() || "unknown",
    version: readPackageVersion(),
    node: process.version,
    ...(env ? { env } : {}),
  };
}

/** 一行人类可读版本串：`runloop <tag> (v<version>, node <node>[, env <env>])`。 */
export function formatVersion(info: VersionInfo = getVersionInfo()): string {
  const env = info.env ? `, env ${info.env}` : "";
  return `runloop ${info.tag} (v${info.version}, node ${info.node}${env})`;
}

/**
 * 从候选路径里读出第一个能解析出 `version` 的 package.json；都失败则 "unknown"。
 * 纯函数（不依赖 env / 缓存），便于覆盖错误/回退分支。
 */
export function resolvePackageVersion(candidates: string[]): string {
  for (const p of candidates) {
    try {
      const json = JSON.parse(readFileSync(p, "utf8")) as { version?: string };
      if (json.version) return json.version;
    } catch {
      // 试下一个候选
    }
  }
  return "unknown";
}

/** 默认候选：① 模块相对（容器 tsx 跑 src/，dirname=/app/src/util → ../../package.json=/app/package.json）；② cwd 兜底。 */
function defaultPackageJsonCandidates(): string[] {
  return [
    join(dirname(fileURLToPath(import.meta.url)), "../../package.json"),
    join(process.cwd(), "package.json"),
  ];
}

let cachedPackageVersion: string | undefined;

function readPackageVersion(): string {
  if (cachedPackageVersion === undefined) {
    cachedPackageVersion = resolvePackageVersion(defaultPackageJsonCandidates());
  }
  return cachedPackageVersion;
}
