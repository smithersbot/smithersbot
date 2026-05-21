import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecFileSync = vi.fn();
const mockSpawnSync = vi.fn();

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
}));

import {
  buildCodexNativeSandboxConfig,
  buildClaudeCodeSandboxSettingsConfig,
  codexNativeSandboxStatus,
  claudeCodeNativeSandboxStatus,
  writeCodexNativeSandboxConfig,
  writeClaudeCodeSandboxSettings,
} from "./backend-sandbox.js";

function mockCommandPaths(): void {
  mockExecFileSync.mockImplementation((command: string, args: string[]) => {
    const joined = [command, ...args].join(" ");
    if (joined === "sh -lc command -v codex") return "/usr/local/bin/codex\n";
    if (joined === "sh -lc command -v claude") return "/usr/local/bin/claude\n";
    if (joined === "sh -lc command -v bwrap") return "/usr/bin/bwrap\n";
    if (joined === "sh -lc command -v socat") return "/usr/bin/socat\n";
    if (joined === "codex --version") return "codex-cli 0.133.0\n";
    if (joined === "claude --version") return "2.1.143 (Claude Code)\n";
    throw new Error(`unexpected command: ${joined}`);
  });
}

describe("Codex native permission-profile sandbox config", () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockSpawnSync.mockReset();
  });

  it("generates per-run config under /var/tmp by default, outside the repo", () => {
    const config = buildCodexNativeSandboxConfig({
      workingDir: "/home/matt/smithersbot-goals/agent/workspaces/smithersbot/repo",
      runId: "run/with spaces",
      purpose: "goal-worker",
      codexPath: "/usr/local/bin/codex",
    });

    expect(config.codexHome).toBe("/var/tmp/smithersbot-codex-run-with-spaces");
    expect(config.configPath).toBe(path.join(config.codexHome, "config.toml"));
    expect(config.helperPath).toBe(path.join(config.codexHome, "bin", "codex-linux-sandbox"));
    expect(config.configPath).not.toContain("/agent/workspaces/smithersbot/repo");
    expect(config.args).toEqual([
      "sandbox",
      "linux",
      "--permissions-profile",
      "smithersbot",
      "--cd",
      "/home/matt/smithersbot-goals/agent/workspaces/smithersbot/repo",
    ]);
    expect(config.args).not.toContain("--sandbox");
  });

  it("emits the Codex 0.133 permission-profile TOML shape without broad recursive denies", () => {
    const managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "managed-root-"));
    const previousRoot = process.env.SMITHERSBOT_GOALS_ROOT;
    process.env.SMITHERSBOT_GOALS_ROOT = managedRoot;
    try {
      const workingDir = path.join(managedRoot, "agent", "workspaces", "smithersbot", "repo");
      fs.mkdirSync(workingDir, { recursive: true });
      const config = buildCodexNativeSandboxConfig({
        workingDir,
        runId: "toml-shape",
        purpose: "goal-worker",
        codexPath: "/usr/local/bin/codex",
      });

      expect(config.configToml).toContain('default_permissions = "smithersbot"');
      expect(config.configToml).toContain("[permissions.smithersbot.filesystem]");
      expect(config.configToml).toContain("glob_scan_max_depth = 8");
      // Base read grant keeps /bin/sh, shared libs, and the codex-linux-sandbox
      // helper executable inside the bubblewrap sandbox; specific write/deny rules
      // below override it by path specificity.
      expect(config.configToml).toContain('"/" = "read"');
      expect(config.configToml).toContain(`${JSON.stringify(workingDir)} = "write"`);
      expect(config.configToml).toContain(
        `${JSON.stringify(path.join(workingDir, ".env.local"))} = "deny"`,
      );
      expect(config.configToml).toContain(
        `${JSON.stringify(path.join(managedRoot, "private", "env", "smithersbot", ".env"))} = "deny"`,
      );
      expect(config.configToml).toContain("[permissions.smithersbot.network]");
      expect(config.configToml).toContain("enabled = false");

      for (const deniedPath of [
        "/",
        os.homedir(),
        path.join(os.homedir(), ".smithersbot"),
        path.join(os.homedir(), ".codex"),
      ]) {
        expect(config.deniedReadPaths).not.toContain(deniedPath);
        expect(config.deniedReadPaths).not.toContain(path.join(deniedPath, "**"));
      }
    } finally {
      if (previousRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
      else process.env.SMITHERSBOT_GOALS_ROOT = previousRoot;
      fs.rmSync(managedRoot, { recursive: true, force: true });
    }
  });

  it("writes config and makes codex-linux-sandbox visible through a per-run helper directory", () => {
    const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-native-sandbox-"));
    const fakeInstall = fs.mkdtempSync(path.join(os.tmpdir(), "codex-install-"));
    const binDir = path.join(fakeInstall, "bin");
    const nativeDir = path.join(
      fakeInstall,
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
    );
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(nativeDir, { recursive: true });
    const codexPath = path.join(binDir, "codex");
    const nativePath = path.join(nativeDir, "codex");
    fs.writeFileSync(codexPath, "#!/bin/sh\n");
    fs.writeFileSync(nativePath, "#!/bin/sh\n");

    try {
      const config = writeCodexNativeSandboxConfig({
        workingDir: process.cwd(),
        runId: "helper-test",
        purpose: "goal-worker",
        sandboxRoot,
        codexPath,
      });

      expect(config.configPath).toBe(
        path.join(sandboxRoot, "smithersbot-codex-helper-test", "config.toml"),
      );
      expect(fs.readFileSync(config.configPath, "utf8")).toBe(config.configToml);
      expect(fs.existsSync(config.helperPath)).toBe(true);
      expect(config.env.CODEX_HOME).toBe(config.codexHome);
      expect(config.env.PATH.startsWith(`${config.helperDir}${path.delimiter}`)).toBe(true);
    } finally {
      fs.rmSync(sandboxRoot, { recursive: true, force: true });
      fs.rmSync(fakeInstall, { recursive: true, force: true });
    }
  });

  it("returns a structured fail-closed blocker until the Codex live probe is explicitly enabled", () => {
    mockCommandPaths();
    mockExecFileSync.mockImplementation((command: string, args: string[]) => {
      const joined = [command, ...args].join(" ");
      if (joined === "sh -lc command -v codex") return "/usr/local/bin/codex\n";
      if (joined === "find /usr/local/lib/node_modules/@openai/codex -path */bin/codex -type f") {
        return "/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex\n";
      }
      if (joined === "codex --version") return "codex-cli 0.133.0\n";
      throw new Error(`unexpected command: ${joined}`);
    });

    const status = codexNativeSandboxStatus({
      workingDir: process.cwd(),
      runId: "status-test",
      sandboxRoot: os.tmpdir(),
      env: {},
    });

    expect(status.proven).toBe(false);
    if (!status.proven) {
      expect(status.blocker).toBe("live-probe-required");
      expect(status.command).toContain("--permissions-profile smithersbot");
      expect(status.reason).toContain("SMITHERSBOT_CODEX_SANDBOX_LIVE_PROBES=1");
    }
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it("reports proven only after the live permission-profile probe passes", () => {
    mockCommandPaths();
    mockExecFileSync.mockImplementation((command: string, args: string[]) => {
      const joined = [command, ...args].join(" ");
      if (joined === "sh -lc command -v codex") return "/usr/local/bin/codex\n";
      if (joined === "find /usr/local/lib/node_modules/@openai/codex -path */bin/codex -type f") {
        return "/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex\n";
      }
      if (joined === "codex --version") return "codex-cli 0.133.0\n";
      throw new Error(`unexpected command: ${joined}`);
    });
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout:
        "readme=0\nenv_example=0\nenv_local=1\nenv_production=1\nenv_test=1\nhome_env=1\nhome_config=1\nprivate_env=1\nsymlink_escape=1\nok",
      stderr: "",
    });

    const status = codexNativeSandboxStatus({
      workingDir: process.cwd(),
      runId: "live-ok",
      sandboxRoot: os.tmpdir(),
      env: { SMITHERSBOT_CODEX_SANDBOX_LIVE_PROBES: "1" },
    });

    expect(status.proven).toBe(true);
    if (status.proven) {
      expect(status.version).toBe("codex-cli 0.133.0");
      expect(status.configPath).toContain("smithersbot-codex-live-ok");
      expect(status.helperPath).toContain("codex-linux-sandbox");
    }
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "codex",
      expect.arrayContaining(["sandbox", "linux", "--permissions-profile", "smithersbot"]),
      expect.objectContaining({
        cwd: process.cwd(),
        env: expect.objectContaining({
          CODEX_HOME: expect.stringContaining("smithersbot-codex-live-ok"),
          PATH: expect.stringContaining("smithersbot-codex-live-ok/bin"),
        }),
      }),
    );
  });
});

