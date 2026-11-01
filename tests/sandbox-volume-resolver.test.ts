import { describe, expect, it, vi } from "vitest";
import { $OpenApiUtil } from "@alicloud/openapi-core";
import {
  AgentSandboxVolumeResolver,
  createFCSandboxOpenApiClient,
  createManagedAgentSandboxVolumeResolver,
  type AgentSandboxVolumeClient,
} from "../src/sandbox/volume-resolver.js";

function client(overrides: Partial<AgentSandboxVolumeClient> = {}): AgentSandboxVolumeClient {
  return {
    listVolumes: vi.fn(async () => ({
      volumes: [{
        volumeID: "volume-1",
        volumeName: "workspace",
        teamID: "team-1",
        status: "AVAILABLE",
      }],
    })),
    getVolume: vi.fn(async () => ({
      volume: {
        volumeID: "volume-1",
        volumeName: "workspace",
        teamID: "team-1",
        status: "AVAILABLE",
        storageClass: "AGENTIC_FS",
        mountConfig: {
          role: "acs:ram::123456789:role/sandbox-volume",
          vpcConfig: { vpcId: "vpc-1", securityGroupId: "sg-1", vSwitchIds: ["vsw-1"] },
        },
      },
    })),
    ...overrides,
  };
}

describe("AgentSandboxVolumeResolver", () => {
  it("constructs the CommonJS FCSandbox SDK client under native Node ESM", () => {
    const config = new $OpenApiUtil.Config({
      accessKeyId: "test-id",
      accessKeySecret: "test-secret",
      regionId: "cn-hangzhou",
      endpoint: "fcsandbox.cn-hangzhou.aliyuncs.com",
    });
    expect(createFCSandboxOpenApiClient(config)).toEqual(expect.objectContaining({
      _regionId: "cn-hangzhou",
      _endpoint: "fcsandbox.cn-hangzhou.aliyuncs.com",
    }));
  });

  it("loads a Volume mount policy once and returns sandbox metadata", async () => {
    const api = client();
    const resolver = new AgentSandboxVolumeResolver(async () => api);
    const expected = {
      "fc.sandbox.auth.role": "acs:ram::123456789:role/sandbox-volume",
      "fc.sandbox.network.vpc": JSON.stringify({
        vpcId: "vpc-1", securityGroupId: "sg-1", vSwitchIds: ["vsw-1"],
      }),
    };
    await expect(resolver.resolveMetadata("workspace")).resolves.toEqual(expected);
    await expect(resolver.resolveMetadata("workspace")).resolves.toEqual(expected);
    expect(api.listVolumes).toHaveBeenCalledTimes(1);
    expect(api.listVolumes).toHaveBeenCalledWith({ volumeName: "workspace", maxResults: 100 });
    expect(api.getVolume).toHaveBeenCalledWith("volume-1", { teamID: "team-1" });
  });

  it("uses the configured Team to disambiguate Volume names", async () => {
    const api = client({
      listVolumes: vi.fn(async () => ({ volumes: [
        { volumeID: "other", volumeName: "workspace", teamID: "team-2", status: "AVAILABLE" },
        { volumeID: "wanted", volumeName: "workspace", teamID: "team-1", status: "AVAILABLE" },
      ] })),
    });
    const resolver = new AgentSandboxVolumeResolver(async () => api);
    await resolver.resolveMetadata("workspace", "team-1");
    expect(api.listVolumes).toHaveBeenCalledWith({ volumeName: "workspace", teamID: "team-1", maxResults: 100 });
    expect(api.getVolume).toHaveBeenCalledWith("wanted", { teamID: "team-1" });
  });

  it("rejects ambiguous, unavailable, and incomplete AgenticFS Volumes", async () => {
    const ambiguous = new AgentSandboxVolumeResolver(async () => client({
      listVolumes: vi.fn(async () => ({ volumes: [
        { volumeID: "one", volumeName: "workspace", teamID: "team-1", status: "AVAILABLE" },
        { volumeID: "two", volumeName: "workspace", teamID: "team-2", status: "AVAILABLE" },
      ] })),
    }));
    await expect(ambiguous.resolveMetadata("workspace")).rejects.toThrow(/SANDBOX_TEAM_ID/);

    const unavailable = new AgentSandboxVolumeResolver(async () => client({
      listVolumes: vi.fn(async () => ({ volumes: [
        { volumeID: "one", volumeName: "workspace", teamID: "team-1", status: "ERROR" },
      ] })),
    }));
    await expect(unavailable.resolveMetadata("workspace")).rejects.toThrow(/not available/);

    const incomplete = new AgentSandboxVolumeResolver(async () => client({
      getVolume: vi.fn(async () => ({ volume: {
        volumeID: "volume-1", volumeName: "workspace", teamID: "team-1", status: "AVAILABLE",
        storageClass: "AGENTIC_FS", mountConfig: { role: "acs:ram::123456789:role/sandbox-volume" },
      } })),
    }));
    await expect(incomplete.resolveMetadata("workspace")).rejects.toThrow(/VPC configuration/);

    const incompleteVpc = new AgentSandboxVolumeResolver(async () => client({
      getVolume: vi.fn(async () => ({ volume: {
        volumeID: "volume-1", volumeName: "workspace", teamID: "team-1", status: "AVAILABLE",
        storageClass: "AGENTIC_FS",
        mountConfig: {
          role: "acs:ram::123456789:role/sandbox-volume",
          vpcConfig: { vpcId: "vpc-1", securityGroupId: "sg-1", vSwitchIds: [""] },
        },
      } })),
    }));
    await expect(incompleteVpc.resolveMetadata("workspace")).rejects.toThrow(/VPC configuration/);
  });

  it("requires a role but does not require VPC metadata for OSS Volumes", async () => {
    const api = client({
      getVolume: vi.fn(async () => ({ volume: {
        volumeID: "volume-1", volumeName: "workspace", teamID: "team-1", status: "AVAILABLE",
        storageClass: "OSS", mountConfig: { role: "acs:ram::123456789:role/sandbox-volume" },
      } })),
    });
    const resolver = new AgentSandboxVolumeResolver(async () => api);
    await expect(resolver.resolveMetadata("workspace")).resolves.toEqual({
      "fc.sandbox.auth.role": "acs:ram::123456789:role/sandbox-volume",
    });
  });

  it("uses AgentCore runtime STS to create the FCSandbox OpenAPI client", async () => {
    const api = client();
    const close = vi.fn();
    const get = vi.fn(async () => ({
      accessKeyId: "sts-id", accessKeySecret: "sts-secret", securityToken: "sts-token",
    }));
    const createClient = vi.fn(() => ({
      listVolumes: async (request: { volumeName?: string; teamID?: string; maxResults?: number }) => ({
        body: await api.listVolumes({
          volumeName: request.volumeName!, teamID: request.teamID, maxResults: request.maxResults!,
        }),
      }),
      getVolume: async (volumeId: string, request: { teamID?: string }) => ({
        body: await api.getVolume(volumeId, { teamID: request.teamID! }),
      }),
    }));
    const resolver = createManagedAgentSandboxVolumeResolver({
      loadAgent: async () => ({ regionId: "cn-hangzhou" }),
      loadEnvironment: async () => ({ controllerUrl: "https://controller.example", agentSATokenFile: "/token" }),
      createResourceSts: vi.fn(() => ({ get, close })),
      createClient,
    } as never);
    await expect(resolver.resolveMetadata("workspace", "team-1")).resolves.toHaveProperty(
      "fc.sandbox.auth.role", "acs:ram::123456789:role/sandbox-volume",
    );
    expect(get).toHaveBeenCalledWith("highcode_sdk");
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({
      regionId: "cn-hangzhou", endpoint: "fcsandbox.cn-hangzhou.aliyuncs.com", protocol: "https",
    }));
    resolver.close?.();
    expect(close).toHaveBeenCalled();
  });

  it("retries managed client initialization after an STS failure", async () => {
    const api = client();
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    const createResourceSts = vi.fn()
      .mockReturnValueOnce({ get: vi.fn(async () => { throw new Error("unavailable"); }), close: firstClose })
      .mockReturnValueOnce({ get: vi.fn(async () => ({ accessKeyId: "id", accessKeySecret: "secret" })), close: secondClose });
    const resolver = createManagedAgentSandboxVolumeResolver({
      loadAgent: async () => ({ regionId: "cn-hangzhou" }),
      loadEnvironment: async () => ({ controllerUrl: "https://controller.example", agentSATokenFile: "/token" }),
      createResourceSts,
      createClient: () => ({
        listVolumes: async () => ({ body: await api.listVolumes({ volumeName: "workspace", maxResults: 100 }) }),
        getVolume: async (volumeId: string) => ({ body: await api.getVolume(volumeId, { teamID: "team-1" }) }),
      }),
    } as never);
    await expect(resolver.resolveMetadata("workspace")).rejects.toThrow("unavailable");
    expect(firstClose).toHaveBeenCalled();
    await expect(resolver.resolveMetadata("workspace")).resolves.toHaveProperty("fc.sandbox.network.vpc");
    resolver.close?.();
    expect(secondClose).toHaveBeenCalled();
  });
});
