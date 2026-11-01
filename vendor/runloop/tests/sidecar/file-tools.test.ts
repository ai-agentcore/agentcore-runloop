import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeFileTool,
  isFileTool,
  globToRegExp,
  FILE_TOOL_DESCRIPTORS,
  FILE_TOOL_NAMES,
  EXEC_TOOLS_PROMPT,
} from "../../src/sidecar/file-tools.js";

function payload(r: Awaited<ReturnType<typeof executeFileTool>>): Record<string, unknown> {
  return JSON.parse(r!.content[0].text);
}

describe("file-tools metadata", () => {
  it("uses MCP/snake tool names and rejects others", () => {
    expect([...FILE_TOOL_NAMES]).toEqual(["read_file", "write_file", "edit_file", "grep", "glob"]);
    for (const n of FILE_TOOL_NAMES) expect(isFileTool(n)).toBe(true);
    expect(isFileTool("bash")).toBe(false);
    expect(isFileTool("Read")).toBe(false);
  });

  it("descriptors cover all tool names with required params", () => {
    expect(FILE_TOOL_DESCRIPTORS.map((d) => d.name).sort()).toEqual([...FILE_TOOL_NAMES].sort());
    const read = FILE_TOOL_DESCRIPTORS.find((d) => d.name === "read_file")!;
    expect(read.inputSchema.required).toContain("file_path");
  });

  it("executeFileTool returns null for non-file tools", async () => {
    expect(await executeFileTool("bash", { command: "ls" })).toBeNull();
  });
});

describe("globToRegExp", () => {
  it("** matches across directories, * within a segment, ? single char", () => {
    expect(globToRegExp("**/*.ts").test("a/b/c.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("a/b.ts")).toBe(false); // * 不跨分隔符
    expect(globToRegExp("src/*.ts").test("src/x.ts")).toBe(true);
    expect(globToRegExp("f?.ts").test("fa.ts")).toBe(true);
    expect(globToRegExp("f?.ts").test("fab.ts")).toBe(false);
    expect(globToRegExp("**/*.ts").test("a/b.js")).toBe(false);
  });

  it("** not followed by slash, and special chars are escaped", () => {
    expect(globToRegExp("a**").test("abc")).toBe(true); // ** 非斜杠收尾
    expect(globToRegExp("a.b").test("a.b")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false); // 字面 `.` 被转义
  });
});

describe("executeFileTool — read_file/write_file/edit_file/grep/glob", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "file-tools-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "line1\nhello world\nline3\n");
    writeFileSync(join(dir, "src", "b.js"), "var x = 1;\nhello again\n");
    writeFileSync(join(dir, "README.md"), "# title\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("read_file returns content; relative path resolves against cwd", async () => {
    const r = await executeFileTool("read_file", { file_path: "src/a.ts" }, { cwd: dir });
    expect(payload(r).content).toContain("hello world");
  });

  it("read_file honors offset/limit (line-based)", async () => {
    const r = await executeFileTool("read_file", { file_path: "src/a.ts", offset: 2, limit: 1 }, { cwd: dir });
    expect(payload(r).content).toBe("hello world");
  });

  it("read_file accepts an absolute path", async () => {
    const r = await executeFileTool("read_file", { file_path: join(dir, "src", "a.ts") });
    expect(payload(r).content).toContain("hello world");
  });

  it("read_file offset-only and limit-only variants", async () => {
    const offsetOnly = await executeFileTool("read_file", { file_path: "src/a.ts", offset: 2 }, { cwd: dir });
    expect(payload(offsetOnly).content).toBe("hello world\nline3\n");
    const limitOnly = await executeFileTool("read_file", { file_path: "src/a.ts", limit: 1 }, { cwd: dir });
    expect(payload(limitOnly).content).toBe("line1");
  });

  it("read_file truncates very large files when no offset/limit", async () => {
    writeFileSync(join(dir, "big.txt"), "x".repeat(300 * 1024));
    const r = await executeFileTool("read_file", { file_path: "big.txt" }, { cwd: dir });
    const p = payload(r);
    expect(p.truncated).toBe(true);
    expect((p.content as string).length).toBe(256 * 1024);
  });

  it("read_file on missing file is an error", async () => {
    const r = await executeFileTool("read_file", { file_path: "nope.txt" }, { cwd: dir });
    expect(r!.isError).toBe(true);
  });

  it("read_file requires file_path", async () => {
    const r = await executeFileTool("read_file", {}, { cwd: dir });
    expect(r!.isError).toBe(true);
  });

  it("write_file creates parent dirs and writes content", async () => {
    const r = await executeFileTool("write_file", { file_path: "deep/new.txt", content: "hi" }, { cwd: dir });
    expect(r!.isError).toBe(false);
    expect(readFileSync(join(dir, "deep", "new.txt"), "utf8")).toBe("hi");
  });

  it("write_file with no content writes an empty file", async () => {
    const r = await executeFileTool("write_file", { file_path: "empty.txt" }, { cwd: dir });
    expect(r!.isError).toBe(false);
    expect(readFileSync(join(dir, "empty.txt"), "utf8")).toBe("");
  });

  it("edit_file replaces the unique occurrence", async () => {
    const r = await executeFileTool("edit_file", { file_path: "src/a.ts", old_string: "hello world", new_string: "HELLO" }, { cwd: dir });
    expect(r!.isError).toBe(false);
    expect(readFileSync(join(dir, "src", "a.ts"), "utf8")).toContain("HELLO");
  });

  it("edit_file fails when old_string missing or absent", async () => {
    expect((await executeFileTool("edit_file", { file_path: "src/a.ts", old_string: "", new_string: "x" }, { cwd: dir }))!.isError).toBe(true);
    expect((await executeFileTool("edit_file", { file_path: "src/a.ts", old_string: "nope", new_string: "x" }, { cwd: dir }))!.isError).toBe(true);
  });

  it("edit_file refuses non-unique old_string unless replace_all", async () => {
    writeFileSync(join(dir, "dup.txt"), "x\nx\n");
    const r1 = await executeFileTool("edit_file", { file_path: "dup.txt", old_string: "x", new_string: "y" }, { cwd: dir });
    expect(r1!.isError).toBe(true);
    const r2 = await executeFileTool("edit_file", { file_path: "dup.txt", old_string: "x", new_string: "y", replace_all: true }, { cwd: dir });
    expect(payload(r2).replaced).toBe(2);
  });

  it("grep finds lines across files with file:line:content", async () => {
    const r = await executeFileTool("grep", { pattern: "hello" }, { cwd: dir });
    const m = payload(r).matches as string[];
    expect(m.some((x) => x.startsWith("src/a.ts:2:"))).toBe(true);
    expect(m.some((x) => x.includes("b.js"))).toBe(true);
  });

  it("grep caps results at MAX_MATCHES and flags truncated", async () => {
    writeFileSync(join(dir, "many.txt"), Array.from({ length: 250 }, (_, i) => `hit ${i}`).join("\n"));
    const r = await executeFileTool("grep", { pattern: "hit" }, { cwd: dir });
    const p = payload(r);
    expect(p.count).toBe(200);
    expect(p.truncated).toBe(true);
  });

  it("grep ignore_case + invalid regex error", async () => {
    const r = await executeFileTool("grep", { pattern: "HELLO", ignore_case: true }, { cwd: dir });
    expect((payload(r).matches as string[]).length).toBeGreaterThan(0);
    expect((await executeFileTool("grep", { pattern: "(" }, { cwd: dir }))!.isError).toBe(true);
  });

  it("glob lists matching files", async () => {
    const r = await executeFileTool("glob", { pattern: "**/*.ts" }, { cwd: dir });
    expect(payload(r).files).toEqual(["src/a.ts"]);
  });

  it("grep/glob skip .git and node_modules", async () => {
    mkdirSync(join(dir, ".git"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, ".git", "config"), "hello secret\n");
    writeFileSync(join(dir, "node_modules", "pkg", "index.ts"), "hello dep\n");
    const g = await executeFileTool("grep", { pattern: "hello" }, { cwd: dir });
    const m = payload(g).matches as string[];
    expect(m.some((x) => x.includes(".git/") || x.includes("node_modules/"))).toBe(false);
    const gl = await executeFileTool("glob", { pattern: "**/*.ts" }, { cwd: dir });
    expect(payload(gl).files as string[]).toEqual(["src/a.ts"]); // node_modules/pkg/index.ts 被跳过
  });

  it("grep/glob require pattern", async () => {
    expect((await executeFileTool("grep", {}, { cwd: dir }))!.isError).toBe(true);
    expect((await executeFileTool("glob", {}, { cwd: dir }))!.isError).toBe(true);
  });
});

