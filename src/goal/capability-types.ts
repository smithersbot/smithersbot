// Capability types for goal enforcement

// --- Capability IDs ---

export type CapabilityId =
  | "fs.read"
  | "fs.write"
  | "fs.write_config"
  | "exec.safe"
  | "exec.install_deps"
  | "exec.long_running"
  | "network.registry_only"
  | "network.read_only"
  | "git.checkpoint"
  | "git.push_private";

// --- TTL: per-node or per-attempt ---

export type CapabilityTtl = "node" | "attempt";

// --- Capability grant ---

export type CapabilityGrant = {
  id: CapabilityId;
  /** Default "node" — persists across retries. "attempt" = excluded on retry. */
  ttl?: CapabilityTtl;
  /** For fs.* — allowed path patterns (globs). */
  pathGlobs?: string[];
  /** For exec.* — allowed command prefixes. */
  commandPatterns?: string[];
  /** For network.* — allowed domains. */
  domainAllowlist?: string[];
  /** For exec.long_running — extended timeout in ms. */
  timeoutMs?: number;
};

// --- Hard deny ---

export type HardDeny = {
  /** Descriptive key, e.g. "secrets.read". */
  id: string;
  /** Glob or command pattern. */
  pattern: string;
  /** Human-readable reason. */
  reason: string;
};

// --- Policy ---

export type CapabilityPolicy = {
  baseline: CapabilityGrant[];
  hardDenies: HardDeny[];
  /** Only these capability IDs can be requested by the planner. */
  expandableIds: CapabilityId[];
};

// --- Effective capabilities (broker output) ---

export type EffectiveCapabilities = {
  /** Merged baseline + validated node requests. */
  grants: CapabilityGrant[];
  /** Always from global policy. */
  denies: HardDeny[];
  /** Which grants came from node requests (for logging/audit). */
  nodeGrants: CapabilityGrant[];
};

// --- Denied action ---

export type DeniedAction = {
  type: "exec" | "read" | "write" | "edit" | "network" | "git";
  command?: string;
  path?: string;
  reason: string;
  /** true = from hard deny list, false = missing capability. */
  hardDeny: boolean;
  missingCapabilityId?: CapabilityId;
};
