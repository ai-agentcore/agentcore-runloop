import { describe, it, expect } from "vitest";
import { createApp } from "@/server/index.js";

describe("C2: Agent CLI security", () => {
  it("rejects unregistered agent CLI names", async () => {
    const app = createApp();
    const res = await app.request("/v1/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: { cli: "/bin/sh" },
        model: { provider: "t", model: "t", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" },
        credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
        events: [
          {
            id: "e1",
            type: "user.message",
            timestamp: Date.now(),
            conversationId: "s1",
            content: "hello",
            role: "user",
          },
        ],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("agent");
  });

  it("rejects absolute paths as agent CLI", async () => {
    const app = createApp();
    const res = await app.request("/v1/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: { cli: "/usr/bin/curl" },
        model: { provider: "t", model: "t", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" },
        credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
        events: [
          {
            id: "e1",
            type: "user.message",
            timestamp: Date.now(),
            conversationId: "s1",
            content: "hello",
            role: "user",
          },
        ],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts registered agent CLI names", async () => {
    const app = createApp();
    const res = await app.request("/v1/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: { cli: "qodercli" },
        model: { provider: "t", model: "t", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" },
        credentials: { accessKeyId: "ak", accessKeySecret: "sk" },
        events: [
          {
            id: "e1",
            type: "user.message",
            timestamp: Date.now(),
            conversationId: "s1",
            content: "hello",
            role: "user",
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
  });
});
