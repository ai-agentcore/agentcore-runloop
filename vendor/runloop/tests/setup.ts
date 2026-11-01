import { beforeEach } from "vitest";
import { __setSsrfLookupForTest } from "@/sidecar/ssrf.js";

// 全局：SSRF 守卫（H1）对非 agentrun 出站 URL 会做真实 DNS 解析。单测里默认注入假解析器返公网 IP
// （TEST-NET-3 203.0.113.0/24，不在受限范围），避免每个走 callOpenapiTool/callSubAgent/mcp-proxy 的
// 测试都依赖真实网络 DNS（fake host 会解析失败被拦）。需要测“拦截私网/rebinding”的用例在用例内
// 调用 __setSsrfLookupForTest 覆盖即可（本 beforeEach 在各文件 beforeEach 之前运行）。
beforeEach(() => {
  __setSsrfLookupForTest(async () => [{ address: "203.0.113.1" }]);
});
