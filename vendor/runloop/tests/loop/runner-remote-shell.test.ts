import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { rm, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LoopRunner } from "@/loop/runner.js";
import { EventType, type RunloopEvent } from "@/types/events.js";
import { createEvent } from "@/events/factory.js";
import type { RunRequest } from "@/types/api.js";
import type { Resource } from "@/types/resources.js";

// 部署形态门控（AGENTCORE_REMOTE_SHELL）的观测信号：workspace AGENTS.md 是否含 EXEC_TOOLS_PROMPT
// （「## 执行与文件工具」段，仅当注入了 bash/file 工具才追加）。cli/echo adapter 不会真调工具，安全。
const EXEC_MARKER = "## 执行与文件工具";

async function collect(gen: AsyncGenerator<RunloopEvent>): Promise<RunloopEvent[]> {
  const events: RunloopEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function makeRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    agent: { cli: "codex" },
    events: [createEvent(EventType.UserMessage, "s1", { content: "hi", role: "user" })],
    model: { provider: "test", model: "m", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" },
    credentials: { accessKeyId: "ak", accessKeySecret: "sk", accountId: "1234567890123456", region: "cn-hangzhou" },
    ...overrides,
  };
}

const SANDBOX: Resource = {
  resourceId: "sbx-1", resourceName: "py", resourceType: "SANDBOX", protocol: "openapi", description: "sandbox",
  openapiConfig: { openapi: "3.0.0", servers: [{ url: "https://tools.example.com" }], paths: {} },
} as Resource;

const FUNCTIONCALL: Resource = {
  resourceId: "fc1", resourceName: "calc", resourceType: "FUNCTIONCALL", protocol: "openapi", description: "calc",
  openapiConfig: { openapi: "3.0.0", servers: [{ url: "https://api.calc" }], paths: { "/calc": { post: { operationId: "calc" } } } },
} as Resource;

// 带显式数据面 operation 的 SANDBOX（上游下发后的形态）：作为执行后端时，这些 operation 不应再暴露为模型工具。
const SANDBOX_WITH_OPS: Resource = {
  resourceId: "sbx-9", resourceName: "pybox", resourceType: "SANDBOX", protocol: "openapi", description: "sandbox",
  openapiConfig: {
    openapi: "3.0.0",
    servers: [{ url: "https://tools.example.com" }],
    paths: {
      "/sandboxes/{id}/processes/cmd": { post: { operationId: "exec" } },
      "/sandboxes/{id}/files": { get: { operationId: "read_file" }, post: { operationId: "write_file" } },
      "/sandboxes/{id}/filesystem": { get: { operationId: "list_directory" } },
      "/sandboxes/{id}/filesystem/mkdir": { post: { operationId: "mkdir" } },
    },
  },
  auth: { mode: "none" },
} as Resource;

// 下载 server 指向 127.0.0.1:1 → 签名下载瞬时失败（ECONNREFUSED）回落 frontmatter-only，
// 不依赖网络也不拖慢单测；skill 提示词段仍由资源 meta 渲染（与下载成败无关）。
const SKILL: Resource = {
  resourceId: "sk1", resourceName: "review", resourceType: "SKILL", protocol: "openapi", description: "审查代码",
  openapiConfig: { openapi: "3.0.0", servers: [{ url: "http://127.0.0.1:1" }], paths: { "/tools/review/download": { get: { operationId: "download" } } } },
  auth: { mode: "none" },
} as Resource;

