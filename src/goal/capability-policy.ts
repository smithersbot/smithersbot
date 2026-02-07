// Baseline policy definition, matchers, and hard denies for goal capability enforcement.

import path from "node:path";
import type {
  CapabilityGrant,
  CapabilityId,
  CapabilityPolicy,
  EffectiveCapabilities,
  HardDeny,
} from "./capability-types.js";

// ---------------------------------------------------------------------------
// Default policy
// ---------------------------------------------------------------------------

/** Command patterns for exec.safe — build/test/lint + read-only discovery + git local. */
const EXEC_SAFE_PATTERNS: string[] = [
  // Build/test/lint
  "pnpm test",
  "pnpm lint",
  "pnpm build",
  "pnpm format",
  "npm test",
  "npm run ",
  "bun test",
  "bun run ",
  "npx ",
  "node ",
  "tsc ",
  "vitest ",
  "jest ",
  "eslint ",
  "oxlint ",
  "prettier ",
  // Git (local-only)
  "git status",
  "git diff",
  "git log",
  "git add",
  "git commit",
  "git branch",
  "git checkout",
  "git show",
  "git stash",
  // Read-only discovery
  "ls ",
  "find ",
  "grep ",
  "rg ",
  "wc ",
  // Safe builtins
  "echo ",
  "printf ",
  "test ",
  "true",
  "false",
  "mkdir ",
];

/** Command patterns for exec.install_deps — package install operations. */
const INSTALL_DEPS_PATTERNS: string[] = [
  "npm install",
  "pnpm install",
  "bun install",
  "pip install",
  "yarn add",
];

/** Commands excluded from exec.safe (bash bypass hole — can read/write arbitrary files). */
const BASH_BYPASS_COMMANDS: string[] = [
  "cat",
  "head",
  "tail",
  "cp",
  "mv",
  "rm",
  "sed",
  "awk",
  "tee",
  "dd",
];

/** Network tool commands (denied by default, unlocked via network.* grants). */
const NETWORK_COMMANDS: string[] = ["curl", "wget", "nc", "ncat"];

export function createDefaultPolicy(workingDir: string): CapabilityPolicy {
  const baseline: CapabilityGrant[] = [
    { id: "fs.read", pathGlobs: [`${workingDir}/**`] },
    { id: "fs.write", pathGlobs: [`${workingDir}/**`] },
    { id: "exec.safe", commandPatterns: EXEC_SAFE_PATTERNS },
    { id: "git.checkpoint" },
  ];

  const hardDenies: HardDeny[] = [
    {
      id: "secrets.read",
      pattern: "**/.env*",
      reason: "Reading secrets files (.env) is not allowed",
    },
    { id: "secrets.pem", pattern: "**/*.pem", reason: "Reading PEM keys is not allowed" },
    { id: "secrets.key", pattern: "**/*.key", reason: "Reading key files is not allowed" },
    {
      id: "secrets.credentials",
      pattern: "**/credentials*",
      reason: "Reading credentials is not allowed",
    },
    { id: "secrets.aws", pattern: "**/.aws/**", reason: "Reading AWS config is not allowed" },
    { id: "secrets.ssh", pattern: "**/.ssh/**", reason: "Reading SSH config is not allowed" },
    {
      id: "secrets.id_rsa",
      pattern: "**/*id_rsa*",
      reason: "Reading SSH keys is not allowed",
    },
    { id: "exec.sudo", pattern: "sudo *", reason: "sudo is not allowed" },
    {
      id: "git.force_push",
      pattern: "git push --force",
      reason: "Force push is not allowed",
    },
    {
      id: "git.force_push_short",
      pattern: "git push -f",
      reason: "Force push is not allowed",
    },
    {
      id: "git.rewrite_history",
      pattern: "git rebase -i",
      reason: "Interactive rebase is not allowed",
    },
    { id: "deploy.generic", pattern: "*deploy*", reason: "Deploy commands are not allowed" },
    { id: "deploy.fly", pattern: "fly deploy", reason: "Fly deploy is not allowed" },
    { id: "deploy.npm", pattern: "npm publish", reason: "npm publish is not allowed" },
    { id: "deploy.docker", pattern: "docker login", reason: "Docker login is not allowed" },
    { id: "dangerous_shell.rm", pattern: "rm -rf /", reason: "Dangerous rm -rf is not allowed" },
    { id: "dangerous_shell.mkfs", pattern: "mkfs", reason: "mkfs is not allowed" },
    { id: "dangerous_shell.dd", pattern: "dd if=", reason: "dd is not allowed" },
    { id: "network.curl", pattern: "curl ", reason: "curl requires network capability grant" },
    { id: "network.wget", pattern: "wget ", reason: "wget requires network capability grant" },
    { id: "network.nc", pattern: "nc ", reason: "nc requires network capability grant" },
    { id: "network.ncat", pattern: "ncat ", reason: "ncat requires network capability grant" },
  ];

  const expandableIds: CapabilityId[] = [
    "exec.install_deps",
    "network.registry_only",
    "network.read_only",
    "exec.long_running",
    "fs.write_config",
    "git.push_private",
  ];

  return { baseline, hardDenies, expandableIds };
}

