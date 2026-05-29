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

/**
 * Explicit opt-in signal naming which OTHER instances the running gateway may
 * observe (read-only) for repo chat, diagnostics, and context. Comma-separated
 * list of instance names, e.g. `SMITHERSBOT_OBSERVED_INSTANCES=dev`.
 *
 * Observation is NEVER inferred from the checkout/working directory: with no
 * explicit opt-in, nothing is observable.
 */
export const OBSERVED_INSTANCES_ENV = "SMITHERSBOT_OBSERVED_INSTANCES";

/**
 * Options for resolving the set of explicitly-observed instances.
 *
 * - `observedInstances`: explicit list (e.g. fed from a `gateway.observedInstances`
 *   config field). When provided (even as an empty array) it is authoritative and
 *   the env signal is NOT consulted.
 * - otherwise the {@link OBSERVED_INSTANCES_ENV} env signal is parsed.
 */
export type ObservedInstanceOptions = {
  observedInstances?: Iterable<string> | null;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
};

/**
 * Resolve the set of instances the current process is explicitly opted in to
 * observe. Unknown instance names are rejected via
 * {@link normalizeGatewayInstanceSelection}. With no opt-in the set is empty.
 */
export function resolveObservedInstanceSet(
  options?: ObservedInstanceOptions,
): Set<GatewayInstanceName> {
  const raw: string[] = [];
  const explicit = options?.observedInstances;
  if (explicit != null) {
    for (const entry of explicit) raw.push(entry);
  } else {
    const env = options?.env ?? process.env;
    const fromEnv = env[OBSERVED_INSTANCES_ENV];
    if (fromEnv) raw.push(...fromEnv.split(","));
  }

  const set = new Set<GatewayInstanceName>();
  for (const entry of raw) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    set.add(normalizeGatewayInstanceSelection(trimmed));
  }
  return set;
}

/** True when `instanceName` is an explicitly opted-in observed instance. */
export function isInstanceObserved(
  instanceName: string,
  options?: ObservedInstanceOptions,
): boolean {
  return resolveObservedInstanceSet(options).has(normalizeGatewayInstanceSelection(instanceName));
}
