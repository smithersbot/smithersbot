import os from "node:os";
import path from "node:path";

export const GATEWAY_INSTANCE_SELECTIONS = ["default", "stable", "dev"] as const;

export type GatewayInstanceSelection = (typeof GATEWAY_INSTANCE_SELECTIONS)[number];
export type GatewayInstanceName = "stable" | "dev";

export type GatewayInstanceIdentity = {
  name: GatewayInstanceName;
  label: string;
  serviceUnit: string;
  stateDirName: string;
  stateDir: string;
  managedRootDirName: string;
  managedRoot: string;
  defaultPort: number;
  legacyStateFallbacks: boolean;
  legacyManagedRootFallback: boolean;
};

type GatewayInstanceDefinition = Omit<GatewayInstanceIdentity, "stateDir" | "managedRoot">;

const GATEWAY_INSTANCE_DEFINITIONS: Record<GatewayInstanceName, GatewayInstanceDefinition> = {
  stable: {
    name: "stable",
    label: "stable",
    serviceUnit: "smithersbot-gateway.service",
    stateDirName: ".smithersbot",
    managedRootDirName: "smithersbot-home",
    defaultPort: 18789,
    legacyStateFallbacks: true,
    legacyManagedRootFallback: true,
  },
  dev: {
    name: "dev",
    label: "dev",
    serviceUnit: "smithersbot-dev-gateway.service",
    stateDirName: ".smithersbot-dev",
    managedRootDirName: "smithersbot-dev-home",
    defaultPort: 18790,
    legacyStateFallbacks: false,
    legacyManagedRootFallback: false,
  },
};

const ALLOWED_INSTANCE_LABEL = GATEWAY_INSTANCE_SELECTIONS.join(", ");

export function normalizeGatewayInstanceSelection(input?: string | null): GatewayInstanceName {
  const trimmed = input?.trim();
  if (!trimmed) return "stable";

  const normalized = trimmed.toLowerCase();
  if (normalized === "default" || normalized === "stable") return "stable";
  if (normalized === "dev") return "dev";

  throw new Error(
    `Unknown SmithersBot gateway instance "${trimmed}". Allowed values: ${ALLOWED_INSTANCE_LABEL}.`,
  );
}

export function resolveGatewayInstanceIdentity(
  input?: string | null,
  homedir: () => string = os.homedir,
): GatewayInstanceIdentity {
  const name = normalizeGatewayInstanceSelection(input);
  const definition = GATEWAY_INSTANCE_DEFINITIONS[name];
  const home = homedir();
  return {
    ...definition,
    stateDir: path.join(home, definition.stateDirName),
    managedRoot: path.join(home, definition.managedRootDirName),
  };
}

export function resolveGatewayInstanceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): GatewayInstanceIdentity {
  return resolveGatewayInstanceIdentity(env.SMITHERSBOT_INSTANCE, homedir);
}