// ---------------------------------------------------------------------------
// Path matching helpers
// ---------------------------------------------------------------------------

/** Simple glob matching for path patterns. */
function matchPathGlob(pattern: string, filePath: string): boolean {
  // Normalize separators
  const normalizedPattern = pattern.replace(/\\/g, "/");
  const normalizedPath = filePath.replace(/\\/g, "/");

  // Convert glob to regex
  let regex = "^";
  let i = 0;
  while (i < normalizedPattern.length) {
    const ch = normalizedPattern[i]!;
    if (ch === "*") {
      if (normalizedPattern[i + 1] === "*") {
        // ** matches any path segments
        if (normalizedPattern[i + 2] === "/") {
          regex += "(?:.*/)?";
          i += 3;
        } else {
          regex += ".*";
          i += 2;
        }
      } else {
        // * matches anything except /
        regex += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      regex += "[^/]";
      i += 1;
    } else {
      regex += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  regex += "$";

  return new RegExp(regex, "i").test(normalizedPath);
}

/** Check if a path matches any hard deny pattern. */
export function isPathDenied(filePath: string, denies: HardDeny[]): HardDeny | null {
  const resolved = path.resolve(filePath);
  for (const deny of denies) {
    // Only check path-like patterns (contain * or / or .)
    if (!deny.pattern.includes("*") && !deny.pattern.includes("/") && !deny.pattern.includes(".")) {
      continue;
    }
    if (matchPathGlob(deny.pattern, resolved)) {
      return deny;
    }
  }
  return null;
}

/** Check if a command matches any hard deny pattern. */
export function isCommandDenied(command: string, denies: HardDeny[]): HardDeny | null {
  const trimmed = command.trim();
  const lower = trimmed.toLowerCase();

  for (const deny of denies) {
    const pattern = deny.pattern.trim().toLowerCase();
    // Wildcard pattern: check if the pattern (without trailing wildcard) is a prefix
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      if (lower.startsWith(prefix)) return deny;
    } else if (pattern.includes("*")) {
      // Contains * in the middle — use glob matching
      if (matchPathGlob(pattern, lower)) return deny;
    } else {
      // Exact prefix match: command starts with the pattern
      if (lower.startsWith(pattern)) return deny;
    }
  }
  return null;
}

/** Check if a path is covered by at least one fs grant's pathGlobs. */
export function isPathWithinGrants(
  filePath: string,
  grants: CapabilityGrant[],
  workingDir: string,
): boolean {
  const resolved = path.resolve(workingDir, filePath);
  for (const grant of grants) {
    if (!grant.id.startsWith("fs.")) continue;
    if (!grant.pathGlobs) continue;
    for (const glob of grant.pathGlobs) {
      if (matchPathGlob(glob, resolved)) return true;
    }
  }
  return false;
}

/** Check if a command is covered by at least one exec grant's commandPatterns. */
export function isCommandWithinGrants(command: string, grants: CapabilityGrant[]): boolean {
  const trimmed = command.trim();
  const lower = trimmed.toLowerCase();

  // First check if the command starts with a bash-bypass command
  const firstToken = lower.split(/\s+/)[0] ?? "";
  if (BASH_BYPASS_COMMANDS.includes(firstToken)) {
    return false; // Never allowed via exec.safe — must use Read/Write/Edit tools
  }

  // Check if the command starts with a network tool
  if (NETWORK_COMMANDS.includes(firstToken)) {
    return false; // Denied at bash level — requires network.* capability
  }

  for (const grant of grants) {
    if (!grant.id.startsWith("exec.")) continue;
    if (!grant.commandPatterns) continue;
    for (const pattern of grant.commandPatterns) {
      const lowerPattern = pattern.toLowerCase();
      if (lower.startsWith(lowerPattern)) return true;
      // Also check with the pattern as an exact command (no trailing space)
      if (lower === lowerPattern.trimEnd()) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Infer missing capability
// ---------------------------------------------------------------------------

/** Deterministic heuristic to infer the most likely missing CapabilityId for a denied action. */
export function inferMissingCapability(
  action: { command?: string; path?: string; operation?: "read" | "write" | "edit" },
  _effective: EffectiveCapabilities,
  policy: CapabilityPolicy,
): CapabilityId | undefined {
  const command = action.command?.trim().toLowerCase() ?? "";
  const firstToken = command.split(/\s+/)[0] ?? "";

  // 1. Package install commands
  for (const pattern of INSTALL_DEPS_PATTERNS) {
    if (command.startsWith(pattern.toLowerCase())) return "exec.install_deps";
  }

  // 2. Git push
  if (command.startsWith("git push")) return "git.push_private";

  // 3. Network tools
  if (NETWORK_COMMANDS.includes(firstToken)) {
    // Check if URL matches a known registry
    if (
      command.includes("registry.npmjs.org") ||
      command.includes("pypi.org") ||
      command.includes("rubygems.org")
    ) {
      return "network.registry_only";
    }
    return "network.read_only";
  }

  // 4. Config file outside workingDir
  if (action.path && action.operation === "write") {
    const ext = path.extname(action.path).toLowerCase();
    if ([".config", ".json", ".yaml", ".yml", ".toml"].includes(ext)) {
      return "fs.write_config";
    }
    // Filename contains "config"
    if (path.basename(action.path).toLowerCase().includes("config")) {
      return "fs.write_config";
    }
  }

  // 5. Long-running commands
  if (
    command.includes("watch") ||
    command.includes("serve") ||
    command.includes("dev server") ||
    command.includes("--watch")
  ) {
    return "exec.long_running";
  }

  // 6. Check if ID is expandable but not granted
  if (command && policy.expandableIds.length > 0) {
    // Bash bypass commands hint at missing fs capability
    if (BASH_BYPASS_COMMANDS.includes(firstToken)) {
      return undefined; // These should use Read/Write/Edit tools instead
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Install deps pattern helper
// ---------------------------------------------------------------------------

/** Get command patterns for the exec.install_deps capability. */
export function getInstallDepsPatterns(): string[] {
  return [...INSTALL_DEPS_PATTERNS];
}

/** Get the list of bash bypass commands (not allowed in exec.safe). */
export function getBashBypassCommands(): string[] {
  return [...BASH_BYPASS_COMMANDS];
}

/** Get the list of network tool commands. */
export function getNetworkCommands(): string[] {
  return [...NETWORK_COMMANDS];
}
