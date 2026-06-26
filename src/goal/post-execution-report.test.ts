import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliWorkerId } from "../config/types.goal.js";
import {
  decideContinuation,
  generateReport,
  prepareManualTestDisplay,
  renderPostExecutionReportMarkdown,
  resolvePostExecutionReportArtifactPaths,
  runPostExecutionReporting,
  type PostExecutionReport,
} from "./post-execution-report.js";
import type { Plan } from "./types.js";
import { markdownToIR } from "../markdown/ir.js";
import { markdownToTelegramHtml } from "../telegram/format.js";

const mockRunCliProcess = vi.hoisted(() => vi.fn());
vi.mock("./cli-process.js", () => ({
  runCliProcess: (...args: unknown[]) => mockRunCliProcess(...args),
}));

const mockResolveClaudeBinary = vi.hoisted(() => vi.fn());
vi.mock("./scout.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./scout.js")>();
  return {
    ...actual,
    resolveClaudeBinary: (...args: unknown[]) => mockResolveClaudeBinary(...args),
  };
});

const mockGetCodexAskForApprovalPlacement = vi.hoisted(() => vi.fn());
vi.mock("./backend-availability.js", () => ({
  getCodexAskForApprovalPlacement: () => mockGetCodexAskForApprovalPlacement(),
}));

const mockBuildClaudeCodeEnv = vi.hoisted(() => vi.fn());
const mockBuildCredentialStrippedEnv = vi.hoisted(() => vi.fn());
vi.mock("./claude-code-env.js", () => ({
  buildClaudeCodeEnv: (...args: unknown[]) => mockBuildClaudeCodeEnv(...args),
  buildCredentialStrippedEnv: (...args: unknown[]) => mockBuildCredentialStrippedEnv(...args),
}));

const mockBuildClaudeCodeSandboxLaunchConfig = vi.hoisted(() =>
  vi.fn((params: { runId: string }) => ({
    settingsPath: `/tmp/${params.runId}-settings.json`,
    args: ["--settings", `/tmp/${params.runId}-settings.json`],
  })),
);
const mockWriteCodexNativeSandboxConfig = vi.hoisted(() =>
  vi.fn((params: { workingDir: string; runId: string }) => ({
    profileName: "smithersbot",
    executionRoot: params.workingDir,
    codexHome: `/tmp/${params.runId}-codex-home`,
    configPath: `/tmp/${params.runId}-codex-home/config.toml`,
    helperDir: `/tmp/${params.runId}-codex-home/bin`,
    helperPath: `/tmp/${params.runId}-codex-home/bin/codex-linux-sandbox`,
    codexPath: "codex",
    authReferencePath: `/tmp/${params.runId}-codex-home/auth.json`,
    authSourcePath: "/tmp/codex-auth.json",
    env: {
      CODEX_HOME: `/tmp/${params.runId}-codex-home`,
      PATH: `/tmp/${params.runId}-codex-home/bin:${process.env.PATH ?? ""}`,
    },
    args: [],
    configToml: "",
    deniedReadPaths: [],
    allowedReadPaths: [params.workingDir],
    writablePaths: [],
  })),
);
vi.mock("./backend-sandbox.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./backend-sandbox.js")>();
  return {
    ...actual,
    buildClaudeCodeSandboxLaunchConfig: (...args: unknown[]) =>
      mockBuildClaudeCodeSandboxLaunchConfig(...args),
    writeCodexNativeSandboxConfig: (...args: unknown[]) =>
      mockWriteCodexNativeSandboxConfig(...args),
  };
});

function cliResult(params: {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
}) {
  return {
    stdout: params.stdout ?? "",
    stderr: params.stderr ?? "",
    timedOut: params.timedOut ?? false,
    exitCode: params.exitCode ?? 0,
    signal: params.signal ?? null,
    durationMs: 10,
  };
}

function makePlan(workingDir: string): Plan {
  return {
    goal: "Ship native reporting",
    workingDir,
    summary: "Implement post-execution reporting",
    shortSummary: "Native reporting",
    buildGate: {
      commands: ["pnpm vitest run src/goal/post-execution-report.test.ts"],
      runBetweenSteps: false,
    },
    steps: [
      {
        id: "report-engine",
        description: "Add report engine",
        shortSummary: "Report engine",
        dependsOn: [],
        status: "done",
        durationMinutes: 30,
        backend: "claude_code",
        executedBackend: "claude_code",
        taskSummary: "Added typed report engine and focused tests.",
      },
    ],
  };
}

function makeReport(overrides: Partial<PostExecutionReport> = {}): PostExecutionReport {
  return {
    planCompleted: true,
    goalAchieved: true,
    summary: "The plan added native post-execution reporting.",
    filesChanged: ["src/goal/post-execution-report.ts"],
    verificationCommands: ["pnpm vitest run src/goal/post-execution-report.test.ts"],
    manualTests: [
      {
        description: "Open the Plan Done surface",
        criticality: 7,
        reason: "Telegram UI requires manual inspection",
        detail: "Complete a goal and confirm View Report appears.",
      },
    ],
    nextPlanRecommended: false,
    nextPlanSummary: null,
    nextPlanPrompt: null,
    decisionsNeeded: [],
    failureOrBlockedReason: null,
    ...overrides,
  };
}

function reportPayload(report = makeReport()) {
  return {
    markdown: "# Post Execution Report\n\nThe native report was generated.\n",
    report,
  };
}

function structuredReportPayload(report = makeReport()) {
  return { report };
}

function manualPayload(report = makeReport()) {
  return {
    manualTests: report.manualTests,
    displayMarkdown: "1. Open the Plan Done surface\nConfirm View Report appears.",
  };
}

function continuationPayload(report = makeReport()) {
  return {
    goalAchieved: report.goalAchieved,
    nextPlanRecommended: report.nextPlanRecommended,
    nextPlanSummary: report.nextPlanSummary,
    nextPlanPrompt: report.nextPlanPrompt,
    decisionsNeeded: report.decisionsNeeded,
    failureOrBlockedReason: report.failureOrBlockedReason,
  };
}

