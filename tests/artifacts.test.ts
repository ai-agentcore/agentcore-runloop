import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishArtifact, publishArtifactBytes } from "../src/artifacts.js";
import { sessionWorkdir } from "../src/session-workspace.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function temp() { const dir = await mkdtemp(join(tmpdir(), "agentcore-artifact-")); dirs.push(dir); return dir; }

describe("publish_artifact", () => {
  it("publishes validated bytes pulled from an isolated sandbox", async () => {
    const artifactRoot = await temp();
    const result = await publishArtifactBytes(
      artifactRoot, "user-1", "conversation-1", "/workspace/final.txt",
      new TextEncoder().encode("sandbox output"), { source_path: "final.txt" },
    );
    expect(await readFile(join(artifactRoot, "user-1", "conversation-1", "final.txt"), "utf8")).toBe("sandbox output");
    expect(result).toMatchObject({ structuredContent: { artifact: { name: "final.txt", size: 14 } } });
    const repeated = await publishArtifactBytes(
      artifactRoot, "user-1", "conversation-1", "final.txt",
      new TextEncoder().encode("next"), { source_path: "final.txt" },
    );
    expect(repeated).toMatchObject({ structuredContent: { artifact: { name: "final-2.txt" } } });
    await expect(publishArtifactBytes(
      artifactRoot, "user-1", "conversation-1", "final.txt",
      new Uint8Array(), { source_path: "final.txt", artifact_path: "final.txt" },
    )).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("copies a final file from AgenticFS scope to the matching OSS user/session scope", async () => {
    const workdir = await temp(), artifactRoot = await temp();
    const workspace = await sessionWorkdir(workdir, "user-1", "conversation-1");
    await mkdir(join(workspace, "report"));
    await writeFile(join(workspace, "report", "final.txt"), "verified output");

    const result = await publishArtifact(workdir, artifactRoot, "user-1", "conversation-1", {
      source_path: "report/final.txt",
      artifact_path: "交付/final.txt",
    });

    const destination = join(artifactRoot, "user-1", "conversation-1", "交付", "final.txt");
    expect(await readFile(destination, "utf8")).toBe("verified output");
    expect(result).toMatchObject({ structuredContent: { artifact: { name: "final.txt", size: 15 } }, isError: false });
    const artifact = (result.structuredContent as { artifact: { id: string; path: string } }).artifact;
    expect(artifact.id).toMatch(/^f_[A-Za-z0-9_-]{22}$/);
    expect(artifact.path).toBe(`/f/${artifact.id}`);
    expect(JSON.stringify(result)).not.toContain(artifactRoot);
    const manifest = JSON.parse(await readFile(join(artifactRoot, "user-1", "conversation-1", ".files.json"), "utf8"));
    expect(manifest).toMatchObject({
      version: 1,
      conversationId: "conversation-1",
      files: { [artifact.id]: { path: "交付/final.txt", name: "final.txt", size: 15 } },
    });
    expect(manifest.files[artifact.id].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("keeps every published file in one conversation manifest", async () => {
    const workdir = await temp(), artifactRoot = await temp();
    const workspace = await sessionWorkdir(workdir, "user-1", "conversation-1");
    await writeFile(join(workspace, "first.txt"), "first");
    await writeFile(join(workspace, "second.txt"), "second");

    const first = await publishArtifact(workdir, artifactRoot, "user-1", "conversation-1", { source_path: "first.txt" });
    const second = await publishArtifact(workdir, artifactRoot, "user-1", "conversation-1", { source_path: "second.txt" });
    const firstId = (first.structuredContent as { artifact: { id: string } }).artifact.id;
    const secondId = (second.structuredContent as { artifact: { id: string } }).artifact.id;
    const manifest = JSON.parse(await readFile(join(artifactRoot, "user-1", "conversation-1", ".files.json"), "utf8"));

    expect(Object.keys(manifest.files).sort()).toEqual([firstId, secondId].sort());
    expect(manifest.files[firstId]).toMatchObject({ path: "first.txt", name: "first.txt", size: 5 });
    expect(manifest.files[secondId]).toMatchObject({ path: "second.txt", name: "second.txt", size: 6 });
  });

  it("rejects paths outside the session and symbolic-link sources", async () => {
    const workdir = await temp(), artifactRoot = await temp(), outside = await temp();
    const workspace = await sessionWorkdir(workdir, "user-1", "conversation-1");
    const secret = join(outside, "secret.txt");
    await writeFile(secret, "secret");
    await symlink(secret, join(workspace, "linked.txt"));

    await expect(publishArtifact(workdir, artifactRoot, "user-1", "conversation-1", { source_path: secret })).rejects.toThrow(/escapes/);
    await expect(publishArtifact(workdir, artifactRoot, "user-1", "conversation-1", { source_path: "linked.txt" })).rejects.toThrow(/regular file/);
    await expect(publishArtifact(workdir, artifactRoot, "user-1", "conversation-1", { source_path: "../outside.txt" })).rejects.toThrow(/escapes/);
  });

  it("keeps implicit repeated publishes unique, rejects explicit collisions and never overwrites", async () => {
    const workdir = await temp(), artifactRoot = await temp();
    const workspace = await sessionWorkdir(workdir, "user-1", "conversation-1");
    await writeFile(join(workspace, "final.txt"), "first");
    await publishArtifact(workdir, artifactRoot, "user-1", "conversation-1", { source_path: "final.txt" });
    await writeFile(join(workspace, "final.txt"), "second");

    const repeated = await publishArtifact(workdir, artifactRoot, "user-1", "conversation-1", { source_path: "final.txt" });
    expect(repeated).toMatchObject({ structuredContent: { artifact: { name: "final-2.txt", size: 6 } }, isError: false });
    expect(await readFile(join(artifactRoot, "user-1", "conversation-1", "final-2.txt"), "utf8")).toBe("second");
    await expect(publishArtifact(workdir, artifactRoot, "user-1", "conversation-1", { source_path: "final.txt", artifact_path: "final.txt" })).rejects.toMatchObject({ code: "EEXIST" });
    await expect(publishArtifact(workdir, artifactRoot, "user-1", "conversation-1", { source_path: "final.txt", artifact_path: "../escape.txt" })).rejects.toThrow(/unsafe/);
    await expect(publishArtifact(workdir, artifactRoot, "user-1", "conversation-1", { source_path: "final.txt", artifact_path: ".files.json" })).rejects.toThrow(/reserved/);
    expect(await readFile(join(artifactRoot, "user-1", "conversation-1", "final.txt"), "utf8")).toBe("first");
  });
});
