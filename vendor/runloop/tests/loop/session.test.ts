import { describe, it, expect } from "vitest";
import { RunManager } from "@/loop/run.js";

describe("RunManager", () => {
  it("creates a run with auto-generated id", () => {
    const manager = new RunManager();
    const session = manager.create();

    expect(session.conversationId).toBeDefined();
    expect(session.status).toBe("idle");
    expect(session.events).toEqual([]);
  });

  it("creates a run with provided id", () => {
    const manager = new RunManager();
    const session = manager.create("my-session");

    expect(session.conversationId).toBe("my-session");
  });

  it("retrieves a run by id", () => {
    const manager = new RunManager();
    const created = manager.create("test-1");
    const retrieved = manager.get("test-1");

    expect(retrieved).toBe(created);
  });

  it("returns undefined for non-existent run", () => {
    const manager = new RunManager();
    expect(manager.get("nonexistent")).toBeUndefined();
  });

  it("interrupts a running run", () => {
    const manager = new RunManager();
    const session = manager.create("sess-1");
    session.status = "running";

    const result = manager.interrupt("sess-1", "user cancelled");
    expect(result).toBe(true);
    expect(session.status).toBe("interrupted");
    expect(session.abortController.signal.aborted).toBe(true);
  });

  it("beginRun resets a reused RunState's aborted signal + hitlPending (H6)", () => {
    const manager = new RunManager();
    const first = manager.create("sess-1");
    first.status = "running";
    first.hitlPending = true;
    manager.interrupt("sess-1", "prev"); // 旧 abortController 被 abort、status=interrupted
    expect(first.abortController.signal.aborted).toBe(true);

    const reused = manager.beginRun("sess-1");
    // 同一 conversationId 复用同一条记录，但瞬态被重置：fresh（未 abort）controller + 清 hitlPending + running。
    expect(manager.get("sess-1")).toBe(reused);
    expect(reused.abortController.signal.aborted).toBe(false);
    expect(reused.hitlPending).toBe(false);
    expect(reused.status).toBe("running");
  });

  it("beginRun creates a fresh RunState when none exists", () => {
    const manager = new RunManager();
    const s = manager.beginRun("new-conv");
    expect(s.conversationId).toBe("new-conv");
    expect(s.status).toBe("running");
    expect(s.abortController.signal.aborted).toBe(false);
  });

  it("cannot interrupt a non-running run", () => {
    const manager = new RunManager();
    manager.create("sess-1");

    const result = manager.interrupt("sess-1");
    expect(result).toBe(false);
  });

  it("cannot interrupt a non-existent run", () => {
    const manager = new RunManager();
    expect(manager.interrupt("nope")).toBe(false);
  });

  it("completes a run", () => {
    const manager = new RunManager();
    const session = manager.create("sess-1");
    session.status = "running";

    manager.complete("sess-1");
    expect(session.status).toBe("completed");
  });

  it("sets error on a run", () => {
    const manager = new RunManager();
    const session = manager.create("sess-1");
    session.status = "running";

    manager.setError("sess-1");
    expect(session.status).toBe("error");
  });

  it("removes a run", () => {
    const manager = new RunManager();
    manager.create("sess-1");

    expect(manager.remove("sess-1")).toBe(true);
    expect(manager.get("sess-1")).toBeUndefined();
  });

  it("returns false when removing non-existent run", () => {
    const manager = new RunManager();
    expect(manager.remove("nope")).toBe(false);
  });

  it("counts active runs", () => {
    const manager = new RunManager();
    const s1 = manager.create("s1");
    const s2 = manager.create("s2");
    const s3 = manager.create("s3");

    s1.status = "running";
    s2.status = "running";
    s3.status = "idle";

    expect(manager.getActiveRuns()).toBe(2);
  });

  it("lists all runs", () => {
    const manager = new RunManager();
    manager.create("a");
    manager.create("b");

    const list = manager.listRuns();
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.conversationId).sort()).toEqual(["a", "b"]);
  });
});
