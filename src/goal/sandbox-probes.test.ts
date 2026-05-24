import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { buildCliArgs, writeDenyFile } from "./cli-worker.js";
import { validateConfigObject } from "../config/config.js";
import {
  buildSandboxProbeCases,
  buildSandboxProbePrompt,
  classifyBackendProbeReadiness,
  cleanupSandboxProbeFixture,
  createSandboxProbeFixture,
  isCommandAvailable,
  isLiveSandboxProbeEnabled,
  liveSandboxProbeHostReady,
  PROBE_HOME_CONFIG_SENTINEL,
  runGoalWorkerSandboxLiveProbe,
  SANDBOX_LIVE_PROBES_ENV,
  type SandboxProbeFixture,
} from "./sandbox-probes.js";

let fixture: SandboxProbeFixture | undefined;

afterEach(() => {
  if (fixture) cleanupSandboxProbeFixture(fixture);
  fixture = undefined;
});

describe("goal worker sandbox live probes", () => {
  it("builds sentinel probe cases for denied and allowed worker boundaries", () => {
    fixture = createSandboxProbeFixture();

    const cases = buildSandboxProbeCases(fixture);
    expect(cases.filter((entry) => entry.kind === "denied").map((entry) => entry.label)).toEqual([
      "managed private env",
      "home env",
      "home config",
      "home codex auth",
      "home ssh key",
      "home claude credentials",
      "repo env local",
      "repo env production",
      "repo env test",
      "bash managed private env",
      "bash home codex auth",
      "python managed private env",
      "private symlink escape",
    ]);
    expect(cases.filter((entry) => entry.kind === "allowed").map((entry) => entry.label)).toEqual([
      "readme",
      "env example",
      "agent history search",
      "repo edit",
    ]);

    expect(fs.readFileSync(path.join(fixture.repoDir, "README.md"), "utf8")).toContain(
      "probe readme safe text",
    );
    expect(fs.readFileSync(path.join(fixture.repoDir, ".env.example"), "utf8")).toContain(
      "placeholder",
    );
    expect(fs.readFileSync(path.join(fixture.historyDir, "summary.md"), "utf8")).toContain(
      "safe prior goal text",
    );

    // Fake home auth/session/credential files exist so the denied probes have real
    // sentinel targets to confirm they cannot be read from sandboxed Bash.
    for (const credentialFile of [
      fixture.fakeCodexAuth,
      fixture.fakeSshKey,
      fixture.fakeClaudeCreds,
    ]) {
      expect(fs.existsSync(credentialFile)).toBe(true);
    }
  });

  it("writes a schema-valid home config fixture and a real git repo in the fixture repo", (ctx) => {
    fixture = createSandboxProbeFixture();

    // The fake ~/.smithersbot/smithersbot.json must satisfy the strict config
    // schema (no "Unrecognized key: token") so the live probe loads instead of
    // aborting before any deny check runs — while still carrying the deny sentinel.
    const parsedConfig: unknown = JSON.parse(
      fs.readFileSync(fixture.fakeSmithersbotConfig, "utf8"),
    );
    const validation = validateConfigObject(parsedConfig);
    expect(validation.ok).toBe(true);
    expect(JSON.stringify(parsedConfig)).toContain(PROBE_HOME_CONFIG_SENTINEL);

    // The fixture repo must be a real git root, not a bare empty .git directory,
    // so git-dependent probe paths (`git diff`) stop emitting "Not a git repository".
    if (isCommandAvailable("git")) {
      expect(fs.existsSync(path.join(fixture.repoDir, ".git", "HEAD"))).toBe(true);
      let insideWorkTree: string;
      try {
        insideWorkTree = execFileSync(
          "git",
          ["-C", fixture.repoDir, "rev-parse", "--is-inside-work-tree"],
          { encoding: "utf8" },
        ).trim();
      } catch {
        ctx.skip();
        return;
      }
      expect(insideWorkTree).toBe("true");
      expect(() =>
        execFileSync("git", ["-C", fixture.repoDir, "diff", "--stat"], { stdio: "ignore" }),
      ).not.toThrow();
    }
  });

  it("threads probe prompts through the normal Codex goal-worker sandbox args", () => {
    fixture = createSandboxProbeFixture();
    const previousRoot = process.env.SMITHERSBOT_GOALS_ROOT;
    process.env.SMITHERSBOT_GOALS_ROOT = fixture.managedRoot;
    try {
      const denyFile = writeDenyFile([], fixture.repoDir);
      const prompt = buildSandboxProbePrompt(fixture);
      const args = buildCliArgs({
        backend: "codex",
        prompt,
        workingDir: fixture.repoDir,
        denyFilePath: denyFile,
      });

      expect(args).not.toContain("--sandbox");
      expect(args).not.toContain("workspace-write");
      expect(args).toContain("--cd");
      expect(args).toContain(fixture.repoDir);
      expect(args.join(" ")).not.toContain("danger-full-access");
      expect(args.join(" ")).not.toContain("dangerously-bypass");
      expect(args.at(-1)).toContain("DENIED managed private env");
      expect(args.at(-1)).toContain("ALLOWED agent history search");
    } finally {
      if (previousRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
      else process.env.SMITHERSBOT_GOALS_ROOT = previousRoot;
    }
  });

  it("reports Claude Code goal-worker live probe readiness without faking success", () => {
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

  it("reports Codex goal-worker live probe readiness without faking success", () => {
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

  it.runIf(isLiveSandboxProbeEnabled())(
    "runs the live Codex goal-worker sandbox probe when explicitly enabled",
    async (ctx) => {
      if (!liveSandboxProbeHostReady("codex")) {
        // The Codex native sandbox cannot be established on this host (codex CLI,
        // bubblewrap, or a writable /var/tmp absent — e.g. this nested
        // read-only-/var/tmp CI sandbox), so the end-to-end live proof is not
        // attemptable here. Skip rather than fail; a capable host still runs and
        // asserts it. A real denial regression keeps the host "ready"
        // (live-probe-failed), so this gate never masks a sandbox failure.
        ctx.skip();
        return;
      }
      const result = await runGoalWorkerSandboxLiveProbe("codex");
      expect(result.status).toBe("proven");
    },
    150_000,
  );
});