describe("EXEC_TOOLS_PROMPT", () => {
  it("documents every tool (bash + file tools) with a call example", () => {
    expect(EXEC_TOOLS_PROMPT).toContain('bash {"command"');
    expect(EXEC_TOOLS_PROMPT).toContain('read_file {"file_path"');
    expect(EXEC_TOOLS_PROMPT).toContain('write_file {"file_path"');
    expect(EXEC_TOOLS_PROMPT).toContain('edit_file {"file_path"');
    expect(EXEC_TOOLS_PROMPT).toContain('grep {"pattern"');
    expect(EXEC_TOOLS_PROMPT).toContain('glob {"pattern"');
  });

  it("curbs hallucinated tool names (no read_mcp_resource / cat / ls)", () => {
    expect(EXEC_TOOLS_PROMPT).toContain("read_mcp_resource");
    expect(EXEC_TOOLS_PROMPT).toContain("不要");
  });
});

describe("file-tools — 分支补全", () => {
  let d: string;
  beforeEach(() => {
    d = mkdtempSync(join(tmpdir(), "ft-br-"));
    writeFileSync(join(d, "f.txt"), "l1\nl2\nl3");
  });
  afterEach(() => rmSync(d, { recursive: true, force: true }));

  it("resolvePath：无 cwd → 锚 process.cwd()（相对路径读仓库 package.json）", async () => {
    const r = await executeFileTool("read_file", { file_path: "package.json" }, {}); // 无 cwd
    expect(payload(r).content).toContain("\"name\"");
  });

  it("read_file offset=0 → 回落 1（Number(0)||1 分支）", async () => {
    const r = await executeFileTool("read_file", { file_path: join(d, "f.txt"), offset: 0, limit: 1 });
    expect(payload(r).content).toBe("l1");
  });

  it("write_file / edit_file 缺 file_path → 报错（215/216, 223/224）", async () => {
    expect((await executeFileTool("write_file", { content: "x" }))!.isError).toBe(true);
    expect((await executeFileTool("edit_file", { old_string: "a", new_string: "b" }))!.isError).toBe(true);
  });
});