function agentsMd(workspacesDir: string, conv: string): string {
  const p = join(workspacesDir, conv, "AGENTS.md");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

describe("LoopRunner - AGENTCORE_REMOTE_SHELL 门控", () => {
  const dirs: string[] = [];
  const prevEnv = process.env.AGENTCORE_REMOTE_SHELL;

  afterEach(async () => {
    if (prevEnv === undefined) delete process.env.AGENTCORE_REMOTE_SHELL;
    else process.env.AGENTCORE_REMOTE_SHELL = prevEnv;
    for (const d of dirs) { try { await rm(d, { recursive: true, force: true }); } catch {} }
    dirs.length = 0;
  });

  async function runWith(opts: { remote: boolean; resources?: Resource[]; conv: string }): Promise<string> {
    if (opts.remote) process.env.AGENTCORE_REMOTE_SHELL = "1";
    else delete process.env.AGENTCORE_REMOTE_SHELL;
    const workspacesDir = await mkdtemp(join(tmpdir(), "runloop-rs-"));
    dirs.push(workspacesDir);
    const runner = new LoopRunner({ agentRegistry: { codex: { command: new URL("../fixtures/mock-agent-cli.sh", import.meta.url).pathname } }, defaultAdapterType: "codex", workspacesDir });
    await collect(runner.run(makeRequest({ conversationId: opts.conv, resources: opts.resources })));
    return agentsMd(workspacesDir, opts.conv);
  }




  it("系统实例 + 无 Sandbox（仅 FunctionCall）→ 不注入执行/文件工具（零执行能力）", async () => {
    const md = await runWith({ remote: true, resources: [FUNCTIONCALL], conv: "rs-nosb" });
    expect(md).not.toContain(EXEC_MARKER);
    // 但平台工具仍在（sidecar 起来了、AGENTS.md 非空）
    expect(md.length).toBeGreaterThan(0);
  });

  it("系统实例 + 无 Sandbox + SKILL + FunctionCall → 零执行，但 skill / 平台工具仍可加载", async () => {
    // AD-033 关键不变量：无 shell（零执行）下 skill 仍可加载、平台工具仍可调，只丢本地执行能力。
    const md = await runWith({ remote: true, resources: [SKILL, FUNCTIONCALL], conv: "rs-skill" });
    // ① 执行/文件工具不注入（零执行）。
    expect(md).not.toContain(EXEC_MARKER);
    // ② skill 仍可加载：系统提示词渲染 skill 段 + 明确 get_skill「任何环境都可用，无需 shell」。
    expect(md).toContain("## 已装入的 Skill");
    expect(md).toContain("get_skill");
    expect(md).toContain("无需 shell");
    // 零执行态不注入 list_skill，也不出 shell 目录引导段。
    expect(md).not.toContain("list_skill");
    expect(md).not.toContain("Skill 文件访问");
    // ③ 平台工具仍在：FunctionCall 段被渲染。
    expect(md).toContain("## 平台工具");
  });

  it("用户实例（默认，无 env）→ 维持原行为：execViaMcp 默认开，注入执行/文件工具", async () => {
    const md = await runWith({ remote: false, conv: "us-default" });
    expect(md).toContain(EXEC_MARKER);
  });

  it("有 shell（用户实例默认 execViaMcp）+ SKILL → 执行/文件工具 + skill 读取走 read_file（不透出 get_skill，Change A）", async () => {
    const md = await runWith({ remote: false, resources: [SKILL], conv: "us-skill" });
    expect(md).toContain(EXEC_MARKER); // 有文件/执行能力
    expect(md).toContain("## 已装入的 Skill"); // 基础 skill 段
    // 有 shell：skill 读取用标准 read_file 读磁盘 SKILL.md，不透出 get_skill（与执行层读法统一）。
    expect(md).toContain(".agents/skills/");
    expect(md).toContain("read_file");
    expect(md).not.toContain("get_skill");
    expect(md).not.toContain("## Skill 文件访问"); // 旧 skillDirPrompt 段已移除（折叠进 skillsSection）
  });



  it("用户实例 + features.execViaMcp=false → 不注入（走 agent CLI 内建 shell）", async () => {
    delete process.env.AGENTCORE_REMOTE_SHELL;
    const workspacesDir = await mkdtemp(join(tmpdir(), "runloop-rs-"));
    dirs.push(workspacesDir);
    const runner = new LoopRunner({ agentRegistry: { codex: { command: new URL("../fixtures/mock-agent-cli.sh", import.meta.url).pathname } }, defaultAdapterType: "codex", workspacesDir });
    await collect(runner.run(makeRequest({ conversationId: "us-off", features: { execViaMcp: false } })));
    // 无资源 + execViaMcp=false → 不建 workspace 工具，AGENTS.md 不含执行段
    expect(agentsMd(workspacesDir, "us-off")).not.toContain(EXEC_MARKER);
  });

  it("按 conversation 注入执行后端时无需 SANDBOX resource 也启用隔离执行", async () => {
    delete process.env.AGENTCORE_REMOTE_SHELL;
    const workspacesDir = await mkdtemp(join(tmpdir(), "runloop-rs-"));
    dirs.push(workspacesDir);
    const runner = new LoopRunner({ agentRegistry: { codex: { command: new URL("../fixtures/mock-agent-cli.sh", import.meta.url).pathname } }, defaultAdapterType: "codex", workspacesDir });
    const backend = { shell: vi.fn(), file: vi.fn(), interrupt: vi.fn(async () => {}) };
    runner.setExecutionBackend("injected", backend);
    await collect(runner.run(makeRequest({ conversationId: "injected", features: { execViaMcp: false } })));
    const md = agentsMd(workspacesDir, "injected");
    expect(md).toContain(EXEC_MARKER);
    expect(md).toContain("## 执行环境（隔离沙箱）");
    expect(md).toContain(".agents/skills/");
  });
});
