import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCore } from "alibabacloud-agentcore-sdk";
import { loadConfig } from "../src/config.js";
import { AgentCoreRuntime, FixtureRuntime, createRuntime } from "../src/runtime.js";

const directories: string[] = [];
const runtimes: AgentCoreRuntime[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const skillWorkspace = await mkdtemp(join(tmpdir(), "agentcore-node-skill-"));
  directories.push(skillWorkspace);
  const completion = vi.fn(async () => ({ choices: [] }));
  const stream = vi.fn(async function* () { yield { choices: [{ delta: { content: "ok" } }] }; });
  const model = { completion, stream };
  const invoke = vi.fn(async (args: Record<string, unknown>) => ({ content: [{ type: "text", text: JSON.stringify(args) }] }));
  const listTools = vi.fn(async (_options?: { signal?: AbortSignal }) => [{ name: "echo", description: "echo", parameters: { type: "object" }, invoke }]);
  const callMcpTool = vi.fn(async (_name: string, args: Record<string, unknown>) => invoke(args));
  const closeMcp = vi.fn(async () => {});
  const managed = vi.fn(async (name: string, options?: { version?: string }) => ({
    name,
    version: options?.version ?? "latest-resolved",
    description: `${name} skill`,
    instruction: "Use this skill",
    root: skillWorkspace,
    files: ["SKILL.md"],
    source: "agentcore" as const,
  }));
  const close = vi.fn(async () => {});
  const core = {
    model: vi.fn(async () => model),
    mcp: vi.fn(async () => ({ listTools, callTool: callMcpTool, close: closeMcp })),
    skills: { managed },
    credentials: { get: vi.fn(async (name: string) => ({ value: `secret:${name}` })) },
    close,
  } as unknown as AgentCore;
  const config = {
    ...loadConfig({ AGENTCORE_MOCK: "true" }),
    mock: false,
    modelConnection: "connection",
    modelName: "qwen",
    mcpServers: ["repo"],
    skills: [{ name: "review", version: "v1.2.0" }, { name: "report" }],
    workspacesDir: skillWorkspace,
    skillWorkspace,
  };
  const timings = vi.fn();
  const runtime = new AgentCoreRuntime(config, core, timings);
  runtimes.push(runtime);
  return { runtime, config, core, model, completion, stream, invoke, listTools, callMcpTool, closeMcp, managed, close, timings };
}

