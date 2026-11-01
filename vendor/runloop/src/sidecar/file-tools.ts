// 内置文件/检索工具（MCP/snake 命名：read_file / write_file / edit_file / grep / glob）。
//
// 动机：execViaMcp 关掉 agent CLI 内建 shell 后，模型常臆测 `read_file`/`read_mcp_resource` 等工具、
// 或被迫用 `bash` 的 cat/grep/echo>（转义脆、无结构）。这里提供与 `bash` 同路径
// （handleToolCall → sidecar.gatedExecute 主轨）的专用工具：结构化、免 shell 转义、命中模型既有习惯。
// 命名对齐 MCP filesystem / OpenAI 系（全小写 snake_case）。
//
// 实现为**纯 Node、无状态、一次性**（与 `executeShell` 一致），跑在本地 fs；后续随 AD-030 把后端
// 换成「每会话隔离沙箱」时一并迁移（工具名/契约不变）。
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, isAbsolute, dirname, relative, sep } from "node:path";
import type { McpToolDescriptor, McpToolResult } from "../mcp/types.js";

const MAX_READ_BYTES = 256 * 1024; // 单文件读取上限
const MAX_MATCHES = 200; // grep/glob 结果上限
const MAX_WALK_FILES = 20_000; // 目录遍历文件数上限（防失控）
const SKIP_DIRS = new Set([".git", "node_modules"]);

/** MCP/snake 工具名（暴露给模型为 `mcp__agentcore__<name>`）。 */
export const FILE_TOOL_NAMES = ["read_file", "write_file", "edit_file", "grep", "glob"] as const;
const FILE_TOOL_NAME_SET = new Set<string>(FILE_TOOL_NAMES);

export const FILE_TOOL_DESCRIPTORS: McpToolDescriptor[] = [
  {
    name: "read_file",
    description: "读取一个文件的内容（返回原始文本，可选按行 offset/limit 截取）。读文件用本工具，不要用 bash 的 cat。",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "文件路径（绝对，或相对工作目录）" },
        offset: { type: "number", description: "起始行号（1 基，可选）" },
        limit: { type: "number", description: "读取行数（可选）" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "write_file",
    description: "把内容写入文件（覆盖；父目录自动创建）。写/新建文件用本工具，不要用 bash 的 echo >。",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "文件路径（绝对，或相对工作目录）" },
        content: { type: "string", description: "要写入的完整内容" },
      },
      required: ["file_path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "对文件做精确字符串替换（old_string → new_string）。默认替换首处；replace_all=true 替换全部。改文件局部用本工具。",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "文件路径（绝对，或相对工作目录）" },
        old_string: { type: "string", description: "要被替换的原文（须在文件中唯一，除非 replace_all）" },
        new_string: { type: "string", description: "替换成的新文本" },
        replace_all: { type: "boolean", description: "是否替换所有出现（默认 false）" },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
  {
    name: "grep",
    description: "在目录下按正则搜索文件内容，返回 `文件:行号:内容`。搜内容用本工具，不要用 bash 的 grep。",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "正则表达式（JS 语法）" },
        path: { type: "string", description: "搜索根目录（绝对，或相对工作目录；默认工作目录）" },
        ignore_case: { type: "boolean", description: "忽略大小写（默认 false）" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "glob",
    description: "按通配（支持 ** / * / ?）列出匹配的文件路径。找文件用本工具，不要用 bash 的 find/ls。",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "通配模式，如 `**/*.ts`" },
        path: { type: "string", description: "搜索根目录（绝对，或相对工作目录；默认工作目录）" },
      },
      required: ["pattern"],
    },
  },
];

export function isFileTool(name: string): boolean {
  return FILE_TOOL_NAME_SET.has(name);
}

/**
 * execViaMcp 下追加到 system prompt 的工具说明：声明可用工具集 + 引导"读写检索用专用工具、
 * 别用 bash 的 cat/echo>/grep/find"，并明确"工具就这些、别臆测 read_mcp_resource 之类"以遏制乱猜。
 */
