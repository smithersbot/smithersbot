import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isPathInsideAgentRoot,
  isPathInsidePrivateRoot,
  resolveAgentRoot,
  resolveObservedInspectionTarget,
  resolveObservedSealedRoots,
  resolvePrivateRoot,
  resolveScratchDir,
  type ObservedInspectionTarget,
} from "../config/managed-paths.js";
import type { GatewayInstanceName } from "../config/gateway-instance.js";
import { stripClaudeSubscriptionAuthEnv } from "./claude-code-env.js";

export type CodexSandboxPurpose = "goal-worker" | "repo-chat";
export type ClaudeSandboxPurpose = CodexSandboxPurpose;

export type CodexSandboxConfig = {
  mode: "read-only" | "workspace-write";
  executionRoot: string;
  configOverrides: string[];
};

export type CodexNativeSandboxConfig = {
  profileName: "smithersbot";
  executionRoot: string;
  codexHome: string;
  configPath: string;
  helperDir: string;
  helperPath: string;
  codexPath: string;
  /**
   * Path inside the generated CODEX_HOME where Codex looks for auth.json.
   * writeCodexNativeSandboxConfig symlinks this to {@link authSourcePath} so the
   * unsandboxed Codex control plane can authenticate while the sandboxed shell
   * stays blocked (the symlink resolves to the already-denied real auth path).
   */
  authReferencePath: string;
  /** Real Codex auth.json the auth reference points at ($CODEX_HOME ?? ~/.codex). */
  authSourcePath: string;
  env: Record<string, string>;
  args: string[];
  configToml: string;
  deniedReadPaths: string[];
  allowedReadPaths: string[];
  writablePaths: string[];
};

export type CodexNativeSandboxStatus =
  | {
      proven: true;
      codexPath: string;
      version: string;
      configPath: string;
      helperPath: string;
      summary: string;
    }
  | {
      proven: false;
      reason: string;
      blocker:
        | "codex-not-found"
        | "helper-discovery-failed"
        | "config-generation-failed"
        | "live-probe-required"
        | "live-probe-failed"
        | "operator-action-required";
      command?: string;
      operatorCommand?: string;
      details?: string;
    };

export type ClaudeCodeSandboxSettingsConfig = {
  settingsDir: string;
  settingsPath: string;
  settings: {
    sandbox: {
      enabled: true;
      failIfUnavailable: true;
      autoAllowBashIfSandboxed: false;
      filesystem: {
        allowRead: string[];
        allowWrite: string[];
        denyRead: string[];
      };
      // Present only when a step opts in via requiresNetwork=true. Omitted
      // (no network) for normal repo-local steps. Mirrors Codex's
      // [permissions.smithersbot.network] enabled grant.
      //
      // Claude Code's sandbox network proxy is allowlist-based and DEFAULT-DENY:
      // an unmatched host is refused at the proxy (HTTP 403 on CONNECT). There is
      // no universal allow-all token (bare "*"/"**"/"*.*" match nothing). Broad
      // egress is expressed as a list of per-suffix wildcards
      // (CLAUDE_SANDBOX_BROAD_NETWORK_DOMAINS) where each `*.<tld>` matches any
      // host under that suffix including the apex. We grant that for a
      // requiresNetwork step.
      network?: { allowedDomains: string[] };
    };
    permissions: {
      deny: string[];
    };
  };
};

export type ClaudeCodeLaunchSandboxConfig = {
  settingsPath: string;
  args: string[];
};

export type ClaudeCodeNativeSandboxStatus =
  | {
      supported: true;
      claudePath: string;
      version: string;
      settingsPath: string;
      summary: string;
    }
  | {
      supported: false;
      reason: string;
      blocker:
        | "claude-not-found"
        | "missing-host-prerequisite"
        | "settings-generation-failed"
        | "live-probe-required"
        | "live-probe-failed"
        | "operator-action-required";
      command?: string;
      operatorCommand?: string;
      details?: string;
    };

export type ClaudeSubscriptionAuthProbeId =
  | "plain_unset_api_key_env"
  | "settings_without_claude_deny"
  | "setting_sources_empty"
  | "permissions_deny_claude_only"
  | "sandbox_deny_claude_only"
  | "full_generated_settings";

export type ClaudeSubscriptionAuthProbeBlocker =
  | "none"
  | "claude-not-found"
  | "live-probe-required"
  | "settings-generation-failed"
  | "api-key-env-poisoning"
  | "missing-subscription-login"
  | "generated-settings-hiding-claude-auth"
  | "native-sandbox-libx32-runtime-blocker"
  | "generic-failure";

export type ClaudeSubscriptionAuthProbeResult = {
  id: ClaudeSubscriptionAuthProbeId;
  ok: boolean;
  blocker: ClaudeSubscriptionAuthProbeBlocker;
};

export type ClaudeSubscriptionAuthProbeReport = {
  enabled: boolean;
  ok: boolean;
  blocker: ClaudeSubscriptionAuthProbeBlocker;
  results: ClaudeSubscriptionAuthProbeResult[];
};

const DEFAULT_CODEX_SANDBOX_ROOT = "/var/tmp";
const CODEX_SANDBOX_LIVE_PROBES_ENV = "SMITHERSBOT_CODEX_SANDBOX_LIVE_PROBES";

/**
 * Broad network allowlist for a Claude Code `requiresNetwork=true` step.
 *
 * Claude Code's sandbox network proxy is allowlist-based and DEFAULT-DENY, and
 * (unlike Codex's unrestricted `[permissions.smithersbot.network] enabled=true`)
 * it has NO universal allow-all token. The documented/observed `allowedDomains`
 * wildcard is a single leading label, `*.<suffix>`, which matches any host under
 * that suffix INCLUDING the apex (`*.com` matches `example.com` and
 * `api.example.com`). A bare `"*"`, `"**"`, or `"*.*"` matches nothing and the
 * proxy returns HTTP 403 on CONNECT. The non-interactive goal worker cannot use
 * the `dangerouslyDisableSandbox` escape hatch (it has no human to approve the
 * fallback), so the only way to actually open egress for the step is to pre-allow
 * domains here.
 *
 * We therefore grant per-suffix wildcards across the common public TLDs. This
 * covers the overwhelming majority of real external endpoints (the live test's
 * example.com is matched by `*.com`). It is intentionally NOT a security boundary
 * equal to Codex's full grant: an exotic TLD or a bare-IP host the step happens
 * to need is still denied by the proxy and surfaces as a real Claude sandbox
 * capability error (curl exit 56 / HTTP 403 from proxy), never a silent success.
 */
const CLAUDE_SANDBOX_BROAD_NETWORK_DOMAINS: readonly string[] = [
  "*.com",
  "*.org",
  "*.net",
  "*.io",
  "*.dev",
  "*.ai",
  "*.co",
  "*.app",
  "*.cloud",
  "*.gov",
  "*.edu",
  "*.mil",
  "*.info",
  "*.biz",
  "*.xyz",
  "*.me",
  "*.us",
  "*.uk",
  "*.eu",
  "*.ca",
  "*.de",
  "*.fr",
  "*.jp",
  "*.au",
  "*.in",
  "*.sh",
  "*.tech",
];
const DEFAULT_CLAUDE_SANDBOX_SETTINGS_ROOT = DEFAULT_CODEX_SANDBOX_ROOT;
const CLAUDE_SANDBOX_LIVE_PROBES_ENV = "SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES";
const KNOWN_CLAUDE_LIBX32_BWRAP_ERROR =
  "bwrap: Can't mount tmpfs on /newroot/libx32: No such file or directory";
const CLAUDE_AUTH_OK_REPLY = "claude-auth-ok";
const OBSERVABLE_GATEWAY_INSTANCES: GatewayInstanceName[] = ["stable", "dev"];
const PRIVATE_RUNTIME_SUBDIRS = ["env", "config", "auth", "sessions"];

/**
 * Classify the working dir against the explicitly opted-in observed instances,
 * but only for repo-chat (the read-only inspection surface). Goal-worker runs
 * never target another instance's surface, so they keep the current process's
 * own resolution untouched.
 */
function observedInspectionTarget(params: {
  workingDir: string;
  purpose: CodexSandboxPurpose;
}): ObservedInspectionTarget {
  if (params.purpose !== "repo-chat") return { kind: "none" };
  return resolveObservedInspectionTarget(params.workingDir);
}

/**
 * Read-scope agent root for a repo-chat sandbox: the observed instance's agent
 * root when inspecting an allowed observed surface, else the current process's
 * own agent root. Throws on an observed private/state target.
 */
function resolveRepoChatAgentRoot(params: {
  workingDir: string;
  purpose: CodexSandboxPurpose;
}): string {
  const observed = observedInspectionTarget(params);
  if (observed.kind === "sealed") {
    throw new Error("Backend execution cannot run from SmithersBot private paths.");
  }
  return observed.kind === "agent" ? observed.agentRoot : resolveAgentRoot();
}

/**
 * Extra deny roots that seal an observed instance's private state (its private
 * root and state dir) against a broad filesystem read grant. Empty unless the
 * working dir targets an explicitly opted-in observed instance.
 */
function observedSealedDenyRoots(params: {
  workingDir: string;
  purpose: CodexSandboxPurpose;
}): string[] {
  const observed = observedInspectionTarget(params);
  if (observed.kind !== "agent") return [];
  return expandedObservedSealedDenyRoots(observed.instance);
}

