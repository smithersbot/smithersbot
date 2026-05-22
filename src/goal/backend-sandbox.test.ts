import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecFileSync = vi.fn();
const mockSpawnSync = vi.fn();
const HOST_TEMP_ROOT = process.env.CODEX_HOME
  ? path.join(process.env.CODEX_HOME, "memories")
  : os.tmpdir();

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
}));

import {
  buildClaudeSandboxProbeCommand,
  buildCodexNativeSandboxConfig,
  buildClaudeCodeSandboxSettingsConfig,
  classifyClaudeSubscriptionAuthProbeFailure,
  codexNativeSandboxStatus,
  claudeCodeNativeSandboxStatus,
  runClaudeSubscriptionAuthDifferentialProbes,
  writeCodexNativeSandboxConfig,
  writeClaudeCodeSandboxSettings,
} from "./backend-sandbox.js";
import { isPathInsideAgentRoot } from "../config/managed-paths.js";

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function createFakeCodexInstall(): { codexPath: string; cleanup: () => void } {
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
  fs.writeFileSync(codexPath, "#!/bin/sh\n");
  fs.writeFileSync(path.join(nativeDir, "codex"), "#!/bin/sh\n");
  return { codexPath, cleanup: () => fs.rmSync(fakeInstall, { recursive: true, force: true }) };
}

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
    const sandboxRoot = fs.mkdtempSync(path.join(HOST_TEMP_ROOT, "codex-native-sandbox-"));
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
      sandboxRoot: HOST_TEMP_ROOT,
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
        "readme=0\nenv_example=0\nenv_local=1\nenv_production=1\nenv_test=1\nhome_env=1\nhome_config=1\nprivate_env=1\ncodex_auth=1\nreal_codex_auth=1\nsymlink_escape=1\nok",
      stderr: "",
    });

    const status = codexNativeSandboxStatus({
      workingDir: process.cwd(),
      runId: "live-ok",
      sandboxRoot: HOST_TEMP_ROOT,
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

  it("fails closed when the real ~/.codex/auth.json read is not blocked", () => {
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
    // Every deny passes except the real ~/.codex/auth.json read, which succeeded
    // (real_codex_auth=0). The status must fail closed, never report proven.
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout:
        "readme=0\nenv_example=0\nenv_local=1\nenv_production=1\nenv_test=1\nhome_env=1\nhome_config=1\nprivate_env=1\ncodex_auth=1\nreal_codex_auth=0\nsymlink_escape=1\nok",
      stderr: "",
    });

    const status = codexNativeSandboxStatus({
      workingDir: process.cwd(),
      runId: "real-auth-leak",
      sandboxRoot: HOST_TEMP_ROOT,
      env: { SMITHERSBOT_CODEX_SANDBOX_LIVE_PROBES: "1" },
    });

    expect(status.proven).toBe(false);
    if (!status.proven) {
      expect(status.blocker).toBe("live-probe-failed");
    }
  });
});