function jsonlResult(value: unknown, sessionId = "exec-session-1"): string {
  return `${JSON.stringify({ type: "result", session_id: sessionId, result: value })}\n`;
}

function rawLastArg(callIndex: number): string {
  const call = mockRunCliProcess.mock.calls[callIndex]?.[0] as { args: string[] } | undefined;
  return call?.args.at(-1) ?? "";
}

function promptArtifactPathFor(callIndex: number): string | undefined {
  const instruction = rawLastArg(callIndex);
  const lines = instruction.split(/\r?\n/);
  const markerIndex = lines.indexOf(
    "Read the complete post-execution prompt from this agent-history artifact path:",
  );
  return markerIndex >= 0 ? lines[markerIndex + 1]?.trim() : undefined;
}

function lastArg(callIndex: number): string {
  const artifactPath = promptArtifactPathFor(callIndex);
  if (artifactPath && fs.existsSync(artifactPath)) {
    return fs.readFileSync(artifactPath, "utf8");
  }
  return rawLastArg(callIndex);
}

function argsFor(callIndex: number): string[] {
  const call = mockRunCliProcess.mock.calls[callIndex]?.[0] as { args: string[] } | undefined;
  return call?.args ?? [];
}

function commandFor(callIndex: number): string | undefined {
  const call = mockRunCliProcess.mock.calls[callIndex]?.[0] as { command: string } | undefined;
  return call?.command;
}

