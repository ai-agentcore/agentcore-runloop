import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeAttachmentEvents, materializeAttachmentEventsToSandbox } from "../src/attachment-materializer.js";
import type { InputEvent } from "../vendor/runloop/src/types/events.js";
import type { SandboxWorkspace } from "../src/sandbox/manager.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function root() { const value = await mkdtemp(join(tmpdir(), "attachment-test-")); roots.push(value); return value; }
const uri = "attachment:up_abc";
const signed = "https://files.example.com/download/signed-object?token=test";
const attachment = (patch = {}) => ({
  type: "user.attachment", id: "up_abc", uri, etag: '"etag-1"',
  name: "photo.png", mimeType: "image/png", size: 3, ...patch,
}) as InputEvent;

function remoteWorkspace(overrides: Partial<SandboxWorkspace> = {}) {
  const written = new Map<string, Uint8Array>();
  const workspace = {
    root: "/workspace/conversations/conversation-1",
    execBackend: {} as never,
    ensureReady: vi.fn(async () => {}),
    ensureDirectory: vi.fn(async () => {}),
    exists: vi.fn(async () => false),
    writeFile: vi.fn(async (path: string, content: string | Uint8Array | ReadableStream<Uint8Array>) => {
      if (content instanceof ReadableStream) {
        const chunks: Uint8Array[] = [];
        for await (const chunk of content) chunks.push(chunk);
        written.set(path, Buffer.concat(chunks));
      }
    }),
    writeFiles: vi.fn(async () => {}),
    readFile: vi.fn(),
    remove: vi.fn(async () => {}),
    getInfo: vi.fn(async (path: string) => ({ type: "file" as const, size: written.get(path)?.byteLength ?? 0 })),
    ...overrides,
  } satisfies SandboxWorkspace;
  return { workspace, written };
}