export const EXEC_TOOLS_PROMPT = [
  "## 执行与文件工具",
  "你**没有**内置的本地 shell；执行与文件操作用下面这些专用工具（每条带调用示例）。**不要**臆测 `cat` / `ls` / `find` / `read_mcp_resource` 之类不存在的工具。（平台能力、skill 等其它工具见上文对应小节，按那里的说明调用。）",
  '- `bash`：执行 shell 命令（装依赖、构建、跑脚本、git 等）。示例：`bash {"command":"pnpm install"}`',
  '- `read_file`：读文件内容。**读文件用 `read_file`，不要 `bash` 的 cat。** 示例：`read_file {"file_path":"src/index.ts"}`（可加 `"offset":1,"limit":50` 按行截取）',
  '- `write_file`：写入/新建文件（覆盖，父目录自动建）。**不要用 `bash` 的 echo >。** 示例：`write_file {"file_path":"src/x.ts","content":"export const x = 1;\\n"}`',
  '- `edit_file`：精确替换文件内容。示例：`edit_file {"file_path":"src/x.ts","old_string":"foo","new_string":"bar"}`（替换全部加 `"replace_all":true`）',
  '- `grep`：按正则搜内容，返回 `文件:行号:内容`。**不要用 `bash` 的 grep。** 示例：`grep {"pattern":"TODO","path":"src","ignore_case":true}`',
  '- `glob`：按通配找文件。**不要用 `bash` 的 find/ls。** 示例：`glob {"pattern":"**/*.ts"}`',
  "路径可绝对或相对工作目录。读写/检索优先用专用工具（更稳、免转义），其它操作才用 `bash`。",
].join("\n");

/**
 * 远端执行环境说明（AD-033，**传入 Sandbox 时注入**——系统实例必经此、用户实例传入 Sandbox 亦然）：告诉模型
 * bash/文件操作发生在隔离沙箱、工作目录、环境干净需按需装依赖、skill 同步位置。cwd 缺省时沙箱用其默认目录。
 */
export function remoteExecPrompt(cwd?: string): string {
  const dir = cwd && cwd.trim() ? cwd.trim() : undefined;
  const lines = [
    "## 执行环境（隔离沙箱）",
    "你的 `bash` 命令和文件操作在一个**隔离沙箱**里执行（不是本地机器、也不是其它会话）。",
    dir
      ? `工作目录为 \`${dir}\`：相对路径锚定于此，需要绝对路径时也以它为基准。`
      : "相对路径锚定于沙箱的默认工作目录。",
    "环境是干净的：完成任务所需的依赖/工具请在沙箱内按需安装（按上文「依赖安装」规则）。",
    `已装入的 skill 已下载到沙箱的 \`${dir ? dir.replace(/\/$/, "") + "/" : ""}.agents/skills/<名字>/\` 下，用 \`read_file\` 读其 \`SKILL.md\` 正文、用 \`bash\`/\`read_file\` 读取或运行其中的 \`scripts/\`、\`assets/\`、\`references/\` 文件。`,
  ];
  return lines.join("\n");
}

const ok = (obj: unknown): McpToolResult => ({ content: [{ type: "text", text: JSON.stringify(obj) }], isError: false });
const fail = (msg: string): McpToolResult => ({ content: [{ type: "text", text: JSON.stringify({ error: msg }) }], isError: true });

function resolvePath(p: string, cwd?: string): string {
  return isAbsolute(p) ? p : join(cwd ?? process.cwd(), p);
}

