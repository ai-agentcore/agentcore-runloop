import { z } from "zod";
import type { Resource } from "../types/resources.js";
import { ResourceSchema } from "../types/resources.js";

const ResourceListSchema = z.array(ResourceSchema);

export interface ResourceLoader {
  load(): Promise<Resource[]>;
}

export class JsonResourceLoader implements ResourceLoader {
  constructor(private readonly data: unknown) {}

  async load(): Promise<Resource[]> {
    return ResourceListSchema.parse(this.data);
  }
}

export class CliResourceLoader implements ResourceLoader {
  constructor(
    private readonly command: string,
    private readonly args: string[] = []
  ) {}

  async load(): Promise<Resource[]> {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    const { stdout } = await execFileAsync(this.command, this.args, {
      encoding: "utf-8",
      timeout: 30_000,
    });

    const data = JSON.parse(stdout);
    return ResourceListSchema.parse(data);
  }
}