describe("attachment materialization", () => {
  it("downloads a storage-neutral ticket into the agent workspace", async () => {
    const workspace = await root();
    const events = [attachment()];
    const send = vi.fn(async () => new Response("png", {
      headers: { "Content-Length": "3", ETag: '"etag-1"', "Content-Type": "image/png" },
    }));
    await materializeAttachmentEvents(events, {
      root: workspace, downloads: [{ uri, url: signed }], fetch: send as typeof fetch,
    });
    const target = join(workspace, "uploads/up_abc/photo.png");
    expect((events[0] as { uri: string }).uri).toBe(target);
    expect(await readFile(target, "utf8")).toBe("png");
    expect(send).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
      method: "GET", redirect: "error", headers: { "If-Match": '"etag-1"' },
    }));
  });

  it("defaults each attachment download to a 30-minute timeout", async () => {
    const workspace = await root();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await materializeAttachmentEvents([attachment()], {
      root: workspace,
      downloads: [{ uri, url: signed }],
      fetch: vi.fn(async () => new Response("png", {
        headers: { "Content-Length": "3", ETag: '"etag-1"' },
      })) as typeof fetch,
    });
    expect(timeout).toHaveBeenCalledWith(1_800_000);
  });

  it("treats the attachment URI as an opaque ticket key", async () => {
    const workspace = await root();
    const opaqueUri = "chat-file/tenant-neutral/reference-123";
    const events = [attachment({ uri: opaqueUri, id: "upload_123", name: "notes.txt", size: 5 })];
    await materializeAttachmentEvents(events, {
      root: workspace,
      downloads: [{ uri: opaqueUri, url: "https://cdn.example.net/object/anything?sig=1" }],
      fetch: vi.fn(async () => new Response("hello", { headers: { "Content-Length": "5", ETag: '"etag-1"' } })) as typeof fetch,
    });
    expect((events[0] as { uri: string }).uri).toBe(join(workspace, "uploads/upload_123/notes.txt"));
  });

  it("requires download tickets to match the unique attachment URIs exactly", async () => {
    const workspace = await root();
    await expect(materializeAttachmentEvents([attachment()], { root: workspace, downloads: [] })).rejects.toThrow(/match/i);
    await expect(materializeAttachmentEvents([attachment()], {
      root: workspace, downloads: [{ uri, url: signed }, { uri, url: signed }],
    })).rejects.toThrow(/duplicate/i);
    await expect(materializeAttachmentEvents([attachment()], {
      root: workspace, downloads: [{ uri, url: signed }, { uri: "unused", url: signed }],
    })).rejects.toThrow(/match/i);
  });

  it("downloads a repeated historical attachment only once", async () => {
    const workspace = await root();
    const events = [attachment(), attachment()] as Array<InputEvent & { uri: string }>;
    const send = vi.fn(async () => new Response("png", { headers: { "Content-Length": "3", ETag: '"etag-1"' } }));
    await materializeAttachmentEvents(events, {
      root: workspace, downloads: [{ uri, url: signed }], fetch: send as typeof fetch,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect((events[0] as unknown as { uri: string }).uri).toBe((events[1] as unknown as { uri: string }).uri);
  });

  it.each([
    ["plain HTTP", signed.replace("https://", "http://")],
    ["credentials", signed.replace("https://", "https://user@")],
    ["port", signed.replace(".com/", ".com:444/")],
    ["hash", `${signed}#fragment`],
    ["localhost", signed.replace("files.example.com", "localhost")],
    ["IP literal", signed.replace("files.example.com", "127.0.0.1")],
  ])("rejects an unsafe download URL: %s", async (_name, url) => {
    const send = vi.fn();
    await expect(materializeAttachmentEvents([attachment()], {
      root: await root(), downloads: [{ uri, url }], fetch: send as typeof fetch,
    })).rejects.toThrow(/download URL/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects expired tickets before fetching", async () => {
    const send = vi.fn();
    await expect(materializeAttachmentEvents([attachment()], {
      root: await root(), downloads: [{ uri, url: signed, expiresAt: "2026-01-01T00:00:00.000Z" }],
      now: () => Date.parse("2026-01-02T00:00:00.000Z"), fetch: send as typeof fetch,
    })).rejects.toThrow(/expired/i);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ["bad id", attachment({ id: "../upload" })],
    ["path name", attachment({ name: "nested/photo.png" })],
    ["hidden name", attachment({ name: ".secret" })],
    ["bad etag", attachment({ etag: "bad\nheader" })],
    ["control URI", attachment({ uri: "bad\nuri" })],
  ])("rejects unsafe attachment metadata: %s", async (_name, event) => {
    await expect(materializeAttachmentEvents([event], {
      root: await root(), downloads: [{ uri: (event as { uri: string }).uri, url: signed }],
    })).rejects.toThrow();
  });

  it("does not follow a pre-existing uploads symlink", async () => {
    const workspace = await root(), outside = await root();
    await symlink(outside, join(workspace, "uploads"));
    await expect(materializeAttachmentEvents([attachment()], {
      root: workspace, downloads: [{ uri, url: signed }], fetch: vi.fn() as typeof fetch,
    })).rejects.toThrow(/unsafe/i);
  });

  it("rejects changed objects and wrong byte counts", async () => {
    const workspace = await root();
    await expect(materializeAttachmentEvents([attachment()], {
      root: workspace, downloads: [{ uri, url: signed }],
      fetch: vi.fn(async () => new Response("png", { headers: { "Content-Length": "3", ETag: '"changed"' } })) as typeof fetch,
    })).rejects.toThrow(/ETag/i);
    await expect(materializeAttachmentEvents([attachment()], {
      root: workspace, downloads: [{ uri, url: signed }],
      fetch: vi.fn(async () => new Response("no", { headers: { "Content-Length": "2", ETag: '"etag-1"' } })) as typeof fetch,
    })).rejects.toThrow(/size/i);
  });

  it("accepts a correctly sized chunked response without Content-Length", async () => {
    const workspace = await root();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("png")); controller.close(); },
    }), { headers: { ETag: '"etag-1"' } });
    await materializeAttachmentEvents([attachment()], {
      root: workspace, downloads: [{ uri, url: signed }],
      fetch: vi.fn(async () => response) as typeof fetch,
    });
    expect(await readFile(join(workspace, "uploads/up_abc/photo.png"), "utf8")).toBe("png");
  });

  it("rejects failed, empty, oversized and truncated responses", async () => {
    const cases = [
      new Response("denied", { status: 403 }), new Response(null, { status: 200 }),
      new Response("toolarge", { headers: { "Content-Length": "8", ETag: '"etag-1"' } }),
      new Response("no", { headers: { ETag: '"etag-1"' } }),
    ];
    for (const response of cases) {
      await expect(materializeAttachmentEvents([attachment()], {
        root: await root(), downloads: [{ uri, url: signed }], maxBytes: 4,
        fetch: vi.fn(async () => response) as typeof fetch,
      })).rejects.toThrow();
    }
    const streamed = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("12345")); controller.close(); },
    }), { headers: { ETag: '"etag-1"' } });
    await expect(materializeAttachmentEvents([attachment({ size: undefined })], {
      root: await root(), downloads: [{ uri, url: signed }], maxBytes: 4,
      fetch: vi.fn(async () => streamed) as typeof fetch,
    })).rejects.toThrow(/size limit/i);
  });

  it("safely replaces a prior regular file and rejects a directory target", async () => {
    const workspace = await root();
    await mkdir(join(workspace, "uploads/up_abc"), { recursive: true });
    const target = join(workspace, "uploads/up_abc/photo.png");
    await writeFile(target, "old");
    const response = () => new Response("png", { headers: { "Content-Length": "3", ETag: '"etag-1"' } });
    await materializeAttachmentEvents([attachment()], {
      root: workspace, downloads: [{ uri, url: signed }], fetch: vi.fn(async () => response()) as typeof fetch,
    });
    expect(await readFile(target, "utf8")).toBe("png");
    await rm(target); await mkdir(target);
    await expect(materializeAttachmentEvents([attachment()], {
      root: workspace, downloads: [{ uri, url: signed }], fetch: vi.fn(async () => response()) as typeof fetch,
    })).rejects.toThrow(/target/i);
  });

  it("ignores requests without attachments", async () => {
    await expect(materializeAttachmentEvents([{ type: "user.message", content: "hello" } as InputEvent], {
      root: await root(), downloads: [],
    })).resolves.toBeUndefined();
  });

  it("streams a validated attachment into the isolated sandbox without forwarding its ticket", async () => {
    const { workspace: sandbox, written } = remoteWorkspace();
    const events = [attachment()];
    const send = vi.fn(async () => new Response("png", {
      headers: { "Content-Length": "3", ETag: '"etag-1"' },
    }));
    await materializeAttachmentEventsToSandbox(events, sandbox, {
      downloads: [{ uri, url: signed }], fetch: send as typeof fetch,
    });
    const target = "/workspace/conversations/conversation-1/uploads/up_abc/photo.png";
    expect((events[0] as { uri: string }).uri).toBe(target);
    expect(Buffer.from(written.get(target)!).toString()).toBe("png");
    expect(JSON.stringify([...written.keys()])).not.toContain("token=test");
  });

  it("fails closed on unsafe sandbox targets and removes failed partial downloads", async () => {
    await expect(materializeAttachmentEventsToSandbox(
      [{ type: "user.message", content: "hello" } as InputEvent], remoteWorkspace().workspace, { downloads: [] },
    )).resolves.toBeUndefined();
    await expect(materializeAttachmentEventsToSandbox([attachment()], remoteWorkspace().workspace, { downloads: [] }))
      .rejects.toThrow(/match/i);

    const existing = remoteWorkspace({
      exists: vi.fn(async () => true),
      getInfo: vi.fn(async () => ({ type: "symlink" as const, size: 0, symlinkTarget: "/tmp/escape" })),
    }).workspace;
    await expect(materializeAttachmentEventsToSandbox([attachment()], existing, { downloads: [{ uri, url: signed }] }))
      .rejects.toThrow(/unsafe/i);
    expect(existing.writeFile).not.toHaveBeenCalled();

    const partial = remoteWorkspace({
      getInfo: vi.fn(async () => ({ type: "file" as const, size: 2 })),
    }).workspace;
    await expect(materializeAttachmentEventsToSandbox([attachment()], partial, {
      downloads: [{ uri, url: signed }],
      fetch: vi.fn(async () => new Response("png", { headers: { ETag: '"etag-1"' } })) as typeof fetch,
    })).rejects.toThrow(/unsafe/i);
    expect(partial.remove).toHaveBeenCalled();
  });

  it("rejects remote download transport, ETag and size violations", async () => {
    const run = (response: Response, options: { maxBytes?: number } = {}) => materializeAttachmentEventsToSandbox(
      [attachment()], remoteWorkspace().workspace,
      { downloads: [{ uri, url: signed }], fetch: vi.fn(async () => response) as typeof fetch, ...options },
    );
    await expect(run(new Response("no", { status: 503 }))).rejects.toThrow(/download failed/i);
    await expect(run(new Response("png", { headers: { ETag: '"other"' } }))).rejects.toThrow(/ETag/i);
    await expect(run(new Response("long", { headers: { "Content-Length": "4", ETag: '"etag-1"' } })))
      .rejects.toThrow(/size mismatch/i);
    await expect(run(new Response("png", { headers: { ETag: '"etag-1"' } }), { maxBytes: 2 }))
      .rejects.toThrow(/size limit/i);
  });

  it("replaces a regular sandbox target and reuses one materialized path for duplicate references", async () => {
    const { workspace } = remoteWorkspace({ exists: vi.fn(async () => true) });
    const events = [attachment(), attachment()];
    await materializeAttachmentEventsToSandbox(events, workspace, {
      downloads: [{ uri, url: signed }],
      fetch: vi.fn(async () => new Response("png", { headers: { ETag: '"etag-1"' } })) as typeof fetch,
    });
    expect(workspace.remove).toHaveBeenCalledTimes(1);
    expect(workspace.writeFile).toHaveBeenCalledTimes(1);
    expect(events[1].uri).toBe(events[0].uri);
  });
});
