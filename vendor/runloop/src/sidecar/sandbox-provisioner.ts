import type { Credentials, Resource } from "../types/resources.js";
import { createAgentRunClient, deriveAgentRunEndpoints } from "./agentrun-client.js";
import type { ResourceCallLogger } from "./resource-log.js";

/** 一个运行中的沙箱实例（懒创建产物）。 */
export interface SandboxInstance {
  sandboxId: string;
  /** 数据面 endpoint（拼到 openapiConfig operation 的 path 前作 serverUrl）。 */
  endpoint: string;
}

export type SandboxCreator = (resource: Resource, credentials: Credentials) => Promise<SandboxInstance>;
export type SandboxDeleter = (sandboxId: string, credentials: Credentials) => Promise<void>;

/**
 * 沙箱实例生命周期编排（SANDBOX_TEMPLATE 懒创建）：
 * - resourceType=SANDBOX（运行中实例）：openapiConfig.serverUrl 已指向实例，无需创建 → ensure 返回 ""（用原 serverUrl）。
 * - resourceType=SANDBOX_TEMPLATE（模板，resourceId=模板 id）：首次用到时按模板**懒创建一个实例**、缓存
 *   （同一 provisioner / 会话内复用、多 operation 共享）、把实例 endpoint 作 serverUrl 绑给后续调用；会话结束 recycle 删除。
 *
 * 创建/删除经 DI（creator/deleter）注入——编排逻辑可独立单测；真实 AR 调用见 `createArSandboxProvisioner`。
 */
export class SandboxProvisioner {
  /** key = 模板 resourceId → 已创建实例（懒创建一次、复用）。 */
  private readonly instances = new Map<string, SandboxInstance>();

  constructor(
    private readonly creator: SandboxCreator,
    private readonly deleter: SandboxDeleter,
    /** 可观测：记录沙箱实例创建/回收的耗时埋点（缺省=不记录）。 */
    private readonly log?: ResourceCallLogger,
  ) {}

  /**
   * 确保该资源有可用的实例 endpoint。SANDBOX_TEMPLATE → 懒创建（缓存复用）返回实例 endpoint；
   * 其它（含 SANDBOX 运行中实例）→ 返回 undefined（调用方用 openapiConfig 原 serverUrl）。
   */
  async ensureServerUrl(resource: Resource, credentials: Credentials | undefined): Promise<string | undefined> {
    const inst = await this.ensureInstance(resource, credentials);
    return inst?.endpoint;
  }

  /**
   * 确保该资源有可用实例并返回 `{sandboxId, endpoint}`（远端 shell/file 后端需要 sandboxId 拼数据面 REST path）。
   * SANDBOX_TEMPLATE → 懒创建（缓存复用）；其它（含 SANDBOX 运行中实例）→ undefined（调用方用 resourceId + openapiConfig endpoint）。
   */
  async ensureInstance(resource: Resource, credentials: Credentials | undefined): Promise<SandboxInstance | undefined> {
    if (resource.resourceType !== "SANDBOX_TEMPLATE") return undefined;
    if (!credentials) throw new Error("SANDBOX_TEMPLATE 懒创建需要 credentials");

    const key = resource.resourceId;
    let inst = this.instances.get(key);
    if (!inst) {
      // 创建耗时埋点：start → created(durationMs)/failed(durationMs)，便于算「沙箱冷启动耗时」（懒创建路径）。
      this.log?.info("sandbox create start", { templateId: key });
      const startedAt = Date.now();
      try {
        inst = await this.creator(resource, credentials);
      } catch (err) {
        this.log?.warn("sandbox create failed", { templateId: key, durationMs: Date.now() - startedAt, error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
      this.log?.info("sandbox created", { templateId: key, sandboxId: inst.sandboxId, durationMs: Date.now() - startedAt });
      this.instances.set(key, inst);
    }
    return inst;
  }

  /** 会话结束：删除所有懒创建的实例（best-effort，单个失败不阻断其余）。 */
  async recycleAll(credentials: Credentials | undefined): Promise<void> {
    if (!credentials) {
      this.instances.clear();
      return;
    }
    const entries = [...this.instances.values()];
    this.instances.clear();
    if (entries.length === 0) return;
    // 回收耗时埋点（会话结束删除懒创建实例）。
    const startedAt = Date.now();
    await Promise.all(
      entries.map((inst) => this.deleter(inst.sandboxId, credentials).catch(() => {})),
    );
    this.log?.info("sandbox recycled", { count: entries.length, durationMs: Date.now() - startedAt });
  }

  /** 已创建实例数（测试/可观测用）。 */
  get size(): number {
    return this.instances.size;
  }
}

/**
 * 真实 AR sandbox provisioner —— best-effort，**🚧 字段与就绪语义待真实 AR 校准**：
 * createSandbox(templateId) → 取响应 sandboxId/endpoint；deleteSandbox(sandboxId)。
 * SDK 请求/响应精确 shape 未在代码库确认，故用宽松读取 + `as` 桥接；接通真实 AR 后收紧。
 */
export function createArSandboxProvisioner(log?: ResourceCallLogger): SandboxProvisioner {
  const clientFor = (credentials: Credentials) => {
    const { controlEndpoint } = deriveAgentRunEndpoints(
      credentials.accountId ?? "",
      credentials.region ?? "cn-hangzhou",
    );
    return createAgentRunClient({
      credentials: {
        accessKeyId: credentials.accessKeyId,
        accessKeySecret: credentials.accessKeySecret,
        securityToken: credentials.securityToken,
        region: credentials.region,
      },
      endpoint: controlEndpoint,
    });
  };

  const creator: SandboxCreator = async (resource, credentials) => {
    const client = clientFor(credentials) as unknown as {
      createSandbox: (req: Record<string, unknown>) => Promise<{ body?: Record<string, unknown> } & Record<string, unknown>>;
    };
    const res = await client.createSandbox({ templateId: resource.resourceId });
    const body = (res.body ?? res) as Record<string, unknown>;
    const sandboxId = (body.sandboxId ?? (body.data as Record<string, unknown> | undefined)?.sandboxId) as string | undefined;
    const endpoint = (body.endpoint ?? (body.data as Record<string, unknown> | undefined)?.endpoint) as string | undefined;
    if (!sandboxId || !endpoint) {
      throw new Error("createSandbox 响应缺 sandboxId/endpoint（待真实 AR 校准）");
    }
    return { sandboxId, endpoint };
  };

  const deleter: SandboxDeleter = async (sandboxId, credentials) => {
    const client = clientFor(credentials) as unknown as { deleteSandbox: (id: string) => Promise<unknown> };
    await client.deleteSandbox(sandboxId);
  };

  return new SandboxProvisioner(creator, deleter, log);
}
