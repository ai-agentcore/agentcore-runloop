import { createHash } from "node:crypto";
import { posix } from "node:path";
import { CommandExitError, FileType, Sandbox, type CommandHandle, type EntryInfo } from "e2b";
import type { SandboxConfig } from "../config.js";
import type { McpToolResult } from "../../vendor/runloop/src/mcp/types.js";
import type { ExecBackend } from "../../vendor/runloop/src/sidecar/exec-backend.js";
import { SHELL_TOOL_NAME } from "../../vendor/runloop/src/sidecar/shell-exec.js";
import { globToRegExp, isFileTool } from "../../vendor/runloop/src/sidecar/file-tools.js";
import type {
  SandboxFileInfo,
  SandboxHandle,
  SandboxProvider,
  SandboxWorkspace,
  SandboxWriteEntry,
} from "./manager.js";
import type { SandboxVolumeMetadataResolver } from "./volume-resolver.js";

const MAX_MATCHES = 200;
const GREP_LINE_CAP = 2000;
const FIND_FILE_CAP = 20_000;
const SAFE_DIAGNOSTIC_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;

interface SandboxSdkDiagnostics {
  code: string;
  status?: number;
  requestId?: string;
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_DIAGNOSTIC_IDENTIFIER.test(value) ? value : undefined;
}

function sandboxSdkPayload(message: string): Record<string, unknown> | undefined {
  const body = message.replace(/^\s*[1-5]\d\d\s*:\s*/, "");
  if (!body.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function classifiedSandboxCode(error: unknown, message: string, payload?: Record<string, unknown>): string {
  const upstreamCode = safeIdentifier(payload?.code);
  if (upstreamCode) return upstreamCode;
  if (/executionRoleArn/i.test(message)) return "EXECUTION_ROLE_REQUIRED";
  if (/\bvolume\b/i.test(message) && /\bteam\b/i.test(message)) return "VOLUME_TEAM_MISMATCH";
  if (/\bvpc\b|vSwitch|securityGroup/i.test(message)) return "VPC_CONFIGURATION_INVALID";
  if (/\bvolume\b/i.test(message)) return "VOLUME_MOUNT_FAILED";
  if (/\btemplate\b/i.test(message)) return "TEMPLATE_ERROR";
  if (/\bquota\b|rate limit/i.test(message)) return "RATE_LIMITED";
  if (error instanceof Error && error.name === "AuthenticationError") return "AUTHENTICATION_FAILED";
  if (error instanceof Error && error.name === "TimeoutError") return "TIMEOUT";
  return "SANDBOX_CREATE_FAILED";
}

function sandboxSdkDiagnostics(error: unknown): SandboxSdkDiagnostics {
  const message = error instanceof Error ? error.message : "";
  const payload = sandboxSdkPayload(message);
  const statusMatch = /^\s*([1-5]\d\d)\s*:/.exec(message);
  const requestId = safeIdentifier(payload?.requestId ?? payload?.request_id);
  return {
    code: classifiedSandboxCode(error, message, payload),
    ...(statusMatch ? { status: Number(statusMatch[1]) } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

class SafeSandboxSdkError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly requestId?: string;

  constructor(source: unknown) {
    super("Agent Sandbox creation failed", { cause: source });
    this.name = source instanceof Error && safeIdentifier(source.name) ? source.name : "SandboxError";
    const diagnostics = sandboxSdkDiagnostics(source);
    this.code = diagnostics.code;
    this.status = diagnostics.status;
    this.requestId = diagnostics.requestId;
  }
}

const ok = (value: unknown): McpToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }], isError: false,
});
const fail = (message: string): McpToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true,
});

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function entryInfo(entry: EntryInfo): SandboxFileInfo {
  const type = entry.symlinkTarget ? "symlink" : entry.type === FileType.DIR ? "dir" : "file";
  return { type, size: entry.size, ...(entry.symlinkTarget ? { symlinkTarget: entry.symlinkTarget } : {}) };
}

class AgentSandboxHandle implements SandboxHandle {
  constructor(readonly sandbox: Sandbox) {}
  get id(): string { return this.sandbox.sandboxId; }
  isRunning(): Promise<boolean> { return this.sandbox.isRunning(); }
  setTimeout(timeoutMs: number): Promise<void> { return this.sandbox.setTimeout(timeoutMs); }
  async kill(): Promise<void> { await this.sandbox.kill(); }
}

class AgentSandboxExecBackend implements ExecBackend {
  private activeCommand?: CommandHandle;

  constructor(
    private readonly sandbox: Sandbox,
    private readonly cwd: string,
    private readonly commandTimeoutMs: number,
  ) {}

  private resolvePath(path: string): string {
    const target = posix.resolve(this.cwd, path || ".");
    if (target !== this.cwd && !target.startsWith(`${this.cwd}/`)) throw new Error("path escapes the sandbox workspace");
    return target;
  }

