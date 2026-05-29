import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCodexRepoChatArgs, runRepoChatWorker } from "./repo-chat-worker.js";
import {
  buildClaudeCodeSandboxSettingsConfig,
  buildCodexNativeSandboxConfig,
} from "../goal/backend-sandbox.js";
import { checkPathDeny } from "../goal/hard-deny.js";
import { SECRET_PATH_DENY_REASON } from "../security/secret-paths.js";
import { validateConfigObject } from "../config/config.js";
import {
  buildSandboxProbePrompt,
  classifyBackendProbeReadiness,
  cleanupSandboxProbeFixture,
  createSandboxProbeFixture,
  isCommandAvailable,
  isLiveSandboxProbeEnabled,
  PROBE_HOME_CONFIG_SENTINEL,
  SANDBOX_LIVE_PROBES_ENV,
  type SandboxProbeFixture,
} from "../goal/sandbox-probes.js";

let fixture: SandboxProbeFixture | undefined;

afterEach(() => {
  if (fixture) cleanupSandboxProbeFixture(fixture);
  fixture = undefined;
});

describe("repo-chat sandbox live probes", () => {
  it("creates a schema-valid home config fixture and a real git repo for the probe", () => {
    fixture = createSandboxProbeFixture("smithersbot-repo-chat-sandbox-probe-");

    const parsedConfig: unknown = JSON.parse(
      fs.readFileSync(fixture.fakeSmithersbotConfig, "utf8"),
    );
    const validation = validateConfigObject(parsedConfig);
    expect(validation.ok).toBe(true);
    expect(JSON.stringify(parsedConfig)).toContain(PROBE_HOME_CONFIG_SENTINEL);

    if (isCommandAvailable("git")) {
      expect(fs.existsSync(path.join(fixture.repoDir, ".git", "HEAD"))).toBe(true);
      expect(() =>
        execFileSync("git", ["-C", fixture.repoDir, "diff", "--stat"], { stdio: "ignore" }),
      ).not.toThrow();
    }
  });

  it("threads probe prompts through the normal Codex repo-chat read-only sandbox args", () => {
    fixture = createSandboxProbeFixture("smithersbot-repo-chat-sandbox-probe-");
    const previousRoot = process.env.SMITHERSBOT_GOALS_ROOT;
    process.env.SMITHERSBOT_GOALS_ROOT = fixture.managedRoot;
    try {
      const prompt = buildSandboxProbePrompt(fixture);
      const args = buildCodexRepoChatArgs({
        prompt,
        workingDir: fixture.repoDir,
      });

      expect(args).not.toContain("--sandbox");
      expect(args).not.toContain("read-only");
      expect(args).not.toContain("workspace-write");
      expect(args).toContain("--cd");
      expect(args).toContain(fixture.agentRoot);
      expect(args.join(" ")).not.toContain("danger-full-access");
      expect(args.join(" ")).not.toContain("dangerously-bypass");
      expect(args.at(-1)).toContain("DENIED managed private env");
      expect(args.at(-1)).toContain("ALLOWED agent history search");
    } finally {
      if (previousRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
      else process.env.SMITHERSBOT_GOALS_ROOT = previousRoot;
    }
  });

  it("reports Claude Code repo-chat live probe readiness without faking success", () => {
    const readiness = classifyBackendProbeReadiness("claude_code");
    if (isLiveSandboxProbeEnabled()) {
      // Claude readiness is environment-dependent (CLI present, bwrap/socat, the
      // live-probe flag): proven only when the live deny/allow matrix passes,
      // otherwise unproven. It must never report not-run once probes are enabled.
      expect(["proven", "unproven"]).toContain(readiness.status);
    } else {
      expect(readiness.status).toBe("not-run");
      expect(readiness.reason).toContain(SANDBOX_LIVE_PROBES_ENV);
    }
  });

  it("reports Codex repo-chat live probe readiness without faking success", () => {
    const readiness = classifyBackendProbeReadiness("codex");
    if (isLiveSandboxProbeEnabled()) {
      expect(["proven", "unproven"]).toContain(readiness.status);
    } else {
      expect(readiness).toEqual({
        backend: "codex",
        status: "not-run",
        reason: `Set ${SANDBOX_LIVE_PROBES_ENV}=1 to run live native backend sandbox probes.`,
      });
    }
  });

  it.runIf(
    isLiveSandboxProbeEnabled() && classifyBackendProbeReadiness("codex").status === "proven",
  )(
    "runs the live Codex repo-chat sandbox probe when explicitly enabled",
    async () => {
      fixture = createSandboxProbeFixture("smithersbot-repo-chat-live-sandbox-probe-");
      const previousRoot = process.env.SMITHERSBOT_GOALS_ROOT;
      const previousHome = process.env.HOME;
      process.env.SMITHERSBOT_GOALS_ROOT = fixture.managedRoot;
      process.env.HOME = fixture.fakeHomeDir;
      try {
        const readiness = classifyBackendProbeReadiness("codex");
        expect(readiness.status).toBe("proven");
        const result = await runRepoChatWorker({
          backend: "codex",
          prompt: buildSandboxProbePrompt(fixture),
          workingDir: fixture.repoDir,
          timeoutMs: 120_000,
        });
        expect(result.text).toMatch(/pass|proven|sandbox/i);
      } finally {
        if (previousRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
        else process.env.SMITHERSBOT_GOALS_ROOT = previousRoot;
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }
    },
    150_000,
  );
});

describe("observed dev surface sandbox read roots", () => {
  let home: string;
  let devManagedRoot: string;
  let devAgentRoot: string;
  let devPrivateRoot: string;
  let devStateDir: string;
  let devWorkspace: string;
  let devSecretEnv: string;
  let previousObserved: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "observed-sandbox-"));
    vi.spyOn(os, "homedir").mockReturnValue(home);
    devManagedRoot = path.join(home, "smithersbot-dev-home");
    devAgentRoot = path.join(devManagedRoot, "agent");
    devPrivateRoot = path.join(devManagedRoot, "private");
    devStateDir = path.join(home, ".smithersbot-dev");
    devWorkspace = path.join(devAgentRoot, "workspaces", "smithersbot-dev");
    for (const dir of [
      devWorkspace,
      path.join(devAgentRoot, "history", "goals"),
      path.join(devPrivateRoot, "env", "ws"),
      devStateDir,
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    devSecretEnv = path.join(devPrivateRoot, "env", "ws", ".env");
    fs.writeFileSync(devSecretEnv, "TELEGRAM_BOT_TOKEN=should-never-be-read\n");
    fs.writeFileSync(path.join(devStateDir, "smithersbot.json"), "{}\n");
    previousObserved = process.env.SMITHERSBOT_OBSERVED_INSTANCES;
    process.env.SMITHERSBOT_OBSERVED_INSTANCES = "dev";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousObserved === undefined) delete process.env.SMITHERSBOT_OBSERVED_INSTANCES;
    else process.env.SMITHERSBOT_OBSERVED_INSTANCES = previousObserved;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("Claude sandbox read roots include the observed agent root but never private/state", () => {
    const config = buildClaudeCodeSandboxSettingsConfig({
      workingDir: devWorkspace,
      runId: "observed-claude",
      purpose: "repo-chat",
      settingsRoot: path.join(home, "claude-settings"),
    });
    const { allowRead, denyRead } = config.settings.sandbox.filesystem;

    expect(allowRead).toContain(devAgentRoot);
    expect(allowRead).toContain(devWorkspace);
    expect(allowRead).not.toContain(devPrivateRoot);
    expect(allowRead).not.toContain(devStateDir);
    // No allowed read root may sit inside the observed private root or state dir.
    for (const root of allowRead) {
      expect(root.startsWith(devPrivateRoot)).toBe(false);
      expect(root.startsWith(devStateDir)).toBe(false);
    }

    // Private/state are sealed via deny entries (defense-in-depth + exact files).
    expect(denyRead).toContain(fs.realpathSync(devPrivateRoot));
    expect(denyRead).toContain(fs.realpathSync(devStateDir));
    expect(denyRead).toContain(fs.realpathSync(devSecretEnv));
    expect(config.settings.permissions.deny).toContain(
      `Read(${fs.realpathSync(devPrivateRoot)}/**)`,
    );
    expect(config.settings.permissions.deny).toContain(`Read(${fs.realpathSync(devStateDir)}/**)`);
  });

  it("Codex sandbox read roots include the observed agent root and deny private/state", () => {
    const config = buildCodexNativeSandboxConfig({
      workingDir: devWorkspace,
      runId: "observed-codex",
      purpose: "repo-chat",
      codexPath: "codex",
      sandboxRoot: path.join(home, "codex-sandbox"),
    });

    expect(config.executionRoot).toBe(devAgentRoot);
    expect(config.allowedReadPaths).toContain(devAgentRoot);
    expect(config.allowedReadPaths).toContain(devWorkspace);
    expect(config.allowedReadPaths).not.toContain(devPrivateRoot);
    expect(config.allowedReadPaths).not.toContain(devStateDir);

    expect(config.deniedReadPaths).toContain(devPrivateRoot);
    expect(config.deniedReadPaths).toContain(devStateDir);
    // The denied roots are present in the generated permission profile TOML.
    expect(config.configToml).toContain(devPrivateRoot);
    expect(config.configToml).toContain(devStateDir);
  });

  it("refuses to build a sandbox for an observed private/state target", () => {
    expect(() =>
      buildClaudeCodeSandboxSettingsConfig({
        workingDir: path.join(devPrivateRoot, "env", "ws"),
        runId: "observed-private",
        purpose: "repo-chat",
        settingsRoot: path.join(home, "claude-settings"),
      }),
    ).toThrow(/private paths/);

    expect(() =>
      buildCodexNativeSandboxConfig({
        workingDir: devStateDir,
        runId: "observed-state",
        purpose: "repo-chat",
        codexPath: "codex",
        sandboxRoot: path.join(home, "codex-sandbox"),
      }),
    ).toThrow(/private paths/);
  });

  it("denies stable-worker enumeration and content reads of the dev private roots via hard-deny", () => {
    // os.homedir() is mocked to `home`, so the static deny policy (used by the
    // stable worker / repo-chat path check) resolves the dev-instance private
    // roots under the fixture home. Child enumeration (ls / find) and content
    // reads must be blocked.
    expect(checkPathDeny(devSecretEnv)?.reason).toBe(SECRET_PATH_DENY_REASON);
    expect(checkPathDeny(path.join(devPrivateRoot, "env"))?.reason).toBe(SECRET_PATH_DENY_REASON);
    expect(checkPathDeny(path.join(devPrivateRoot, "config"))?.reason).toBe(
      SECRET_PATH_DENY_REASON,
    );
    expect(checkPathDeny(path.join(devPrivateRoot, "auth"))?.reason).toBe(SECRET_PATH_DENY_REASON);
    expect(checkPathDeny(path.join(devPrivateRoot, "sessions"))?.reason).toBe(
      SECRET_PATH_DENY_REASON,
    );
    expect(checkPathDeny(path.join(devStateDir, "smithersbot.json"))?.reason).toBe(
      SECRET_PATH_DENY_REASON,
    );

    // Exact-path metadata of the known roots remains visible (ls -ld is allowed).
    expect(checkPathDeny(devPrivateRoot)).toBeNull();
    expect(checkPathDeny(devStateDir)).toBeNull();

    // The dev agent-visible surface stays inspectable.
    expect(checkPathDeny(devAgentRoot)).toBeNull();
    expect(checkPathDeny(devWorkspace)).toBeNull();
    expect(checkPathDeny(path.join(devAgentRoot, "history"))).toBeNull();
  });

  it("leaves the current process's own surface unchanged without opt-in", () => {
    delete process.env.SMITHERSBOT_OBSERVED_INSTANCES;
    const config = buildCodexNativeSandboxConfig({
      workingDir: devWorkspace,
      runId: "no-optin",
      purpose: "repo-chat",
      codexPath: "codex",
      sandboxRoot: path.join(home, "codex-sandbox"),
    });
    // No opt-in: dev paths are not observed, so the dev private/state are NOT added
    // to the deny list and the dev agent root is not the read-scoped execution root.
    expect(config.deniedReadPaths).not.toContain(devPrivateRoot);
    expect(config.deniedReadPaths).not.toContain(devStateDir);
    expect(config.executionRoot).toBe(devWorkspace);
  });
});