function expandedObservedSealedDenyRoots(instance: GatewayInstanceName): string[] {
  const sealed = resolveObservedSealedRoots(instance, { observedInstances: [instance] });
  return uniqueValues([
    sealed.privateRoot,
    ...PRIVATE_RUNTIME_SUBDIRS.map((name) => path.join(sealed.privateRoot, name)),
    sealed.stateDir,
  ]);
}

function expandConfiguredPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("~")) {
    return path.resolve(trimmed.replace(/^~(?=$|[\\/])/, os.homedir()));
  }
  return path.resolve(trimmed);
}

function observedReadOnlyTarget(root: string): ObservedInspectionTarget {
  for (const instance of OBSERVABLE_GATEWAY_INSTANCES) {
    const target = resolveObservedInspectionTarget(root, { observedInstances: [instance] });
    if (target.kind !== "none") return target;
  }
  return { kind: "none" };
}

function resolveConfiguredReadOnlyRoots(readOnlyRoots: readonly string[] = []): {
  allowedReadRoots: string[];
  sealedDenyRoots: string[];
} {
  const allowedReadRoots: string[] = [];
  const sealedDenyRoots: string[] = [];

  for (const rawRoot of readOnlyRoots) {
    if (!rawRoot.trim()) continue;
    const root = expandConfiguredPath(rawRoot);
    const observed = observedReadOnlyTarget(root);

    if (observed.kind === "agent") {
      allowedReadRoots.push(root);
      sealedDenyRoots.push(...expandedObservedSealedDenyRoots(observed.instance));
      continue;
    }
    if (observed.kind === "sealed") {
      sealedDenyRoots.push(...expandedObservedSealedDenyRoots(observed.instance));
      continue;
    }

    if (isPathInsidePrivateRoot(root)) {
      sealedDenyRoots.push(resolvePrivateRoot());
      continue;
    }

    allowedReadRoots.push(root);
  }

  return {
    allowedReadRoots: uniqueValues(allowedReadRoots),
    sealedDenyRoots: uniqueValues(sealedDenyRoots),
  };
}

