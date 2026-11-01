// 内置 skill 读取工具 `get_skill`（只读、限定 `.agents/skills/` 范围；已移除 list_skill，见下注释）。
//
// 动机：skill 是渐进加载的能力包，正文在 `<workspace>/.agents/skills/<name>/SKILL.md`。普通模式下模型靠
// read_file/shell 自行读取；但**系统实例无 Sandbox 的零执行态**没有任何文件工具，"按需读 SKILL.md" 这条
// 路断了（模型只看得到 name+description）。这两个工具给模型一条**与 shell/文件能力无关**的结构化读取通道：
// 后端是 runloop 读自己本地的 skill 目录，不暴露任意路径、不能执行——在系统实例下也安全（skill 是用户自带
// 的公开内容、不碰密钥）。只要存在 SKILL 资源就注入，任何模式都可用。

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Resource } from "../types/resources.js";
import type { McpToolDescriptor, McpToolResult } from "../mcp/types.js";
import { toSkillName } from "./workspace.js";

/** 暴露给模型的 skill 工具名（MCP/snake）。
 *  注意：不提供 `list_skill`——已装入 skill 的 name+description 已逐条写进系统提示词「已装入的 Skill」段
 *  （与 list_skill 返回值逐字相同），再给 list_skill 只是一次零增量往返。只保留 `get_skill` 取正文。 */
export const SKILL_TOOL_NAMES = ["get_skill"] as const;
const SKILL_TOOL_NAME_SET = new Set<string>(SKILL_TOOL_NAMES);

export const SKILL_TOOL_DESCRIPTORS: McpToolDescriptor[] = [
  {
    name: "get_skill",
    description:
      "读取指定 skill 的完整 SKILL.md 正文（及包内文件清单、磁盘目录）。skill 名见系统提示词「已装入的 Skill」列表，直接传入即可。",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "skill 名（见系统提示词的 skill 列表）" } },
      required: ["name"],
    },
  },
];

export function isSkillTool(name: string): boolean {
  return SKILL_TOOL_NAME_SET.has(name);
}

const ok = (obj: unknown): McpToolResult => ({ content: [{ type: "text", text: JSON.stringify(obj) }], isError: false });
const fail = (msg: string): McpToolResult => ({ content: [{ type: "text", text: JSON.stringify({ error: msg }) }], isError: true });

export interface SkillToolOptions {
  /** SKILL 资源（name + description 来源）。 */
  skills: Resource[];
  /** 会话本地 workspace 目录（skill 落盘于 `<workdir>/.agents/skills/<slug>/`）。 */
  workdir?: string;
}

/** 执行一个 skill 工具；name 非 skill 工具时返回 null（调用方继续走其它分发）。 */
export async function executeSkillTool(
  name: string,
  args: Record<string, unknown>,
  opts: SkillToolOptions,
): Promise<McpToolResult | null> {
  if (!isSkillTool(name)) return null;
  const skills = opts.skills ?? [];

  // get_skill（唯一 skill 工具）
  const want = String(args.name ?? "");
  if (!want) return fail("name is required");
  const slug = toSkillName(want);
  const skill = skills.find((s) => s.resourceName === want || toSkillName(s.resourceName) === slug);
  if (!skill) return fail(`unknown skill: ${want}`);

  // 返回相对工作目录的 skill 目录，便于有 shell/文件能力时直接 read_file/bash 读子文件（scripts/assets/…）。
  const relDir = join(".agents", "skills", slug);
  const dir = opts.workdir ? join(opts.workdir, ".agents", "skills", slug) : undefined;
  if (dir) {
    try {
      const content = await readFile(join(dir, "SKILL.md"), "utf8");
      let files: string[] = [];
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        files = entries.filter((e) => e.isFile() && e.name !== "SKILL.md").map((e) => e.name);
      } catch { /* 目录列举失败不致命 */ }
      return ok({ name: skill.resourceName, dir: relDir, content, files });
    } catch {
      // SKILL.md 不在（未配 workspace / 下载失败）→ 回落 description。
    }
  }
  return ok({ name: skill.resourceName, description: skill.description ?? "", note: "完整正文不可用（skill 未落盘）" });
}
