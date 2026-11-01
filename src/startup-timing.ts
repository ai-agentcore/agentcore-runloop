import { performance } from "node:perf_hooks";
import { errorDiagnostics } from "./error-diagnostics.js";

export type StartupPhase = "manifest" | "model" | "mcp" | "skill" | "runner_initialize";
export type StartupStatus = "ok" | "error" | "timeout";

export interface StartupTiming {
  phase: StartupPhase;
  durationMs: number;
  status: StartupStatus;
  resourceKind?: "model" | "mcp" | "skill" | "runner";
  resource?: string;
  errorType?: string;
  errorCode?: string;
  errorStatus?: number;
  errorRequestId?: string;
  causeType?: string;
  causeCode?: string;
  causeStatus?: number;
  causeRequestId?: string;
}

export type StartupTimingRecorder = (timing: StartupTiming) => void;

function durationMs(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100);
}

export async function measureStartup<T>(
  record: StartupTimingRecorder | undefined,
  base: Omit<StartupTiming, "durationMs" | "status">,
  operation: () => Promise<T>,
  failureStatus: (error: unknown) => StartupStatus = () => "error",
): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await operation();
    try { record?.({ ...base, durationMs: durationMs(startedAt), status: "ok" }); } catch {}
    return result;
  } catch (error) {
    const diagnostics = errorDiagnostics(error);
    try {
      record?.({
        ...base,
        durationMs: durationMs(startedAt),
        status: failureStatus(error),
        errorType: diagnostics.errorType,
        ...(diagnostics.code ? { errorCode: diagnostics.code } : {}),
        ...(diagnostics.status ? { errorStatus: diagnostics.status } : {}),
        ...(diagnostics.requestId ? { errorRequestId: diagnostics.requestId } : {}),
        ...(diagnostics.causeType ? { causeType: diagnostics.causeType } : {}),
        ...(diagnostics.causeCode ? { causeCode: diagnostics.causeCode } : {}),
        ...(diagnostics.causeStatus ? { causeStatus: diagnostics.causeStatus } : {}),
        ...(diagnostics.causeRequestId ? { causeRequestId: diagnostics.causeRequestId } : {}),
      });
    } catch {}
    throw error;
  }
}

export function logStartupTiming(timing: StartupTiming): void {
  try { console.info(JSON.stringify({ event: "agent_startup_timing", ...timing, coldStart: true })); }
  catch { /* Observability must never affect startup. */ }
}
