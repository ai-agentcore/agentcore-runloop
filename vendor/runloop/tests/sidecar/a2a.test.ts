import { describe, expect, it } from "vitest";
import {
  buildA2aRequestBody,
  buildA2aResumeBody,
  unwrapA2aResult,
  a2aPartsText,
  a2aMessageText,
  isA2aInputRequired,
  isA2aCompleted,
  isA2aFailed,
  extractA2aText,
  extractA2aError,
  isA2aCardUrl,
  extractA2aCardEndpoint,
  deriveA2aBaseFromCardUrl,
  chooseA2aServiceEndpoint,
} from "@/sidecar/a2a.js";

describe("a2a — 协议助手", () => {
  describe("buildA2aRequestBody", () => {
    it("构造 JSON-RPC message/stream 请求（role=user、text part、随机 messageId）", () => {
      const body = JSON.parse(buildA2aRequestBody("你好"));
      expect(body.jsonrpc).toBe("2.0");
      expect(body.method).toBe("message/stream");
      expect(body.params.message.role).toBe("user");
      expect(body.params.message.kind).toBe("message");
      expect(body.params.message.parts).toEqual([{ kind: "text", text: "你好" }]);
      expect(typeof body.params.message.messageId).toBe("string");
      expect(body.params.message.messageId.length).toBeGreaterThan(0);
      expect(typeof body.id).toBe("string");
    });
  });

  describe("buildA2aResumeBody", () => {
    it("带 resolve + suspend(taskId) → message/stream 续发，带审批文本与 taskId", () => {
      const body = JSON.parse(buildA2aResumeBody([
        { type: "toolcall.suspend", toolCallId: "task-9" },
        { type: "user.command", command: "resolve", selectedOptionId: "approve" },
      ]));
      expect(body.method).toBe("message/stream");
      expect(body.params.message.taskId).toBe("task-9");
      expect(body.params.message.parts[0].text).toContain("approve");
    });

    it("resolve.payload.input 存在 → 用它作为续接输入（A2A input-required 的真实输入优先于审批决策文本）", () => {
      const body = JSON.parse(buildA2aResumeBody([
        { type: "toolcall.suspend", toolCallId: "task-7" },
        { type: "user.command", command: "resolve", selectedOptionId: "approve", payload: { input: "用方案 B，预算 1000" } },
      ]));
      expect(body.params.message.parts[0].text).toBe("用方案 B，预算 1000");
      expect(body.params.message.taskId).toBe("task-7");
    });

    it("无 resolve / 无 suspend → 默认 continue 文本、不带 taskId", () => {
      const body = JSON.parse(buildA2aResumeBody([]));
      expect(body.params.message.parts[0].text).toBe("continue");
      expect(body.params.message.taskId).toBeUndefined();
    });

    it("resumeEvents 为 undefined → 不抛、回落 continue", () => {
      const body = JSON.parse(buildA2aResumeBody(undefined as unknown as unknown[]));
      expect(body.params.message.parts[0].text).toBe("continue");
    });
  });

  describe("unwrapA2aResult", () => {
    it("有 result 对象 → 解包；无 result → 原样", () => {
      expect(unwrapA2aResult({ jsonrpc: "2.0", result: { kind: "message" } })).toEqual({ kind: "message" });
      expect(unwrapA2aResult({ kind: "message" })).toEqual({ kind: "message" });
      // result 为非对象（如字符串）→ 不解包，返回原 event
      expect(unwrapA2aResult({ result: "x", kind: "task" })).toEqual({ result: "x", kind: "task" });
    });
  });

  describe("a2aPartsText / a2aMessageText", () => {
    it("拼接文本 part、非数组 → 空", () => {
      expect(a2aPartsText([{ kind: "text", text: "a" }, { kind: "text", text: "b" }])).toBe("ab");
      expect(a2aPartsText([])).toBe("");
      expect(a2aPartsText(undefined)).toBe("");
      expect(a2aPartsText("not-array")).toBe("");
    });
    it("多模态 part：file → 文本引用（name/mimeType/uri，不 dump bytes）、data → 紧凑 JSON", () => {
      expect(a2aPartsText([{ kind: "file", file: { name: "a.png", mimeType: "image/png", uri: "https://x/a.png" } }]))
        .toBe("[file: a.png (image/png) https://x/a.png]");
      // 仅 bytes（无 uri/name）：不 dump base64，给 mediaType + 标注 inline
      expect(a2aPartsText([{ kind: "file", file: { mimeType: "image/png", bytes: "QUJDRA==" } }]))
        .toBe("[file: file (image/png) inline]");
      // data part → 紧凑 JSON
      expect(a2aPartsText([{ kind: "data", data: { x: 1, y: "z" } }])).toBe('{"x":1,"y":"z"}');
      // 文本 + 文件 + data 混合按序拼接
      expect(a2aPartsText([{ kind: "text", text: "见图 " }, { kind: "file", file: { name: "r.json", uri: "u" } }]))
        .toBe("见图 [file: r.json u]");
    });
    it("a2aMessageText：从 message.parts 取；非对象 → 空", () => {
      expect(a2aMessageText({ role: "agent", parts: [{ kind: "text", text: "hi" }] })).toBe("hi");
      expect(a2aMessageText(undefined)).toBe("");
      expect(a2aMessageText("x")).toBe("");
    });
  });

  describe("TaskState 判定（kebab-case + gRPC 大写枚举）", () => {
    it("isA2aInputRequired", () => {
      expect(isA2aInputRequired("input-required")).toBe(true);
      expect(isA2aInputRequired("auth-required")).toBe(true);
      expect(isA2aInputRequired("TASK_STATE_INPUT_REQUIRED")).toBe(true);
      expect(isA2aInputRequired("TASK_STATE_AUTH_REQUIRED")).toBe(true);
      expect(isA2aInputRequired("working")).toBe(false);
      expect(isA2aInputRequired(undefined)).toBe(false);
    });
    it("isA2aCompleted", () => {
      expect(isA2aCompleted("completed")).toBe(true);
      expect(isA2aCompleted("TASK_STATE_COMPLETED")).toBe(true);
      expect(isA2aCompleted("working")).toBe(false);
    });
    it("isA2aFailed", () => {
      for (const s of ["failed", "rejected", "canceled", "TASK_STATE_FAILED", "TASK_STATE_REJECTED", "TASK_STATE_CANCELED"]) {
        expect(isA2aFailed(s)).toBe(true);
      }
      expect(isA2aFailed("completed")).toBe(false);
      expect(isA2aFailed(undefined)).toBe(false);
    });
  });

  describe("extractA2aText", () => {
    const wrap = (result: Record<string, unknown>) => ({ jsonrpc: "2.0", result });
    it("message / artifact-update / status-update(working).message 取文本", () => {
      expect(extractA2aText(wrap({ kind: "message", parts: [{ kind: "text", text: "m" }] }))).toBe("m");
      expect(extractA2aText(wrap({ kind: "artifact-update", artifact: { parts: [{ kind: "text", text: "a" }] } }))).toBe("a");
      expect(extractA2aText(wrap({ kind: "status-update", status: { state: "working", message: { parts: [{ kind: "text", text: "s" }] } } }))).toBe("s");
    });
    it("input-required / 失败终态 / task / 未知 → 空串", () => {
      expect(extractA2aText(wrap({ kind: "status-update", status: { state: "input-required", message: { parts: [{ kind: "text", text: "x" }] } } }))).toBe("");
      expect(extractA2aText(wrap({ kind: "status-update", status: { state: "failed", message: { parts: [{ kind: "text", text: "x" }] } } }))).toBe("");
      expect(extractA2aText(wrap({ kind: "task", status: { state: "working" } }))).toBe("");
      expect(extractA2aText(wrap({ kind: "heartbeat" }))).toBe("");
    });
  });

  describe("extractA2aError", () => {
    it("JSON-RPC error 信封 → message（缺 message 用 code 兜底）", () => {
      expect(extractA2aError({ jsonrpc: "2.0", error: { code: -32603, message: "boom" } })).toBe("boom");
      expect(extractA2aError({ jsonrpc: "2.0", error: { code: -32000 } })).toBe("a2a error -32000");
    });
    it("失败终态 → status.message 文本，缺则 state 兜底", () => {
      expect(extractA2aError({ result: { kind: "status-update", status: { state: "failed", message: { parts: [{ kind: "text", text: "503" }] } } } })).toBe("503");
      expect(extractA2aError({ result: { kind: "task", status: { state: "rejected" } } })).toBe("sub-agent task rejected");
    });
    it("非错误事件 → undefined", () => {
      expect(extractA2aError({ result: { kind: "message", parts: [{ kind: "text", text: "hi" }] } })).toBeUndefined();
      expect(extractA2aError({ result: { kind: "status-update", status: { state: "working" } } })).toBeUndefined();
    });
  });

  describe("agent-card 发现", () => {
    it("isA2aCardUrl：识别 well-known card URL（新/旧路径）", () => {
      expect(isA2aCardUrl("https://h/.well-known/agent-card.json")).toBe(true);
      expect(isA2aCardUrl("https://h/.well-known/agent.json")).toBe(true);
      expect(isA2aCardUrl("https://h/foo/agent-card.json?x=1")).toBe(true);
      expect(isA2aCardUrl("https://h/a2a")).toBe(false);
      expect(isA2aCardUrl("https://h/invoke")).toBe(false);
    });
    it("extractA2aCardEndpoint：取 card.url，兼容 additionalInterfaces/endpoints，无则 undefined", () => {
      expect(extractA2aCardEndpoint({ url: "https://svc/a2a" })).toBe("https://svc/a2a");
      expect(extractA2aCardEndpoint({ additionalInterfaces: [{ transport: "JSONRPC", url: "https://svc/jr" }] })).toBe("https://svc/jr");
      expect(extractA2aCardEndpoint({ endpoints: [{ uri: "https://svc/ep" }] })).toBe("https://svc/ep");
      // url 优先于 additionalInterfaces
      expect(extractA2aCardEndpoint({ url: "https://svc/primary", additionalInterfaces: [{ url: "https://svc/jr" }] })).toBe("https://svc/primary");
      expect(extractA2aCardEndpoint({ name: "no url" })).toBeUndefined();
      expect(extractA2aCardEndpoint(null)).toBeUndefined();
      expect(extractA2aCardEndpoint("not-object")).toBeUndefined();
    });
  });

  describe("平台托管端点回退（localhost card.url，L-052）", () => {
    const PLATFORM_CARD =
      "https://acct.funagent-data-pre.cn-hangzhou.aliyuncs.com/agent-runtimes/bot/endpoints/Default/invocations/.well-known/agent-card.json";
    const PLATFORM_BASE =
      "https://acct.funagent-data-pre.cn-hangzhou.aliyuncs.com/agent-runtimes/bot/endpoints/Default/invocations";

    it("deriveA2aBaseFromCardUrl：去掉 well-known agent-card 后缀，返回 invocations 基址", () => {
      expect(deriveA2aBaseFromCardUrl(PLATFORM_CARD)).toBe(PLATFORM_BASE);
      expect(deriveA2aBaseFromCardUrl("https://x.aliyuncs.com/foo/.well-known/agent.json")).toBe("https://x.aliyuncs.com/foo");
      expect(deriveA2aBaseFromCardUrl("https://x.aliyuncs.com/foo/")).toBe("https://x.aliyuncs.com/foo");
    });

    it("chooseA2aServiceEndpoint 平台托管（agentrun）：忽略 card 内 localhost url，改用 cardUrl 的 invocations 基址", () => {
      // 平台托管 a2a 在容器内 listen localhost:9000、AgentCard.url 也写 localhost（不可外部访问）；
      // 对外经数据面 invocations 反代。故端点须用 cardUrl 基址，否则取 card.url=localhost → SSRF 拦。
      const card = { url: "http://localhost:9000", capabilities: { streaming: true } };
      expect(chooseA2aServiceEndpoint(card, PLATFORM_CARD, "agentrun")).toBe(PLATFORM_BASE);
      // card 无 url 也回退基址
      expect(chooseA2aServiceEndpoint({}, PLATFORM_CARD, "agentrun")).toBe(PLATFORM_BASE);
    });

    it("chooseA2aServiceEndpoint 外部（none）：信 card.url（标准 A2A，含本地 mock 127.0.0.1）", () => {
      expect(
        chooseA2aServiceEndpoint({ url: "https://ext.example.com/a2a" }, "https://ext.example.com/.well-known/agent-card.json", "none"),
      ).toBe("https://ext.example.com/a2a");
      // 本地 mock：card.url=127.0.0.1 原样（不回退，保持现有 mock e2e 行为）
      expect(
        chooseA2aServiceEndpoint({ url: "http://127.0.0.1:55555/a2a" }, "http://127.0.0.1:55555/.well-known/agent-card.json", "none"),
      ).toBe("http://127.0.0.1:55555/a2a");
      // 外部 + card 无 url → undefined（callSubAgent 据此报「无 service endpoint」错误，不瞎发请求）
      expect(chooseA2aServiceEndpoint({ name: "no url" }, "https://ext.example.com/.well-known/agent-card.json", "none")).toBeUndefined();
    });
  });
});