describe("Codex native sandbox auth continuity", () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockSpawnSync.mockReset();
  });

  // (a) Generated CODEX_HOME carries an auth reference to the real ~/.codex/auth.json
  // and lives outside agent-visible roots.
  it("carries an auth reference targeting the real ~/.codex/auth.json with codexHome outside agent roots", () => {
    const managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "managed-root-"));
    try {
      const workingDir = path.join(managedRoot, "agent", "workspaces", "smithersbot", "repo");
      fs.mkdirSync(workingDir, { recursive: true });
      withEnv({ SMITHERSBOT_GOALS_ROOT: managedRoot, CODEX_HOME: undefined }, () => {
        const config = buildCodexNativeSandboxConfig({
          workingDir,
          runId: "auth-ref",
          purpose: "goal-worker",
          sandboxRoot: HOST_TEMP_ROOT,
          codexPath: "/usr/local/bin/codex",
        });

        expect(config.authReferencePath).toBe(path.join(config.codexHome, "auth.json"));
        expect(config.authSourcePath).toBe(path.join(os.homedir(), ".codex", "auth.json"));
        expect(config.codexHome.startsWith(workingDir)).toBe(false);
        expect(isPathInsideAgentRoot(config.codexHome)).toBe(false);
      });
    } finally {
      fs.rmSync(managedRoot, { recursive: true, force: true });
    }
  });

  // (b) config.toml still selects the smithersbot permission profile.
  it('keeps default_permissions = "smithersbot" in the generated config.toml', () => {
    const config = buildCodexNativeSandboxConfig({
      workingDir: "/home/matt/smithersbot-goals/agent/workspaces/smithersbot/repo",
      runId: "perm",
      purpose: "goal-worker",
      sandboxRoot: HOST_TEMP_ROOT,
      codexPath: "/usr/local/bin/codex",
    });
    expect(config.configToml).toContain('default_permissions = "smithersbot"');
  });

  // (c) Deny rules still cover private env, repo .env variants, and ~/.codex/auth.json
  // with no broad recursive deny over /, ~, or ~/.codex.
  it("denies private env, repo env files, and ~/.codex/auth.json without broad recursive denies", () => {
    const managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "managed-root-"));
    try {
      const workingDir = path.join(managedRoot, "agent", "workspaces", "smithersbot", "repo");
      fs.mkdirSync(workingDir, { recursive: true });
      withEnv({ SMITHERSBOT_GOALS_ROOT: managedRoot, CODEX_HOME: undefined }, () => {
        const config = buildCodexNativeSandboxConfig({
          workingDir,
          runId: "deny",
          purpose: "goal-worker",
          sandboxRoot: HOST_TEMP_ROOT,
          codexPath: "/usr/local/bin/codex",
        });

        for (const denied of [
          path.join(managedRoot, "private", "env", "smithersbot", ".env"),
          path.join(workingDir, ".env"),
          path.join(workingDir, ".env.local"),
          path.join(workingDir, ".env.production"),
          path.join(workingDir, ".env.test"),
          path.join(os.homedir(), ".codex", "auth.json"),
        ]) {
          expect(config.deniedReadPaths).toContain(denied);
        }
        for (const broad of ["/", os.homedir(), path.join(os.homedir(), ".codex")]) {
          expect(config.deniedReadPaths).not.toContain(broad);
          expect(config.deniedReadPaths).not.toContain(path.join(broad, "**"));
        }
      });
    } finally {
      fs.rmSync(managedRoot, { recursive: true, force: true });
    }
  });

  // (d) README.md and .env.example stay readable through the workspace grant, with
  // no broad read grant added to reach them.
  it("keeps README.md and .env.example readable via the workspace grant without broad read grants", () => {
    const managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "managed-root-"));
    try {
      const workingDir = path.join(managedRoot, "agent", "workspaces", "smithersbot", "repo");
      fs.mkdirSync(workingDir, { recursive: true });
      withEnv({ SMITHERSBOT_GOALS_ROOT: managedRoot, CODEX_HOME: undefined }, () => {
        const config = buildCodexNativeSandboxConfig({
          workingDir,
          runId: "allow",
          purpose: "goal-worker",
          sandboxRoot: HOST_TEMP_ROOT,
          codexPath: "/usr/local/bin/codex",
        });

        // The workspace executionRoot write grant (write implies read) covers
        // README.md and .env.example, neither of which carries a deny rule.
        expect(config.configToml).toContain(`${JSON.stringify(workingDir)} = "write"`);
        expect(config.deniedReadPaths).not.toContain(path.join(workingDir, "README.md"));
        expect(config.deniedReadPaths).not.toContain(path.join(workingDir, ".env.example"));
        for (const root of [
          "/home",
          "/home/matt",
          os.homedir(),
          path.join(os.homedir(), ".codex"),
        ]) {
          expect(config.configToml).not.toContain(`${JSON.stringify(root)} = "read"`);
        }
      });
    } finally {
      fs.rmSync(managedRoot, { recursive: true, force: true });
    }
  });

  // (e)+(f) Both the generated CODEX_HOME/auth.json and the real ~/.codex/auth.json
  // are blocked from the sandboxed shell: the generated reference is a symlink to
  // the real auth source, and that source is in the deny list.
  it("blocks both the generated and real auth paths from the sandboxed shell", () => {
    withEnv({ CODEX_HOME: undefined }, () => {
      const config = buildCodexNativeSandboxConfig({
        workingDir: "/home/matt/smithersbot-goals/agent/workspaces/smithersbot/repo",
        runId: "auth-block",
        purpose: "goal-worker",
        sandboxRoot: HOST_TEMP_ROOT,
        codexPath: "/usr/local/bin/codex",
      });

      // Real auth path is denied directly (f).
      expect(config.deniedReadPaths).toContain(path.join(os.homedir(), ".codex", "auth.json"));
      // Generated reference resolves to the real auth source, which is denied (e).
      expect(config.authReferencePath).toBe(path.join(config.codexHome, "auth.json"));
      expect(config.deniedReadPaths).toContain(config.authSourcePath);
    });
  });

  // (g) The control plane authenticates via a real symlink (not a copy) at the
  // generated auth reference, while that reference stays denied to the sandbox.
  it("symlinks the generated auth.json to the real auth source for control-plane auth", () => {
    const sandboxRoot = fs.mkdtempSync(path.join(HOST_TEMP_ROOT, "codex-native-sandbox-"));
    const fakeCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    const install = createFakeCodexInstall();
    fs.writeFileSync(path.join(fakeCodexHome, "auth.json"), '{"OPENAI_API_KEY":"placeholder"}\n');
    try {
      withEnv({ CODEX_HOME: fakeCodexHome }, () => {
        const config = writeCodexNativeSandboxConfig({
          workingDir: process.cwd(),
          runId: "auth-link",
          purpose: "goal-worker",
          sandboxRoot,
          codexPath: install.codexPath,
        });

        expect(config.env.CODEX_HOME).toBe(config.codexHome);
        expect(config.authSourcePath).toBe(path.join(fakeCodexHome, "auth.json"));
        const linkStat = fs.lstatSync(config.authReferencePath);
        expect(linkStat.isSymbolicLink()).toBe(true);
        expect(fs.readlinkSync(config.authReferencePath)).toBe(config.authSourcePath);
        // The control-plane read resolves through the symlink; the sandboxed shell
        // is blocked because the resolved target is denied.
        expect(config.deniedReadPaths).toContain(config.authSourcePath);
      });
    } finally {
      fs.rmSync(sandboxRoot, { recursive: true, force: true });
      fs.rmSync(fakeCodexHome, { recursive: true, force: true });
      install.cleanup();
    }
  });

  it("skips the auth symlink (no copy) when the real auth source is absent", () => {
    const sandboxRoot = fs.mkdtempSync(path.join(HOST_TEMP_ROOT, "codex-native-sandbox-"));
    const emptyCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-empty-"));
    const install = createFakeCodexInstall();
    try {
      withEnv({ CODEX_HOME: emptyCodexHome }, () => {
        const config = writeCodexNativeSandboxConfig({
          workingDir: process.cwd(),
          runId: "auth-missing",
          purpose: "goal-worker",
          sandboxRoot,
          codexPath: install.codexPath,
        });

        expect(fs.existsSync(config.authReferencePath)).toBe(false);
      });
    } finally {
      fs.rmSync(sandboxRoot, { recursive: true, force: true });
      fs.rmSync(emptyCodexHome, { recursive: true, force: true });
      install.cleanup();
    }
  });

  // (h) No new broad read grant beyond the single sandbox-bootstrap base read.
  it("introduces no broad read grant beyond the single sandbox-bootstrap base", () => {
    const config = buildCodexNativeSandboxConfig({
      workingDir: "/home/matt/smithersbot-goals/agent/workspaces/smithersbot/repo",
      runId: "no-broad",
      purpose: "goal-worker",
      sandboxRoot: HOST_TEMP_ROOT,
      codexPath: "/usr/local/bin/codex",
    });

    // The lone pre-existing `"/" = "read"` base keeps /bin/sh, shared libs, and the
    // codex-linux-sandbox helper executable inside bubblewrap; the auth fix adds no
    // new read grants. Specific deny rules override it by path specificity.
    const baseReadGrants = config.configToml.match(/^"\/" = "read"$/gm) ?? [];
    expect(baseReadGrants).toHaveLength(1);
    for (const root of [
      "/home",
      "/home/matt",
      path.join(os.homedir(), ".codex"),
      path.join(os.homedir(), ".ssh"),
      path.join(os.homedir(), ".aws"),
      path.join(os.homedir(), ".gnupg"),
      path.join(os.homedir(), ".smithersbot"),
      path.join(os.homedir(), ".moltbot"),
      path.join(os.homedir(), ".clawdbot-dev"),
    ]) {
      expect(config.configToml).not.toContain(`${JSON.stringify(root)} = "read"`);
    }
  });

  // (i) Regression: no danger flags and no --sandbox workspace-write shape.
  it("emits no danger-full-access / dangerously-bypass / --sandbox workspace-write flags", () => {
    const config = buildCodexNativeSandboxConfig({
      workingDir: "/home/matt/smithersbot-goals/agent/workspaces/smithersbot/repo",
      runId: "regression",
      purpose: "goal-worker",
      sandboxRoot: HOST_TEMP_ROOT,
      codexPath: "/usr/local/bin/codex",
    });

    const joined = config.args.join(" ");
    expect(joined).not.toContain("danger-full-access");
    expect(joined).not.toContain("dangerously-bypass");
    expect(config.args).not.toContain("--sandbox");
    expect(config.args).not.toContain("workspace-write");
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

    expect(config.settingsDir).toBe(path.join("/var/tmp", "smithersbot-claude-run-with-spaces"));
    expect(config.settingsPath).toBe(path.join(config.settingsDir, "settings.json"));
    expect(config.settingsPath).not.toContain("/agent/workspaces/smithersbot/repo");
  });

  it("writes fail-closed sandbox settings and denies private/env reads while allowing workspace files", () => {
    const settingsRoot = fs.mkdtempSync(path.join(HOST_TEMP_ROOT, "claude-sandbox-settings-"));
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
      settingsRoot: HOST_TEMP_ROOT,
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

  const CLAUDE_MATRIX_PASS_STDOUT = [
    "SMITHERSBOT_CLAUDE_readme=0",
    "SMITHERSBOT_CLAUDE_env_example=0",
    "SMITHERSBOT_CLAUDE_env_local=1",
    "SMITHERSBOT_CLAUDE_private_env=1",
    "SMITHERSBOT_CLAUDE_symlink_escape=1",
    "",
  ].join("\n");

  it("reports supported only after the live deny/allow matrix passes", () => {
    mockCommandPaths();
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: CLAUDE_MATRIX_PASS_STDOUT,
      stderr: "",
    });

    const status = claudeCodeNativeSandboxStatus({
      workingDir: process.cwd(),
      runId: "live-ok",
      settingsRoot: HOST_TEMP_ROOT,
      env: { SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES: "1" },
    });

    expect(status.supported).toBe(true);
    if (status.supported) {
      expect(status.version).toBe("2.1.143 (Claude Code)");
      expect(status.settingsPath).toContain("smithersbot-claude-live-ok");
      expect(status.summary).toContain("blocked managed private env");
    }
    // The live probe drives Claude through the generated fail-closed settings with
    // the Bash tool and never via a danger-skip-permissions flag.
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining([
        "--settings",
        expect.stringContaining("settings.json"),
        "--allowedTools",
        "Bash",
      ]),
      expect.objectContaining({ cwd: process.cwd() }),
    );
    const claudeArgs = mockSpawnSync.mock.calls[0][1] as string[];
    expect(claudeArgs.join(" ")).not.toContain("dangerously-skip-permissions");
  });

  it("fails closed (unsupported) when a denied read succeeds inside the sandbox", () => {
    mockCommandPaths();
    // env_local read succeeded (=0) — a deny was not honored. Must never report
    // supported; classified as an operator-action security blocker.
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: [
        "SMITHERSBOT_CLAUDE_readme=0",
        "SMITHERSBOT_CLAUDE_env_example=0",
        "SMITHERSBOT_CLAUDE_env_local=0",
        "SMITHERSBOT_CLAUDE_private_env=1",
        "SMITHERSBOT_CLAUDE_symlink_escape=1",
        "",
      ].join("\n"),
      stderr: "",
    });

    const status = claudeCodeNativeSandboxStatus({
      workingDir: process.cwd(),
      runId: "deny-leak",
      settingsRoot: HOST_TEMP_ROOT,
      env: { SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES: "1" },
    });

    expect(status.supported).toBe(false);
    if (!status.supported) {
      expect(status.blocker).toBe("operator-action-required");
      expect(status.reason).toContain("did not honor");
    }
  });

  it("reports unsupported when an allowed read fails inside the sandbox", () => {
    mockCommandPaths();
    // README.md read failed (=1) even though every deny blocked — the allow side of
    // the matrix did not pass, so the probe is not proven.
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: [
        "SMITHERSBOT_CLAUDE_readme=1",
        "SMITHERSBOT_CLAUDE_env_example=0",
        "SMITHERSBOT_CLAUDE_env_local=1",
        "SMITHERSBOT_CLAUDE_private_env=1",
        "SMITHERSBOT_CLAUDE_symlink_escape=1",
        "",
      ].join("\n"),
      stderr: "",
    });

    const status = claudeCodeNativeSandboxStatus({
      workingDir: process.cwd(),
      runId: "allow-fail",
      settingsRoot: HOST_TEMP_ROOT,
      env: { SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES: "1" },
    });

    expect(status.supported).toBe(false);
    if (!status.supported) {
      expect(status.blocker).toBe("live-probe-failed");
    }
  });

  it("classifies a not-logged-in / settings-not-honored failure as an operator blocker", () => {
    mockCommandPaths();
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "Not logged in · Please run /login\n",
    });

    const status = claudeCodeNativeSandboxStatus({
      workingDir: process.cwd(),
      runId: "not-logged-in",
      settingsRoot: HOST_TEMP_ROOT,
      env: { SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES: "1" },
    });

    expect(status.supported).toBe(false);
    if (!status.supported) {
      expect(status.blocker).toBe("operator-action-required");
      expect(status.reason).toContain("not logged in");
      expect(status.operatorCommand).toContain("claude /login");
    }
  });

  it("builds a deny/allow probe command that prints booleans only and never file contents", () => {
    const managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "managed-root-"));
    const previousRoot = process.env.SMITHERSBOT_GOALS_ROOT;
    process.env.SMITHERSBOT_GOALS_ROOT = managedRoot;
    try {
      const workingDir = path.join(managedRoot, "agent", "workspaces", "smithersbot", "repo");
      const command = buildClaudeSandboxProbeCommand(workingDir);

      const privateEnvPath = path.join(managedRoot, "private", "env", "smithersbot", ".env");
      // Deny + allow checks present; every read redirected to /dev/null (no contents).
      expect(command).toContain("cat README.md >/dev/null 2>&1; echo SMITHERSBOT_CLAUDE_readme=$?");
      expect(command).toContain("SMITHERSBOT_CLAUDE_env_example=$?");
      expect(command).toContain("SMITHERSBOT_CLAUDE_env_local=$?");
      expect(command).toContain("SMITHERSBOT_CLAUDE_private_env=$?");
      expect(command).toContain("SMITHERSBOT_CLAUDE_symlink_escape=$?");
      expect(command).toContain(privateEnvPath);
      // The managed private env is referenced for deny + symlink-escape checks only;
      // it is always piped to /dev/null, never printed.
      expect(command).not.toMatch(new RegExp(`cat '${privateEnvPath}'(?! >/dev/null)`));
      // Symlink-escape probe cleans up the link it creates.
      expect(command).toContain("rm -f .smithersbot-claude-env-link");
    } finally {
      if (previousRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
      else process.env.SMITHERSBOT_GOALS_ROOT = previousRoot;
      fs.rmSync(managedRoot, { recursive: true, force: true });
    }
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
      settingsRoot: HOST_TEMP_ROOT,
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

  it("keeps Claude subscription-auth differential probes fail-closed unless explicitly enabled", () => {
    mockCommandPaths();

    const report = runClaudeSubscriptionAuthDifferentialProbes({
      workingDir: process.cwd(),
      runId: "auth-disabled",
      settingsRoot: HOST_TEMP_ROOT,
      env: {},
    });

    expect(report).toEqual({
      enabled: false,
      ok: false,
      blocker: "live-probe-required",
      results: [],
    });
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it("classifies subscription-auth probe failures without carrying raw output", () => {
    expect(
      classifyClaudeSubscriptionAuthProbeFailure({
        output: "Invalid API key provided",
        usedGeneratedSettings: false,
      }),
    ).toBe("api-key-env-poisoning");
    expect(
      classifyClaudeSubscriptionAuthProbeFailure({
        output: "Not logged in. Please run /login",
        usedGeneratedSettings: false,
      }),
    ).toBe("missing-subscription-login");
    expect(
      classifyClaudeSubscriptionAuthProbeFailure({
        output: "Not logged in. Please run /login",
        usedGeneratedSettings: true,
      }),
    ).toBe("generated-settings-hiding-claude-auth");
    expect(
      classifyClaudeSubscriptionAuthProbeFailure({
        output: "bwrap: Can't mount tmpfs on /newroot/libx32: No such file or directory",
        usedGeneratedSettings: true,
      }),
    ).toBe("native-sandbox-libx32-runtime-blocker");
    expect(
      classifyClaudeSubscriptionAuthProbeFailure({
        output: "unexpected provider failure",
        usedGeneratedSettings: true,
      }),
    ).toBe("generic-failure");
  });

  it("runs status-only Claude subscription-auth differential probes with API-key env unset", () => {
    mockCommandPaths();
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "claude-auth-ok\n",
      stderr: "",
    });

    const settingsRoot = fs.mkdtempSync(path.join(HOST_TEMP_ROOT, "claude-auth-probes-"));
    try {
      const report = runClaudeSubscriptionAuthDifferentialProbes({
        workingDir: process.cwd(),
        runId: "auth-ok",
        settingsRoot,
        env: {
          SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES: "1",
          ANTHROPIC_API_KEY: "placeholder-api-key",
          ANTHROPIC_AUTH_TOKEN: "placeholder-auth-token",
          ANTHROPIC_API_KEY_OLD: "placeholder-old-api-key",
          ANTHROPIC_BASE_URL: "https://placeholder.invalid",
          PATH: process.env.PATH,
        },
      });

      expect(report.enabled).toBe(true);
      expect(report.ok).toBe(true);
      expect(report.blocker).toBe("none");
      expect(report.results).toEqual([
        { id: "plain_unset_api_key_env", ok: true, blocker: "none" },
        { id: "settings_without_claude_deny", ok: true, blocker: "none" },
        { id: "setting_sources_empty", ok: true, blocker: "none" },
        { id: "permissions_deny_claude_only", ok: true, blocker: "none" },
        { id: "sandbox_deny_claude_only", ok: true, blocker: "none" },
        { id: "full_generated_settings", ok: true, blocker: "none" },
      ]);

      expect(mockSpawnSync).toHaveBeenCalledTimes(6);
      for (const call of mockSpawnSync.mock.calls) {
        const args = call[1] as string[];
        const options = call[2] as { env: Record<string, string | undefined> };
        expect(call[0]).toBe("claude");
        expect(args.join(" ")).not.toContain("dangerously-skip-permissions");
        expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(options.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
        expect(options.env.ANTHROPIC_API_KEY_OLD).toBeUndefined();
        expect(options.env.ANTHROPIC_BASE_URL).toBeUndefined();
      }

      const plainArgs = mockSpawnSync.mock.calls[0][1] as string[];
      expect(plainArgs).toEqual(["-p", "Reply exactly: claude-auth-ok"]);
      const allArgs = mockSpawnSync.mock.calls.map((call) => call[1] as string[]);
      expect(allArgs[1]).toContain("--settings");
      expect(allArgs[1]).not.toContain("--setting-sources");
      expect(allArgs.slice(2).every((args) => args.includes("--setting-sources"))).toBe(true);

      for (const result of report.results) {
        expect(Object.keys(result).sort()).toEqual(["blocker", "id", "ok"]);
      }
      expect(JSON.stringify(report)).not.toContain("Invalid API key");
      expect(JSON.stringify(report)).not.toContain("Not logged in");
      expect(JSON.stringify(report)).not.toContain("placeholder-api-key");
    } finally {
      fs.rmSync(settingsRoot, { recursive: true, force: true });
    }
  });

  it("reports generated-settings-hidden auth as a status-only blocker", () => {
    mockCommandPaths();
    mockSpawnSync
      .mockReturnValueOnce({
        status: 0,
        stdout: "claude-auth-ok\n",
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 1,
        stdout: "",
        stderr: "Not logged in. Please run /login\n",
      })
      .mockReturnValue({
        status: 1,
        stdout: "",
        stderr: "Not logged in. Please run /login\n",
      });

    const settingsRoot = fs.mkdtempSync(path.join(HOST_TEMP_ROOT, "claude-auth-probes-"));
    try {
      const report = runClaudeSubscriptionAuthDifferentialProbes({
        workingDir: process.cwd(),
        runId: "auth-hidden",
        settingsRoot,
        env: { SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES: "1", PATH: process.env.PATH },
      });

      expect(report.ok).toBe(false);
      expect(report.blocker).toBe("generated-settings-hiding-claude-auth");
      expect(report.results[0]).toEqual({
        id: "plain_unset_api_key_env",
        ok: true,
        blocker: "none",
      });
      expect(report.results[1]).toEqual({
        id: "settings_without_claude_deny",
        ok: false,
        blocker: "generated-settings-hiding-claude-auth",
      });
      expect(JSON.stringify(report)).not.toContain("Not logged in");
      expect(JSON.stringify(report)).not.toContain("/login");
    } finally {
      fs.rmSync(settingsRoot, { recursive: true, force: true });
    }
  });
});
