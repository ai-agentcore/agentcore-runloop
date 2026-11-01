import { nanoid } from "nanoid";
import type { RunloopEvent } from "../types/events.js";

export interface RunState {
  conversationId: string;
  status: "idle" | "running" | "interrupted" | "completed" | "error";
  abortController: AbortController;
  events: RunloopEvent[];
  /** HITL 挂起标记：sidecar 主轨命中 ask 规则后置位，使 run 以 hitl_pending 收尾而非 interrupted */
  hitlPending?: boolean;
  /** Client tool 暂停标记：模型调用客户端声明的工具后置位，使 run 以 tool_pending 收尾，等客户端回传 toolresult */
  toolPending?: boolean;
}

const FINISHED_STATUSES = new Set(["completed", "interrupted", "error"]);

export class RunManager {
  private sessions = new Map<string, RunState>();
  /** 已结束（completed/error/interrupted）的 run 保留上限，超出按插入序淘汰最旧的，避免无限增长。 */
  constructor(private readonly maxFinished = 200) {}

  create(conversationId?: string): RunState {
    const id = conversationId ?? nanoid();
    const state: RunState = {
      conversationId: id,
      status: "idle",
      abortController: new AbortController(),
      events: [],
    };
    this.sessions.set(id, state);
    return state;
  }

  /** 淘汰超出上限的已结束 run（Map 保插入序；running/idle 不淘汰）。在 run 转入终态后调用。 */
  private reapFinished(): void {
    const finished: string[] = [];
    for (const [id, s] of this.sessions) {
      if (FINISHED_STATUSES.has(s.status)) finished.push(id);
    }
    const excess = finished.length - this.maxFinished;
    for (let i = 0; i < excess; i++) this.sessions.delete(finished[i]);
  }

  get(conversationId: string): RunState | undefined {
    return this.sessions.get(conversationId);
  }

  /**
   * 开始一个 run：get-or-create 对应 RunState，并重置 run 级瞬态——fresh AbortController + 清 hitlPending
   * + status=running（H6）。直接调 `LoopRunner.run({conversationId})`（未先 prepareRun）复用旧 RunState 时，
   * 旧的 abortController 可能已 abort（上一次 interrupt/timeout）、hitlPending 可能残留 true，导致新 run
   * 立刻被中断或错误收尾。HTTP 路径经 prepareRun→create 本就 fresh，这里重置对它幂等无害。
   */
  beginRun(conversationId?: string): RunState {
    const existing = conversationId ? this.sessions.get(conversationId) : undefined;
    const state = existing ?? this.create(conversationId);
    state.status = "running";
    state.abortController = new AbortController();
    state.hitlPending = false;
    state.toolPending = false;
    return state;
  }

  /** 同一 conversationId 是否已有 running 的 run（用于并发 409 拒绝，L-029） */
  hasRunning(conversationId: string): boolean {
    return this.sessions.get(conversationId)?.status === "running";
  }

  interrupt(conversationId: string, reason?: string): boolean {
    const session = this.sessions.get(conversationId);
    if (!session || session.status !== "running") return false;
    session.status = "interrupted";
    session.abortController.abort(reason ?? "user_interrupt");
    this.reapFinished();
    return true;
  }

  complete(conversationId: string): void {
    const session = this.sessions.get(conversationId);
    if (session) {
      session.status = "completed";
      this.reapFinished();
    }
  }

  setError(conversationId: string): void {
    const session = this.sessions.get(conversationId);
    if (session) {
      session.status = "error";
      this.reapFinished();
    }
  }

  remove(conversationId: string): boolean {
    return this.sessions.delete(conversationId);
  }

  getActiveRuns(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.status === "running") count++;
    }
    return count;
  }

  listRuns(): RunState[] {
    return Array.from(this.sessions.values());
  }
}
