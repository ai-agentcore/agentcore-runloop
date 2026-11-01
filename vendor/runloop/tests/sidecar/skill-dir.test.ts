import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupWorkspaceTools } from "@/sidecar/workspace.js";
import type { NonMcpResources } from "@/mcp/types.js";

function resources(skills: NonMcpResources["skills"]): NonMcpResources {
  return { tools: [], skills, subAgents: [], sandboxes: [] };
}

// 扁平 Resource：SKILL 下载 URL 从 openapiConfig 的 download operation 派生（serverUrl + path）。
function skillResource(over: { resourceId: string; resourceName: string; description?: string; path: string }): NonMcpResources["skills"][number] {
  return {
    resourceId: over.resourceId,
    resourceName: over.resourceName,
    resourceType: "SKILL",
    protocol: "openapi",
    ...(over.description !== undefined ? { description: over.description } : {}),
    openapiConfig: {
      openapi: "3.0.0",
      servers: [{ url: "https://acct-ram.agentrun-data.cn-hangzhou.aliyuncs.com" }],
      paths: { [over.path]: { get: { operationId: "download" } } },
    },
  };
}

describe("setupWorkspaceTools — SKILL → codex skills dir (L-031/P1)", () => {
  let dir = "";
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  it("writes .agents/skills/<name>/SKILL.md frontmatter (body downloaded from downloadUrl, P1)", async () => {
    dir = await mkdtemp(join(tmpdir(), "skill-test-"));
    await setupWorkspaceTools(dir, resources([
      skillResource({ resourceId: "sk-1", resourceName: "Code Review", description: "审查代码质量；用户要求 review 时使用", path: "/skills/code-review/download" }),
    ]));

    const skillPath = join(dir, ".agents", "skills", "code-review", "SKILL.md");
    const md = await readFile(skillPath, "utf-8");
    expect(md).toContain("name: code-review");            // hyphen-case slug from "Code Review"
    expect(md).toContain("description: 审查代码质量");      // single-line frontmatter
    expect(md.startsWith("---\n")).toBe(true);
    // 正文 + 附带脚本/资源来自 downloadUrl 的签名下载解包（P1）；当前 SKILL.md 仅含 frontmatter、无内联正文。
    expect(md.trimEnd().endsWith("---")).toBe(true);
  });

  it("does not create skills dir when no SKILL resources", async () => {
    dir = await mkdtemp(join(tmpdir(), "skill-test-"));
    await setupWorkspaceTools(dir, resources([]));
    await expect(stat(join(dir, ".agents", "skills"))).rejects.toThrow();
  });

  it("falls back to 'skill' slug for symbol-only name + synthesizes description when missing", async () => {
    dir = await mkdtemp(join(tmpdir(), "skill-test-"));
    await setupWorkspaceTools(dir, resources([
      skillResource({ resourceId: "s", resourceName: "!!!", path: "/skills/x/download" }),
    ]));
    const md = await readFile(join(dir, ".agents", "skills", "skill", "SKILL.md"), "utf-8");
    expect(md).toContain("name: skill");
    expect(md).toContain("description: Skill: !!!"); // synthesized when description absent
  });
});
