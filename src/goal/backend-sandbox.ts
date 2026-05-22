import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isPathInsideAgentRoot,
  isPathInsidePrivateRoot,
  resolveAgentRoot,
  resolvePrivateRoot,
} from "../config/managed-paths.js";
import { AUTH_KEYS_TO_STRIP } from "./claude-code-env.js";

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
const DEFAULT_CLAUDE_SANDBOX_SETTINGS_ROOT = DEFAULT_CODEX_SANDBOX_ROOT;
const CLAUDE_SANDBOX_LIVE_PROBES_ENV = "SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES";
const KNOWN_CLAUDE_LIBX32_BWRAP_ERROR =
  "bwrap: Can't mount tmpfs on /newroot/libx32: No such file or directory";
const CLAUDE_AUTH_OK_REPLY = "claude-auth-ok";
const CLAUDE_BASE_URL_KEY = "ANTHROPIC_BASE_URL";

export function resolveManagedExecutionRoot(params: {
  workingDir: string;
  purpose: CodexSandboxPurpose;
}): string {
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
  purpose: CodexSandboxPurpose;
  requiresNetwork?: boolean;
}): CodexSandboxConfig {
  const executionRoot = resolveManagedExecutionRoot({
    workingDir: params.workingDir,
    purpose: params.purpose,
  });

  if (params.purpose === "repo-chat") {
    return {
      mode: "read-only",
      executionRoot,
      configOverrides: [`net.allowed=${params.requiresNetwork === true ? "true" : "false"}`],
    };
  }

  const gitWritablePath = path.join(params.workingDir, ".git");
  return {
    mode: "workspace-write",
    executionRoot,
    configOverrides: [
      `net.allowed=${params.requiresNetwork === true ? "true" : "false"}`,
      `sandbox_workspace_write.writable_roots=["${escapeTomlString(gitWritablePath)}"]`,
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

function buildCodexDeniedReadPaths(workingDir: string, authSourcePath: string): string[] {
  return uniqueValues([
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

function buildCodexPermissionProfileToml(params: {
  executionRoot: string;
  deniedReadPaths: string[];
  writablePaths: string[];
  requiresNetwork?: boolean;
}): string {
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
  purpose: CodexSandboxPurpose;
  requiresNetwork?: boolean;
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
  const allowedReadPaths =
    params.purpose === "repo-chat"
      ? uniqueValues([resolveAgentRoot(), params.workingDir])
      : uniqueValues([params.workingDir, path.join(resolveAgentRoot(), "history")]);
  const writablePaths =
    params.purpose === "repo-chat"
      ? []
      : uniqueValues([params.workingDir, path.join(params.workingDir, ".git")]);
  const deniedReadPaths = buildCodexDeniedReadPaths(params.workingDir, authSourcePath);
  const configToml = buildCodexPermissionProfileToml({
    executionRoot,
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
  purpose: CodexSandboxPurpose;
  requiresNetwork?: boolean;
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

function buildClaudeDenyReadPaths(workingDir: string): string[] {
  return uniqueValues([
    path.join(workingDir, ".env"),
    path.join(workingDir, ".env.local"),
    path.join(workingDir, ".env.production"),
    path.join(workingDir, ".env.test"),
    path.join(workingDir, "**", ".env"),
    path.join(workingDir, "**", ".env.*"),
    path.join(resolvePrivateRoot(), "**"),
    path.join(os.homedir(), ".smithersbot", "**"),
    path.join(os.homedir(), ".moltbot", "**"),
    path.join(os.homedir(), ".clawdbot", "**"),
    path.join(os.homedir(), ".clawdbot-dev", "**"),
    path.join(os.homedir(), ".codex", "**"),
    path.join(os.homedir(), ".claude", "**"),
    path.join(os.homedir(), ".ssh", "**"),
    path.join(os.homedir(), ".aws", "**"),
    path.join(os.homedir(), ".gnupg", "**"),
  ]);
}

export function buildClaudeCodeSandboxSettingsConfig(params: {
  workingDir: string;
  runId: string;
  purpose: ClaudeSandboxPurpose;
  settingsRoot?: string;
}): ClaudeCodeSandboxSettingsConfig {
  if (isPathInsidePrivateRoot(params.workingDir)) {
    throw new Error("Claude Code sandbox cannot run from SmithersBot private paths.");
  }

  const settingsRoot = params.settingsRoot ?? DEFAULT_CLAUDE_SANDBOX_SETTINGS_ROOT;
  const settingsDir = path.join(
    settingsRoot,
    `smithersbot-claude-${safeRunIdSegment(params.runId)}`,
  );
  const agentRoot = resolveAgentRoot();
  const allowRead =
    params.purpose === "repo-chat"
      ? uniqueValues([agentRoot, params.workingDir])
      : uniqueValues([params.workingDir, path.join(agentRoot, "history")]);
  const allowWrite = params.purpose === "repo-chat" ? [] : [params.workingDir];

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
          denyRead: buildClaudeDenyReadPaths(params.workingDir),
        },
      },
      permissions: {
        deny: [
          "Read(./.env)",
          "Read(./.env.*)",
          "Read(**/.env)",
          "Read(**/.env.*)",
          "Read(~/.smithersbot/**)",
          "Read(~/.moltbot/**)",
          "Read(~/.clawdbot/**)",
          "Read(~/.clawdbot-dev/**)",
          "Read(~/.codex/**)",
          "Read(~/.claude/**)",
          "Read(~/.ssh/**)",
          "Read(~/.aws/**)",
          "Read(~/.gnupg/**)",
        ],
      },
    },
  };
}

export function writeClaudeCodeSandboxSettings(params: {
  workingDir: string;
  runId: string;
  purpose: ClaudeSandboxPurpose;
  settingsRoot?: string;
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
  purpose: ClaudeSandboxPurpose;
  settingsRoot?: string;
}): ClaudeCodeLaunchSandboxConfig {
  const config = writeClaudeCodeSandboxSettings(params);
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
  const env = { ...sourceEnv };
  for (const key of [...AUTH_KEYS_TO_STRIP, CLAUDE_BASE_URL_KEY]) {
    delete env[key];
  }
  return env;
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
  const claudeHomePattern = path.join(os.homedir(), ".claude", "**");
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
          : config.settings.permissions.deny.filter((rule) => rule !== "Read(~/.claude/**)"),
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
  const settingsRoot = params.settingsRoot;

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
          "--bare",
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
          "--bare",
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
          "--bare",
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
          "--bare",
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
          "--bare",
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
    (matrix.env_local === 0 || matrix.private_env === 0 || matrix.symlink_escape === 0)
  ) {
    return {
      supported: false,
      blocker: "operator-action-required",
      reason:
        "Claude Code ran but did not honor the fail-closed sandbox deny rules: a protected read succeeded.",
      details:
        "A managed private env / repo .env.local / symlink-escape read was not blocked inside the sandbox; the generated settings were not enforced.",
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
      settingsRoot: params.settingsRoot,
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
      command: `claude -p --bare --settings ${settingsConfig.settingsPath} --setting-sources ''`,
    };
  }

  const probeCommand = buildClaudeSandboxProbeCommand(workingDir);
  const result = spawnSync(
    "claude",
    [
      "-p",
      "--bare",
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
    matrix.env_local === 1 && matrix.private_env === 1 && matrix.symlink_escape === 1;
  const allowSucceeded = matrix.readme === 0 && matrix.env_example === 0;
  if (result.status === 0 && denyBlocked && allowSucceeded) {
    return {
      supported: true,
      claudePath,
      version: commandVersion("claude"),
      settingsPath: settingsConfig.settingsPath,
      summary:
        "Claude Code native sandbox blocked managed private env, repo .env.local, and symlink-escape reads while allowing README.md and .env.example.",
    };
  }
  return classifyClaudeProbeFailure(output, matrix);
}
