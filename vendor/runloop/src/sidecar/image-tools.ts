import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { McpToolDescriptor, McpToolResult } from "../mcp/types.js";

export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export type ImageCredentialProvider = (credentialName: string) => Promise<string>;

export const IMAGE_TOOL_DESCRIPTORS: McpToolDescriptor[] = [
  {
    name: "view_image",
    description: "View a PNG, JPEG, or WebP file in the current session. Bailian analyzes the image and returns its visible content as text.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, detail: { type: "string", enum: ["high", "original"] } },
      required: ["path"], additionalProperties: false,
    },
  },
  {
    name: "imagegen",
    description: "Generate an image with Bailian and save it under .generated-images in the current session.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" }, transparent_background: { type: "boolean" },
        referenced_image_paths: { type: "array", items: { type: "string" }, maxItems: 5 },
        num_last_images_to_include: { type: "integer", minimum: 1, maximum: 5 },
      },
      required: ["prompt"], additionalProperties: false,
    },
  },
];

const IMAGE_TOOL_NAMES = new Set(["view_image", "imagegen"]);
export const isImageTool = (name: string): boolean => IMAGE_TOOL_NAMES.has(name);
export const imageCredentialName = (): string => (process.env.IMAGE_ABLE ?? "DASHBOARD_API_KEY").trim();

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function readBoundedBody(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new Error("image service unavailable");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("image response too large");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}

class ImageProviderError extends Error {
  constructor(readonly safeDetail: string) { super("image provider request failed"); }
}

function safeProviderField(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
}

function providerDetail(status: number | undefined, payload: any, taskStatus?: string): string {
  const parts = [status === undefined ? undefined : `HTTP ${status}`, taskStatus ? `task ${taskStatus}` : undefined];
  const code = safeProviderField(payload?.code);
  const requestId = safeProviderField(payload?.request_id);
  if (code) parts.push(`code ${code}`);
  if (requestId) parts.push(`request_id ${requestId}`);
  return parts.filter(Boolean).join(", ");
}

async function providerJson(response: Response): Promise<any> {
  let body: Buffer;
  try { body = await readBoundedBody(response, 1024 * 1024); } catch {
    throw new ImageProviderError("unreadable response body");
  }
  let payload: any;
  try { payload = JSON.parse(body.toString()); } catch {
    if (!response.ok) throw new ImageProviderError(`HTTP ${response.status}`);
    throw new ImageProviderError("invalid JSON response");
  }
  if (!response.ok) throw new ImageProviderError(providerDetail(response.status, payload));
  return payload;
}

async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok) throw new Error("image service unavailable");
  return readBoundedBody(response, limit);
}

const pause = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

function asyncQwenImageModel(model: string): boolean {
  return model === "qwen-image" || model.startsWith("qwen-image-plus");
}

function generatedImageUrl(output: any): unknown {
  const result = output?.results?.find?.((item: any) => typeof item?.url === "string")?.url;
  if (typeof result === "string") return result;
  for (const choice of output?.choices ?? []) {
    const image = choice?.message?.content?.find?.((item: any) => typeof item?.image === "string")?.image;
    if (typeof image === "string") return image;
  }
  return undefined;
}

function isAliyunOssResultHost(hostname: string): boolean {
  const labels = hostname.split(".");
  if (labels.length < 4 || labels.at(-2) !== "aliyuncs" || labels.at(-1) !== "com") return false;
  const endpoint = labels.at(-3);
  return typeof endpoint === "string" && /^oss-[a-z0-9-]+$/.test(endpoint)
    && labels.slice(0, -3).every(label => /^[a-z0-9][a-z0-9-]{0,62}$/.test(label));
}

export function imageMime(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) return "image/jpeg";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw new Error("unsupported image type");
}

export class ImageTools {
  private readonly root: string;

  constructor(workdir: string, private readonly credential: ImageCredentialProvider,
    private readonly credentialName = imageCredentialName()) {
    this.root = resolve(workdir);
  }

  private target(path: string): string {
    if (!path || path.includes("\0")) throw new Error("invalid image path");
    const target = resolve(this.root, path);
    if (!contained(this.root, target)) throw new Error("image path is outside this session");
    return target;
  }

