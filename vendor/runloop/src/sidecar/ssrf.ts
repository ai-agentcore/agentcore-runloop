// Outbound requests must pass URL/IP validation. Only server-registered loopback MCP endpoints are exempt.

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
