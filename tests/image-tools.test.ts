import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImageTools, IMAGE_TOOL_DESCRIPTORS } from "../vendor/runloop/src/sidecar/image-tools.js";
import { buildExtraTools } from "../vendor/runloop/src/loop/extra-tools.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "agentcore-image-"));
  roots.push(value);
  return value;
}

describe("AgentCore Bailian image tools", () => {
  it("registers native view and generation entries only when enabled", () => {
    expect(buildExtraTools({ hitlEnabled: false, execToolsEnabled: true, hasSkills: false, imageToolsEnabled: true })
      .map(tool => tool.name)).toEqual(expect.arrayContaining(["view_image", "imagegen"]));
    expect(buildExtraTools({ hitlEnabled: false, execToolsEnabled: true, hasSkills: false, imageToolsEnabled: false })
      .map(tool => tool.name)).not.toEqual(expect.arrayContaining(["view_image", "imagegen"]));
    expect(IMAGE_TOOL_DESCRIPTORS.map(tool => tool.name)).toEqual(["view_image", "imagegen"]);
  });

  it("reads a current-session PNG and asks AgentCore for the configured credential", async () => {
    const workspace = await root();
    const path = join(workspace, "uploads", "sample.png");
    await mkdir(join(workspace, "uploads"));
    await writeFile(path, Buffer.from("89504e470d0a1a0a", "hex"));
    const credential = vi.fn(async () => "bailian-secret");
    vi.stubGlobal("fetch", vi.fn(async (_url: URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer bailian-secret" });
      return new Response(JSON.stringify({ choices: [{ message: { content: "a visible test image" } }] }), { status: 200 });
    }));
    const result = await new ImageTools(workspace, credential, "DASHBOARD_API_KEY").call("view_image", { path: "uploads/sample.png" });
    expect(credential).toHaveBeenCalledWith("DASHBOARD_API_KEY");
    expect(result).toMatchObject({ content: [{ text: JSON.stringify({ answer: "a visible test image" }) }] });
  });

  it("cannot read outside the current session or follow a symlink", async () => {
    const workspace = await root();
    const outside = await root();
    const secret = join(outside, "secret.png");
    await writeFile(secret, Buffer.from("89504e470d0a1a0a", "hex"));
    const { symlink } = await import("node:fs/promises");
    await symlink(secret, join(workspace, "linked.png"));
    const tools = new ImageTools(workspace, vi.fn(async () => "secret"), "DASHBOARD_API_KEY");
    expect((await tools.call("view_image", { path: secret })).isError).toBe(true);
    expect((await tools.call("view_image", { path: "linked.png" })).isError).toBe(true);
  });

  it("writes generated images inside the current session", async () => {
    const workspace = await root();
    const fetchMock = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.pathname.includes("image-synthesis")) {
        expect(init?.headers).toMatchObject({ "X-DashScope-Async": "enable" });
        expect(JSON.parse(init?.body as string)).toMatchObject({ model: "qwen-image-plus", input: { prompt: "draw a cube" } });
        return new Response(JSON.stringify({ output: { task_id: "task-1", task_status: "PENDING", results: [] } }), { status: 200 });
      }
      if (url.pathname.includes("/tasks/task-1")) return new Response(JSON.stringify({ output: { task_id: "task-1", task_status: "SUCCEEDED", results: [{ url: "https://dashscope-result-cn.oss-cn-hangzhou.aliyuncs.com/result.png" }] } }), { status: 200 });
      return new Response(Buffer.from("89504e470d0a1a0a", "hex"), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await new ImageTools(workspace, vi.fn(async () => "secret"), "DASHBOARD_API_KEY").call("imagegen", { prompt: "draw a cube" });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as { file_path: string };
    expect(payload.file_path.startsWith(join(workspace, ".generated-images"))).toBe(true);
    expect(await readFile(payload.file_path)).toEqual(Buffer.from("89504e470d0a1a0a", "hex"));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns safe Bailian diagnostics without leaking provider messages or credentials", async () => {
    const workspace = await root();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      code: "Model.AccessDenied", message: "secret provider detail", request_id: "req-safe-1",
    }), { status: 403 })));

    const result = await new ImageTools(workspace, vi.fn(async () => "bailian-secret"), "DASHBOARD_API_KEY")
      .call("imagegen", { prompt: "draw a cube" });

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toContain("HTTP 403, code Model.AccessDenied, request_id req-safe-1");
    expect(result.content[0].text).not.toContain("secret provider detail");
    expect(result.content[0].text).not.toContain("bailian-secret");
  });

  it("distinguishes polling network failures from provider task failures", async () => {
    const workspace = await root();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ output: { task_id: "task-1", task_status: "PENDING" } })))
      .mockRejectedValueOnce(new Error("secret network detail")));

    const result = await new ImageTools(workspace, vi.fn(async () => "bailian-secret"), "DASHBOARD_API_KEY")
      .call("imagegen", { prompt: "draw a cube" });

    expect(result.content[0].text).toBe("Unable to poll Bailian image generation task (network request failed)");
    expect(JSON.stringify(result)).not.toContain("secret network detail");
  });

  it("accepts provider OSS result URLs without depending on one bucket prefix", async () => {
    const workspace = await root();
    const resultUrl = "https://bailian-output.oss-cn-beijing.aliyuncs.com/generated/cat.png?Expires=1";
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: { task_id: "task-1", task_status: "SUCCEEDED", results: [{ url: resultUrl }] },
      })))
      .mockResolvedValueOnce(new Response(Buffer.from("89504e470d0a1a0a", "hex"))));

    const result = await new ImageTools(workspace, vi.fn(async () => "secret"), "DASHBOARD_API_KEY")
      .call("imagegen", { prompt: "draw a cat" });

    expect(result.isError).not.toBe(true);
  });

  it("accepts the V2 choices image response documented by Bailian", async () => {
    const workspace = await root();
    const resultUrl = "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/generated/cat.png?Expires=1";
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: { task_id: "task-1", task_status: "SUCCEEDED", choices: [{ message: { content: [{ type: "image", image: resultUrl }] } }] },
      })))
      .mockResolvedValueOnce(new Response(Buffer.from("89504e470d0a1a0a", "hex"))));

    const result = await new ImageTools(workspace, vi.fn(async () => "secret"), "DASHBOARD_API_KEY")
      .call("imagegen", { prompt: "draw a cat" });

    expect(result.isError).not.toBe(true);
  });
});
