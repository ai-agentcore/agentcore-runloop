import "dotenv/config";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const entry = new URL("../dist/src/main.js", import.meta.url);
if (!existsSync(fileURLToPath(entry))) throw new Error("Compiled server is missing; run npm run build");
await import(entry);
