import type { ExecBackend } from "../../vendor/runloop/src/sidecar/exec-backend.js";

export interface SandboxFileInfo {
  type: "file" | "dir" | "symlink";
  size: number;
  symlinkTarget?: string;
}

export interface SandboxWriteEntry {
  path: string;
  content: string | Uint8Array;
}

export interface SandboxWorkspace {
  root: string;
  execBackend: ExecBackend;
  ensureReady(): Promise<void>;
  ensureDirectory(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  writeFile(path: string, content: string | Uint8Array | ReadableStream<Uint8Array>): Promise<void>;
  writeFiles(entries: SandboxWriteEntry[]): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  getInfo(path: string): Promise<SandboxFileInfo>;
  remove(path: string): Promise<void>;
}

export interface SandboxHandle {
  id: string;
  isRunning(): Promise<boolean>;
  setTimeout(timeoutMs: number): Promise<void>;
  kill(): Promise<void>;
}

export interface SandboxProvider {
  create(tenantKey: string, conversationId: string): Promise<SandboxHandle>;
  connect(sandboxId: string): Promise<SandboxHandle>;
  workspace(handle: SandboxHandle, conversationId: string): SandboxWorkspace;
  close?(): void;
}

export interface SandboxLease {
  sandboxId: string;
  workspace: SandboxWorkspace;
  prepareOnce(key: string, operation: () => Promise<void>): Promise<void>;
  release(): Promise<void>;
}

export type SandboxAcquireStage = "lease" | "health_check" | "create" | "renew" | "workspace_ready";

export class SandboxAcquireError extends Error {
  constructor(
    readonly code: "USER_SANDBOX_BUSY" | "SANDBOX_NOT_READY",
    readonly reason: "busy" | "timeout" | "unavailable" = code === "USER_SANDBOX_BUSY" ? "busy" : "unavailable",
    readonly stage: SandboxAcquireStage = code === "USER_SANDBOX_BUSY" ? "lease" : "create",
    cause?: unknown,
  ) {
    super(code === "USER_SANDBOX_BUSY" ? "The user sandbox is busy" : "The user sandbox is not ready");
    this.name = "SandboxAcquireError";
    this.cause = cause;
  }
}

interface Binding {
  handle: SandboxHandle;
  lastUsedAt: number;
  lastHealthCheckedAt: number;
  lastRenewedAt: number;
  preparations: Map<string, Promise<void>>;
}

/**
 * Process-local lifecycle coordinator. Each tenant/conversation pair owns one sandbox and one active
 * run. The provider and binding store are separated so a distributed CAS-backed registry can replace
 * this map without changing the execution backend.
 */
export class SandboxManager {
  private readonly bindings = new Map<string, Binding>();
  private readonly active = new Set<string>();

  constructor(
    private readonly provider: SandboxProvider,
    private readonly options: { timeoutMs: number; healthCheckIntervalMs?: number },
  ) {}

  private healthCheckIntervalMs(): number {
    return this.options.healthCheckIntervalMs ?? Math.min(60_000, Math.max(5_000, Math.floor(this.options.timeoutMs / 4)));
  }

  private key(tenantKey: string, conversationId: string): string {
    return JSON.stringify([tenantKey, conversationId]);
  }

  async acquire(tenantKey: string, conversationId: string): Promise<SandboxLease> {
    const key = this.key(tenantKey, conversationId);
    if (this.active.has(key)) throw new SandboxAcquireError("USER_SANDBOX_BUSY");
    this.active.add(key);
    let stage: SandboxAcquireStage = "health_check";
    try {
      const now = Date.now();
      let binding = this.bindings.get(key);
      let checked = false;
      if (binding && now - binding.lastHealthCheckedAt >= this.healthCheckIntervalMs()) {
        if (!await binding.handle.isRunning().catch(() => false)) {
          this.bindings.delete(key);
          binding = undefined;
        } else {
          binding.lastHealthCheckedAt = now;
          checked = true;
        }
      }
      let created = false;
      if (!binding) {
        stage = "create";
        const handle = await this.provider.create(tenantKey, conversationId);
        binding = {
          handle,
          lastUsedAt: now,
          lastHealthCheckedAt: now,
          lastRenewedAt: 0,
          preparations: new Map(),
        };
        this.bindings.set(key, binding);
        created = true;
      }
      if (created || now - binding.lastRenewedAt >= Math.floor(this.options.timeoutMs / 2)) {
        stage = "renew";
        await binding.handle.setTimeout(this.options.timeoutMs);
        binding.lastRenewedAt = now;
      }
      const workspace = this.provider.workspace(binding.handle, conversationId);
      if (created || checked) {
        stage = "workspace_ready";
        await workspace.ensureReady();
      }
      let released = false;
      return {
        sandboxId: binding.handle.id,
        workspace,
        prepareOnce: async (key, operation) => {
          let preparation = binding!.preparations.get(key);
          if (!preparation) {
            preparation = operation().catch(error => {
              binding!.preparations.delete(key);
              throw error;
            });
            binding!.preparations.set(key, preparation);
          }
          await preparation;
        },
        release: async () => {
          if (released) return;
          released = true;
          binding!.lastUsedAt = Date.now();
          this.active.delete(key);
        },
      };
    } catch (error) {
      this.active.delete(key);
      if (error instanceof SandboxAcquireError) throw error;
      const failed = this.bindings.get(key);
      this.bindings.delete(key);
      if (failed) void failed.handle.kill().catch(() => {});
      const reason = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "unavailable";
      throw new SandboxAcquireError("SANDBOX_NOT_READY", reason, stage, error);
    }
  }

  workspace(tenantKey: string, conversationId: string): SandboxWorkspace | undefined {
    const binding = this.bindings.get(this.key(tenantKey, conversationId));
    return binding ? this.provider.workspace(binding.handle, conversationId) : undefined;
  }

  close(): void { this.provider.close?.(); }
}