export function resolveManagedExecutionRoot(params: {
  workingDir: string;
  purpose: CodexSandboxPurpose;
}): string {
  const observed = observedInspectionTarget(params);
  if (observed.kind === "sealed") {
    throw new Error("Backend execution cannot run from SmithersBot private paths.");
  }
  if (observed.kind === "agent") {
    return observed.agentRoot;
  }

  if (isPathInsidePrivateRoot(params.workingDir)) {
    throw new Error("Backend execution cannot run from SmithersBot private paths.");
  }

  if (params.purpose === "repo-chat" && isPathInsideAgentRoot(params.workingDir)) {
    return resolveAgentRoot();
  }

  return params.workingDir;
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function tomlQuotedKey(value: string): string {
  return `"${escapeTomlString(value)}"`;
}

export function buildCodexSandboxConfig(params: {
  workingDir: string;
  runId?: string;
  taskId?: string;
  purpose: CodexSandboxPurpose;
  requiresNetwork?: boolean;
  requiresDevGatewayControl?: boolean;
}): CodexSandboxConfig {
  const executionRoot = resolveManagedExecutionRoot({
    workingDir: params.workingDir,
    purpose: params.purpose,
  });

  if (params.purpose === "repo-chat") {
    return {
      mode: "read-only",
      executionRoot,
      configOverrides: [
        `net.allowed=${params.requiresNetwork === true ? "true" : "false"}`,
        "features.image_generation=false",
      ],
    };
  }

  const gitWritablePath = path.join(params.workingDir, ".git");
  const devGatewayWritablePaths = devGatewayControlWritablePaths(params);
  return {
    mode: "workspace-write",
    executionRoot,
    configOverrides: [
      `net.allowed=${params.requiresNetwork === true ? "true" : "false"}`,
      "features.image_generation=false",
      `sandbox_workspace_write.writable_roots=[${uniqueValues([
        gitWritablePath,
        ...devGatewayWritablePaths,
      ])
        .map((writablePath) => `"${escapeTomlString(writablePath)}"`)
        .join(",")}]`,
    ],
  };
}

export function appendCodexSandboxArgs(args: string[], config: CodexSandboxConfig): string[] {
  args.push("--sandbox", config.mode, "--cd", config.executionRoot);
  for (const override of config.configOverrides) {
    args.push("-c", override);
  }
  return args;
}

export function appendCodexNativeSandboxExecArgs(
  args: string[],
  config: CodexNativeSandboxConfig,
): string[] {
  if (!args.includes("--skip-git-repo-check")) {
    args.push("--skip-git-repo-check");
  }
  args.push("--cd", config.executionRoot);
  return args;
}

export function mergeCodexNativeSandboxEnv(
  baseEnv: Record<string, string | undefined>,
  config: CodexNativeSandboxConfig,
): Record<string, string | undefined> {
  return {
    ...baseEnv,
    CODEX_HOME: config.env.CODEX_HOME,
    PATH: `${config.helperDir}${path.delimiter}${baseEnv.PATH ?? process.env.PATH ?? ""}`,
  };
}

/**
 * Resolve the real Codex auth.json the unsandboxed control plane authenticates
 * with. Honors an explicit CODEX_HOME override and otherwise falls back to
 * ~/.codex/auth.json. Never reads or copies the file — only its path is used.
 */
function resolveRealCodexAuthSource(): string {
  const realCodexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  return path.join(realCodexHome, "auth.json");
}

function buildCodexDeniedReadPaths(
  workingDir: string,
  authSourcePath: string,
  extraDeniedRoots: string[] = [],
): string[] {
  return uniqueValues([
    ...extraDeniedRoots,
    path.join(workingDir, ".env"),
    path.join(workingDir, ".env.local"),
    path.join(workingDir, ".env.production"),
    path.join(workingDir, ".env.test"),
    path.join(resolvePrivateRoot(), "env", path.basename(path.dirname(workingDir)), ".env"),
    path.join(os.homedir(), ".smithersbot", ".env"),
    path.join(os.homedir(), ".smithersbot", "smithersbot.json"),
    path.join(os.homedir(), ".moltbot", "moltbot.json"),
    path.join(os.homedir(), ".clawdbot", "clawdbot.json"),
    path.join(os.homedir(), ".clawdbot-dev", "moltbot.json"),
    path.join(os.homedir(), ".codex", "auth.json"),
    // Deny the resolved real auth source too. When CODEX_HOME is unset this is the
    // same path as ~/.codex/auth.json above (deduped); when overridden it ensures
    // the generated auth symlink still resolves to a denied target for the
    // sandboxed shell while the unsandboxed control plane reads it directly.
    authSourcePath,
    path.join(os.homedir(), ".codex", "config.toml"),
    path.join(os.homedir(), ".claude", "settings.json"),
    path.join(os.homedir(), ".ssh", "id_rsa"),
    path.join(os.homedir(), ".aws", "credentials"),
    path.join(os.homedir(), ".gnupg", "pubring.kbx"),
  ]);
}

function devGatewayControlWritablePaths(params: {
  runId?: string;
  taskId?: string;
  requiresDevGatewayControl?: boolean;
}): string[] {
  if (params.requiresDevGatewayControl !== true) return [];
  if (!params.runId || !params.taskId) {
    throw new Error("requiresDevGatewayControl sandbox grants require runId and taskId.");
  }
  return [resolveScratchDir(params.runId, params.taskId)];
}

function buildCodexPermissionProfileToml(params: {
  executionRoot: string;
  allowedReadPaths: string[];
  deniedReadPaths: string[];
  writablePaths: string[];
  requiresNetwork?: boolean;
}): string {
  const writablePathSet = new Set(params.writablePaths);
  const filesystemLines = [
    "[permissions.smithersbot.filesystem]",
    "glob_scan_max_depth = 8",
    // Base read access to the whole filesystem so the codex-linux-sandbox helper,
    // system binaries (sh), and shared libraries remain executable inside the
    // bubblewrap sandbox. Without this, a permissions profile that only grants the
    // workspace makes /bin/sh and the helper unreadable and bwrap fails with
    // "execvp codex-linux-sandbox: No such file or directory". Specific write and
    // deny rules below override this broad read grant by path specificity.
    '"/" = "read"',
    `${tomlQuotedKey(params.executionRoot)} = "${
      params.writablePaths.includes(params.executionRoot) ? "write" : "read"
    }"`,
    ...params.allowedReadPaths
      .filter((readPath) => readPath !== params.executionRoot && !writablePathSet.has(readPath))
      .map((readPath) => `${tomlQuotedKey(readPath)} = "read"`),
    ...params.writablePaths
      .filter((writablePath) => writablePath !== params.executionRoot)
      .map((writablePath) => `${tomlQuotedKey(writablePath)} = "write"`),
    ...params.deniedReadPaths.map((deniedPath) => `${tomlQuotedKey(deniedPath)} = "deny"`),
  ];

  return [
    'default_permissions = "smithersbot"',
    "",
    ...filesystemLines,
    "",
    "[permissions.smithersbot.network]",
    `enabled = ${params.requiresNetwork === true ? "true" : "false"}`,
    "",
    "[features]",
    "image_generation = false",
    "",
  ].join("\n");
}

function discoverCodexNativeBinary(codexPath: string): string | undefined {
  const candidate = path.resolve(
    path.dirname(codexPath),
    "..",
    "lib",
    "node_modules",
    "@openai",
    "codex",
    "node_modules",
    "@openai",
    "codex-linux-x64",
    "vendor",
    "x86_64-unknown-linux-musl",
    "bin",
    "codex",
  );
  if (fs.existsSync(candidate)) return candidate;

  const packageRoot = path.resolve(
    path.dirname(codexPath),
    "..",
    "lib",
    "node_modules",
    "@openai",
    "codex",
  );
  try {
    const result = execFileSync("find", [packageRoot, "-path", "*/bin/codex", "-type", "f"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.includes("codex-linux"));
    return result || undefined;
  } catch {
    return undefined;
  }
}

export function buildCodexNativeSandboxConfig(params: {
  workingDir: string;
  runId: string;
  taskId?: string;
  purpose: CodexSandboxPurpose;
  requiresNetwork?: boolean;
  requiresDevGatewayControl?: boolean;
  readOnlyRoots?: string[];
  extraWritablePaths?: string[];
  sandboxRoot?: string;
  codexPath?: string;
}): CodexNativeSandboxConfig {
  const executionRoot = resolveManagedExecutionRoot({
    workingDir: params.workingDir,
    purpose: params.purpose,
  });
  const codexPath = params.codexPath ?? commandPath("codex");
  if (!codexPath) {
    throw new Error("codex CLI is not available on PATH.");
  }

  const sandboxRoot = params.sandboxRoot ?? DEFAULT_CODEX_SANDBOX_ROOT;
  const codexHome = path.join(sandboxRoot, `smithersbot-codex-${safeRunIdSegment(params.runId)}`);
  const helperDir = path.join(codexHome, "bin");
  const helperPath = path.join(helperDir, "codex-linux-sandbox");
  const authSourcePath = resolveRealCodexAuthSource();
  const authReferencePath = path.join(codexHome, "auth.json");
  const repoChatAgentRoot = resolveRepoChatAgentRoot(params);
  const configuredReadOnlyRoots = resolveConfiguredReadOnlyRoots(params.readOnlyRoots);
  const devGatewayWritablePaths = devGatewayControlWritablePaths(params);
  const allowedReadPaths =
    params.purpose === "repo-chat"
      ? uniqueValues([
          repoChatAgentRoot,
          params.workingDir,
          ...configuredReadOnlyRoots.allowedReadRoots,
        ])
      : uniqueValues([
          params.workingDir,
          path.join(resolveAgentRoot(), "history"),
          ...configuredReadOnlyRoots.allowedReadRoots,
        ]);
  const writablePaths =
    params.purpose === "repo-chat"
      ? uniqueValues([...(params.extraWritablePaths ?? []), ...devGatewayWritablePaths])
      : uniqueValues([
          params.workingDir,
          path.join(params.workingDir, ".git"),
          ...(params.extraWritablePaths ?? []),
          ...devGatewayWritablePaths,
        ]);
  // Codex grants a broad `/`=read base, so an observed instance's private root
  // and state dir must be explicitly denied to seal dev private state.
  const deniedReadPaths = buildCodexDeniedReadPaths(
    params.workingDir,
    authSourcePath,
    uniqueValues([...observedSealedDenyRoots(params), ...configuredReadOnlyRoots.sealedDenyRoots]),
  );
  const configToml = buildCodexPermissionProfileToml({
    executionRoot,
    allowedReadPaths,
    deniedReadPaths,
    writablePaths,
    requiresNetwork: params.requiresNetwork,
  });

  return {
    profileName: "smithersbot",
    executionRoot,
    codexHome,
    configPath: path.join(codexHome, "config.toml"),
    helperDir,
    helperPath,
    codexPath,
    authReferencePath,
    authSourcePath,
    env: {
      CODEX_HOME: codexHome,
      PATH: `${helperDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    args: ["sandbox", "linux", "--permissions-profile", "smithersbot", "--cd", executionRoot],
    configToml,
    deniedReadPaths,
    allowedReadPaths,
    writablePaths,
  };
}

export function writeCodexNativeSandboxConfig(params: {
  workingDir: string;
  runId: string;
  taskId?: string;
  purpose: CodexSandboxPurpose;
  requiresNetwork?: boolean;
  requiresDevGatewayControl?: boolean;
  readOnlyRoots?: string[];
  extraWritablePaths?: string[];
  sandboxRoot?: string;
  codexPath?: string;
}): CodexNativeSandboxConfig {
  const config = buildCodexNativeSandboxConfig(params);
  if (isPathInsideAgentRoot(config.codexHome) || config.codexHome.startsWith(params.workingDir)) {
    throw new Error("Codex native sandbox config must be outside agent-visible paths.");
  }

  const nativeCodexPath = discoverCodexNativeBinary(config.codexPath);
  if (!nativeCodexPath) {
    throw new Error("Unable to locate the Codex native binary for codex-linux-sandbox helper.");
  }

  fs.mkdirSync(config.helperDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(config.configPath, config.configToml, { encoding: "utf8", mode: 0o600 });
  try {
    fs.rmSync(config.helperPath, { force: true });
    fs.symlinkSync(nativeCodexPath, config.helperPath);
  } catch {
    fs.copyFileSync(nativeCodexPath, config.helperPath);
    fs.chmodSync(config.helperPath, 0o700);
  }
  linkCodexAuthReference(config);
  return config;
}

/**
 * Restore Codex auth continuity for the generated CODEX_HOME by symlinking
 * <codexHome>/auth.json to the real ~/.codex/auth.json (never a copy, so no auth
 * contents are duplicated or persisted). The symlink lets the unsandboxed Codex
 * control plane read $CODEX_HOME/auth.json and authenticate; the sandboxed shell
 * stays blocked because the link resolves to the already-denied real auth path
 * (the same symlink-target deny the symlink_escape probe proves). Best-effort:
 * if the source is missing or the link can't be created, control-plane auth
 * still resolves via the real CODEX_HOME when present. We never chmod the link
 * (a Linux chmod follows it and would mutate the real auth file's perms); the
 * generated CODEX_HOME directory is created mode 0o700 so the link is owner-only.
 */
function linkCodexAuthReference(config: CodexNativeSandboxConfig): void {
  try {
    if (config.authSourcePath === config.authReferencePath) return;
    if (!fs.existsSync(config.authSourcePath)) return;
    fs.rmSync(config.authReferencePath, { force: true });
    fs.symlinkSync(config.authSourcePath, config.authReferencePath);
  } catch {
    // Best-effort auth continuity; do not fail sandbox setup on link errors.
  }
}

function safeRunIdSegment(runId: string): string {
  const safe = runId.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[.-]+/, "");
  return (safe || "run").slice(0, 80);
}

function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.length > 0)));
}

export function resolveClaudeCodeSandboxSettingsRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SMITHERSBOT_CLAUDE_SANDBOX_SETTINGS_ROOT) {
    return env.SMITHERSBOT_CLAUDE_SANDBOX_SETTINGS_ROOT;
  }
  if (env.CODEX_HOME) {
    const codexMemoryRoot = path.join(env.CODEX_HOME, "memories");
    if (fs.existsSync(codexMemoryRoot)) return codexMemoryRoot;
  }
  return DEFAULT_CLAUDE_SANDBOX_SETTINGS_ROOT;
}

export type ClaudeDenyReadDeps = {
  homedir?: () => string;
  privateRoot?: () => string;
  pathExists?: (candidate: string) => boolean;
  realPath?: (candidate: string) => string;
  /** List a directory's entry names. Metadata-only (no contents); defaults to fs.readdirSync. */
  readDir?: (dir: string) => string[];
  /** True when the path is a regular file (follows symlinks); defaults to fs.statSync().isFile(). */
  isRegularFile?: (candidate: string) => boolean;
  /** True when the path is a directory (follows symlinks); defaults to fs.statSync().isDirectory(). */
  isDirectory?: (candidate: string) => boolean;
};

type ResolvedClaudeDenyDeps = {
  homedir: () => string;
  privateRoot: () => string;
  pathExists: (candidate: string) => boolean;
  realPath: (candidate: string) => string;
  readDir: (dir: string) => string[];
  isRegularFile: (candidate: string) => boolean;
  isDirectory: (candidate: string) => boolean;
};

/**
 * Build the native-sandbox `filesystem.denyRead` entries for sandboxed Bash.
 *
 * Claude Code 2.1.x enforces `filesystem.denyRead` for sandboxed Bash via per-entry
 * bubblewrap mounts. Live differential probing established two key facts:
 *   - EXACT regular-file entries are mounted reliably and DO block Bash child reads
 *     (the repo `.env*` denies worked).
 *   - DIRECTORY/prefix entries (and `permissions.deny Read(.../**)` rules) do NOT
 *     reliably block Bash child content reads recursively — a live smoke test could
 *     still `cat ~/.codex/auth.json`, a `~/.ssh` file, and a regular file under
 *     `~/.claude` from sandboxed Bash with rc=0.
 *
 * So the reliable mechanism is to deny each sensitive file as its own EXACT existing
 * regular-file entry (see {@link buildClaudeSensitiveFileDenies}), discovered
 * metadata-only and bounded. Three bwrap constraints still hold:
 *   1. A recursive/large glob (e.g. `<repo>/**` + `/.env`) is expanded by walking
 *      the matching tree; over `node_modules` that walk hangs sandbox startup. So we
 *      never emit `**` globs and the discovery is depth- and budget-bounded.
 *   2. bwrap cannot mount over a path that is absent from the sandbox rootfs or is a
 *      symlink — it fails with "Can't mount tmpfs on /newroot/...: No such file or
 *      directory". So we filter to existing paths, resolve symlinks to their real
 *      targets, and keep only regular files for the exact-file entries.
 *   3. Startup cost scales with denied DIRECTORY tree size; stacking several large
 *      trees hangs startup. Individual file mounts are cheap (one mount target, no
 *      tree walk), so the exact-file set does not reintroduce that cost.
 *
 * The directory denies (`~/.claude`, managed private root) and the broad
 * `permissions.deny Read(.../**)` rules are kept as defense-in-depth — they are no
 * longer the only coverage for sensitive child files.
 */
function resolveClaudeDenyDeps(deps: ClaudeDenyReadDeps): ResolvedClaudeDenyDeps {
  return {
    homedir: deps.homedir ?? os.homedir,
    privateRoot: deps.privateRoot ?? (() => resolvePrivateRoot()),
    pathExists: deps.pathExists ?? ((candidate) => fs.existsSync(candidate)),
    realPath:
      deps.realPath ??
      ((candidate) => {
        try {
          return fs.realpathSync(candidate);
        } catch {
          return candidate;
        }
      }),
    readDir:
      deps.readDir ??
      ((dir) => {
        try {
          return fs.readdirSync(dir);
        } catch {
          return [];
        }
      }),
    isRegularFile:
      deps.isRegularFile ??
      ((candidate) => {
        try {
          return fs.statSync(candidate).isFile();
        } catch {
          return false;
        }
      }),
    isDirectory:
      deps.isDirectory ??
      ((candidate) => {
        try {
          return fs.statSync(candidate).isDirectory();
        } catch {
          return false;
        }
      }),
  };
}

/**
 * Keep only candidates that exist and rewrite symlinks to their real targets, so every
 * emitted path is a real, mountable bubblewrap target (bwrap fails to mount over an
 * absent path or a symlink — the "Can't mount tmpfs on /newroot/..." family). uniqueValues
 * dedupes collisions (e.g. a `~/.clawdbot -> ~/.moltbot` symlink collapses onto `~/.moltbot`).
 */
function resolveExistingRealPaths(
  candidates: string[],
  deps: { pathExists: (candidate: string) => boolean; realPath: (candidate: string) => string },
): string[] {
  return uniqueValues(candidates.filter((c) => deps.pathExists(c)).map((c) => deps.realPath(c)));
}

/**
 * Like {@link resolveExistingRealPaths} but additionally requires the resolved real
 * target to be a regular file. Symlinks are resolved to their real target first (so
 * we deny the target, never the link — bwrap cannot mount over a symlink), then
 * non-regular targets (directories, sockets, fifos, broken links) are dropped so
 * every emitted exact-file deny is a real, mountable bwrap FILE target.
 */
function resolveExistingRealFiles(
  candidates: string[],
  deps: {
    pathExists: (candidate: string) => boolean;
    realPath: (candidate: string) => string;
    isRegularFile: (candidate: string) => boolean;
  },
): string[] {
  return uniqueValues(
    candidates
      .filter((c) => deps.pathExists(c))
      .map((c) => deps.realPath(c))
      .filter((real) => deps.isRegularFile(real)),
  );
}

/** Default bounds for {@link discoverSensitiveFilesInDir}; see its doc for rationale. */
const SENSITIVE_SCAN_MAX_DEPTH = 2;
const SENSITIVE_SCAN_BUDGET = 1000;

type SensitiveScanDeps = {
  pathExists: (candidate: string) => boolean;
  readDir: (dir: string) => string[];
  isRegularFile: (candidate: string) => boolean;
  isDirectory: (candidate: string) => boolean;
};

const CLAUDE_SUBSCRIPTION_CREDENTIAL_BASENAME = ".credentials.json";

/**
 * Shallow, bounded scan of a single directory for sensitive regular files. Reads
 * directory listings and stat metadata only — never file contents. Bounded by depth
 * (small per category — e.g. 1 for `~/.codex`, 2 for `~/.gnupg/private-keys-v1.d`)
 * and a shared global entry budget so it can never walk an unrelated large tree such
 * as `node_modules`. Returns absolute paths of regular files whose basename matches
 * `namePredicate`. Subdirectories at the depth limit are detected but NOT descended
 * into (no readDir call), keeping traversal off large nested trees.
 */
function discoverSensitiveFilesInDir(
  dir: string,
  options: {
    namePredicate: (name: string) => boolean;
    maxDepth?: number;
    budget?: { remaining: number };
  },
  deps: SensitiveScanDeps,
): string[] {
  const maxDepth = options.maxDepth ?? SENSITIVE_SCAN_MAX_DEPTH;
  const budget = options.budget ?? { remaining: SENSITIVE_SCAN_BUDGET };
  const found: string[] = [];
  const walk = (current: string, depth: number): void => {
    if (depth > maxDepth || budget.remaining <= 0) return;
    if (!deps.pathExists(current) || !deps.isDirectory(current)) return;
    for (const name of deps.readDir(current)) {
      if (budget.remaining <= 0) break;
      budget.remaining -= 1;
      const child = path.join(current, name);
      if (deps.isDirectory(child)) {
        walk(child, depth + 1);
      } else if (options.namePredicate(name) && deps.isRegularFile(child)) {
        found.push(child);
      }
    }
  };
  walk(dir, 1);
  return found;
}

/** Top-level repo env files to deny: `.env` and `.env.*`, but keep templates readable. */
function isRepoEnvFileName(name: string): boolean {
  if (name === ".env") return true;
  if (!name.startsWith(".env.")) return false;
  return name !== ".env.example" && name !== ".env.sample";
}

/** Known sensitive credential/config/session basenames found inside credential dirs. */
const SENSITIVE_FILE_BASENAMES = new Set<string>([
  CLAUDE_SUBSCRIPTION_CREDENTIAL_BASENAME,
  "credentials",
  "credentials.json",
  "auth.json",
  "config.json",
  "config.toml",
  "settings.json",
  "settings.local.json",
  "config",
  "known_hosts",
  "authorized_keys",
  "trustdb.gpg",
  ".env",
  "smithersbot.json",
  "moltbot.json",
  "clawdbot.json",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
]);

/** Sensitive file extensions: keys/certs, GPG keyrings, and service-account/oauth/token JSON. */
const SENSITIVE_FILE_EXTENSIONS = new Set<string>([
  ".pem",
  ".key",
  ".crt",
  ".cer",
  ".p12",
  ".pfx",
  ".kbx",
  ".gpg",
  ".json",
  ".toml",
]);

/** Match a credential/secret filename inside a known credential directory. */
function isSensitiveCredentialFileName(name: string): boolean {
  if (SENSITIVE_FILE_BASENAMES.has(name)) return true;
  // SSH private keys (`id_rsa`, `id_ed25519`, ...) but never the `.pub` public half.
  if (name.startsWith("id_") && !name.endsWith(".pub")) return true;
  const ext = path.extname(name);
  if (ext === ".pub") return false; // public keys are not secret
  return SENSITIVE_FILE_EXTENSIONS.has(ext);
}

/**
 * Discover the exact, existing, sensitive REGULAR FILES that sandboxed Bash must not
 * read, as absolute real (symlink-resolved) paths. This is the reliable Bash-deny
 * mechanism: Claude Code mounts each exact-file `denyRead` entry individually,
 * whereas directory/prefix denies do not reliably block Bash child reads.
 *
 * Discovery is metadata-only (directory listings + stat) and bounded: each credential
 * directory is scanned at a small depth and all scans share one global entry budget,
 * so node_modules / large unrelated trees are never walked. The "common credential
 * file" patterns (service-account/oauth/token JSON, `*.pem`/`*.key`/`*.crt`) are
 * applied ONLY inside these bounded credential dirs and as fixed home files — never a
 * repo-wide scan — to avoid the node_modules walk and avoid denying repo fixtures.
 */
function buildClaudeSensitiveFileDenies(
  workingDir: string,
  deps: ResolvedClaudeDenyDeps,
  extraScanDirs: string[] = [],
  options: { exposeClaudeSubscriptionCredentialsForDrivenSession?: boolean } = {},
): string[] {
  const { homedir, privateRoot, pathExists, realPath, readDir, isRegularFile, isDirectory } = deps;
  const home = homedir();
  const claudeSubscriptionCredentialPath = path.join(
    home,
    ".claude",
    CLAUDE_SUBSCRIPTION_CREDENTIAL_BASENAME,
  );
  const budget = { remaining: SENSITIVE_SCAN_BUDGET };
  const scanDeps: SensitiveScanDeps = { pathExists, readDir, isRegularFile, isDirectory };

  const workspaceName = path.basename(path.dirname(workingDir));
  const privateWorkspaceDir = path.join(privateRoot(), "env", workspaceName);

  // Explicit exact-path candidates: the managed private env and fixed home credential
  // files (no scan needed — they have well-known names).
  const candidates: string[] = [
    path.join(privateWorkspaceDir, ".env"),
    ...[".netrc", ".npmrc", ".pypirc", ".git-credentials"].map((name) => path.join(home, name)),
  ];

  // Bounded scans: repo top level (env files only, never recursed), the managed
  // private workspace dir, and the small home credential dirs.
  const scans: Array<{ dir: string; maxDepth: number; namePredicate: (name: string) => boolean }> =
    [
      { dir: workingDir, maxDepth: 1, namePredicate: isRepoEnvFileName },
      { dir: privateWorkspaceDir, maxDepth: 1, namePredicate: isSensitiveCredentialFileName },
      {
        dir: path.join(home, ".claude"),
        maxDepth: 1,
        namePredicate: isSensitiveCredentialFileName,
      },
      { dir: path.join(home, ".codex"), maxDepth: 1, namePredicate: isSensitiveCredentialFileName },
      { dir: path.join(home, ".ssh"), maxDepth: 1, namePredicate: isSensitiveCredentialFileName },
      { dir: path.join(home, ".aws"), maxDepth: 1, namePredicate: isSensitiveCredentialFileName },
      { dir: path.join(home, ".gnupg"), maxDepth: 2, namePredicate: isSensitiveCredentialFileName },
      ...[".smithersbot", ".moltbot", ".clawdbot", ".clawdbot-dev"].map((name) => ({
        dir: path.join(home, name),
        maxDepth: 1,
        namePredicate: isSensitiveCredentialFileName,
      })),
      // Observed-instance sealed roots (e.g. dev private + ~/.smithersbot-dev):
      // scan a few levels deep so dev .env / auth / config / session files become
      // exact-file denies, the reliable Bash-deny mechanism.
      ...extraScanDirs.map((dir) => ({
        dir,
        maxDepth: 3,
        namePredicate: isSensitiveCredentialFileName,
      })),
    ];

  for (const scan of scans) {
    candidates.push(
      ...discoverSensitiveFilesInDir(
        scan.dir,
        { namePredicate: scan.namePredicate, maxDepth: scan.maxDepth, budget },
        scanDeps,
      ),
    );
  }

  const effectiveCandidates =
    options.exposeClaudeSubscriptionCredentialsForDrivenSession === true
      ? candidates.filter((candidate) => candidate !== claudeSubscriptionCredentialPath)
      : candidates;

  return resolveExistingRealFiles(effectiveCandidates, { pathExists, realPath, isRegularFile });
}

function buildClaudeDenyReadPaths(
  workingDir: string,
  deps: ClaudeDenyReadDeps = {},
  extraDenyDirs: string[] = [],
  options: { exposeClaudeSubscriptionCredentialsForDrivenSession?: boolean } = {},
): string[] {
  const resolved = resolveClaudeDenyDeps(deps);
  const { homedir, privateRoot, pathExists, realPath } = resolved;
  const home = homedir();
  // Directory denies kept as defense-in-depth (proven safe for bwrap startup). On their
  // own these do NOT reliably block sandboxed Bash child reads — see buildClaudeSensitiveFileDenies.
  // extraDenyDirs seal an observed instance's private root + state dir.
  const protectedDirs = [privateRoot(), path.join(home, ".claude"), ...extraDenyDirs];
  // Literal top-level repo env files (kept explicit for back-compat with the proven matrix).
  const protectedFiles = [".env", ".env.local", ".env.production", ".env.test"].map((name) =>
    path.join(workingDir, name),
  );
  const dirAndLiteralDenies = resolveExistingRealPaths([...protectedFiles, ...protectedDirs], {
    pathExists,
    realPath,
  });
  // Exact existing sensitive regular files — the reliable Bash-deny mechanism.
  const exactFileDenies = buildClaudeSensitiveFileDenies(
    workingDir,
    resolved,
    extraDenyDirs,
    options,
  );
  return uniqueValues([...dirAndLiteralDenies, ...exactFileDenies]);
}

/**
 * Build the `permissions.deny` Read-tool rules. Claude Code enforces these denies via the
 * SAME bubblewrap mounts as `sandbox.filesystem.denyRead`, so they are subject to the same
 * constraint: every referenced path must exist and be a real (non-symlink) target, or
 * bwrap fails to start the sandbox. We therefore filter the home credential dirs to
 * existing real paths (dropping absent `~/.aws`, resolving the `~/.clawdbot -> ~/.moltbot`
 * symlink) and deny repo env files by absolute literal path (workspace-relative or
 * recursive double-star Read forms make Claude scan node_modules at startup and hang).
 */
function buildClaudeReadToolDenies(
  workingDir: string,
  deps: ClaudeDenyReadDeps = {},
  extraDenyDirs: string[] = [],
): string[] {
  const { homedir, pathExists, realPath } = resolveClaudeDenyDeps(deps);
  const home = homedir();
  const repoEnvFiles = [".env", ".env.local", ".env.production", ".env.test"].map((name) =>
    path.join(workingDir, name),
  );
  const homeCredentialDirs = [
    ".smithersbot",
    ".moltbot",
    ".clawdbot",
    ".clawdbot-dev",
    ".codex",
    ".claude",
    ".ssh",
    ".aws",
    ".gnupg",
  ].map((name) => path.join(home, name));
  const repoEnvDenies = resolveExistingRealPaths(repoEnvFiles, { pathExists, realPath }).map(
    (p) => `Read(${p})`,
  );
  const homeDenies = resolveExistingRealPaths([...homeCredentialDirs, ...extraDenyDirs], {
    pathExists,
    realPath,
  }).map((d) => `Read(${d}/**)`);
  return [...repoEnvDenies, ...homeDenies];
}

/**
 * Whether the Claude Code sandbox is eligible to attempt broad network for a
 * single sandboxed invocation (the equivalent of Codex's
 * `[permissions.smithersbot.network] enabled = true`).
 *
 * Policy: a planned step's `requiresNetwork=true` is sufficient to attempt
 * Claude network activation — there is no hidden operator env-var opt-in. The
 * grant is written into that one invocation's generated sandbox settings via
 * `sandbox.network.allowedDomains` (broad per-suffix wildcards — see
 * CLAUDE_SANDBOX_BROAD_NETWORK_DOMAINS) and is never applied to steps that did
 * not request it. Network remains off by default for normal steps.
 *
 * This reports eligibility only; it does not prove the installed Claude build
 * honors the network setting at runtime. A genuine runtime/sandbox failure to
 * enable network must still surface as capability_blocked/sandbox_blocked via
 * the live-probe/blocker plumbing in backend selection (agent-executor-helpers.ts),
 * which classifies the real Claude sandbox error rather than an env-var hint.
 *
 * The `env` parameter is retained for signature stability but no longer gates
 * the result: we do not read SMITHERSBOT_CLAUDE_SANDBOX_NETWORK.
 */
export function claudeCodeSandboxNetworkCapability(_env: NodeJS.ProcessEnv = process.env): {
  supported: boolean;
  reason: string;
} {
  return {
    supported: true,
    reason:
      "Claude Code sandbox network is activated per step: a planned requiresNetwork=true " +
      "step requests network for that single invocation (off by default otherwise).",
  };
}

export function buildClaudeCodeSandboxSettingsConfig(params: {
  workingDir: string;
  runId: string;
  taskId?: string;
  purpose: ClaudeSandboxPurpose;
  readOnlyRoots?: string[];
  extraWritablePaths?: string[];
  settingsRoot?: string;
  denyReadDeps?: ClaudeDenyReadDeps;
  requiresNetwork?: boolean;
  requiresDevGatewayControl?: boolean;
  exposeClaudeSubscriptionCredentialsForDrivenSession?: boolean;
}): ClaudeCodeSandboxSettingsConfig {
  if (isPathInsidePrivateRoot(params.workingDir)) {
    throw new Error("Claude Code sandbox cannot run from SmithersBot private paths.");
  }
  // Read-scope to an observed instance's agent root when inspecting it (throws on
  // an observed private/state target); seal that instance's private/state dirs.
  const agentRoot = resolveRepoChatAgentRoot(params);
  const configuredReadOnlyRoots = resolveConfiguredReadOnlyRoots(params.readOnlyRoots);
  const extraDenyDirs = uniqueValues([
    ...observedSealedDenyRoots(params),
    ...configuredReadOnlyRoots.sealedDenyRoots,
  ]);

  const settingsRoot = params.settingsRoot ?? DEFAULT_CLAUDE_SANDBOX_SETTINGS_ROOT;
  const settingsDir = path.join(
    settingsRoot,
    `smithersbot-claude-${safeRunIdSegment(params.runId)}`,
  );
  const devGatewayWritablePaths = devGatewayControlWritablePaths(params);
  const allowRead =
    params.purpose === "repo-chat"
      ? uniqueValues([agentRoot, params.workingDir, ...configuredReadOnlyRoots.allowedReadRoots])
      : uniqueValues([
          params.workingDir,
          path.join(agentRoot, "history"),
          ...configuredReadOnlyRoots.allowedReadRoots,
        ]);
  const allowWrite =
    params.purpose === "repo-chat"
      ? uniqueValues([...(params.extraWritablePaths ?? []), ...devGatewayWritablePaths])
      : uniqueValues([
          params.workingDir,
          ...(params.extraWritablePaths ?? []),
          ...devGatewayWritablePaths,
        ]);

  // requiresNetwork=true must never be silently ignored: either write a real
  // network grant (when the build supports it) or throw a clear capability error
  // so the caller routes the step to a network-capable backend (or blocks).
  let networkGrant: { allowedDomains: string[] } | undefined;
  if (params.requiresNetwork === true) {
    const capability = claudeCodeSandboxNetworkCapability();
    if (!capability.supported) {
      throw new Error(`Claude Code cannot satisfy requiresNetwork=true: ${capability.reason}`);
    }
    // Grant broad per-suffix wildcards; Claude's proxy is default-deny and has no
    // universal allow-all token, so an explicit allowlist is the only way to open
    // egress for the step. See CLAUDE_SANDBOX_BROAD_NETWORK_DOMAINS.
    networkGrant = { allowedDomains: [...CLAUDE_SANDBOX_BROAD_NETWORK_DOMAINS] };
  }

  return {
    settingsDir,
    settingsPath: path.join(settingsDir, "settings.json"),
    settings: {
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: false,
        filesystem: {
          allowRead,
          allowWrite,
          denyRead: buildClaudeDenyReadPaths(
            params.workingDir,
            params.denyReadDeps,
            extraDenyDirs,
            {
              // Item #6: a tui-pilot driven Claude Code session may need the
              // subscription OAuth store while API-key env remains scrubbed. This
              // opt-in removes only ~/.claude/.credentials.json from exact-file
              // denies; the ~/.claude directory deny and every other sensitive
              // file deny remain. Live apiKeySource!=none validation is an
              // operator Observation Point, not a unit-test requirement.
              exposeClaudeSubscriptionCredentialsForDrivenSession:
                params.exposeClaudeSubscriptionCredentialsForDrivenSession,
            },
          ),
        },
        ...(networkGrant ? { network: networkGrant } : {}),
      },
      permissions: {
        // Read-tool denies, filtered to existing real paths because Claude Code enforces
        // them via the same bubblewrap mounts as the sandbox filesystem denies (an absent
        // ~/.aws or a symlinked ~/.clawdbot would fail bwrap startup). See builder doc.
        deny: buildClaudeReadToolDenies(params.workingDir, params.denyReadDeps, extraDenyDirs),
      },
    },
  };
}

export function writeClaudeCodeSandboxSettings(params: {
  workingDir: string;
  runId: string;
  taskId?: string;
  purpose: ClaudeSandboxPurpose;
  readOnlyRoots?: string[];
  extraWritablePaths?: string[];
  settingsRoot?: string;
  denyReadDeps?: ClaudeDenyReadDeps;
  requiresNetwork?: boolean;
  requiresDevGatewayControl?: boolean;
  exposeClaudeSubscriptionCredentialsForDrivenSession?: boolean;
}): ClaudeCodeSandboxSettingsConfig {
  const config = buildClaudeCodeSandboxSettingsConfig(params);
  if (
    isPathInsideAgentRoot(config.settingsDir) ||
    config.settingsDir.startsWith(params.workingDir)
  ) {
    throw new Error("Claude Code sandbox settings must be outside agent-visible paths.");
  }
  fs.mkdirSync(config.settingsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(config.settingsPath, `${JSON.stringify(config.settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return config;
}

export function buildClaudeCodeSandboxLaunchConfig(params: {
  workingDir: string;
  runId: string;
  taskId?: string;
  purpose: ClaudeSandboxPurpose;
  readOnlyRoots?: string[];
  extraWritablePaths?: string[];
  settingsRoot?: string;
  requiresNetwork?: boolean;
  requiresDevGatewayControl?: boolean;
  exposeClaudeSubscriptionCredentialsForDrivenSession?: boolean;
}): ClaudeCodeLaunchSandboxConfig {
  const config = writeClaudeCodeSandboxSettings({
    ...params,
    settingsRoot: params.settingsRoot ?? resolveClaudeCodeSandboxSettingsRoot(),
  });
  return {
    settingsPath: config.settingsPath,
    args: [
      "--settings",
      config.settingsPath,
      "--setting-sources",
      "",
      "--permission-mode",
      "default",
    ],
  };
}

export function appendClaudeCodeSandboxArgs(
  args: string[],
  config: ClaudeCodeLaunchSandboxConfig,
): string[] {
  args.push(...config.args);
  return args;
}

function buildClaudeSubscriptionProbeEnv(
  sourceEnv: NodeJS.ProcessEnv,
): Record<string, string | undefined> {
  return stripClaudeSubscriptionAuthEnv(sourceEnv);
}

function buildClaudeAuthProbeSettingsConfig(params: {
  workingDir: string;
  runId: string;
  purpose: ClaudeSandboxPurpose;
  settingsRoot?: string;
  includePermissionClaudeDeny: boolean;
  includeSandboxClaudeDeny: boolean;
}): ClaudeCodeSandboxSettingsConfig {
  const config = buildClaudeCodeSandboxSettingsConfig(params);
  // The Claude deny is emitted as a resolved real path (buildClaudeDenyReadPaths /
  // buildClaudeReadToolDenies run realpath), so match that resolved form to drop it for
  // the differential probe variants that intentionally exclude the Claude auth deny.
  let claudeHomePattern = path.join(os.homedir(), ".claude");
  try {
    claudeHomePattern = fs.realpathSync(claudeHomePattern);
  } catch {
    // keep the unresolved path if it does not exist
  }
  const claudePermRule = `Read(${claudeHomePattern}/**)`;
  return {
    ...config,
    settings: {
      ...config.settings,
      sandbox: {
        ...config.settings.sandbox,
        filesystem: {
          ...config.settings.sandbox.filesystem,
          denyRead: params.includeSandboxClaudeDeny
            ? config.settings.sandbox.filesystem.denyRead
            : config.settings.sandbox.filesystem.denyRead.filter(
                (deniedPath) => deniedPath !== claudeHomePattern,
              ),
        },
      },
      permissions: {
        deny: params.includePermissionClaudeDeny
          ? config.settings.permissions.deny
          : config.settings.permissions.deny.filter((rule) => rule !== claudePermRule),
      },
    },
  };
}

function writeClaudeAuthProbeSettings(params: {
  workingDir: string;
  runId: string;
  purpose: ClaudeSandboxPurpose;
  settingsRoot?: string;
  includePermissionClaudeDeny: boolean;
  includeSandboxClaudeDeny: boolean;
}): ClaudeCodeSandboxSettingsConfig {
  const config = buildClaudeAuthProbeSettingsConfig(params);
  if (
    isPathInsideAgentRoot(config.settingsDir) ||
    config.settingsDir.startsWith(params.workingDir)
  ) {
    throw new Error("Claude Code auth probe settings must be outside agent-visible paths.");
  }
  fs.mkdirSync(config.settingsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(config.settingsPath, `${JSON.stringify(config.settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return config;
}

export function classifyClaudeSubscriptionAuthProbeFailure(params: {
  output: string;
  usedGeneratedSettings: boolean;
}): ClaudeSubscriptionAuthProbeBlocker {
  if (params.output.includes(KNOWN_CLAUDE_LIBX32_BWRAP_ERROR)) {
    return "native-sandbox-libx32-runtime-blocker";
  }
  if (/invalid api key|api key.*invalid|x-api-key/i.test(params.output)) {
    return "api-key-env-poisoning";
  }
  if (
    /not logged in|please run \/login|run \/login|login required|authentication required/i.test(
      params.output,
    )
  ) {
    return params.usedGeneratedSettings
      ? "generated-settings-hiding-claude-auth"
      : "missing-subscription-login";
  }
  return "generic-failure";
}

function summarizeClaudeSubscriptionAuthProbeResults(
  results: ClaudeSubscriptionAuthProbeResult[],
): { ok: boolean; blocker: ClaudeSubscriptionAuthProbeBlocker } {
  const failed = results.find((result) => !result.ok);
  return {
    ok: failed === undefined,
    blocker: failed?.blocker ?? "none",
  };
}

export function runClaudeSubscriptionAuthDifferentialProbes(
  params: {
    workingDir?: string;
    runId?: string;
    purpose?: ClaudeSandboxPurpose;
    settingsRoot?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): ClaudeSubscriptionAuthProbeReport {
  const env = params.env ?? process.env;
  if (env[CLAUDE_SANDBOX_LIVE_PROBES_ENV] !== "1") {
    return {
      enabled: false,
      ok: false,
      blocker: "live-probe-required",
      results: [],
    };
  }

  if (!commandPath("claude")) {
    return {
      enabled: true,
      ok: false,
      blocker: "claude-not-found",
      results: [],
    };
  }

  const workingDir = params.workingDir ?? process.cwd();
  const runId = params.runId ?? `auth-${Date.now()}`;
  const purpose = params.purpose ?? "goal-worker";
  const probeEnv = buildClaudeSubscriptionProbeEnv(env);
  const prompt = `Reply exactly: ${CLAUDE_AUTH_OK_REPLY}`;
  const settingsRoot = params.settingsRoot ?? resolveClaudeCodeSandboxSettingsRoot(env);

  const makeSettings = (
    id: ClaudeSubscriptionAuthProbeId,
    includePermissionClaudeDeny: boolean,
    includeSandboxClaudeDeny: boolean,
  ): ClaudeCodeSandboxSettingsConfig =>
    writeClaudeAuthProbeSettings({
      workingDir,
      runId: `${runId}-${id}`,
      purpose,
      settingsRoot,
      includePermissionClaudeDeny,
      includeSandboxClaudeDeny,
    });

  let cases: Array<{
    id: ClaudeSubscriptionAuthProbeId;
    args: string[];
    usedGeneratedSettings: boolean;
  }>;
  try {
    const settingsWithoutClaudeDeny = makeSettings("settings_without_claude_deny", false, false);
    const settingSourcesEmpty = makeSettings("setting_sources_empty", false, false);
    const permissionsOnly = makeSettings("permissions_deny_claude_only", true, false);
    const sandboxOnly = makeSettings("sandbox_deny_claude_only", false, true);
    const fullGenerated = writeClaudeCodeSandboxSettings({
      workingDir,
      runId: `${runId}-full-generated-settings`,
      purpose,
      settingsRoot,
    });

    cases = [
      {
        id: "plain_unset_api_key_env",
        args: ["-p", prompt],
        usedGeneratedSettings: false,
      },
      {
        id: "settings_without_claude_deny",
        args: [
          "-p",
          "--settings",
          settingsWithoutClaudeDeny.settingsPath,
          "--permission-mode",
          "default",
          "--allowedTools",
          "Bash",
          "--",
          prompt,
        ],
        usedGeneratedSettings: true,
      },
      {
        id: "setting_sources_empty",
        args: [
          "-p",
          "--settings",
          settingSourcesEmpty.settingsPath,
          "--setting-sources",
          "",
          "--permission-mode",
          "default",
          "--allowedTools",
          "Bash",
          "--",
          prompt,
        ],
        usedGeneratedSettings: true,
      },
      {
        id: "permissions_deny_claude_only",
        args: [
          "-p",
          "--settings",
          permissionsOnly.settingsPath,
          "--setting-sources",
          "",
          "--permission-mode",
          "default",
          "--allowedTools",
          "Bash",
          "--",
          prompt,
        ],
        usedGeneratedSettings: true,
      },
      {
        id: "sandbox_deny_claude_only",
        args: [
          "-p",
          "--settings",
          sandboxOnly.settingsPath,
          "--setting-sources",
          "",
          "--permission-mode",
          "default",
          "--allowedTools",
          "Bash",
          "--",
          prompt,
        ],
        usedGeneratedSettings: true,
      },
      {
        id: "full_generated_settings",
        args: [
          "-p",
          "--settings",
          fullGenerated.settingsPath,
          "--setting-sources",
          "",
          "--permission-mode",
          "default",
          "--allowedTools",
          "Bash",
          "--",
          prompt,
        ],
        usedGeneratedSettings: true,
      },
    ];
  } catch {
    return {
      enabled: true,
      ok: false,
      blocker: "settings-generation-failed",
      results: [],
    };
  }

  const results = cases.map((probeCase): ClaudeSubscriptionAuthProbeResult => {
    const result = spawnSync("claude", probeCase.args, {
      cwd: workingDir,
      env: probeEnv,
      encoding: "utf8",
      timeout: 45000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = Buffer.isBuffer(result.stdout)
      ? result.stdout.toString("utf8")
      : String(result.stdout ?? "");
    const output = formatSpawnOutput(result);
    const ok = result.status === 0 && stdout.trim() === CLAUDE_AUTH_OK_REPLY;
    return {
      id: probeCase.id,
      ok,
      blocker: ok
        ? "none"
        : classifyClaudeSubscriptionAuthProbeFailure({
            output,
            usedGeneratedSettings: probeCase.usedGeneratedSettings,
          }),
    };
  });
  const summary = summarizeClaudeSubscriptionAuthProbeResults(results);
  return {
    enabled: true,
    ok: summary.ok,
    blocker: summary.blocker,
    results,
  };
}

function commandPath(command: string): string | undefined {
  try {
    return execFileSync("sh", ["-lc", `command -v ${command}`], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function commandVersion(command: string): string {
  try {
    return execFileSync(command, ["--version"], {
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function formatSpawnOutput(result: ReturnType<typeof spawnSync>): string {
  const stdout = Buffer.isBuffer(result.stdout)
    ? result.stdout.toString("utf8")
    : String(result.stdout ?? "");
  const stderr = Buffer.isBuffer(result.stderr)
    ? result.stderr.toString("utf8")
    : String(result.stderr ?? "");
  return [stdout, stderr, result.error?.message].filter(Boolean).join("\n").trim();
}

function classifyCodexProbeFailure(output: string): CodexNativeSandboxStatus {
  if (output.includes("Read-only file system") && output.includes("/var/tmp")) {
    return {
      proven: false,
      blocker: "operator-action-required",
      reason: "Codex native sandbox config could not be written under /var/tmp.",
      details: output,
      operatorCommand:
        "mount | grep ' /var/tmp ' && touch /var/tmp/smithersbot-codex-write-test && rm /var/tmp/smithersbot-codex-write-test",
    };
  }
  if (
    output.includes("Failed to create NETLINK_ROUTE socket") ||
    output.includes("Operation not permitted")
  ) {
    return {
      proven: false,
      blocker: "operator-action-required",
      reason:
        "Codex bubblewrap sandbox could not create the required Linux namespace on this host.",
      details: output,
      operatorCommand:
        "codex sandbox linux --permissions-profile smithersbot sh -lc 'echo smithersbot-codex-sandbox-ok'",
    };
  }
  return {
    proven: false,
    blocker: "live-probe-failed",
    reason: "Codex native permission-profile live probe did not complete successfully.",
    details: output,
  };
}

export function codexNativeSandboxStatus(
  params: {
    workingDir?: string;
    runId?: string;
    purpose?: CodexSandboxPurpose;
    requiresNetwork?: boolean;
    sandboxRoot?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): CodexNativeSandboxStatus {
  const env = params.env ?? process.env;
  const codexPath = commandPath("codex");
  if (!codexPath) {
    return {
      proven: false,
      blocker: "codex-not-found",
      reason: "codex CLI is not available on PATH.",
      command: "codex --version",
    };
  }

  const workingDir = params.workingDir ?? process.cwd();
  let sandboxConfig: CodexNativeSandboxConfig;
  try {
    sandboxConfig = writeCodexNativeSandboxConfig({
      workingDir,
      runId: params.runId ?? `status-${Date.now()}`,
      purpose: params.purpose ?? "goal-worker",
      requiresNetwork: params.requiresNetwork,
      sandboxRoot: params.sandboxRoot,
      codexPath,
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return {
      proven: false,
      blocker: details.includes("native binary")
        ? "helper-discovery-failed"
        : "config-generation-failed",
      reason: "Codex native sandbox config/helper setup failed.",
      details,
    };
  }

  if (env[CODEX_SANDBOX_LIVE_PROBES_ENV] !== "1") {
    return {
      proven: false,
      blocker: "live-probe-required",
      reason: `Set ${CODEX_SANDBOX_LIVE_PROBES_ENV}=1 to prove Codex native permission-profile enforcement with a live probe.`,
      command: `CODEX_HOME=${sandboxConfig.codexHome} PATH=${sandboxConfig.helperDir}:$PATH codex ${sandboxConfig.args.join(" ")} sh -lc '<probe>'`,
    };
  }

  const probe = [
    "set +e",
    "cat README.md >/dev/null; echo readme=$?",
    "cat .env.example >/dev/null; echo env_example=$?",
    "cat .env.local >/dev/null; echo env_local=$?",
    "cat .env.production >/dev/null; echo env_production=$?",
    "cat .env.test >/dev/null; echo env_test=$?",
    "cat ~/.smithersbot/.env >/dev/null; echo home_env=$?",
    "cat ~/.smithersbot/smithersbot.json >/dev/null; echo home_config=$?",
    `cat ${escapeShellArg(path.join(resolvePrivateRoot(), "env", path.basename(path.dirname(workingDir)), ".env"))} >/dev/null; echo private_env=$?`,
    // The generated CODEX_HOME/auth.json symlink must stay unreadable from inside
    // the sandbox: it resolves to the already-denied real ~/.codex/auth.json, so
    // only the unsandboxed control plane can follow it to authenticate.
    `cat ${escapeShellArg(sandboxConfig.authReferencePath)} >/dev/null; echo codex_auth=$?`,
    // The real ~/.codex/auth.json must also stay unreadable from the sandboxed
    // shell — distinct from the generated reference above. The unsandboxed Codex
    // control plane reads it directly to authenticate; the sandbox must not.
    `cat ${escapeShellArg(path.join(os.homedir(), ".codex", "auth.json"))} >/dev/null; echo real_codex_auth=$?`,
    "rm -f .smithersbot-codex-env-link",
    `ln -s ${escapeShellArg(path.join(resolvePrivateRoot(), "env", path.basename(path.dirname(workingDir)), ".env"))} .smithersbot-codex-env-link`,
    "cat .smithersbot-codex-env-link >/dev/null; echo symlink_escape=$?",
    "rm -f .smithersbot-codex-env-link",
    "printf ok > .smithersbot-codex-write-probe && cat .smithersbot-codex-write-probe && rm -f .smithersbot-codex-write-probe",
  ].join("; ");
  const result = spawnSync("codex", [...sandboxConfig.args, "sh", "-lc", probe], {
    cwd: workingDir,
    env: { ...process.env, ...sandboxConfig.env },
    encoding: "utf8",
    timeout: 45000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = formatSpawnOutput(result);
  const passed =
    result.status === 0 &&
    output.includes("readme=0") &&
    output.includes("env_example=0") &&
    output.includes("env_local=1") &&
    output.includes("env_production=1") &&
    output.includes("env_test=1") &&
    output.includes("home_env=1") &&
    output.includes("home_config=1") &&
    output.includes("private_env=1") &&
    output.includes("codex_auth=1") &&
    output.includes("real_codex_auth=1") &&
    output.includes("symlink_escape=1") &&
    output.includes("ok");
  if (passed) {
    return {
      proven: true,
      codexPath,
      version: commandVersion("codex"),
      configPath: sandboxConfig.configPath,
      helperPath: sandboxConfig.helperPath,
      summary:
        "Codex native permission profile denied secret reads and allowed workspace reads/writes.",
    };
  }
  return classifyCodexProbeFailure(output);
}

function escapeShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Markers emitted (one per line) by the Claude sandbox deny/allow probe command.
 * Each is printed as `SMITHERSBOT_CLAUDE_<marker>=<exit-code>`; deny markers must
 * report a non-zero (blocked) exit, allow markers a zero (succeeded) exit.
 */
const CLAUDE_PROBE_MARKERS = [
  "readme",
  "env_example",
  "env_local",
  "private_env",
  "symlink_escape",
  "claude_auth_path",
  "creds_file",
] as const;
type ClaudeProbeMarker = (typeof CLAUDE_PROBE_MARKERS)[number];
type ClaudeProbeMatrix = Partial<Record<ClaudeProbeMarker, number>>;

/** Managed private env path for {@link workingDir}'s workspace (never read here). */
function resolveWorkspacePrivateEnvPath(workingDir: string): string {
  return path.join(resolvePrivateRoot(), "env", path.basename(path.dirname(workingDir)), ".env");
}

/**
 * Build the single deny/allow probe command run inside Claude Code's native
 * sandbox via the Bash tool. Every read is redirected to /dev/null, so only
 * `<marker>=<exit-code>` booleans are emitted — never file contents. Deny reads
 * (managed private env, repo .env.local, symlink-escape to the private env) must
 * fail; allow reads (README.md, .env.example) must succeed.
 */
export function buildClaudeSandboxProbeCommand(workingDir: string): string {
  const privateEnvPath = resolveWorkspacePrivateEnvPath(workingDir);
  const linkName = ".smithersbot-claude-env-link";
  return [
    "set +e",
    "cat README.md >/dev/null 2>&1; echo SMITHERSBOT_CLAUDE_readme=$?",
    "cat .env.example >/dev/null 2>&1; echo SMITHERSBOT_CLAUDE_env_example=$?",
    "cat .env.local >/dev/null 2>&1; echo SMITHERSBOT_CLAUDE_env_local=$?",
    `cat ${escapeShellArg(privateEnvPath)} >/dev/null 2>&1; echo SMITHERSBOT_CLAUDE_private_env=$?`,
    `rm -f ${linkName}`,
    `ln -s ${escapeShellArg(privateEnvPath)} ${linkName} 2>/dev/null`,
    `cat ${linkName} >/dev/null 2>&1; echo SMITHERSBOT_CLAUDE_symlink_escape=$?`,
    `rm -f ${linkName}`,
    "cat ~/.claude/settings.json >/dev/null 2>&1; echo SMITHERSBOT_CLAUDE_claude_auth_path=$?",
    // Explicit credential-file deny check. Covered by the ~/.claude directory deny
    // (a directory deny tmpfs-mounts the whole subtree), proven separately so the
    // matrix records the credential store specifically as blocked.
    "cat ~/.claude/.credentials.json >/dev/null 2>&1; echo SMITHERSBOT_CLAUDE_creds_file=$?",
  ].join("; ");
}

function parseClaudeProbeMatrix(output: string): ClaudeProbeMatrix {
  const matrix: ClaudeProbeMatrix = {};
  for (const marker of CLAUDE_PROBE_MARKERS) {
    const match = output.match(new RegExp(`SMITHERSBOT_CLAUDE_${marker}=(\\d+)`));
    if (match) matrix[marker] = Number(match[1]);
  }
  return matrix;
}

function classifyClaudeProbeFailure(
  output: string,
  matrix?: ClaudeProbeMatrix,
): ClaudeCodeNativeSandboxStatus {
  if (output.includes(KNOWN_CLAUDE_LIBX32_BWRAP_ERROR)) {
    return {
      supported: false,
      blocker: "operator-action-required",
      reason:
        "Claude Code native sandbox failed during bubblewrap startup while mounting /newroot/libx32.",
      details:
        "The host has /libx32 as a symlink to /usr/libx32; this failure is not solved by creating /libx32 as a directory.",
      operatorCommand:
        "claude update && claude --version && SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES=1 pnpm vitest run src/goal/backend-sandbox.test.ts",
    };
  }
  if (/not logged in|please run \/login|run \/login|invalid api key/i.test(output)) {
    return {
      supported: false,
      blocker: "operator-action-required",
      reason:
        "Claude Code is not logged in, so the native sandbox deny/allow live probe could not run.",
      details:
        "Authenticate Claude Code in an operator-controlled context; the worker cannot supply auth because ~/.claude/** is hard-denied.",
      operatorCommand:
        "claude /login && SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES=1 node --import tsx scripts/prove-claude-sandbox.ts",
    };
  }
  if (
    matrix &&
    (matrix.env_local === 0 ||
      matrix.private_env === 0 ||
      matrix.symlink_escape === 0 ||
      matrix.claude_auth_path === 0 ||
      matrix.creds_file === 0)
  ) {
    return {
      supported: false,
      blocker: "operator-action-required",
      reason:
        "Claude Code ran but did not honor the fail-closed sandbox deny rules: a protected read succeeded.",
      details:
        "A managed private env / repo .env.local / symlink-escape / Claude auth-path read was not blocked inside the sandbox; the generated settings were not enforced.",
      operatorCommand:
        "claude --version && SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES=1 node --import tsx scripts/prove-claude-sandbox.ts",
    };
  }
  return {
    supported: false,
    blocker: "live-probe-failed",
    reason: "Claude Code native sandbox deny/allow live probe did not complete successfully.",
    details: output,
  };
}

export function claudeCodeNativeSandboxStatus(
  params: {
    workingDir?: string;
    runId?: string;
    purpose?: ClaudeSandboxPurpose;
    settingsRoot?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): ClaudeCodeNativeSandboxStatus {
  const env = params.env ?? process.env;
  const claudePath = commandPath("claude");
  if (!claudePath) {
    return {
      supported: false,
      blocker: "claude-not-found",
      reason: "claude CLI is not available on PATH.",
      command: "claude --version",
    };
  }

  for (const prerequisite of ["bwrap", "socat"]) {
    if (!commandPath(prerequisite)) {
      return {
        supported: false,
        blocker: "missing-host-prerequisite",
        reason: `Claude Code native sandbox host prerequisite is missing: ${prerequisite}.`,
        command: `command -v ${prerequisite}`,
        operatorCommand: `sudo apt-get install -y ${prerequisite === "bwrap" ? "bubblewrap" : prerequisite}`,
      };
    }
  }

  const workingDir = params.workingDir ?? process.cwd();
  let settingsConfig: ClaudeCodeSandboxSettingsConfig;
  try {
    settingsConfig = writeClaudeCodeSandboxSettings({
      workingDir,
      runId: params.runId ?? `status-${Date.now()}`,
      purpose: params.purpose ?? "goal-worker",
      settingsRoot: params.settingsRoot ?? resolveClaudeCodeSandboxSettingsRoot(env),
    });
  } catch (error) {
    return {
      supported: false,
      blocker: "settings-generation-failed",
      reason: "Claude Code sandbox settings could not be generated outside the agent workspace.",
      details: error instanceof Error ? error.message : String(error),
    };
  }

  if (env[CLAUDE_SANDBOX_LIVE_PROBES_ENV] !== "1") {
    return {
      supported: false,
      blocker: "live-probe-required",
      reason: `Set ${CLAUDE_SANDBOX_LIVE_PROBES_ENV}=1 to prove Claude Code native sandbox enforcement with a live probe.`,
      command: `claude -p --settings ${settingsConfig.settingsPath} --setting-sources ''`,
    };
  }

  const probeCommand = buildClaudeSandboxProbeCommand(workingDir);
  const result = spawnSync(
    "claude",
    [
      "-p",
      "--settings",
      settingsConfig.settingsPath,
      "--setting-sources",
      "",
      "--permission-mode",
      "default",
      "--allowedTools",
      "Bash",
    ],
    {
      cwd: workingDir,
      input: `Use the Bash tool to run exactly this one command, then reply with only its raw stdout:\n\n${probeCommand}`,
      env: stripClaudeSubscriptionAuthEnv(env),
      encoding: "utf8",
      timeout: 60000,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const output = formatSpawnOutput(result);
  const matrix = parseClaudeProbeMatrix(output);
  // Fail closed: supported only when EVERY deny read is blocked (exit != 0) and
  // EVERY allow read succeeds (exit 0). Missing markers leave the value undefined,
  // which never equals 0/1, so an incomplete probe is treated as unproven.
  const denyBlocked =
    matrix.env_local === 1 &&
    matrix.private_env === 1 &&
    matrix.symlink_escape === 1 &&
    matrix.claude_auth_path === 1 &&
    matrix.creds_file === 1;
  const allowSucceeded = matrix.readme === 0 && matrix.env_example === 0;
  if (result.status === 0 && denyBlocked && allowSucceeded) {
    return {
      supported: true,
      claudePath,
      version: commandVersion("claude"),
      settingsPath: settingsConfig.settingsPath,
      summary:
        "Claude Code native sandbox blocked managed private env, repo .env.local, symlink-escape, and Claude auth-path reads while allowing README.md and .env.example.",
    };
  }
  return classifyClaudeProbeFailure(output, matrix);
}
