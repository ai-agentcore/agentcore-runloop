import { createHmac, createHash } from "node:crypto";
import type { Credentials } from "../types/resources.js";

/**
 * AgentRun data plane 的 RAM 签名实现。
 * 参考 super-agent 的 sign.ts，实现 AGENTRUN4-HMAC-SHA256 签名算法。
 */

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

export function buildSignedRequest(
  method: string,
  rawUrl: string,
  // 保留位置参数以兼容调用方；签名用 UNSIGNED-PAYLOAD，不对 body 做哈希，故此处不引用。
  _body: string,
  credentials: Credentials,
  contentType?: string,
): SignedRequest {
  const url = rewriteToRamUrl(rawUrl);
  const parsed = new URL(url);

  const dateStr = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const dateOnly = dateStr.slice(0, 10).replace(/-/g, "");
  const region = credentials.region ?? "cn-hangzhou";

  // 严格对齐权威签名器（agentrun-sdk-python `get_agentrun_signed_headers` / super_agent sign.ts）：
  // 只签 host / x-acs-date / x-acs-content-sha256 [+ x-acs-security-token]，content-type 仅在显式传入
  // （即有 body 的请求）时参与签名。**不得**加 x-acs-parent-id 等额外 x-acs-* 头——任何多签的
  // x-acs-* 都会让服务端按其固定实现重算出不同签名 → 403 SignatureDoesNotMatch（skill GET 下载实测）。
  const headers: Record<string, string> = {
    host: parsed.host,
    "x-acs-date": dateStr,
    "x-acs-content-sha256": "UNSIGNED-PAYLOAD",
  };

  if (credentials.securityToken) {
    headers["x-acs-security-token"] = credentials.securityToken;
  }
  if (contentType) {
    headers["content-type"] = contentType;
  }

  const signedHeaderKeys = Object.keys(headers)
    .filter((k) => k === "host" || k === "content-type" || k.startsWith("x-acs-"))
    .sort();
  const signedHeadersStr = signedHeaderKeys.join(";");

  const canonicalHeaders = signedHeaderKeys
    .map((k) => `${k}:${headers[k]}`)
    .join("\n") + "\n";

  const canonicalQueryString = [...parsed.searchParams.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${percentEncode(k)}=${percentEncode(v)}`)
    .join("&");

  const canonicalRequest = [
    method.toUpperCase(),
    parsed.pathname,
    canonicalQueryString,
    canonicalHeaders,
    signedHeadersStr,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const hashedCanonicalRequest = sha256Hex(canonicalRequest);
  const stringToSign = `AGENTRUN4-HMAC-SHA256\n${hashedCanonicalRequest}`;

  const signingKey = deriveSigningKey(credentials.accessKeySecret, dateOnly, region);
  const signature = hmacSha256Hex(signingKey, stringToSign);

  const credential = `${credentials.accessKeyId}/${dateOnly}/${region}/agentrun/aliyun_v4_request`;
  headers["Agentrun-Authorization"] =
    `AGENTRUN4-HMAC-SHA256 Credential=${credential},SignedHeaders=${signedHeadersStr},Signature=${signature}`;

  return { url, headers };
}

function rewriteToRamUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    if (u.hostname.endsWith(".aliyuncs.com") && !u.hostname.includes("-ram.")) {
      u.hostname = u.hostname.replace(
        /^([^.]+)\.(agentrun-data|funagent-data|funagent-data-pre)/,
        "$1-ram.$2"
      );
    }
    return u.toString().replace(/\/$/, "");
  } catch {
    return rawUrl;
  }
}

function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf-8").digest("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf-8").digest();
}

function hmacSha256Hex(key: Buffer | string, data: string): string {
  return createHmac("sha256", key).update(data, "utf-8").digest("hex");
}

function deriveSigningKey(secret: string, date: string, region: string): Buffer {
  const kDate = hmacSha256(`aliyun_v4${secret}`, date);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, "agentrun");
  return hmacSha256(kService, "aliyun_v4_request");
}
