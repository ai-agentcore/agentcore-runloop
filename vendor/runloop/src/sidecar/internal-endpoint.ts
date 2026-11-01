/**
 * 出站资源 URL 的「公网 → 内网(VPC)」转换**收口点**（尝试切换为内网地址访问）。
 *
 * 定调（2026-06）：上游一律下发**公网**数据面 endpoint；当 runloop 与目标资源在**同 region**（按 `FC_REGION`
 * 判断）时，应自动把公网 host 改写成对应的 VPC 内网 host，走内网（更快、不出公网）。**所有出站资源调用 URL
 * （子 agent 委派 / openapi 工具 / 下游 MCP / 远端沙箱 / SKILL 下载）都收口到本函数**——将来要开启内网切换，
 * 只改这一处。
 *
 * ⚠ **当前不做任何转换（恒等返回）**。原因：VPC host（如 `agentrun-data-vpc.cn-hangzhou.aliyuncs.com`）
 * **只有在 dns-mapping + NLB 配齐时才可解析**（= CLAUDE.md「runloop FC 打通 agentrun 数据面 VPC」P1 项，
 * 尚未落地）；**单纯把 host 改成 VPC 而不配 dns-mapping 会 fetch failed**，比走公网更糟。故先把所有 URL 收口
 * 到这里、保持恒等，待 P1 落地后**仅在本函数内**实现真正的转换：
 *   1. 解析 url host；仅当它是 agentrun 数据面**公网**域名（`funagent-data-pre` / `agentrun-data` 等）才考虑转换；
 *   2. 取 host 的 region 段与 `process.env.FC_REGION` 比对，**同 region 才改写**（跨 region 仍走公网）；
 *   3. 公网域名 → VPC 域名（`agentrun-data-vpc.<region>`）；签名/SNI 一致性按 dns-mapping 方案处理；
 *   4. 非 agentrun / 外部 / 跨 region 的 URL 原样返回。
 *
 * @param url 出站 URL（通常已是签名后的最终 URL）。
 * @returns 转换后的 URL（**当前 === 入参**）。
 */
export function rewriteToInternalEndpoint(url: string): string {
  // TODO(P1 · VPC 内网): 同 region 时公网 host → VPC host 改写。
  // 必须与 dns-mapping/NLB 同批落地，否则 VPC host 不可解析 → fetch failed。
  return url;
}
