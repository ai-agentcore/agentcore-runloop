import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { unzipBuffer, downloadAndUnpackSkill, buildSandboxSkillDownloadScript } from "@/sidecar/skill-download.js";
import { __setSsrfLookupForTest } from "@/sidecar/ssrf.js";
import type { Credentials } from "@/types/resources.js";

const CREDS: Credentials = { accessKeyId: "ak", accessKeySecret: "sk", region: "cn-hangzhou" };

/** Response-like stub：覆盖 status/headers.get/arrayBuffer 足够喂 downloadAndUnpackSkill。 */
function resp(status: number, opts: { headers?: Record<string, string>; arrayBuffer?: ArrayBuffer; text?: string } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => opts.headers?.[k.toLowerCase()] ?? null },
    arrayBuffer: async () => opts.arrayBuffer ?? new ArrayBuffer(0),
    text: async () => opts.text ?? "",
  } as unknown as Response;
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

/** 构造单文件 zip（method 0=store / 8=deflate），local header offset 固定为 0。 */
function makeZip(name: string, content: string, method: 0 | 8): Buffer {
  const nameB = Buffer.from(name);
  const raw = Buffer.from(content);
  const comp = method === 8 ? deflateRawSync(raw) : raw;
  const crc = crc32(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameB.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(comp.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameB.length, 28);
  central.writeUInt32LE(0, 42); // local header offset

  const localTotal = 30 + nameB.length + comp.length;
  const centralTotal = 46 + nameB.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralTotal, 12);
  eocd.writeUInt32LE(localTotal, 16);

  return Buffer.concat([local, nameB, comp, central, nameB, eocd]);
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** 构造多文件 zip（全部 store/method 0），每条 entry 各自正确的 local header offset。 */
function makeMultiZip(files: Array<{ name: string; content: string }>): Buffer {
  const locals: Buffer[] = [];
  const offsets: number[] = [];
  let offset = 0;
  for (const f of files) {
    const nameB = Buffer.from(f.name);
    const raw = Buffer.from(f.content);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(raw.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameB.length, 26);
    const buf = Buffer.concat([local, nameB, raw]);
    offsets.push(offset);
    offset += buf.length;
    locals.push(buf);
  }
  const localSection = Buffer.concat(locals);
  const centrals: Buffer[] = [];
  files.forEach((f, i) => {
    const nameB = Buffer.from(f.name);
    const raw = Buffer.from(f.content);
    const crc = crc32(raw);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(raw.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameB.length, 28);
    central.writeUInt32LE(offsets[i], 42);
    centrals.push(Buffer.concat([central, nameB]));
  });
  const centralSection = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSection.length, 12);
  eocd.writeUInt32LE(localSection.length, 16);
  return Buffer.concat([localSection, centralSection, eocd]);
}

describe("unzipBuffer", () => {
  it("extracts a stored (method 0) entry", () => {
    const entries = unzipBuffer(makeZip("SKILL.md", "hello world", 0));
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("SKILL.md");
    expect(entries[0].data.toString()).toBe("hello world");
  });

  it("extracts a deflate (method 8) entry", () => {
    const body = "deflate me ".repeat(50);
    const entries = unzipBuffer(makeZip("SKILL.md", body, 8));
    expect(entries[0].data.toString()).toBe(body);
  });

  it("throws on missing EOCD", () => {
    expect(() => unzipBuffer(Buffer.from("not a zip"))).toThrow(/EOCD/);
  });

  it("throws on unsupported compression method", () => {
    // 借类型转换写入非 0/8 的 method（如 99），命中 unzipBuffer 的 unsupported 分支。
    expect(() => unzipBuffer(makeZip("SKILL.md", "x", 99 as unknown as 0))).toThrow(
      /unsupported zip compression method/,
    );
  });
});

