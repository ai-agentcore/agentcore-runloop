import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ToolDescriptor } from "./runtime.js";
import { sessionWorkdir } from "./session-workspace.js";

export const PUBLISH_ARTIFACT_TOOL: ToolDescriptor = {
  name: "publish_artifact",
  description: "Publish one verified final file from the current AgenticFS session workspace to the current user's OSS artifact directory. Returns an opaque /f/<id> reference that is the only path that should be presented to the user.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["source_path"],
    properties: {
      source_path: {
        type: "string",
        description: "A relative path in the current session workspace, or an absolute path inside that workspace.",
      },
      artifact_path: {
        type: "string",
        description: "Optional relative destination below the session artifact directory. Defaults to the source filename.",
      },
    },
  },
};

export const ARTIFACT_UID_HEADER = "X-AgentCore-UID";
export const ARTIFACT_CONVERSATION_HEADER = "X-AgentCore-Conversation-Id";
export const ARTIFACT_MANIFEST_NAME = ".files.json";
const manifestUpdates = new Map<string, Promise<void>>();

function staysWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

function relativeArtifactPath(value: unknown, fallback: string): string {
  const selected = value === undefined ? fallback : value;
  if (typeof selected !== "string" || !selected.trim()) throw new Error("artifact_path must be a non-empty relative path");
  const path = selected.trim();
  if (isAbsolute(path) || path.includes("\\")) throw new Error("artifact_path must be relative");
  if (/[\u0000-\u001f\u007f<>|`]/.test(path)) throw new Error("artifact_path contains unsafe characters");
  const parts = path.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) throw new Error("artifact_path contains an unsafe segment");
  if (parts.includes(ARTIFACT_MANIFEST_NAME)) throw new Error("artifact_path uses a reserved file name");
  return parts.join("/");
}

function numberedArtifactPath(path: string, number: number): string {
  const slash = path.lastIndexOf("/");
  const directory = slash >= 0 ? path.slice(0, slash + 1) : "";
  const filename = path.slice(slash + 1);
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : "";
  return `${directory}${stem}-${number}${extension}`;
}

async function safeDestinationParent(sessionRoot: string, artifactPath: string): Promise<string> {
  const parentParts = artifactPath.split("/").slice(0, -1);
  let current = sessionRoot;
  for (const part of parentParts) {
    current = join(current, part);
    try { await mkdir(current); }
    catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("artifact destination contains an unsafe directory");
  }
  return current;
}

export function withArtifactTool(tools: readonly ToolDescriptor[], enabled: boolean): ToolDescriptor[] {
  if (!enabled) return [...tools];
  if (tools.some(tool => tool.name === PUBLISH_ARTIFACT_TOOL.name)) throw new Error("Managed tool name conflicts with publish_artifact");
  return [...tools, PUBLISH_ARTIFACT_TOOL];
}

interface ArtifactReference {
  path: string;
  name: string;
  size: number;
  createdAt: string;
}

interface ArtifactManifest {
  version: 1;
  conversationId: string;
  files: Record<string, ArtifactReference>;
}

function fileSystemCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
}

async function readArtifactManifest(path: string, conversationId: string): Promise<ArtifactManifest> {
  let raw: string;
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("Artifact manifest is not a regular file");
    raw = await readFile(path, "utf8");
  }
  catch (error) {
    if (fileSystemCode(error) === "ENOENT") return { version: 1, conversationId, files: {} };
    throw error;
  }
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("Artifact manifest is invalid");
  const manifest = value as Partial<ArtifactManifest>;
  if (manifest.version !== 1 || manifest.conversationId !== conversationId || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
    throw new Error("Artifact manifest is invalid");
  }
  return manifest as ArtifactManifest;
}

async function serializeManifestUpdate(path: string, update: () => Promise<void>) {
  const previous = manifestUpdates.get(path) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(update);
  manifestUpdates.set(path, current);
  try { await current; }
  finally { if (manifestUpdates.get(path) === current) manifestUpdates.delete(path); }
}

async function createArtifactReference(
  artifactSession: string,
  conversationId: string,
  artifactPath: string,
  name: string,
  size: number,
): Promise<{ id: string; reference: ArtifactReference }> {
  const manifestPath = join(artifactSession, ARTIFACT_MANIFEST_NAME);
  let result: { id: string; reference: ArtifactReference } | undefined;
  await serializeManifestUpdate(manifestPath, async () => {
    const manifest = await readArtifactManifest(manifestPath, conversationId);
    let id = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = `f_${randomBytes(16).toString("base64url")}`;
      if (!(candidate in manifest.files)) { id = candidate; break; }
    }
    if (!id) throw new Error("Unable to allocate artifact reference");
    const reference = { path: artifactPath, name, size, createdAt: new Date().toISOString() };
    manifest.files[id] = reference;
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { encoding: "utf8", mode: 0o600 });
    result = { id, reference };
  });
  return result!;
}

export async function publishArtifact(
  workdir: string,
  artifactRoot: string,
  uid: string,
  conversationId: string,
  arguments_: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (typeof arguments_.source_path !== "string" || !arguments_.source_path.trim()) {
    throw new Error("source_path is required");
  }

  const workspace = await sessionWorkdir(workdir, uid, conversationId);
  const canonicalWorkspace = await realpath(workspace);
  const requestedSource = arguments_.source_path.trim();
  const source = isAbsolute(requestedSource) ? resolve(requestedSource) : resolve(workspace, requestedSource);
  if (!staysWithin(resolve(workspace), source)) throw new Error("source_path escapes the session workspace");
  const sourceInfo = await lstat(source);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) throw new Error("source_path must be a regular file");
  const canonicalSource = await realpath(source);
  if (!staysWithin(canonicalWorkspace, canonicalSource)) throw new Error("source_path escapes the session workspace");

  const requestedArtifactPath = relativeArtifactPath(arguments_.artifact_path, basename(source));
  const explicitArtifactPath = arguments_.artifact_path !== undefined;
  const artifactSession = await sessionWorkdir(artifactRoot, uid, conversationId);
  let artifactPath = requestedArtifactPath;
  let destination = "";
  let copied = false;
  for (let attempt = 0; attempt < 1000; attempt++) {
    artifactPath = attempt === 0 ? requestedArtifactPath : numberedArtifactPath(requestedArtifactPath, attempt + 1);
    await safeDestinationParent(artifactSession, artifactPath);
    destination = resolve(artifactSession, artifactPath);
    if (!staysWithin(resolve(artifactSession), destination)) throw new Error("artifact_path escapes the session artifact directory");
    try {
      await copyFile(canonicalSource, destination, constants.COPYFILE_EXCL);
      copied = true;
      break;
    } catch (error) {
      const collision = error && typeof error === "object" && "code" in error && error.code === "EEXIST";
      if (collision && !explicitArtifactPath) continue;
      if (!collision) await unlink(destination).catch(() => {});
      throw error;
    }
  }
  if (!copied) throw Object.assign(new Error("Unable to allocate artifact filename"), { code: "EEXIST" });
  const published = await stat(destination);
  const name = basename(destination);
  let reference: { id: string; reference: ArtifactReference };
  try {
    reference = await createArtifactReference(artifactSession, conversationId, artifactPath, name, published.size);
  } catch (error) {
    await unlink(destination).catch(() => {});
    throw error;
  }
  const artifact = { id: reference.id, path: `/f/${reference.id}`, name, size: published.size };
  return {
    content: [{ type: "text", text: JSON.stringify({ artifact }) }],
    structuredContent: { artifact },
    isError: false,
  };
}

/** Publish bytes already validated and read from an isolated execution workspace. */
export async function publishArtifactBytes(
  artifactRoot: string,
  uid: string,
  conversationId: string,
  sourceName: string,
  bytes: Uint8Array,
  arguments_: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const fallback = basename(sourceName);
  if (!fallback || fallback === "." || fallback === "..") throw new Error("source_path must name a regular file");
  const requestedArtifactPath = relativeArtifactPath(arguments_.artifact_path, fallback);
  const explicitArtifactPath = arguments_.artifact_path !== undefined;
  const artifactSession = await sessionWorkdir(artifactRoot, uid, conversationId);
  let artifactPath = requestedArtifactPath;
  let destination = "";
  let written = false;
  for (let attempt = 0; attempt < 1000; attempt++) {
    artifactPath = attempt === 0 ? requestedArtifactPath : numberedArtifactPath(requestedArtifactPath, attempt + 1);
    await safeDestinationParent(artifactSession, artifactPath);
    destination = resolve(artifactSession, artifactPath);
    if (!staysWithin(resolve(artifactSession), destination)) throw new Error("artifact_path escapes the session artifact directory");
    try {
      await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
      written = true;
      break;
    } catch (error) {
      const collision = fileSystemCode(error) === "EEXIST";
      if (collision && !explicitArtifactPath) continue;
      throw error;
    }
  }
  if (!written) throw Object.assign(new Error("Unable to allocate artifact filename"), { code: "EEXIST" });
  const name = basename(destination);
  let reference: { id: string; reference: ArtifactReference };
  try {
    reference = await createArtifactReference(artifactSession, conversationId, artifactPath, name, bytes.byteLength);
  } catch (error) {
    await unlink(destination).catch(() => {});
    throw error;
  }
  const artifact = { id: reference.id, path: `/f/${reference.id}`, name, size: bytes.byteLength };
  return {
    content: [{ type: "text", text: JSON.stringify({ artifact }) }],
    structuredContent: { artifact },
    isError: false,
  };
}
