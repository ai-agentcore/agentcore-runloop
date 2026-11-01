// 执行/文件工具的后端抽象。
//
// 默认（用户实例）：无 ExecBackend 注入 → handleToolCall 走本地 executeShell / executeFileTool（本地 fs）。
// 系统实例（AGENTCORE_REMOTE_SHELL + 传入 Sandbox）：注入 RemoteSandboxBackend → bash/文件工具一律打到
// AgentRun 隔离沙箱数据面（runloop 进程不落地执行、密钥不外泄）。工具名/契约对模型完全无感。

import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep, isAbsolute } from "node:path";
import type { Credentials, Resource } from "../types/resources.js";
import type { McpToolResult } from "../mcp/types.js";
import type { SandboxProvisioner } from "./sandbox-provisioner.js";
import { RemoteSandboxBridge, resolveSandboxOps, type RemoteSandboxTarget } from "./remote-sandbox.js";
import { deriveAgentRunEndpoints } from "./agentrun-client.js";
import type { ResourceCallLogger } from "./resource-log.js";
import { SHELL_TOOL_NAME } from "./shell-exec.js";
import { isFileTool, globToRegExp } from "./file-tools.js";
import { buildSandboxSkillDownloadScript } from "./skill-download.js";
import { buildSignedRequest } from "./agentrun-sign.js";
import { assertAgentrunHostAllowed } from "./ssrf.js";
import { deriveSkillDownloadUrl } from "../mcp/openapi.js";
import { toSkillName } from "./workspace.js";

/** bash / 文件工具的执行后端。返回 null 表示「非本后端负责的工具名」，调用方继续走其它分发。 */
export interface ExecBackend {
  shell(command: string): Promise<McpToolResult>;
  file(name: string, args: Record<string, unknown>): Promise<McpToolResult | null>;
  /** Best-effort interruption of the currently running remote command. */
  interrupt?(): Promise<void>;
}

const ok = (obj: unknown): McpToolResult => ({ content: [{ type: "text", text: JSON.stringify(obj) }], isError: false });
const fail = (msg: string): McpToolResult => ({ content: [{ type: "text", text: JSON.stringify({ error: msg }) }], isError: true });

// 远端 grep/glob 上限（与本地 file-tools 对齐，防大仓库把整棵树拉回本地撑爆内存/上下文，H7）。
const MAX_MATCHES = 200;       // 返回给模型的结果上限
const GREP_LINE_CAP = 2000;    // grep 原始行 head 封顶（远端 executeCommand 无 64KB 截断）
const FIND_FILE_CAP = 20_000;  // find 扫描文件数 head 封顶（regex 过滤前）

/** 单引号安全包裹（防 shell 注入/转义）：`'` → `'\''`。 */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 取 URL 的 origin（scheme://host）；解析失败原样返回。 */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * 远端沙箱后端：把 runloop 的执行/文件工具映射到 AgentRun 沙箱数据面。
 * - bash → executeCommand
 * - read_file / write_file / edit_file → 数据面 vfs（edit_file = 读+替换+写）
 * - grep / glob → 经沙箱 shell（grep -rn / find）实现，保持与本地后端一致的工具面
 *
 * target 懒解析（SANDBOX_TEMPLATE 首用时经 provisioner 懒创建实例）。
 */
export class RemoteSandboxBackend implements ExecBackend {
  private bridge?: RemoteSandboxBridge;
  private resolving?: Promise<RemoteSandboxBridge>;

  constructor(
    private readonly sandbox: Resource,
    private readonly credentials: Credentials | undefined,
    private readonly provisioner?: SandboxProvisioner,
    /** 沙箱内运行目录（remote cwd / 相对文件路径基址 / skill 同步根）；复用 request.agent.cwd，缺省=沙箱默认目录。 */
    private readonly cwd?: string,
    /** 资源调用日志器（透传给 bridge，记录沙箱数据面 请求/响应）。 */
    private readonly log?: ResourceCallLogger,
  ) {}

  /** 相对路径锚到 remote cwd；绝对路径原样（沙箱内路径语义）。 */
  private resolveRemotePath(p: string): string {
    if (!this.cwd || isAbsolute(p)) return p;
    return `${this.cwd.replace(/\/$/, "")}/${p}`;
  }

  private async getBridge(): Promise<RemoteSandboxBridge> {
    if (this.bridge) return this.bridge;
    if (!this.resolving) this.resolving = this.resolveBridge();
    this.bridge = await this.resolving;
    return this.bridge;
  }

  private async resolveBridge(): Promise<RemoteSandboxBridge> {
    if (!this.credentials) throw new Error("远端沙箱执行需要 credentials");
    const target = await this.resolveTarget();
    // 数据面 operation 从沙箱 openapiConfig 解析（spec 有就用 spec 的 {method,path}，无则回退默认）。
    const ops = resolveSandboxOps(this.sandbox.openapiConfig as Record<string, unknown> | undefined);
    this.log?.info("remote sandbox target resolved", { dataBase: target.dataBase, sandboxId: target.sandboxId });
    return new RemoteSandboxBridge(target, this.credentials, this.log, ops);
  }

