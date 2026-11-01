import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getVersionInfo, formatVersion, resolvePackageVersion } from "@/util/version.js";

describe("version", () => {
  const saved = { tag: process.env.AGENTCORE_TAG, env: process.env.AGENTCORE_ENV };
  afterEach(() => {
    if (saved.tag === undefined) delete process.env.AGENTCORE_TAG;
    else process.env.AGENTCORE_TAG = saved.tag;
    if (saved.env === undefined) delete process.env.AGENTCORE_ENV;
    else process.env.AGENTCORE_ENV = saved.env;
  });

  it("tag 取自 AGENTCORE_TAG", () => {
    process.env.AGENTCORE_TAG = "abc1234";
    expect(getVersionInfo().tag).toBe("abc1234");
  });

  it("AGENTCORE_TAG 未设/空 → tag = unknown", () => {
    delete process.env.AGENTCORE_TAG;
    expect(getVersionInfo().tag).toBe("unknown");
    process.env.AGENTCORE_TAG = "   ";
    expect(getVersionInfo().tag).toBe("unknown");
  });

  it("version = package.json 的 semver（可读、形如 x.y.z）、node = process.version", () => {
    const info = getVersionInfo();
    expect(info.version).not.toBe("unknown");
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(info.node).toBe(process.version);
  });

  it("env 仅在 AGENTCORE_ENV 设置时出现", () => {
    delete process.env.AGENTCORE_ENV;
    expect(getVersionInfo().env).toBeUndefined();
    process.env.AGENTCORE_ENV = "pre";
    expect(getVersionInfo().env).toBe("pre");
  });

  it("formatVersion 渲染单行版本串（含 tag/version/node，env 可选）", () => {
    const base = { tag: "abc1234", version: "1.2.3", node: "v22.14.0" };
    expect(formatVersion(base)).toBe("runloop abc1234 (v1.2.3, node v22.14.0)");
    expect(formatVersion({ ...base, env: "pre" })).toBe(
      "runloop abc1234 (v1.2.3, node v22.14.0, env pre)",
    );
  });

  describe("resolvePackageVersion", () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });
    const writePkg = (content: string): string => {
      const dir = mkdtempSync(join(tmpdir(), "runloop-ver-"));
      dirs.push(dir);
      const p = join(dir, "package.json");
      writeFileSync(p, content);
      return p;
    };

    it("读到合法 package.json 的 version", () => {
      const p = writePkg(JSON.stringify({ version: "9.9.9" }));
      expect(resolvePackageVersion([p])).toBe("9.9.9");
    });

    it("候选全部不存在 → unknown", () => {
      expect(resolvePackageVersion(["/no/such/package.json"])).toBe("unknown");
    });

    it("空候选 → unknown", () => {
      expect(resolvePackageVersion([])).toBe("unknown");
    });

    it("首个不存在/畸形 → 跳到下一个能读的", () => {
      const bad = writePkg("{ not json");
      const good = writePkg(JSON.stringify({ version: "2.0.0" }));
      expect(resolvePackageVersion(["/no/such/package.json", bad, good])).toBe("2.0.0");
    });

    it("有 package.json 但无 version 字段 → unknown", () => {
      const p = writePkg(JSON.stringify({ name: "x" }));
      expect(resolvePackageVersion([p])).toBe("unknown");
    });
  });
});