  private async readImage(path: string): Promise<{ data: string; mime: string }> {
    const target = this.target(path);
    if ((await lstat(target)).isSymbolicLink()) throw new Error("image symlink is not allowed");
    const actual = await realpath(target);
    if (!contained(await realpath(this.root), actual)) throw new Error("image path is outside this session");
    const file = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!(await file.stat()).isFile()) throw new Error("image must be a regular file");
      const bytes = Buffer.alloc(IMAGE_MAX_BYTES + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, null);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset > IMAGE_MAX_BYTES) throw new Error("image exceeds 8 MiB");
      const body = bytes.subarray(0, offset);
      return { data: body.toString("base64"), mime: imageMime(body) };
    } finally { await file.close(); }
  }

  private async writeGenerated(bytes: Buffer): Promise<string> {
    if (bytes.length > IMAGE_MAX_BYTES) throw new Error("image exceeds 8 MiB");
    imageMime(bytes);
    const directory = resolve(this.root, ".generated-images");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await lstat(directory)).isSymbolicLink() || !contained(await realpath(this.root), await realpath(directory))) {
      throw new Error("unsafe generated image directory");
    }
    const target = resolve(directory, `${randomUUID()}.png`);
    if (!contained(this.root, target) || dirname(target) !== directory) throw new Error("unsafe generated image path");
    const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await file.writeFile(bytes); } finally { await file.close(); }
    return target;
  }

  async call(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    let stage = "validate image arguments";
    let key = "";
    try {
      if (!isImageTool(name) || !this.credentialName || this.credentialName === "0") throw new Error();
      const viewing = name === "view_image";
      if (viewing ? typeof args.path !== "string" || !args.path.trim()
        : typeof args.prompt !== "string" || !args.prompt.trim() || args.prompt.length > 16000) throw new Error();
      if (args.detail !== undefined && args.detail !== "high" && args.detail !== "original") throw new Error();
      if (args.transparent_background !== undefined && typeof args.transparent_background !== "boolean") throw new Error();
      if (args.referenced_image_paths !== undefined && (!Array.isArray(args.referenced_image_paths)
        || args.referenced_image_paths.some(path => typeof path !== "string") || args.referenced_image_paths.length > 5)) throw new Error();
      if (args.num_last_images_to_include !== undefined) throw new Error();
      const origin = new URL(process.env.AGENTCORE_IMAGE_BASE_URL ?? "https://dashscope.aliyuncs.com");
      if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") throw new Error();
      stage = "read AgentCore image credential";
      key = (await this.credential(this.credentialName)).trim();
      if (!key) throw new Error();
      const requestJson = async (path: string, init: RequestInit): Promise<any> => {
        let response: Response;
        try {
          response = await fetch(new URL(path, origin), { ...init, redirect: "error", signal: AbortSignal.timeout(180000) });
        } catch { throw new ImageProviderError("network request failed"); }
        return providerJson(response);
      };
      const post = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<any> => requestJson(path, {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });

      let result: unknown;
      if (viewing) {
        stage = "read image file";
        const image = await this.readImage(args.path as string);
        stage = "call Bailian vision";
        const response = await post("/compatible-mode/v1/chat/completions", {
          model: process.env.AGENTCORE_IMAGE_VISION_MODEL ?? "qwen-vl-max", stream: false,
          messages: [{ role: "user", content: [
            { type: "image_url", image_url: { url: `data:${image.mime};base64,${image.data}` } },
            { type: "text", text: "Describe the image accurately, including visible text and details relevant to a coding agent." },
          ] }],
        });
        const answer = response.choices?.[0]?.message?.content;
        if (typeof answer !== "string" || !answer) throw new Error();
        result = { answer };
      } else {
        stage = "read reference images";
        const references = (args.referenced_image_paths as string[] | undefined) ?? [];
        const model = process.env.AGENTCORE_IMAGE_GENERATION_MODEL ?? "qwen-image-plus";
        if (asyncQwenImageModel(model) && references.length) throw new Error("qwen-image-plus does not accept reference images");
        const content: Record<string, string>[] = [];
        for (const reference of references) {
          const image = await this.readImage(reference);
          content.push({ image: `data:${image.mime};base64,${image.data}` });
        }
        const prompt = args.transparent_background
          ? `${args.prompt as string}\nThe output must have a transparent background and preserve a real alpha channel.`
          : args.prompt as string;
        stage = "call Bailian image generation";
        let generatedUrl: unknown;
        if (asyncQwenImageModel(model)) {
          stage = "submit Bailian image generation task";
          let response = await post("/api/v1/services/aigc/text2image/image-synthesis", {
            model, input: { prompt }, parameters: { n: 1 },
          }, { "X-DashScope-Async": "enable" });
          const taskId = response.output?.task_id;
          if (typeof taskId !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(taskId)) throw new ImageProviderError("missing or invalid task_id");
          const deadline = Date.now() + 180000;
          stage = "poll Bailian image generation task";
          while (response.output?.task_status === "PENDING" || response.output?.task_status === "RUNNING") {
            if (Date.now() >= deadline) throw new ImageProviderError("poll timeout");
            response = await requestJson(`/api/v1/tasks/${taskId}`, {
              method: "GET", headers: { Authorization: `Bearer ${key}` },
            });
            if (response.output?.task_status === "PENDING" || response.output?.task_status === "RUNNING") await pause(2000);
          }
          if (response.output?.task_status !== "SUCCEEDED") {
            const taskStatus = safeProviderField(response.output?.task_status) ?? "UNKNOWN";
            throw new ImageProviderError(providerDetail(undefined, response, taskStatus));
          }
          stage = "read Bailian image generation result";
          generatedUrl = generatedImageUrl(response.output);
        } else {
          content.push({ text: prompt });
          const response = await post("/api/v1/services/aigc/multimodal-generation/generation", {
            model, input: { messages: [{ role: "user", content }] }, parameters: { n: 1 },
          });
          generatedUrl = generatedImageUrl(response.output);
        }
        if (typeof generatedUrl !== "string") throw new ImageProviderError("missing result URL");
        let url: URL;
        try { url = new URL(generatedUrl); } catch { throw new ImageProviderError("invalid result URL"); }
        if (url.protocol !== "https:" || url.username || url.password || url.port
          || !isAliyunOssResultHost(url.hostname)) {
          throw new ImageProviderError("untrusted result URL");
        }
        stage = "download generated image";
        const bytes = await boundedBody(await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60000) }), IMAGE_MAX_BYTES);
        stage = "save generated image";
        const filePath = await this.writeGenerated(bytes);
        result = { file_path: filePath, mime_type: imageMime(bytes), bytes: bytes.length };
      }
      return { content: [{ type: "text", text: JSON.stringify(result).split(key).join("[REDACTED]") }] };
    } catch (error) {
      const detail = error instanceof ImageProviderError && error.safeDetail ? ` (${error.safeDetail})` : "";
      return { isError: true, content: [{ type: "text", text: `Unable to ${stage}${detail}` }] };
    }
  }
}
