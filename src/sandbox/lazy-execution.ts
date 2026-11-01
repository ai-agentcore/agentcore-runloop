import { createHash } from "node:crypto";
import type { McpToolResult } from "../../vendor/runloop/src/mcp/types.js";
import type { ExecBackend } from "../../vendor/runloop/src/sidecar/exec-backend.js";
import type { SkillDescriptor } from "../runtime.js";
import { errorDiagnostics, logSafeError } from "../error-diagnostics.js";
import { SandboxAcquireError, type SandboxLease, type SandboxManager, type SandboxWorkspace } from "./manager.js";
import { sandboxSkillPaths, syncSkillsToSandbox } from "./skill-sync.js";

function failed(error: unknown): McpToolResult {
  const rawDiagnostics = errorDiagnostics(error);
  const { code: _code, ...safeDiagnostics } = rawDiagnostics;
  const diagnostics = error instanceof SandboxAcquireError
    ? { stage: error.stage, reason: error.reason, ...safeDiagnostics }
    : safeDiagnostics;
  return {
    content: [{ type: "text", text: JSON.stringify({
      error: "sandbox execution is unavailable",
      code: "SANDBOX_NOT_READY",
      diagnostics,
    }) }],
    isError: true,
  };
}

function skillPreparationKey(skills: SkillDescriptor[]): string {
  const identity = skills.map(skill => [skill.name, skill.version ?? "", skill.root]);
  return `skills:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

/** Lazily owns one request lease while the manager keeps the conversation sandbox binding reusable. */
export class LazySandboxExecution implements ExecBackend {
  readonly skills: SkillDescriptor[];
  private readonly sourceSkills: SkillDescriptor[];
  private lease?: SandboxLease;
  private acquiring?: Promise<SandboxLease>;

  constructor(
    private readonly manager: SandboxManager,
    private readonly uid: string,
    private readonly conversationId: string,
    readonly root: string,
    sourceSkills: SkillDescriptor[],
    private readonly logDetail: { runId: string; resource: string },
  ) {
    this.sourceSkills = sourceSkills;
    this.skills = sandboxSkillPaths(root, sourceSkills);
  }

  async workspace(): Promise<SandboxWorkspace> {
    if (this.lease) return this.lease.workspace;
    if (!this.acquiring) {
      const current = this.acquire();
      this.acquiring = current;
      void current.catch(() => {
        if (this.acquiring === current) this.acquiring = undefined;
      });
    }
    this.lease = await this.acquiring;
    return this.lease.workspace;
  }

  private async acquire(): Promise<SandboxLease> {
    const lease = await this.manager.acquire(this.uid, this.conversationId);
    try {
      if (this.skills.length > 0) {
        const key = skillPreparationKey(this.sourceSkills);
        await lease.prepareOnce(key, async () => {
          await syncSkillsToSandbox(lease.workspace, this.sourceSkills);
        });
      }
      return lease;
    } catch (error) {
      await lease.release().catch(() => {});
      throw error;
    }
  }

  private async backend(): Promise<ExecBackend> {
    return (await this.workspace()).execBackend;
  }

  async shell(command: string): Promise<McpToolResult> {
    try {
      return await (await this.backend()).shell(command);
    } catch (error) {
      this.logFailure(error);
      return failed(error);
    }
  }

  async file(name: string, args: Record<string, unknown>): Promise<McpToolResult | null> {
    try {
      return await (await this.backend()).file(name, args);
    } catch (error) {
      this.logFailure(error);
      return failed(error);
    }
  }

  async interrupt(): Promise<void> {
    await Promise.resolve(this.lease?.workspace.execBackend.interrupt?.()).catch(() => {});
  }

  async release(): Promise<void> {
    await this.lease?.release();
    this.lease = undefined;
  }

  private logFailure(error: unknown): void {
    const stage = error instanceof SandboxAcquireError ? error.stage : "workspace_ready";
    logSafeError("sandbox_acquire_failed", stage, error, {
      reason: error instanceof SandboxAcquireError ? error.reason : "unavailable",
      resource: this.logDetail.resource,
      runId: this.logDetail.runId,
      conversationId: this.conversationId,
    });
  }
}
