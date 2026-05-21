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
  buildClaudeCodeSandboxSettingsConfig,
  claudeCodeNativeSandboxStatus,
  writeClaudeCodeSandboxSettings,
} from "./backend-sandbox.js";

function mockCommandPaths(): void {
  mockExecFileSync.mockImplementation((command: string, args: string[]) => {
    const joined = [command, ...args].join(" ");
    if (joined === "sh -lc command -v claude") return "/usr/local/bin/claude\n";
    if (joined === "sh -lc command -v bwrap") return "/usr/bin/bwrap\n";
    if (joined === "sh -lc command -v socat") return "/usr/bin/socat\n";
    if (joined === "claude --version") return "2.1.143 (Claude Code)\n";
    throw new Error(`unexpected command: ${joined}`);
  });
}

describe("Claude Code native sandbox settings", () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockSpawnSync.mockReset();
  });

  it("generates per-run settings under /var/tmp by default, outside the repo", () => {
    const config = buildClaudeCodeSandboxSettingsConfig({
      workingDir: "/home/matt/smithersbot-goals/agent/workspaces/smithersbot/repo",
      runId: "run/with spaces",
      purpose: "goal-worker",
    });

    expect(config.settingsDir).toBe("/var/tmp/smithersbot-claude-run-with-spaces");
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