  async shell(command: string): Promise<McpToolResult> {
    try {
      const handle = await this.sandbox.commands.run(command, {
        background: true,
        cwd: this.cwd,
        timeoutMs: this.commandTimeoutMs,
      });
      this.activeCommand = handle;
      try {
        const result = await handle.wait();
        return ok({ exit_code: result.exitCode, stdout: result.stdout, stderr: result.stderr });
      } finally {
        if (this.activeCommand === handle) this.activeCommand = undefined;
      }
    } catch (error) {
      if (error instanceof CommandExitError) {
        return ok({ exit_code: error.exitCode, stdout: error.stdout, stderr: error.stderr });
      }
      return fail("sandbox command failed");
    }
  }

  async interrupt(): Promise<void> {
    const current = this.activeCommand;
    if (!current) return;
    await current.kill().catch(() => false);
  }

  async file(name: string, args: Record<string, unknown>): Promise<McpToolResult | null> {
    if (name !== SHELL_TOOL_NAME && !isFileTool(name)) return null;
    try {
      switch (name) {
        case "read_file": {
          const path = this.resolvePath(String(args.file_path ?? ""));
          if (!args.file_path) return fail("file_path is required");
          let text = await this.sandbox.files.read(path);
          if (args.offset !== undefined || args.limit !== undefined) {
            const lines = text.split("\n");
            const start = Math.max(0, (Number(args.offset ?? 1) || 1) - 1);
            const end = args.limit === undefined ? lines.length : start + Number(args.limit);
            text = lines.slice(start, end).join("\n");
          }
          return ok({ content: text });
        }
        case "write_file": {
          if (!args.file_path) return fail("file_path is required");
          const path = this.resolvePath(String(args.file_path));
          await this.sandbox.files.write(path, String(args.content ?? ""));
          return ok({ ok: true, file_path: args.file_path });
        }
        case "edit_file": {
          if (!args.file_path) return fail("file_path is required");
          const oldString = String(args.old_string ?? "");
          if (!oldString) return fail("old_string is required");
          const path = this.resolvePath(String(args.file_path));
          const text = await this.sandbox.files.read(path);
          const count = text.split(oldString).length - 1;
          if (count === 0) return fail("old_string not found in file");
          if (count > 1 && !args.replace_all) return fail(`old_string is not unique (${count} matches); pass replace_all=true or give more context`);
          const replacement = String(args.new_string ?? "");
          const next = args.replace_all ? text.split(oldString).join(replacement) : text.replace(oldString, replacement);
          await this.sandbox.files.write(path, next);
          return ok({ ok: true, replaced: args.replace_all ? count : 1 });
        }
        case "grep": {
          const pattern = String(args.pattern ?? "");
          if (!pattern) return fail("pattern is required");
          const root = this.resolvePath(String(args.path ?? "."));
          const flags = args.ignore_case ? "-rnEi" : "-rnE";
          const command = `grep ${flags} --exclude-dir=.git --exclude-dir=node_modules -- ${quote(pattern)} ${quote(root)} 2>/dev/null | head -n ${GREP_LINE_CAP} || true`;
          const result = await this.sandbox.commands.run(command, { cwd: this.cwd, timeoutMs: this.commandTimeoutMs });
          const all = result.stdout.split("\n").filter(Boolean);
          const matches = all.slice(0, MAX_MATCHES);
          return ok({ matches, count: matches.length, truncated: all.length > MAX_MATCHES });
        }
        case "glob": {
          const pattern = String(args.pattern ?? "");
          if (!pattern) return fail("pattern is required");
          const root = this.resolvePath(String(args.path ?? "."));
          const command = `find ${quote(root)} -type f -not -path '*/.git/*' -not -path '*/node_modules/*' 2>/dev/null | head -n ${FIND_FILE_CAP} || true`;
          const result = await this.sandbox.commands.run(command, { cwd: this.cwd, timeoutMs: this.commandTimeoutMs });
          const expression = globToRegExp(pattern);
          const files = result.stdout.split("\n").filter(Boolean)
            .map(file => file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file)
            .filter(file => expression.test(file)).slice(0, MAX_MATCHES);
          return ok({ files, count: files.length });
        }
        default:
          return fail(`unknown file tool: ${name}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message === "path escapes the sandbox workspace") return fail(error.message);
      return fail("sandbox file operation failed");
    }
  }
}

class AgentSandboxWorkspace implements SandboxWorkspace {
  readonly execBackend: AgentSandboxExecBackend;

  constructor(
    private readonly sandbox: Sandbox,
    readonly root: string,
    commandTimeoutMs: number,
  ) {
    this.execBackend = new AgentSandboxExecBackend(sandbox, root, commandTimeoutMs);
  }

  private resolve(path: string): string {
    const target = posix.resolve(this.root, path || ".");
    if (target !== this.root && !target.startsWith(`${this.root}/`)) throw new Error("path escapes the sandbox workspace");
    return target;
  }

  private async assertSafeDirectory(path: string): Promise<void> {
    const info = await this.sandbox.files.getInfo(path);
    if (info.type !== FileType.DIR || info.symlinkTarget) throw new Error("unsafe sandbox workspace");
  }

  private segments(path: string): string[] {
    const relative = posix.relative(this.root, path);
    return relative ? relative.split("/") : [];
  }

  async ensureReady(): Promise<void> {
    await this.ensureDirectory(this.root);
  }

  async ensureDirectory(path: string): Promise<void> {
    const target = this.resolve(path);
    await this.sandbox.files.makeDir(this.root);
    await this.assertSafeDirectory(this.root);
    let current = this.root;
    for (const segment of this.segments(target)) {
      current = posix.join(current, segment);
      if (!await this.sandbox.files.exists(current)) await this.sandbox.files.makeDir(current);
      await this.assertSafeDirectory(current);
    }
  }

  exists(path: string): Promise<boolean> {
    return this.sandbox.files.exists(this.resolve(path));
  }

  async writeFile(path: string, content: string | Uint8Array | ReadableStream<Uint8Array>): Promise<void> {
    const data = content instanceof Uint8Array ? Uint8Array.from(content).buffer : content;
    await this.sandbox.files.write(this.resolve(path), data);
  }

  async writeFiles(entries: SandboxWriteEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const files = entries.map(entry => ({
      path: this.resolve(entry.path),
      data: entry.content instanceof Uint8Array ? Uint8Array.from(entry.content).buffer : entry.content,
    }));
    await this.sandbox.files.write(files);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const target = this.resolve(path);
    await this.assertSafeDirectory(this.root);
    let current = this.root;
    const segments = this.segments(target);
    for (const segment of segments.slice(0, -1)) {
      current = posix.join(current, segment);
      await this.assertSafeDirectory(current);
    }
    const info = await this.sandbox.files.getInfo(target);
    if (info.type !== FileType.FILE || info.symlinkTarget) throw new Error("unsafe sandbox file");
    return this.sandbox.files.read(target, { format: "bytes" });
  }

  async getInfo(path: string): Promise<SandboxFileInfo> {
    return entryInfo(await this.sandbox.files.getInfo(this.resolve(path)));
  }

  remove(path: string): Promise<void> {
    return this.sandbox.files.remove(this.resolve(path));
  }
}

export class AgentSandboxProvider implements SandboxProvider {
  constructor(
    private readonly config: SandboxConfig,
    private readonly credential: (name: string) => Promise<string>,
    private readonly volumeResolver?: SandboxVolumeMetadataResolver,
  ) {}

  private async connection() {
    return {
      apiKey: this.config.apiKey ?? await this.credential(this.config.credential),
      apiUrl: this.config.apiUrl,
      domain: this.config.domain,
      requestTimeoutMs: this.config.requestTimeoutMs,
    };
  }

  private volumeMounts(): Record<string, string> | undefined {
    if (!this.config.volumeName || !this.config.volumeMountPath) return undefined;
    return { [this.config.volumeMountPath]: this.config.volumeName };
  }

  async create(tenantKey: string, conversationId: string): Promise<SandboxHandle> {
    const tenant = createHash("sha256").update(tenantKey).digest("hex");
    const conversation = createHash("sha256").update(conversationId).digest("hex");
    const connection = await this.connection();
    const volumeMounts = this.volumeMounts();
    const volumeMetadata = this.config.volumeName
      ? await this.volumeResolver?.resolveMetadata(this.config.volumeName, this.config.teamId)
      : undefined;
    if (this.config.volumeName && !volumeMetadata) {
      throw new Error("Agent Sandbox Volume metadata resolver is not configured");
    }
    let sandbox: Sandbox;
    try {
      sandbox = await Sandbox.create(this.config.template, {
        ...connection,
        timeoutMs: this.config.timeoutMs,
        allowInternetAccess: this.config.allowInternetAccess,
        ...(volumeMounts ? { volumeMounts } : {}),
        metadata: {
          ...volumeMetadata,
          agentcore_tenant: tenant,
          agentcore_conversation: conversation,
          agentcore_template: this.config.template,
        },
      });
    } catch (error) {
      throw new SafeSandboxSdkError(error);
    }
    return new AgentSandboxHandle(sandbox);
  }

  async connect(sandboxId: string): Promise<SandboxHandle> {
    const connection = await this.connection();
    return new AgentSandboxHandle(await Sandbox.connect(sandboxId, { ...connection, timeoutMs: this.config.timeoutMs }));
  }

  workspace(handle: SandboxHandle, _conversationId: string): SandboxWorkspace {
    if (!(handle instanceof AgentSandboxHandle)) throw new Error("Unsupported sandbox handle");
    return new AgentSandboxWorkspace(handle.sandbox, this.config.root, this.config.commandTimeoutMs);
  }

  close(): void { this.volumeResolver?.close?.(); }
}
