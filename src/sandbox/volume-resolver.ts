import FCSandboxClientModule, {
  GetVolumeRequest,
  ListVolumesRequest,
} from "@alicloud/fcsandbox20260509";
import { $OpenApiUtil } from "@alicloud/openapi-core";
import {
  AgentSATokenProvider,
  HIGH_CODE_SDK_PURPOSE,
  ResourceSTSProvider,
} from "alibabacloud-agentcore-sdk/auth";
import { loadAgentConfig, RuntimeEnvironmentProvider } from "alibabacloud-agentcore-sdk/runtime";

type FCSandboxClient = InstanceType<typeof FCSandboxClientModule>;

// The generated Alibaba Cloud SDK is CommonJS. Under native Node ESM its constructor is nested
// under the synthetic default export, even though the package declarations describe a direct
// default class export.
const FCSandboxClientConstructor = (
  (FCSandboxClientModule as unknown as { default?: typeof FCSandboxClientModule }).default
  ?? FCSandboxClientModule
);

export function createFCSandboxOpenApiClient(config: $OpenApiUtil.Config): FCSandboxClient {
  return new FCSandboxClientConstructor(config);
}

export type SandboxVolumeMetadata = Record<string, string>;

export interface AgentSandboxVolume {
  volumeID?: string;
  volumeName?: string;
  teamID?: string;
  status?: string;
  storageClass?: string;
  mountConfig?: {
    role?: string;
    vpcConfig?: { vpcId?: string; securityGroupId?: string; vSwitchIds?: string[] };
  };
}

export interface AgentSandboxVolumeClient {
  listVolumes(request: {
    volumeName: string;
    teamID?: string;
    maxResults: number;
    nextToken?: string;
  }): Promise<{ volumes?: AgentSandboxVolume[]; nextToken?: string }>;
  getVolume(volumeId: string, request: { teamID: string }): Promise<{ volume?: AgentSandboxVolume }>;
}

export interface SandboxVolumeMetadataResolver {
  resolveMetadata(volumeName: string, teamId?: string): Promise<SandboxVolumeMetadata>;
  close?(): void;
}

type VolumeResolutionCode =
  | "VOLUME_NOT_FOUND"
  | "VOLUME_AMBIGUOUS"
  | "VOLUME_NOT_AVAILABLE"
  | "VOLUME_IDENTITY_INVALID"
  | "VOLUME_ROLE_INVALID"
  | "VOLUME_VPC_MISSING"
  | "VOLUME_VPC_INVALID"
  | "VOLUME_LOOKUP_INCONSISTENT";

export class SandboxVolumeResolutionError extends Error {
  readonly name = "SandboxVolumeResolutionError";
  constructor(readonly code: VolumeResolutionCode, message: string) { super(message); }
}

type ClientFactory = () => Promise<AgentSandboxVolumeClient>;

function matchesVolume(volume: AgentSandboxVolume, volumeName: string, teamId?: string): boolean {
  return volume.volumeName === volumeName && (!teamId || volume.teamID === teamId);
}

function requireSingleVolume(volumes: AgentSandboxVolume[], volumeName: string, teamId?: string): AgentSandboxVolume {
  const matches = volumes.filter(volume => matchesVolume(volume, volumeName, teamId));
  if (matches.length === 0) throw new SandboxVolumeResolutionError("VOLUME_NOT_FOUND", "Configured Agent Sandbox Volume was not found");
  if (matches.length > 1) {
    throw new SandboxVolumeResolutionError(
      "VOLUME_AMBIGUOUS", "Configured Agent Sandbox Volume is ambiguous; set AGENTCORE_SANDBOX_TEAM_ID",
    );
  }
  const volume = matches[0]!;
  if (volume.status !== "AVAILABLE") {
    throw new SandboxVolumeResolutionError("VOLUME_NOT_AVAILABLE", "Configured Agent Sandbox Volume is not available");
  }
  if (!volume.volumeID || !volume.teamID) {
    throw new SandboxVolumeResolutionError("VOLUME_IDENTITY_INVALID", "Configured Agent Sandbox Volume identity is incomplete");
  }
  return volume;
}

function validRole(role: string | undefined): role is string {
  return typeof role === "string" && /^acs:ram::[0-9]+:role\/[A-Za-z0-9@._+=,-]+$/.test(role);
}

function volumeMetadata(volume: AgentSandboxVolume): SandboxVolumeMetadata {
  const role = volume.mountConfig?.role;
  if (!validRole(role)) {
    throw new SandboxVolumeResolutionError("VOLUME_ROLE_INVALID", "Configured Agent Sandbox Volume execution role is missing or invalid");
  }
  const metadata: SandboxVolumeMetadata = { "fc.sandbox.auth.role": role };
  const vpc = volume.mountConfig?.vpcConfig;
  if (!vpc) {
    if (volume.storageClass !== "OSS") {
      throw new SandboxVolumeResolutionError("VOLUME_VPC_MISSING", "Configured Agent Sandbox Volume VPC configuration is missing");
    }
    return metadata;
  }
  if (!vpc.vpcId || !vpc.securityGroupId || !vpc.vSwitchIds?.length || vpc.vSwitchIds.some(id => !id)) {
    throw new SandboxVolumeResolutionError("VOLUME_VPC_INVALID", "Configured Agent Sandbox Volume VPC configuration is incomplete");
  }
  metadata["fc.sandbox.network.vpc"] = JSON.stringify({
    vpcId: vpc.vpcId,
    securityGroupId: vpc.securityGroupId,
    vSwitchIds: vpc.vSwitchIds,
  });
  return metadata;
}

