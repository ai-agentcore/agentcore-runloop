import { describe, it, expect } from "vitest";
import { rewriteToInternalEndpoint } from "@/sidecar/internal-endpoint.js";

// 收口点：所有出站资源 URL 都过本函数。当前**恒等**（不做公网→VPC 转换，待 P1 dns-mapping 落地再实现）。
describe("rewriteToInternalEndpoint（内网切换收口点）", () => {
  it("当前对任意 URL 恒等返回（不做转换）", () => {
    for (const u of [
      "https://1234567890123456.funagent-data-pre.cn-hangzhou.aliyuncs.com/agent-runtimes/x/endpoints/Default/invocations/ag-ui/agent",
      "https://1234567890123456-ram.funagent-data-pre.cn-hangzhou.aliyuncs.com/sandboxes/sb-1/cmd",
      "https://acct.agentrun-data.cn-hangzhou.aliyuncs.com/tools/calc",
      "https://example.com/anything?x=1",
      "http://127.0.0.1:8080/mcp",
      "",
    ]) {
      expect(rewriteToInternalEndpoint(u)).toBe(u);
    }
  });
});