describe("AgentCore Node runtime", () => {
  it("loads model, MCP and versioned Skills once", async () => {
    const f = await fixture();
    const first = await f.runtime.manifest();
    const second = await f.runtime.manifest();
    expect(second).toBe(first);
    expect(f.core.model).toHaveBeenCalledWith("connection", { model: "qwen", timeoutMs: 21600000 });
    expect(f.core.mcp).toHaveBeenCalledWith("repo", expect.objectContaining({ sessionMs: expect.any(Number), metadataMs: expect.any(Number) }));
    expect(f.listTools).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
    expect(f.managed).toHaveBeenNthCalledWith(1, "review", { version: "v1.2.0" });
    expect(f.managed).toHaveBeenNthCalledWith(2, "report", undefined);
    expect(first.skills.map(skill => [skill.name, skill.version])).toEqual([
      ["review", "v1.2.0"],
      ["report", "latest-resolved"],
    ]);
    expect(first.tools.some(tool => tool.name.includes("mcp_repo_echo"))).toBe(true);
    expect(first.tools.some(tool => tool.name.includes("skill_managed_load_skills"))).toBe(true);
    expect(f.timings.mock.calls.map(([timing]) => timing.phase)).toEqual(expect.arrayContaining([
      "model", "mcp", "skill", "skill", "manifest",
    ]));
    expect(f.timings).toHaveBeenCalledTimes(5);
  });

  it("forwards model calls, tool calls and close through the SDK", async () => {
    const f = await fixture();
    const messages = [{ role: "user", content: "hello" }];
    await expect(f.runtime.completion(messages, { temperature: 0 })).resolves.toEqual({ choices: [] });
    const chunks = [];
    for await (const chunk of f.runtime.stream(messages, { top_p: 1 })) chunks.push(chunk);
    expect(chunks).toHaveLength(1);
    const manifest = await f.runtime.manifest();
    const echo = manifest.tools.find(tool => tool.name.includes("mcp_repo_echo"))!;
    await expect(f.runtime.callTool(echo.name, { text: "hello" })).resolves.toMatchObject({ content: expect.any(Array) });
    await expect(f.runtime.callTool("missing", {})).rejects.toThrow("Unknown AgentCore tool");
    await expect(f.runtime.credential("IMAGE_KEY")).resolves.toBe("secret:IMAGE_KEY");
    await f.runtime.close();
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("rejects duplicate SDK tool identities", async () => {
    const f = await fixture();
    vi.mocked(f.listTools).mockResolvedValue([
      { name: "same", description: "one", parameters: {}, invoke: vi.fn() },
      { name: "same", description: "two", parameters: {}, invoke: vi.fn() },
    ] as never);
    await expect(f.runtime.manifest()).rejects.toThrow("Duplicate AgentCore tool identity");
  });

  it("keeps the model available when developer MCP or Skill resources fail to load", async () => {
    const f = await fixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(f.core.mcp).mockRejectedValueOnce(Object.assign(new Error("sensitive MCP failure"), {
      code: "Forbidden.NoPermission", statusCode: 403, requestId: "mcp-request-1",
    }));
    vi.mocked(f.managed).mockRejectedValueOnce(Object.assign(new Error("sensitive Skill failure"), {
      code: "SkillNotFound", status: 404, requestId: "skill-request-1",
    }));

    const manifest = await f.runtime.manifest();
    expect(manifest.model.name).toBe("qwen");
    expect(manifest.skills.map(skill => skill.name)).toEqual(["report"]);
    expect(manifest.resourceWarnings).toEqual([
      { kind: "mcp", resource: "repo", code: "RESOURCE_UNAVAILABLE", diagnostics: {
        stage: "resolve", errorType: "Error", code: "Forbidden.NoPermission", status: 403, requestId: "mcp-request-1",
      } },
      { kind: "skill", resource: "review@v1.2.0", code: "RESOURCE_UNAVAILABLE", diagnostics: {
        errorType: "Error", code: "SkillNotFound", status: 404, requestId: "skill-request-1",
      } },
    ]);
    const logs = log.mock.calls.flat().join("\n");
    expect(logs).toContain('"code":"Forbidden.NoPermission"');
    expect(logs).toContain('"requestId":"skill-request-1"');
    expect(logs).not.toContain("sensitive");
  });

  it("aborts listTools while keeping its reconnectable MCP client when discovery reaches its deadline", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    f.config.mcpDiscoveryTimeoutMs = 25;
    let signal: AbortSignal | undefined;
    vi.mocked(f.listTools).mockImplementation(options => {
      signal = options?.signal;
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal?.reason), { once: true }));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const pending = f.runtime.manifest();
    await vi.advanceTimersByTimeAsync(25);
    const manifest = await pending;

    expect(signal?.aborted).toBe(true);
    expect(f.closeMcp).not.toHaveBeenCalled();
    expect(manifest.resourceWarnings).toContainEqual(expect.objectContaining({
      resource: "repo",
      code: "RESOURCE_TIMEOUT",
      diagnostics: expect.objectContaining({ stage: "list_tools", code: "MCP_DISCOVERY_TIMEOUT" }),
    }));
  });

  it("keeps a late-resolved client for retry without listing tools after the deadline", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    f.config.mcpDiscoveryTimeoutMs = 20;
    const listTools = vi.fn();
    const close = vi.fn(async () => {});
    vi.mocked(f.core.mcp).mockImplementation(async () => new Promise(resolve => {
      setTimeout(() => resolve({ listTools, close } as never), 30);
    }));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const pending = f.runtime.manifest();
    await vi.advanceTimersByTimeAsync(20);
    const manifest = await pending;
    expect(manifest.resourceWarnings).toContainEqual(expect.objectContaining({
      resource: "repo", diagnostics: expect.objectContaining({ stage: "resolve" }),
    }));

    await vi.advanceTimersByTimeAsync(10);
    expect(close).not.toHaveBeenCalled();
    expect(listTools).not.toHaveBeenCalled();
  });

  it("bounds a hanging MCP independently and continues with healthy resources", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    f.config.mcpDiscoveryTimeoutMs = 25;
    f.config.mcpServers = ["repo", "healthy"];
    const hanging = vi.fn(() => new Promise<never>(() => {}));
    const healthy = vi.fn(async () => [{
      name: "healthy_echo", description: "healthy", parameters: { type: "object" }, invoke: vi.fn(),
    }]);
    vi.mocked(f.core.mcp).mockImplementation(async resource => ({
      listTools: resource === "repo" ? hanging : healthy,
      close: vi.fn(async () => {}),
    }) as never);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const pending = f.runtime.manifest();
    await vi.advanceTimersByTimeAsync(25);
    const manifest = await pending;
    expect(manifest.resourceWarnings).toContainEqual({
      kind: "mcp", resource: "repo", code: "RESOURCE_TIMEOUT",
      diagnostics: { stage: "list_tools", errorType: "McpDiscoveryTimeoutError", code: "MCP_DISCOVERY_TIMEOUT" },
    });
    expect(manifest.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: expect.stringContaining("mcp_healthy_healthy_echo") }),
    ]));
    expect(f.timings).toHaveBeenCalledWith(expect.objectContaining({
      phase: "mcp", resource: "repo", status: "timeout", errorCode: "MCP_DISCOVERY_TIMEOUT",
    }));
    expect(log.mock.calls.flat().join("\n")).toContain('"code":"MCP_DISCOVERY_TIMEOUT"');
  });

  it("retries only failed MCP resources with backoff and publishes recovery to later manifests", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    f.config.mcpServers = ["healthy", "recovering"];
    const invoke = vi.fn();
    const attempts = new Map<string, number>();
    vi.mocked(f.core.mcp).mockImplementation(async resource => ({
      close: vi.fn(async () => {}),
      listTools: vi.fn(async () => {
        const attempt = (attempts.get(resource) ?? 0) + 1;
        attempts.set(resource, attempt);
        if (resource === "recovering" && attempt <= 2) throw new Error("temporarily unavailable");
        return [{ name: `${resource}_echo`, description: resource, parameters: {}, invoke }];
      }),
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const degraded = await f.runtime.manifest();
    expect(degraded.resourceWarnings).toContainEqual(expect.objectContaining({ resource: "recovering" }));
    expect(attempts.get("healthy")).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts.get("recovering")).toBe(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(attempts.get("recovering")).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    const recovered = await f.runtime.manifest();

    expect(recovered).not.toBe(degraded);
    expect(recovered.resourceWarnings).not.toContainEqual(expect.objectContaining({ resource: "recovering" }));
    expect(recovered.tools).toContainEqual(expect.objectContaining({
      name: expect.stringContaining("mcp_recovering_recovering_echo"),
    }));
    expect(attempts.get("healthy")).toBe(1);
    expect(attempts.get("recovering")).toBe(3);
    expect(f.core.model).toHaveBeenCalledOnce();
  });

  it("returns after the MCP soft wait and adds a late discovery to the next manifest", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    f.config.mcpInitialWaitMs = 0;
    let finishDiscovery: (() => void) | undefined;
    const lateTool = { name: "late", description: "late", parameters: { type: "object" }, invoke: vi.fn() };
    vi.mocked(f.listTools).mockImplementation(() => new Promise(resolve => {
      finishDiscovery = () => resolve([lateTool]);
    }));

    const pending = f.runtime.manifest();
    await vi.advanceTimersByTimeAsync(0);
    const warming = await pending;
    expect(warming.tools).not.toContainEqual(expect.objectContaining({ name: expect.stringContaining("mcp_repo_late") }));
    expect(warming.resourceWarnings).toContainEqual(expect.objectContaining({
      resource: "repo", code: "RESOURCE_WARMING",
    }));

    finishDiscovery?.();
    await vi.advanceTimersByTimeAsync(0);
    const refreshed = await f.runtime.manifest();
    expect(refreshed.tools).toContainEqual(expect.objectContaining({ name: expect.stringContaining("mcp_repo_late") }));
    expect(refreshed.resourceWarnings).not.toContainEqual(expect.objectContaining({ resource: "repo" }));
  });

  it("uses the last successful MCP manifest immediately and lazily connects on tool call", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    f.config.mcpInitialWaitMs = 0;
    const cacheFile = join(f.config.workspacesDir, ".agentcore-mcp-tools-v1.json");
    await writeFile(cacheFile, JSON.stringify({
      version: 1,
      resources: {
        repo: {
          updatedAt: "2026-09-30T00:00:00.000Z",
          tools: [{ name: "cached", description: "cached tool", inputSchema: { type: "object" } }],
        },
      },
    }));
    vi.mocked(f.listTools).mockImplementation(() => new Promise(() => {}));

    const pending = f.runtime.manifest();
    await vi.advanceTimersByTimeAsync(0);
    const manifest = await pending;
    const cached = manifest.tools.find(tool => tool.name.includes("mcp_repo_cached"));
    expect(cached).toBeDefined();

    await f.runtime.callTool(cached!.name, { value: 1 });
    expect(f.invoke).toHaveBeenCalledWith({ value: 1 });
  });

  it("distinguishes resolve, connect, and list_tools MCP diagnostics", async () => {
    const f = await fixture();
    f.config.mcpServers = ["resolve", "connect", "list"];
    vi.mocked(f.core.mcp).mockImplementation(async resource => {
      if (resource === "resolve") throw new Error("resolve failed");
      return {
        close: vi.fn(async () => {}),
        listTools: vi.fn(async () => {
          if (resource === "connect") throw new Error("MCP session open timed out");
          throw new Error("list failed");
        }),
      } as never;
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const manifest = await f.runtime.manifest();

    expect(manifest.resourceWarnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ resource: "resolve", diagnostics: expect.objectContaining({ stage: "resolve" }) }),
      expect.objectContaining({ resource: "connect", diagnostics: expect.objectContaining({ stage: "connect" }) }),
      expect.objectContaining({ resource: "list", diagnostics: expect.objectContaining({ stage: "list_tools" }) }),
    ]));
  });

  it("applies discovery timeout overrides independently by MCP resource name", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    f.config.mcpDiscoveryTimeoutMs = 100;
    f.config.mcpDiscoveryTimeouts = { fast: 20, slow: 50 };
    f.config.mcpServers = ["fast", "slow"];
    vi.mocked(f.core.mcp).mockImplementation(async resource => ({
      listTools: vi.fn(() => new Promise(resolve => setTimeout(() => resolve([{
        name: `${resource}_echo`, description: resource, parameters: {}, invoke: vi.fn(),
      }]), 30))),
      close: vi.fn(async () => {}),
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const pending = f.runtime.manifest();
    await vi.advanceTimersByTimeAsync(30);
    const manifest = await pending;

    expect(manifest.resourceWarnings).toContainEqual(expect.objectContaining({
      kind: "mcp", resource: "fast", code: "RESOURCE_TIMEOUT",
    }));
    expect(manifest.resourceWarnings).not.toContainEqual(expect.objectContaining({ resource: "slow" }));
    expect(manifest.tools).toContainEqual(expect.objectContaining({
      name: expect.stringContaining("mcp_slow_slow_echo"),
    }));
  });

  it("retries required model initialization and exposes safe diagnostics", async () => {
    const f = await fixture();
    const modelError = Object.assign(new Error("temporary model failure"), {
      code: "Forbidden.Model", statusCode: 403, requestId: "model-request-1",
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(f.core.model).mockRejectedValueOnce(modelError).mockResolvedValueOnce(f.model as never);
    await expect(f.runtime.manifest()).rejects.toMatchObject({ code: "MODEL_RESOURCE_NOT_READY", cause: modelError });
    await expect(f.runtime.manifest()).resolves.toMatchObject({ model: { name: "qwen" } });
    expect(f.timings).toHaveBeenCalledWith(expect.objectContaining({
      phase: "model", status: "error", errorCode: "Forbidden.Model", errorStatus: 403,
      errorRequestId: "model-request-1",
    }));
  });

  it("provides a pure Node fixture runtime", async () => {
    const runtime = new FixtureRuntime();
    const manifest = await runtime.manifest();
    expect(manifest.model.name).toBe("fixture-model");
    const completion = await runtime.completion([{ role: "user", content: "hi" }]);
    expect(completion.object).toBe("chat.completion");
    const chunks = [];
    for await (const chunk of runtime.stream([])) chunks.push(chunk);
    expect(chunks).toHaveLength(2);
    await expect(runtime.callTool(manifest.tools[0].name, { ok: true })).resolves.toMatchObject({ isError: false });
    await expect(runtime.callTool("missing", {})).rejects.toThrow();
    await runtime.close();
    expect(createRuntime(loadConfig({ AGENTCORE_MOCK: "true" }))).toBeInstanceOf(FixtureRuntime);
  });
});

describe("AgentCore production runtime", () => {
  it("uses the Node SDK", () => {
    const config = loadConfig({
      AGENTCORE_MODEL_CONNECTION: "managed",
      AGENTCORE_MODEL_NAME: "qwen",
    });
    expect(createRuntime(config)).toBeInstanceOf(AgentCoreRuntime);
  });
});