describe("post-execution report engine", () => {
  let managedRoot: string;
  let previousManagedRoot: string | undefined;
  let workingDir: string;
  let plan: Plan;

  beforeEach(() => {
    managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "post-exec-managed-"));
    previousManagedRoot = process.env.SMITHERSBOT_GOALS_ROOT;
    process.env.SMITHERSBOT_GOALS_ROOT = managedRoot;
    workingDir = path.join(managedRoot, "agent", "workspaces", "smithersbot-dev");
    fs.mkdirSync(workingDir, { recursive: true });
    plan = makePlan(workingDir);
    mockRunCliProcess.mockReset();
    mockResolveClaudeBinary.mockReset();
    mockGetCodexAskForApprovalPlacement.mockReset();
    mockBuildClaudeCodeEnv.mockReset();
    mockBuildCredentialStrippedEnv.mockReset();
    mockBuildClaudeCodeSandboxLaunchConfig.mockClear();
    mockWriteCodexNativeSandboxConfig.mockClear();
    mockResolveClaudeBinary.mockReturnValue("/usr/bin/claude");
    mockGetCodexAskForApprovalPlacement.mockReturnValue("unsupported");
    mockBuildClaudeCodeEnv.mockReturnValue({ CLAUDE_AUTH: "subscription" });
    mockBuildCredentialStrippedEnv.mockReturnValue({ PATH: process.env.PATH });
  });

  afterEach(() => {
    if (previousManagedRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
    else process.env.SMITHERSBOT_GOALS_ROOT = previousManagedRoot;
    fs.rmSync(managedRoot, { recursive: true, force: true });
  });

  it("renders core-only post-execution reports with source links for expanded surfaces", () => {
    const markdown = renderPostExecutionReportMarkdown(
      makeReport({
        goalAchieved: false,
        nextPlanRecommended: true,
        nextPlanSummary: "Create the remaining Stage 2 artifact.",
        nextPlanPrompt: "Create the Stage 2 artifact and verify it exists.",
        decisionsNeeded: [
          {
            question: "Should Stage 2 start now?",
            options: ["Start Stage 2 now", "Pause before Stage 2"],
            recommendedOption: "Start Stage 2 now",
            rationale: "The original goal still has a remaining stage.",
          },
        ],
      }),
    );

    expect(markdown).toContain("**Post-Execution Report:**");
    expect(markdown).toContain("**Summary:** The plan added native post-execution reporting.");
    expect(markdown).toContain("**Outcome:**");
    expect(markdown).toContain("**Files Changed:**");
    expect(markdown).toContain("**Verification Commands:**");
    expect(markdown).toContain("**Sources:**");
    expect(markdown).toContain(
      "- Test Details: open the Test Detail surface from the completed plan message.",
    );
    expect(markdown).toContain(
      "- Continuation message: open the continuation prompt message for next-plan details.",
    );
    expect(markdown).toContain(
      "- View Prompt: open the continuation View Prompt surface for the proposed prompt.",
    );
    expect(markdown).not.toContain("**Manual Tests:**");
    expect(markdown).not.toContain("**Next Plan:**");
    expect(markdown).not.toContain("**Proposed prompt:**");
    expect(markdown).not.toContain("**Decision(s) needed:**");
    expect(markdown).not.toContain("Start Stage 2 now");
    expect(markdown).not.toMatch(/^#/m);
    expect(markdown).not.toContain("## Summary");
    expect(markdown).not.toContain("### Draft Prompt");
    expect(markdown).not.toContain("\n\n");

    const irText = JSON.stringify(markdownToIR(markdown));
    expect(irText).toContain("Post-Execution Report:");
    expect(irText).toContain("Sources:");
    expect(irText).toContain("Test Details:");
    expect(irText).toContain("Continuation message:");
    expect(irText).toContain("View Prompt:");
    expect(irText).not.toContain("Manual Tests:");
    expect(irText).not.toContain("Next Plan:");
    expect(irText).not.toContain("Proposed prompt:");
    expect(irText).not.toContain("Decision(s) needed:");
  });

  it("renders no blank line between the Outcome label and its first bullet in the Telegram message", () => {
    const markdown = renderPostExecutionReportMarkdown(
      makeReport({ planCompleted: true, goalAchieved: false, nextPlanRecommended: true }),
    );
    const html = markdownToTelegramHtml(markdown);

    // The first Outcome bullet must immediately follow the label — no blank line.
    expect(html).toContain("<b>Outcome:</b>\n• Plan completed: Yes");
    expect(html).not.toContain("<b>Outcome:</b>\n\n");
  });

  it("instructs report generation to author Manual Tests around observable behavior only", async () => {
    const report = makeReport();
    mockRunCliProcess.mockResolvedValueOnce(
      cliResult({ stdout: jsonlResult(reportPayload(report)) }),
    );

    const result = await generateReport({
      runId: "run-manual-test-behavior",
      goal: "Build native reporting",
      plan,
      workingDir,
      backend: "claude_code",
      sessionId: "exec-session-1",
      completionSummary: "Completed report work.",
    });

    expect(result.status).toBe("success");
    const prompt = lastArg(0);
    expect(prompt).toContain(
      'Prefer Manual Tests that check observable behavior ("user can X and sees Y"), not internal structure; a good Manual Test survives an internal rewrite.',
    );
    expect(prompt).not.toContain("docs/goal-engine-guides/testing-guidance.md");
    expect(prompt).not.toContain("docs/goal-engine-guides/diagnosis-guide.md");
  });

  it("writes markdown and JSON to the goal history folder through native generation", async () => {
    const report = makeReport();
    mockRunCliProcess
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(reportPayload(report)) }))
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(manualPayload(report)) }))
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(continuationPayload(report)) }));

    const result = await runPostExecutionReporting({
      runId: "run-native",
      goal: "Build native reporting",
      plan,
      workingDir,
      backend: "claude_code",
      sessionId: "exec-session-1",
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(fs.existsSync(result.artifacts.markdownPath)).toBe(true);
    expect(fs.existsSync(result.artifacts.jsonPath)).toBe(true);
    expect(result.artifacts.markdownPath).toBe(
      path.join(
        managedRoot,
        "agent",
        "history",
        "goals",
        "smithersbot-dev",
        "run-native",
        "post-execution-report.md",
      ),
    );
    expect(result.artifacts.markdownPath.startsWith(workingDir)).toBe(false);
    const savedMarkdown = fs.readFileSync(result.artifacts.markdownPath, "utf8");
    expect(savedMarkdown).toContain("**Post-Execution Report:**");
    expect(savedMarkdown).toContain("**Summary:** The plan added native post-execution reporting.");
    expect(savedMarkdown).not.toMatch(/^#/m);
    expect(JSON.parse(fs.readFileSync(result.artifacts.jsonPath, "utf8"))).toMatchObject({
      planCompleted: true,
      goalAchieved: true,
      summary: "The plan added native post-execution reporting.",
    });
    expect(lastArg(0)).toContain("Native lifecycle phase: post-execution report generation.");
    expect(lastArg(0)).not.toContain("/new_goal");
    expect(lastArg(0)).not.toContain('"markdown"');
    expect(lastArg(0)).not.toContain("Markdown formatting rules:");
    expect(lastArg(0)).toContain(
      "The system will render markdown deterministically from the report object.",
    );
    expect(lastArg(0)).toContain("Evidence source links:");
    expect(lastArg(0)).toContain("Goal Brief:");
    expect(lastArg(0)).toContain(path.join("run-native", "wiki", "goal-brief.md"));
    expect(lastArg(0)).toContain("ScoutReport mirror:");
    expect(lastArg(0)).toContain(path.join("runtime", "scout", "scout_report.json"));
    expect(lastArg(0)).toContain("Prior Plan Report:");
    expect(lastArg(0)).toContain(path.join("run-native", "post-execution-report.md"));
  });

  it("accepts structured report JSON without reading a model-provided markdown field", async () => {
    const report = makeReport({ summary: "Structured report only." });
    mockRunCliProcess.mockResolvedValueOnce(
      cliResult({ stdout: jsonlResult(structuredReportPayload(report)) }),
    );

    const result = await generateReport({
      runId: "run-structured-report",
      goal: "Build native reporting",
      plan,
      workingDir,
      backend: "claude_code",
      sessionId: "exec-session-1",
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.markdown).toContain("**Post-Execution Report:**");
    expect(result.markdown).toContain("**Summary:** Structured report only.");
    expect(result.markdown).toContain("**Sources:**");
    const prompt = lastArg(0);
    expect(prompt).not.toContain('"markdown"');
    expect(prompt).not.toContain("Markdown formatting rules:");
  });

  it("falls back to the plan summary for Long Goal Summary when the Goal Brief is absent", async () => {
    const report = makeReport();
    mockRunCliProcess
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(reportPayload(report)) }))
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(manualPayload(report)) }))
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(continuationPayload(report)) }));

    const result = await runPostExecutionReporting({
      runId: "run-brief",
      goal: "Build native reporting",
      plan,
      workingDir,
      backend: "claude_code",
      sessionId: "exec-session-1",
      serializedRun: {
        runId: "run-brief",
        goal: "Build native reporting",
        state: "done",
        plan,
        stepResults: {},
        blocked: null,
        answers: {},
        workingDir: path.join(os.tmpdir(), "changed-working-dir"),
        goalBriefPath: path.join(
          "stored",
          "history",
          "goals",
          "original-workspace",
          "run-brief",
          "wiki",
          "goal-brief.md",
        ),
        model: undefined,
        dryRun: false,
        createdAt: "2026-01-30T00:00:00.000Z",
        updatedAt: "2026-01-30T00:00:00.000Z",
      },
    });

    expect(result.status).toBe("success");
    const prompt = lastArg(0);
    expect(prompt).toContain("Plan summary: Implement post-execution reporting");
    expect(prompt).toContain("Long Goal Summary: Implement post-execution reporting");
    // The reporter is pointed at the goal brief living under the goal wiki dir.
    expect(prompt).toContain("Goal brief:");
    expect(prompt).toContain(
      path.join(
        "stored",
        "history",
        "goals",
        "original-workspace",
        "run-brief",
        "wiki",
        "goal-brief.md",
      ),
    );
  });

  it("passes Worker Summaries as linked evidence and instructs Reporter to verify claims", async () => {
    const report = makeReport();
    const workerSummaryPath = path.join(
      managedRoot,
      "agent",
      "history",
      "goals",
      "smithersbot-dev",
      "run-worker-summaries",
      "wiki",
      "worker-summary-report-engine.md",
    );
    mockRunCliProcess
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(reportPayload(report)) }))
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(manualPayload(report)) }))
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(continuationPayload(report)) }));

    const result = await runPostExecutionReporting({
      runId: "run-worker-summaries",
      goal: "Build native reporting",
      plan,
      workingDir,
      backend: "claude_code",
      sessionId: "exec-session-1",
      workerSummaries: [
        {
          id: "report-engine",
          summary: "Added typed report engine and focused tests.",
          path: workerSummaryPath,
          status: "pass",
          createdAt: "2026-06-06T00:00:00.000Z",
          claimsToVerify: [
            "Verify Task report-engine's worker summary against the actual diff before relying on it.",
          ],
          usedSummaryIds: [],
        },
      ],
      buildGateResults: {
        "report-engine": {
          passed: false,
          timestamp: "2026-06-06T00:00:00.000Z",
          failedCommand: "pnpm build",
          output: `build failed ${"x".repeat(3_000)} sentinel-after-truncation`,
        },
      },
    });

    expect(result.status).toBe("success");
    const prompt = lastArg(0);
    expect(prompt).toContain(
      "Treat Worker Summaries as linked evidence, not ground truth: verify each flagged claim against the actual diff and build-gate output before reporting it as fact.",
    );
    expect(prompt).toContain("Worker Summaries (linked evidence, not ground truth):");
    expect(prompt).toContain("- report-engine: Added typed report engine and focused tests.");
    expect(prompt).toContain(`Source Link: ${workerSummaryPath}`);
    expect(prompt).toContain("Claims to verify before relying on this summary:");
    expect(prompt).toContain("Verify Task report-engine's worker summary");
    expect(prompt).toContain("Recorded build-gate results:");
    expect(prompt).toContain("- report-engine: failed at 2026-06-06T00:00:00.000Z");
    expect(prompt).toContain("failedCommand: pnpm build");
    expect(prompt).toContain("build failed");
    expect(prompt).not.toContain("sentinel-after-truncation");
  });

  it("links Goal Brief content and keeps only compact derived fields in the reporter prompt", async () => {
    const report = makeReport();
    const briefPath = path.join(managedRoot, "stored", "wiki", "goal-brief.md");
    const briefContent = [
      "# Goal Brief",
      "",
      "## Long Goal Summary",
      "Two-stage goal: create goal1.txt then goal2.txt.",
      "",
      "## Remaining Work",
      "Stage 2 still needs goal2.txt created.",
      "",
      "## Observation Point",
      "Stop after Stage 1; confirm goal1.txt before Stage 2.",
    ].join("\n");
    fs.mkdirSync(path.dirname(briefPath), { recursive: true });
    fs.writeFileSync(briefPath, briefContent, "utf8");

    mockRunCliProcess
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(reportPayload(report)) }))
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(manualPayload(report)) }))
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(continuationPayload(report)) }));

    const result = await runPostExecutionReporting({
      runId: "run-brief-content",
      goal: "Build native reporting",
      plan,
      workingDir,
      backend: "claude_code",
      sessionId: "exec-session-1",
      serializedRun: {
        runId: "run-brief-content",
        goal: "Build native reporting",
        state: "done",
        plan,
        stepResults: {},
        blocked: null,
        answers: {},
        workingDir: path.join(os.tmpdir(), "changed-working-dir"),
        goalBriefPath: briefPath,
        model: undefined,
        dryRun: false,
        createdAt: "2026-01-30T00:00:00.000Z",
        updatedAt: "2026-01-30T00:00:00.000Z",
      },
    });

    expect(result.status).toBe("success");
    const prompt = lastArg(0);
    expect(prompt).toContain("Plan summary: Implement post-execution reporting");
    expect(prompt).toContain("Long Goal Summary: Two-stage goal: create goal1.txt then goal2.txt.");
    // The stored brief path is surfaced.
    expect(prompt).toContain(`Goal brief: ${briefPath}`);
    expect(prompt).toContain("Open the Goal Brief path above if you need the full brief");
    expect(prompt).not.toContain("Goal Brief content (read from the stored brief path):");
    expect(prompt).not.toContain("Stage 2 still needs goal2.txt created.");
    expect(prompt).not.toContain("Stop after Stage 1; confirm goal1.txt before Stage 2.");
    expect(prompt).not.toContain("Goal Brief is missing");
  });

  it("uses Goal Summary from the Goal Brief when Long Goal Summary is missing", async () => {
    const report = makeReport();
    const briefPath = path.join(managedRoot, "stored", "wiki", "goal-brief.md");
    const briefContent = [
      "# Goal Brief",
      "",
      "## Goal Summary",
      "Full goal scope from the brief.",
      "",
      "## Remaining Work",
      "No remaining work is recorded.",
    ].join("\n");
    fs.mkdirSync(path.dirname(briefPath), { recursive: true });
    fs.writeFileSync(briefPath, briefContent, "utf8");

    mockRunCliProcess
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(reportPayload(report)) }))
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(manualPayload(report)) }))
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(continuationPayload(report)) }));

    const result = await runPostExecutionReporting({
      runId: "run-brief-goal-summary",
      goal: "Build native reporting",
      plan,
      workingDir,
      backend: "claude_code",
      sessionId: "exec-session-1",
      serializedRun: {
        runId: "run-brief-goal-summary",
        goal: "Build native reporting",
        state: "done",
        plan,
        stepResults: {},
        blocked: null,
        answers: {},
        workingDir,
        goalBriefPath: briefPath,
        model: undefined,
        dryRun: false,
        createdAt: "2026-01-30T00:00:00.000Z",
        updatedAt: "2026-01-30T00:00:00.000Z",
      },
    });

    expect(result.status).toBe("success");
    const prompt = lastArg(0);
    expect(prompt).toContain("Plan summary: Implement post-execution reporting");
    expect(prompt).toContain("Long Goal Summary: Full goal scope from the brief.");
  });

  it("injects missing-brief framing without defaulting to goalAchieved=true", async () => {
    // Backend reports the goal is NOT achieved; the reporter must preserve that.
    const report = makeReport({ goalAchieved: false });
    mockRunCliProcess
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(reportPayload(report)) }))
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(manualPayload(report)) }))
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(continuationPayload(report)) }));

    const result = await runPostExecutionReporting({
      runId: "run-missing-brief",
      goal: "Build native reporting",
      plan,
      workingDir,
      backend: "claude_code",
      sessionId: "exec-session-1",
      serializedRun: {
        runId: "run-missing-brief",
        goal: "Build native reporting",
        state: "done",
        plan,
        stepResults: {},
        blocked: null,
        answers: {},
        workingDir,
        goalBriefPath: path.join(managedRoot, "absent", "wiki", "goal-brief.md"),
        model: undefined,
        dryRun: false,
        createdAt: "2026-01-30T00:00:00.000Z",
        updatedAt: "2026-01-30T00:00:00.000Z",
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    const prompt = lastArg(0);
    expect(prompt).toContain(
      "Goal Brief is missing — do not infer goal achievement from its absence.",
    );
    expect(prompt).not.toContain("Goal Brief content (read from the stored brief path):");
    // The reporter never hard-codes goalAchieved; the backend's false verdict survives.
    expect(result.report.goalAchieved).toBe(false);
  });

  it("prompts and records remaining original-goal stage work after a completed first plan", async () => {
    const stagedPlan: Plan = {
      ...plan,
      goal: "This goal has two stages. Stage 1 creates the first artifact. Stage 2 continues this same goal with another plan that creates the second artifact.",
      summary: "Complete only Stage 1 and leave Stage 2 for a continuation plan.",
      shortSummary: "Stage 1 only",
      steps: [
        {
          id: "stage-1",
          description: "Create the first-stage artifact only.",
          shortSummary: "Create first artifact",
          dependsOn: [],
          status: "done",
          taskSummary: "Created the first-stage artifact and did not start Stage 2.",
        },
      ],
    };
    const stagedReport = makeReport({
      goalAchieved: false,
      summary:
        "Stage 1 completed, but the original two-stage goal still has unfinished Stage 2 work.",
      nextPlanRecommended: true,
      nextPlanSummary:
        "Continue the same goal with Stage 2 by creating and verifying the second artifact.",
      nextPlanPrompt:
        "Create the Stage 2 plan for the remaining original-goal work, then wait for normal approval before execution.",
      decisionsNeeded: [
        {
          question: "Should Stage 2 start now?",
          options: ["Start Stage 2 now", "Pause before Stage 2"],
          recommendedOption: "Start Stage 2 now",
          rationale: "The original goal explicitly asks to continue after Stage 1.",
        },
      ],
    });
    mockRunCliProcess
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(reportPayload(stagedReport)) }))
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(continuationPayload(stagedReport)) }));

    const result = await generateReport({
      runId: "run-staged",
      goal: stagedPlan.goal,
      plan: stagedPlan,
      workingDir,
      backend: "claude_code",
      sessionId: "exec-session-1",
      completionSummary: "Stage 1 completed and Stage 2 remains.",
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.report.goalAchieved).toBe(false);
    expect(result.report.nextPlanRecommended).toBe(true);
    expect(result.report.nextPlanSummary).toContain("Stage 2");
    expect(result.report.nextPlanPrompt).toContain("remaining original-goal work");
    expect(result.report.nextPlanSummary?.trim()).not.toBe("");
    expect(result.report.nextPlanPrompt?.trim()).not.toBe("");
    expect(lastArg(0)).toContain(
      "Evaluate goalAchieved against the user's original goal, not just this plan's completion.",
    );
    expect(lastArg(0)).toContain(
      "If the original goal describes multiple stages, sequenced phases, or asks to continue after this plan",
    );
    expect(lastArg(0)).toContain("The next plan must directly perform the remaining work");
    expect(lastArg(0)).toContain("Original user goal:");
    expect(lastArg(0)).toContain("Stage 2 continues this same goal");
    expect(lastArg(0)).toContain("completion snippet: Created the first-stage artifact");

    const continuation = await decideContinuation({
      runId: "run-staged",
      goal: stagedPlan.goal,
      plan: stagedPlan,
      workingDir,
      backend: "claude_code",
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      report: result.report,
      artifacts: result.artifacts,
    });

    expect(continuation.status).toBe("success");
    if (continuation.status !== "success") throw new Error("expected success");
    expect(continuation.continuation.goalAchieved).toBe(false);
    expect(continuation.continuation.nextPlanRecommended).toBe(true);
    expect(continuation.continuation.nextPlanSummary).toContain("Stage 2");
    expect(continuation.continuation.nextPlanPrompt).toContain("remaining original-goal work");
    expect(continuation.continuation.nextPlanSummary?.trim()).not.toBe("");
    expect(continuation.continuation.nextPlanPrompt?.trim()).not.toBe("");
    expect(lastArg(1)).toContain("Native lifecycle phase: decide continuation.");
    expect(lastArg(1)).toContain("Structured completion context:");
    expect(lastArg(1)).toContain("Original user goal:");
    expect(lastArg(1)).toContain(
      "When remaining work exists, set goalAchieved=false, nextPlanRecommended=true",
    );
  });

  it("attempts same-session resume separately for report, manual-test display, and continuation", async () => {
    mockRunCliProcess
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(reportPayload()) }))
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(manualPayload()) }))
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(continuationPayload()) }));

    await runPostExecutionReporting({
      runId: "run-same-session",
      goal: "Build native reporting",
      plan,
      workingDir,
      backend: "claude_code",
      sessionId: "exec-session-1",
    });

    expect(mockRunCliProcess).toHaveBeenCalledTimes(3);
    for (let index = 0; index < 3; index += 1) {
      expect(commandFor(index)).toBe("/usr/bin/claude");
      expect(argsFor(index)).toEqual(expect.arrayContaining(["--resume", "exec-session-1"]));
    }
    expect(lastArg(0)).toContain("post-execution report generation");
    expect(lastArg(1)).toContain("prepare manual-test display data");
    expect(lastArg(2)).toContain("decide continuation");
  });

  it("preserves the phase-1 report when manual-test display generation fails", async () => {
    const report = makeReport();
    mockRunCliProcess
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(structuredReportPayload(report)) }))
      .mockResolvedValueOnce(cliResult({ stderr: "manual display backend failed", exitCode: 1 }))
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(continuationPayload(report)) }));

    const result = await runPostExecutionReporting({
      runId: "run-manual-phase-fails",
      goal: "Build native reporting",
      plan,
      workingDir,
      backend: "claude_code",
      sessionId: "exec-session-1",
      enabledBackends: ["claude_code"],
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.report.summary).toBe(report.summary);
    expect(result.markdown).toContain("**Post-Execution Report:**");
    expect(result.manualTestDisplay.manualTests).toHaveLength(1);
    expect(result.manualTestDisplay.manualTests[0]?.description).toContain("report engine");
    expect(result.manualTestDisplay.displayMarkdown).toContain("Post-execution manual-test");
    expect(result.continuation.goalAchieved).toBe(true);
    expect(mockRunCliProcess).toHaveBeenCalledTimes(3);
  });

  it("preserves the phase-1 report and manual tests when continuation decision fails", async () => {
    const report = makeReport();
    const briefPath = path.join(managedRoot, "stored", "wiki", "goal-brief.md");
    fs.mkdirSync(path.dirname(briefPath), { recursive: true });
    fs.writeFileSync(
      briefPath,
      [
        "# Goal Brief",
        "",
        "## Remaining Work",
        "Stage 2 still needs the final smoke test artifact.",
        "",
        "## Observation Point",
        "Confirm the smoke artifact after the next plan.",
      ].join("\n"),
      "utf8",
    );

    mockRunCliProcess
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(structuredReportPayload(report)) }))
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(manualPayload(report)) }))
      .mockResolvedValueOnce(
        cliResult({ stderr: "continuation decision backend failed", exitCode: 1 }),
      );

    const result = await runPostExecutionReporting({
      runId: "run-continuation-phase-fails",
      goal: "Build native reporting",
      plan,
      workingDir,
      backend: "claude_code",
      sessionId: "exec-session-1",
      enabledBackends: ["claude_code"],
      serializedRun: {
        runId: "run-continuation-phase-fails",
        goal: "Build native reporting",
        state: "done",
        plan,
        stepResults: {},
        blocked: null,
        answers: {},
        workingDir,
        goalBriefPath: briefPath,
        model: undefined,
        dryRun: false,
        createdAt: "2026-01-30T00:00:00.000Z",
        updatedAt: "2026-01-30T00:00:00.000Z",
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.report.summary).toBe(report.summary);
    expect(result.manualTestDisplay.manualTests).toEqual(report.manualTests);
    expect(result.continuation.goalAchieved).toBe(false);
    expect(result.continuation.nextPlanRecommended).toBe(true);
    expect(result.continuation.nextPlanSummary).toContain("Stage 2 still needs");
    expect(result.continuation.nextPlanPrompt).toContain("Goal Brief");
    expect(result.continuation.failureOrBlockedReason).toContain(
      "Post-execution continuation decision failed",
    );
  });

  it("re-prompts the same resumed session once when a clean phase response is invalid JSON", async () => {
    const report = makeReport({ summary: "Retry produced valid JSON." });
    mockRunCliProcess
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult("not valid json", "exec-session-1") }))
      .mockResolvedValueOnce(
        cliResult({ stdout: jsonlResult(structuredReportPayload(report), "exec-session-1") }),
      );

    const result = await generateReport({
      runId: "run-json-retry",
      goal: "Build native reporting",
      plan,
      workingDir,
      backend: "claude_code",
      sessionId: "exec-session-1",
      enabledBackends: ["claude_code"],
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.report.summary).toBe("Retry produced valid JSON.");
    expect(mockRunCliProcess).toHaveBeenCalledTimes(2);
    expect(argsFor(0)).toEqual(expect.arrayContaining(["--resume", "exec-session-1"]));
    expect(argsFor(1)).toEqual(expect.arrayContaining(["--resume", "exec-session-1"]));
    expect(lastArg(1)).toBe(
      "Your previous message was not valid JSON. Resend ONLY the JSON object this phase requested, with no prose or code fences.",
    );
  });

  it("resolves report, scout, and goal-brief source paths under the history anchor", async () => {
    mockRunCliProcess
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(reportPayload()) }))
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(manualPayload()) }))
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(continuationPayload()) }));
    const staleBriefPath = path.join(
      managedRoot,
      "agent",
      "history",
      "goals",
      "smithersbot-dev",
      "run-anchor-report",
      "wiki",
      "goal-brief.md",
    );
    const anchoredBriefPath = path.join(
      managedRoot,
      "agent",
      "history",
      "goals",
      "test-workspace",
      "run-anchor-report",
      "wiki",
      "goal-brief.md",
    );
    fs.mkdirSync(path.dirname(anchoredBriefPath), { recursive: true });
    fs.writeFileSync(
      anchoredBriefPath,
      "## Long Goal Summary\n\nAnchored long goal summary.\n",
      "utf8",
    );

    const result = await runPostExecutionReporting({
      runId: "run-anchor-report",
      goal: "Build native reporting",
      plan,
      workingDir,
      backend: "claude_code",
      serializedRun: {
        runId: "run-anchor-report",
        goal: "Build native reporting",
        state: "reporting",
        plan,
        stepResults: {},
        blocked: null,
        answers: {},
        workingDir,
        historyWorkspaceSlug: "test-workspace",
        goalBriefPath: staleBriefPath,
        model: undefined,
        dryRun: false,
        createdAt: "2026-06-06T00:00:00.000Z",
        updatedAt: "2026-06-06T00:00:00.000Z",
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.artifacts.historyDir).toContain(
      path.join("history", "goals", "test-workspace", "run-anchor-report"),
    );
    expect(result.artifacts.historyDir).not.toContain(
      path.join("history", "goals", "smithersbot-dev"),
    );
    expect(lastArg(0)).toContain(`Goal Brief: ${anchoredBriefPath}`);
    expect(lastArg(0)).toContain(
      path.join(
        managedRoot,
        "agent",
        "history",
        "goals",
        "test-workspace",
        "run-anchor-report",
        "runtime",
        "scout",
        "scout_report.json",
      ),
    );
    expect(lastArg(0)).not.toContain(staleBriefPath);
  });

  it("stores report, manual-test, and continuation prompts under the selected workspace history", async () => {
    mockRunCliProcess
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(reportPayload()) }))
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(manualPayload()) }))
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(continuationPayload()) }));

    const result = await runPostExecutionReporting({
      runId: "run-prompt-history",
      goal: "Build native reporting",
      plan,
      workingDir,
      backend: "claude_code",
      model: "claude-test-model",
      serializedRun: {
        runId: "run-prompt-history",
        goal: "Build native reporting",
        state: "reporting",
        plan,
        stepResults: {},
        blocked: null,
        answers: {},
        workingDir,
        historyWorkspaceSlug: "test-workspace",
        model: "claude-test-model",
        dryRun: false,
        createdAt: "2026-01-30T00:00:00.000Z",
        updatedAt: "2026-01-30T00:00:00.000Z",
      },
    });

    expect(result.status).toBe("success");
    const historyDir = path.join(
      managedRoot,
      "agent",
      "history",
      "goals",
      "test-workspace",
      "run-prompt-history",
    );
    const promptDir = path.join(historyDir, "prompts");
    const promptFiles = fs.readdirSync(promptDir).sort();
    expect(promptFiles).toHaveLength(3);
    expect(promptFiles.join("\n")).toContain("-report-claude_code-");
    expect(promptFiles.join("\n")).toContain("-manual-test-claude_code-");
    expect(promptFiles.join("\n")).toContain("-continuation-claude_code-");

    const eventLines = fs
      .readFileSync(path.join(historyDir, "events.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map(
        (line) =>
          JSON.parse(line) as {
            phase: string;
            postExecutionPhase?: string;
            argv?: string[];
            model?: string;
            promptArtifactPath?: string;
          },
      );
    expect(eventLines.map((event) => event.phase)).toEqual([
      "report",
      "manual-test",
      "continuation",
    ]);
    expect(eventLines.map((event) => event.postExecutionPhase)).toEqual([
      "generateReport",
      "prepareManualTestDisplay",
      "decideContinuation",
    ]);
    expect(eventLines.every((event) => event.model === "claude-test-model")).toBe(true);
    expect(eventLines.every((event) => event.promptArtifactPath)).toBe(true);
    for (const event of eventLines) {
      expect(fs.existsSync(event.promptArtifactPath!)).toBe(true);
    }
    const argvText = eventLines.flatMap((event) => event.argv ?? []).join("\n");
    expect(argvText).toContain(
      "Read the complete post-execution prompt from this agent-history artifact path:",
    );
    expect(argvText).not.toContain("<prompt>");
    expect(argvText).not.toContain("Original user goal:");
    expect(argvText).not.toContain("Structured completion context:");

    const promptContents = eventLines.map((event) =>
      fs.readFileSync(event.promptArtifactPath!, "utf8"),
    );
    expect(promptContents[0]).toContain("post-execution report generation");
    expect(promptContents[1]).toContain("prepare manual-test display data");
    expect(promptContents[2]).toContain("decide continuation");
  });

  it("keeps Claude Code and Codex argv bounded while storing large post-execution prompts", async () => {
    const largeMarker = `x402-large-post-exec-context-${"A".repeat(150_000)}`;
    const largePlan: Plan = {
      ...plan,
      goal: `Fix a large completed-plan reporting context. ${largeMarker}`,
      summary: `Generate reports from a very large completed plan. ${largeMarker}`,
      steps: [
        {
          ...plan.steps[0]!,
          taskSummary: `Completed the first reporting stage with a very large summary. ${largeMarker}`,
        },
      ],
    };

    const backends: CliWorkerId[] = ["claude_code", "codex"];
    for (const backend of backends) {
      mockRunCliProcess.mockReset();
      mockRunCliProcess
        .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(reportPayload()) }))
        .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(manualPayload()) }))
        .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(continuationPayload()) }));

      const result = await runPostExecutionReporting({
        runId: `run-large-${backend}`,
        goal: largePlan.goal,
        plan: largePlan,
        workingDir,
        backend,
        enabledBackends: [backend],
      });

      expect(result.status, backend).toBe("success");
      expect(mockRunCliProcess, backend).toHaveBeenCalledTimes(3);
      const argvText = mockRunCliProcess.mock.calls
        .map((call) => ((call[0] as { args: string[] }).args ?? []).join("\n"))
        .join("\n");
      expect(argvText.length, backend).toBeLessThan(10_000);
      expect(argvText, backend).toContain(
        "Read the complete post-execution prompt from this agent-history artifact path:",
      );
      expect(argvText, backend).not.toContain(largeMarker.slice(0, 120));

      const promptArtifacts = [0, 1, 2].map((index) => promptArtifactPathFor(index));
      expect(
        promptArtifacts.every((artifactPath) => artifactPath && fs.existsSync(artifactPath)),
      ).toBe(true);
      const promptContents = promptArtifacts.map((artifactPath) =>
        fs.readFileSync(artifactPath!, "utf8"),
      );
      expect(promptContents[0], backend).toContain("post-execution report generation");
      expect(promptContents[0], backend).toContain(largeMarker.slice(0, 120));
      expect(promptContents[0], backend).toContain("Return exactly one JSON object:");
      expect(promptContents[1], backend).toContain("prepare manual-test display data");
      expect(promptContents[1], backend).toContain("Saved post-execution report markdown:");
      expect(promptContents[2], backend).toContain("decide continuation");
      expect(promptContents[2], backend).toContain("Structured completion context:");
      expect(promptContents[2], backend).toContain(largeMarker.slice(0, 120));
    }
  });

  it("falls back to the other backend on a usage limit for each phase", async () => {
    const artifacts = resolvePostExecutionReportArtifactPaths({
      workingDir,
      runId: "run-fallback",
    });
    fs.mkdirSync(artifacts.historyDir, { recursive: true });
    fs.writeFileSync(artifacts.markdownPath, "# Existing Report\n\nSaved report body.\n", "utf8");
    fs.writeFileSync(
      artifacts.jsonPath,
      `${JSON.stringify(
        makeReport({ summary: "json-only-marker-for-source-link-test" }),
        null,
        2,
      )}\n`,
      "utf8",
    );

    const cases: Array<{
      name: string;
      run: () => Promise<{ status: string; backend?: CliWorkerId }>;
      successPayload: unknown;
    }> = [
      {
        name: "generateReport",
        successPayload: reportPayload(),
        run: () =>
          generateReport({
            runId: "run-fallback-generate",
            goal: "Build native reporting",
            plan,
            workingDir,
            backend: "claude_code",
            sessionId: "exec-session-1",
          }),
      },
      {
        name: "prepareManualTestDisplay",
        successPayload: manualPayload(),
        run: () =>
          prepareManualTestDisplay({
            runId: "run-fallback-manual",
            goal: "Build native reporting",
            plan,
            workingDir,
            backend: "claude_code",
            sessionId: "exec-session-1",
            report: makeReport(),
            artifacts,
          }),
      },
      {
        name: "decideContinuation",
        successPayload: continuationPayload(),
        run: () =>
          decideContinuation({
            runId: "run-fallback-continuation",
            goal: "Build native reporting",
            plan,
            workingDir,
            backend: "claude_code",
            sessionId: "exec-session-1",
            report: makeReport(),
            artifacts,
          }),
      },
    ];

    for (const entry of cases) {
      mockRunCliProcess.mockReset();
      mockRunCliProcess
        .mockResolvedValueOnce(
          cliResult({
            stderr: "API 429: monthly usage limit reached. Resets at 3pm.",
            exitCode: 1,
          }),
        )
        .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(entry.successPayload, "codex-1") }));

      const result = await entry.run();

      expect(result.status, entry.name).toBe("success");
      expect(result.backend, entry.name).toBe("codex");
      expect(commandFor(0), entry.name).toBe("/usr/bin/claude");
      expect(commandFor(1), entry.name).toBe("codex");
      expect(argsFor(0), entry.name).toEqual(
        expect.arrayContaining(["--resume", "exec-session-1"]),
      );
      expect(argsFor(1), entry.name).not.toContain("exec-session-1");
    }
  });

  it("prompts a fresh fallback backend with saved report artifacts when the original session is unavailable", async () => {
    const artifacts = resolvePostExecutionReportArtifactPaths({ workingDir, runId: "run-saved" });
    fs.mkdirSync(artifacts.historyDir, { recursive: true });
    fs.writeFileSync(
      artifacts.markdownPath,
      "# Saved Report\n\nManual test from saved report.\n",
      "utf8",
    );
    fs.writeFileSync(
      artifacts.jsonPath,
      `${JSON.stringify(
        makeReport({ summary: "json-only-marker-for-source-link-test" }),
        null,
        2,
      )}\n`,
      "utf8",
    );
    mockRunCliProcess
      .mockResolvedValueOnce(cliResult({ stdout: "session unavailable-session not found" }))
      .mockResolvedValueOnce(cliResult({ stdout: jsonlResult(manualPayload(), "codex-fresh") }));

    const result = await prepareManualTestDisplay({
      runId: "run-saved",
      goal: "Build native reporting",
      plan,
      workingDir,
      backend: "claude_code",
      sessionId: "unavailable-session",
      report: makeReport(),
      artifacts,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.backend).toBe("codex");
    expect(argsFor(1)).not.toContain("resume");
    expect(lastArg(1)).toContain("Saved post-execution report markdown:");
    expect(lastArg(1)).toContain("Manual test from saved report.");
    expect(lastArg(1)).toContain(
      `Saved post-execution report JSON Source Link: ${artifacts.jsonPath}`,
    );
    expect(lastArg(1)).not.toContain("```json");
    expect(lastArg(1)).not.toContain("json-only-marker-for-source-link-test");
  });

  it("returns a structured failure when both backends fail without rerunning completed plan steps", async () => {
    mockRunCliProcess
      .mockResolvedValueOnce(
        cliResult({ stderr: "Claude monthly usage limit reached.", exitCode: 1 }),
      )
      .mockResolvedValueOnce(
        cliResult({ stderr: "Codex weekly usage limit reached.", exitCode: 1 }),
      );

    const result = await runPostExecutionReporting({
      runId: "run-both-failed",
      goal: "Build native reporting",
      plan,
      workingDir,
      backend: "claude_code",
      sessionId: "exec-session-1",
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failure");
    expect(result.phase).toBe("generateReport");
    expect(result.reason).toContain("All compatible backends are exhausted");
    expect(mockRunCliProcess).toHaveBeenCalledTimes(2);
    expect(lastArg(0)).toContain("Do not rerun completed plan steps.");
    expect(lastArg(1)).toContain("Do not rerun completed plan steps.");
    expect(lastArg(0)).not.toContain("worker_result.json");
    expect(lastArg(1)).not.toContain("worker_result.json");
  });
});