  private async resolveTarget(): Promise<RemoteSandboxTarget> {
    // SANDBOX_TEMPLATE：经 provisioner 懒创建实例，拿 {sandboxId, endpoint}。
    if (this.sandbox.resourceType === "SANDBOX_TEMPLATE") {
      if (!this.provisioner) throw new Error("SANDBOX_TEMPLATE 远端执行需要 sandboxProvisioner");
      const inst = await this.provisioner.ensureInstance(this.sandbox, this.credentials);
      if (!inst) throw new Error("SANDBOX_TEMPLATE 懒创建未返回实例");
      return { dataBase: originOf(inst.endpoint), sandboxId: inst.sandboxId };
    }
    // SANDBOX（运行中实例）：sandboxId = resourceId；数据面基址取 openapiConfig server 或据凭证推导。
    const servers = (this.sandbox.openapiConfig?.servers as Array<{ url?: string }> | undefined) ?? [];
    const serverUrl = servers[0]?.url;
    const dataBase = serverUrl
      ? originOf(serverUrl)
      : this.credentials?.accountId
        ? deriveAgentRunEndpoints(this.credentials.accountId, this.credentials.region ?? "cn-hangzhou").dataEndpoint
        : undefined;
    if (!dataBase) throw new Error("无法推导沙箱数据面 endpoint（openapiConfig.servers 与 credentials.accountId 均缺）");
    return { dataBase, sandboxId: this.sandbox.resourceId };
  }

