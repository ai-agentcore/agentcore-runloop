import { describe, it, expect, vi } from "vitest";
import { SandboxProvisioner, createArSandboxProvisioner, type SandboxInstance } from "@/sidecar/sandbox-provisioner.js";
import type { Resource, Credentials } from "@/types/resources.js";

// mock 真实 AR client，覆盖 createArSandboxProvisioner 的 creator/deleter 与响应解析。
const { createSandbox, deleteSandbox } = vi.hoisted(() => ({ createSandbox: vi.fn(), deleteSandbox: vi.fn() }));
vi.mock("@/sidecar/agentrun-client.js", () => ({
  createAgentRunClient: () => ({ createSandbox, deleteSandbox }),
  deriveAgentRunEndpoints: () => ({ controlEndpoint: "https://ctrl", dataEndpoint: "https://data", effectiveRegion: "cn-hangzhou" }),
}));

const CREDS: Credentials = { accessKeyId: "ak", accessKeySecret: "sk", accountId: "1234567890123456", region: "cn-hangzhou" };

function template(id = "tpl-1"): Resource {
  return {
    resourceId: id, resourceName: "py", resourceType: "SANDBOX_TEMPLATE", protocol: "openapi",
    openapiConfig: { servers: [{ url: "" }], paths: { "/exec": { post: { operationId: "exec" } } } },
  } as Resource;
}
function instance(id = "sbx-1"): Resource {
  return { resourceId: id, resourceName: "py", resourceType: "SANDBOX", protocol: "openapi" } as Resource;
}

