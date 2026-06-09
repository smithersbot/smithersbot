import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanParseError } from "./planner.js";
import {
  buildCachedScoutSummary,
  buildAgentVisibleWikiDir,
  buildPlanningPrompt,
  buildPlanRevisionPrompt,
  CLAUDE_ALLOWED_TOOLS,
  runCliPlanning,
  runCliPlanRevision,
  EXECUTION_PLAN_FILE,
  GOAL_BRIEF_FILE,
} from "./cli-planner.js";
import { DEV_GATEWAY_PLANNER_GUIDANCE } from "../prompts/planner/system-prompt.js";
import { resolveAgentHistoryEventsPath } from "./agent-history-events.js";
import * as runtimeMirror from "./runtime-mirror.js";
import { SCOUT_NEEDS_DECISION_FILE, validateScoutOutput } from "./scout.js";
import {
  NO_WORKER_BACKEND_ERROR,
  requireEffectiveEnabledWorkers,
  resolveDefaultPlanAutocheckMode,
  resolveEffectiveEnabledWorkers,
} from "./effective-workers.js";
import { resolveStoredGoalBriefPath } from "./goal-brief.js";
import { PENDING_WORKSPACE_SLUG } from "./history-anchor.js";
import type { Plan } from "./types.js";

const mockRunCliProcess = vi.fn();
vi.mock("./cli-process.js", () => ({
  runCliProcess: (...args: unknown[]) => mockRunCliProcess(...args),
}));

const mockResolveClaudeBinary = vi.fn();
vi.mock("./scout.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./scout.js")>();
  return {
    ...actual,
    resolveClaudeBinary: (...args: unknown[]) => mockResolveClaudeBinary(...args),
  };
});

const mockGetCodexAskForApprovalPlacement = vi.fn(() => "unsupported" as const);
const mockDetectBackendAvailability = vi.fn(() => [
  { id: "pi", available: true },
  { id: "codex", available: true },
  { id: "claude_code", available: true },
]);
vi.mock("./backend-availability.js", () => ({
  detectBackendAvailability: () => mockDetectBackendAvailability(),
  getCodexAskForApprovalPlacement: () => mockGetCodexAskForApprovalPlacement(),
}));

vi.mock("./backend-sandbox.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./backend-sandbox.js")>();
  const fs = await import("node:fs");

  const buildCodexNativeSandboxConfig = vi.fn(
    (params: Parameters<typeof actual.buildCodexNativeSandboxConfig>[0]) =>
      actual.buildCodexNativeSandboxConfig({
        ...params,
        codexPath: params.codexPath ?? "codex",
      }),
  );

  const writeCodexNativeSandboxConfig = vi.fn(
    (params: Parameters<typeof actual.writeCodexNativeSandboxConfig>[0]) => {
      const config = buildCodexNativeSandboxConfig(params);
      fs.mkdirSync(config.helperDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(config.configPath, config.configToml, {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.writeFileSync(config.helperPath, '#!/bin/sh\nexec codex "$@"\n', {
        encoding: "utf8",
        mode: 0o700,
      });
      try {
        if (
          config.authSourcePath !== config.authReferencePath &&
          fs.existsSync(config.authSourcePath)
        ) {
          fs.rmSync(config.authReferencePath, { force: true });
          fs.symlinkSync(config.authSourcePath, config.authReferencePath);
        }
      } catch {
        // Mirrors production's best-effort auth reference behavior.
      }
      return config;
    },
  );

  return {
    ...actual,
    buildCodexNativeSandboxConfig,
    writeCodexNativeSandboxConfig,
  };
});

const FORBIDDEN_AGENT_ENV_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "SMITHERSBOT_GATEWAY_TOKEN",
  "CLAWDBOT_GATEWAY_TOKEN",
  "MOLTBOT_GATEWAY_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY_OLD",
  "OPENAI_API_KEY",
  "GITHUB_TOKEN",
] as const;

function seedForbiddenAgentEnv(): Partial<
  Record<(typeof FORBIDDEN_AGENT_ENV_KEYS)[number], string>
> {
  const previous: Partial<Record<(typeof FORBIDDEN_AGENT_ENV_KEYS)[number], string>> = {};
  for (const key of FORBIDDEN_AGENT_ENV_KEYS) {
    previous[key] = process.env[key];
    process.env[key] = `secret-${key}`;
  }
  return previous;
}

