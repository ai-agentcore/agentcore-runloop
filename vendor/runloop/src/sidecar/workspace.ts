import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { NonMcpResources } from "../mcp/types.js";

/** AgentCore owns Skill installation; Runloop writes only its session instructions. */
export async function setupWorkspaceTools(
  workspaceDir: string,
  _resources: NonMcpResources,
  systemPrompt?: string,
): Promise<void> {
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, "AGENTS.md"), systemPrompt ?? "");
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
