import { describe, it, expect } from "vitest";
import { buildExtraTools } from "@/loop/extra-tools.js";

/** 取工具名集合，便于断言注入/未注入。 */
const names = (gate: Parameters<typeof buildExtraTools>[0]): string[] =>
  buildExtraTools(gate).map((d) => d.name);

const EXEC_FILE_TOOLS = ["bash", "read_file", "write_file", "edit_file", "grep", "glob"];
const SKILL_TOOLS = ["get_skill"];

describe("buildExtraTools —— runloop-mcp 非资源工具门控", () => {
  it("无 shell / 零执行 + 有 SKILL：注入 skill 读取工具，但不注入执行/文件工具", () => {
    // 系统实例 + 无 Sandbox（execToolsEnabled=false）+ 有 SKILL 资源 = AD-033 的「零执行态」。
    const n = names({ hitlEnabled: false, execToolsEnabled: false, hasSkills: true });
    expect(n).toEqual(expect.arrayContaining(SKILL_TOOLS)); // skill 仍可加载（与执行能力无关）
    for (const t of EXEC_FILE_TOOLS) expect(n).not.toContain(t); // 执行/文件工具整组不注入
    expect(n).not.toContain("request_user_input");
  });

  it("无 shell / 零执行 + 无 SKILL：什么非资源工具都不注入（纯推理 + 平台工具）", () => {
    const n = names({ hitlEnabled: false, execToolsEnabled: false, hasSkills: false });
    expect(n).toEqual([]);
  });

  it("有 shell（execToolsEnabled）+ 有 SKILL：注入执行/文件工具，但不注入 get_skill（走标准 read_file 读 skill）", () => {
    const n = names({ hitlEnabled: false, execToolsEnabled: true, hasSkills: true });
    for (const t of EXEC_FILE_TOOLS) expect(n).toContain(t);
    for (const t of SKILL_TOOLS) expect(n).not.toContain(t); // 有 shell 时 skill 经 read_file/bash 读，不透出 get_skill
  });

  it("有 shell + 无 SKILL：注入执行/文件工具，但无 skill 工具", () => {
    const n = names({ hitlEnabled: false, execToolsEnabled: true, hasSkills: false });
    for (const t of EXEC_FILE_TOOLS) expect(n).toContain(t);
    for (const t of SKILL_TOOLS) expect(n).not.toContain(t);
  });

  it("hitlEnabled 独立门控 ask 原语 request_user_input（与 shell/skill 正交）", () => {
    expect(names({ hitlEnabled: true, execToolsEnabled: false, hasSkills: false }))
      .toEqual(["request_user_input"]);
    expect(names({ hitlEnabled: false, execToolsEnabled: false, hasSkills: false }))
      .not.toContain("request_user_input");
  });

  it("get_skill 仅在无 shell（零执行）注入；有 shell 时不注入（skill 走标准 read_file/bash）", () => {
    // 零执行态：get_skill 是读 skill 正文的唯一通道。
    expect(names({ hitlEnabled: false, execToolsEnabled: false, hasSkills: true }))
      .toEqual(expect.arrayContaining(SKILL_TOOLS));
    // 有 shell：skill 已落盘/同步进沙箱，模型用 read_file/bash 读，不透出 get_skill。
    for (const t of SKILL_TOOLS) {
      expect(names({ hitlEnabled: false, execToolsEnabled: true, hasSkills: true })).not.toContain(t);
    }
  });
});
