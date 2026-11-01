import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { NonMcpResources } from "../mcp/types.js";
import type { Credentials } from "../types/resources.js";
import type { Logger } from "../util/logger.js";
import { downloadAndUnpackSkill } from "./skill-download.js";
import { deriveSkillDownloadUrl } from "../mcp/openapi.js";

/**
 * 在 workspace 中生成 SKILL 目录、AGENTS.md，以及（仅 CLI 模式）`.tools/agentrun` shell CLI。
 * 资源暴露方式由 `features.toolBridge` 控制（默认 mcp，见 runner）：
 * - **mcp 模式**（默认）：非 MCP 资源经进程内 agentrun-mcp server 原生暴露，**不生成** CLI 脚本；
 * - **cli 模式**（降级）：传 `cliSidecarPort`，生成 `.tools/agentrun`，codex 经 `exec_command` 调 sidecar `/call`。
 * AGENTS.md 的内容 100% 来自我们生成的 system prompt（含资源描述），不在此处拼接任何文本。
 */
export async function setupWorkspaceTools(
  workspaceDir: string,
  resources: NonMcpResources,
  systemPrompt?: string,
  opts?: { cliSidecarPort?: number; credentials?: Credentials; logger?: Logger; skipSkillDownload?: boolean },
): Promise<void> {
  await mkdir(workspaceDir, { recursive: true });

  // CLI 模式：生成 .tools/agentrun shell 隧道脚本（mcp 模式不生成）。
  if (opts?.cliSidecarPort !== undefined) {
    const toolsDir = join(workspaceDir, ".tools");
    await mkdir(toolsDir, { recursive: true });
    await writeFile(join(toolsDir, "agentrun"), generateCliScript(opts.cliSidecarPort), { mode: 0o755 });
  }

  // SKILL 资源写成 codex skills 目录（渐进加载）：<workspace>/.agents/skills/<name>/SKILL.md
  // 官方 codex 从 <project>/.agents/skills 读取；frontmatter 仅 name(hyphen-case)+description。
  // 正文 + 附带脚本/资源来自 downloadUrl 的 RAM 端点签名下载解包（参考 agentrun-sdk-python download_skill），不再内联 instruction。
  //
  // skipSkillDownload（有 Sandbox 时）：「有沙箱不落本地盘」——skill 改由 RemoteSandboxBackend.downloadSkillsIntoSandbox
  // 在沙箱内直接下载（Change B / option b），本地不写；模型经 read_file 从沙箱读 `.agents/skills/<slug>/`。
  if (!opts?.skipSkillDownload) {
    await writeSkillFiles(workspaceDir, resources.skills, opts?.credentials, opts?.logger);
  }

  // AGENTS.md 直接写入 system prompt，codex 会把它作为项目指令读取。
  await writeFile(join(workspaceDir, "AGENTS.md"), systemPrompt ?? "");
}

/** CLI 模式：转发命令到 runloop sidecar server 的 shell 脚本。 */
function generateCliScript(port: number): string {
  return `#!/bin/sh
# agentrun sidecar CLI — 转发命令到 runloop sidecar server
#   .tools/agentrun list                           列出所有可用工具
#   .tools/agentrun call <tool-name> [json-args]   调用工具
BASE="http://127.0.0.1:${port}"
case "\$1" in
  list)   curl -sS "\$BASE/tools" ;;
  call)
    TOOL="\$2"; ARGS="\${3:-{}}"
    BODY=\$(printf '{"name":"%s","args":%s}' "\$TOOL" "\$ARGS")
    curl -sS -X POST "\$BASE/call" -H "Content-Type: application/json" -d "\$BODY" ;;
  health) curl -sS "\$BASE/health" ;;
  *) echo "用法: .tools/agentrun <list|call|health> [args...]"; exit 1 ;;
esac
`;
}

/** 把 resourceName 规范成 codex skill 名：hyphen-case，^[a-z0-9-]+$，≤64 */
export function toSkillName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "skill";
}

/**
 * 名称一致化（goal 1）：把下载解包后的 SKILL.md frontmatter `name` 强制改成 slug。
 * 否则下载包自带的 frontmatter name（如 `Travel`）会被 codex 原生 skill 发现展示出来，而我们注入的
 * 「已装入的 Skill」段 + `get_skill` 匹配用的是 slug（`travel-test`）——三处名字不一致、模型按 codex 那个名
 * 调 `get_skill` 会落空。统一到 slug（= 目录名）后：codex 展示名 == 目录 == 我们的提示词 == get_skill 匹配键。
 * SKILL.md 不存在（异常包）则跳过；只动 frontmatter 的 name 行，正文与其它字段不变。
 */
async function normalizeSkillName(dir: string, slug: string): Promise<void> {
  const p = join(dir, "SKILL.md");
  let md: string;
  try {
    md = await readFile(p, "utf8");
  } catch {
    return; // 包内无 SKILL.md，留给上层判断（download 已校验「无文件」）
  }
  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fm) {
    const body = /^name:.*$/m.test(fm[1])
      ? fm[1].replace(/^name:.*$/m, `name: ${slug}`)
      : `name: ${slug}\n${fm[1]}`;
    md = `---\n${body}\n---\n` + md.slice(fm[0].length);
  } else {
    md = `---\nname: ${slug}\n---\n` + md; // 无 frontmatter → 前置一段
  }
  await writeFile(p, md);
}

async function writeSkillFiles(
  workspaceDir: string,
  skills: NonMcpResources["skills"],
  credentials?: Credentials,
  logger?: Logger,
): Promise<void> {
  if (!skills || skills.length === 0) return;
  const skillsRoot = join(workspaceDir, ".agents", "skills");
  for (const skill of skills) {
    const name = toSkillName(skill.resourceName);
    const dir = join(skillsRoot, name);
    await mkdir(dir, { recursive: true });

    // 主路径：用 credentials 对 downloadUrl（openapiConfig 的 download 入口 operation 派生）签名下载
    // skill 包（含 SKILL.md 正文 + 脚本/资源）解包到本目录。
    const downloadUrl = deriveSkillDownloadUrl(skill);
    if (credentials && downloadUrl) {
      try {
        await downloadAndUnpackSkill(downloadUrl, dir, credentials);
        // 把下载包的 frontmatter name 统一成 slug（与目录 / 提示词 / get_skill 一致，见 normalizeSkillName）。
        await normalizeSkillName(dir, name);
        logger?.info("skill downloaded", { name, url: downloadUrl });
        continue;
      } catch (err) {
        logger?.warn("skill download failed, writing frontmatter-only fallback", {
          name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 回落：未配 credentials 或下载失败时，仅写 frontmatter 供 codex 渐进加载发现 name+description（无正文）。
    const description = (skill.description ?? `Skill: ${skill.resourceName}`).replace(/\n/g, " ");
    const md = `---\nname: ${name}\ndescription: ${description}\n---\n`;
    await writeFile(join(dir, "SKILL.md"), md);
  }
}
