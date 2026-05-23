import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanParseError } from "./planner.js";
import {
  CLAUDE_ALLOWED_TOOLS,
  runCliPlanning,
  runCliPlanRevision,
  EXECUTION_PLAN_FILE,
} from "./cli-planner.js";
import {
  NO_WORKER_BACKEND_ERROR,
  requireEffectiveEnabledWorkers,
  resolveDefaultPlanAutocheckMode,
  resolveEffectiveEnabledWorkers,
} from "./effective-workers.js";

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

function writeScoutArtifacts(scoutDir: string, goalId: string): void {
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
}

describe("runCliPlanning", () => {
  let goalsDir: string;
  let priorApiKey: string | undefined;
  let priorAuthToken: string | undefined;
  let priorApiKeyOld: string | undefined;
  let priorBaseUrl: string | undefined;

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
  });

  afterEach(() => {
    if (priorApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = priorApiKey;
    if (priorAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = priorAuthToken;
    if (priorApiKeyOld === undefined) delete process.env.ANTHROPIC_API_KEY_OLD;
    else process.env.ANTHROPIC_API_KEY_OLD = priorApiKeyOld;
    if (priorBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = priorBaseUrl;
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

  it("returns blocked-at-planning when clarification artifact is produced", async () => {
    mockRunCliProcess.mockImplementation(async (params: Record<string, unknown>) => {
      const scoutDir = path.dirname(String(params.stdoutPath));
      fs.mkdirSync(scoutDir, { recursive: true });
      fs.writeFileSync(String(params.stdoutPath), "blocked", "utf8");
      fs.writeFileSync(String(params.stderrPath), "", "utf8");
      fs.writeFileSync(
        path.join(scoutDir, "plan_needs_clarification.md"),
        "Which deployment target should this use?",
        "utf8",
      );
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
      question: "Which deployment target should this use?",
      scoutStatus: "needs_clarification",
    });

    const attemptPath = path.join(goalsDir, "run-blocked", "scout", "attempt-1.json");
    const attempt = JSON.parse(fs.readFileSync(attemptPath, "utf8")) as Record<string, unknown>;
    expect(attempt.outcome).toBe("blocked");
    expect(attempt.errorClassification).toBe("needs_clarification");
  });

  it("clears stale clarification artifacts before replanning the same run", async () => {
    const runId = "run-replan-stale-clarification";
    let planningAttempt = 0;

    mockRunCliProcess.mockImplementation(async (params: Record<string, unknown>) => {
      planningAttempt += 1;
      const scoutDir = path.dirname(String(params.stdoutPath));
      fs.writeFileSync(String(params.stderrPath), "", "utf8");

      if (planningAttempt === 1) {
        fs.writeFileSync(String(params.stdoutPath), "blocked", "utf8");
        fs.writeFileSync(
          path.join(scoutDir, "plan_needs_clarification.md"),
          "Which deployment target should this use?",
          "utf8",
        );
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
    expect(fs.existsSync(path.join(scoutDir, "plan_needs_clarification.md"))).toBe(true);

    const secondResult = await runCliPlanning({
      runId,
      goalText: "Deploy this change",
      goalsDir,
    });

    expect(secondResult.status).toBe("success");
    expect(secondResult.scoutStatus).toBe("success");
    expect(fs.existsSync(path.join(scoutDir, "plan_needs_clarification.md"))).toBe(false);
  });

  it("clears all stale artifact types (draft, report, node_specs, raw_output) before replanning", async () => {
    const runId = "run-replan-all-artifacts";
    let planningAttempt = 0;

    mockRunCliProcess.mockImplementation(async (params: Record<string, unknown>) => {
      planningAttempt += 1;
      const scoutDir = path.dirname(String(params.stdoutPath));
      fs.writeFileSync(String(params.stderrPath), "", "utf8");

      if (planningAttempt === 1) {
        // First attempt: produce all artifacts plus a clarification file
        writeScoutArtifacts(scoutDir, runId);
        fs.writeFileSync(
          path.join(scoutDir, EXECUTION_PLAN_FILE),
          JSON.stringify({ summary: "stale", workingDir: "/tmp/test-wd", steps: [] }),
          "utf8",
        );
        fs.writeFileSync(String(params.stdoutPath), "blocked", "utf8");
        fs.writeFileSync(
          path.join(scoutDir, "plan_needs_clarification.md"),
          "Which DB should we use?",
          "utf8",
        );
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
        "plan_needs_clarification.md",
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

  it("handles triple replan: clarification → clarification → success", async () => {
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
        fs.writeFileSync(path.join(scoutDir, "plan_needs_clarification.md"), question, "utf8");
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
        summary: "Final plan after two clarifications",
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
      expect(r1.question).toBe("Which framework should we use?");
    }

    // Second planning attempt → blocked again (different question)
    const r2 = await runCliPlanning({ runId, goalText: "Deploy app", goalsDir });
    expect(r2.status).toBe("blocked");
    if (r2.status === "blocked") {
      expect(r2.question).toBe("Which deployment target?");
    }

    // Third planning attempt → success (stale clarification from r2 is cleared)
    const r3 = await runCliPlanning({ runId, goalText: "Deploy app", goalsDir });
    expect(r3.status).toBe("success");
    if (r3.status === "success") {
      expect(r3.plan.summary).toBe("Final plan after two clarifications");
    }

    // Verify no stale clarification file remains
    const scoutDir = path.join(goalsDir, runId, "scout");
    expect(fs.existsSync(path.join(scoutDir, "plan_needs_clarification.md"))).toBe(false);
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
        const outDirMatch =
          /Write all output files to ([^\n]+)\/ \(create subdirectories as needed\)\./.exec(prompt);
        if (!outDirMatch?.[1])
          throw new Error("expected codex prompt to include writable output dir");
        const codexScoutDir = outDirMatch[1];
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
    expect(procCall.args).not.toContain("--dangerously-skip-permissions");
    expect(procCall.args).not.toContain("--allow-dangerously-skip-permissions");
    expect(procCall.cwd).toBe(process.cwd());
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
    };
    expect(procCall.command).toBe("codex");
    expectForbiddenAgentEnvAbsent(procCall.env);
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
