import { describe, expect, it } from "vitest";
import { buildSystemPrompt, buildModelPrompt } from "@/loop/prompt-builder.js";
import type { RunRequest } from "@/types/api.js";
import type { Resource } from "@/types/resources.js";

// buildSystemPrompt 入参是完整 RunRequest；测试只关心 agent.systemPrompt / resources / features，故用薄封装。
// execToolsEnabled（有 shell/文件能力）经第二参注入，仅影响 skill 读取措辞（read_file vs get_skill）。
const sp = (
  o: {
    userPrompt?: string;
    resources?: Resource[];
    resourceMode?: "mcp" | "cli";
    execToolsEnabled?: boolean;
    clientTools?: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }>;
    hitlEnabled?: boolean;
    clientCapabilities?: { interactions?: Array<"confirm" | "input" | "choice">; nativeHitl?: boolean; renderTools?: Record<string, string> };
  } = {},
): string =>
  buildSystemPrompt(
    {
      agent: o.userPrompt !== undefined ? { systemPrompt: o.userPrompt } : undefined,
      resources: o.resources,
      features: o.resourceMode ? { toolBridge: o.resourceMode } : undefined,
      clientTools: o.clientTools,
      hitl: o.hitlEnabled
        ? { enabled: true, ...(o.clientCapabilities ? { clientCapabilities: o.clientCapabilities } : {}) }
        : undefined,
    } as RunRequest,
    { execToolsEnabled: o.execToolsEnabled ?? false },
  );

// 扁平 Resource fixture：FUNCTIONCALL —— operationId（= 工具名）取 resourceName。
const fcResource = (name: string, description: string): Resource => ({
  resourceId: name,
  resourceName: name,
  resourceType: "FUNCTIONCALL",
  description,
  protocol: "openapi",
  openapiConfig: {
    servers: [{ url: "https://api.example.com" }],
    paths: { [`/${name}`]: { post: { operationId: name, description } } },
  },
} as Resource);

// 扁平 Resource fixture：AGENT 子 agent 委派（protocol=ag-ui，入口 operationId=invoke）。
const agentResource = (name: string, description: string): Resource => ({
  resourceId: name,
  resourceName: name,
  resourceType: "AGENT",
  description,
  protocol: "ag-ui",
  openapiConfig: {
    servers: [{ url: "https://acct.agentrun-data.cn-hangzhou.aliyuncs.com" }],
    paths: { "/invoke": { post: { operationId: "invoke" } } },
  },
  auth: { mode: "agentrun" },
} as Resource);

