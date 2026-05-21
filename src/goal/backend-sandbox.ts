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

export type CodexSandboxPurpose = "goal-worker" | "repo-chat";
export type ClaudeSandboxPurpose = CodexSandboxPurpose;

export type CodexSandboxConfig = {
  mode: "read-only" | "workspace-write";
  executionRoot: string;
  configOverrides: string[];
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

const DEFAULT_CLAUDE_SANDBOX_SETTINGS_ROOT = "/var/tmp";
const CLAUDE_SANDBOX_LIVE_PROBES_ENV = "SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES";
const KNOWN_CLAUDE_LIBX32_BWRAP_ERROR =
  "bwrap: Can't mount tmpfs on /newroot/libx32: No such file or directory";

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

function classifyClaudeProbeFailure(output: string): ClaudeCodeNativeSandboxStatus {
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
  return {
    supported: false,
    blocker: "live-probe-failed",
    reason: "Claude Code native sandbox live probe did not complete successfully.",
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
      "Bash(echo *)",
    ],
    {
      cwd: workingDir,
      input: "Use Bash to run: echo smithersbot-claude-sandbox-ok",
      encoding: "utf8",
      timeout: 45000,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const output = formatSpawnOutput(result);
  if (result.status === 0 && output.includes("smithersbot-claude-sandbox-ok")) {
    return {
      supported: true,
      claudePath,
      version: commandVersion("claude"),
      settingsPath: settingsConfig.settingsPath,
      summary: "Claude Code native sandbox started with fail-closed settings.",
    };
  }
  return classifyClaudeProbeFailure(output);
}
