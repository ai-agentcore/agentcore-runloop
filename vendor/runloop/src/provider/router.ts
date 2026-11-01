import type { ProviderConfig } from "./types.js";

/**
 * 静态 RouterPolicy（AD-012）：把 inbound model 名映射到具体上游 ProviderConfig（alias 表），
 * 并提供 fallback 链（首选失败时按序尝试下一个）。运行期由 Coordinator 热替换（待 WebSocket 通道）。
 *
 * audit.model_* 不进 24 事件枚举——路由决策经结构化日志（model category）旁路记录（见 AD-022）。
 */
export interface RouteEntry {
  /** 匹配的 model 名（精确或 "*" 通配兜底） */
  match: string;
  config: ProviderConfig;
}

export interface RouterPolicyOptions {
  /** alias 表：按序匹配第一个命中的 match */
  routes: RouteEntry[];
  /** fallback 链：首选 upstream 出错（首 chunk 前）时按序尝试 */
  fallback?: ProviderConfig[];
}

export class RouterPolicy {
  private routes: RouteEntry[];
  private fallback: ProviderConfig[];

  constructor(opts: RouterPolicyOptions) {
    this.routes = opts.routes;
    this.fallback = opts.fallback ?? [];
  }

  /** 单 config 的退化构造（无路由时 proxy 直接用 config） */
  static single(config: ProviderConfig): RouterPolicy {
    return new RouterPolicy({ routes: [{ match: "*", config }] });
  }

  /** 解析 inbound model → 首选 config（精确优先，再 "*" 兜底；都不中回落第一个 route） */
  resolve(model?: string): ProviderConfig {
    if (model) {
      const exact = this.routes.find((r) => r.match === model);
      if (exact) return exact.config;
    }
    const wildcard = this.routes.find((r) => r.match === "*");
    if (wildcard) return wildcard.config;
    if (this.routes[0]) return this.routes[0].config;
    throw new Error("RouterPolicy has no routes");
  }

  /** 首选 + fallback 的完整尝试链（去重，按序） */
  chain(model?: string): ProviderConfig[] {
    const primary = this.resolve(model);
    const seen = new Set<string>();
    const out: ProviderConfig[] = [];
    for (const c of [primary, ...this.fallback]) {
      const key = `${c.baseUrl}::${c.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
    return out;
  }
}
