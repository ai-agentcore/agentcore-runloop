import { describe, it, expect, vi } from "vitest";
import { AgentProcess } from "@/acp/process.js";

describe("AgentProcess", () => {
  it("spawns a process and captures stdout lines", async () => {
    const proc = new AgentProcess();
    const lines: string[] = [];

    proc.on("stdout", (line: string) => {
      lines.push(line);
    });

    const exitPromise = new Promise<number | null>((resolve) => {
      proc.on("exit", resolve);
    });

    proc.spawn({
      command: "echo",
      args: ["hello\nworld"],
    });

    const code = await exitPromise;
    expect(code).toBe(0);
    expect(proc.exited).toBe(true);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.join(" ")).toContain("hello");
  });

  it("captures stderr", async () => {
    const proc = new AgentProcess();
    const stderrData: string[] = [];

    proc.on("stderr", (data: string) => {
      stderrData.push(data);
    });

    const exitPromise = new Promise<number | null>((resolve) => {
      proc.on("exit", resolve);
    });

    proc.spawn({
      command: "sh",
      args: ["-c", "echo error >&2"],
    });

    await exitPromise;
    expect(stderrData.join("")).toContain("error");
  });

  it("reports non-zero exit codes", async () => {
    const proc = new AgentProcess();

    const exitPromise = new Promise<number | null>((resolve) => {
      proc.on("exit", resolve);
    });

    proc.spawn({
      command: "sh",
      args: ["-c", "exit 1"],
    });

    const code = await exitPromise;
    expect(code).toBe(1);
  });

  it("can kill a running process", async () => {
    const proc = new AgentProcess();

    const exitPromise = new Promise<number | null>((resolve) => {
      proc.on("exit", resolve);
    });

    proc.spawn({
      command: "sleep",
      args: ["10"],
    });

    expect(proc.exited).toBe(false);
    proc.kill();

    const code = await exitPromise;
    expect(proc.exited).toBe(true);
  });

  it("can write to stdin", async () => {
    const proc = new AgentProcess();
    const lines: string[] = [];

    proc.on("stdout", (line: string) => {
      lines.push(line);
    });

    const exitPromise = new Promise<number | null>((resolve) => {
      proc.on("exit", resolve);
    });

    proc.spawn({
      command: "sh",
      args: ["-c", "read line && echo $line"],
    });

    proc.write("hello from stdin");

    await exitPromise;
    expect(lines.join("")).toContain("hello from stdin");
  });

  it("handles timeout", async () => {
    const proc = new AgentProcess();

    const exitPromise = new Promise<number | null>((resolve) => {
      proc.on("exit", resolve);
    });

    proc.spawn({
      command: "sleep",
      args: ["60"],
      timeout: 200,
    });

    await exitPromise;
    expect(proc.exited).toBe(true);
  });

  it("emits remaining stdout buffer on exit (no trailing newline)", async () => {
    const proc = new AgentProcess();
    const lines: string[] = [];

    proc.on("stdout", (line: string) => {
      lines.push(line);
    });

    const exitPromise = new Promise<number | null>((resolve) => {
      proc.on("exit", resolve);
    });

    proc.spawn({
      command: "sh",
      args: ["-c", "printf 'no-newline-at-end'"],
    });

    await exitPromise;
    expect(lines.join("")).toContain("no-newline-at-end");
  });

  it("emits error for invalid command", async () => {
    const proc = new AgentProcess();

    const errorPromise = new Promise<Error>((resolve) => {
      proc.on("error", resolve);
    });

    proc.spawn({
      command: "nonexistent_command_12345",
      args: [],
    });

    const err = await errorPromise;
    expect(err).toBeInstanceOf(Error);
    expect(proc.exited).toBe(true);
  });

  it("passes environment variables", async () => {
    const proc = new AgentProcess();
    const lines: string[] = [];

    proc.on("stdout", (line: string) => {
      lines.push(line);
    });

    const exitPromise = new Promise<number | null>((resolve) => {
      proc.on("exit", resolve);
    });

    proc.spawn({
      command: "sh",
      args: ["-c", "echo $TEST_VAR"],
      env: { TEST_VAR: "custom_value" },
    });

    await exitPromise;
    expect(lines.join("")).toContain("custom_value");
  });
});