function restoreForbiddenAgentEnv(
  previous: Partial<Record<(typeof FORBIDDEN_AGENT_ENV_KEYS)[number], string>>,
): void {
  for (const key of FORBIDDEN_AGENT_ENV_KEYS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
}

function expectForbiddenAgentEnvAbsent(env: Record<string, string | undefined>): void {
  for (const key of FORBIDDEN_AGENT_ENV_KEYS) {
    expect(env[key]).toBeUndefined();
  }
}

function sectionBetween(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(endMarker, start + startMarker.length);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

function expectComputerBasedCapabilityFraming(text: string): void {
  expect(text).toContain("full user-requested outcome");
  expect(text).toContain("broad, real-world, long-running");
  expect(text).toContain("not fully observable by SmithersBot");
  expect(text).toContain("do not shrink");
  expect(text).toContain("only what SmithersBot can finish on a computer");
  expect(text).toContain(
    "computer-based work, including software, research, writing, analysis, automation, repo work, workflow automation, structured planning",
  );
}

function expectNoSoftwareOnlyLimitingFraming(text: string): void {
  expect(text).not.toMatch(
    /autonomous coding agent|coding-agent|coding agent|software-only|software only|software tasks|coding tasks/i,
  );
}

describe("CLAUDE_ALLOWED_TOOLS", () => {
  it("does not grant the planner the Write tool", () => {
    const tools = CLAUDE_ALLOWED_TOOLS.split(",").map((t) => t.trim());
    expect(tools).not.toContain("Write");
  });
});

describe("resolveEffectiveEnabledWorkers", () => {
  it("uses Codex only when Codex is the only available backend", () => {
    expect(
      resolveEffectiveEnabledWorkers({
        availability: [
          { id: "pi", available: true },
          { id: "codex", available: true },
          { id: "claude_code", available: false, reason: "not found" },
        ],
      }),
    ).toEqual(["codex"]);
  });

  it("uses Claude Code only when Claude Code is the only available backend", () => {
    expect(
      resolveEffectiveEnabledWorkers({
        availability: [
          { id: "pi", available: true },
          { id: "codex", available: false, reason: "not found" },
          { id: "claude_code", available: true },
        ],
      }),
    ).toEqual(["claude_code"]);
  });

  it("keeps both workers when both backends are available", () => {
    expect(
      resolveEffectiveEnabledWorkers({
        availability: [
          { id: "pi", available: true },
          { id: "codex", available: true },
          { id: "claude_code", available: true },
        ],
      }),
    ).toEqual(["claude_code", "codex"]);
  });

  it("returns no workers and raises the canonical setup error when neither backend is available", () => {
    const availability = [
      { id: "pi", available: true },
      { id: "codex", available: false, reason: "not found" },
      { id: "claude_code", available: false, reason: "not found" },
    ] as const;

    expect(resolveEffectiveEnabledWorkers({ availability: [...availability] })).toEqual([]);
    expect(() => requireEffectiveEnabledWorkers({ availability: [...availability] })).toThrow(
      NO_WORKER_BACKEND_ERROR,
    );
  });
});

describe("resolveDefaultPlanAutocheckMode", () => {
  it("prefers codex when Codex is available", () => {
    expect(
      resolveDefaultPlanAutocheckMode([
        { id: "pi", available: true },
        { id: "codex", available: true },
        { id: "claude_code", available: true },
      ]),
    ).toBe("codex");
  });

  it("returns codex when only Codex is available", () => {
    expect(
      resolveDefaultPlanAutocheckMode([
        { id: "pi", available: true },
        { id: "codex", available: true },
        { id: "claude_code", available: false, reason: "not found" },
      ]),
    ).toBe("codex");
  });

  it("returns claude_code when only Claude Code is available", () => {
    expect(
      resolveDefaultPlanAutocheckMode([
        { id: "pi", available: true },
        { id: "codex", available: false, reason: "not found" },
        { id: "claude_code", available: true },
      ]),
    ).toBe("claude_code");
  });

  it("returns undefined when neither worker backend is available", () => {
    expect(
      resolveDefaultPlanAutocheckMode([
        { id: "pi", available: true },
        { id: "codex", available: false, reason: "not found" },
        { id: "claude_code", available: false, reason: "not found" },
      ]),
    ).toBeUndefined();
  });

  it("probes backend availability when none is provided", () => {
    mockDetectBackendAvailability.mockReturnValueOnce([
      { id: "pi", available: true },
      { id: "codex", available: false, reason: "not found" },
      { id: "claude_code", available: true },
    ]);
    expect(resolveDefaultPlanAutocheckMode()).toBe("claude_code");
    expect(mockDetectBackendAvailability).toHaveBeenCalledTimes(1);
  });
});

function goalBriefPathForRun(runId: string): string {
  return path.join(buildAgentVisibleWikiDir(runId, PENDING_WORKSPACE_SLUG), GOAL_BRIEF_FILE);
}

function writeGoalBriefForRun(runId: string, text = "# Goal Summary\n\nTest goal brief\n"): string {
  const briefPath = goalBriefPathForRun(runId);
  fs.mkdirSync(path.dirname(briefPath), { recursive: true });
  fs.writeFileSync(briefPath, text, "utf8");
  return briefPath;
}

function writeScoutArtifacts(
  scoutDir: string,
  goalId: string,
  options: { goalBrief?: boolean } = {},
): void {
  fs.mkdirSync(path.join(scoutDir, "node_specs"), { recursive: true });

  fs.writeFileSync(
    path.join(scoutDir, "plan_draft.md"),
    [
      "BEGIN_PLAN_DRAFT",
      `GOAL_ID: ${goalId}`,
      "",
      "graph TD",
      '  analyze-repo["Analyze repo"]',
      "",
      "END_PLAN_DRAFT",
    ].join("\n"),
    "utf8",
  );

  fs.writeFileSync(
    path.join(scoutDir, "scout_report.json"),
    JSON.stringify(
      {
        goal_id: goalId,
        nodes: [
          {
            id: "analyze-repo",
            type: "Impl",
            objective: "Analyze repository structure",
            verification: "pnpm test src/commands/goal.test.ts",
            effort: 2,
            risk: 1,
            uncertainty: 1,
          },
        ],
        edges: [],
      },
      null,
      2,
    ),
    "utf8",
  );

  fs.writeFileSync(
    path.join(scoutDir, "node_specs", "analyze-repo.md"),
    [
      `GOAL_ID: ${goalId}`,
      "Type: Impl",
      "Objective: Analyze repository structure",
      "",
      "Requirements:",
      "1. Inspect relevant files",
      "",
      "Constraints:",
      "- Keep behavior unchanged",
      "",
      "Verification: pnpm test src/commands/goal.test.ts",
    ].join("\n"),
    "utf8",
  );

  if (options.goalBrief !== false) {
    writeGoalBriefForRun(goalId);
  }
}

function writeNeedsDecisionArtifact(
  scoutDir: string,
  decisions = [
    {
      id: "deployment-target",
      question: "Which deployment target should this use?",
      options: [
        { key: "A", label: "Staging", recommended: true },
        { key: "B", label: "Production" },
      ],
    },
  ],
): void {
  fs.writeFileSync(
    path.join(scoutDir, SCOUT_NEEDS_DECISION_FILE),
    JSON.stringify({ version: 1, decisions }, null, 2),
    "utf8",
  );
}

function readPlannerHistoryEvents(
  runId: string,
  workspaceSlug = PENDING_WORKSPACE_SLUG,
): Record<string, unknown>[] {
  const eventsPath = resolveAgentHistoryEventsPath({
    kind: "goal",
    workspaceName: workspaceSlug,
    goalId: runId,
  });
  return fs
    .readFileSync(eventsPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("buildPlanningPrompt dev-gateway guidance gating", () => {
  // Literal paths: only a checkout whose path includes the smithersbot-dev
  // workspace segment is the dev checkout. Guidance is gated on the cwd and
  // never flips runtime instance config.
  const DEV_CWD = "/tmp/agent/workspaces/smithersbot-dev/repo";
  const NON_DEV_CWD = "/tmp/agent/workspaces/smithersbot/repo";
  const DEV_CAPS_ENV = "SMITHERSBOT_DEV_CAPS";

  function withDevCapsEnv<T>(value: string | undefined, fn: () => T): T {
    const previous = process.env[DEV_CAPS_ENV];
    if (value === undefined) delete process.env[DEV_CAPS_ENV];
    else process.env[DEV_CAPS_ENV] = value;
    try {
      return fn();
    } finally {
      if (previous === undefined) delete process.env[DEV_CAPS_ENV];
      else process.env[DEV_CAPS_ENV] = previous;
    }
  }

  function planOnlyPrompt(
    cwd: string,
    goalConfig?: Parameters<typeof buildPlanningPrompt>[0]["goalConfig"],
  ): string {
    return buildPlanningPrompt({
      runId: "run-dev-guidance",
      goalText: "Change gateway restart behavior",
      cwd,
      scoutDir: "/tmp/unused-scout-dir",
      includeScoutArtifacts: false,
      enabledWorkers: ["claude_code", "codex"],
      ...(goalConfig ? { goalConfig } : {}),
    });
  }

  function fullPlanningPrompt(
    cwd: string,
    goalConfig?: Parameters<typeof buildPlanningPrompt>[0]["goalConfig"],
  ): string {
    return buildPlanningPrompt({
      runId: "run-dev-guidance",
      goalText: "Change gateway restart behavior",
      cwd,
      scoutDir: "/tmp/unused-scout-dir",
      includeScoutArtifacts: true,
      enabledWorkers: ["claude_code", "codex"],
      ...(goalConfig ? { goalConfig } : {}),
    });
  }

  function revisionPrompt(
    cwd: string,
    goalConfig?: Parameters<typeof buildPlanRevisionPrompt>[0]["goalConfig"],
  ): string {
    const currentPlan: Plan = {
      goal: "Change gateway restart behavior",
      workingDir: cwd,
      summary: "Current plan",
      steps: [
        {
          id: "edit-restart",
          description: "Update restart resolver and verify with a focused test",
          dependsOn: [],
          status: "pending",
          durationMinutes: 10,
          backend: "codex",
        },
      ],
    };
    return buildPlanRevisionPrompt({
      goalText: "Change gateway restart behavior",
      currentPlan,
      cwd,
      editInstructions: "Tighten the dev-gateway verification step",
      enabledWorkers: ["claude_code", "codex"],
      ...(goalConfig ? { goalConfig } : {}),
    });
  }

  it("omits dev-gateway guidance for the smithersbot-dev checkout by default", () => {
    expect(planOnlyPrompt(DEV_CWD)).not.toContain(DEV_GATEWAY_PLANNER_GUIDANCE);
    expect(fullPlanningPrompt(DEV_CWD)).not.toContain("DEV GATEWAY VERIFICATION");
  });

  it("omits dev-gateway guidance for non-dev checkouts", () => {
    expect(planOnlyPrompt(NON_DEV_CWD)).not.toContain("DEV GATEWAY VERIFICATION");
  });

  it("omits dev-gateway guidance when goal config turns dev capabilities off", () => {
    expect(planOnlyPrompt(DEV_CWD, { devCapabilities: "off" })).not.toContain(
      DEV_GATEWAY_PLANNER_GUIDANCE,
    );
    expect(fullPlanningPrompt(DEV_CWD, { devCapabilities: "off" })).not.toContain(
      DEV_GATEWAY_PLANNER_GUIDANCE,
    );
  });

  it("omits dev-gateway guidance when the env kill switch is off", () => {
    withDevCapsEnv("off", () => {
      expect(planOnlyPrompt(DEV_CWD)).not.toContain(DEV_GATEWAY_PLANNER_GUIDANCE);
      expect(fullPlanningPrompt(DEV_CWD)).not.toContain(DEV_GATEWAY_PLANNER_GUIDANCE);
    });
  });

  it("applies default and off dev-gateway guidance gates to revision prompts", () => {
    expect(revisionPrompt(DEV_CWD)).not.toContain(DEV_GATEWAY_PLANNER_GUIDANCE);
    expect(revisionPrompt(DEV_CWD, { devCapabilities: "off" })).not.toContain(
      DEV_GATEWAY_PLANNER_GUIDANCE,
    );
    withDevCapsEnv("off", () => {
      expect(revisionPrompt(DEV_CWD)).not.toContain(DEV_GATEWAY_PLANNER_GUIDANCE);
    });
  });
});

describe("buildPlanningPrompt Goal-vs-Plan framing", () => {
  it("preserves the full Goal while scoping only the first Plan to an Observation Point", () => {
    const prompt = buildPlanningPrompt({
      runId: "run-goal-plan-framing",
      goalText:
        "my goal is to start a business that makes $10m per year in revenue that I own the majority of",
      cwd: "/tmp/workspaces/smithersbot/repo",
      scoutDir: "/tmp/unused-scout-dir",
      includeScoutArtifacts: true,
      enabledWorkers: ["claude_code", "codex"],
    });

    const gateSection = sectionBetween(prompt, "### Needs Decision Gate", "### Goal Brief Phase");
    const goalBriefSection = sectionBetween(prompt, "### Goal Brief Phase", "### Planner Phase");

    expectComputerBasedCapabilityFraming(gateSection);
    expect(gateSection).toContain(
      "A Plan is bounded work SmithersBot can do now toward that Goal, stopping at an Observation Point.",
    );
    expect(gateSection).toContain("the first Plan toward the Goal");
    expect(gateSection).toContain("choose or scope the first Plan");
    expect(gateSection).toContain("ask what the first Plan should do");
    expect(gateSection).toContain(
      "time, market response, human action, external feedback, or real-world events",
    );
    expectNoSoftwareOnlyLimitingFraming(gateSection);

    expect(goalBriefSection).toContain("Original User Ask");
    expect(goalBriefSection).toContain("First Plan Intent");
    expect(goalBriefSection).toContain(
      "separate the full Goal from the First Plan Intent and Observation Point",
    );
    expect(goalBriefSection).toContain("preserve the full Goal in Original User Ask");
    expect(goalBriefSection).toContain("Goal Summary is WHOLE-GOAL scoped");
    expect(goalBriefSection).toContain("Plan Summary / First Plan Intent are plan-scoped");
    expect(goalBriefSection).toContain("describe only the bounded first Plan");
    expect(goalBriefSection).toContain(
      "First Plan Intent must state what the first Plan should do",
    );
    expect(goalBriefSection).toContain("toward the full Goal");
    expectNoSoftwareOnlyLimitingFraming(goalBriefSection);
  });
});

describe("Needs Decision source cleanup", () => {
  it("does not keep old scout/planner artifact or status references", () => {
    const oldArtifact = ["plan", "needs", "clarification.md"].join("_");
    const oldStatus = ["needs", "clarification"].join("_");
    const sourceTexts = [
      fs.readFileSync(new URL("./scout.ts", import.meta.url), "utf8"),
      fs.readFileSync(new URL("./cli-planner.ts", import.meta.url), "utf8"),
    ];
    for (const sourceText of sourceTexts) {
      expect(sourceText).not.toContain(oldArtifact);
      expect(sourceText).not.toContain(oldStatus);
    }
  });
});

describe("runCliPlanning", () => {
  let goalsDir: string;
  let priorApiKey: string | undefined;
  let priorAuthToken: string | undefined;
  let priorApiKeyOld: string | undefined;
  let priorBaseUrl: string | undefined;
  let priorManagedRoot: string | undefined;
  let priorCodexSandboxRoot: string | undefined;
  let priorClaudeSandboxSettingsRoot: string | undefined;
  let managedRoot: string;
  let codexSandboxRoot: string;
  let claudeSandboxSettingsRoot: string;
  let cwdSpy: { mockRestore: () => void } | undefined;

  beforeEach(() => {
    goalsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-planner-test-"));
    vi.clearAllMocks();
    mockDetectBackendAvailability.mockReturnValue([
      { id: "pi", available: true },
      { id: "codex", available: true },
      { id: "claude_code", available: true },
    ]);
    mockResolveClaudeBinary.mockReturnValue("/usr/bin/claude");
    priorApiKey = process.env.ANTHROPIC_API_KEY;
    priorAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    priorApiKeyOld = process.env.ANTHROPIC_API_KEY_OLD;
    priorBaseUrl = process.env.ANTHROPIC_BASE_URL;
    priorManagedRoot = process.env.SMITHERSBOT_GOALS_ROOT;
    priorCodexSandboxRoot = process.env.SMITHERSBOT_CODEX_SANDBOX_ROOT;
    priorClaudeSandboxSettingsRoot = process.env.SMITHERSBOT_CLAUDE_SANDBOX_SETTINGS_ROOT;
    managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cli-planner-managed-"));
    const hostTempRoot = path.join(os.tmpdir(), "cli-planner-host-temp");
    fs.mkdirSync(hostTempRoot, { recursive: true });
    codexSandboxRoot = fs.mkdtempSync(path.join(hostTempRoot, "cli-planner-codex-"));
    claudeSandboxSettingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cli-planner-claude-"));
    process.env.SMITHERSBOT_GOALS_ROOT = managedRoot;
    process.env.SMITHERSBOT_CODEX_SANDBOX_ROOT = codexSandboxRoot;
    process.env.SMITHERSBOT_CLAUDE_SANDBOX_SETTINGS_ROOT = claudeSandboxSettingsRoot;
    // The native-sandbox guards require generated config to live OUTSIDE the agent
    // root AND the workspace. Under vitest, os.tmpdir() (hence codexSandboxRoot and
    // the managed root) is redirected into the repo, and on dogfood hosts the repo
    // is itself under the real agent root — so a planner workingDir of the real
    // process.cwd() would make the sibling sandbox roots fail the guard. Point cwd at
    // a fixture checkout that mirrors a normal CI layout: OUTSIDE the (relocated)
    // agent root, with the workspace name "smithersbot" so path assertions stay valid
    // and repo-chat executionRoot resolves to the workspace (not the agent root).
    const plannerWorkingDir = path.join(managedRoot, "checkout", "smithersbot", "repo");
    fs.mkdirSync(plannerWorkingDir, { recursive: true });
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(plannerWorkingDir);
  });

  afterEach(() => {
    cwdSpy?.mockRestore();
    if (priorApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = priorApiKey;
    if (priorAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = priorAuthToken;
    if (priorApiKeyOld === undefined) delete process.env.ANTHROPIC_API_KEY_OLD;
    else process.env.ANTHROPIC_API_KEY_OLD = priorApiKeyOld;
    if (priorBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = priorBaseUrl;
    if (priorManagedRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
    else process.env.SMITHERSBOT_GOALS_ROOT = priorManagedRoot;
    if (priorCodexSandboxRoot === undefined) delete process.env.SMITHERSBOT_CODEX_SANDBOX_ROOT;
    else process.env.SMITHERSBOT_CODEX_SANDBOX_ROOT = priorCodexSandboxRoot;
    if (priorClaudeSandboxSettingsRoot === undefined) {
      delete process.env.SMITHERSBOT_CLAUDE_SANDBOX_SETTINGS_ROOT;
    } else {
      process.env.SMITHERSBOT_CLAUDE_SANDBOX_SETTINGS_ROOT = priorClaudeSandboxSettingsRoot;
    }
    fs.rmSync(managedRoot, { recursive: true, force: true });
    fs.rmSync(codexSandboxRoot, { recursive: true, force: true });
    fs.rmSync(claudeSandboxSettingsRoot, { recursive: true, force: true });
    fs.rmSync(goalsDir, { recursive: true, force: true });
  });

  it("runs a single CLI planning pass and returns a validated plan", async () => {
    process.env.ANTHROPIC_API_KEY = "should-be-stripped";
    process.env.ANTHROPIC_AUTH_TOKEN = "should-be-stripped";
    process.env.ANTHROPIC_API_KEY_OLD = "should-be-stripped";
    process.env.ANTHROPIC_BASE_URL = "https://proxy.invalid";

    mockRunCliProcess.mockImplementation(async (params: Record<string, unknown>) => {
      const stdoutPath = String(params.stdoutPath);
      const scoutDir = path.dirname(stdoutPath);
      fs.writeFileSync(stdoutPath, "planner stdout", "utf8");
      fs.writeFileSync(String(params.stderrPath), "", "utf8");
      writeScoutArtifacts(scoutDir, "run-success");
      fs.writeFileSync(
        path.join(scoutDir, EXECUTION_PLAN_FILE),
        JSON.stringify(
          {
            summary: "Unified planning summary",
            workingDir: "/tmp/test-wd",
            steps: [
              {
                id: "analyze-repo",
                description: "Inspect repository files and verify with a targeted test run",
                dependsOn: [],
                durationMinutes: 45,
                backend: "codex",
              },
            ],
          },
          null,
          2,
        ),
        "utf8",
      );
      return {
        stdout:
          '{"summary":"Unified planning summary","workingDir":"/tmp/test-wd","steps":[{"id":"analyze-repo","description":"Inspect repository files and verify with a targeted test run","dependsOn":[],"durationMinutes":45,"backend":"codex"}]}',
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 123,
      };
    });

    const result = await runCliPlanning({
      runId: "run-success",
      goalText: "Create a tiny test artifact",
      goalsDir,
    });

    expect(result.status).toBe("success");
    expect(result.scoutStatus).toBe("success");
    if (result.status === "success") {
      expect(result.plan.summary).toBe("Unified planning summary");
      expect(result.plan.steps).toHaveLength(1);
      expect(result.plan.steps[0]?.backend).toBe("codex");
    }

    const scoutDir = path.join(goalsDir, "run-success", "scout");
    expect(fs.existsSync(path.join(scoutDir, "planning_stdout.txt"))).toBe(true);
    expect(fs.existsSync(path.join(scoutDir, "planning_stderr.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(scoutDir, "planning_raw_output.txt"), "utf8")).toContain(
      "Unified planning summary",
    );
    expect(fs.existsSync(path.join(scoutDir, EXECUTION_PLAN_FILE))).toBe(true);
    const goalBriefPath = path.join(
      managedRoot,
      "agent",
      "history",
      "goals",
      PENDING_WORKSPACE_SLUG,
      "run-success",
      "wiki",
      GOAL_BRIEF_FILE,
    );
    expect(fs.existsSync(goalBriefPath)).toBe(true);
    expect(goalBriefPath).not.toContain(`${path.sep}runtime${path.sep}scout${path.sep}`);
    if (result.status === "success") {
      expect(result.goalBriefPath).toBe(goalBriefPath);
      expect(
        resolveStoredGoalBriefPath({
          runId: "run-success",
          workingDir: "/tmp/reassigned-after-planning",
          goalBriefPath: result.goalBriefPath,
        }),
      ).toBe(goalBriefPath);
    }
    const mirroredPlanPath = path.join(
      managedRoot,
      "agent",
      "history",
      "goals",
      PENDING_WORKSPACE_SLUG,
      "run-success",
      "runtime",
      "scout",
      EXECUTION_PLAN_FILE,
    );
    expect(fs.existsSync(mirroredPlanPath)).toBe(true);
    expect(
      fs.existsSync(path.join(path.dirname(path.dirname(mirroredPlanPath)), "index.json")),
    ).toBe(true);

    const procCall = mockRunCliProcess.mock.calls[0]?.[0] as {
      env: Record<string, string | undefined>;
      cwd: string;
      args: string[];
    };
    expect(procCall.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(procCall.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(procCall.env.ANTHROPIC_API_KEY_OLD).toBeUndefined();
    expect(procCall.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(procCall.cwd).toBe(process.cwd());
    expect(procCall.args).not.toContain("--dangerously-skip-permissions");
    expect(procCall.args).not.toContain("--allow-dangerously-skip-permissions");
    expect(procCall.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("accepts a stdout-only execution plan when first-time scout artifacts are missing", async () => {
    const stdoutPlan = JSON.stringify({
      summary: "Stdout-only plan",
      workingDir: "/tmp/test-wd",
      steps: [
        {
          id: "inspect-repo",
          description: "Inspect repository state and report findings",
          dependsOn: [],
          durationMinutes: 10,
          backend: "codex",
        },
      ],
    });

    mockRunCliProcess.mockImplementation(async (params: Record<string, unknown>) => {
      fs.writeFileSync(String(params.stdoutPath), stdoutPlan, "utf8");
      fs.writeFileSync(String(params.stderrPath), "", "utf8");
      writeGoalBriefForRun("run-stdout-only-missing-scout");
      return {
        stdout: stdoutPlan,
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 42,
      };
    });

    const result = await runCliPlanning({
      runId: "run-stdout-only-missing-scout",
      goalText: "Tell me whether the git tree is clean",
      goalsDir,
    });

    expect(result.status).toBe("success");
    expect(result.scoutStatus).toBe("skipped");
    expect(result.scoutSkipReason).toContain("plan_draft.md not found");
    if (result.status === "success") {
      expect(result.plan.summary).toBe("Stdout-only plan");
    }
  });

  it("records an advisory diagnostic when stdout plan parsing succeeds but scout artifacts are missing", async () => {
    const stdoutPlan = JSON.stringify({
      summary: "Advisory diagnostic plan",
      workingDir: "/tmp/test-wd",
      steps: [
        {
          id: "inspect-repo",
          description: "Inspect repository state and report findings",
          dependsOn: [],
          durationMinutes: 10,
          backend: "codex",
        },
      ],
    });

    mockRunCliProcess.mockImplementation(async (params: Record<string, unknown>) => {
      fs.writeFileSync(String(params.stdoutPath), stdoutPlan, "utf8");
      fs.writeFileSync(String(params.stderrPath), "", "utf8");
      writeGoalBriefForRun("run-stdout-only-advisory");
      return {
        stdout: stdoutPlan,
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 42,
      };
    });

    await runCliPlanning({
      runId: "run-stdout-only-advisory",
      goalText: "Tell me whether the git tree is clean",
      goalsDir,
    });

    const events = readPlannerHistoryEvents("run-stdout-only-advisory");
    const advisory = events.find((event) => event.event === "scout_artifacts_missing");
    expect(advisory).toMatchObject({
      phase: "planner",
      status: "warning",
      validationReason: "plan_draft.md not found",
      planSource: "stdout",
      executionPlan: { exists: false },
      planningStdout: expect.objectContaining({
        exists: true,
        preview: expect.stringContaining("Advisory diagnostic plan"),
      }),
    });
    expect(advisory?.scoutDir).toBe(
      path.resolve(path.join(goalsDir, "run-stdout-only-advisory", "scout")),
    );
    expect(advisory?.directoryListing).toContain("node_specs/");
  });

  it("throws a rich scout diagnostic when plan parsing and first-time scout validation both fail", async () => {
    mockRunCliProcess.mockImplementation(async (params: Record<string, unknown>) => {
      fs.writeFileSync(String(params.stdoutPath), "not a valid plan", "utf8");
      fs.writeFileSync(String(params.stderrPath), "", "utf8");
      return {
        stdout: "not a valid plan",
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 42,
      };
    });

    await expect(
      runCliPlanning({
        runId: "run-invalid-plan-missing-scout",
        goalText: "Create a tiny test artifact",
        goalsDir,
      }),
    ).rejects.toThrow(
      new RegExp(
        [
          "Planning scout artifacts invalid: plan_draft\\.md not found",
          "scoutDir: .*run-invalid-plan-missing-scout.*scout",
          "directory listing: .*node_specs/",
          "execution_plan\\.json: exists=false",
          "planning_stdout\\.txt: exists=true",
          "planning_stdout\\.txt preview: not a valid plan",
          "scout validation error: plan_draft\\.md not found",
        ].join("[\\s\\S]*"),
      ),
    );
  });

  it("replans with compact cached scout context without rerunning the scout template", async () => {
    const runId = "run-cached-scout-replan";
    const scoutDir = path.join(goalsDir, runId, "scout");
    writeScoutArtifacts(scoutDir, runId);
    const scoutData = {
      status: "success" as const,
      report: {
        goal_id: runId,
        nodes: [
          {
            id: "analyze-repo",
            type: "Impl",
            objective: "Analyze repository structure",
            verification: "pnpm vitest run src/goal/cli-planner.test.ts",
            effort: 2,
            risk: 1,
            uncertainty: 1,
          },
        ],
        edges: [],
      },
      planDraft: fs.readFileSync(path.join(scoutDir, "plan_draft.md"), "utf8"),
    };

    mockRunCliProcess.mockResolvedValueOnce({
      stdout: JSON.stringify({
        summary: "Cached scout replan summary",
        workingDir: "/tmp/test-wd",
        steps: [
          {
            id: "analyze-repo",
            description: "Use cached scout facts and verify with focused tests",
            dependsOn: [],
            durationMinutes: 20,
            backend: "codex",
          },
        ],
      }),
      stderr: "",
      timedOut: false,
      exitCode: 0,
      signal: null,
      durationMs: 50,
    });

    const result = await runCliPlanning({
      runId,
      goalText: "Replan from cached scout",
      goalsDir,
      scoutData,
    });

    expect(result.status).toBe("success");
    expect(result.scoutStatus).toBe("success");
    expect(result.scoutData).toEqual(scoutData);
    if (result.status === "success") {
      const briefPath = goalBriefPathForRun(runId);
      expect(result.goalBriefPath).toBe(briefPath);
      expect(fs.readFileSync(briefPath, "utf8").trim()).not.toBe("");
      expect(
        resolveStoredGoalBriefPath({
          runId,
          workingDir: "/tmp/final-planner-working-dir",
          goalBriefPath: result.goalBriefPath,
        }),
      ).toBe(briefPath);
    }
    expect(fs.existsSync(path.join(scoutDir, "scout_report.json"))).toBe(true);
    expect(fs.existsSync(path.join(scoutDir, "plan_draft.md"))).toBe(true);
    expect(fs.existsSync(path.join(scoutDir, "node_specs", "analyze-repo.md"))).toBe(true);

    const planningCall = mockRunCliProcess.mock.calls[0]?.[0] as { stdin: string };
    expect(planningCall.stdin).toContain("## Replan With Cached Scout Context");
    expect(planningCall.stdin).toContain("## Cached Scout Context");
    expect(planningCall.stdin).toContain("agent/history/goals/");
    expect(planningCall.stdin).toContain("Do not run a fresh scout by default");
    expect(planningCall.stdin).not.toContain("## Conceptual Planning Phases");
    expect(planningCall.stdin).not.toContain("### Scout Phase");
    expect(planningCall.stdin).not.toContain("BEGIN_SCOUT_PROMPT");
  });

  it("keeps cached-scout replan inputs tied to strict full scout artifacts", () => {
    const runId = "run-cached-scout-strict";
    const scoutDir = path.join(goalsDir, runId, "scout");
    fs.mkdirSync(path.join(scoutDir, "node_specs"), { recursive: true });
    fs.writeFileSync(
      path.join(scoutDir, "scout_report.json"),
      JSON.stringify({ goal_id: runId, nodes: [], edges: [] }),
      "utf8",
    );

    // Cached replans are fed by previously validated ScoutResult data; unlike
    // first-time planning above, missing scout ceremony files remain strict here.
    expect(validateScoutOutput(scoutDir)).toMatchObject({
      status: "error",
      error: "plan_draft.md not found",
    });
  });

  it("repairs a missing Goal Brief with the same backend before accepting a plan", async () => {
    const runId = "run-missing-brief-repair-same";
    const plan = {
      summary: "Plan missing a brief",
      workingDir: "/tmp/test-wd",
      steps: [
        {
          id: "analyze-repo",
          description: "Inspect repository files and verify with a targeted test run",
          dependsOn: [],
          durationMinutes: 20,
          backend: "claude_code",
        },
      ],
    };

    mockRunCliProcess
      .mockImplementationOnce(async (params: Record<string, unknown>) => {
        const scoutDir = path.dirname(String(params.stdoutPath));
        writeScoutArtifacts(scoutDir, runId, { goalBrief: false });
        fs.writeFileSync(path.join(scoutDir, EXECUTION_PLAN_FILE), JSON.stringify(plan), "utf8");
        return {
          stdout: JSON.stringify(plan),
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 40,
        };
      })
      .mockImplementationOnce(async (params: Record<string, unknown>) => {
        expect(params.command).toBe("/usr/bin/claude");
        const repairPrompt = String(params.stdin);
        expect(repairPrompt).toContain("repairing a missing required Goal Brief");
        expect(repairPrompt).toContain(`${path.join("wiki", GOAL_BRIEF_FILE)}`);
        expectComputerBasedCapabilityFraming(repairPrompt);
        expect(repairPrompt).toContain(
          "A Plan is bounded work SmithersBot can do now toward that Goal, stopping at an Observation Point.",
        );
        expect(repairPrompt).toContain(
          "time, market response, human action, external feedback, or real-world events",
        );
        expect(repairPrompt).toContain(
          "separate the full Goal from the First Plan Intent and Observation Point",
        );
        expect(repairPrompt).toContain("preserve the full Goal in Original User Ask");
        expect(repairPrompt).toContain("Goal Summary is WHOLE-GOAL scoped");
        expect(repairPrompt).toContain("Plan Summary / First Plan Intent are plan-scoped");
        expect(repairPrompt).toContain("describe only the bounded first Plan");
        expect(repairPrompt).toContain(
          "First Plan Intent must explain what the first Plan should do",
        );
        expect(repairPrompt).toContain("toward the full Goal");
        const repairGuidance = sectionBetween(
          repairPrompt,
          "Use the same Goal-vs-Plan framing",
          "GOAL_ID:",
        );
        expectNoSoftwareOnlyLimitingFraming(repairGuidance);
        writeGoalBriefForRun(runId, "# Goal Summary\n\nRepaired brief\n");
        return {
          stdout: "created goal brief",
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 12,
        };
      });

    const result = await runCliPlanning({
      runId,
      goalText: "Create a plan that needs brief repair",
      goalsDir,
      enabledWorkers: ["claude_code"],
    });

    expect(result.status).toBe("success");
    expect(mockRunCliProcess).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(goalBriefPathForRun(runId), "utf8")).toContain("Repaired brief");
  });

  it("falls back to the other backend when same-backend Goal Brief repair is usage-limited", async () => {
    const runId = "run-missing-brief-repair-fallback";
    const plan = {
      summary: "Plan missing a brief before fallback repair",
      workingDir: "/tmp/test-wd",
      steps: [
        {
          id: "analyze-repo",
          description: "Inspect repository files and verify with a targeted test run",
          dependsOn: [],
          durationMinutes: 20,
          backend: "claude_code",
        },
      ],
    };

    mockRunCliProcess
      .mockImplementationOnce(async (params: Record<string, unknown>) => {
        const scoutDir = path.dirname(String(params.stdoutPath));
        writeScoutArtifacts(scoutDir, runId, { goalBrief: false });
        fs.writeFileSync(path.join(scoutDir, EXECUTION_PLAN_FILE), JSON.stringify(plan), "utf8");
        return {
          stdout: JSON.stringify(plan),
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 40,
        };
      })
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "monthly usage limit reached. Resets at 3pm.",
        timedOut: false,
        exitCode: 1,
        signal: null,
        durationMs: 8,
      })
      .mockImplementationOnce(async (params: Record<string, unknown>) => {
        expect(params.command).toBe("codex");
        const args = params.args as string[];
        expect(args.at(-1)).toContain("repairing a missing required Goal Brief");
        writeGoalBriefForRun(runId, "# Goal Summary\n\nFallback repaired brief\n");
        return {
          stdout: "created goal brief",
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 14,
        };
      });

    const result = await runCliPlanning({
      runId,
      goalText: "Create a plan that needs fallback brief repair",
      goalsDir,
      enabledWorkers: ["claude_code", "codex"],
    });

    expect(result.status).toBe("success");
    expect(mockRunCliProcess).toHaveBeenCalledTimes(3);
    expect((mockRunCliProcess.mock.calls[1]![0] as { command: string }).command).toBe(
      "/usr/bin/claude",
    );
    expect((mockRunCliProcess.mock.calls[2]![0] as { command: string }).command).toBe("codex");
    expect(fs.readFileSync(goalBriefPathForRun(runId), "utf8")).toContain("Fallback repaired");
  });

  it("keeps planning successful and writes a warning event when runtime mirroring fails", async () => {
    const mirrorSpy = vi
      .spyOn(runtimeMirror, "mirrorGoalRuntimeToAgentHistory")
      .mockImplementationOnce(() => {
        throw new Error("mirror unavailable");
      });

    mockRunCliProcess.mockImplementation(async (params: Record<string, unknown>) => {
      const stdoutPath = String(params.stdoutPath);
      const scoutDir = path.dirname(stdoutPath);
      fs.writeFileSync(stdoutPath, "planner stdout", "utf8");
      fs.writeFileSync(String(params.stderrPath), "", "utf8");
      writeScoutArtifacts(scoutDir, "run-mirror-warning");
      const plan = {
        summary: "Plan still succeeds",
        workingDir: "/tmp/test-wd",
        steps: [
          {
            id: "analyze-repo",
            description: "Inspect repository files and verify with a targeted test run",
            dependsOn: [],
            durationMinutes: 45,
            backend: "codex",
          },
        ],
      };
      fs.writeFileSync(path.join(scoutDir, EXECUTION_PLAN_FILE), JSON.stringify(plan), "utf8");
      return {
        stdout: JSON.stringify(plan),
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 123,
      };
    });

    const result = await runCliPlanning({
      runId: "run-mirror-warning",
      goalText: "Create a tiny test artifact",
      goalsDir,
    });

    expect(result.status).toBe("success");
    expect(mirrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceName: PENDING_WORKSPACE_SLUG,
        goalId: "run-mirror-warning",
        goalsDir,
      }),
    );
    expect(
      readPlannerHistoryEvents("run-mirror-warning", PENDING_WORKSPACE_SLUG).at(-1),
    ).toMatchObject({
      event: "runtime_mirror_warning",
      phase: "planner",
      status: "warning",
    });
    mirrorSpy.mockRestore();
  });

  it("builds a compact cached scout summary with artifact references", () => {
    const summary = buildCachedScoutSummary({
      runId: "run-summary",
      cwd: "/tmp/workspaces/smithersbot/repo",
      scoutDir: "/tmp/goals/run-summary/scout",
      scoutData: {
        status: "success",
        report: {
          goal_id: "run-summary",
          nodes: [
            {
              id: "step-one",
              type: "Impl",
              objective: "Touch concrete files",
              verification: "pnpm vitest run src/example.test.ts",
              effort: 1,
              risk: 2,
              uncertainty: 3,
            },
          ],
          edges: [{ from: "step-one", to: "step-two", why: "dependency" }],
        },
        planDraft: "BEGIN_PLAN_DRAFT\nGOAL_ID: run-summary\nEND_PLAN_DRAFT",
      },
    });

    expect(summary).toContain("## Cached Scout Context");
    expect(summary).toContain("agent/history/goals/repo/run-summary/runtime/scout");
    expect(summary).toContain("agent/history/goals/repo/run-summary/wiki/goal-brief.md");
    expect(summary).not.toContain("{{WIKI_DIR}}");
    expect(summary).toContain("step-one (Impl)");
    expect(summary).toContain("step-one -> step-two: dependency");
    expect(summary).toContain("Prior-version lineage (follow for history):");
    expect(summary).toContain("Prior ScoutReport:");
    expect(summary).toContain("Prior Goal Brief:");
    expect(summary).toContain("What changed since the prior scout:");
    expect(summary).toContain("Terms: see GLOSSARY.md");
  });

  it("writes agent-visible launch and prompt history before planner spawn and captures tokens", async () => {
    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "FAKE_PLANNER_HISTORY_SECRET";
    const gatewayCwd = path.join(managedRoot, "agent", "workspaces", "smithersbot-dev");
    fs.mkdirSync(gatewayCwd, { recursive: true });
    try {
      mockDetectBackendAvailability.mockReturnValue([
        { id: "pi", available: true },
        { id: "codex", available: true },
        { id: "claude_code", available: false, reason: "not found" },
      ]);
      mockResolveClaudeBinary.mockReturnValue(null);
      mockRunCliProcess.mockImplementationOnce(async (params: Record<string, unknown>) => {
        const events = readPlannerHistoryEvents("run-history-pre-spawn", "test-workspace");
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          event: "launch",
          phase: "planner",
          backend: "codex",
          runId: "run-history-pre-spawn",
          status: "launching",
        });
        const promptArtifactPath = String(events[0]?.promptArtifactPath);
        expect(promptArtifactPath).toContain(
          path.join("history", "goals", "test-workspace", "run-history-pre-spawn", "prompts"),
        );
        expect(fs.existsSync(promptArtifactPath)).toBe(true);
        const promptArtifact = fs.readFileSync(promptArtifactPath, "utf8");
        expect(promptArtifact).toContain("[REDACTED]");
        expect(promptArtifact).not.toContain("FAKE_PLANNER_HISTORY_SECRET");
        expect(JSON.stringify(events[0])).not.toContain("FAKE_PLANNER_HISTORY_SECRET");
        expect(JSON.stringify(events[0])).not.toContain("Goal has FAKE_PLANNER_HISTORY_SECRET");

        const scoutDir = path.dirname(String(params.stdoutPath));
        fs.writeFileSync(
          path.join(scoutDir, EXECUTION_PLAN_FILE),
          JSON.stringify({
            summary: "History plan",
            workingDir: "/tmp/test-wd",
            steps: [
              {
                id: "history-step",
                description: "Inspect history",
                dependsOn: [],
                durationMinutes: 5,
                backend: "codex",
              },
            ],
          }),
          "utf8",
        );
        return {
          stdout: JSON.stringify({
            type: "token_count",
            token_count: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
          }),
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 20,
        };
      });

      const result = await runCliPlanning({
        runId: "run-history-pre-spawn",
        goalText: "Goal has FAKE_PLANNER_HISTORY_SECRET",
        goalsDir,
        cwd: gatewayCwd,
        historyWorkspaceSlug: "test-workspace",
        includeScoutArtifacts: false,
        enabledWorkers: ["codex"],
      });

      expect(result.status).toBe("success");
      const events = readPlannerHistoryEvents("run-history-pre-spawn", "test-workspace");
      expect(events.map((event) => event.event)).toEqual(["launch", "result"]);
      expect(events[1]).toMatchObject({
        event: "result",
        phase: "planner",
        backend: "codex",
        status: "success",
        tokenUsage: {
          available: true,
          inputTokens: 11,
          outputTokens: 7,
          totalTokens: 18,
          source: "codex-json",
        },
      });
      expect(JSON.stringify(events)).not.toContain("FAKE_PLANNER_HISTORY_SECRET");
      expect(
        fs.existsSync(
          resolveAgentHistoryEventsPath({
            kind: "goal",
            workspaceName: "smithersbot-dev",
            goalId: "run-history-pre-spawn",
          }),
        ),
      ).toBe(false);
    } finally {
      if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = previousToken;
    }
  });

  it("launches Codex planning through the shared native sandbox helper", async () => {
    const previousEnv = seedForbiddenAgentEnv();
    try {
      mockRunCliProcess.mockImplementation(async (params: Record<string, unknown>) => {
        const scoutDir = path.dirname(String(params.stdoutPath));
        fs.writeFileSync(
          path.join(scoutDir, EXECUTION_PLAN_FILE),
          JSON.stringify({
            summary: "Codex sandboxed planning",
            workingDir: "/tmp/test-wd",
            steps: [
              {
                id: "sandboxed-plan",
                description: "Inspect repository state",
                dependsOn: [],
                durationMinutes: 5,
                backend: "codex",
              },
            ],
          }),
          "utf8",
        );
        return {
          stdout: JSON.stringify({
            summary: "Codex sandboxed planning",
            workingDir: "/tmp/test-wd",
            steps: [
              {
                id: "sandboxed-plan",
                description: "Inspect repository state",
                dependsOn: [],
                durationMinutes: 5,
                backend: "codex",
              },
            ],
          }),
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 20,
        };
      });

      await runCliPlanning({
        runId: "run-codex-native-sandbox",
        goalText: "Plan with Codex",
        goalsDir,
        includeScoutArtifacts: false,
        enabledWorkers: ["codex"],
      });
    } finally {
      restoreForbiddenAgentEnv(previousEnv);
    }

    const procCall = mockRunCliProcess.mock.calls[0]?.[0] as {
      args: string[];
      env: Record<string, string | undefined>;
    };
    expect(procCall.args).not.toContain("--permissions-profile");
    expect(procCall.args).toContain("--skip-git-repo-check");
    expect(procCall.args).toContain("--cd");
    expect(procCall.args).not.toContain("--sandbox");
    expect(procCall.args).not.toContain("--dangerously-skip-permissions");
    expect(procCall.args).not.toContain("--allow-dangerously-skip-permissions");
    expect(procCall.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(procCall.env.CODEX_HOME).toContain(codexSandboxRoot);
    expect(procCall.env.PATH).toContain(`${procCall.env.CODEX_HOME}${path.sep}bin`);
    expectForbiddenAgentEnvAbsent(procCall.env);

    const configToml = fs.readFileSync(path.join(procCall.env.CODEX_HOME!, "config.toml"), "utf8");
    expect(configToml).toContain(`${JSON.stringify(path.join(process.cwd(), ".env"))} = "deny"`);
    expect(configToml).toContain(
      `${JSON.stringify(path.join(managedRoot, "private", "env", "smithersbot", ".env"))} = "deny"`,
    );
    expect(configToml).toContain(
      `${JSON.stringify(path.join(os.homedir(), ".codex", "auth.json"))} = "deny"`,
    );
    expect(configToml).toContain(`${JSON.stringify(process.cwd())} = "read"`);
  });

  it("allows Codex scout artifact writes without granting repo writes", async () => {
    mockRunCliProcess.mockImplementation(async (params: Record<string, unknown>) => {
      const prompt = String((params.args as string[]).at(-1));
      const match = /Agent-visible planning artifact directory: ([^\n]+)/.exec(prompt);
      if (!match?.[1]) throw new Error("missing agent-visible scout dir in prompt");
      expect(match[1].trim()).toBe(
        path.join(
          managedRoot,
          "agent",
          "history",
          "goals",
          PENDING_WORKSPACE_SLUG,
          "run-codex-scout-sandbox",
          "runtime",
          "scout",
        ),
      );
      const codexScoutDir = path.dirname(String(params.stdoutPath));
      writeScoutArtifacts(codexScoutDir, "run-codex-scout-sandbox");
      fs.writeFileSync(
        path.join(codexScoutDir, EXECUTION_PLAN_FILE),
        JSON.stringify({
          summary: "Codex scout sandbox",
          workingDir: "/tmp/test-wd",
          steps: [
            {
              id: "analyze-repo",
              description: "Inspect repository files",
              dependsOn: [],
              durationMinutes: 10,
              backend: "codex",
            },
          ],
        }),
        "utf8",
      );
      return {
        stdout: JSON.stringify({
          summary: "Codex scout sandbox",
          workingDir: "/tmp/test-wd",
          steps: [
            {
              id: "analyze-repo",
              description: "Inspect repository files",
              dependsOn: [],
              durationMinutes: 10,
              backend: "codex",
            },
          ],
        }),
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 20,
      };
    });

    await runCliPlanning({
      runId: "run-codex-scout-sandbox",
      goalText: "Plan with Codex scout artifacts",
      goalsDir,
      enabledWorkers: ["codex"],
    });

    const procCall = mockRunCliProcess.mock.calls[0]?.[0] as {
      env: Record<string, string | undefined>;
    };
    const configToml = fs.readFileSync(path.join(procCall.env.CODEX_HOME!, "config.toml"), "utf8");
    const codexScoutDir = path.join(
      os.tmpdir(),
      "moltbot-goal-planner",
      "run-codex-scout-sandbox",
      "scout",
    );
    expect(configToml).toContain(`${JSON.stringify(process.cwd())} = "read"`);
    expect(configToml).not.toContain(`${JSON.stringify(process.cwd())} = "write"`);
    expect(configToml).toContain(`${JSON.stringify(codexScoutDir)} = "write"`);
    expect(configToml).toContain(
      `${JSON.stringify(
        path.join(
          managedRoot,
          "agent",
          "history",
          "goals",
          PENDING_WORKSPACE_SLUG,
          "run-codex-scout-sandbox",
          "wiki",
        ),
      )} = "write"`,
    );
  });

  it("launches Claude planning with generated read-only sandbox settings and scout-only writes", async () => {
    mockRunCliProcess.mockImplementation(async (params: Record<string, unknown>) => {
      const scoutDir = path.dirname(String(params.stdoutPath));
      writeScoutArtifacts(scoutDir, "run-claude-scout-sandbox");
      fs.writeFileSync(
        path.join(scoutDir, EXECUTION_PLAN_FILE),
        JSON.stringify({
          summary: "Claude sandboxed planning",
          workingDir: "/tmp/test-wd",
          steps: [
            {
              id: "analyze-repo",
              description: "Inspect repository files",
              dependsOn: [],
              durationMinutes: 10,
              backend: "claude_code",
            },
          ],
        }),
        "utf8",
      );
      return {
        stdout: JSON.stringify({
          summary: "Claude sandboxed planning",
          workingDir: "/tmp/test-wd",
          steps: [
            {
              id: "analyze-repo",
              description: "Inspect repository files",
              dependsOn: [],
              durationMinutes: 10,
              backend: "claude_code",
            },
          ],
        }),
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 20,
      };
    });

    await runCliPlanning({
      runId: "run-claude-scout-sandbox",
      goalText: "Plan with Claude scout artifacts",
      goalsDir,
      enabledWorkers: ["claude_code"],
    });

    const procCall = mockRunCliProcess.mock.calls[0]?.[0] as { args: string[]; stdin: string };
    const settingsPath = procCall.args[procCall.args.indexOf("--settings") + 1];
    expect(settingsPath).toBeTruthy();
    expect(procCall.args).toContain("--setting-sources");
    expect(procCall.args).toContain("--permission-mode");
    expect(procCall.args).not.toContain("--dangerously-skip-permissions");
    expect(procCall.args).not.toContain("--allow-dangerously-skip-permissions");
    const settings = JSON.parse(fs.readFileSync(settingsPath!, "utf8")) as {
      sandbox: { filesystem: { allowRead: string[]; allowWrite: string[]; denyRead: string[] } };
      permissions: { deny: string[] };
    };
    expect(settings.sandbox.enabled).toBe(true);
    expect(settings.sandbox.failIfUnavailable).toBe(true);
    expect(settings.sandbox.filesystem.allowRead).toContain(process.cwd());
    expect(settings.sandbox.filesystem.allowWrite).toEqual([
      path.join(goalsDir, "run-claude-scout-sandbox", "scout"),
      path.join(
        managedRoot,
        "agent",
        "history",
        "goals",
        PENDING_WORKSPACE_SLUG,
        "run-claude-scout-sandbox",
        "runtime",
        "scout",
      ),
      path.join(
        managedRoot,
        "agent",
        "history",
        "goals",
        PENDING_WORKSPACE_SLUG,
        "run-claude-scout-sandbox",
        "wiki",
      ),
    ]);
    expect(settings.sandbox.filesystem.allowWrite).not.toContain(process.cwd());
    expect(procCall.stdin.startsWith("You are a technical planning agent.")).toBe(true);
  });

  it("uses Codex-only planning when Claude Code is unavailable", async () => {
    const previousEnv = seedForbiddenAgentEnv();
    mockResolveClaudeBinary.mockReturnValue(null);
    mockDetectBackendAvailability.mockReturnValue([
      { id: "pi", available: true },
      { id: "codex", available: true },
      { id: "claude_code", available: false, reason: "claude not found on PATH" },
    ]);
    mockRunCliProcess.mockImplementation(async (params: Record<string, unknown>) => {
      const args = params.args as string[];
      const prompt = args.at(-1);
      expect(typeof prompt).toBe("string");
      expect(prompt).not.toContain("claude_code");
      return {
        stdout: JSON.stringify({
          summary: "Codex-only planning summary",
          workingDir: "/tmp/test-wd",
          steps: [
            {
              id: "inspect-repo-state",
              description:
                "Inspect the repository state and report whether the working tree is clean. Do not edit files.",
              dependsOn: [],
              durationMinutes: 10,
              backend: "codex",
            },
          ],
        }),
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 40,
      };
    });

    let result: Awaited<ReturnType<typeof runCliPlanning>>;
    try {
      result = await runCliPlanning({
        runId: "run-codex-only",
        goalText:
          "Inspect the repository state and report whether the working tree is clean. Do not edit files.",
        goalsDir,
        includeScoutArtifacts: false,
      });
    } finally {
      restoreForbiddenAgentEnv(previousEnv);
    }

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.plan.steps[0]?.backend).toBe("codex");
    expect(result.plan.steps[0]?.backend).not.toBe("claude_code");
    const procCall = mockRunCliProcess.mock.calls[0]?.[0] as {
      command: string;
      args: string[];
      env: Record<string, string | undefined>;
    };
    expect(procCall.command).toBe("codex");
    expect(procCall.args).toContain("exec");
    expectForbiddenAgentEnvAbsent(procCall.env);
  });

  it("keeps the planning prompt prefix stable while moving dynamic goal context after it", async () => {
    mockRunCliProcess.mockImplementation(async (params: Record<string, unknown>) => {
      const scoutDir = path.dirname(String(params.stdoutPath));
      fs.writeFileSync(
        path.join(scoutDir, EXECUTION_PLAN_FILE),
        JSON.stringify({
          summary: "Stable prefix plan",
          workingDir: "/tmp/test-wd",
          steps: [
            {
              id: "stable-prefix",
              description: "Verify prompt structure",
              dependsOn: [],
              durationMinutes: 5,
              backend: "claude_code",
            },
          ],
        }),
        "utf8",
      );
      return {
        stdout: JSON.stringify({
          summary: "Stable prefix plan",
          workingDir: "/tmp/test-wd",
          steps: [
            {
              id: "stable-prefix",
              description: "Verify prompt structure",
              dependsOn: [],
              durationMinutes: 5,
              backend: "claude_code",
            },
          ],
        }),
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 20,
      };
    });

    await runCliPlanning({
      runId: "run-prefix-a",
      goalText: "Add feature A",
      goalsDir,
      includeScoutArtifacts: false,
      enabledWorkers: ["claude_code"],
    });
    await runCliPlanning({
      runId: "run-prefix-b",
      goalText: "Add feature B",
      goalsDir,
      includeScoutArtifacts: false,
      enabledWorkers: ["claude_code"],
    });

    const firstPrompt = (mockRunCliProcess.mock.calls[0]![0] as { stdin: string }).stdin;
    const secondPrompt = (mockRunCliProcess.mock.calls[1]![0] as { stdin: string }).stdin;
    const firstStaticPrefix = firstPrompt.slice(0, firstPrompt.indexOf("\n\nGoal:"));
    const secondStaticPrefix = secondPrompt.slice(0, secondPrompt.indexOf("\n\nGoal:"));
    expect(firstStaticPrefix).toBe(secondStaticPrefix);
    expect(firstStaticPrefix).toContain("Step schema:");
    expect(firstStaticPrefix).toContain("BACKEND SELECTION RULES");
    expect(firstStaticPrefix).toContain("dependsOn");
    expect(firstPrompt.indexOf("Goal: Add feature A")).toBeGreaterThan(firstStaticPrefix.length);
    expect(secondPrompt.indexOf("Goal: Add feature B")).toBeGreaterThan(secondStaticPrefix.length);
  });

  it("keeps scout planning schema requirements after the stable prefix without exposing private runtime paths", async () => {
    const privateGoalsDir = path.join(managedRoot, ".clawdbot-dev", "goals");
    mockRunCliProcess.mockImplementation(async (params: Record<string, unknown>) => {
      const scoutDir = path.dirname(String(params.stdoutPath));
      writeScoutArtifacts(scoutDir, "run-scout-prefix");
      fs.writeFileSync(
        path.join(scoutDir, EXECUTION_PLAN_FILE),
        JSON.stringify({
          summary: "Scout prefix plan",
          workingDir: "/tmp/test-wd",
          steps: [
            {
              id: "analyze-repo",
              description: "Inspect repository files",
              dependsOn: [],
              durationMinutes: 5,
              backend: "claude_code",
            },
          ],
        }),
        "utf8",
      );
      return {
        stdout: JSON.stringify({
          summary: "Scout prefix plan",
          workingDir: "/tmp/test-wd",
          steps: [
            {
              id: "analyze-repo",
              description: "Inspect repository files",
              dependsOn: [],
              durationMinutes: 5,
              backend: "claude_code",
            },
          ],
        }),
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 20,
      };
    });

    await runCliPlanning({
      runId: "run-scout-prefix",
      goalText: "Use scout planning",
      goalsDir: privateGoalsDir,
      enabledWorkers: ["claude_code"],
    });

    const prompt = (mockRunCliProcess.mock.calls[0]![0] as { stdin: string }).stdin;
    expect(prompt.startsWith("You are a technical planning agent.")).toBe(true);
    expect(prompt.indexOf("## Context")).toBeGreaterThan(
      prompt.indexOf("Respond ONLY with raw JSON"),
    );
    expect(prompt).toContain("## Canonical Goal Brief and Execution Plan Output");
    expect(prompt).toContain("Match the stable planning schema above");
    expect(prompt).toContain("DAG dependencies");
    expect(prompt).toContain('backend: "claude_code"');
    expect(prompt).toContain("### Scout Phase");
    expect(prompt).toContain("### Needs Decision Gate");
    expect(prompt).toContain("### Goal Brief Phase");
    expect(prompt).toContain("### Planner Phase");
    expect(prompt.indexOf("### Scout Phase")).toBeLessThan(
      prompt.indexOf("### Needs Decision Gate"),
    );
    expect(prompt.indexOf("### Needs Decision Gate")).toBeLessThan(
      prompt.indexOf("### Goal Brief Phase"),
    );
    expect(prompt.indexOf("### Goal Brief Phase")).toBeLessThan(
      prompt.indexOf("### Planner Phase"),
    );
    expect(prompt).toContain(SCOUT_NEEDS_DECISION_FILE);
    expect(prompt).toContain("Specific means");
    expect(prompt).toContain("Measurable means");
    expect(prompt).toContain("Attainable means");
    expect(prompt).toContain("stop before goal-brief.md or execution_plan.json");
    expect(prompt).toContain("Goal Summary (max 140 characters)");
    expect(prompt).toContain("Goal Summary is WHOLE-GOAL scoped");
    expect(prompt).toContain("Plan Summary / First Plan Intent are plan-scoped");
    expect(prompt).toContain("Key Decision summaries");
    expect(prompt).not.toContain("{{WIKI_DIR}}");
    expect(prompt).toContain(
      path.join(
        managedRoot,
        "agent",
        "history",
        "goals",
        PENDING_WORKSPACE_SLUG,
        "run-scout-prefix",
        "wiki",
        "goal-brief.md",
      ),
    );
    expect(prompt).toContain(
      path.join(
        managedRoot,
        "agent",
        "history",
        "goals",
        PENDING_WORKSPACE_SLUG,
        "run-scout-prefix",
        "runtime",
        "scout",
        "execution_plan.json",
      ),
    );
    expect(prompt).toContain("Agent-visible planning artifact directory:");
    expect(prompt).not.toContain("full access to the filesystem");
    expect(prompt).not.toContain(".clawdbot-dev");
    expect(prompt).not.toContain(".clawdbot-dev/goals");
  });

  it("reconciles Claude scout artifacts written only to the advertised agent-history scout path", async () => {
    const runId = "run-agent-visible-reconcile";
    const privateGoalsDir = path.join(managedRoot, ".clawdbot-dev", "goals");
    const agentVisibleScoutDir = path.join(
      managedRoot,
      "agent",
      "history",
      "goals",
      PENDING_WORKSPACE_SLUG,
      runId,
      "runtime",
      "scout",
    );
    fs.mkdirSync(path.join(agentVisibleScoutDir, "node_specs"), { recursive: true });
    fs.writeFileSync(path.join(agentVisibleScoutDir, "plan_draft.md"), "stale draft", "utf8");
    fs.writeFileSync(
      path.join(agentVisibleScoutDir, "node_specs", "stale.md"),
      "stale node spec",
      "utf8",
    );

    mockRunCliProcess.mockImplementation(async (params: Record<string, unknown>) => {
      const prompt = typeof params.stdin === "string" ? params.stdin : "";
      expect(prompt).not.toContain(".clawdbot-dev");
      const match = /Agent-visible planning artifact directory: ([^\n]+)/.exec(prompt);
      if (!match?.[1]) throw new Error("missing agent-visible scout dir in prompt");
      const advertisedScoutDir = match[1].trim();
      expect(advertisedScoutDir).toBe(agentVisibleScoutDir);
      expect(fs.existsSync(path.join(advertisedScoutDir, "plan_draft.md"))).toBe(false);
      expect(fs.existsSync(path.join(advertisedScoutDir, "node_specs", "stale.md"))).toBe(false);

      fs.writeFileSync(String(params.stdoutPath), "planner stdout", "utf8");
      fs.writeFileSync(String(params.stderrPath), "", "utf8");
      writeScoutArtifacts(advertisedScoutDir, runId);
      const plan = {
        summary: "Reconciled scout artifacts",
        workingDir: "/tmp/test-wd",
        steps: [
          {
            id: "analyze-repo",
            description: "Inspect repository files and verify with a targeted test run",
            dependsOn: [],
            durationMinutes: 45,
            backend: "claude_code",
          },
        ],
      };
      fs.writeFileSync(path.join(advertisedScoutDir, EXECUTION_PLAN_FILE), JSON.stringify(plan));
      return {
        stdout: JSON.stringify(plan),
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 52,
      };
    });

    const result = await runCliPlanning({
      runId,
      goalText: "Plan with agent-visible scout artifacts",
      goalsDir: privateGoalsDir,
      enabledWorkers: ["claude_code"],
    });

    expect(result.status).toBe("success");
    expect(result.scoutStatus).toBe("success");
    const canonicalScoutDir = path.join(privateGoalsDir, runId, "scout");
    expect(fs.existsSync(path.join(canonicalScoutDir, "plan_draft.md"))).toBe(true);
    expect(fs.existsSync(path.join(canonicalScoutDir, "scout_report.json"))).toBe(true);
    expect(fs.existsSync(path.join(canonicalScoutDir, EXECUTION_PLAN_FILE))).toBe(true);
    expect(fs.existsSync(path.join(canonicalScoutDir, "node_specs", "analyze-repo.md"))).toBe(true);
  });

  it("redacts known secret values in planner stdout, raw output, and copied scout artifacts", async () => {
    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "FAKE_TELEGRAM_SECRET_123";
    try {
      mockDetectBackendAvailability.mockReturnValue([
        { id: "pi", available: true },
        { id: "codex", available: true },
        { id: "claude_code", available: false, reason: "not found" },
      ]);
      mockResolveClaudeBinary.mockReturnValue(null);

      mockRunCliProcess.mockImplementationOnce(async (params: Record<string, unknown>) => {
        const stdoutPath = String(params.stdoutPath);
        const canonicalScoutDir = path.dirname(stdoutPath);
        const codexScoutDir = path.join(os.tmpdir(), "moltbot-goal-planner", "run-redact", "scout");
        fs.writeFileSync(stdoutPath, "planner stdout FAKE_TELEGRAM_SECRET_123", "utf8");
        fs.writeFileSync(
          String(params.stderrPath),
          "planner stderr FAKE_TELEGRAM_SECRET_123",
          "utf8",
        );
        writeScoutArtifacts(codexScoutDir, "run-redact");
        fs.appendFileSync(
          path.join(codexScoutDir, "plan_draft.md"),
          "\ndraft FAKE_TELEGRAM_SECRET_123",
          "utf8",
        );
        fs.appendFileSync(
          path.join(codexScoutDir, "node_specs", "analyze-repo.md"),
          "\nnode FAKE_TELEGRAM_SECRET_123",
          "utf8",
        );
        fs.writeFileSync(
          path.join(codexScoutDir, EXECUTION_PLAN_FILE),
          JSON.stringify({
            summary: "Redaction plan",
            workingDir: "/tmp/test-wd",
            steps: [
              {
                id: "analyze-repo",
                description: "Inspect repository files",
                dependsOn: [],
                durationMinutes: 10,
                backend: "codex",
              },
            ],
          }),
          "utf8",
        );
        expect(canonicalScoutDir).toBe(path.join(goalsDir, "run-redact", "scout"));
        return {
          stdout:
            '{"summary":"Redaction plan","workingDir":"/tmp/test-wd","steps":[{"id":"analyze-repo","description":"Inspect repository files","dependsOn":[],"durationMinutes":10,"backend":"codex"}]} FAKE_TELEGRAM_SECRET_123',
          stderr: "planner stderr FAKE_TELEGRAM_SECRET_123",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 123,
        };
      });

      const result = await runCliPlanning({
        runId: "run-redact",
        goalText: "Create a tiny test artifact",
        goalsDir,
      });

      expect(result.status).toBe("success");
      const scoutDir = path.join(goalsDir, "run-redact", "scout");
      for (const artifactPath of [
        path.join(scoutDir, "planning_stdout.txt"),
        path.join(scoutDir, "planning_stderr.txt"),
        path.join(scoutDir, "planning_raw_output.txt"),
        path.join(scoutDir, "plan_draft.md"),
        path.join(scoutDir, "node_specs", "analyze-repo.md"),
      ]) {
        const persisted = fs.readFileSync(artifactPath, "utf8");
        expect(persisted).toContain("[REDACTED]");
        expect(persisted).not.toContain("FAKE_TELEGRAM_SECRET_123");
      }
    } finally {
      if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = previousToken;
    }
  });

  it("uses Claude-only planning when Codex is unavailable", async () => {
    mockDetectBackendAvailability.mockReturnValue([
      { id: "pi", available: true },
      { id: "codex", available: false, reason: "codex not found on PATH" },
      { id: "claude_code", available: true },
    ]);
    mockRunCliProcess.mockImplementation(async (params: Record<string, unknown>) => {
      expect(String(params.stdin).toLowerCase()).not.toContain("codex");
      return {
        stdout: JSON.stringify({
          summary: "Claude-only planning summary",
          workingDir: "/tmp/test-wd",
          steps: [
            {
              id: "claude-step",
              description: "Plan with the available worker",
              dependsOn: [],
              durationMinutes: 10,
              backend: "claude_code",
            },
          ],
        }),
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 40,
      };
    });

    const result = await runCliPlanning({
      runId: "run-claude-only",
      goalText: "Plan with the installed worker",
      goalsDir,
      includeScoutArtifacts: false,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.plan.steps[0]?.backend).toBe("claude_code");
    const procCall = mockRunCliProcess.mock.calls[0]?.[0] as { command: string };
    expect(procCall.command).toBe("/usr/bin/claude");
  });

  it("throws an actionable setup error when no planner backend is available", async () => {
    mockResolveClaudeBinary.mockReturnValue(null);
    mockDetectBackendAvailability.mockReturnValue([
      { id: "pi", available: true },
      { id: "codex", available: false, reason: "codex not found on PATH" },
      { id: "claude_code", available: false, reason: "claude not found on PATH" },
    ]);

    await expect(
      runCliPlanning({
        runId: "run-no-backend",
        goalText: "Plan without tools",
        goalsDir,
        includeScoutArtifacts: false,
      }),
    ).rejects.toThrow("No worker backend available. Install Codex or Claude Code and rerun.");
  });

  it("writes canonical execution plan with buildGate and step metadata", async () => {
    mockRunCliProcess.mockResolvedValue({
      stdout: JSON.stringify({
        summary: "Plan with verification metadata",
        workingDir: "/tmp/test-wd",
        buildGate: {
          commands: ["pnpm build"],
          runBetweenSteps: true,
        },
        steps: [
          {
            id: "impl-step",
            description: "Implement and verify",
            dependsOn: [],
            successCriteria: "pnpm build exits 0",
            constraints: ["Do not narrow tsconfig include"],
            durationMinutes: 20,
            backend: "codex",
          },
        ],
      }),
      stderr: "",
      timedOut: false,
      exitCode: 0,
      signal: null,
      durationMs: 40,
    });

    const result = await runCliPlanning({
      runId: "run-canonical-build-gate",
      goalText: "Write canonical plan artifact",
      goalsDir,
      includeScoutArtifacts: false,
    });

    expect(result.status).toBe("success");
    const planPath = path.join(goalsDir, "run-canonical-build-gate", "scout", EXECUTION_PLAN_FILE);
    const savedPlan = JSON.parse(fs.readFileSync(planPath, "utf8")) as Record<string, unknown>;
    expect(savedPlan.buildGate).toEqual({
      commands: ["pnpm build"],
      runBetweenSteps: true,
    });
    const firstStep = ((savedPlan.steps as unknown[])?.[0] ?? {}) as Record<string, unknown>;
    expect(firstStep.successCriteria).toBe("pnpm build exits 0");
    expect(firstStep.constraints).toEqual(["Do not narrow tsconfig include"]);
  });

  it("returns blocked-at-planning with decisions when a decision artifact is produced", async () => {
    mockRunCliProcess.mockImplementation(async (params: Record<string, unknown>) => {
      const scoutDir = path.dirname(String(params.stdoutPath));
      fs.mkdirSync(scoutDir, { recursive: true });
      fs.writeFileSync(String(params.stdoutPath), "blocked", "utf8");
      fs.writeFileSync(String(params.stderrPath), "", "utf8");
      writeNeedsDecisionArtifact(scoutDir);
      return {
        stdout: '{"blocked":true,"question":"Which deployment target should this use?"}',
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 88,
      };
    });

    const result = await runCliPlanning({
      runId: "run-blocked",
      goalText: "Deploy this change",
      goalsDir,
    });

    expect(result).toEqual({
      status: "blocked",
      question: [
        "Decision(s) needed:",
        "Decision 1. Which deployment target should this use?",
        "(A) Staging (Recommended)",
        "(B) Production",
      ].join("\n"),
      decisions: [
        {
          id: "deployment-target",
          question: "Which deployment target should this use?",
          options: [
            { key: "A", label: "Staging", recommended: true },
            { key: "B", label: "Production" },
          ],
        },
      ],
      scoutStatus: "needs_decision",
    });
    expect(mockRunCliProcess).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(goalBriefPathForRun("run-blocked"))).toBe(false);

    const attemptPath = path.join(goalsDir, "run-blocked", "scout", "attempt-1.json");
    const attempt = JSON.parse(fs.readFileSync(attemptPath, "utf8")) as Record<string, unknown>;
    expect(attempt.outcome).toBe("blocked");
    expect(attempt.errorClassification).toBe("needs_decision");
  });

  it("lets the decision gate block before accepting a plan artifact", async () => {
    mockRunCliProcess.mockImplementation(async (params: Record<string, unknown>) => {
      const scoutDir = path.dirname(String(params.stdoutPath));
      fs.mkdirSync(scoutDir, { recursive: true });
      fs.writeFileSync(String(params.stdoutPath), "blocked", "utf8");
      fs.writeFileSync(String(params.stderrPath), "", "utf8");
      writeNeedsDecisionArtifact(scoutDir, [
        {
          id: "success-boundary",
          question: "What should count as a successful migration?",
          options: [
            { key: "A", label: "Typecheck and focused tests", recommended: true },
            { key: "B", label: "Full deployment proof" },
          ],
        },
      ]);
      const prematurePlan = {
        summary: "This plan should not be accepted",
        workingDir: "/tmp/test-wd",
        steps: [
          {
            id: "premature-plan",
            description: "Do work before the user decision",
            dependsOn: [],
            durationMinutes: 10,
            backend: "codex",
          },
        ],
      };
      fs.writeFileSync(
        path.join(scoutDir, EXECUTION_PLAN_FILE),
        JSON.stringify(prematurePlan, null, 2),
        "utf8",
      );
      return {
        stdout: JSON.stringify(prematurePlan),
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 90,
      };
    });

    const result = await runCliPlanning({
      runId: "run-decision-beats-plan",
      goalText: "Migrate this system",
      goalsDir,
    });

    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.scoutStatus).toBe("needs_decision");
      expect(result.question).toContain("What should count as a successful migration?");
      expect(result.decisions?.[0]?.id).toBe("success-boundary");
    }
  });

  it("honors stdout-only blocked JSON before scout artifact validation (no plan files)", async () => {
    // Reproduces the ordering bug: the planner deliberately blocked (e.g. an invalid
    // observed-runtime workingDir) and wrote NO plan_draft.md / decision artifact.
    // The blocked stdout response must be authoritative — not surfaced as the misleading
    // scout-artifact failure "Planning scout artifacts invalid: plan_draft.md not found".
    mockRunCliProcess.mockImplementation(async (params: Record<string, unknown>) => {
      const scoutDir = path.dirname(String(params.stdoutPath));
      fs.mkdirSync(scoutDir, { recursive: true });
      fs.writeFileSync(String(params.stdoutPath), "blocked", "utf8");
      fs.writeFileSync(String(params.stderrPath), "", "utf8");
      // Intentionally write NO plan_draft.md, decision artifact, or execution_plan.json.
      return {
        stdout:
          '{"blocked":true,"question":"This workspace is an observed dev runtime surface and cannot be used as an executable working dir. Pick a managed workspace."}',
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 71,
      };
    });

    const result = await runCliPlanning({
      runId: "run-blocked-stdout-only",
      goalText: "Build in /home/matt/smithersbot-dev-home/agent/workspaces/smithersbot-dev",
      goalsDir,
    });

    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.question).toContain("observed dev runtime surface");
      // Clean actionable decision prompt — never the generic scout-artifact failure or
      // the generic "Planning failed:" formatting.
      expect(result.question).not.toContain("plan_draft.md not found");
      expect(result.question).not.toContain("Planning scout artifacts invalid");
      expect(result.question).not.toContain("Planning failed");
    }

    // No execution plan / branch / worker side effects: an intentional block must not
    // produce a canonical execution_plan.json artifact.
    const scoutDir = path.join(goalsDir, "run-blocked-stdout-only", "scout");
    expect(fs.existsSync(path.join(scoutDir, EXECUTION_PLAN_FILE))).toBe(false);

    // The attempt bundle records a blocked outcome routed through the Needs Decision
    // transport, not a failed/validation outcome.
    const attempt = JSON.parse(
      fs.readFileSync(path.join(scoutDir, "attempt-1.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(attempt.outcome).toBe("blocked");
    expect(attempt.errorClassification).toBe("needs_decision");
  });

  it("does not throw a generic planning failure for an intentional stdout-only block", async () => {
    mockRunCliProcess.mockImplementation(async (params: Record<string, unknown>) => {
      const scoutDir = path.dirname(String(params.stdoutPath));
      fs.mkdirSync(scoutDir, { recursive: true });
      fs.writeFileSync(String(params.stdoutPath), "blocked", "utf8");
      fs.writeFileSync(String(params.stderrPath), "", "utf8");
      return {
        stdout: '{"blocked":true,"question":"Which deployment target should this use?"}',
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 64,
      };
    });

    // Must resolve to a blocked result, never reject with a generic planning error.
    await expect(
      runCliPlanning({
        runId: "run-blocked-stdout-only-2",
        goalText: "Deploy this change",
        goalsDir,
      }),
    ).resolves.toMatchObject({ status: "blocked", scoutStatus: "skipped" });
  });

  it("clears stale decision artifacts before replanning the same run", async () => {
    const runId = "run-replan-stale-decision";
    let planningAttempt = 0;

    mockRunCliProcess.mockImplementation(async (params: Record<string, unknown>) => {
      planningAttempt += 1;
      const scoutDir = path.dirname(String(params.stdoutPath));
      fs.writeFileSync(String(params.stderrPath), "", "utf8");

      if (planningAttempt === 1) {
        fs.writeFileSync(String(params.stdoutPath), "blocked", "utf8");
        writeNeedsDecisionArtifact(scoutDir);
        return {
          stdout: '{"blocked":true,"question":"Which deployment target should this use?"}',
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 76,
        };
      }

      const successPlan = {
        summary: "Unified planning summary",
        workingDir: "/tmp/test-wd",
        steps: [
          {
            id: "analyze-repo",
            description: "Inspect repository files and verify with a targeted test run",
            dependsOn: [],
            durationMinutes: 45,
            backend: "codex",
          },
        ],
      };
      fs.writeFileSync(String(params.stdoutPath), JSON.stringify(successPlan), "utf8");
      writeScoutArtifacts(scoutDir, runId);
      fs.writeFileSync(
        path.join(scoutDir, EXECUTION_PLAN_FILE),
        JSON.stringify(successPlan, null, 2),
        "utf8",
      );
      return {
        stdout: JSON.stringify(successPlan),
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 82,
      };
    });

    const firstResult = await runCliPlanning({
      runId,
      goalText: "Deploy this change",
      goalsDir,
    });
    expect(firstResult.status).toBe("blocked");

    const scoutDir = path.join(goalsDir, runId, "scout");
    expect(fs.existsSync(path.join(scoutDir, SCOUT_NEEDS_DECISION_FILE))).toBe(true);

    const secondResult = await runCliPlanning({
      runId,
      goalText: "Deploy this change",
      goalsDir,
    });

    expect(secondResult.status).toBe("success");
    expect(secondResult.scoutStatus).toBe("success");
    expect(fs.existsSync(path.join(scoutDir, SCOUT_NEEDS_DECISION_FILE))).toBe(false);
  });

  it("clears all stale artifact types (draft, report, node_specs, raw_output) before replanning", async () => {
    const runId = "run-replan-all-artifacts";
    let planningAttempt = 0;

    mockRunCliProcess.mockImplementation(async (params: Record<string, unknown>) => {
      planningAttempt += 1;
      const scoutDir = path.dirname(String(params.stdoutPath));
      fs.writeFileSync(String(params.stderrPath), "", "utf8");

      if (planningAttempt === 1) {
        // First attempt: produce all artifacts plus a decision file
        writeScoutArtifacts(scoutDir, runId);
        fs.writeFileSync(
          path.join(scoutDir, EXECUTION_PLAN_FILE),
          JSON.stringify({ summary: "stale", workingDir: "/tmp/test-wd", steps: [] }),
          "utf8",
        );
        fs.writeFileSync(String(params.stdoutPath), "blocked", "utf8");
        writeNeedsDecisionArtifact(scoutDir, [
          {
            id: "database-target",
            question: "Which DB should we use?",
            options: [
              { key: "A", label: "SQLite", recommended: true },
              { key: "B", label: "Postgres" },
            ],
          },
        ]);
        return {
          stdout: '{"blocked":true,"question":"Which DB should we use?"}',
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 70,
        };
      }

      // Second attempt: verify stale artifacts were removed before we run
      // If clearStalePlanningArtifacts works, these should NOT exist at this point
      const staleFiles = [
        SCOUT_NEEDS_DECISION_FILE,
        "plan_draft.md",
        "scout_report.json",
        EXECUTION_PLAN_FILE,
        "planning_raw_output.txt",
      ];
      const staleNodeSpecs = path.join(scoutDir, "node_specs");
      const survivingStale = staleFiles.filter((f) => fs.existsSync(path.join(scoutDir, f)));
      if (survivingStale.length > 0) {
        throw new Error(`Stale artifacts not cleared: ${survivingStale.join(", ")}`);
      }
      if (fs.existsSync(staleNodeSpecs) && fs.readdirSync(staleNodeSpecs).length > 0) {
        throw new Error("Stale node_specs/ directory was not cleared");
      }
      if (fs.existsSync(goalBriefPathForRun(runId))) {
        throw new Error("Stale goal-brief.md was not cleared");
      }

      // Produce fresh success artifacts
      const successPlan = {
        summary: "Fresh plan after cleanup",
        workingDir: "/tmp/test-wd",
        steps: [
          {
            id: "impl-step",
            description: "Implement the feature",
            dependsOn: [],
            durationMinutes: 30,
            backend: "codex",
          },
        ],
      };
      fs.writeFileSync(String(params.stdoutPath), JSON.stringify(successPlan), "utf8");
      writeScoutArtifacts(scoutDir, runId);
      fs.writeFileSync(
        path.join(scoutDir, EXECUTION_PLAN_FILE),
        JSON.stringify(successPlan, null, 2),
        "utf8",
      );
      return {
        stdout: JSON.stringify(successPlan),
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 90,
      };
    });

    const firstResult = await runCliPlanning({ runId, goalText: "Set up DB", goalsDir });
    expect(firstResult.status).toBe("blocked");

    const secondResult = await runCliPlanning({ runId, goalText: "Set up DB", goalsDir });
    expect(secondResult.status).toBe("success");
    if (secondResult.status === "success") {
      expect(secondResult.plan.summary).toBe("Fresh plan after cleanup");
    }
  });

  it("handles triple replan: decision → decision → success", async () => {
    const runId = "run-triple-replan";
    let planningAttempt = 0;

    mockRunCliProcess.mockImplementation(async (params: Record<string, unknown>) => {
      planningAttempt += 1;
      const scoutDir = path.dirname(String(params.stdoutPath));
      fs.writeFileSync(String(params.stderrPath), "", "utf8");

      if (planningAttempt <= 2) {
        const question =
          planningAttempt === 1 ? "Which framework should we use?" : "Which deployment target?";
        fs.writeFileSync(String(params.stdoutPath), "blocked", "utf8");
        writeNeedsDecisionArtifact(scoutDir, [
          {
            id: planningAttempt === 1 ? "framework-choice" : "deployment-target",
            question,
            options: [
              { key: "A", label: "Recommended path", recommended: true },
              { key: "B", label: "Alternative path" },
            ],
          },
        ]);
        return {
          stdout: JSON.stringify({ blocked: true, question }),
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 60 + planningAttempt * 10,
        };
      }

      // Third attempt: success
      const successPlan = {
        summary: "Final plan after two decisions",
        workingDir: "/tmp/test-wd",
        steps: [
          {
            id: "deploy",
            description: "Deploy to production",
            dependsOn: [],
            durationMinutes: 20,
            backend: "codex",
          },
        ],
      };
      fs.writeFileSync(String(params.stdoutPath), JSON.stringify(successPlan), "utf8");
      writeScoutArtifacts(scoutDir, runId);
      fs.writeFileSync(
        path.join(scoutDir, EXECUTION_PLAN_FILE),
        JSON.stringify(successPlan, null, 2),
        "utf8",
      );
      return {
        stdout: JSON.stringify(successPlan),
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 95,
      };
    });

    // First planning attempt → blocked
    const r1 = await runCliPlanning({ runId, goalText: "Deploy app", goalsDir });
    expect(r1.status).toBe("blocked");
    if (r1.status === "blocked") {
      expect(r1.question).toContain("Decision 1. Which framework should we use?");
      expect(r1.decisions?.[0]?.id).toBe("framework-choice");
    }

    // Second planning attempt → blocked again (different question)
    const r2 = await runCliPlanning({ runId, goalText: "Deploy app", goalsDir });
    expect(r2.status).toBe("blocked");
    if (r2.status === "blocked") {
      expect(r2.question).toContain("Decision 1. Which deployment target?");
      expect(r2.decisions?.[0]?.id).toBe("deployment-target");
    }

    // Third planning attempt → success (stale decision from r2 is cleared)
    const r3 = await runCliPlanning({ runId, goalText: "Deploy app", goalsDir });
    expect(r3.status).toBe("success");
    if (r3.status === "success") {
      expect(r3.plan.summary).toBe("Final plan after two decisions");
    }

    // Verify no stale decision file remains
    const scoutDir = path.join(goalsDir, runId, "scout");
    expect(fs.existsSync(path.join(scoutDir, SCOUT_NEEDS_DECISION_FILE))).toBe(false);
  });

  it("throws PlanParseError when planner output is invalid and still writes diagnostics", async () => {
    mockRunCliProcess.mockImplementation(async (params: Record<string, unknown>) => {
      const scoutDir = path.dirname(String(params.stdoutPath));
      fs.writeFileSync(String(params.stdoutPath), "also not json", "utf8");
      fs.writeFileSync(String(params.stderrPath), "", "utf8");
      writeScoutArtifacts(scoutDir, "run-parse-fail");
      fs.writeFileSync(path.join(scoutDir, EXECUTION_PLAN_FILE), "not json", "utf8");
      return {
        stdout: "also not json",
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 42,
      };
    });

    await expect(
      runCliPlanning({
        runId: "run-parse-fail",
        goalText: "Create a tiny test artifact",
        goalsDir,
      }),
    ).rejects.toBeInstanceOf(PlanParseError);

    const scoutDir = path.join(goalsDir, "run-parse-fail", "scout");
    expect(fs.readFileSync(path.join(scoutDir, "planning_raw_output.txt"), "utf8")).toBe(
      "also not json",
    );

    const attempt = JSON.parse(
      fs.readFileSync(path.join(scoutDir, "attempt-1.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(attempt.outcome).toBe("failed");
    expect(attempt.errorClassification).toBe("parse");
  });

  it("throws validation errors for invalid plan JSON shape and still writes diagnostics", async () => {
    const invalidPlanJson = JSON.stringify({
      summary: "Missing backend field",
      workingDir: "/tmp/test-wd",
      steps: [
        {
          id: "analyze-repo",
          description: "Inspect repository files",
          dependsOn: [],
          durationMinutes: 30,
        },
      ],
    });

    mockRunCliProcess.mockImplementation(async (params: Record<string, unknown>) => {
      const scoutDir = path.dirname(String(params.stdoutPath));
      fs.writeFileSync(String(params.stdoutPath), invalidPlanJson, "utf8");
      fs.writeFileSync(String(params.stderrPath), "", "utf8");
      writeScoutArtifacts(scoutDir, "run-validation-fail");
      fs.writeFileSync(path.join(scoutDir, EXECUTION_PLAN_FILE), invalidPlanJson, "utf8");
      return {
        stdout: invalidPlanJson,
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 51,
      };
    });

    await expect(
      runCliPlanning({
        runId: "run-validation-fail",
        goalText: "Create a tiny test artifact",
        goalsDir,
      }),
    ).rejects.toThrow("backend is required");

    const scoutDir = path.join(goalsDir, "run-validation-fail", "scout");
    expect(fs.readFileSync(path.join(scoutDir, "planning_raw_output.txt"), "utf8")).toBe(
      invalidPlanJson,
    );

    const attempt = JSON.parse(
      fs.readFileSync(path.join(scoutDir, "attempt-1.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(attempt.outcome).toBe("failed");
    expect(attempt.errorClassification).toBe("validation");
  });

  it("uses codex immediately when only codex is enabled", async () => {
    mockResolveClaudeBinary.mockReturnValue(undefined);
    mockRunCliProcess.mockResolvedValue({
      stdout: JSON.stringify({
        summary: "Codex only planning summary",
        workingDir: "/tmp/test-wd",
        steps: [
          {
            id: "analyze-repo",
            description: "Inspect repository files and verify with a targeted test run",
            dependsOn: [],
            durationMinutes: 45,
            backend: "codex",
          },
        ],
      }),
      stderr: "",
      timedOut: false,
      exitCode: 0,
      signal: null,
      durationMs: 33,
    });

    const result = await runCliPlanning({
      runId: "run-codex-only",
      goalText: "Create codex-only plan",
      goalsDir,
      includeScoutArtifacts: false,
      enabledWorkers: ["codex"],
    });

    expect(result.status).toBe("success");
    expect(mockRunCliProcess).toHaveBeenCalledTimes(1);
    const onlyCall = mockRunCliProcess.mock.calls[0]?.[0] as { command: string; args: string[] };
    expect(onlyCall.command).toBe("codex");
    expect(onlyCall.args).toContain("exec");
  });

  it("throws a clear error when only claude_code is enabled and Anthropic degrades", async () => {
    mockRunCliProcess.mockResolvedValueOnce({
      stdout: "",
      stderr: "Planning execution failed: You've hit your limit · resets 6pm (America/Toronto)",
      timedOut: false,
      exitCode: 1,
      signal: null,
      durationMs: 31,
    });

    await expect(
      runCliPlanning({
        runId: "run-claude-only-degraded",
        goalText: "Create claude-only plan",
        goalsDir,
        includeScoutArtifacts: false,
        enabledWorkers: ["claude_code"],
      }),
    ).rejects.toThrow("codex fallback is disabled by goal.enabledWorkers");

    expect(mockRunCliProcess).toHaveBeenCalledTimes(1);
    const onlyCall = mockRunCliProcess.mock.calls[0]?.[0] as { command: string };
    expect(onlyCall.command).toBe("/usr/bin/claude");
  });

  it("treats Anthropic 529 overloaded as transient overload, not a rate limit", async () => {
    vi.useFakeTimers();
    try {
      mockRunCliProcess.mockResolvedValue({
        stdout: "",
        stderr: "API Error: 529 Overloaded",
        timedOut: false,
        exitCode: 1,
        signal: null,
        durationMs: 31,
      });

      const planning = runCliPlanning({
        runId: "run-claude-529-overloaded",
        goalText: "Create claude-only plan",
        goalsDir,
        includeScoutArtifacts: false,
        enabledWorkers: ["claude_code"],
      }).catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(15_000);

      const caught = await planning;
      expect(caught).toBeInstanceOf(Error);
      const message = caught instanceof Error ? caught.message : String(caught);
      expect(message).toContain(
        "Anthropic Claude Code is temporarily overloaded (529/provider 5xx)",
      );
      expect(message).not.toContain("rate limit reached");
      expect(mockRunCliProcess).toHaveBeenCalledTimes(3);
      expect(
        mockRunCliProcess.mock.calls.every(
          (call) => (call[0] as { command: string }).command === "/usr/bin/claude",
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats Anthropic server-side issue text as transient overload, not a rate limit", async () => {
    vi.useFakeTimers();
    try {
      mockRunCliProcess
        .mockResolvedValueOnce({
          stdout: "",
          stderr: "Anthropic API server-side issue. Please retry.",
          timedOut: false,
          exitCode: 1,
          signal: null,
          durationMs: 31,
        })
        .mockResolvedValueOnce({
          stdout: "",
          stderr: "Anthropic API server-side issue. Please retry.",
          timedOut: false,
          exitCode: 1,
          signal: null,
          durationMs: 31,
        })
        .mockResolvedValueOnce({
          stdout: "",
          stderr: "Anthropic API server-side issue. Please retry.",
          timedOut: false,
          exitCode: 1,
          signal: null,
          durationMs: 31,
        })
        .mockResolvedValueOnce({
          stdout: JSON.stringify({
            summary: "Fallback after overload",
            workingDir: "/tmp/test-wd",
            steps: [
              {
                id: "fallback-step",
                description: "Plan after transient overload",
                dependsOn: [],
                durationMinutes: 10,
                backend: "codex",
              },
            ],
          }),
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 53,
        });

      const planning = runCliPlanning({
        runId: "run-server-side-overload",
        goalText: "Create fallback plan",
        goalsDir,
        includeScoutArtifacts: false,
        enabledWorkers: ["claude_code", "codex"],
      });
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await planning;

      expect(result.status).toBe("success");
      expect(result.plannerBackendUsed).toBe("codex");
      expect(result.plannerDegradedReason).toBe("anthropic_overloaded");
      expect(result.plannerDegradedReason).not.toBe("anthropic_rate_limit");
      expect(mockRunCliProcess).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still classifies true Anthropic usage-limit text as a usage limit", async () => {
    mockRunCliProcess.mockResolvedValueOnce({
      stdout: "",
      stderr: "Planning execution failed: You've hit your usage limit · resets 6pm",
      timedOut: false,
      exitCode: 1,
      signal: null,
      durationMs: 31,
    });

    await expect(
      runCliPlanning({
        runId: "run-claude-usage-limit",
        goalText: "Create claude-only plan",
        goalsDir,
        includeScoutArtifacts: false,
        enabledWorkers: ["claude_code"],
      }),
    ).rejects.toThrow("Anthropic usage limit reached");
    expect(mockRunCliProcess).toHaveBeenCalledTimes(1);
  });

  it("still classifies true Anthropic 429/rate-limit text as a rate limit", async () => {
    mockRunCliProcess.mockResolvedValueOnce({
      stdout: "",
      stderr: "API Error: 429 rate limit exceeded",
      timedOut: false,
      exitCode: 1,
      signal: null,
      durationMs: 31,
    });

    await expect(
      runCliPlanning({
        runId: "run-claude-429-rate-limit",
        goalText: "Create claude-only plan",
        goalsDir,
        includeScoutArtifacts: false,
        enabledWorkers: ["claude_code"],
      }),
    ).rejects.toThrow("Anthropic rate limit reached");
    expect(mockRunCliProcess).toHaveBeenCalledTimes(1);
  });

  it("retries transient overload on the same Claude backend before failing over", async () => {
    vi.useFakeTimers();
    try {
      mockRunCliProcess
        .mockResolvedValueOnce({
          stdout: "",
          stderr: "API Error: 529 Overloaded",
          timedOut: false,
          exitCode: 1,
          signal: null,
          durationMs: 31,
        })
        .mockResolvedValueOnce({
          stdout: "",
          stderr: "API Error: 529 Overloaded",
          timedOut: false,
          exitCode: 1,
          signal: null,
          durationMs: 32,
        })
        .mockResolvedValueOnce({
          stdout: JSON.stringify({
            summary: "Recovered after overload",
            workingDir: "/tmp/test-wd",
            steps: [
              {
                id: "claude-step",
                description: "Plan after transient retry",
                dependsOn: [],
                durationMinutes: 10,
                backend: "claude_code",
              },
            ],
          }),
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 40,
        });

      const planning = runCliPlanning({
        runId: "run-claude-overload-retry-success",
        goalText: "Create claude plan",
        goalsDir,
        includeScoutArtifacts: false,
        enabledWorkers: ["claude_code", "codex"],
      });
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await planning;

      expect(result.status).toBe("success");
      expect(result.plannerDegradedReason).toBeUndefined();
      expect(mockRunCliProcess).toHaveBeenCalledTimes(3);
      expect(
        mockRunCliProcess.mock.calls.every(
          (call) => (call[0] as { command: string }).command === "/usr/bin/claude",
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to codex on Anthropic limits and rewrites all claude_code steps", async () => {
    mockRunCliProcess
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "Planning execution failed: You've hit your limit · resets 6pm (America/Toronto)",
        timedOut: false,
        exitCode: 1,
        signal: null,
        durationMs: 31,
      })
      .mockImplementationOnce(async (params: Record<string, unknown>) => {
        const stdoutPath = String(params.stdoutPath);
        const scoutDir = path.dirname(stdoutPath);
        fs.writeFileSync(stdoutPath, "planner stdout", "utf8");
        fs.writeFileSync(String(params.stderrPath), "", "utf8");
        writeScoutArtifacts(scoutDir, "run-fallback");
        fs.writeFileSync(
          path.join(scoutDir, EXECUTION_PLAN_FILE),
          JSON.stringify(
            {
              summary: "Fallback planning summary",
              workingDir: "/tmp/test-wd",
              steps: [
                {
                  id: "analyze-repo",
                  description: "Inspect repository files and verify with a targeted test run",
                  dependsOn: [],
                  durationMinutes: 45,
                  backend: "claude_code",
                },
              ],
            },
            null,
            2,
          ),
          "utf8",
        );
        return {
          stdout:
            '{"summary":"Fallback planning summary","workingDir":"/tmp/test-wd","steps":[{"id":"analyze-repo","description":"Inspect repository files and verify with a targeted test run","dependsOn":[],"durationMinutes":45,"backend":"claude_code"}]}',
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 53,
        };
      });

    const result = await runCliPlanning({
      runId: "run-fallback",
      goalText: "Create fallback plan",
      goalsDir,
      enabledWorkers: ["codex", "claude_code"],
    });

    expect(result.status).toBe("success");
    expect(result.plannerBackendUsed).toBe("codex");
    expect(result.plannerDegradedReason).toBe("anthropic_usage_limit");
    expect(result.plannerDegradedResetHint).toBe("resets 6pm (America/Toronto)");
    if (result.status === "success") {
      expect(result.plan.steps.every((step) => step.backend === "codex")).toBe(true);
      expect(result.plan.steps.every((step) => step.executedBackend !== "claude_code")).toBe(true);
    }

    expect(mockRunCliProcess).toHaveBeenCalledTimes(2);
    const firstCall = mockRunCliProcess.mock.calls[0]?.[0] as { command: string };
    const secondCall = mockRunCliProcess.mock.calls[1]?.[0] as { command: string };
    expect(firstCall.command).toBe("/usr/bin/claude");
    expect(secondCall.command).toBe("codex");

    const events = readPlannerHistoryEvents("run-fallback", PENDING_WORKSPACE_SLUG);
    expect(events.map((event) => event.event)).toEqual([
      "launch",
      "failure",
      "fallback",
      "launch",
      "result",
    ]);
    expect(events[1]).toMatchObject({
      event: "failure",
      backend: "claude_code",
      status: "crash",
      errorClass: "rate_limit",
    });
    expect(events[2]).toMatchObject({
      event: "fallback",
      backend: "claude_code",
      status: "anthropic_usage_limit",
      fallbackBackend: "codex",
    });
    expect(events[3]).toMatchObject({
      event: "launch",
      backend: "codex",
      status: "launching",
    });
  });

  it("falls back to the other backend on a non-zero planning subprocess crash", async () => {
    const runId = "run-generic-crash-fallback";
    mockRunCliProcess
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "segmentation fault while planning",
        timedOut: false,
        exitCode: 1,
        signal: null,
        durationMs: 11,
      })
      .mockImplementationOnce(async (params: Record<string, unknown>) => {
        const scoutDir = path.dirname(String(params.stdoutPath));
        const plan = {
          summary: "Recovered after generic crash",
          workingDir: "/tmp/test-wd",
          steps: [
            {
              id: "analyze-repo",
              description: "Inspect repository files and verify with a targeted test run",
              dependsOn: [],
              durationMinutes: 20,
              backend: "codex",
            },
          ],
        };
        writeScoutArtifacts(scoutDir, runId);
        fs.writeFileSync(path.join(scoutDir, EXECUTION_PLAN_FILE), JSON.stringify(plan), "utf8");
        return {
          stdout: JSON.stringify(plan),
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 30,
        };
      });

    const result = await runCliPlanning({
      runId,
      goalText: "Recover from a planner crash",
      goalsDir,
      enabledWorkers: ["claude_code", "codex"],
    });

    expect(result.status).toBe("success");
    expect(mockRunCliProcess).toHaveBeenCalledTimes(2);
    expect((mockRunCliProcess.mock.calls[0]![0] as { command: string }).command).toBe(
      "/usr/bin/claude",
    );
    expect((mockRunCliProcess.mock.calls[1]![0] as { command: string }).command).toBe("codex");

    const events = readPlannerHistoryEvents(runId);
    expect(events.find((event) => event.event === "fallback")).toMatchObject({
      backend: "claude_code",
      status: "crash",
      fallbackBackend: "codex",
    });
  });

  it("copies codex fallback scout artifacts from writable temp dir into canonical scout dir", async () => {
    mockRunCliProcess
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "Planning execution failed: You've hit your limit · resets 6pm (America/Toronto)",
        timedOut: false,
        exitCode: 1,
        signal: null,
        durationMs: 30,
      })
      .mockImplementationOnce(async (params: Record<string, unknown>) => {
        const args = (params.args as string[]) ?? [];
        const prompt = String(args.at(-1) ?? "");
        const outDirMatch = /Agent-visible planning artifact directory: ([^\n]+)/.exec(prompt);
        if (!outDirMatch?.[1])
          throw new Error("expected codex prompt to include agent-visible output dir");
        expect(outDirMatch[1]).toBe(
          path.join(
            managedRoot,
            "agent",
            "history",
            "goals",
            PENDING_WORKSPACE_SLUG,
            "run-codex-copy",
            "runtime",
            "scout",
          ),
        );
        const codexScoutDir = path.dirname(String(params.stdoutPath));
        writeScoutArtifacts(codexScoutDir, "run-codex-copy");
        fs.writeFileSync(
          path.join(codexScoutDir, EXECUTION_PLAN_FILE),
          JSON.stringify(
            {
              summary: "Codex copied artifacts",
              workingDir: "/tmp/test-wd",
              steps: [
                {
                  id: "analyze-repo",
                  description: "Inspect repository files and verify with a targeted test run",
                  dependsOn: [],
                  durationMinutes: 45,
                  backend: "codex",
                },
              ],
            },
            null,
            2,
          ),
          "utf8",
        );
        return {
          stdout:
            '{"summary":"Codex copied artifacts","workingDir":"/tmp/test-wd","steps":[{"id":"analyze-repo","description":"Inspect repository files and verify with a targeted test run","dependsOn":[],"durationMinutes":45,"backend":"codex"}]}',
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 49,
        };
      });

    const result = await runCliPlanning({
      runId: "run-codex-copy",
      goalText: "Create fallback plan with copied artifacts",
      goalsDir,
    });

    expect(result.status).toBe("success");
    const canonicalScoutDir = path.join(goalsDir, "run-codex-copy", "scout");
    expect(fs.existsSync(path.join(canonicalScoutDir, "plan_draft.md"))).toBe(true);
    expect(fs.existsSync(path.join(canonicalScoutDir, "scout_report.json"))).toBe(true);
    expect(fs.existsSync(path.join(canonicalScoutDir, EXECUTION_PLAN_FILE))).toBe(true);
  });

  it("runs CLI plan revision with subscription auth and parses revised plan", async () => {
    process.env.ANTHROPIC_API_KEY = "should-be-stripped";
    process.env.ANTHROPIC_AUTH_TOKEN = "should-be-stripped";
    process.env.ANTHROPIC_API_KEY_OLD = "should-be-stripped";
    process.env.ANTHROPIC_BASE_URL = "https://proxy.invalid";

    mockRunCliProcess.mockResolvedValue({
      stdout: JSON.stringify({
        summary: "Revised summary",
        workingDir: "/tmp/test-wd",
        steps: [
          {
            id: "refine-auth",
            description: "Adjust auth flow and verify behavior",
            dependsOn: [],
            durationMinutes: 30,
            backend: "codex",
          },
        ],
      }),
      stderr: "",
      timedOut: false,
      exitCode: 0,
      signal: null,
      durationMs: 64,
    });

    const result = await runCliPlanRevision({
      runId: "run-revision",
      goalText: "Refine auth flow",
      currentPlan: {
        goal: "Refine auth flow",
        summary: "Original summary",
        workingDir: "/tmp/test-wd",
        steps: [
          {
            id: "step-1",
            description: "Initial step",
            dependsOn: [],
            status: "pending",
            durationMinutes: 45,
            backend: "codex",
          },
        ],
      },
      editInstructions: "Tighten validation logic",
      goalsDir,
      model: "claude-sonnet-4-20250514",
    });
    const revisedPlan = result.plan;

    if ("blocked" in revisedPlan) throw new Error("Expected plan result, got blocked");
    expect(revisedPlan.summary).toBe("Revised summary");
    expect(revisedPlan.steps[0]?.id).toBe("refine-auth");
    expect(result.plannerBackendUsed).toBe("claude_code");
    expect(result.plannerDegradedReason).toBeUndefined();
    expect(result.plannerDegradedResetHint).toBeUndefined();

    const procCall = mockRunCliProcess.mock.calls[0]?.[0] as {
      env: Record<string, string | undefined>;
      args: string[];
      cwd: string;
    };
    expect(procCall.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(procCall.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(procCall.env.ANTHROPIC_API_KEY_OLD).toBeUndefined();
    expect(procCall.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(procCall.args).toContain("--model");
    expect(procCall.args).toContain("claude-sonnet-4-20250514");
    expect(procCall.args).toContain("--settings");
    expect(procCall.args).toContain("--setting-sources");
    expect(procCall.args).not.toContain("--dangerously-skip-permissions");
    expect(procCall.args).not.toContain("--allow-dangerously-skip-permissions");
    expect(procCall.cwd).toBe(process.cwd());
    const settingsPath = procCall.args[procCall.args.indexOf("--settings") + 1];
    const settings = JSON.parse(fs.readFileSync(settingsPath!, "utf8")) as {
      sandbox: { filesystem: { allowRead: string[]; allowWrite: string[] } };
    };
    expect(settings.sandbox.filesystem.allowRead).toContain(process.cwd());
    expect(settings.sandbox.filesystem.allowWrite).toEqual([]);
  });

  it("strips credential env vars from Codex plan revision", async () => {
    const previousEnv = seedForbiddenAgentEnv();
    mockRunCliProcess.mockResolvedValue({
      stdout: JSON.stringify({
        summary: "Codex revised summary",
        workingDir: "/tmp/test-wd",
        steps: [
          {
            id: "refine-codex",
            description: "Adjust the Codex-only plan",
            dependsOn: [],
            durationMinutes: 20,
            backend: "codex",
          },
        ],
      }),
      stderr: "",
      timedOut: false,
      exitCode: 0,
      signal: null,
      durationMs: 64,
    });

    try {
      await runCliPlanRevision({
        runId: "run-codex-revision-env",
        goalText: "Refine Codex plan",
        currentPlan: {
          goal: "Refine Codex plan",
          summary: "Original summary",
          workingDir: "/tmp/test-wd",
          steps: [
            {
              id: "step-1",
              description: "Initial step",
              dependsOn: [],
              status: "pending",
              durationMinutes: 45,
              backend: "codex",
            },
          ],
        },
        editInstructions: "Tighten validation logic",
        goalsDir,
        enabledWorkers: ["codex"],
      });
    } finally {
      restoreForbiddenAgentEnv(previousEnv);
    }

    const procCall = mockRunCliProcess.mock.calls[0]?.[0] as {
      command: string;
      env: Record<string, string | undefined>;
      args: string[];
    };
    expect(procCall.command).toBe("codex");
    expectForbiddenAgentEnvAbsent(procCall.env);
    expect(procCall.args).toContain("--skip-git-repo-check");
    expect(procCall.args).toContain("--cd");
    expect(procCall.args).not.toContain("--sandbox");
    expect(procCall.args).not.toContain("--dangerously-skip-permissions");
    expect(procCall.args).not.toContain("--allow-dangerously-skip-permissions");
    expect(procCall.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    const configToml = fs.readFileSync(path.join(procCall.env.CODEX_HOME!, "config.toml"), "utf8");
    expect(configToml).toContain(`${JSON.stringify(process.cwd())} = "read"`);
    expect(configToml).not.toContain(`${JSON.stringify(process.cwd())} = "write"`);
  });

  it("serializes buildGate, successCriteria, and constraints in revision prompts", async () => {
    mockRunCliProcess.mockResolvedValue({
      stdout: JSON.stringify({
        summary: "Revised summary",
        workingDir: "/tmp/test-wd",
        steps: [
          {
            id: "refine-auth",
            description: "Adjust auth flow and verify behavior",
            dependsOn: [],
            durationMinutes: 30,
            backend: "codex",
          },
        ],
      }),
      stderr: "",
      timedOut: false,
      exitCode: 0,
      signal: null,
      durationMs: 64,
    });

    await runCliPlanRevision({
      runId: "run-revision-build-gate-fields",
      goalText: "Refine auth flow",
      currentPlan: {
        goal: "Refine auth flow",
        summary: "Original summary",
        shortSummary: "Original short summary",
        workingDir: "/tmp/test-wd",
        buildGate: {
          commands: ["pnpm build"],
          runBetweenSteps: true,
        },
        steps: [
          {
            id: "step-1",
            description: "Initial step",
            shortSummary: "Initial step",
            dependsOn: [],
            successCriteria: "pnpm build exits 0",
            constraints: ["Do not narrow tsconfig include"],
            status: "pending",
            durationMinutes: 45,
            backend: "codex",
          },
        ],
      },
      editInstructions: "Keep the same build-gate and constraints",
      goalsDir,
    });

    const procCall = mockRunCliProcess.mock.calls[0]?.[0] as { stdin: string };
    expect(procCall.stdin).toContain('"buildGate": {');
    expect(procCall.stdin).toContain('"commands": [');
    expect(procCall.stdin).toContain('"pnpm build"');
    expect(procCall.stdin).toContain('"runBetweenSteps": true');
    expect(procCall.stdin).toContain('"successCriteria": "pnpm build exits 0"');
    expect(procCall.stdin).toContain('"constraints": [');
    expect(procCall.stdin).toContain('"Do not narrow tsconfig include"');
  });

  it("includes a deduplicated prior corrections checklist in revision prompts", async () => {
    mockRunCliProcess.mockResolvedValue({
      stdout: JSON.stringify({
        summary: "Revised summary",
        workingDir: "/tmp/test-wd",
        steps: [
          {
            id: "refine-auth",
            description: "Adjust auth flow and verify behavior",
            dependsOn: [],
            durationMinutes: 30,
            backend: "codex",
          },
        ],
      }),
      stderr: "",
      timedOut: false,
      exitCode: 0,
      signal: null,
      durationMs: 64,
    });

    const repeatedCorrection =
      "loadConfigFile does not exist; use readConfigFileSnapshot from src/config/index.ts.";
    await runCliPlanRevision({
      runId: "run-revision-prior-feedback",
      goalText: "Refine auth flow",
      currentPlan: {
        goal: "Refine auth flow",
        summary: "Original summary",
        workingDir: "/tmp/test-wd",
        steps: [
          {
            id: "step-1",
            description: "Initial step",
            dependsOn: [],
            status: "pending",
            durationMinutes: 45,
            backend: "codex",
          },
        ],
      },
      editInstructions: "Add explicit verification details for the updated plan.",
      priorFeedback: [
        repeatedCorrection,
        "Step IDs must map to existing scout nodes.",
        repeatedCorrection,
      ],
      goalsDir,
    });

    const procCall = mockRunCliProcess.mock.calls[0]?.[0] as { stdin: string };
    expect(procCall.stdin).toContain("Prior corrections checklist:");
    expect(procCall.stdin).toContain(
      "1. loadConfigFile does not exist; use readConfigFileSnapshot",
    );
    expect(procCall.stdin).toContain("2. Step IDs must map to existing scout nodes.");
    expect(procCall.stdin.split(repeatedCorrection).length - 1).toBe(1);

    const promptArtifact = path.join(
      goalsDir,
      "run-revision-prior-feedback",
      "replan",
      "revision_prompt_r1.txt",
    );
    expect(fs.existsSync(promptArtifact)).toBe(true);
    expect(fs.readFileSync(promptArtifact, "utf8")).toContain("Prior corrections checklist:");
  });

  it("keeps the plan revision prompt prefix stable before dynamic revision context", async () => {
    mockRunCliProcess.mockResolvedValue({
      stdout: JSON.stringify({
        summary: "Revised summary",
        workingDir: "/tmp/test-wd",
        steps: [
          {
            id: "refine-auth",
            description: "Adjust auth flow and verify behavior",
            dependsOn: [],
            durationMinutes: 30,
            backend: "claude_code",
          },
        ],
      }),
      stderr: "",
      timedOut: false,
      exitCode: 0,
      signal: null,
      durationMs: 64,
    });

    const currentPlan = {
      goal: "Refine auth flow",
      summary: "Original summary",
      workingDir: "/tmp/test-wd",
      steps: [
        {
          id: "step-1",
          description: "Initial step",
          dependsOn: [],
          status: "pending" as const,
          durationMinutes: 45,
          backend: "claude_code" as const,
        },
      ],
    };

    await runCliPlanRevision({
      runId: "run-revision-prefix-a",
      goalText: "Refine auth flow A",
      currentPlan,
      editInstructions: "Tighten validation logic",
      goalsDir,
      enabledWorkers: ["claude_code"],
    });
    await runCliPlanRevision({
      runId: "run-revision-prefix-b",
      goalText: "Refine auth flow B",
      currentPlan,
      editInstructions: "Tighten output formatting",
      goalsDir,
      enabledWorkers: ["claude_code"],
    });

    const firstPrompt = (mockRunCliProcess.mock.calls[0]![0] as { stdin: string }).stdin;
    const secondPrompt = (mockRunCliProcess.mock.calls[1]![0] as { stdin: string }).stdin;
    const firstStaticPrefix = firstPrompt.slice(0, firstPrompt.indexOf("\n\nGoal:"));
    const secondStaticPrefix = secondPrompt.slice(0, secondPrompt.indexOf("\n\nGoal:"));
    expect(firstStaticPrefix).toBe(secondStaticPrefix);
    expect(firstStaticPrefix).toContain("Step schema:");
    expect(firstStaticPrefix).toContain("BACKEND SELECTION RULES");
    expect(firstPrompt).toContain("Goal: Refine auth flow A");
    expect(secondPrompt).toContain("Goal: Refine auth flow B");
    expect(firstPrompt).toContain("Revision instructions: Tighten validation logic");
    expect(secondPrompt).toContain("Revision instructions: Tighten output formatting");
  });

  it("omits prior corrections checklist on first revision with no prior feedback", async () => {
    mockRunCliProcess.mockResolvedValue({
      stdout: JSON.stringify({
        summary: "Revised summary",
        workingDir: "/tmp/test-wd",
        steps: [
          {
            id: "refine-auth",
            description: "Adjust auth flow and verify behavior",
            dependsOn: [],
            durationMinutes: 30,
            backend: "codex",
          },
        ],
      }),
      stderr: "",
      timedOut: false,
      exitCode: 0,
      signal: null,
      durationMs: 64,
    });

    await runCliPlanRevision({
      runId: "run-revision-first-round",
      goalText: "Refine auth flow",
      currentPlan: {
        goal: "Refine auth flow",
        summary: "Original summary",
        workingDir: "/tmp/test-wd",
        steps: [
          {
            id: "step-1",
            description: "Initial step",
            dependsOn: [],
            status: "pending",
            durationMinutes: 45,
            backend: "codex",
          },
        ],
      },
      editInstructions: "Tighten validation logic",
      goalsDir,
    });

    const procCall = mockRunCliProcess.mock.calls[0]?.[0] as { stdin: string };
    expect(procCall.stdin).not.toContain("Prior corrections checklist:");
  });

  it("uses codex immediately for plan revision when only codex is enabled", async () => {
    mockResolveClaudeBinary.mockReturnValue(undefined);
    mockRunCliProcess.mockResolvedValueOnce({
      stdout: JSON.stringify({
        summary: "Codex-only revised summary",
        workingDir: "/tmp/test-wd",
        steps: [
          {
            id: "refine-auth",
            description: "Adjust auth flow and verify behavior",
            dependsOn: [],
            durationMinutes: 30,
            backend: "codex",
          },
        ],
      }),
      stderr: "",
      timedOut: false,
      exitCode: 0,
      signal: null,
      durationMs: 21,
    });

    const result = await runCliPlanRevision({
      runId: "run-revision-codex-only",
      goalText: "Refine auth flow",
      currentPlan: {
        goal: "Refine auth flow",
        summary: "Original summary",
        workingDir: "/tmp/test-wd",
        steps: [
          {
            id: "step-1",
            description: "Initial step",
            dependsOn: [],
            status: "pending",
            durationMinutes: 45,
            backend: "codex",
          },
        ],
      },
      editInstructions: "Tighten validation logic",
      goalsDir,
      enabledWorkers: ["codex"],
    });
    const revisedPlan = result.plan;

    if ("blocked" in revisedPlan) throw new Error("Expected plan result, got blocked");
    expect(result.plannerBackendUsed).toBe("codex");
    expect(mockRunCliProcess).toHaveBeenCalledTimes(1);
    const onlyCall = mockRunCliProcess.mock.calls[0]?.[0] as { command: string; args: string[] };
    expect(onlyCall.command).toBe("codex");
    expect(onlyCall.args).toContain("exec");
  });

  it("throws a clear revision error when only claude_code is enabled and Anthropic degrades", async () => {
    mockRunCliProcess.mockResolvedValueOnce({
      stdout: "",
      stderr: "Plan revision failed: You've hit your limit · resets 6pm (America/Toronto)",
      timedOut: false,
      exitCode: 1,
      signal: null,
      durationMs: 21,
    });

    await expect(
      runCliPlanRevision({
        runId: "run-revision-claude-only-degraded",
        goalText: "Refine auth flow",
        currentPlan: {
          goal: "Refine auth flow",
          summary: "Original summary",
          workingDir: "/tmp/test-wd",
          steps: [
            {
              id: "step-1",
              description: "Initial step",
              dependsOn: [],
              status: "pending",
              durationMinutes: 45,
              backend: "claude_code",
            },
          ],
        },
        editInstructions: "Tighten validation logic",
        goalsDir,
        enabledWorkers: ["claude_code"],
      }),
    ).rejects.toThrow("codex fallback is disabled by goal.enabledWorkers");

    expect(mockRunCliProcess).toHaveBeenCalledTimes(1);
    const onlyCall = mockRunCliProcess.mock.calls[0]?.[0] as { command: string };
    expect(onlyCall.command).toBe("/usr/bin/claude");
  });

  it("falls back to codex for plan revision on Anthropic limits and rewrites claude_code steps", async () => {
    mockRunCliProcess
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "Plan revision failed: You've hit your limit · resets 6pm (America/Toronto)",
        timedOut: false,
        exitCode: 1,
        signal: null,
        durationMs: 21,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          summary: "Revised summary from fallback",
          workingDir: "/tmp/test-wd",
          steps: [
            {
              id: "refine-auth",
              description: "Adjust auth flow and verify behavior",
              dependsOn: [],
              durationMinutes: 30,
              backend: "claude_code",
            },
          ],
        }),
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 41,
      });

    const result = await runCliPlanRevision({
      runId: "run-revision-fallback",
      goalText: "Refine auth flow",
      currentPlan: {
        goal: "Refine auth flow",
        summary: "Original summary",
        workingDir: "/tmp/test-wd",
        steps: [
          {
            id: "step-1",
            description: "Initial step",
            dependsOn: [],
            status: "pending",
            durationMinutes: 45,
            backend: "claude_code",
          },
        ],
      },
      editInstructions: "Tighten validation logic",
      goalsDir,
      enabledWorkers: ["codex", "claude_code"],
    });
    const revisedPlan = result.plan;

    if ("blocked" in revisedPlan) throw new Error("Expected plan result, got blocked");
    expect(result.plannerBackendUsed).toBe("codex");
    expect(result.plannerDegradedReason).toBe("anthropic_usage_limit");
    expect(result.plannerDegradedResetHint).toBe("resets 6pm (America/Toronto)");
    expect(revisedPlan.steps.every((step) => step.backend === "codex")).toBe(true);
    expect(revisedPlan.steps.every((step) => step.executedBackend !== "claude_code")).toBe(true);

    expect(mockRunCliProcess).toHaveBeenCalledTimes(2);
    const firstCall = mockRunCliProcess.mock.calls[0]?.[0] as { command: string };
    const secondCall = mockRunCliProcess.mock.calls[1]?.[0] as { command: string; args: string[] };
    expect(firstCall.command).toBe("/usr/bin/claude");
    expect(secondCall.command).toBe("codex");
    expect(secondCall.args).toContain("exec");
  });

  it("uses caller-provided cwd for planning and revision", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-planner-cwd-"));
    mockRunCliProcess.mockResolvedValue({
      stdout: JSON.stringify({
        summary: "Custom cwd",
        workingDir: workDir,
        steps: [
          {
            id: "step-1",
            description: "Do thing",
            dependsOn: [],
            durationMinutes: 30,
            backend: "codex",
          },
        ],
      }),
      stderr: "",
      timedOut: false,
      exitCode: 0,
      signal: null,
      durationMs: 50,
    });

    await runCliPlanning({
      runId: "run-custom-cwd",
      goalText: "Test cwd",
      goalsDir,
      cwd: workDir,
      includeScoutArtifacts: false,
    });
    const planningCall = mockRunCliProcess.mock.calls.at(-1)?.[0] as { cwd: string };
    expect(planningCall.cwd).toBe(workDir);

    await runCliPlanRevision({
      runId: "run-custom-cwd-revision",
      goalText: "Test cwd",
      currentPlan: {
        goal: "Test cwd",
        summary: "Initial",
        workingDir: workDir,
        steps: [
          {
            id: "step-1",
            description: "Do thing",
            dependsOn: [],
            status: "pending",
            durationMinutes: 30,
            backend: "codex",
          },
        ],
      },
      editInstructions: "Keep it simple",
      goalsDir,
      cwd: workDir,
    });
    const revisionCall = mockRunCliProcess.mock.calls.at(-1)?.[0] as { cwd: string };
    expect(revisionCall.cwd).toBe(workDir);
  });
});
