import type { NonMcpResources } from "../../../mcp/types.js";
import { toSkillName } from "../../../sidecar/workspace.js";
import { descriptorsFor, renderToolList, type ResourceMode } from "./render.js";

export type { ResourceMode } from "./render.js";

function renderResourceIntro(mode: ResourceMode): string {
  return [
    "# 可用的平台工具",
    "",
    "你的工具列表中**已经包含**以下工具，可以像调用任何其它工具一样**直接按名字调用**。",
    "",
    "**严格要求**：",
    "- 需要平台能力（子 Agent / 实时数据 / 沙箱 / 知识库 / 记忆等）时，**必须直接调用下面列出的对应工具**。",
    "- **禁止**用 `exec_command` / shell / `curl` 去“模拟”工具结果或绕过工具；这些工具**已经在你的工具列表里**，不需要、也不要去“列举/探索/搜索”它们（不要调用 list/search 类工具找它们）。",
    "- 不能只在回复文本里描述调用意图，必须真正发起工具调用。",
    "- 无需平台能力即可回答的请求，直接自然回答即可。",
  ].join("\n");
}

/** 委派块：subAgents → agent__<name>__delegate 工具列表（AD-029）。 */
function delegationSection(nonMcp: NonMcpResources, mode: ResourceMode): string {
  const descs = descriptorsFor(nonMcp, "subAgents");
  if (descs.length === 0) return "";
  return `## 子 Agent 委派\n\n${renderToolList(descs, mode)}`;
}

/** 平台工具块：tools + sandboxes（openapi）+ mcpServers（聚合的下游 MCP 工具，来自 toolManifest）。 */
function platformToolsSection(nonMcp: NonMcpResources, mode: ResourceMode): string {
  const descs = [
    ...descriptorsFor(nonMcp, "tools"),
    ...descriptorsFor(nonMcp, "sandboxes"),
    ...descriptorsFor(nonMcp, "mcpServers"),
  ];
  if (descs.length === 0) return "";
  return `## 平台工具（FunctionCall / 沙箱 / 知识库 / 记忆 / MCP 等）\n\n${renderToolList(descs, mode)}`;
}

/**
 * SKILL 块：skill 是渐进加载的能力包（非模型工具），仅提示已装入工作区。
 * 读取措辞按 execToolsEnabled（是否有 shell/文件能力）分叉：
 * - 有 shell（execToolsEnabled）：skill 已落盘/同步进沙箱的 `.agents/skills/<名字>/`，用标准 `read_file`/`bash` 读，
 *   **不提 get_skill**（与执行层读法统一，避免本地副本读法分叉）。
 * - 无 shell（零执行态）：没有文件工具，`get_skill` 是读 SKILL.md 正文的唯一通道。
 */
function skillsSection(nonMcp: NonMcpResources, execToolsEnabled: boolean): string {
  if (nonMcp.skills.length === 0) return "";
  // skill 名一律用 slug（toSkillName）——与磁盘目录、codex 原生发现、get_skill 匹配键完全一致（goal 1）。
  const names = nonMcp.skills.map((s) => toSkillName(s.resourceName));
  const intro = execToolsEnabled
    ? "下面是已装入 skill 的**名字**与简介。它们连同附带文件已落盘在工作目录的 `.agents/skills/<名字>/`。当任务匹配某个 skill 时，用 `read_file` 读它的 `.agents/skills/<名字>/SKILL.md` 正文、再按其说明执行（可继续用 `read_file`/`bash` 读取或运行其中的 `scripts/`、`assets/`、`references/` 文件）。**名字必须用下面列出的原样。**"
    : "下面是已装入 skill 的**名字**与简介。当任务匹配某个 skill 时，先用 `get_skill` 取它的完整 SKILL.md 正文、再按其说明执行（任何环境都可用，无需 shell）。**`name` 必须用下面列出的名字原样传入。**";
  const lines = ["## 已装入的 Skill（渐进加载）", intro, ""];
  nonMcp.skills.forEach((s, i) => {
    lines.push(`- **${names[i]}**：${s.description ?? ""}`);
  });
  const example = execToolsEnabled
    ? `读取示例：\`read_file {"file_path":".agents/skills/${names[0]}/SKILL.md"}\``
    : `调用示例：\`get_skill {"name":"${names[0]}"}\``;
  lines.push("", example);
  return lines.join("\n");
}

const SECTION_BUILDERS = [delegationSection, platformToolsSection] as const;

/**
 * 资源提示词主装配：顶部一次「调用总则」（按 mode）+ 委派 / 平台工具 / Skill 块（无该类资源则跳过）。
 * 全部为空时返回 ''（无资源块）。`execToolsEnabled` 仅影响 skill 读取措辞（有 shell→read_file / 无 shell→get_skill）。
 */
export function buildResourcePrompt(
  nonMcp: NonMcpResources,
  mode: ResourceMode,
  execToolsEnabled = false,
): string {
  const sections = SECTION_BUILDERS.map((fn) => fn(nonMcp, mode)).filter((s) => s.length > 0);
  const skills = skillsSection(nonMcp, execToolsEnabled);
  if (skills) sections.push(skills);
  if (sections.length === 0) return "";
  return [renderResourceIntro(mode), ...sections].join("\n\n");
}