describe("downloadAndUnpackSkill", () => {
  let dir = "";
  afterEach(async () => {
    vi.unstubAllGlobals();
    __setSsrfLookupForTest(null);
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("signs, downloads and unpacks the zip into destDir", async () => {
    dir = await mkdtemp(join(tmpdir(), "skill-dl-"));
    const zip = makeZip("SKILL.md", "---\nname: x\ndescription: y\n---\nbody", 0);
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      // RAM 签名头存在 + host 改写为 -ram
      expect((init.headers as Record<string, string>)["Agentrun-Authorization"]).toMatch(/AGENTRUN4-HMAC-SHA256/);
      expect(url).toContain("-ram.agentrun-data");
      return { ok: true, status: 200, arrayBuffer: async () => toArrayBuffer(zip) } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await downloadAndUnpackSkill(
      "https://acct.agentrun-data.cn-hangzhou.aliyuncs.com/tools/x/download",
      dir,
      CREDS,
    );

    expect(await readFile(join(dir, "SKILL.md"), "utf-8")).toContain("body");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws on non-2xx HTTP", async () => {
    dir = await mkdtemp(join(tmpdir(), "skill-dl-"));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, text: async () => "Forbidden" }) as unknown as Response));
    await expect(
      downloadAndUnpackSkill("https://acct.agentrun-data.cn-hangzhou.aliyuncs.com/tools/x/download", dir, CREDS),
    ).rejects.toThrow(/HTTP 403/);
  });

  it("surfaces fetch network cause (不只是不透明的 'fetch failed')", async () => {
    dir = await mkdtemp(join(tmpdir(), "skill-dl-"));
    // 模拟 undici：message 恒为 "fetch failed"，真因在 cause（这里模拟 redirect:error 被拒）。
    const netErr = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("unexpected redirect"), { code: "UND_ERR_REQ_REDIRECT" }),
    });
    vi.stubGlobal("fetch", vi.fn(async () => { throw netErr; }));
    const err = await downloadAndUnpackSkill(
      "https://acct.agentrun-data.cn-hangzhou.aliyuncs.com/tools/x/download?sig=secret",
      dir,
      CREDS,
    ).catch((e) => e as Error);
    expect(err.message).toContain("unexpected redirect"); // cause 摊进了 message
    expect(err.message).toContain("UND_ERR_REQ_REDIRECT");
    expect(err.message).toContain("/tools/x/download");
    expect(err.message).not.toContain("secret"); // 仍不泄露 signed query（H3）
    expect(err.message).not.toContain("?");
  });

  it("follows a 302 to OSS (SSRF-allowed) and unpacks", async () => {
    dir = await mkdtemp(join(tmpdir(), "skill-dl-"));
    __setSsrfLookupForTest(async () => [{ address: "203.0.113.7" }]); // 公网 IP → 放行
    const zip = makeZip("SKILL.md", "---\nname: x\ndescription: y\n---\nbody", 0);
    let n = 0;
    const responses = [
      resp(302, { headers: { location: "https://oss-cn-hangzhou.aliyuncs.com/bucket/obj?sig=ossSECRET" } }),
      resp(200, { arrayBuffer: toArrayBuffer(zip) }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => responses[n++]));
    await downloadAndUnpackSkill("https://acct.agentrun-data.cn-hangzhou.aliyuncs.com/tools/x/download", dir, CREDS);
    expect(await readFile(join(dir, "SKILL.md"), "utf8")).toContain("name: x");
  });

  it("allows multiple hops, checking SSRF on EACH redirect target", async () => {
    dir = await mkdtemp(join(tmpdir(), "skill-dl-"));
    const lookup = vi.fn(async () => [{ address: "203.0.113.7" }]);
    __setSsrfLookupForTest(lookup);
    const zip = makeZip("SKILL.md", "ok", 0);
    let n = 0;
    const responses = [
      resp(302, { headers: { location: "https://a.aliyuncs.com/1" } }),
      resp(307, { headers: { location: "https://b.aliyuncs.com/2" } }),
      resp(200, { arrayBuffer: toArrayBuffer(zip) }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => responses[n++]));
    await downloadAndUnpackSkill("https://acct.agentrun-data.cn-hangzhou.aliyuncs.com/tools/x/download", dir, CREDS);
    expect(lookup).toHaveBeenCalledTimes(2); // 每个重定向目标各校验一次（初始 URL 不校验，信任上游）
  });

  it("rejects a non-aliyun / metadata downloadUrl on the first hop (SSRF R1, no fetch)", async () => {
    dir = await mkdtemp(join(tmpdir(), "skill-dl-"));
    const spy = vi.fn(async () => resp(200, {}));
    vi.stubGlobal("fetch", spy);
    for (const bad of ["http://169.254.169.254/skill.zip", "http://127.0.0.1/skill.zip", "https://evil.example.com/skill.zip"]) {
      await expect(downloadAndUnpackSkill(bad, dir, CREDS), bad).rejects.toThrow(/agentrun outbound|not in allowlist|IP literal/);
    }
    expect(spy).not.toHaveBeenCalled(); // 首跳被拦，根本不发请求
  });

  it("rejects a redirect to a private/metadata target (SSRF, no files)", async () => {
    dir = await mkdtemp(join(tmpdir(), "skill-dl-"));
    __setSsrfLookupForTest(async () => [{ address: "169.254.169.254" }]); // 元数据 IP → 拦截
    vi.stubGlobal("fetch", vi.fn(async () =>
      resp(302, { headers: { location: "http://169.254.169.254/latest/meta-data/" } }),
    ));
    await expect(
      downloadAndUnpackSkill("https://acct.agentrun-data.cn-hangzhou.aliyuncs.com/tools/x/download", dir, CREDS),
    ).rejects.toThrow(/blocked.*address/i);
  });

  it("rejects after too many redirects", async () => {
    dir = await mkdtemp(join(tmpdir(), "skill-dl-"));
    __setSsrfLookupForTest(async () => [{ address: "203.0.113.7" }]);
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () =>
      resp(302, { headers: { location: `https://h.aliyuncs.com/${n++}` } }),
    ));
    await expect(
      downloadAndUnpackSkill("https://acct.agentrun-data.cn-hangzhou.aliyuncs.com/tools/x/download", dir, CREDS),
    ).rejects.toThrow(/too many redirects/);
  });

  it("rejects path-traversal entries (no files written)", async () => {
    dir = await mkdtemp(join(tmpdir(), "skill-dl-"));
    const zip = makeZip("../evil.txt", "pwned", 0);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => toArrayBuffer(zip) }) as unknown as Response));
    await expect(
      downloadAndUnpackSkill("https://acct.agentrun-data.cn-hangzhou.aliyuncs.com/tools/x/download", dir, CREDS),
    ).rejects.toThrow(/no files/);
  });

  it("rejects download when Content-Length exceeds cap (H3)", async () => {
    dir = await mkdtemp(join(tmpdir(), "skill-dl-"));
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      headers: { get: (k: string) => (k === "content-length" ? String(128 * 1024 * 1024) : null) },
      arrayBuffer: async () => new ArrayBuffer(0),
    }) as unknown as Response));
    await expect(
      downloadAndUnpackSkill("https://acct.agentrun-data.cn-hangzhou.aliyuncs.com/tools/x/download", dir, CREDS),
    ).rejects.toThrow(/too large/);
  });

  it("error message never includes the signed URL query (H3)", async () => {
    dir = await mkdtemp(join(tmpdir(), "skill-dl-"));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, text: async () => "x" }) as unknown as Response));
    const err = await downloadAndUnpackSkill("https://acct.agentrun-data.cn-hangzhou.aliyuncs.com/tools/x/download", dir, CREDS).catch((e) => e as Error);
    // 只含 host+pathname（host 经 RAM 重写为 -ram），不含 query（签名/凭证在 query 里）。
    expect(err.message).toContain("/tools/x/download");
    expect(err.message).not.toContain("?");
    expect(err.message).not.toMatch(/Signature|Authorization|x-acs|Expires/i);
  });

  it("skips a zip entry whose decompressed size exceeds the per-entry cap (zip bomb, H3)", () => {
    // 高压缩比 entry：解压后 ~16MB（> 4MB 单 entry 上限）→ 被跳过，不抛、不 OOM。
    const bomb = makeZip("bomb.bin", "A".repeat(16 * 1024 * 1024), 8);
    const small = makeZip("ok.txt", "hi", 8);
    // 两个 zip 各是独立 zip，这里单测 unzipBuffer 对单 bomb 的处理：超限 entry 被跳过 → 返回空。
    expect(unzipBuffer(bomb)).toEqual([]);
    expect(unzipBuffer(small)).toHaveLength(1);
  });

  // ── 分支补全 ──
  it("真实 Response（含 body 流）→ 走流式读取分支并解包", async () => {
    dir = await mkdtemp(join(tmpdir(), "skill-dl-"));
    const zip = makeZip("SKILL.md", "---\nname: x\n---\nbody", 0);
    // 真实 Response 带 ReadableStream body → readBodyCapped 走 reader 流式分支（而非 arrayBuffer）。
    vi.stubGlobal("fetch", vi.fn(async () => new Response(toArrayBuffer(zip), { status: 200 })));
    await downloadAndUnpackSkill("https://acct.agentrun-data.cn-hangzhou.aliyuncs.com/tools/x/download", dir, CREDS);
    expect(await readFile(join(dir, "SKILL.md"), "utf8")).toContain("name: x");
  });

  it("3xx 无 Location 头 → 不跟随，按 !res.ok 报错", async () => {
    dir = await mkdtemp(join(tmpdir(), "skill-dl-"));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 302, headers: { get: () => null }, text: async () => "" }) as unknown as Response));
    await expect(
      downloadAndUnpackSkill("https://acct.agentrun-data.cn-hangzhou.aliyuncs.com/tools/x/download", dir, CREDS),
    ).rejects.toThrow(/HTTP 302/);
  });

  it("fetch cause 无 code / 非 Error 抛出 → message 仍含 cause（139/144 分支）", async () => {
    dir = await mkdtemp(join(tmpdir(), "skill-dl-"));
    const errNoCode = Object.assign(new TypeError("fetch failed"), { cause: new Error("dns boom") }); // cause 无 code
    vi.stubGlobal("fetch", vi.fn(async () => { throw errNoCode; }));
    let e = await downloadAndUnpackSkill("https://acct.agentrun-data.cn-hangzhou.aliyuncs.com/tools/x/download", dir, CREDS).catch((x) => x as Error);
    expect(e.message).toContain("dns boom");
    expect(e.message).not.toContain("(undefined)");

    vi.stubGlobal("fetch", vi.fn(async () => { throw "plain-string-throw"; })); // 非 Error
    e = await downloadAndUnpackSkill("https://acct.agentrun-data.cn-hangzhou.aliyuncs.com/tools/x/download", dir, CREDS).catch((x) => x as Error);
    expect(e.message).toContain("plain-string-throw");
  });

  it("zip 含目录条目（名以 / 结尾）→ safeRelPath 跳过、不写文件", async () => {
    const dirEntry = makeZip("subdir/", "", 0);     // 目录条目
    const fileEntry = makeZip("a.txt", "hi", 0);
    // unzipBuffer 仍解出条目，但下载流程经 safeRelPath 跳过目录条目（仅校验解包行为，目录条目 name 以 / 结尾）。
    expect(unzipBuffer(dirEntry)[0].name).toBe("subdir/");
    expect(unzipBuffer(fileEntry)).toHaveLength(1);
  });

  // ── GitHub 归档型嵌套：全部文件包在唯一顶层目录下（如 repo-main/SKILL.md），
  //    须剥离该前缀使 SKILL.md 落在 destDir 根（否则 normalizeSkillName / get_skill /
  //    codex 渐进发现都按 join(dir,"SKILL.md") 读取 → 必然 miss、skill 正文丢失）。
  //    对齐 super_agent fix/skill-md-zip-lookup（findSkillRoot）。
  it("剥离 GitHub 归档的唯一顶层目录前缀，SKILL.md 落在根目录", async () => {
    dir = await mkdtemp(join(tmpdir(), "skill-dl-"));
    const zip = makeMultiZip([
      { name: "skill-repo-main/LICENSE", content: "MIT" },
      { name: "skill-repo-main/SKILL.md", content: "---\nname: x\n---\nreal body" },
      { name: "skill-repo-main/scripts/run.sh", content: "echo hi" },
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => toArrayBuffer(zip) }) as unknown as Response));
    await downloadAndUnpackSkill("https://acct.agentrun-data.cn-hangzhou.aliyuncs.com/tools/x/download", dir, CREDS);

    // SKILL.md 与其它文件都被重定根到 destDir，顶层目录前缀消失。
    expect(await readFile(join(dir, "SKILL.md"), "utf8")).toContain("real body");
    expect(await readFile(join(dir, "LICENSE"), "utf8")).toBe("MIT");
    expect(await readFile(join(dir, "scripts", "run.sh"), "utf8")).toBe("echo hi");
    await expect(readFile(join(dir, "skill-repo-main", "SKILL.md"), "utf8")).rejects.toThrow();
  });

  it("SKILL.md 已在根（同时有子目录）→ 不误剥离任何前缀", async () => {
    dir = await mkdtemp(join(tmpdir(), "skill-dl-"));
    const zip = makeMultiZip([
      { name: "SKILL.md", content: "root skill" },
      { name: "scripts/run.sh", content: "echo hi" },
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => toArrayBuffer(zip) }) as unknown as Response));
    await downloadAndUnpackSkill("https://acct.agentrun-data.cn-hangzhou.aliyuncs.com/tools/x/download", dir, CREDS);

    expect(await readFile(join(dir, "SKILL.md"), "utf8")).toBe("root skill");
    expect(await readFile(join(dir, "scripts", "run.sh"), "utf8")).toBe("echo hi");
  });

  it("多个顶层目录（根无 SKILL.md）→ 无法确定根，保持原样不剥离", async () => {
    dir = await mkdtemp(join(tmpdir(), "skill-dl-"));
    const zip = makeMultiZip([
      { name: "a/SKILL.md", content: "a body" },
      { name: "b/other.txt", content: "b" },
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => toArrayBuffer(zip) }) as unknown as Response));
    await downloadAndUnpackSkill("https://acct.agentrun-data.cn-hangzhou.aliyuncs.com/tools/x/download", dir, CREDS);

    // 顶层目录不唯一 → 不剥离，保持嵌套（与 super_agent findSkillRoot 返回 undefined 一致）。
    expect(await readFile(join(dir, "a", "SKILL.md"), "utf8")).toBe("a body");
    expect(await readFile(join(dir, "b", "other.txt"), "utf8")).toBe("b");
  });
});

