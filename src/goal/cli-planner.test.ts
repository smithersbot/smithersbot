import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanParseError } from "./planner.js";
import { runCliPlanning, EXECUTION_PLAN_FILE } from "./cli-planner.js";

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
          '{"summary":"Unified planning summary","steps":[{"id":"analyze-repo","description":"Inspect repository files and verify with a targeted test run","dependsOn":[],"durationMinutes":45,"backend":"codex"}]}',
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
    };
    expect(procCall.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(procCall.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
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
});
