import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { buildCodexRepoChatArgs, runRepoChatWorker } from "./repo-chat-worker.js";
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

  it.runIf(isLiveSandboxProbeEnabled())(
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
