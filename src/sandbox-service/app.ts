import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Executor } from "./executor.js";
import { FILE_HELPER } from "./files.js";

const commandSchema = z.object({
  command: z.string().min(1).max(65536).refine(value => !value.includes("\0")),
  args: z.array(z.string().max(65536).refine(value => !value.includes("\0"))).max(256).default([]),
  timeoutMs: z.number().int().min(1).max(60000).default(30000),
}).strict();
const safePath = z.string().min(1).max(4096).refine(p => !p.startsWith("/") && !p.includes("\0") && !p.includes("\\") && !p.split("/").includes(".."));

export function createSandboxApp(token: string, executor: Executor) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error.message === "SANDBOX_BUSY") return c.json({ code: "SANDBOX_BUSY" }, 409);
    return c.json({ code: "SANDBOX_UNAVAILABLE" }, 503);
  });
  app.get("/healthz", c => c.json({ status: "ok" }));
  app.get("/readyz", async c => { await executor.initialize(); return c.json({ status: "ready" }); });
  app.use("/v1/*", async (c, next) => {
    const supplied = Buffer.from(c.req.header("Authorization") ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return c.json({ code: "UNAUTHORIZED" }, 401);
    await next();
  });
  app.use("/v1/*", bodyLimit({ maxSize: 8 * 1024 * 1024, onError: c => c.json({ code: "BODY_TOO_LARGE" }, 413) }));
  app.post("/v1/exec", async c => {
    const input = commandSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "INVALID_REQUEST" }, 400);
    const result = await executor.run([input.data.command, ...input.data.args], undefined, input.data.timeoutMs);
    return c.json({ stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8"),
      exitCode: result.exitCode, timedOut: result.timedOut, truncated: result.truncated });
  });
  for (const method of ["GET", "PUT"] as const) {
    app.on(method, "/v1/files", async c => {
      const path = safePath.safeParse(c.req.query("path"));
      if (!path.success) return c.json({ code: "INVALID_PATH" }, 400);
      const op = method === "GET" ? "read" : "write";
      let body: Buffer | undefined;
      if (method === "PUT") body = Buffer.from(await c.req.arrayBuffer());
      const result = await executor.run([process.execPath, "--openssl-config=/dev/null", "-e", FILE_HELPER, op, path.data], body, 30000, 8 * 1024 * 1024);
      if (result.exitCode !== 0 || result.truncated || result.timedOut) return c.json({ code: "FILE_OPERATION_FAILED" }, 422);
      if (method === "PUT") return c.json({ status: "created" }, 201);
      return new Response(new Uint8Array(result.stdout), { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" } });
    });
  }
  app.get("/v1/directories", async c => {
    const path = safePath.safeParse(c.req.query("path") ?? ".");
    if (!path.success) return c.json({ code: "INVALID_PATH" }, 400);
    const result = await executor.run([process.execPath, "--openssl-config=/dev/null", "-e", FILE_HELPER, "list", path.data]);
    if (result.exitCode !== 0 || result.truncated || result.timedOut) return c.json({ code: "FILE_OPERATION_FAILED" }, 422);
    return new Response(new Uint8Array(result.stdout), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  });
  return app;
}
