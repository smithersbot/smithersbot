import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCliArgs, writeDenyFile } from "./cli-worker.js";
import {
  buildSandboxProbeCases,
  buildSandboxProbePrompt,
  classifyBackendProbeReadiness,
  cleanupSandboxProbeFixture,
  createSandboxProbeFixture,
  isLiveSandboxProbeEnabled,
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
      "repo env local",
      "bash managed private env",
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

      expect(args).toContain("--sandbox");
      expect(args).toContain("workspace-write");
      expect(args).toContain("--cd");
      expect(args).toContain(fixture.repoDir);
      expect(args).toContain(`sandbox_workspace_write.writable_roots=["${fixture.repoDir}/.git"]`);
      expect(args.join(" ")).not.toContain("danger-full-access");
      expect(args.join(" ")).not.toContain("dangerously-bypass");
      expect(args.at(-1)).toContain("DENIED managed private env");
      expect(args.at(-1)).toContain("ALLOWED agent history search");
    } finally {
      if (previousRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
      else process.env.SMITHERSBOT_GOALS_ROOT = previousRoot;
    }
  });

  it("marks Claude Code goal-worker sandbox probes unproven because no native fs sandbox is configured", () => {
    const readiness = classifyBackendProbeReadiness("claude_code");
    if (isLiveSandboxProbeEnabled()) {
      expect(readiness.status).toBe("unproven");
      expect(readiness.reason).toMatch(/no native filesystem sandbox/i);
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
    async () => {
      const result = await runGoalWorkerSandboxLiveProbe("codex");
      expect(result.status).toBe("proven");
    },
    150_000,
  );
});
