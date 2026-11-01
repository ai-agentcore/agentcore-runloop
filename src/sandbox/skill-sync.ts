import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { posix } from "node:path";
import type { Manifest } from "../runtime.js";
import { skillSlug } from "../workspace.js";
import type { SandboxWorkspace, SandboxWriteEntry } from "./manager.js";

const MAX_BATCH_FILES = 256;
const MAX_BATCH_BYTES = 16 * 1024 * 1024;

interface PreparedFile {
  relativePath: string;
  content: Uint8Array;
}

interface PreparedSkill {
  digest: string;
  files: PreparedFile[];
}

const preparedSkills = new Map<string, Promise<PreparedSkill>>();

async function filesBelow(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error("Managed Skill contains an unsafe symbolic link");
      if (info.isDirectory()) pending.push(path);
      else if (info.isFile()) files.push(path);
    }
  }
  return files.sort();
}

function skillIdentity(skill: Manifest["skills"][number]): string {
  return JSON.stringify([skill.name, skill.version ?? "", skill.root]);
}

function remoteSkillRoot(root: string, skill: Manifest["skills"][number]): string {
  const identity = createHash("sha256").update(skillIdentity(skill)).digest("hex").slice(0, 12);
  return posix.join(root, ".agents", "skills", `${skillSlug(skill.name)}-${identity}`);
}

async function prepareSkill(skill: Manifest["skills"][number]): Promise<PreparedSkill> {
  const key = skillIdentity(skill);
  let prepared = preparedSkills.get(key);
  if (!prepared) {
    prepared = (async () => {
      const digest = createHash("sha256");
      const files: PreparedFile[] = [];
      for (const file of await filesBelow(skill.root)) {
        const relativePath = relative(skill.root, file).split(sep).join("/");
        const content = await readFile(file);
        digest.update(relativePath).update("\0").update(String(content.byteLength)).update("\0").update(content);
        files.push({ relativePath, content });
      }
      return { digest: digest.digest("hex"), files };
    })().catch(error => {
      preparedSkills.delete(key);
      throw error;
    });
    preparedSkills.set(key, prepared);
  }
  return prepared;
}

async function writeBatches(workspace: SandboxWorkspace, entries: SandboxWriteEntry[]): Promise<void> {
  let batch: SandboxWriteEntry[] = [];
  let batchBytes = 0;
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    await workspace.writeFiles(batch);
    batch = [];
    batchBytes = 0;
  };
  for (const entry of entries) {
    const bytes = typeof entry.content === "string" ? Buffer.byteLength(entry.content) : entry.content.byteLength;
    if (batch.length > 0 && (batch.length >= MAX_BATCH_FILES || batchBytes + bytes > MAX_BATCH_BYTES)) {
      await flush();
    }
    batch.push(entry);
    batchBytes += bytes;
  }
  await flush();
}

export async function syncSkillsToSandbox(
  workspace: SandboxWorkspace,
  skills: Manifest["skills"],
): Promise<Manifest["skills"]> {
  const installed: Manifest["skills"] = [];
  const entries: SandboxWriteEntry[] = [];
  const manifestSkills: Array<{ name: string; version?: string; digest: string; files: number; bytes: number }> = [];
  for (const skill of skills) {
    const remoteRoot = remoteSkillRoot(workspace.root, skill);
    const prepared = await prepareSkill(skill);
    let bytes = 0;
    for (const file of prepared.files) {
      entries.push({ path: posix.join(remoteRoot, file.relativePath), content: file.content });
      bytes += file.content.byteLength;
    }
    manifestSkills.push({
      name: skill.name,
      ...(skill.version ? { version: skill.version } : {}),
      digest: prepared.digest,
      files: prepared.files.length,
      bytes,
    });
    installed.push({ ...skill, root: remoteRoot });
  }
  await writeBatches(workspace, entries);
  const manifestBody = `${JSON.stringify({ version: 1, skills: manifestSkills })}\n`;
  const skillsetDigest = createHash("sha256").update(manifestBody).digest("hex");
  const marker = posix.join(workspace.root, ".agents", "skills", `.agentcore-skillset-${skillsetDigest}.ready.json`);
  await workspace.writeFile(marker, manifestBody);
  return installed;
}

export function sandboxSkillPaths(
  root: string,
  skills: Manifest["skills"],
): Manifest["skills"] {
  return skills.map(skill => ({
    ...skill,
    root: remoteSkillRoot(root, skill),
  }));
}
