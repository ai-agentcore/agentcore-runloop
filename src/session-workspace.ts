import { constants } from "node:fs";
import { access, lstat, mkdir, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { z } from "zod";

export const DEFAULT_UID = "default";
export const UidSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

export class SessionWorkspaceError extends Error {
  constructor(readonly step: string, readonly fsCode: string, cause: unknown) {
    super(`Session workspace failed at ${step}`, { cause });
    this.name = "SessionWorkspaceError";
  }
}

function filesystemErrorCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return "FAILED";
  if (typeof error.code !== "string") return "FAILED";
  if (!/^[A-Z0-9_]+$/.test(error.code)) return "FAILED";
  return error.code;
}

async function atStep<T>(step: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new SessionWorkspaceError(step, filesystemErrorCode(error), error);
  }
}

function staysWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

async function ensureDirectory(path: string, step: string): Promise<void> {
  try { await atStep(`${step}-mkdir`, () => mkdir(path)); }
  catch (error) {
    if (!(error instanceof SessionWorkspaceError) || error.fsCode !== "EEXIST") throw error;
  }
  const info = await atStep(`${step}-lstat`, () => lstat(path));
  if (!info.isDirectory() || info.isSymbolicLink()) throw new SessionWorkspaceError(`${step}-validate`, "UNSAFE_PATH", new Error("not a real directory"));
}

async function prepareMountedRoot(mountedRoot: string): Promise<string> {
  // The deployment platform may expose its trusted OSS/FUSE mount point through
  // a symlink. Follow only this configured parent, then pin containment to its
  // canonical directory. The configured root and request-derived descendants
  // remain non-symlink directories.
  const parent = dirname(mountedRoot);
  const parentInfo = await atStep("root-parent-stat", () => stat(parent));
  if (!parentInfo.isDirectory()) {
    throw new SessionWorkspaceError("root-parent-validate", "UNSAFE_PATH", new Error("not a directory"));
  }
  const canonicalParent = await atStep("root-parent-realpath", () => realpath(parent));

  let rootInfo;
  try { rootInfo = await atStep("root-lstat", () => lstat(mountedRoot)); }
  catch (error) {
    if (!(error instanceof SessionWorkspaceError) || error.fsCode !== "ENOENT") throw error;
    await atStep("root-parent-access", () => access(parent, constants.W_OK | constants.X_OK));
    await ensureDirectory(mountedRoot, "root");
    rootInfo = await atStep("root-lstat-after-create", () => lstat(mountedRoot));
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new SessionWorkspaceError("root-validate", "UNSAFE_PATH", new Error("not a real directory"));
  await atStep("root-access", () => access(mountedRoot, constants.R_OK | constants.W_OK | constants.X_OK));
  const canonicalRoot = await atStep("root-realpath", () => realpath(mountedRoot));
  if (!staysWithin(canonicalParent, canonicalRoot)) {
    throw new SessionWorkspaceError("root-containment", "UNSAFE_PATH", new Error("escaped mount parent"));
  }
  return canonicalRoot;
}

/** Create <mountedRoot>/<uid>/<conversationId> without following user/session symlinks. */
export async function sessionWorkdir(mountedRoot: string, uid: string, conversationId: string): Promise<string> {
  const safeUid = UidSchema.parse(uid);
  const safeConversation = UidSchema.parse(conversationId);
  const canonicalRoot = await prepareMountedRoot(mountedRoot);

  const userRoot = join(mountedRoot, safeUid);
  await ensureDirectory(userRoot, "user");
  const canonicalUser = await atStep("user-realpath", () => realpath(userRoot));
  if (!staysWithin(canonicalRoot, canonicalUser)) throw new SessionWorkspaceError("user-containment", "UNSAFE_PATH", new Error("escaped mounted root"));

  const sessionRoot = join(userRoot, safeConversation);
  await ensureDirectory(sessionRoot, "session");
  const canonicalSession = await atStep("session-realpath", () => realpath(sessionRoot));
  if (!staysWithin(canonicalUser, canonicalSession)) throw new SessionWorkspaceError("session-containment", "UNSAFE_PATH", new Error("escaped user root"));
  await atStep("session-access", () => access(canonicalSession, constants.R_OK | constants.W_OK | constants.X_OK));
  return sessionRoot;
}
