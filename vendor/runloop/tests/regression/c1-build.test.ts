import { describe, it, expect } from "vitest";
import { builtinModules } from "node:module";

describe("C1: Build configuration", () => {
  it("vite.config.ts externals cover all bare Node builtins", async () => {
    const { default: config } = await import("../../vite.config.js");
    const resolved =
      typeof config === "function" ? await config({} as any) : config;
    const external = resolved?.build?.rollupOptions?.external;
    expect(external).toBeDefined();

    const externals = Array.isArray(external) ? external : [external];
    const testModules = ["stream", "http", "http2", "crypto", "fs", "path"];
    for (const mod of testModules) {
      const matched = externals.some((e: unknown) => {
        if (e instanceof RegExp) return e.test(mod) || e.test(`node:${mod}`);
        if (typeof e === "string") return e === mod;
        return false;
      });
      expect(matched, `${mod} should be externalized`).toBe(true);
    }
  });

  it("library entry does not export server/createApp", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const entry = readFileSync(
      resolve(__dirname, "../../src/index.ts"),
      "utf-8"
    );
    expect(entry).not.toContain('from "./server/index.js"');
    expect(entry).not.toContain("createApp");
  });
});