// 沙箱内下载链路（Change B / option b）：把 RAM 签名头交给沙箱内 curl 直发，二进制按字节落盘。
describe("buildSandboxSkillDownloadScript —— 沙箱内 skill 下载脚本（option b）", () => {
  const HEADERS = {
    host: "acct-ram.funagent-data-pre.cn-hangzhou.aliyuncs.com",
    "x-acs-date": "2026-06-24T00:00:00Z",
    "x-acs-content-sha256": "UNSIGNED-PAYLOAD",
    "Agentrun-Authorization": "AGENTRUN4-HMAC-SHA256 Credential=ak/.../aliyun_v4_request,SignedHeaders=host;x-acs-content-sha256;x-acs-date,Signature=deadbeef",
  };
  const SCRIPT = buildSandboxSkillDownloadScript({
    signedUrl: "https://acct-ram.funagent-data-pre.cn-hangzhou.aliyuncs.com/skills/travel/download",
    headers: HEADERS,
    skillDir: "/workspace/.agents/skills/travel",
    tmpZip: "/tmp/runloop-skill-travel.zip",
  });

  it("curl 跟随重定向（-L）并带 RAM 签名头；Host 不作为 -H（交 curl 按 URL 派生，避免串到 OSS）", () => {
    expect(SCRIPT).toMatch(/curl[^\n]*-fsSL/); // 静默 + 失败非零退出 + 跟随重定向
    expect(SCRIPT).toContain("-H 'Agentrun-Authorization: AGENTRUN4-HMAC-SHA256");
    expect(SCRIPT).toContain("-H 'x-acs-date: 2026-06-24T00:00:00Z'");
    expect(SCRIPT).toContain("-H 'x-acs-content-sha256: UNSIGNED-PAYLOAD'");
    // host 头不透传：curl 自行按 URL（含 302→OSS 的跳转）设 Host，签名 host 不会串到 OSS。
    expect(SCRIPT).not.toMatch(/-H '[Hh]ost:/);
  });

  it("下载到临时 zip → python3 解包（reroot）到 skillDir → 清理临时 zip；路径单引号防注入", () => {
    expect(SCRIPT).toContain("mkdir -p '/workspace/.agents/skills/travel'");
    expect(SCRIPT).toContain("-o '/tmp/runloop-skill-travel.zip'");
    expect(SCRIPT).toContain("'https://acct-ram.funagent-data-pre.cn-hangzhou.aliyuncs.com/skills/travel/download'");
    expect(SCRIPT).toContain("python3");
    expect(SCRIPT).toContain("zipfile");
    expect(SCRIPT).toContain("SKILL.md"); // reroot 判定锚点（L-048）
    expect(SCRIPT).toContain("rm -f '/tmp/runloop-skill-travel.zip'");
    expect(SCRIPT).toContain("set -e");
  });

  it("含特殊字符的目录被单引号转义（shell 注入防护）", () => {
    const s = buildSandboxSkillDownloadScript({
      signedUrl: "https://acct-ram.funagent-data-pre.cn-hangzhou.aliyuncs.com/skills/x/download",
      headers: { "Agentrun-Authorization": "sig" },
      skillDir: "/w/.agents/skills/a'b",
      tmpZip: "/tmp/a.zip",
    });
    expect(s).toContain("'/w/.agents/skills/a'\\''b'"); // 单引号转义为 '\''
  });
});