describe("Claude Code native sandbox settings", () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockSpawnSync.mockReset();
  });

  it("generates per-run settings under the OS temp dir by default, outside the repo", () => {
    const config = buildClaudeCodeSandboxSettingsConfig({
      workingDir: "/home/matt/smithersbot-goals/agent/workspaces/smithersbot/repo",
      runId: "run/with spaces",
      purpose: "goal-worker",
    });

    expect(config.settingsDir).toBe(path.join(os.tmpdir(), "smithersbot-claude-run-with-spaces"));
    expect(config.settingsPath).toBe(path.join(config.settingsDir, "settings.json"));
    expect(config.settingsPath).not.toContain("/agent/workspaces/smithersbot/repo");
  });

  it("writes fail-closed sandbox settings and denies private/env reads while allowing workspace files", () => {
    const settingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-sandbox-settings-"));
    const managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "managed-root-"));
    const previousRoot = process.env.SMITHERSBOT_GOALS_ROOT;
    process.env.SMITHERSBOT_GOALS_ROOT = managedRoot;
    try {
      const workingDir = path.join(managedRoot, "agent", "workspaces", "smithersbot", "repo");
      fs.mkdirSync(workingDir, { recursive: true });

      const config = writeClaudeCodeSandboxSettings({
        workingDir,
        runId: "run-123",
        purpose: "goal-worker",
        settingsRoot,
      });
      const parsed = JSON.parse(
        fs.readFileSync(config.settingsPath, "utf8"),
      ) as typeof config.settings;

      expect(config.settingsPath).toBe(
        path.join(settingsRoot, "smithersbot-claude-run-123", "settings.json"),
      );
      expect(parsed.sandbox.enabled).toBe(true);
      expect(parsed.sandbox.failIfUnavailable).toBe(true);
      expect(parsed.sandbox.autoAllowBashIfSandboxed).toBe(false);
      expect(parsed.sandbox.filesystem.allowRead).toContain(workingDir);
      expect(parsed.sandbox.filesystem.allowRead).toContain(
        path.join(managedRoot, "agent", "history"),
      );
      expect(parsed.sandbox.filesystem.allowWrite).toEqual([workingDir]);
      expect(parsed.sandbox.filesystem.denyRead).toContain(path.join(workingDir, ".env.local"));
      expect(parsed.sandbox.filesystem.denyRead).toContain(path.join(managedRoot, "private", "**"));
      expect(parsed.permissions.deny).toContain("Read(./.env.*)");
      expect(parsed.permissions.deny).toContain("Read(~/.claude/**)");
    } finally {
      if (previousRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
      else process.env.SMITHERSBOT_GOALS_ROOT = previousRoot;
      fs.rmSync(settingsRoot, { recursive: true, force: true });
      fs.rmSync(managedRoot, { recursive: true, force: true });
    }
  });

  it("returns a structured fail-closed blocker until the live probe is explicitly enabled", () => {
    mockCommandPaths();

    const status = claudeCodeNativeSandboxStatus({
      workingDir: process.cwd(),
      runId: "status-test",
      settingsRoot: os.tmpdir(),
      env: {},
    });

    expect(status.supported).toBe(false);
    if (!status.supported) {
      expect(status.blocker).toBe("live-probe-required");
      expect(status.command).toContain("--settings");
      expect(status.reason).toContain("SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES=1");
    }
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it("reports supported only after the live startup probe succeeds", () => {
    mockCommandPaths();
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "smithersbot-claude-sandbox-ok\n",
      stderr: "",
    });

    const status = claudeCodeNativeSandboxStatus({
      workingDir: process.cwd(),
      runId: "live-ok",
      settingsRoot: os.tmpdir(),
      env: { SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES: "1" },
    });

    expect(status.supported).toBe(true);
    if (status.supported) {
      expect(status.version).toBe("2.1.143 (Claude Code)");
      expect(status.settingsPath).toContain("smithersbot-claude-live-ok");
    }
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining(["--settings", expect.stringContaining("settings.json")]),
      expect.objectContaining({ cwd: process.cwd() }),
    );
  });

  it("classifies the known bwrap /newroot/libx32 startup failure with an operator command", () => {
    mockCommandPaths();
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "bwrap: Can't mount tmpfs on /newroot/libx32: No such file or directory\n",
    });

    const status = claudeCodeNativeSandboxStatus({
      workingDir: process.cwd(),
      runId: "libx32-fail",
      settingsRoot: os.tmpdir(),
      env: { SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES: "1" },
    });

    expect(status.supported).toBe(false);
    if (!status.supported) {
      expect(status.blocker).toBe("operator-action-required");
      expect(status.reason).toContain("bubblewrap startup");
      expect(status.details).toContain("/libx32 as a symlink");
      expect(status.operatorCommand).toContain("claude update");
      expect(status.operatorCommand).not.toContain("mkdir /libx32");
    }
  });
});