describe("buildSystemPrompt", () => {
  it("uses the built-in Super Agent identity by default", () => {
    const prompt = sp({});

    expect(prompt).toContain("超级 Agent");
    expect(prompt).not.toContain("## 用户自定义提示");
  });

  describe("客户端工具（HITL / 用户交互）引导", () => {
    it("有 clientTools → 每个工具像平台工具一样渲染（### name + 描述 + 参数 + 示例），不含硬规则", () => {
      const prompt = sp({
        clientTools: [
          {
            name: "super_agent_choices",
            description: "向用户提问并展示候选选项",
            parameters: {
              type: "object",
              properties: {
                question: { type: "string", description: "问题" },
                choices: { type: "array", description: "候选项" },
                allowCustomInput: { type: "boolean", description: "是否允许自定义" },
              },
              required: ["question", "choices"],
            },
          },
          { name: "super_agent_confirm", description: "请用户确认" },
        ],
      });
      // 文末渲染段：每个客户端工具像平台工具一样渲染（### client__name + 描述 + 参数 + 示例）
      expect(prompt).toContain("## 与用户交互（客户端工具 / HITL）");
      expect(prompt).toContain("### client__super_agent_choices");
      expect(prompt).toContain("### client__super_agent_confirm");
      expect(prompt).toContain("向用户提问并展示候选选项");
      expect(prompt).toContain("示例：");
      // 示例占位类型正确：array→[]、boolean→false、string→"<key>"（不再把 array 填成字符串）
      expect(prompt).toContain('{"question":"<question>","choices":[],"allowCustomInput":false}');
    });

    it("顶部强制引导段：点名实际工具 + 禁纯文本 + 覆盖竞争说法（本地实测 8/8 触发的配置）", () => {
      const prompt = sp({
        userPrompt: "通过确认工具（如有）或自然语言向用户询问",
        clientTools: [{ name: "super_agent_choices", description: "d" }, { name: "super_agent_confirm", description: "d" }],
      });
      // 强制段存在且点名动态工具
      expect(prompt).toContain("# 与用户交互（强制 · 最高优先级");
      expect(prompt).toContain("必须调用下面这些客户端工具之一");
      expect(prompt).toContain("`client__super_agent_choices`");
      expect(prompt).toContain("`client__super_agent_confirm`");
      expect(prompt).toContain("禁止用纯文本向用户提问");
      expect(prompt).toContain("覆盖下文任何「可用自然语言向用户询问」的说法");
      // 放在最顶部：强制段在「身份与核心约束」之前
      expect(prompt.indexOf("# 与用户交互（强制")).toBeLessThan(prompt.indexOf("身份与核心约束"));
      // 也在用户自定义提示（含竞争说法）之前
      expect(prompt.indexOf("# 与用户交互（强制")).toBeLessThan(prompt.indexOf("## 用户自定义提示"));
    });

    it("标题层级正确：客户端工具用 ### 子标题（不在 h2 段下塞 h1）", () => {
      const prompt = sp({ clientTools: [{ name: "super_agent_choices", description: "d" }] });
      // 资源段顶层标题不再被 `## AgentRun 资源提示` 外包成倒挂
      expect(prompt).not.toContain("## AgentRun 资源提示");
      // 文末渲染段：## 段标题 + ### 工具标题
      const sec = prompt.slice(prompt.indexOf("## 与用户交互（客户端工具"));
      expect(sec).toMatch(/^### client__super_agent_choices$/m);
    });

    it("名字含非法字符 → 用 sanitizeToolName 后的 client__ 名（与模型实际工具名一致）", () => {
      const prompt = sp({ clientTools: [{ name: "ask-user.now" }] });
      expect(prompt).toContain("`client__ask_user_now`");
    });

    it("无 clientTools → 不注入该段（零行为变化）", () => {
      expect(sp({})).not.toContain("## 与用户交互");
      expect(sp({ clientTools: [] })).not.toContain("## 与用户交互");
    });
  });

  describe("HITL ask 原语（request_user_input）引导", () => {
    it("hitl.enabled → 注入 request_user_input 引导段（何时调 + 三种 responseSchema 形态）", () => {
      const prompt = sp({ hitlEnabled: true });
      expect(prompt).toContain("## 与用户交互（确认 / 提问 · request_user_input）");
      expect(prompt).toContain("request_user_input");
      // 三种形态的引导都在
      expect(prompt).toContain("不带 `responseSchema`"); // 仅确认
      expect(prompt).toContain('"enum"'); // 多选
      expect(prompt).toContain('"type":"string"'); // 取值
    });

    it("无 hitl / hitl.enabled=false → 不注入该段（零行为变化）", () => {
      expect(sp({})).not.toContain("request_user_input");
      expect(sp({ hitlEnabled: false })).not.toContain("request_user_input");
    });

    describe("F1 声明才产生：按 clientCapabilities.interactions 裁剪 steering", () => {
      it("无 clientCapabilities（未声明 interactions）→ 仍讲全部三种形态（向后兼容）", () => {
        const prompt = sp({ hitlEnabled: true });
        expect(prompt).toContain("不带 `responseSchema`"); // 确认
        expect(prompt).toContain('"enum"'); // 多选
        expect(prompt).toContain('"type":"string"'); // 取值
      });

      it("只声明 confirm → 只讲是非确认，不讲多选/取值", () => {
        const prompt = sp({ hitlEnabled: true, clientCapabilities: { interactions: ["confirm"] } });
        expect(prompt).toContain("request_user_input");
        expect(prompt).toContain("不带 `responseSchema`"); // 确认形态仍在
        expect(prompt).not.toContain('"enum"'); // 多选不讲
        expect(prompt).not.toContain('"type":"string"'); // 取值不讲
      });

      it("声明 confirm + choice → 讲确认 + 多选，不讲取值", () => {
        const prompt = sp({ hitlEnabled: true, clientCapabilities: { interactions: ["confirm", "choice"] } });
        expect(prompt).toContain("不带 `responseSchema`");
        expect(prompt).toContain('"enum"');
        expect(prompt).not.toContain('"type":"string"');
      });

      it("声明 input（未声明 confirm）→ 安全二元确认仍在（不被掐掉），加取值，不讲多选", () => {
        const prompt = sp({ hitlEnabled: true, clientCapabilities: { interactions: ["input"] } });
        expect(prompt).toContain("不带 `responseSchema`"); // 安全主轨二元确认始终可用
        expect(prompt).toContain('"type":"string"'); // 取值
        expect(prompt).not.toContain('"enum"'); // 多选未声明
      });

      it("声明全部三种 → 三种形态都讲", () => {
        const prompt = sp({ hitlEnabled: true, clientCapabilities: { interactions: ["confirm", "input", "choice"] } });
        expect(prompt).toContain("不带 `responseSchema`");
        expect(prompt).toContain('"enum"');
        expect(prompt).toContain('"type":"string"');
      });
    });
  });

  it("includes environment constraints and install guidance (domestic mirrors, rootless tools)", () => {
    const prompt = sp({});

    expect(prompt).toContain("## 环境硬约束");
    expect(prompt).toContain("境外站点均不可达");
    expect(prompt).toContain("禁止使用");
    expect(prompt).toContain("uv pip install");
    expect(prompt).toContain("micromamba install");
    expect(prompt).toContain("bun add");
    expect(prompt).toContain("不要编造内容");
  });

  it("identity override takes highest priority in prompt", () => {
    const prompt = sp({});

    expect(prompt).toContain("超级 Agent");
    expect(prompt).toContain("不要自称 Codex");
    expect(prompt.indexOf("超级 Agent")).toBeLessThan(prompt.indexOf("## 环境硬约束"));
  });

  it("keeps user prompt as additional instructions", () => {
    const prompt = sp({ userPrompt: "回答要简洁" });

    expect(prompt).toContain("超级 Agent");
    expect(prompt).toContain("## 用户自定义提示");
    expect(prompt).toContain("回答要简洁");
  });

  it("does not let empty user prompt add a user section", () => {
    const prompt = sp({ userPrompt: "   " });

    expect(prompt).toContain("超级 Agent");
    expect(prompt).not.toContain("## 用户自定义提示");
  });

  it("adds function call tools and skills to the prompt", () => {
    const prompt = sp({
      resources: [
        fcResource("calculator", "Math operations"),
        // SKILL：openapi(protocol) + download operation；扁平模型下 skill 不作为模型工具，列在「已装入的 Skill」块
        {
          resourceId: "code-review",
          resourceName: "code-review",
          resourceType: "SKILL",
          description: "Review code for quality",
          protocol: "openapi",
          openapiConfig: {
            servers: [{ url: "https://acct-ram.agentrun-data.cn-hangzhou.aliyuncs.com" }],
            paths: { "/skills/code-review/download": { get: { operationId: "download" } } },
          },
        },
      ],
    });

    expect(prompt).toContain("# 可用的 AgentRun 工具");
    // 全走 MCP：工具已在列表中、直接按名调用；明确禁止用 shell 模拟/探索（不再用 .tools/agentrun）
    expect(prompt).toContain("直接按名字调用");
    expect(prompt).toContain("禁止");
    expect(prompt).not.toContain(".tools/agentrun");
    // FUNCTIONCALL 工具名 = <净化 resourceName>_<净化 operationId>（这里都是 calculator）
    expect(prompt).toContain("### function__calculator__calculator");
    expect(prompt).toContain("Math operations");
    // SKILL 不作为模型工具，而是列在「已装入的 Skill」块（名字用 slug）+ 带 get_skill 调用示例（goal 1）
    expect(prompt).toContain("## 已装入的 Skill");
    expect(prompt).toContain("**code-review**");
    expect(prompt).toContain("Review code for quality");
    // 默认（无 shell / 零执行态）：skill 读取走 get_skill（唯一通道），不提 read_file
    expect(prompt).toContain('调用示例：`get_skill {"name":"code-review"}`');
    expect(prompt).not.toContain("read_file");
  });

  it("有 shell（execToolsEnabled）：skill 读取措辞走 read_file 读 .agents/skills/，不提 get_skill", () => {
    const skill: Resource = {
      resourceId: "code-review",
      resourceName: "code-review",
      resourceType: "SKILL",
      description: "Review code for quality",
      protocol: "openapi",
      openapiConfig: {
        servers: [{ url: "https://acct-ram.agentrun-data.cn-hangzhou.aliyuncs.com" }],
        paths: { "/skills/code-review/download": { get: { operationId: "download" } } },
      },
    } as Resource;
    const prompt = sp({ resources: [skill], execToolsEnabled: true });
    expect(prompt).toContain("## 已装入的 Skill");
    expect(prompt).toContain("**code-review**");
    // 有 shell：用标准 read_file 读磁盘 SKILL.md，不透出 get_skill（与执行层读法统一）
    expect(prompt).toContain('读取示例：`read_file {"file_path":".agents/skills/code-review/SKILL.md"}`');
    expect(prompt).not.toContain("get_skill");
  });

  it("skill 块名字用 slug（非 slug 的 resourceName 被规范化）+ 调用示例用同一 slug（goal 1）", () => {
    const prompt = sp({
      resources: [
        {
          resourceId: "sk",
          resourceName: "Fancy Travel", // 非 slug → toSkillName = fancy-travel
          resourceType: "SKILL",
          description: "trip planner",
          protocol: "openapi",
          openapiConfig: {
            servers: [{ url: "https://acct-ram.agentrun-data.cn-hangzhou.aliyuncs.com" }],
            paths: { "/skills/fancy-travel/download": { get: { operationId: "download" } } },
          },
        },
      ],
    });
    expect(prompt).toContain("**fancy-travel**"); // 展示 slug，不展示原始 "Fancy Travel"
    expect(prompt).not.toContain("**Fancy Travel**");
    expect(prompt).toContain('调用示例：`get_skill {"name":"fancy-travel"}`'); // 示例名 == slug
  });

  it("adds sandbox tools to the prompt", () => {
    const prompt = sp({
      resources: [
        {
          resourceId: "sb-123",
          resourceName: "sb-123",
          resourceType: "SANDBOX",
          protocol: "openapi",
          openapiConfig: {
            servers: [{ url: "https://sandbox.example.com" }],
            paths: {
              "/exec": {
                post: { operationId: "sandbox_sb_123_exec", description: "CodeInterpreter exec" },
              },
            },
          },
        },
      ],
    });

    expect(prompt).toContain("# 可用的 AgentRun 工具");
    // 沙箱工具名 = <净化 resourceName>_<净化 operationId>（sb-123 → sb_123）
    expect(prompt).toContain("### sandbox__sb_123__sandbox_sb_123_exec");
    expect(prompt).toContain("CodeInterpreter");
  });

  it("adds knowledge-base and memory tools to the prompt", () => {
    const prompt = sp({
      resources: [
        // 扁平模型：KB / Memory 走 openapi 工具（归入 tools），每 operation 一个工具，无独立分块
        {
          resourceId: "kb1",
          resourceName: "kb1",
          resourceType: "KNOWLEDGE_BASE",
          protocol: "openapi",
          openapiConfig: {
            servers: [{ url: "https://kb.example.com" }],
            paths: { "/retrieve": { post: { operationId: "kb1_retrieve", description: "Retrieve from KB" } } },
          },
        },
        {
          resourceId: "mem1",
          resourceName: "mem1",
          resourceType: "MEMORY",
          protocol: "openapi",
          openapiConfig: {
            servers: [{ url: "https://mem.example.com" }],
            paths: { "/search": { post: { operationId: "mem1_search", description: "Search memory" } } },
          },
        },
      ],
    });

    expect(prompt).toContain("# 可用的 AgentRun 工具");
    // KB / Memory 渲染为平台工具（工具名 = <净化 resourceName>_<净化 operationId>）
    expect(prompt).toContain("### kb__kb1__kb1_retrieve");
    expect(prompt).toContain("### memory__mem1__mem1_search");
  });

  it("adds sub-agent coordination and delegate tools to the prompt", () => {
    const prompt = sp({
      resources: [agentResource("researcher", "Web research agent")],
    });

    // 扁平模型：委派块为工具列表（## 子 Agent 委派 + <净化 name>_delegate）
    expect(prompt).toContain("## 子 Agent 委派");
    expect(prompt).toContain("### agent__researcher__delegate");
    expect(prompt).toContain("Web research agent");
  });

  it("makes the exec_command constraint conditional, not mandatory for all turns", () => {
    const prompt = sp({
      resources: [fcResource("calculator", "Math")],
    });

    expect(prompt).toContain("需要平台能力");
    expect(prompt).toContain("直接自然回答即可");
  });

  it("renders function-call tool parameters (required/optional, with/without description)", () => {
    const prompt = sp({
      resources: [{
        resourceId: "search",
        resourceName: "search",
        resourceType: "FUNCTIONCALL",
        description: "Search the web",
        protocol: "openapi",
        openapiConfig: {
          servers: [{ url: "https://api.example.com" }],
          paths: {
            "/search": {
              post: {
                operationId: "search",
                description: "Search the web",
                requestBody: {
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          query: { type: "string", description: "the query" },
                          limit: { type: "number" },
                        },
                        required: ["query"],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }],
    });

    expect(prompt).toContain("### function__search__search");
    expect(prompt).toContain("`query` （必填）: the query");
    expect(prompt).toContain("`limit` （可选）:");
  });

  it("adds no resource section when only MCP tools are present", () => {
    const prompt = sp({
      resources: [{
        resourceId: "mcp-only",
        resourceName: "mcp-only",
        resourceType: "MCP",
        protocol: "mcp",
        mcpConfig: { transport: "http", url: "https://example.com/mcp" },
      }],
    });

    expect(prompt).toContain("超级 Agent");
    expect(prompt).not.toContain("# 可用的 AgentRun 工具");
  });

  it("cli 模式用 .tools/agentrun call 指引（mcp 模式不用）", () => {
    const cli = sp({
      resources: [{
        resourceId: "calc",
        resourceName: "calc",
        resourceType: "FUNCTIONCALL",
        description: "Math",
        protocol: "openapi",
        openapiConfig: {
          servers: [{ url: "https://api.example.com" }],
          paths: {
            "/calc": {
              post: {
                operationId: "calc",
                description: "Math",
                requestBody: {
                  content: { "application/json": { schema: { type: "object", properties: { x: { type: "string" } } } } },
                },
              },
            },
          },
        },
      }],
      resourceMode: "cli",
    });
    expect(cli).toContain(".tools/agentrun call function__calc__calc");
    expect(cli).not.toContain("直接按名字调用");
  });

  it("每个工具都带一个调用示例（mcp + cli 两模式）", () => {
    for (const mode of ["mcp", "cli"] as const) {
      const prompt = sp({
        resources: [
          fcResource("fc", "f"),
          agentResource("ag", "a"),
        ],
        resourceMode: mode,
      });
      const section = prompt.slice(prompt.indexOf("# 可用的 AgentRun 工具"));
      const tools = (section.match(/^### /gm) ?? []).length;
      const examples = (section.match(/^示例：$/gm) ?? []).length;
      expect(tools, `mode=${mode}`).toBe(examples);
      expect(examples, `mode=${mode}`).toBeGreaterThan(0);
    }
  });
});

describe("buildModelPrompt", () => {
  it("按 model 选模型操作规约，返回通用 base，且不含 codex 私有内容", () => {
    const p = buildModelPrompt({ model: { model: "qwen3.7-max" } } as RunRequest);
    expect(p).toContain("工作规约");
    expect(p).not.toContain("Codex");
  });

  it("qwen 模型追加模型族补充", () => {
    const p = buildModelPrompt({ model: { model: "qwen3.7-max" } } as RunRequest);
    expect(p).toContain("针对当前模型的补充");
  });

  it("未知模型只返回通用 base", () => {
    const p = buildModelPrompt({ model: { model: "unknown-x" } } as RunRequest);
    expect(p).toContain("工作规约");
    expect(p).not.toContain("针对当前模型的补充");
  });
});