export class AgentSandboxVolumeResolver implements SandboxVolumeMetadataResolver {
  private readonly cache = new Map<string, Promise<SandboxVolumeMetadata>>();

  constructor(private readonly createClient: ClientFactory) {}

  resolveMetadata(volumeName: string, teamId?: string): Promise<SandboxVolumeMetadata> {
    const key = JSON.stringify([teamId ?? "", volumeName]);
    const existing = this.cache.get(key);
    if (existing) return existing;
    const current = this.load(volumeName, teamId).catch(error => {
      if (this.cache.get(key) === current) this.cache.delete(key);
      throw error;
    });
    this.cache.set(key, current);
    return current;
  }

  private async load(volumeName: string, teamId?: string): Promise<SandboxVolumeMetadata> {
    const client = await this.createClient();
    const volumes: AgentSandboxVolume[] = [];
    let nextToken: string | undefined;
    do {
      const response = await client.listVolumes({
        volumeName,
        ...(teamId ? { teamID: teamId } : {}),
        maxResults: 100,
        ...(nextToken ? { nextToken } : {}),
      });
      volumes.push(...(response.volumes ?? []));
      nextToken = response.nextToken;
    } while (nextToken);
    const listed = requireSingleVolume(volumes, volumeName, teamId);
    const response = await client.getVolume(listed.volumeID!, { teamID: listed.teamID! });
    const resolved = response.volume;
    if (!resolved || !matchesVolume(resolved, volumeName, listed.teamID)) {
      throw new SandboxVolumeResolutionError(
        "VOLUME_LOOKUP_INCONSISTENT", "Configured Agent Sandbox Volume lookup returned an inconsistent resource",
      );
    }
    if (resolved.status !== "AVAILABLE") {
      throw new SandboxVolumeResolutionError("VOLUME_NOT_AVAILABLE", "Configured Agent Sandbox Volume is not available");
    }
    return volumeMetadata(resolved);
  }
}

interface ManagedClientDependencies {
  loadAgent(): Promise<{ regionId: string }>;
  loadEnvironment(): Promise<{ controllerUrl: string; agentSATokenFile: string }>;
  createResourceSts(controllerUrl: string, tokenFile: string): ResourceSTSProvider;
  createClient(config: $OpenApiUtil.Config): FCSandboxClient;
}

const managedClientDependencies: ManagedClientDependencies = {
  loadAgent: () => loadAgentConfig(),
  loadEnvironment: () => new RuntimeEnvironmentProvider().snapshot(),
  createResourceSts: (controllerUrl, tokenFile) =>
    new ResourceSTSProvider(controllerUrl, new AgentSATokenProvider(tokenFile)),
  createClient: createFCSandboxOpenApiClient,
};

export function createManagedAgentSandboxVolumeResolver(
  dependencies: ManagedClientDependencies = managedClientDependencies,
): SandboxVolumeMetadataResolver {
  let sts: ResourceSTSProvider | undefined;
  let client: Promise<AgentSandboxVolumeClient> | undefined;
  const createClient = async (): Promise<AgentSandboxVolumeClient> => {
    if (client) return client;
    client = (async () => {
      const [agent, environment] = await Promise.all([dependencies.loadAgent(), dependencies.loadEnvironment()]);
      sts = dependencies.createResourceSts(environment.controllerUrl, environment.agentSATokenFile);
      const credential = await sts.get(HIGH_CODE_SDK_PURPOSE);
      const sdk = dependencies.createClient(new $OpenApiUtil.Config({
        accessKeyId: credential.accessKeyId,
        accessKeySecret: credential.accessKeySecret,
        securityToken: credential.securityToken,
        regionId: agent.regionId,
        endpoint: `fcsandbox.${agent.regionId}.aliyuncs.com`,
        protocol: "https",
        connectTimeout: 5_000,
        readTimeout: 10_000,
      }));
      return {
        async listVolumes(request: Parameters<AgentSandboxVolumeClient["listVolumes"]>[0]) {
          const response = await sdk.listVolumes(new ListVolumesRequest(request));
          return { volumes: response.body?.volumes, nextToken: response.body?.nextToken };
        },
        async getVolume(volumeId: string, request: Parameters<AgentSandboxVolumeClient["getVolume"]>[1]) {
          const response = await sdk.getVolume(volumeId, new GetVolumeRequest(request));
          return { volume: response.body?.volume };
        },
      };
    })().catch(error => {
      client = undefined;
      sts?.close();
      sts = undefined;
      throw error;
    });
    return client;
  };
  const resolver = new AgentSandboxVolumeResolver(createClient);
  return {
    resolveMetadata: (volumeName, teamId) => resolver.resolveMetadata(volumeName, teamId),
    close: () => sts?.close(),
  };
}