  async shell(command: string): Promise<McpToolResult> {
    if (!command.trim()) return fail("command is required");
    try {
      const bridge = await this.getBridge();
      const r = await bridge.executeCommand(command, { cwd: this.cwd });
      return ok({ stdout: r.stdout, stderr: r.stderr, exit_code: r.exitCode });
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * 会话级环境初始化（best-effort）：把本地 workspace 下已下载解包的 skill 同步进沙箱
   * （`<localWorkspaceDir>/.agents/skills/**` → remote `<cwd>/.agents/skills/**`），
   * 使沙箱内的 read_file/bash 能读取并执行 skill。失败不阻断 run（仅警告）。返回同步的文件数。
   */
  async initEnvironment(opts: { localWorkspaceDir: string }): Promise<number> {
    const skillsRoot = join(opts.localWorkspaceDir, ".agents", "skills");
    let files: string[];
    try {
      files = await walkLocalFiles(skillsRoot);
    } catch {
      return 0; // 无 skill 目录 → 无需同步
    }
    const bridge = await this.getBridge();
    const remotePaths = files.map((abs) => this.resolveRemotePath(relative(opts.localWorkspaceDir, abs).split(sep).join("/")));
    // 先并发 mkdir 各文件的父目录：writeFile 的 createDir:true 在多级子目录下不可靠（super_agent ee341da
    // 实测同一标志位），不先建父目录会让 skill 正文静默写不进沙箱（L9）。失败仅忽略（best-effort，
    // writeFile 仍会再尝试 createDir）。
    const parents = new Set<string>();
    for (const remote of remotePaths) {
      const slash = remote.lastIndexOf("/");
      if (slash > 0) parents.add(remote.slice(0, slash));
    }
    await Promise.all([...parents].map((d) => bridge.mkdir(d).catch(() => { /* best-effort */ })));
    let synced = 0;
    for (let i = 0; i < files.length; i++) {
      const content = await readFile(files[i], "utf8");
      await bridge.writeFile(remotePaths[i], content);
      synced++;
    }
    return synced;
  }

  /**
   * Change B（option b，**默认链路**）：在沙箱内直接下载并解包每个 skill 到 remote cwd 下的
   * `.agents/skills/<slug>/`，使沙箱内 read_file/bash 能读取/运行 skill（含二进制，按字节落盘）。
   * 相对旧 `initEnvironment`（本地解包 → 数据面 text-only writeFile 同步，损坏二进制）：
   * 这里把 RAM 签名头交给沙箱内 curl 直发，二进制安全；且「有沙箱不落本地盘」（runner 跳过本地 writeSkillFiles）。
   * best-effort：单个 skill 失败（缺 url / 非法 host / 脚本非零退出 / 异常）仅警告、不阻断 run。返回成功数。
   */
  async downloadSkillsIntoSandbox(skills: Resource[]): Promise<number> {
    if (!skills || skills.length === 0) return 0;
    if (!this.credentials) throw new Error("沙箱内 skill 下载需要 credentials");
    const bridge = await this.getBridge();
    let synced = 0;
    for (const skill of skills) {
      const slug = toSkillName(skill.resourceName);
      const downloadUrl = deriveSkillDownloadUrl(skill);
      if (!downloadUrl) {
        this.log?.warn("skill 缺 downloadUrl，跳过沙箱下载", { name: slug });
        continue;
      }
      try {
        assertAgentrunHostAllowed(downloadUrl); // 纵深：拒绝把非 agentrun URL 注入沙箱命令
        const signed = buildSignedRequest("GET", downloadUrl, "", this.credentials);
        const script = buildSandboxSkillDownloadScript({
          signedUrl: signed.url,
          headers: signed.headers,
          skillDir: this.resolveRemotePath(`.agents/skills/${slug}`),
          tmpZip: `/tmp/runloop-skill-${slug}.zip`,
        });
        const r = await bridge.executeCommand(script, { cwd: this.cwd });
        if (r.exitCode !== 0) {
          this.log?.warn("沙箱内 skill 下载失败（非致命）", { name: slug, exitCode: r.exitCode, stderr: r.stderr.slice(0, 500) });
          continue;
        }
        synced++;
      } catch (e) {
        this.log?.warn("沙箱内 skill 下载异常（非致命）", { name: slug, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return synced;
  }

  async file(name: string, args: Record<string, unknown>): Promise<McpToolResult | null> {
    if (name !== SHELL_TOOL_NAME && !isFileTool(name)) return null;
    try {
      const bridge = await this.getBridge();
      switch (name) {
        case "read_file": {
          const fp = String(args.file_path ?? "");
          if (!fp) return fail("file_path is required");
          let text = await bridge.readFile(this.resolveRemotePath(fp));
          if (args.offset !== undefined || args.limit !== undefined) {
            const lines = text.split("\n");
            const start = Math.max(0, (Number(args.offset ?? 1) || 1) - 1);
            const end = args.limit !== undefined ? start + Number(args.limit) : lines.length;
            text = lines.slice(start, end).join("\n");
          }
          return ok({ content: text });
        }
        case "write_file": {
          const fp = String(args.file_path ?? "");
          if (!fp) return fail("file_path is required");
          await bridge.writeFile(this.resolveRemotePath(fp), String(args.content ?? ""));
          return ok({ ok: true, file_path: fp });
        }
        case "edit_file": {
          const fp = String(args.file_path ?? "");
          if (!fp) return fail("file_path is required");
          const oldStr = String(args.old_string ?? "");
          const newStr = String(args.new_string ?? "");
          if (!oldStr) return fail("old_string is required");
          const remoteFp = this.resolveRemotePath(fp);
          const text = await bridge.readFile(remoteFp);
          const count = text.split(oldStr).length - 1;
          if (count === 0) return fail("old_string not found in file");
          if (count > 1 && !args.replace_all) return fail(`old_string is not unique (${count} matches); pass replace_all=true or give more context`);
          const next = args.replace_all ? text.split(oldStr).join(newStr) : text.replace(oldStr, newStr);
          await bridge.writeFile(remoteFp, next);
          return ok({ ok: true, replaced: args.replace_all ? count : 1 });
        }
        case "grep": {
          const pattern = String(args.pattern ?? "");
          if (!pattern) return fail("pattern is required");
          // 路径经 resolveRemotePath 锚定，与 read/write/edit 一致（H8）；排除 .git/node_modules
          // 并 head 封顶原始行（远端 executeCommand 无 64KB 截断，防大仓库撑爆内存/上下文，H7）。
          const root = this.resolveRemotePath(String(args.path ?? "."));
          const flags = args.ignore_case ? "-rnEi" : "-rnE";
          // grep 失败（含无匹配 exit=1）不视为错误：无匹配返回空。cwd 经 executeCommand 锚定。
          const cmd = `grep ${flags} --exclude-dir=.git --exclude-dir=node_modules -- ${shQuote(pattern)} ${shQuote(root)} 2>/dev/null | head -n ${GREP_LINE_CAP} || true`;
          const r = await bridge.executeCommand(cmd, { cwd: this.cwd });
          const all = r.stdout.split("\n").filter(Boolean);
          const matches = all.slice(0, MAX_MATCHES);
          return ok({ matches, count: matches.length, truncated: all.length > MAX_MATCHES });
        }
        case "glob": {
          const pattern = String(args.pattern ?? "");
          if (!pattern) return fail("pattern is required");
          const root = this.resolveRemotePath(String(args.path ?? "."));
          const re = globToRegExp(pattern);
          // 排除 .git/node_modules + head 封顶扫描文件数（H7）；root 与 read/write 锚定一致（H8）。
          const cmd = `find ${shQuote(root)} -type f -not -path '*/.git/*' -not -path '*/node_modules/*' 2>/dev/null | head -n ${FIND_FILE_CAP} || true`;
          const r = await bridge.executeCommand(cmd, { cwd: this.cwd });
          const files = r.stdout
            .split("\n")
            .filter(Boolean)
            .map((f) => (f.startsWith(root + "/") ? f.slice(root.length + 1) : f))
            .filter((f) => re.test(f))
            .slice(0, MAX_MATCHES);
          return ok({ files, count: files.length });
        }
        default:
          return fail(`unknown file tool: ${name}`);
      }
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }
}

/** 递归收集目录下所有文件的绝对路径（root 不存在时抛错，由调用方兜底）。 */
async function walkLocalFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [root];
  // 首次 readdir 失败（目录不存在）→ 让异常冒泡给调用方（视为"无需同步"）。
  let first = true;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (first) throw e;
      continue;
    }
    first = false;
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) out.push(full);
    }
  }
  return out;
}
