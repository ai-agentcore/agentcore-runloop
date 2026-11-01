import { constants } from "node:fs";
import { isIP } from "node:net";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { InputEvent } from "../vendor/runloop/src/types/events.js";
import { posix } from "node:path";
import type { SandboxWorkspace } from "./sandbox/manager.js";

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 1_800_000;

type AttachmentEvent = InputEvent & {
  type: "user.attachment";
  id: string;
  uri: string;
  etag: string;
  name: string;
  mimeType: string;
  size?: number;
};

export interface AttachmentDownload {
  uri: string;
  url: string;
  expiresAt?: string;
}

interface MaterializeOptions {
  root: string;
  downloads: AttachmentDownload[];
  maxBytes?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

function safeFileName(value: string): string {
  if (!value || value === "." || value === ".." || value.startsWith(".")
    || value.includes("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)
    || Buffer.byteLength(value) > 255) {
    throw new Error("Invalid attachment file name");
  }
  return value;
}

function validateAttachment(event: AttachmentEvent) {
  if (!SAFE_ID.test(event.id)) throw new Error("Invalid attachment id");
  if (!event.uri || event.uri.length > 2048 || /[\u0000-\u001f\u007f]/.test(event.uri)) {
    throw new Error("Invalid attachment URI");
  }
  if (!event.etag || event.etag.length > 256 || /[\r\n]/.test(event.etag)) {
    throw new Error("Invalid attachment ETag");
  }
  if (event.size !== undefined && (!Number.isSafeInteger(event.size) || event.size < 0)) {
    throw new Error("Invalid attachment size");
  }
  return { id: event.id, fileName: safeFileName(event.name) };
}

async function ensureDirectory(root: string, ...segments: string[]) {
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe attachment directory");
  }
  return current;
}

function validateDownloadUrl(download: AttachmentDownload, now: () => number): URL {
  let url: URL;
  try { url = new URL(download.url); } catch { throw new Error("Invalid attachment download URL"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash
    || !host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || isIP(host)) {
    throw new Error("Invalid attachment download URL");
  }
  if (download.expiresAt !== undefined) {
    const expiresAt = Date.parse(download.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now()) throw new Error("Attachment download ticket expired");
  }
  return url;
}

async function writeResponse(response: Response, target: string, maxBytes: number, expectedSize?: number) {
  if (!response.ok || !response.body) throw new Error("Attachment download failed");
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const announced = Number(contentLength);
    if (!Number.isFinite(announced) || announced < 0 || announced > maxBytes
      || (expectedSize !== undefined && announced !== expectedSize)) {
      await response.body.cancel();
      throw new Error("Attachment size mismatch");
    }
  }
  const temporary = `${target}.partial-${crypto.randomUUID()}`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  let bytes = 0;
  try {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes || (expectedSize !== undefined && bytes > expectedSize)) {
          await reader.cancel();
          throw new Error("Attachment exceeds size limit");
        }
        await handle.write(value);
      }
    } finally { reader.releaseLock(); }
    if (expectedSize !== undefined && bytes !== expectedSize) throw new Error("Attachment size mismatch");
    await handle.sync();
    await handle.close();
    await rename(temporary, target);
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/** Materialize trusted, short-lived download tickets before the agent process starts. */
export async function materializeAttachmentEvents(events: InputEvent[], options: MaterializeOptions): Promise<void> {
  const attachments = events.filter((event): event is AttachmentEvent => event.type === "user.attachment");
  if (!attachments.length) return;
  const tickets = new Map(options.downloads.map(item => [item.uri, item]));
  if (tickets.size !== options.downloads.length) throw new Error("Duplicate attachment download ticket");
  const attachmentUris = new Set(attachments.map(event => event.uri));
  if (tickets.size !== attachmentUris.size || [...tickets.keys()].some(uri => !attachmentUris.has(uri))) {
    throw new Error("Attachment download tickets must match attachments");
  }

  const send = options.fetch ?? fetch;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const localPaths = new Map<string, string>();
  const destinations = new Map<string, string>();

  for (const event of attachments) {
    const parsed = validateAttachment(event);
    const previous = localPaths.get(event.uri);
    if (previous) {
      event.uri = previous;
      continue;
    }
    const ticket = tickets.get(event.uri);
    if (!ticket) throw new Error("Missing attachment download ticket");
    const url = validateDownloadUrl(ticket, now);
    const directory = await ensureDirectory(options.root, "uploads", parsed.id);
    const target = join(directory, parsed.fileName);
    const collision = destinations.get(target);
    if (collision && collision !== event.uri) throw new Error("Attachment target collision");
    destinations.set(target, event.uri);
    try {
      const current = await lstat(target);
      if (!current.isFile() || current.isSymbolicLink()) throw new Error("Unsafe attachment target");
      await rm(target);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    const response = await send(url, {
      method: "GET",
      redirect: "error",
      headers: { "If-Match": event.etag },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const actualEtag = response.headers.get("etag");
    if (actualEtag && actualEtag !== event.etag) {
      await response.body?.cancel();
      throw new Error("Attachment ETag mismatch");
    }
    await writeResponse(response, target, maxBytes, event.size);
    localPaths.set(event.uri, target);
    event.uri = target;
  }
}

/** Materialize validated attachment tickets directly into a remote sandbox without exposing the ticket to it. */
export async function materializeAttachmentEventsToSandbox(
  events: InputEvent[],
  workspace: SandboxWorkspace,
  options: Omit<MaterializeOptions, "root">,
): Promise<void> {
  const attachments = events.filter((event): event is AttachmentEvent => event.type === "user.attachment");
  if (!attachments.length) return;
  const tickets = new Map(options.downloads.map(item => [item.uri, item]));
  const attachmentUris = new Set(attachments.map(event => event.uri));
  if (tickets.size !== options.downloads.length || tickets.size !== attachmentUris.size
    || [...tickets.keys()].some(uri => !attachmentUris.has(uri))) {
    throw new Error("Attachment download tickets must match attachments");
  }

  const send = options.fetch ?? fetch;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const paths = new Map<string, string>();

  for (const event of attachments) {
    const parsed = validateAttachment(event);
    const previous = paths.get(event.uri);
    if (previous) { event.uri = previous; continue; }
    const ticket = tickets.get(event.uri);
    if (!ticket) throw new Error("Missing attachment download ticket");
    const url = validateDownloadUrl(ticket, now);
    const uploads = posix.join(workspace.root, "uploads");
    const attachmentDirectory = posix.join(uploads, parsed.id);
    await workspace.ensureDirectory(uploads);
    await workspace.ensureDirectory(attachmentDirectory);
    const target = posix.join(attachmentDirectory, parsed.fileName);
    if (await workspace.exists(target)) {
      const current = await workspace.getInfo(target);
      if (current.type !== "file" || current.symlinkTarget) throw new Error("Unsafe attachment target");
      await workspace.remove(target);
    }
    const response = await send(url, {
      method: "GET",
      redirect: "error",
      headers: { "If-Match": event.etag },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok || !response.body) throw new Error("Attachment download failed");
    const actualEtag = response.headers.get("etag");
    if (actualEtag && actualEtag !== event.etag) {
      await response.body.cancel();
      throw new Error("Attachment ETag mismatch");
    }
    const announcedHeader = response.headers.get("content-length");
    const announced = announcedHeader === null ? undefined : Number(announcedHeader);
    if (announced !== undefined && Number.isFinite(announced)
      && (announced > maxBytes || (event.size !== undefined && announced !== event.size))) {
      await response.body.cancel();
      throw new Error("Attachment size mismatch");
    }
    let bytes = 0;
    const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes || (event.size !== undefined && bytes > event.size)) {
          controller.error(new Error("Attachment exceeds size limit"));
          return;
        }
        controller.enqueue(chunk);
      },
    }));
    try {
      await workspace.writeFile(target, bounded);
      if (event.size !== undefined && bytes !== event.size) throw new Error("Attachment size mismatch");
      const info = await workspace.getInfo(target);
      if (info.type !== "file" || info.symlinkTarget || info.size !== bytes) throw new Error("Unsafe attachment target");
    } catch (error) {
      await workspace.remove(target).catch(() => undefined);
      throw error;
    }
    paths.set(event.uri, target);
    event.uri = target;
  }
}
