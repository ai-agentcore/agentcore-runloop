// 此文件由 scripts/generate-server.ts 从 spec/openapi.json 自动生成，请勿手动编辑。
import type { Hono, Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { z } from "zod";

import {
  RunRequestSchema,
  InterruptRequestSchema,
} from "../types/api.js";

export interface SSEEvent {
  id: string;
  type: string;
  [key: string]: unknown;
}

export interface HandlerContext {
  header: (name: string) => string | undefined;
  setHeader: (name: string, value: string) => void;
  query: (name: string) => string | undefined;
}

export interface RouteHandlers {
  /** Health check */
  health: (ctx: HandlerContext) => Promise<unknown>;
  /** Start an agent loop */
  run: (req: z.infer<typeof RunRequestSchema>, ctx: HandlerContext) => AsyncGenerator<SSEEvent>;
  /** Interrupt a running run */
  interrupt: (req: z.infer<typeof InterruptRequestSchema>, ctx: HandlerContext) => Promise<unknown>;
  /** Pre-warm agent CLI binary */
  initialize: (ctx: HandlerContext) => Promise<unknown>;
  /** List runs */
  listRuns: (ctx: HandlerContext) => Promise<unknown>;
}

export interface RouteLogger {
  info: (msg: string, fields?: Record<string, unknown>) => void;
}

export function registerRoutes(app: Hono, handlers: RouteHandlers, logger?: RouteLogger): void {

  app.use(async (c, next) => {
    const started = Date.now();
    await next();
    if (logger) {
      logger.info("http access", {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Date.now() - started,
      });
    }
  });

  app.get("/health", async (c: Context) => {
    const ctx: HandlerContext = {
      header: (name) => c.req.header(name),
      setHeader: (name, value) => c.header(name, value),
      query: (name) => c.req.query(name),
    };
    try {
      const result = await handlers.health(ctx);
      return c.json(result);
    } catch (err) {
      const e = err as Record<string, unknown>; if (typeof e?.status === "number") return c.json({ error: String(e.message ?? err) }, e.status as 400);
      throw err;
    }
  });

  app.post("/v1/run", async (c: Context) => {
    const ctx: HandlerContext = {
      header: (name) => c.req.header(name),
      setHeader: (name, value) => c.header(name, value),
      query: (name) => c.req.query(name),
    };
    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: "Invalid JSON body" }, 400); }
    const parsed = RunRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
    }
    const gen = handlers.run(parsed.data, ctx);
    let first: IteratorResult<SSEEvent>;
    try { first = await gen.next(); }
    catch (err) { const e = err as Record<string, unknown>; if (typeof e?.status === "number") return c.json({ error: String(e.message ?? err) }, e.status as 400); throw err; }
    return streamSSE(c, async (stream) => {
      const heartbeat = setInterval(async () => {
        try { await stream.write(":heartbeat\n\n"); } catch {}
      }, 5000);
      try {
        if (!first.done) {
          await stream.writeSSE({ event: first.value.type, data: JSON.stringify(first.value), id: first.value.id });
          for await (const event of gen) {
            await stream.writeSSE({ event: event.type, data: JSON.stringify(event), id: event.id });
          }
        }
      } finally { clearInterval(heartbeat); }
    });
  });

  app.post("/v1/interrupt", async (c: Context) => {
    const ctx: HandlerContext = {
      header: (name) => c.req.header(name),
      setHeader: (name, value) => c.header(name, value),
      query: (name) => c.req.query(name),
    };
    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: "Invalid JSON body" }, 400); }
    const parsed = InterruptRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
    }
    try {
      const result = await handlers.interrupt(parsed.data, ctx);
      return c.json(result);
    } catch (err) {
      const e = err as Record<string, unknown>; if (typeof e?.status === "number") return c.json({ error: String(e.message ?? err) }, e.status as 400);
      throw err;
    }
  });

  app.post("/initialize", async (c: Context) => {
    const ctx: HandlerContext = {
      header: (name) => c.req.header(name),
      setHeader: (name, value) => c.header(name, value),
      query: (name) => c.req.query(name),
    };
    try {
      const result = await handlers.initialize(ctx);
      return c.json(result);
    } catch (err) {
      const e = err as Record<string, unknown>; if (typeof e?.status === "number") return c.json({ error: String(e.message ?? err) }, e.status as 400);
      throw err;
    }
  });

  app.get("/v1/runs", async (c: Context) => {
    const ctx: HandlerContext = {
      header: (name) => c.req.header(name),
      setHeader: (name, value) => c.header(name, value),
      query: (name) => c.req.query(name),
    };
    try {
      const result = await handlers.listRuns(ctx);
      return c.json(result);
    } catch (err) {
      const e = err as Record<string, unknown>; if (typeof e?.status === "number") return c.json({ error: String(e.message ?? err) }, e.status as 400);
      throw err;
    }
  });
}
