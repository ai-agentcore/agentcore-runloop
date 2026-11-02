import { describe, it, expect, afterEach, vi } from "vitest";
import { readFile, writeFile, mkdir, rm, mkdtemp } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setupWorkspaceTools } from "@/sidecar/workspace.js";
import type { NonMcpResources } from "@/mcp/types.js";
import type { Credentials } from "@/types/resources.js";
import type { Logger } from "@/util/logger.js";

const EMPTY: NonMcpResources = {
  tools: [],
  skills: [],
  subAgents: [],
  sandboxes: [],
};

describe("setupWorkspaceTools", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const d of dirs) {
      try { await rm(d, { recursive: true, force: true }); } catch {}
    }
    dirs.length = 0;
  });

  async function makeTmpDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "runloop-ws-"));
    dirs.push(dir);
    return dir;
  }

  // 全走 MCP 后不再生成 .tools/agentrun shell CLI（非 MCP 资源经进程内 runloop-mcp server 暴露）。
  it("does NOT generate the .tools/agentrun shell CLI (all-MCP)", async () => {
    const dir = await makeTmpDir();
    await setupWorkspaceTools(dir, EMPTY);
    expect(existsSync(join(dir, ".tools", "agentrun"))).toBe(false);
    expect(existsSync(join(dir, ".tools"))).toBe(false);
  });

  // CLI 模式（降级）：传 cliSidecarPort 时生成可执行的 .tools/agentrun 转发脚本。







  it("writes AGENTS.md with the provided system prompt", async () => {
    const dir = await makeTmpDir();
    const prompt = "# Test Prompt\nYou are a helpful agent.";
    await setupWorkspaceTools(dir, EMPTY, prompt);

    const content = await readFile(join(dir, "AGENTS.md"), "utf-8");
    expect(content).toBe(prompt);
  });

  it("AGENTS.md contains exactly the provided prompt — no extra content injected", async () => {
    const dir = await makeTmpDir();
    const prompt = "# 流程约束\n你是 AgentRun 的超级 Agent\n\n## 环境与依赖安装\n...";
    await setupWorkspaceTools(dir, EMPTY, prompt);

    const content = await readFile(join(dir, "AGENTS.md"), "utf-8");
    expect(content).toBe(prompt);
    expect(content).not.toContain("codex");
    expect(content).not.toContain("You are Codex");
    expect(content).not.toContain("IMPORTANT");
  });

  it("writes empty AGENTS.md when systemPrompt is undefined", async () => {
    const dir = await makeTmpDir();
    await setupWorkspaceTools(dir, EMPTY);

    const content = await readFile(join(dir, "AGENTS.md"), "utf-8");
    expect(content).toBe("");
  });

  it("is idempotent when the workspace already exists", async () => {
    const dir = await makeTmpDir();
    await setupWorkspaceTools(dir, EMPTY, "p");
    // call again — should not throw
    await setupWorkspaceTools(dir, EMPTY, "p");
    expect(await readFile(join(dir, "AGENTS.md"), "utf-8")).toBe("p");
  });
});
