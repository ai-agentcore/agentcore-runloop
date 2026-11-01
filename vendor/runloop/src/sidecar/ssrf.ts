// SSRF 出站守卫（H1）。
//
// 资源 URL（openapiConfig.servers / mcpConfig.url / AGENT invoke endpoint）可由请求体影响，服务端会据此
// 发起 fetch/MCP 连接并透传 headers 或签名请求。对**用户自填**（auth.mode !== "agentrun"）的出站目标做
// 协议白名单 + 解析后 IP 范围拦截，拒绝 loopback / RFC1918 私网 / 169.254 链路本地（含 169.254.169.254
// 云元数据）/ 100.64 CGNAT / IPv6 ULA·link-local / IPv4-mapped IPv6。agentrun 平台内网域名（RAM 签名）豁免。
//
// 注意：单做入站 allowlist 挡不住 302 重定向绕过。调用方二选一：① 对 fetch 设 redirect:"error"（mcp-proxy）；
// ② 设 redirect:"manual"、逐跳对 Location 目标再调 assertOutboundAllowed 后才跟随（skill-download，需跟随到 OSS）。

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

type LookupFn = (host: string, opts: { all: true }) => Promise<Array<{ address: string }>>;

// AgentCore integration: trusted local bridge endpoints are registered by server
// bootstrap, never accepted from the public run request or a hostname wildcard.
const trustedOutboundUrls = new Set<string>();
export function registerTrustedOutboundUrl(rawUrl: string): void {
  const u = new URL(rawUrl);
  if (u.protocol !== "http:" || u.hostname !== "127.0.0.1" || u.pathname !== "/mcp" || u.username || u.password || u.search || u.hash) {
    throw new Error("Only a loopback AgentCore /mcp endpoint can be trusted");
  }
  trustedOutboundUrls.add(u.href);
}

// 可覆盖的 DNS 解析器：生产用 node:dns/promises 的 lookup；测试经 __setSsrfLookupForTest 注入假解析器，
// 避免单测依赖真实网络 DNS（同时仍能构造「域名解析到私网」的 rebinding 场景）。
let lookupFn: LookupFn = lookup as unknown as LookupFn;
export function __setSsrfLookupForTest(fn: LookupFn | null): void {
  lookupFn = fn ?? (lookup as unknown as LookupFn);
}

/** 校验出站 URL 安全：协议必须 http(s)，且（IP 字面量 / DNS 解析出的每个 IP）都不在受限范围。 */
export async function assertOutboundAllowed(rawUrl: string): Promise<void> {
  if (trustedOutboundUrls.has(rawUrl)) return;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(`invalid outbound URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new SsrfBlockedError(`blocked non-http(s) outbound protocol: ${u.protocol}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, ""); // 去 IPv6 字面量的方括号

  // 一律经 lookupFn 解析后逐个 IP 校验（IP 字面量经 dns.lookup 自返该 IP；域名解析所有 A/AAAA，
  // catch DNS-rebinding 到私网）。lookupFn 可注入便于单测（避免依赖真实网络 DNS）。
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookupFn(host, { all: true });
  } catch {
    throw new SsrfBlockedError(`dns lookup failed for host ${host}`);
  }
  if (addrs.length === 0) throw new SsrfBlockedError(`no address resolved for host ${host}`);
  for (const { address } of addrs) {
    if (isBlockedAddress(address)) {
      throw new SsrfBlockedError(`blocked private/loopback/metadata address ${address} (host ${host})`);
    }
  }
}

// agentrun 平台域名白名单（R1）：auth.mode=agentrun 的出站目标**不能**用 IP 级 assertOutboundAllowed
// 校验——VPC dns-mapping 会把 *.agentrun-data-vpc...aliyuncs.com 解析到内网 NLB IP，IP 级会误杀合法目标。
// 改为**域名前缀白名单**（DNS 前判定）：必须是 aliyun 域名，借此挡掉 169.254 元数据 / 127 环回 / RFC1918
// 私网等 IP 直连与任意外部域名。即不再把 auth.mode 当信任边界——所有请求体可控 URL 都过 SSRF 校验。
const AGENTRUN_HOST_SUFFIXES = [".aliyuncs.com", ".aliyuncsslb.com"];

// 生产恒开；测试经 __setAgentrunHostCheckForTest(false) 临时关，便于连本地 mock server（127.0.0.1）
// 验证签名/转发等管路（同 __setSsrfLookupForTest 的用意，不削弱生产 SSRF 策略）。
let agentrunHostCheckEnabled = true;
export function __setAgentrunHostCheckForTest(enabled: boolean): void {
  agentrunHostCheckEnabled = enabled;
}

/** 校验 agentrun 出站 URL：协议 http(s) + host 非 IP 字面量 + 落在 aliyun 域名白名单内（同步，无 DNS）。 */
export function assertAgentrunHostAllowed(rawUrl: string): void {
  if (!agentrunHostCheckEnabled) return;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(`invalid outbound URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new SsrfBlockedError(`blocked non-http(s) outbound protocol: ${u.protocol}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host) !== 0) {
    throw new SsrfBlockedError(`agentrun outbound target must be a domain, got IP literal ${host}`);
  }
  if (!AGENTRUN_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new SsrfBlockedError(`agentrun outbound host not in allowlist: ${host}`);
  }
}

/** 判断单个 IP 是否落在受限范围（解析不出的视为受限，保守拦截）。 */
export function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isBlockedV4(ip);
  if (v === 6) return isBlockedV6(ip);
  return true;
}

function isBlockedV4(ip: string): boolean {
  const p = ip.split(".").map((s) => Number(s));
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true;                            // 0.0.0.0/8
  if (a === 127) return true;                          // loopback 127/8
  if (a === 10) return true;                           // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true;    // RFC1918
  if (a === 192 && b === 168) return true;             // RFC1918
  if (a === 169 && b === 254) return true;             // link-local / 169.254.169.254 元数据
  if (a === 100 && b >= 64 && b <= 127) return true;   // CGNAT 100.64/10
  return false;
}

function isBlockedV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;          // loopback / 未指定
  if (lower.startsWith("fe80")) return true;                  // link-local fe80::/10
  if (/^f[cd]/.test(lower)) return true;                      // ULA fc00::/7
  const mapped = lower.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/); // IPv4-mapped
  if (mapped) return isBlockedV4(mapped[1]);
  return false;
}