describe("SandboxProvisioner（懒创建编排）", () => {
  it("SANDBOX（运行中实例）→ ensureServerUrl 返回 undefined（用 openapiConfig 原 serverUrl）", async () => {
    const creator = vi.fn();
    const p = new SandboxProvisioner(creator as never, vi.fn() as never);
    expect(await p.ensureServerUrl(instance(), CREDS)).toBeUndefined();
    expect(creator).not.toHaveBeenCalled();
  });

  it("SANDBOX_TEMPLATE → 懒创建一次、缓存复用、返回实例 endpoint", async () => {
    const creator = vi.fn(async (): Promise<SandboxInstance> => ({ sandboxId: "sbx-9", endpoint: "https://inst.example.com" }));
    const p = new SandboxProvisioner(creator, vi.fn() as never);

    const url1 = await p.ensureServerUrl(template(), CREDS);
    const url2 = await p.ensureServerUrl(template(), CREDS); // 同模板 → 复用
    expect(url1).toBe("https://inst.example.com");
    expect(url2).toBe("https://inst.example.com");
    expect(creator).toHaveBeenCalledTimes(1);
    expect(p.size).toBe(1);
  });

  it("创建/回收埋点：log 记 sandbox created（含 sandboxId+durationMs）与 sandbox recycled（count+durationMs）", async () => {
    const logs: Array<{ msg: string; fields: Record<string, unknown> }> = [];
    const log = {
      info: (msg: string, f?: Record<string, unknown>) => logs.push({ msg, fields: f ?? {} }),
      warn: (msg: string, f?: Record<string, unknown>) => logs.push({ msg, fields: f ?? {} }),
      error: () => {}, debug: () => {},
    };
    const creator = vi.fn(async (): Promise<SandboxInstance> => ({ sandboxId: "sbx-9", endpoint: "https://i" }));
    const deleter = vi.fn(async () => {});
    const p = new SandboxProvisioner(creator, deleter, log);

    await p.ensureInstance(template("tpl-x"), CREDS);
    await p.recycleAll(CREDS);

    const created = logs.find((l) => l.msg === "sandbox created");
    expect(created).toBeDefined();
    expect(created!.fields).toMatchObject({ templateId: "tpl-x", sandboxId: "sbx-9" });
    expect(typeof created!.fields.durationMs).toBe("number");
    const recycled = logs.find((l) => l.msg === "sandbox recycled");
    expect(recycled!.fields).toMatchObject({ count: 1 });
    expect(typeof recycled!.fields.durationMs).toBe("number");
  });

  it("创建失败也记埋点（sandbox create failed + durationMs）", async () => {
    const logs: Array<{ msg: string; fields: Record<string, unknown> }> = [];
    const log = { info: () => {}, warn: (msg: string, f?: Record<string, unknown>) => logs.push({ msg, fields: f ?? {} }), error: () => {}, debug: () => {} };
    const creator = vi.fn(async (): Promise<SandboxInstance> => { throw new Error("AR create boom"); });
    const p = new SandboxProvisioner(creator, vi.fn() as never, log);
    await expect(p.ensureInstance(template("tpl-e"), CREDS)).rejects.toThrow("AR create boom");
    const failed = logs.find((l) => l.msg === "sandbox create failed");
    expect(failed!.fields).toMatchObject({ templateId: "tpl-e", error: "AR create boom" });
    expect(typeof failed!.fields.durationMs).toBe("number");
  });

  it("不同模板各自创建一次", async () => {
    let n = 0;
    const creator = vi.fn(async (): Promise<SandboxInstance> => ({ sandboxId: `sbx-${++n}`, endpoint: `https://i${n}` }));
    const p = new SandboxProvisioner(creator, vi.fn() as never);
    await p.ensureServerUrl(template("a"), CREDS);
    await p.ensureServerUrl(template("b"), CREDS);
    expect(creator).toHaveBeenCalledTimes(2);
    expect(p.size).toBe(2);
  });

  it("SANDBOX_TEMPLATE 缺 credentials → 抛错", async () => {
    const p = new SandboxProvisioner(vi.fn() as never, vi.fn() as never);
    await expect(p.ensureServerUrl(template(), undefined)).rejects.toThrow(/credentials/);
  });

  it("recycleAll → 对每个实例调 deleter、清空缓存（单个失败不阻断）", async () => {
    const creator = vi.fn(async (r: Resource): Promise<SandboxInstance> => ({ sandboxId: `sbx-${r.resourceId}`, endpoint: "https://i" }));
    const deleter = vi.fn(async (id: string) => { if (id === "sbx-bad") throw new Error("boom"); });
    const p = new SandboxProvisioner(creator, deleter);
    await p.ensureServerUrl(template("ok"), CREDS);
    await p.ensureServerUrl(template("bad"), CREDS);
    expect(p.size).toBe(2);

    await p.recycleAll(CREDS);
    expect(deleter).toHaveBeenCalledWith("sbx-ok", CREDS);
    expect(deleter).toHaveBeenCalledWith("sbx-bad", CREDS);
    expect(p.size).toBe(0);
  });

  it("recycleAll 无 credentials → 仅清缓存、不调 deleter", async () => {
    const creator = vi.fn(async (): Promise<SandboxInstance> => ({ sandboxId: "s", endpoint: "https://i" }));
    const deleter = vi.fn();
    const p = new SandboxProvisioner(creator, deleter as never);
    await p.ensureServerUrl(template(), CREDS);
    await p.recycleAll(undefined);
    expect(deleter).not.toHaveBeenCalled();
    expect(p.size).toBe(0);
  });

  it("ensureInstance: SANDBOX_TEMPLATE → 返回 {sandboxId, endpoint}（远端后端用）；SANDBOX → undefined", async () => {
    const creator = vi.fn(async (): Promise<SandboxInstance> => ({ sandboxId: "sbx-7", endpoint: "https://inst" }));
    const p = new SandboxProvisioner(creator, vi.fn() as never);
    expect(await p.ensureInstance(instance(), CREDS)).toBeUndefined();
    const inst = await p.ensureInstance(template(), CREDS);
    expect(inst).toEqual({ sandboxId: "sbx-7", endpoint: "https://inst" });
    // 复用缓存：第二次不再创建
    await p.ensureInstance(template(), CREDS);
    expect(creator).toHaveBeenCalledTimes(1);
  });
});

describe("createArSandboxProvisioner（真实 AR best-effort）", () => {
  it("creator: createSandbox(templateId) → 取 body.sandboxId/endpoint", async () => {
    createSandbox.mockResolvedValueOnce({ body: { sandboxId: "sbx-77", endpoint: "https://inst-77" } });
    const p = createArSandboxProvisioner();
    const url = await p.ensureServerUrl(template("tpl-x"), CREDS);
    expect(url).toBe("https://inst-77");
    expect(createSandbox).toHaveBeenCalledWith({ templateId: "tpl-x" });
  });

  it("creator: 响应缺 sandboxId/endpoint → 抛错（待真实 AR 校准）", async () => {
    createSandbox.mockResolvedValueOnce({ body: {} });
    const p = createArSandboxProvisioner();
    await expect(p.ensureServerUrl(template(), CREDS)).rejects.toThrow(/sandboxId\/endpoint/);
  });

  it("deleter: recycleAll → deleteSandbox(sandboxId)", async () => {
    createSandbox.mockResolvedValueOnce({ data: { sandboxId: "sbx-9", endpoint: "https://i9" } }); // 兼容 data 包裹
    deleteSandbox.mockResolvedValueOnce({});
    const p = createArSandboxProvisioner();
    await p.ensureServerUrl(template("t9"), CREDS);
    await p.recycleAll(CREDS);
    expect(deleteSandbox).toHaveBeenCalledWith("sbx-9");
  });
});
