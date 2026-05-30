import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

const mockExecFileSync = vi.fn();
const mockSpawnSync = vi.fn();
const HOST_TEMP_ROOT = process.env.CODEX_HOME
  ? path.join(process.env.CODEX_HOME, "memories")
  : os.tmpdir();
const MOCK_WORKING_DIR = path.join(
  os.tmpdir(),
  "smithersbot-mock-agent",
  "workspaces",
  "smithersbot",
  "repo",
);
const HOST_HOME = os.homedir();
const HOST_HOME_ROOT = path.parse(HOST_HOME).root;
const BROAD_HOME_READ_FIXTURES = Array.from(
  new Set([HOST_HOME, path.dirname(HOST_HOME)].filter((candidate) => candidate !== HOST_HOME_ROOT)),
);

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
}));

import {
  buildClaudeSandboxProbeCommand,
  buildCodexNativeSandboxConfig,
  buildClaudeCodeSandboxSettingsConfig,
  claudeCodeSandboxNetworkCapability,
  appendCodexNativeSandboxExecArgs,
  classifyClaudeSubscriptionAuthProbeFailure,
  codexNativeSandboxStatus,
  claudeCodeNativeSandboxStatus,
  resolveClaudeCodeSandboxSettingsRoot,
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

type IsolatedSandboxRoots = { managedRoot: string; workingDir: string; sandboxRoot: string };

/**
 * Provide host-independent sandbox roots for offline status/probe tests.
 *
 * The native-sandbox guards require generated config to live OUTSIDE the agent root
 * AND outside the workspace. Under vitest, os.tmpdir() is redirected into the repo
 * (see vitest.config.ts), and on dogfood hosts the repo itself lives under the real
 * agent root — so tests must NOT pass process.cwd()/os.tmpdir() straight through or
 * the guard fail-closes as `*-generation-failed`. This points SMITHERSBOT_GOALS_ROOT
 * at a fresh managed root, places workingDir under it, and returns a sibling
 * sandboxRoot (outside the agent root, not a parent of workingDir). Cleanup and env
 * restoration run via onTestFinished, so the test body stays flat.
 */
function setupIsolatedSandboxRoots(): IsolatedSandboxRoots {
  const managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-managed-"));
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-root-"));
  const workingDir = path.join(managedRoot, "agent", "workspaces", "smithersbot", "repo");
  fs.mkdirSync(workingDir, { recursive: true });
  const previousRoot = process.env.SMITHERSBOT_GOALS_ROOT;
  process.env.SMITHERSBOT_GOALS_ROOT = managedRoot;
  onTestFinished(() => {
    if (previousRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
    else process.env.SMITHERSBOT_GOALS_ROOT = previousRoot;
    fs.rmSync(managedRoot, { recursive: true, force: true });
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  });
  return { managedRoot, workingDir, sandboxRoot };
}

describe("Codex native permission-profile sandbox config", () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockSpawnSync.mockReset();
  });

  it("generates per-run config under /var/tmp by default, outside the repo", () => {
    const config = buildCodexNativeSandboxConfig({
      workingDir: MOCK_WORKING_DIR,
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
      MOCK_WORKING_DIR,
    ]);
    expect(config.args).not.toContain("--sandbox");
  });

  it("appends the Codex trust preflight skip once before the execution root", () => {
    const config = buildCodexNativeSandboxConfig({
      workingDir: "/repo",
      runId: "exec-args",
      purpose: "repo-chat",
      sandboxRoot: HOST_TEMP_ROOT,
      codexPath: "/usr/local/bin/codex",
    });
    const originalSandboxArgs = [...config.args];

    const args = appendCodexNativeSandboxExecArgs(["exec", "--json"], config);

    expect(args).toEqual(["exec", "--json", "--skip-git-repo-check", "--cd", "/repo"]);
    expect(config.args).toEqual(originalSandboxArgs);
  });

  it("does not duplicate an existing Codex trust preflight skip", () => {
    const config = buildCodexNativeSandboxConfig({
      workingDir: "/repo",
      runId: "exec-args-dedup",
      purpose: "repo-chat",
      sandboxRoot: HOST_TEMP_ROOT,
      codexPath: "/usr/local/bin/codex",
    });

    const args = appendCodexNativeSandboxExecArgs(
      ["exec", "--json", "--skip-git-repo-check"],
      config,
    );

    expect(args.filter((arg) => arg === "--skip-git-repo-check")).toHaveLength(1);
    expect(args).toEqual(["exec", "--json", "--skip-git-repo-check", "--cd", "/repo"]);
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
    const { workingDir, sandboxRoot } = setupIsolatedSandboxRoots();
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
        workingDir,
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

    const { workingDir, sandboxRoot } = setupIsolatedSandboxRoots();
    const status = codexNativeSandboxStatus({
      workingDir,
      runId: "status-test",
      sandboxRoot,
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

    const { workingDir, sandboxRoot } = setupIsolatedSandboxRoots();
    const status = codexNativeSandboxStatus({
      workingDir,
      runId: "live-ok",
      sandboxRoot,
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
        cwd: workingDir,
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

    const { workingDir, sandboxRoot } = setupIsolatedSandboxRoots();
    const status = codexNativeSandboxStatus({
      workingDir,
      runId: "real-auth-leak",
      sandboxRoot,
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
      workingDir: MOCK_WORKING_DIR,
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
        for (const root of [...BROAD_HOME_READ_FIXTURES, path.join(HOST_HOME, ".codex")]) {
          expect(config.configToml).not.toContain(`${JSON.stringify(root)} = "read"`);
        }
      });
    } finally {
      fs.rmSync(managedRoot, { recursive: true, force: true });
    }
  });

  it("keeps repo-chat Codex read-only except explicit extra writable paths", () => {
    const managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "managed-root-"));
    try {
      const workingDir = path.join(managedRoot, "agent", "workspaces", "smithersbot", "repo");
      const scoutDir = path.join(os.tmpdir(), "planner-scout-extra-write");
      fs.mkdirSync(workingDir, { recursive: true });
      withEnv({ SMITHERSBOT_GOALS_ROOT: managedRoot, CODEX_HOME: undefined }, () => {
        const config = buildCodexNativeSandboxConfig({
          workingDir,
          runId: "repo-chat-extra-write",
          purpose: "repo-chat",
          extraWritablePaths: [scoutDir],
          sandboxRoot: HOST_TEMP_ROOT,
          codexPath: "/usr/local/bin/codex",
        });

        expect(config.executionRoot).toBe(path.join(managedRoot, "agent"));
        expect(config.allowedReadPaths).toContain(path.join(managedRoot, "agent"));
        expect(config.allowedReadPaths).toContain(workingDir);
        expect(config.writablePaths).toEqual([scoutDir]);
        expect(config.configToml).toContain(`${JSON.stringify(config.executionRoot)} = "read"`);
        expect(config.configToml).toContain(`${JSON.stringify(scoutDir)} = "write"`);
        expect(config.configToml).not.toContain(`${JSON.stringify(workingDir)} = "write"`);
        expect(config.deniedReadPaths).toContain(path.join(workingDir, ".env"));
        expect(config.deniedReadPaths).toContain(
          path.join(managedRoot, "private", "env", "smithersbot", ".env"),
        );
        expect(config.deniedReadPaths).toContain(path.join(os.homedir(), ".codex", "auth.json"));
      });
    } finally {
      fs.rmSync(managedRoot, { recursive: true, force: true });
    }
  });

  it("adds configured observed dev agent roots without moving a stable goal-worker execution root", () => {
    const home = "/home/matt";
    const stableWorkingDir = path.join(
      home,
      "smithersbot-home",
      "agent",
      "workspaces",
      "smithersbot-dev",
    );
    const stableHistoryRoot = path.join(home, "smithersbot-home", "agent", "history");
    const devAgentRoot = path.join(home, "smithersbot-dev-home", "agent");
    const devWorkspacesRoot = path.join(devAgentRoot, "workspaces");
    const devHistoryRoot = path.join(devAgentRoot, "history");
    const devPrivateRoot = path.join(home, "smithersbot-dev-home", "private");
    const devStateDir = path.join(home, ".smithersbot-dev");
    const devPrivateChecks = [
      devPrivateRoot,
      path.join(devPrivateRoot, "env"),
      path.join(devPrivateRoot, "config"),
      path.join(devPrivateRoot, "auth"),
      path.join(devPrivateRoot, "sessions"),
      devStateDir,
    ];
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(home);

    try {
      withEnv({ SMITHERSBOT_GOALS_ROOT: undefined, SMITHERSBOT_INSTANCE: undefined }, () => {
        const config = buildCodexNativeSandboxConfig({
          workingDir: stableWorkingDir,
          runId: "observed-dev-read-roots",
          purpose: "goal-worker",
          readOnlyRoots: [devAgentRoot, devWorkspacesRoot, devHistoryRoot],
          sandboxRoot: HOST_TEMP_ROOT,
          codexPath: "/usr/local/bin/codex",
        });

        expect(config.executionRoot).toBe(stableWorkingDir);
        expect(config.args).toContain(stableWorkingDir);
        expect(config.allowedReadPaths).toEqual(
          expect.arrayContaining([
            stableWorkingDir,
            stableHistoryRoot,
            devAgentRoot,
            devWorkspacesRoot,
            devHistoryRoot,
          ]),
        );
        expect(config.writablePaths).toContain(stableWorkingDir);
        expect(config.writablePaths).not.toContain(devAgentRoot);
        expect(config.configToml).toContain(`${JSON.stringify(devAgentRoot)} = "read"`);
        expect(config.configToml).toContain(`${JSON.stringify(devWorkspacesRoot)} = "read"`);
        expect(config.configToml).toContain(`${JSON.stringify(devHistoryRoot)} = "read"`);

        for (const privatePath of devPrivateChecks) {
          expect(config.deniedReadPaths).toContain(privatePath);
          expect(config.allowedReadPaths).not.toContain(privatePath);
          expect(config.configToml).toContain(`${JSON.stringify(privatePath)} = "deny"`);
          expect(config.configToml).not.toContain(`${JSON.stringify(privatePath)} = "read"`);
        }
      });
    } finally {
      homedirSpy.mockRestore();
    }
  });

  // (e)+(f) Both the generated CODEX_HOME/auth.json and the real ~/.codex/auth.json
  // are blocked from the sandboxed shell: the generated reference is a symlink to
  // the real auth source, and that source is in the deny list.
  it("blocks both the generated and real auth paths from the sandboxed shell", () => {
    withEnv({ CODEX_HOME: undefined }, () => {
      const config = buildCodexNativeSandboxConfig({
        workingDir: MOCK_WORKING_DIR,
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
    const { workingDir, sandboxRoot } = setupIsolatedSandboxRoots();
    const fakeCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    const install = createFakeCodexInstall();
    fs.writeFileSync(path.join(fakeCodexHome, "auth.json"), '{"OPENAI_API_KEY":"placeholder"}\n');
    try {
      withEnv({ CODEX_HOME: fakeCodexHome }, () => {
        const config = writeCodexNativeSandboxConfig({
          workingDir,
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
      fs.rmSync(fakeCodexHome, { recursive: true, force: true });
      install.cleanup();
    }
  });

  it("skips the auth symlink (no copy) when the real auth source is absent", () => {
    const { workingDir, sandboxRoot } = setupIsolatedSandboxRoots();
    const emptyCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-empty-"));
    const install = createFakeCodexInstall();
    try {
      withEnv({ CODEX_HOME: emptyCodexHome }, () => {
        const config = writeCodexNativeSandboxConfig({
          workingDir,
          runId: "auth-missing",
          purpose: "goal-worker",
          sandboxRoot,
          codexPath: install.codexPath,
        });

        expect(fs.existsSync(config.authReferencePath)).toBe(false);
      });
    } finally {
      fs.rmSync(emptyCodexHome, { recursive: true, force: true });
      install.cleanup();
    }
  });

  // (h) No new broad read grant beyond the single sandbox-bootstrap base read.
  it("introduces no broad read grant beyond the single sandbox-bootstrap base", () => {
    const config = buildCodexNativeSandboxConfig({
      workingDir: MOCK_WORKING_DIR,
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
      ...BROAD_HOME_READ_FIXTURES,
      path.join(HOST_HOME, ".codex"),
      path.join(HOST_HOME, ".ssh"),
      path.join(HOST_HOME, ".aws"),
      path.join(HOST_HOME, ".gnupg"),
      path.join(HOST_HOME, ".smithersbot"),
      path.join(HOST_HOME, ".moltbot"),
      path.join(HOST_HOME, ".clawdbot-dev"),
    ]) {
      expect(config.configToml).not.toContain(`${JSON.stringify(root)} = "read"`);
    }
  });

  // (i) Regression: no danger flags and no --sandbox workspace-write shape.
  it("emits no danger-full-access / dangerously-bypass / --sandbox workspace-write flags", () => {
    const config = buildCodexNativeSandboxConfig({
      workingDir: MOCK_WORKING_DIR,
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
      workingDir: MOCK_WORKING_DIR,
      runId: "run/with spaces",
      purpose: "goal-worker",
    });

    expect(config.settingsDir).toBe(path.join("/var/tmp", "smithersbot-claude-run-with-spaces"));
    expect(config.settingsPath).toBe(path.join(config.settingsDir, "settings.json"));
    expect(config.settingsPath).not.toContain("/agent/workspaces/smithersbot/repo");
  });

  it("reports Claude Code sandbox network supported per-step without any env-var opt-in", () => {
    const previous = process.env.SMITHERSBOT_CLAUDE_SANDBOX_NETWORK;
    try {
      // No env var set: per-step policy alone makes Claude eligible to attempt network.
      delete process.env.SMITHERSBOT_CLAUDE_SANDBOX_NETWORK;
      const cap = claudeCodeSandboxNetworkCapability();
      expect(cap.supported).toBe(true);
      expect(cap.reason).not.toMatch(/SMITHERSBOT_CLAUDE_SANDBOX_NETWORK/);
      expect(cap.reason).toMatch(/requiresNetwork=true/);
    } finally {
      if (previous === undefined) delete process.env.SMITHERSBOT_CLAUDE_SANDBOX_NETWORK;
      else process.env.SMITHERSBOT_CLAUDE_SANDBOX_NETWORK = previous;
    }
  });

  it("omits a network grant for normal repo-local steps (network off by default)", () => {
    const config = buildClaudeCodeSandboxSettingsConfig({
      workingDir: MOCK_WORKING_DIR,
      runId: "no-network",
      purpose: "goal-worker",
    });
    expect(config.settings.sandbox.network).toBeUndefined();
  });

  it("wires a network grant when requiresNetwork=true with no env var set", () => {
    const previous = process.env.SMITHERSBOT_CLAUDE_SANDBOX_NETWORK;
    delete process.env.SMITHERSBOT_CLAUDE_SANDBOX_NETWORK;
    try {
      const config = buildClaudeCodeSandboxSettingsConfig({
        workingDir: MOCK_WORKING_DIR,
        runId: "net-supported",
        purpose: "goal-worker",
        requiresNetwork: true,
      });
      // Claude Code's network proxy is default-deny and allowlist-based with no
      // universal allow-all token, so the grant is a list of per-suffix wildcards
      // (each `*.<tld>` matches any host under that suffix, including the apex).
      const network = config.settings.sandbox.network;
      expect(network).toBeDefined();
      expect(Array.isArray(network?.allowedDomains)).toBe(true);
      // Every entry is a per-suffix wildcard; a bare "*" (which the proxy rejects)
      // must never be emitted.
      expect(network?.allowedDomains.every((d) => /^\*\.[a-z]+$/.test(d))).toBe(true);
      expect(network?.allowedDomains).not.toContain("*");
      // example.com (the live-test target) is covered by the *.com wildcard.
      expect(network?.allowedDomains).toContain("*.com");
    } finally {
      if (previous === undefined) delete process.env.SMITHERSBOT_CLAUDE_SANDBOX_NETWORK;
      else process.env.SMITHERSBOT_CLAUDE_SANDBOX_NETWORK = previous;
    }
  });

  it("omits the network grant when requiresNetwork is false (network off by default)", () => {
    const config = buildClaudeCodeSandboxSettingsConfig({
      workingDir: MOCK_WORKING_DIR,
      runId: "net-false",
      purpose: "goal-worker",
      requiresNetwork: false,
    });
    expect(config.settings.sandbox.network).toBeUndefined();
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
        // Deterministic deny generation: treat every candidate as present and not a
        // symlink, and scan no home directories, so the asserted shape does not depend
        // on (or read) the real test HOME. (Exact sensitive-file discovery is covered
        // by its own fake-home fixture test below.)
        denyReadDeps: {
          pathExists: () => true,
          realPath: (candidate) => candidate,
          readDir: () => [],
          isRegularFile: () => false,
          isDirectory: () => false,
        },
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
      // Literal repo env file + directory-path denies (no `**` globs, which hang
      // bubblewrap startup by walking large trees like node_modules).
      expect(parsed.sandbox.filesystem.denyRead).toContain(path.join(workingDir, ".env.local"));
      expect(parsed.sandbox.filesystem.denyRead).toContain(path.join(managedRoot, "private"));
      expect(parsed.sandbox.filesystem.denyRead).toContain(path.join(os.homedir(), ".claude"));
      // Regression guards: never emit `**` globs or the recursive repo .env walk.
      expect(parsed.sandbox.filesystem.denyRead.some((entry) => entry.includes("**"))).toBe(false);
      expect(parsed.sandbox.filesystem.denyRead).not.toContain(path.join(workingDir, "**", ".env"));
      // Read-tool permission denies: repo env files by ABSOLUTE LITERAL path (the
      // workspace-relative `Read(./.env)` / `Read(**/.env)` forms make Claude scan
      // node_modules at sandbox startup and hang — proven by live bisection); home
      // credential dirs by `~/...` (those do not hang).
      expect(parsed.permissions.deny).toContain(`Read(${path.join(workingDir, ".env.local")})`);
      expect(parsed.permissions.deny).toContain(`Read(${path.join(os.homedir(), ".claude")}/**)`);
      // Regression guards: no workspace-relative / recursive Read-tool patterns (they make
      // Claude scan node_modules at startup and hang).
      expect(parsed.permissions.deny.some((rule) => rule.startsWith("Read(./"))).toBe(false);
      expect(parsed.permissions.deny.some((rule) => rule.includes("Read(**/"))).toBe(false);
    } finally {
      if (previousRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
      else process.env.SMITHERSBOT_GOALS_ROOT = previousRoot;
      fs.rmSync(settingsRoot, { recursive: true, force: true });
      fs.rmSync(managedRoot, { recursive: true, force: true });
    }
  });

  it("filters deny entries to existing real paths and emits no ** globs (empty home scan)", () => {
    const home = "/home/testuser";
    const config = buildClaudeCodeSandboxSettingsConfig({
      workingDir: "/ws/repo",
      runId: "deny-filter",
      purpose: "goal-worker",
      denyReadDeps: {
        homedir: () => home,
        privateRoot: () => "/managed/private",
        // .env.production and ~/.aws are absent on this host; everything else exists.
        pathExists: (candidate) =>
          candidate !== path.join("/ws/repo", ".env.production") &&
          candidate !== path.join(home, ".aws"),
        // ~/.claude is a symlink to a relocated config dir and ~/.clawdbot -> ~/.moltbot;
        // bwrap cannot mount over a symlink, so they must resolve to real targets.
        realPath: (candidate) => {
          if (candidate === path.join(home, ".claude")) return "/real/claude-config";
          if (candidate === path.join(home, ".clawdbot")) return path.join(home, ".moltbot");
          return candidate;
        },
        // No sensitive home files exist for this case: exact-file discovery finds nothing,
        // so only the dir/literal deny matrix remains. (Population is covered separately.)
        readDir: () => [],
        isRegularFile: () => false,
        isDirectory: () => false,
      },
    });
    const deny = config.settings.sandbox.filesystem.denyRead;

    // Absent path dropped (bwrap would fail "Can't mount tmpfs ... No such file").
    expect(deny).not.toContain(path.join("/ws/repo", ".env.production"));
    // Symlinked protected dir resolved to its real, mountable target.
    expect(deny).not.toContain(path.join(home, ".claude"));
    expect(deny).toContain("/real/claude-config");
    // Required matrix present: private root (covers private env + symlink escape),
    // repo literal env files, and the Claude credential/config store.
    expect(deny).toContain("/managed/private");
    expect(deny).toContain(path.join("/ws/repo", ".env"));
    expect(deny).toContain(path.join("/ws/repo", ".env.local"));
    expect(deny).toContain(path.join("/ws/repo", ".env.test"));
    // With an empty home scan no credential-dir files are discovered, so the deny set
    // is exactly the dir/literal matrix (no `~/.ssh`/`~/.gnupg`/`~/.codex`/legacy entries).
    for (const dropped of [
      ".ssh",
      ".gnupg",
      ".codex",
      ".smithersbot",
      ".moltbot",
      ".clawdbot-dev",
    ]) {
      expect(deny.some((entry) => entry.includes(dropped))).toBe(false);
    }
    expect(deny).toHaveLength(5);
    // Never emit `**` globs in the sandbox filesystem denyRead.
    expect(deny.some((entry) => entry.includes("**"))).toBe(false);

    // permissions.deny (Read-tool denies) are enforced via the SAME bwrap mounts, so they
    // must be filtered too: absent dropped, symlinks resolved+deduped, repo env absolute.
    const perm = config.settings.permissions.deny;
    expect(perm).toContain(`Read(${path.join("/ws/repo", ".env.local")})`);
    expect(perm).not.toContain(`Read(${path.join("/ws/repo", ".env.production")})`); // absent
    expect(perm).toContain("Read(/real/claude-config/**)"); // resolved ~/.claude symlink
    expect(perm).not.toContain(`Read(${path.join(home, ".claude")}/**)`); // unresolved form gone
    expect(perm).not.toContain(`Read(${path.join(home, ".aws")}/**)`); // absent dropped
    expect(perm).not.toContain(`Read(${path.join(home, ".clawdbot")}/**)`); // symlink resolved away
    expect(perm.filter((rule) => rule === `Read(${path.join(home, ".moltbot")}/**)`)).toHaveLength(
      1,
    );
    // No workspace-relative / recursive Read-tool patterns.
    expect(perm.some((rule) => rule.startsWith("Read(./"))).toBe(false);
    expect(perm.some((rule) => rule.includes("Read(**/"))).toBe(false);
  });

  it("adds configured observed dev agent roots to Claude allowRead while sealing dev private state", () => {
    const home = "/home/matt";
    const stableWorkingDir = path.join(
      home,
      "smithersbot-home",
      "agent",
      "workspaces",
      "smithersbot-dev",
    );
    const stablePrivateRoot = path.join(home, "smithersbot-home", "private");
    const stableHistoryRoot = path.join(home, "smithersbot-home", "agent", "history");
    const devAgentRoot = path.join(home, "smithersbot-dev-home", "agent");
    const devWorkspacesRoot = path.join(devAgentRoot, "workspaces");
    const devHistoryRoot = path.join(devAgentRoot, "history");
    const devPrivateRoot = path.join(home, "smithersbot-dev-home", "private");
    const devStateDir = path.join(home, ".smithersbot-dev");
    const devPrivateChecks = [
      devPrivateRoot,
      path.join(devPrivateRoot, "env"),
      path.join(devPrivateRoot, "config"),
      path.join(devPrivateRoot, "auth"),
      path.join(devPrivateRoot, "sessions"),
      devStateDir,
    ];
    const isSameOrInside = (candidate: string, parent: string) =>
      candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(home);

    try {
      const config = buildClaudeCodeSandboxSettingsConfig({
        workingDir: stableWorkingDir,
        runId: "observed-dev-claude",
        purpose: "goal-worker",
        readOnlyRoots: [devAgentRoot, devWorkspacesRoot, devHistoryRoot],
        denyReadDeps: {
          homedir: () => home,
          privateRoot: () => stablePrivateRoot,
          pathExists: () => true,
          realPath: (candidate) => candidate,
          readDir: () => [],
          isRegularFile: () => false,
          isDirectory: () => false,
        },
      });
      const { allowRead, allowWrite, denyRead } = config.settings.sandbox.filesystem;

      expect(allowRead).toEqual(
        expect.arrayContaining([
          stableWorkingDir,
          stableHistoryRoot,
          devAgentRoot,
          devWorkspacesRoot,
          devHistoryRoot,
        ]),
      );
      expect(allowWrite).toEqual([stableWorkingDir]);

      for (const privatePath of devPrivateChecks) {
        expect(denyRead).toContain(privatePath);
        expect(allowRead.some((root) => isSameOrInside(root, privatePath))).toBe(false);
        expect(config.settings.permissions.deny).toContain(`Read(${privatePath}/**)`);
      }
    } finally {
      homedirSpy.mockRestore();
    }
  });

  it("keeps repo-chat Claude settings read-only except explicit extra writable paths", () => {
    const home = "/home/testuser";
    const config = buildClaudeCodeSandboxSettingsConfig({
      workingDir: "/managed/agent/workspaces/smithersbot/repo",
      runId: "claude-extra-write",
      purpose: "repo-chat",
      extraWritablePaths: ["/tmp/planner-scout"],
      denyReadDeps: {
        homedir: () => home,
        privateRoot: () => "/managed/private",
        pathExists: () => true,
        realPath: (candidate) => {
          if (candidate === path.join(home, ".claude")) return "/real/claude-config";
          if (candidate === "/managed/private") return "/managed/private";
          return candidate;
        },
        // Scan no home files: this case asserts the dir/literal denies and Read-tool rules.
        readDir: () => [],
        isRegularFile: () => false,
        isDirectory: () => false,
      },
    });

    expect(config.settings.sandbox.enabled).toBe(true);
    expect(config.settings.sandbox.failIfUnavailable).toBe(true);
    expect(config.settings.sandbox.filesystem.allowRead).toContain(
      "/managed/agent/workspaces/smithersbot/repo",
    );
    expect(config.settings.sandbox.filesystem.allowWrite).toEqual(["/tmp/planner-scout"]);
    expect(config.settings.sandbox.filesystem.allowWrite).not.toContain(
      "/managed/agent/workspaces/smithersbot/repo",
    );
    expect(config.settings.sandbox.filesystem.denyRead).toContain(
      "/managed/agent/workspaces/smithersbot/repo/.env",
    );
    expect(config.settings.sandbox.filesystem.denyRead).toContain("/managed/private");
    expect(config.settings.sandbox.filesystem.denyRead).toContain("/real/claude-config");
    expect(config.settings.permissions.deny).toContain(
      "Read(/managed/agent/workspaces/smithersbot/repo/.env)",
    );
    expect(config.settings.permissions.deny).toContain("Read(/real/claude-config/**)");
    expect(config.settings.permissions.deny).toContain(`Read(${path.join(home, ".codex")}/**)`);
    expect(config.settings.permissions.deny).toContain(`Read(${path.join(home, ".ssh")}/**)`);
  });

  it("denies exact existing sensitive home/credential files via metadata-bounded discovery", () => {
    // Canonicalize the fixture root so emitted realpath()s match our expected paths
    // even when os.tmpdir() resolves through a symlink.
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-deny-home-")));
    const previousRoot = process.env.SMITHERSBOT_GOALS_ROOT;
    process.env.SMITHERSBOT_GOALS_ROOT = root;
    const mkfile = (filePath: string, body = "secret\n"): string => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, body);
      return filePath;
    };
    try {
      const home = path.join(root, "home");
      const workingDir = path.join(root, "agent", "workspaces", "smithersbot", "repo");

      // Repo: secret env files + safe files + a decoy node_modules subtree.
      mkfile(path.join(workingDir, ".env"));
      const repoEnvLocal = mkfile(path.join(workingDir, ".env.local"));
      const repoEnvStaging = mkfile(path.join(workingDir, ".env.staging"));
      mkfile(path.join(workingDir, ".env.example"), "TOKEN=placeholder\n");
      mkfile(path.join(workingDir, "README.md"), "safe\n");
      mkfile(path.join(workingDir, "node_modules", "pkg", ".env"), "must-not-be-walked\n");

      // Managed private env (workspace name = basename(dirname(workingDir)) = "smithersbot").
      const privateEnv = mkfile(path.join(root, "private", "env", "smithersbot", ".env"));

      // Home credential files across categories.
      const claudeCreds = mkfile(path.join(home, ".claude", ".credentials.json"));
      mkfile(path.join(home, ".claude", "settings.json"));
      const codexAuth = mkfile(path.join(home, ".codex", "auth.json"));
      mkfile(path.join(home, ".codex", "config.toml"));
      const sshKey = mkfile(path.join(home, ".ssh", "id_ed25519"));
      const sshPub = mkfile(path.join(home, ".ssh", "id_ed25519.pub"), "ssh-ed25519 AAAA\n");
      const gpgKeyring = mkfile(path.join(home, ".gnupg", "pubring.kbx"));
      const gpgPrivKey = mkfile(path.join(home, ".gnupg", "private-keys-v1.d", "ABCD.key"));
      const netrc = mkfile(path.join(home, ".netrc"));

      // Legacy `.clawdbot -> .moltbot` symlink: the deny must resolve to the real moltbot
      // target, never the symlink path (bwrap cannot mount over a symlink).
      const moltbotCreds = mkfile(path.join(home, ".moltbot", "clawdbot.json"));
      let symlinkCreated = true;
      try {
        fs.symlinkSync(path.join(home, ".moltbot"), path.join(home, ".clawdbot"));
      } catch {
        symlinkCreated = false;
      }

      // Decoy large tree outside the scan set that must never be walked.
      mkfile(path.join(home, ".cache", "huge", "deep", "secret.json"), "decoy\n");

      const readDirCalls: string[] = [];
      const config = buildClaudeCodeSandboxSettingsConfig({
        workingDir,
        runId: "deny-home",
        purpose: "goal-worker",
        denyReadDeps: {
          homedir: () => home,
          privateRoot: () => path.join(root, "private"),
          // pathExists/realPath/isRegularFile/isDirectory default to real fs (exercising the
          // production defaults); readDir is wrapped only to observe traversal bounds.
          readDir: (dir) => {
            readDirCalls.push(dir);
            return fs.readdirSync(dir);
          },
        },
      });
      const deny = config.settings.sandbox.filesystem.denyRead;

      // Exact existing sensitive regular files are denied (the reliable Bash mechanism),
      // including a discovered `.env.*` variant and a private-keys-v1.d depth-2 key.
      for (const expected of [
        claudeCreds,
        codexAuth,
        sshKey,
        gpgKeyring,
        gpgPrivKey,
        netrc,
        privateEnv,
        repoEnvLocal,
        repoEnvStaging,
      ]) {
        expect(deny).toContain(expected);
      }

      // Directory deny is NOT the only coverage: the ~/.claude dir AND files under it appear.
      expect(deny).toContain(path.join(home, ".claude"));
      expect(deny).toContain(claudeCreds);

      // Safe files stay readable; the public SSH key is not a secret.
      expect(deny).not.toContain(path.join(workingDir, "README.md"));
      expect(deny).not.toContain(path.join(workingDir, ".env.example"));
      expect(deny).not.toContain(sshPub);

      // Nonexistent sensitive path is skipped.
      expect(deny).not.toContain(path.join(home, ".aws", "credentials"));

      // No recursive globs in the filesystem denyRead.
      expect(deny.some((entry) => entry.includes("**"))).toBe(false);

      // Symlinks resolve to the real target; the symlink path is never emitted.
      if (symlinkCreated) {
        expect(deny).toContain(moltbotCreds);
        expect(deny.some((entry) => entry.startsWith(path.join(home, ".clawdbot")))).toBe(false);
      }

      // Bounded traversal: the repo node_modules and the decoy ~/.cache tree are never walked.
      expect(readDirCalls).not.toContain(path.join(workingDir, "node_modules"));
      expect(readDirCalls.some((dir) => dir.includes("node_modules"))).toBe(false);
      expect(readDirCalls.some((dir) => dir.includes(".cache"))).toBe(false);

      // Defense-in-depth Read-tool denies remain.
      const perm = config.settings.permissions.deny;
      expect(perm).toContain(`Read(${repoEnvLocal})`);
      expect(perm).toContain(`Read(${path.join(home, ".codex")}/**)`);
      expect(perm).toContain(`Read(${path.join(home, ".ssh")}/**)`);
    } finally {
      if (previousRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
      else process.env.SMITHERSBOT_GOALS_ROOT = previousRoot;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a structured fail-closed blocker until the live probe is explicitly enabled", () => {
    mockCommandPaths();

    const { workingDir, sandboxRoot } = setupIsolatedSandboxRoots();
    const status = claudeCodeNativeSandboxStatus({
      workingDir,
      runId: "status-test",
      settingsRoot: sandboxRoot,
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
    "SMITHERSBOT_CLAUDE_claude_auth_path=1",
    "SMITHERSBOT_CLAUDE_creds_file=1",
    "",
  ].join("\n");

  it("reports supported only after the live deny/allow matrix passes", () => {
    mockCommandPaths();
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: CLAUDE_MATRIX_PASS_STDOUT,
      stderr: "",
    });

    const { workingDir, sandboxRoot } = setupIsolatedSandboxRoots();
    const status = claudeCodeNativeSandboxStatus({
      workingDir,
      runId: "live-ok",
      settingsRoot: sandboxRoot,
      env: {
        SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES: "1",
        ANTHROPIC_API_KEY: "placeholder-api-key",
        ANTHROPIC_AUTH_TOKEN: "placeholder-auth-token",
        ANTHROPIC_API_KEY_OLD: "placeholder-old-api-key",
        ANTHROPIC_BASE_URL: "https://placeholder.invalid",
      } as NodeJS.ProcessEnv,
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
      expect.objectContaining({
        cwd: workingDir,
        env: expect.not.objectContaining({
          ANTHROPIC_API_KEY: expect.any(String),
          ANTHROPIC_AUTH_TOKEN: expect.any(String),
          ANTHROPIC_API_KEY_OLD: expect.any(String),
          ANTHROPIC_BASE_URL: expect.any(String),
        }),
      }),
    );
    const claudeArgs = mockSpawnSync.mock.calls[0][1] as string[];
    expect(claudeArgs.join(" ")).not.toContain("dangerously-skip-permissions");
    // --bare disables OAuth/subscription auth; the live proof must never use it.
    expect(claudeArgs).not.toContain("--bare");
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
        "SMITHERSBOT_CLAUDE_claude_auth_path=1",
        "SMITHERSBOT_CLAUDE_creds_file=1",
        "",
      ].join("\n"),
      stderr: "",
    });

    const { workingDir, sandboxRoot } = setupIsolatedSandboxRoots();
    const status = claudeCodeNativeSandboxStatus({
      workingDir,
      runId: "deny-leak",
      settingsRoot: sandboxRoot,
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
        "SMITHERSBOT_CLAUDE_claude_auth_path=1",
        "SMITHERSBOT_CLAUDE_creds_file=1",
        "",
      ].join("\n"),
      stderr: "",
    });

    const { workingDir, sandboxRoot } = setupIsolatedSandboxRoots();
    const status = claudeCodeNativeSandboxStatus({
      workingDir,
      runId: "allow-fail",
      settingsRoot: sandboxRoot,
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

    const { workingDir, sandboxRoot } = setupIsolatedSandboxRoots();
    const status = claudeCodeNativeSandboxStatus({
      workingDir,
      runId: "not-logged-in",
      settingsRoot: sandboxRoot,
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
      expect(command).toContain("SMITHERSBOT_CLAUDE_claude_auth_path=$?");
      expect(command).toContain("cat ~/.claude/settings.json >/dev/null 2>&1");
      // Credential store is checked explicitly (covered by the ~/.claude dir deny).
      expect(command).toContain("SMITHERSBOT_CLAUDE_creds_file=$?");
      expect(command).toContain("cat ~/.claude/.credentials.json >/dev/null 2>&1");
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

  it("uses an explicit Claude settings root or the Codex writable memory root when available", () => {
    const codexHome = fs.mkdtempSync(path.join(HOST_TEMP_ROOT, "codex-home-"));
    const memories = path.join(codexHome, "memories");
    fs.mkdirSync(memories, { recursive: true });
    try {
      expect(
        resolveClaudeCodeSandboxSettingsRoot({
          SMITHERSBOT_CLAUDE_SANDBOX_SETTINGS_ROOT: "/tmp/explicit-claude-settings",
          CODEX_HOME: codexHome,
        } as NodeJS.ProcessEnv),
      ).toBe("/tmp/explicit-claude-settings");
      expect(
        resolveClaudeCodeSandboxSettingsRoot({ CODEX_HOME: codexHome } as NodeJS.ProcessEnv),
      ).toBe(memories);
      expect(resolveClaudeCodeSandboxSettingsRoot({} as NodeJS.ProcessEnv)).toBe("/var/tmp");
    } finally {
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("classifies the known bwrap /newroot/libx32 startup failure with an operator command", () => {
    mockCommandPaths();
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "bwrap: Can't mount tmpfs on /newroot/libx32: No such file or directory\n",
    });

    const { workingDir, sandboxRoot } = setupIsolatedSandboxRoots();
    const status = claudeCodeNativeSandboxStatus({
      workingDir,
      runId: "libx32-fail",
      settingsRoot: sandboxRoot,
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

    const { workingDir, sandboxRoot: settingsRoot } = setupIsolatedSandboxRoots();
    try {
      const report = runClaudeSubscriptionAuthDifferentialProbes({
        workingDir,
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
        // --bare disables OAuth/subscription auth; no probe may use it.
        expect(args).not.toContain("--bare");
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

    const { workingDir, sandboxRoot: settingsRoot } = setupIsolatedSandboxRoots();
    try {
      const report = runClaudeSubscriptionAuthDifferentialProbes({
        workingDir,
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
