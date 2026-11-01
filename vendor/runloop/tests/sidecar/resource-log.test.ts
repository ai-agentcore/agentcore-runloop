import { describe, it, expect } from "vitest";
import {
  truncateForLog,
  logResourceRequest,
  logResourceResponse,
  MAX_BODY_LOG,
  type ResourceCallLogger,
} from "@/sidecar/resource-log.js";

function fakeLogger() {
  const calls: Array<{ level: string; msg: string; fields: Record<string, unknown> }> = [];
  const log: ResourceCallLogger = {
    info: (msg, fields) => calls.push({ level: "info", msg, fields: fields ?? {} }),
    warn: (msg, fields) => calls.push({ level: "warn", msg, fields: fields ?? {} }),
    error: (msg, fields) => calls.push({ level: "error", msg, fields: fields ?? {} }),
    debug: (msg, fields) => calls.push({ level: "debug", msg, fields: fields ?? {} }),
  };
  return { log, calls };
}

describe("resource-log", () => {
  describe("truncateForLog", () => {
    it("returns undefined for undefined", () => {
      expect(truncateForLog(undefined)).toBeUndefined();
    });
    it("keeps short strings as-is", () => {
      expect(truncateForLog("hello")).toBe("hello");
    });
    it("truncates long strings and annotates original length", () => {
      const s = "x".repeat(MAX_BODY_LOG + 50);
      const out = truncateForLog(s)!;
      expect(out.length).toBeLessThan(s.length);
      expect(out).toContain(`(${s.length} chars total)`);
    });
    it("respects custom max", () => {
      expect(truncateForLog("abcdef", 3)).toBe("abc…(6 chars total)");
    });
  });

  describe("logResourceRequest", () => {
    it("emits info with truncated body", () => {
      const { log, calls } = fakeLogger();
      logResourceRequest(log, { target: "subagent", toolName: "bot", method: "POST", url: "http://x/invoke", body: "y".repeat(MAX_BODY_LOG + 10) });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ level: "info", msg: "resource request" });
      expect(calls[0].fields).toMatchObject({ target: "subagent", toolName: "bot", method: "POST", url: "http://x/invoke" });
      expect(String(calls[0].fields.body)).toContain("chars total");
    });
    it("is a no-op when logger is undefined", () => {
      expect(() => logResourceRequest(undefined, { target: "openapi", method: "GET", url: "http://x" })).not.toThrow();
    });
  });

  describe("logResourceResponse", () => {
    it("emits info for ok responses", () => {
      const { log, calls } = fakeLogger();
      logResourceResponse(log, { target: "openapi", status: 200, ok: true, body: "ok" });
      expect(calls[0].level).toBe("info");
    });
    it("emits warn for non-ok responses", () => {
      const { log, calls } = fakeLogger();
      logResourceResponse(log, { target: "subagent", status: 404, ok: false, body: '{"detail":"Not Found"}' });
      expect(calls[0].level).toBe("warn");
      expect(calls[0].msg).toBe("resource response");
      expect(String(calls[0].fields.body)).toContain("Not Found");
    });
    it("emits warn when an error (no HTTP response) is present", () => {
      const { log, calls } = fakeLogger();
      logResourceResponse(log, { target: "mcp", error: "ECONNREFUSED" });
      expect(calls[0].level).toBe("warn");
      expect(calls[0].fields).toMatchObject({ error: "ECONNREFUSED" });
    });
  });
});
