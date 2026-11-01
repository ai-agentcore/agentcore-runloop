import { describe, it, expect, afterEach, vi } from "vitest";
import { readFile, writeFile, mkdir, rm, mkdtemp } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setupWorkspaceTools } from "@/sidecar/workspace.js";
import { downloadAndUnpackSkill } from "@/sidecar/skill-download.js";
import type { NonMcpResources } from "@/mcp/types.js";
import type { Credentials } from "@/types/resources.js";
import type { Logger } from "@/util/logger.js";

vi.mock("@/sidecar/skill-download.js", () => ({
  downloadAndUnpackSkill: vi.fn(),
}));

const CREDS: Credentials = { accessKeyId: "ak", accessKeySecret: "sk" };
const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;
// 扁平 Resource：SKILL 下载 URL 现在从 openapiConfig 的 download operation（serverUrl + path）派生。
const SKILL_SERVER = "https://acct-ram.agentrun-data.cn-hangzhou.aliyuncs.com";
const SKILL_PATH = "/skills/my-skill/download";
const SKILL_DOWNLOAD_URL = SKILL_SERVER + SKILL_PATH;
const skill = (over: Partial<NonMcpResources["skills"][number]> = {}): NonMcpResources["skills"][number] => ({
  resourceId: "r-sk",
  resourceName: "My Skill",
  resourceType: "SKILL",
  protocol: "openapi",
  description: "do things",
  openapiConfig: {
    openapi: "3.0.0",
    servers: [{ url: SKILL_SERVER }],
    paths: { [SKILL_PATH]: { get: { operationId: "download" } } },
  },
  ...over,
});

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

  afterEach(() => {
    vi.mocked(downloadAndUnpackSkill).mockReset();
    vi.mocked(logger.info).mockReset?.();
    vi.mocked(logger.warn).mockReset?.();
  });

  // 全走 MCP 后不再生成 .tools/agentrun shell CLI（非 MCP 资源经进程内 agentrun-mcp server 暴露）。
  it("does NOT generate the .tools/agentrun shell CLI (all-MCP)", async () => {
    const dir = await makeTmpDir();
    await setupWorkspaceTools(dir, EMPTY);
    expect(existsSync(join(dir, ".tools", "agentrun"))).toBe(false);
    expect(existsSync(join(dir, ".tools"))).toBe(false);
  });

  // CLI 模式（降级）：传 cliSidecarPort 时生成可执行的 .tools/agentrun 转发脚本。
  it("generates an executable .tools/agentrun shell CLI in cli mode", async () => {
    const dir = await makeTmpDir();
    await setupWorkspaceTools(dir, EMPTY, "p", { cliSidecarPort: 54321 });
    const cliPath = join(dir, ".tools", "agentrun");
    expect(existsSync(cliPath)).toBe(true);
    const content = await readFile(cliPath, "utf-8");
    expect(content).toContain('BASE="http://127.0.0.1:54321"');
    expect(content).toContain("/call");
    // mode 0o755（可执行）
    expect(statSync(cliPath).mode & 0o111).not.toBe(0);
  });

  it("downloads + unpacks the skill via derived downloadUrl when credentials are present", async () => {
    const dir = await makeTmpDir();
    vi.mocked(downloadAndUnpackSkill).mockResolvedValueOnce(undefined);
    await setupWorkspaceTools(
      dir,
      { ...EMPTY, skills: [skill()] },
      "p",
      { credentials: CREDS, logger },
    );
    const skillDir = join(dir, ".agents", "skills", "my-skill");
    expect(vi.mocked(downloadAndUnpackSkill)).toHaveBeenCalledWith(
      SKILL_DOWNLOAD_URL, // 从 openapiConfig 派生（serverUrl + path）
      skillDir,
      CREDS,
    );
    // 成功走 continue，不写 frontmatter-only 回落（SKILL.md 由下载内容决定，本测不预置）。
    expect(vi.mocked(logger.info)).toHaveBeenCalled();
  });

  it("skipSkillDownload（有 Sandbox）：本地不下载/不落盘 skill（改由沙箱内下载，Change B）", async () => {
    const dir = await makeTmpDir();
    await setupWorkspaceTools(
      dir,
      { ...EMPTY, skills: [skill()] },
      "p",
      { credentials: CREDS, logger, skipSkillDownload: true },
    );
    // 不触发本地下载，且本地不生成 skill 目录的 SKILL.md（「有沙箱不用落本地盘」）。
    expect(vi.mocked(downloadAndUnpackSkill)).not.toHaveBeenCalled();
    await expect(readFile(join(dir, ".agents", "skills", "my-skill", "SKILL.md"), "utf-8")).rejects.toThrow();
    // AGENTS.md 仍写（系统提示词照常）。
    expect(await readFile(join(dir, "AGENTS.md"), "utf-8")).toBe("p");
  });

  it("normalizes the downloaded SKILL.md frontmatter name to the slug (goal 1)", async () => {
    const dir = await makeTmpDir();
    // 模拟下载包：frontmatter name 是非 slug 的 "Fancy Travel"（codex 原生会展示它，与我们的 slug 不一致）。
    vi.mocked(downloadAndUnpackSkill).mockImplementationOnce(async (_url: string, destDir: string) => {
      await mkdir(destDir, { recursive: true });
      await writeFile(join(destDir, "SKILL.md"), "---\nname: Fancy Travel\ndescription: pkg desc\n---\n正文内容\n");
    });
    await setupWorkspaceTools(dir, { ...EMPTY, skills: [skill()] }, "p", { credentials: CREDS, logger });
    const md = await readFile(join(dir, ".agents", "skills", "my-skill", "SKILL.md"), "utf-8");
    expect(md).toContain("name: my-skill");          // 统一成 slug（= 目录名 = 提示词 = get_skill 键）
    expect(md).not.toContain("name: Fancy Travel");  // 原始非 slug name 被替换
    expect(md).toContain("description: pkg desc");   // 其它 frontmatter 字段保留
    expect(md).toContain("正文内容");                 // 正文保留
  });

  it("normalizeSkillName: frontmatter 无 name → 前置 name；无 frontmatter → 前置整段", async () => {
    // 无 name 字段的 frontmatter
    const d1 = await makeTmpDir();
    vi.mocked(downloadAndUnpackSkill).mockImplementationOnce(async (_u: string, dest: string) => {
      await mkdir(dest, { recursive: true });
      await writeFile(join(dest, "SKILL.md"), "---\ndescription: only desc\n---\nbody1\n");
    });
    await setupWorkspaceTools(d1, { ...EMPTY, skills: [skill()] }, "p", { credentials: CREDS, logger });
    const md1 = await readFile(join(d1, ".agents", "skills", "my-skill", "SKILL.md"), "utf-8");
    expect(md1).toContain("name: my-skill");
    expect(md1).toContain("description: only desc");

    // 完全没有 frontmatter
    const d2 = await makeTmpDir();
    vi.mocked(downloadAndUnpackSkill).mockImplementationOnce(async (_u: string, dest: string) => {
      await mkdir(dest, { recursive: true });
      await writeFile(join(dest, "SKILL.md"), "just body, no frontmatter\n");
    });
    await setupWorkspaceTools(d2, { ...EMPTY, skills: [skill()] }, "p", { credentials: CREDS, logger });
    const md2 = await readFile(join(d2, ".agents", "skills", "my-skill", "SKILL.md"), "utf-8");
    expect(md2.startsWith("---\nname: my-skill\n---\n")).toBe(true);
    expect(md2).toContain("just body, no frontmatter");
  });

  it("falls back to frontmatter-only SKILL.md when the download fails", async () => {
    const dir = await makeTmpDir();
    vi.mocked(downloadAndUnpackSkill).mockRejectedValueOnce(new Error("boom"));
    await setupWorkspaceTools(
      dir,
      { ...EMPTY, skills: [skill()] },
      "p",
      { credentials: CREDS, logger },
    );
    const md = await readFile(join(dir, ".agents", "skills", "my-skill", "SKILL.md"), "utf-8");
    expect(md).toContain("name: my-skill");
    expect(md).toContain("description: do things");
    expect(md.trimEnd().endsWith("---")).toBe(true); // 仅 frontmatter，无正文
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
  });

  it("writes frontmatter-only SKILL.md when no credentials are provided", async () => {
    const dir = await makeTmpDir();
    await setupWorkspaceTools(dir, { ...EMPTY, skills: [skill({ description: undefined })] }, "p");
    expect(vi.mocked(downloadAndUnpackSkill)).not.toHaveBeenCalled();
    const md = await readFile(join(dir, ".agents", "skills", "my-skill", "SKILL.md"), "utf-8");
    expect(md).toContain("name: my-skill");
    expect(md).toContain("description: Skill: My Skill"); // 缺省 description 回落
  });

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
