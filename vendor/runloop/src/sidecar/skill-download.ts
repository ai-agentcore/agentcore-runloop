import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { buildSignedRequest } from "./agentrun-sign.js";
import { assertOutboundAllowed, assertAgentrunHostAllowed } from "./ssrf.js";
import { rewriteToInternalEndpoint } from "./internal-endpoint.js";
import type { Credentials } from "../types/resources.js";

/**
 * SKILL 包下载与解包。参考 agentrun-sdk-python `tool.download_skill`：
 * RAM 签名（AGENTRUN4-HMAC-SHA256，host 改写 `-ram`）GET downloadUrl → zip bytes → 解包到目标目录。
 */

// 防 zip bomb / 失控下载的上限（H3）。
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;       // 单 entry 解压上限
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;      // 累计解压上限
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;   // 压缩包下载上限
const MAX_ENTRIES = 2000;                      // entry 数上限
const MAX_REDIRECTS = 5;                        // 重定向跳数上限（防重定向环/无限跳）

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/** 只保留 host + pathname，丢弃 query（signed URL 的签名/凭证在 query 里，不可入日志，H3）。 */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return "<unparseable-url>";
  }
}

/** 流式读取响应体并按字节封顶：先查 Content-Length 预检，再边读边累计，超限即 cancel + 抛错（H3）。 */
async function readBodyCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers?.get?.("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`skill download too large: Content-Length ${declared} > ${maxBytes}`);
  }
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`skill download too large: streamed > ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * 依赖无关的 ZIP 解包：按中央目录读取条目，支持 store(0) 与 deflate(8)。
 * agentrun skill 包结构简单（SKILL.md + 可选脚本/资源），不处理 zip64 / 加密。
 */
export function unzipBuffer(buf: Buffer): ZipEntry[] {
  // EOCD（End of Central Directory，0x06054b50）从尾部回扫（comment 长度通常为 0）
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("invalid zip: EOCD not found");

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16); // 中央目录起始偏移
  const entries: ZipEntry[] = [];
  let totalOut = 0; // 累计解压字节（防 zip bomb，H3）

  for (let n = 0; n < count && entries.length < MAX_ENTRIES; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("invalid zip: bad central header");
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);

    // 用 local header 自己的 name/extra 长度定位数据起点（中央目录与 local 的 extra 可不同）
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error("invalid zip: bad local header");
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);

    // 累计解压超上限即停止（防高压缩比 zip bomb 撑爆内存，H3）。
    if (totalOut >= MAX_TOTAL_BYTES) break;

    let data: Buffer;
    if (method === 0) {
      // store：未压缩，按单 entry 上限截断（不应超，超则跳过该 entry）。
      if (comp.length > MAX_ENTRY_BYTES) { off += 46 + nameLen + extraLen + commentLen; continue; }
      data = Buffer.from(comp);
    } else if (method === 8) {
      // deflate：限制单 entry 解压上限，超限 inflateRawSync 抛错 → 跳过该 entry（防单文件 zip bomb）。
      try {
        data = inflateRawSync(comp, { maxOutputLength: MAX_ENTRY_BYTES });
      } catch {
        off += 46 + nameLen + extraLen + commentLen;
        continue;
      }
    } else {
      throw new Error(`unsupported zip compression method ${method}`);
    }

    totalOut += data.length;
    entries.push({ name, data });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 单引号安全包裹（防 shell 注入/转义）：`'` → `'\''`（与 exec-backend 的 shQuote 一致）。 */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * 沙箱内解包脚本（python3，code-interpreter 沙箱自带）：reroot（L-048：剥唯一顶层目录使 SKILL.md 落根）
 * + 防目录穿越 + **按字节落盘**（二进制安全——这正是 option b 相对「本地解包→数据面 text writeFile」的关键）。
 * argv: <zip> <destDir>。
 */
const SANDBOX_SKILL_EXTRACT_PY = `import sys, zipfile, os, shutil
zip_path, dest = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(zip_path) as z:
    names = [n for n in z.namelist() if not n.endswith('/')]
    tops = set(n.split('/', 1)[0] for n in names)
    prefix = ''
    if not any(n == 'SKILL.md' for n in names) and len(tops) == 1:
        only = next(iter(tops))
        if (only + '/SKILL.md') in names:
            prefix = only + '/'
    for n in names:
        rel = n[len(prefix):] if prefix and n.startswith(prefix) else n
        parts = [p for p in rel.split('/') if p not in ('', '.')]
        if not parts or '..' in parts:
            continue
        target = os.path.join(dest, *parts)
        d = os.path.dirname(target)
        if d:
            os.makedirs(d, exist_ok=True)
        with z.open(n) as src, open(target, 'wb') as out:
            shutil.copyfileobj(src, out)`;

/**
 * 构造「在沙箱内下载并解包一个 skill」的自包含 bash 脚本（Change B / option b）。
 * 把 RAM 签名头交给**沙箱内** curl 直发（`-fsSL` 静默/失败非零/跟随重定向），二进制按字节落盘——
 * 避免经数据面 text-only writeFile 损坏二进制（旧 initEnvironment 的 utf8 同步缺陷）。
 * 解包用 python3 内联脚本（含 reroot + 防穿越），临时 zip 用毕清理。
 *
 * Host 头**不**作为 `-H` 透传：让 curl 按 URL 自行设 Host（含 302→OSS 预签名跳转时按新 host 设），
 * 否则签名用的 `-ram` host 会串到 OSS。Agentrun-Authorization 在跳转后仍会被 curl 透传到 OSS——
 * 已知且可接受（OSS 预签名自鉴权、忽略该头；决策「漏给 oss 没问题」）。
 */
export function buildSandboxSkillDownloadScript(opts: {
  signedUrl: string;
  headers: Record<string, string>;
  skillDir: string;
  tmpZip: string;
}): string {
  const headerFlags = Object.entries(opts.headers)
    .filter(([k]) => k.toLowerCase() !== "host")
    .map(([k, v]) => `-H ${shq(`${k}: ${v}`)}`)
    .join(" ");
  const dir = shq(opts.skillDir);
  const zip = shq(opts.tmpZip);
  const url = shq(opts.signedUrl);
  return [
    "set -e",
    `mkdir -p ${dir}`,
    `curl -fsSL ${headerFlags} -o ${zip} ${url}`,
    `python3 - ${zip} ${dir} <<'AGENTCORE_SKILL_PY'`,
    SANDBOX_SKILL_EXTRACT_PY,
    "AGENTCORE_SKILL_PY",
    `rm -f ${zip}`,
  ].join("\n");
}

/** 防目录穿越：归一化分隔符、剥前导斜杠、拒绝含 `..` 段；目录条目返回 null。 */
function safeRelPath(name: string): string | null {
  const norm = name.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!norm || norm.endsWith("/")) return null;
  if (norm.split("/").some((seg) => seg === "..")) return null;
  return norm;
}

/**
 * 重定 skill 根：GitHub 归档型 zip 把全部文件包在唯一顶层目录下（如 `repo-main/SKILL.md`），
 * 须剥离该前缀使 SKILL.md 落在 destDir 根——否则 `normalizeSkillName` / `get_skill` / codex 渐进发现
 * 都按 `join(dir, "SKILL.md")` 读取必然 miss、skill 正文静默丢失（对齐 super_agent findSkillRoot）。
 * 规则：根已有 SKILL.md → 原样；否则全部文件同属唯一顶层目录且其下有 SKILL.md → 剥前缀；
 * 其它（多顶层目录 / 找不到 SKILL.md）→ 无法确定根，保持原样。
 */
export function rerootSkillEntries(entries: ZipEntry[]): ZipEntry[] {
  const rels = entries.map((e) => safeRelPath(e.name)).filter((r): r is string => r !== null);
  if (rels.some((r) => r === "SKILL.md")) return entries;
  const topDirs = new Set(rels.map((r) => r.split("/")[0]));
  if (topDirs.size !== 1) return entries;
  const dir = [...topDirs][0];
  const prefix = `${dir}/`;
  if (!rels.some((r) => r === `${prefix}SKILL.md`)) return entries;
  return entries.map((e) => {
    const norm = e.name.replace(/\\/g, "/").replace(/^\/+/, "");
    return norm.startsWith(prefix) ? { ...e, name: norm.slice(prefix.length) } : e;
  });
}

/** 单跳 fetch，把 undici 不透明的 "fetch failed" 真因（err.cause + code）摊进 message（不带 signed query）。 */
async function fetchOnce(url: string, headers: Record<string, string> | undefined): Promise<Response> {
  try {
    // redirect:"manual"——不让 fetch 自动跟随；3xx 由本模块按 SSRF 校验后手动跟（见 downloadAndUnpackSkill）。
    // 收口到内网切换转换点（当前恒等；OSS 预签名跳转等非 agentrun 公网域名将来也由该函数判定不转换）。
    return await fetch(rewriteToInternalEndpoint(url), { method: "GET", headers, redirect: "manual" });
  } catch (err) {
    const cause = (err as { cause?: unknown }).cause;
    const causeMsg =
      cause instanceof Error
        ? `${cause.message}${(cause as { code?: string }).code ? ` (${(cause as { code?: string }).code})` : ""}`
        : cause
          ? String(cause)
          : undefined;
    throw new Error(
      `skill download fetch error url=${redactUrl(url)}: ${err instanceof Error ? err.message : String(err)}${causeMsg ? ` — cause: ${causeMsg}` : ""}`,
    );
  }
}

/**
 * 经 RAM 签名 GET `downloadUrl`，把 skill 包解包到 `destDir`。
 * 失败抛错（调用方决定是否回落 frontmatter-only）。
 *
 * 重定向处理：AgentRun data-plane 的 download 端点会 302 跳到 OSS 预签名 URL。允许多跳（上限 MAX_REDIRECTS），
 * 但**每一跳的目标都由服务器响应控制 → 必须逐跳过 SSRF 校验**（H1），拒绝被诱导跳到内网/元数据。
 * 跳转后丢弃原 agentrun 签名头（目标是自包含鉴权的 OSS 预签名 URL，跨 host 带签名头无意义且避免凭证外漏）。
 */
export async function downloadAndUnpackSkill(
  downloadUrl: string,
  destDir: string,
  credentials: Credentials,
): Promise<void> {
  // SSRF（R1）：downloadUrl 来自 RunRequest，首跳也须校验——agentrun 签名下载只允许 aliyun 域名，
  // 挡掉 169.254 元数据 / 127 环回 / RFC1918 等 IP 直连（后续重定向目标仍逐跳过 assertOutboundAllowed）。
  assertAgentrunHostAllowed(downloadUrl);
  const signed = buildSignedRequest("GET", downloadUrl, "", credentials);
  let url = signed.url;
  let headers: Record<string, string> | undefined = signed.headers;
  let res = await fetchOnce(url, headers);
  for (let hop = 0; res.status >= 300 && res.status < 400; hop++) {
    const loc = res.headers.get("location");
    if (!loc) break; // 3xx 无 Location → 交由下面 !res.ok 分支报错
    if (hop >= MAX_REDIRECTS) throw new Error(`skill download: too many redirects (>${MAX_REDIRECTS}) url=${redactUrl(url)}`);
    const next = new URL(loc, url).toString();
    await assertOutboundAllowed(next); // 每跳都校验重定向目标（H1）：拒私网/loopback/元数据
    url = next;
    headers = undefined; // 不把 agentrun 签名头带到 OSS 等跳转目标
    res = await fetchOnce(url, headers);
  }
  if (!res.ok) {
    // 错误日志只记 host+pathname，绝不带 signed query（含签名/凭证），也不回灌上游 body（H3）。
    throw new Error(`skill download failed: HTTP ${res.status} url=${redactUrl(url)}`);
  }

  const buf = await readBodyCapped(res, MAX_DOWNLOAD_BYTES);
  const entries = rerootSkillEntries(unzipBuffer(buf));

  let wrote = 0;
  for (const entry of entries) {
    const rel = safeRelPath(entry.name);
    if (!rel) continue;
    const target = join(destDir, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, entry.data);
    wrote++;
  }
  if (wrote === 0) throw new Error("skill package contained no files");
}