/** glob → 锚定正则：`**`=任意层级、`*`=非分隔符段、`?`=单字符；其余字面量转义。 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // `**/` 吃掉斜杠，匹配零或多层目录
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\/".includes(c)) {
      re += c === "/" ? "/" : "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

/** 递归收集 root 下的文件相对路径（forward-slash），跳过 .git/node_modules，封顶 MAX_WALK_FILES。 */
async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0 && out.length < MAX_WALK_FILES) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 不可读目录跳过
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
      } else if (e.isFile()) {
        out.push(relative(root, full).split(sep).join("/"));
        if (out.length >= MAX_WALK_FILES) break;
      }
    }
  }
  return out;
}

export interface FileToolOptions {
  cwd?: string;
}

/** 执行一个文件工具；name 非文件工具时返回 null（调用方继续走其它分发）。 */
export async function executeFileTool(
  name: string,
  args: Record<string, unknown>,
  opts: FileToolOptions = {},
): Promise<McpToolResult | null> {
  if (!isFileTool(name)) return null;
  const cwd = opts.cwd;
  try {
    switch (name) {
      case "read_file": {
        const fp = String(args.file_path ?? "");
        if (!fp) return fail("file_path is required");
        const buf = await readFile(resolvePath(fp, cwd));
        if (buf.length > MAX_READ_BYTES && args.offset === undefined && args.limit === undefined) {
          return ok({ content: buf.subarray(0, MAX_READ_BYTES).toString("utf8"), truncated: true });
        }
        let text = buf.toString("utf8");
        if (args.offset !== undefined || args.limit !== undefined) {
          const lines = text.split("\n");
          const start = Math.max(0, (Number(args.offset ?? 1) || 1) - 1);
          const end = args.limit !== undefined ? start + Number(args.limit) : lines.length;
          text = lines.slice(start, end).join("\n");
        }
        return ok({ content: text });
      }
      case "write_file": {
        const fp = String(args.file_path ?? "");
        if (!fp) return fail("file_path is required");
        const target = resolvePath(fp, cwd);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, String(args.content ?? ""));
        return ok({ ok: true, file_path: target });
      }
      case "edit_file": {
        const fp = String(args.file_path ?? "");
        if (!fp) return fail("file_path is required");
        const oldStr = String(args.old_string ?? "");
        const newStr = String(args.new_string ?? "");
        if (!oldStr) return fail("old_string is required");
        const target = resolvePath(fp, cwd);
        const text = (await readFile(target)).toString("utf8");
        const count = text.split(oldStr).length - 1;
        if (count === 0) return fail("old_string not found in file");
        if (count > 1 && !args.replace_all) return fail(`old_string is not unique (${count} matches); pass replace_all=true or give more context`);
        const next = args.replace_all ? text.split(oldStr).join(newStr) : text.replace(oldStr, newStr);
        await writeFile(target, next);
        return ok({ ok: true, replaced: args.replace_all ? count : 1 });
      }
      case "grep": {
        const pattern = String(args.pattern ?? "");
        if (!pattern) return fail("pattern is required");
        let re: RegExp;
        try {
          re = new RegExp(pattern, args.ignore_case ? "i" : "");
        } catch (e) {
          return fail(`invalid regex: ${e instanceof Error ? e.message : String(e)}`);
        }
        const root = resolvePath(String(args.path ?? "."), cwd);
        const files = await walkFiles(root);
        const matches: string[] = [];
        for (const rel of files) {
          if (matches.length >= MAX_MATCHES) break;
          let content: string;
          try {
            content = (await readFile(join(root, rel))).toString("utf8");
          } catch {
            continue;
          }
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              matches.push(`${rel}:${i + 1}:${lines[i]}`);
              if (matches.length >= MAX_MATCHES) break;
            }
          }
        }
        return ok({ matches, count: matches.length, truncated: matches.length >= MAX_MATCHES });
      }
      case "glob": {
        const pattern = String(args.pattern ?? "");
        if (!pattern) return fail("pattern is required");
        const re = globToRegExp(pattern);
        const root = resolvePath(String(args.path ?? "."), cwd);
        const files = (await walkFiles(root)).filter((f) => re.test(f)).slice(0, MAX_MATCHES);
        return ok({ files, count: files.length });
      }
      default:
        return fail(`unknown file tool: ${name}`);
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
