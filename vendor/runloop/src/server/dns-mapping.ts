/**
 * DNS 映射（VPC 打通）—— 让 runloop FC 直连 agentrun 数据面/控制面的**内网域名**。
 *
 * 背景：runloop FC 与 super_agent 同 VPC，但 `*.agentrun-data-vpc.*` / `agentrun-vpc.*` 这类
 * 内网域名在容器内默认解析不到 VPC 内的实际目标（NLB / PrivateLink endpoint）。super_agent 用同样的
 * 进程级 hook 解决（`super_agent/src/server/dns-mapping.ts`），本文件是其移植：
 *   1. hook `dns.lookup`：命中规则的域名解析到对应 target（VPC 内 NLB/EP 域名 → 私网 IP）。
 *   2. hook `tls.connect`：当代码直接用原域名建连时，保底把 SNI 修正回原域名（证书签发名）。
 *
 * 完全 **env 驱动**：未配置 `AGENTRUN_DATA_HOST/ENDPOINT`（及可选 `AGENTRUN_CONTROL_*`）时为 no-op，
 * 故本地/线上（线上目前不配 VPC）零影响。值与 super_agent 预发一致（同 VPC、可复用 NLB/EP 目标）。
 */
import dns from "node:dns";
import tls from "node:tls";
import { Logger } from "../util/logger.js";

export interface DnsMappingRule {
  mode: "exact" | "suffix";
  /** exact: 完整域名；suffix: 域名后缀（不含前导 `.`）。 */
  pattern: string;
  /** 解析目标域名（VPC 内可达）。 */
  target: string;
}

/**
 * 从 env 构建 DNS 映射规则（纯函数，无副作用）。
 * - 控制面：`AGENTRUN_CONTROL_HOST`（精确域名）→ `AGENTRUN_CONTROL_ENDPOINT` 的 host。
 * - 数据面：`AGENTRUN_DATA_HOST`（后缀，覆盖 `{accountId}-ram.<host>` 等子域）→ `AGENTRUN_DATA_ENDPOINT` 的 host。
 */
export function buildDnsMappingRules(env: NodeJS.ProcessEnv = process.env): DnsMappingRule[] {
  const rules: DnsMappingRule[] = [];

  const controlHost = env.AGENTRUN_CONTROL_HOST;
  const controlEndpoint = env.AGENTRUN_CONTROL_ENDPOINT;
  if (controlHost && controlEndpoint) {
    rules.push({ mode: "exact", pattern: controlHost, target: new URL(controlEndpoint).hostname });
  }

  const dataHost = env.AGENTRUN_DATA_HOST;
  const dataEndpoint = env.AGENTRUN_DATA_ENDPOINT;
  if (dataHost && dataEndpoint) {
    rules.push({ mode: "suffix", pattern: dataHost, target: new URL(dataEndpoint).hostname });
  }

  return rules;
}

/** 按规则解析域名；命中返回 target，否则原样返回（纯函数）。 */
export function resolveHostname(hostname: string, rules: DnsMappingRule[]): string {
  for (const rule of rules) {
    if (rule.mode === "exact" && hostname === rule.pattern) return rule.target;
    if (rule.mode === "suffix" && (hostname === rule.pattern || hostname.endsWith("." + rule.pattern))) {
      return rule.target;
    }
  }
  return hostname;
}

export interface DnsMappingDeps {
  /** 可注入的 dns 模块（测试用）；默认 node:dns。 */
  dnsModule?: { lookup: typeof dns.lookup };
  /** 可注入的 tls 模块（测试用）；默认 node:tls。 */
  tlsModule?: { connect: typeof tls.connect };
  /** 可注入 env（测试用）；默认 process.env。 */
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
}

/**
 * 安装全局 DNS 映射（进程级副作用，应在 server 启动时调用一次）。
 * 无规则（env 未配）时直接返回，不打补丁。返回生效的规则列表（便于日志/测试断言）。
 */
export function setupDnsMapping(deps: DnsMappingDeps = {}): DnsMappingRule[] {
  const rules = buildDnsMappingRules(deps.env ?? process.env);
  if (rules.length === 0) return rules;

  const log = deps.logger ?? new Logger("dns");
  const dnsMod = deps.dnsModule ?? dns;
  const tlsMod = deps.tlsModule ?? tls;

  // 幂等保护（L7）：进程级 monkey-patch 无 teardown，重复调用会层层包裹 patch 链（热重载/重复初始化时
  // 无限增长）。已打过补丁则跳过再 patch。
  const PATCH_MARK = "__runloopDnsPatched";
  if ((dnsMod.lookup as unknown as Record<string, unknown>)[PATCH_MARK]) {
    log.info("dns-mapping already installed, skipping re-patch");
    return rules;
  }

  for (const rule of rules) {
    log.info("dns-mapping rule installed", {
      label: rule.mode === "exact" ? rule.pattern : `*.${rule.pattern}`,
      target: rule.target,
    });
  }

  // 1) hook dns.lookup：命中规则的域名换成 target 再交原始 lookup 解析。
  const originalLookup = dnsMod.lookup;
  (dnsMod as { lookup: unknown }).lookup = function patchedLookup(
    hostname: string,
    optionsOrCb: unknown,
    maybeCallback?: unknown,
  ) {
    const resolved = resolveHostname(hostname, rules);
    if (resolved !== hostname) log.info("dns-mapping resolve", { from: hostname, to: resolved });
    return (originalLookup as (...a: unknown[]) => unknown).call(dnsMod, resolved, optionsOrCb, maybeCallback);
  };
  (dnsMod.lookup as unknown as Record<string, unknown>)[PATCH_MARK] = true; // 标记已 patch（幂等，L7）

  // 2) hook tls.connect：保底 SNI 修正（target host → 原域名 pattern），避免证书校验失败。
  const targetToPattern = new Map<string, string>();
  for (const rule of rules) targetToPattern.set(rule.target, rule.pattern);

  const originalTlsConnect = tlsMod.connect;
  (tlsMod as { connect: unknown }).connect = function patchedTlsConnect(...args: unknown[]) {
    const opts = (typeof args[0] === "object" && args[0] !== null ? args[0] : {}) as {
      host?: string;
      servername?: string;
    };
    const pattern = opts.host ? targetToPattern.get(opts.host) : undefined;
    if (pattern && !opts.servername) {
      opts.servername = pattern;
      log.info("dns-mapping tls sni override", { host: opts.host, servername: pattern });
    }
    return (originalTlsConnect as (...a: unknown[]) => unknown).apply(tlsMod, args);
  };

  return rules;
}
