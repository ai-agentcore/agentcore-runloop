import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parsePasswd,
  resolveAgentUser,
  buildSandboxEnv,
  chownRecursive,
  type AgentUser,
} from "@/acp/sandbox-user.js";

const CODER: AgentUser = { name: "coder", uid: 1000, gid: 1000, home: "/home/coder" };

describe("parsePasswd", () => {
  const passwd = [
    "root:x:0:0:root:/root:/bin/bash",
    "coder:x:1000:1000::/home/coder:/bin/bash",
    "# a comment",
    "",
  ].join("\n");

  it("extracts uid/gid/home for the target user", () => {
    expect(parsePasswd(passwd, "coder")).toEqual(CODER);
  });

  it("returns null for an unknown user", () => {
    expect(parsePasswd(passwd, "nobodyhere")).toBeNull();
  });

  it("falls back to /home/<name> when home field empty", () => {
    expect(parsePasswd("x:x:5:5::", "x")?.home).toBe("/home/x");
  });

  it("returns null on non-numeric uid/gid", () => {
    expect(parsePasswd("bad:x:abc:def::/h:/bin/sh", "bad")).toBeNull();
  });
});

describe("resolveAgentUser", () => {
  it("does not drop privilege when explicitly disabled", () => {
    expect(resolveAgentUser({ enabled: "off" })).toBeNull();
    expect(resolveAgentUser({ enabled: "0" })).toBeNull();
    expect(resolveAgentUser({ enabled: "false" })).toBeNull();
  });

  it("does not drop privilege when the process is not root (dev/test)", () => {
    // mock 成非 root → 返回 null（不依赖测试进程真实 uid，容器内以 root 运行时也成立）
    const proc = process as NodeJS.Process & { getuid?: () => number };
    const orig = proc.getuid;
    proc.getuid = () => 1000;
    try {
      expect(resolveAgentUser()).toBeNull();
    } finally {
      proc.getuid = orig;
    }
  });

  it("returns null for a missing user even when root", () => {
    const proc = process as NodeJS.Process & { getuid?: () => number };
    const orig = proc.getuid;
    proc.getuid = () => 0;
    try {
      expect(resolveAgentUser({ user: "___definitely_not_a_user___" })).toBeNull();
    } finally {
      proc.getuid = orig;
    }
  });
});

describe("buildSandboxEnv", () => {
  it("keeps allowlisted vars + forces HOME/USER, and drops platform secrets", () => {
    const source: NodeJS.ProcessEnv = {
      PATH: "/usr/local/bin:/usr/bin",
      GOPROXY: "https://goproxy.cn,direct",
      MAMBA_ROOT_PREFIX: "/opt/micromamba",
      HOME: "/root",
      // 平台密钥——绝不应进入 codex 的 env
      WEB_SEARCH_API_KEY: "sk-platform-secret",
      ACCESS_KEY_SECRET: "ak-secret",
      SOME_TOKEN: "tok",
      AWS_SECRET_ACCESS_KEY: "aws",
    };
    const env = buildSandboxEnv(
      { CODEX_HOME: "/ws/.runloop/codex-home", OPENAI_API_KEY: "runloop-proxy" },
      CODER,
      source,
    );

    expect(env.PATH).toBe("/usr/local/bin:/usr/bin");
    expect(env.GOPROXY).toBe("https://goproxy.cn,direct");
    expect(env.MAMBA_ROOT_PREFIX).toBe("/opt/micromamba");
    expect(env.HOME).toBe("/home/coder");
    expect(env.USER).toBe("coder");
    expect(env.LOGNAME).toBe("coder");
    // 适配器自身 env 透传
    expect(env.CODEX_HOME).toBe("/ws/.runloop/codex-home");
    expect(env.OPENAI_API_KEY).toBe("runloop-proxy");
    // 密钥被剔除
    expect(env.WEB_SEARCH_API_KEY).toBeUndefined();
    expect(env.ACCESS_KEY_SECRET).toBeUndefined();
    expect(env.SOME_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it("falls back to a sane PATH when source has none", () => {
    const env = buildSandboxEnv({}, CODER, {});
    expect(env.PATH).toContain("/usr/local/bin");
  });
});

describe("chownRecursive", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("walks a tree without throwing (chown to current uid is a no-op)", async () => {
    dir = await mkdtemp(join(tmpdir(), "chown-test-"));
    await writeFile(join(dir, "a.txt"), "x");
    const proc = process as NodeJS.Process & { getuid?: () => number; getgid?: () => number };
    const uid = proc.getuid ? proc.getuid() : 0;
    const gid = proc.getgid ? proc.getgid() : 0;
    await expect(chownRecursive(dir, uid, gid)).resolves.toBeUndefined();
  });
});
