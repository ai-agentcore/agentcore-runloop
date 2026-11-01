import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isSkillTool, executeSkillTool, SKILL_TOOL_NAMES } from "@/sidecar/skill-tools.js";
import type { Resource } from "@/types/resources.js";

function skill(name: string, description = ""): Resource {
  return { resourceId: `sk-${name}`, resourceName: name, resourceType: "SKILL", protocol: "openapi", description } as Resource;
}
function parse(r: { content: Array<{ text: string }> }) { return JSON.parse(r.content[0].text); }

describe("skill 工具（仅 get_skill）", () => {
  const dirs: string[] = [];
  afterEach(async () => { for (const d of dirs) { try { await rm(d, { recursive: true, force: true }); } catch {} } dirs.length = 0; });

  it("isSkillTool / 工具名集合（已移除 list_skill）", () => {
    expect(SKILL_TOOL_NAMES).toEqual(["get_skill"]);
    expect(isSkillTool("get_skill")).toBe(true);
    expect(isSkillTool("list_skill")).toBe(false);
    expect(isSkillTool("read_file")).toBe(false);
  });

  it("非 skill 工具名 → null", async () => {
    expect(await executeSkillTool("bash", {}, { skills: [] })).toBeNull();
  });

  it("list_skill 已移除 → 不被识别、返回 null", async () => {
    expect(await executeSkillTool("list_skill", {}, { skills: [skill("a")] })).toBeNull();
  });

  it("get_skill → 读本地 SKILL.md 正文 + 文件清单 + 相对目录 dir", async () => {
    const ws = await mkdtemp(join(tmpdir(), "skill-"));
    dirs.push(ws);
    const dir = join(ws, ".agents", "skills", "code-review");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "# Review\n步骤...");
    await writeFile(join(dir, "helper.py"), "print(1)");

    const r = await executeSkillTool("get_skill", { name: "Code Review" }, { skills: [skill("Code Review")], workdir: ws });
    const out = parse(r!);
    expect(out.name).toBe("Code Review");
    expect(out.content).toContain("# Review");
    expect(out.files).toEqual(["helper.py"]);
    expect(out.dir).toBe(join(".agents", "skills", "code-review"));
  });

  it("get_skill：name 必填 / 未知 skill 报错", async () => {
    expect((await executeSkillTool("get_skill", {}, { skills: [skill("a")] }))!.isError).toBe(true);
    const unknown = await executeSkillTool("get_skill", { name: "nope" }, { skills: [skill("a")] });
    expect(unknown!.isError).toBe(true);
    expect(parse(unknown!).error).toMatch(/unknown skill/);
  });

  it("get_skill：SKILL.md 未落盘（无 workdir）→ 回落 description + note", async () => {
    const r = await executeSkillTool("get_skill", { name: "a" }, { skills: [skill("a", "desc-a")] });
    const out = parse(r!);
    expect(out.description).toBe("desc-a");
    expect(out.note).toMatch(/不可用/);
  });
});
