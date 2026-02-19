import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanParseError } from "./planner.js";
import { runCliPlanning, runCliPlanRevision, EXECUTION_PLAN_FILE } from "./cli-planner.js";

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
vi.mock("./backend-availability.js", () => ({
  getCodexAskForApprovalPlacement: () => mockGetCodexAskForApprovalPlacement(),
}));

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

  beforeEach(() => {
    goalsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-planner-test-"));
    vi.clearAllMocks();
    mockResolveClaudeBinary.mockReturnValue("/usr/bin/claude");
    priorApiKey = process.env.ANTHROPIC_API_KEY;
    priorAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  });

  afterEach(() => {
    if (priorApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = priorApiKey;
    if (priorAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = priorAuthToken;
    fs.rmSync(goalsDir, { recursive: true, force: true });
  });

  it("runs a single CLI planning pass and returns a validated plan", async () => {
    process.env.ANTHROPIC_API_KEY = "should-be-stripped";
    process.env.ANTHROPIC_AUTH_TOKEN = "should-be-stripped";

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
    };
    expect(procCall.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(procCall.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(procCall.cwd).toBe(process.cwd());
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
    expect(procCall.args).toContain("--model");
    expect(procCall.args).toContain("claude-sonnet-4-20250514");
    expect(procCall.cwd).toBe(process.cwd());
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
