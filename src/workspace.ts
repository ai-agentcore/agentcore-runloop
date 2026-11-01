import { createHash } from "node:crypto";
import { lstat, mkdir, readlink, readdir, realpath, rm, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Manifest } from "./runtime.js";

export function skillSlug(name: string): string {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  const readable = normalized || "skill";
  const digest = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${readable}-${digest}`;
}

const DEPENDENCY_DIRECTORIES = new Set([".runtime", ".venv", "venv", "node_modules"]);
const SYSTEM_RUNTIME_EXECUTABLE = /^\/(?:usr\/(?:local\/)?bin|bin)\/(?:python(?:\d+(?:\.\d+)*)?|node|env)$/;

function staysWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep));
}

async function assertSafeDependencyLink(root: string, path: string): Promise<void> {
  const target = await readlink(path);
  if (isAbsolute(target)) {
    if (SYSTEM_RUNTIME_EXECUTABLE.test(target)) return;
    throw new Error("Skill contains an unsafe dependency link");
  }
  if (!staysWithin(root, resolve(dirname(path), target))) {
    throw new Error("Skill contains an unsafe dependency link");
  }
}

async function assertSafeSkillTree(root: string): Promise<void> {
  if (!(await lstat(root)).isDirectory()) throw new Error("Skill root must be a real directory");
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (entry.isFile()) continue;
      if (entry.isSymbolicLink()) {
        const dependencyRoot = relative(root, path).split(sep)[0];
        if (!DEPENDENCY_DIRECTORIES.has(dependencyRoot)) {
          throw new Error("Skill links are only allowed in dependency directories");
        }
        await assertSafeDependencyLink(root, path);
        continue;
      }
      throw new Error("Skill packages must not contain special files");
    }
  };
  await visit(root);
  try {
    if (!(await lstat(join(root, "SKILL.md"))).isFile()) throw new Error();
  } catch {
    throw new Error("Skill root must contain a regular SKILL.md file");
  }
}

/**
 * Project SDK-managed Skills into Codex's conventional `.agents/skills` path.
 * The SDK root is the persistent source of truth; directory links avoid copying
 * packages and keep Skill-local dependency installations across conversations.
 */
export async function installSkills(workspace: string, skills: Manifest["skills"]): Promise<Manifest["skills"]> {
  const target = join(workspace, ".agents", "skills");
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  const installed: Manifest["skills"] = [];
  for (const skill of skills) {
    await assertSafeSkillTree(skill.root);
    const source = await realpath(skill.root);
    const destination = join(target, skillSlug(skill.name));
    await symlink(source, destination, "dir");
    installed.push({ ...skill, root: destination });
  }
  return installed;
}
