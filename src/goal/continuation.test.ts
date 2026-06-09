import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONTINUATION_BACKEND_UNAVAILABLE_MESSAGE,
  buildContinuationUserMessage,
  buildContinuationProposal,
  generateAndStoreContinuationProposal,
  generateContinuationAssessment,
  generateContinuationFromAchievedState,
  reviseContinuationProposal,
} from "./continuation.js";
import { createContinuationCliClient } from "./continuation-cli-client.js";
import { loadRun, saveRun } from "./run-store.js";
import type { ClaudeCodeLaunchSandboxConfig, CodexNativeSandboxConfig } from "./backend-sandbox.js";
import type { GoalLlmClient, SerializedRun } from "./types.js";
import { CONTINUATION_SYSTEM_PROMPT } from "../prompts/continuation/system-prompt.js";
import { resolveContinuationClient } from "../telegram/continuation-client.js";

let testStateDir: string;
let testManagedRoot: string;
let testGoalsDir: string;
let previousStateDir: string | undefined;
let previousManagedRoot: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.SMITHERSBOT_STATE_DIR;
  previousManagedRoot = process.env.SMITHERSBOT_GOALS_ROOT;
  testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-state-"));
  testManagedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-managed-"));
  testGoalsDir = path.join(testStateDir, "goals");
  process.env.SMITHERSBOT_STATE_DIR = testStateDir;
  process.env.SMITHERSBOT_GOALS_ROOT = testManagedRoot;
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.SMITHERSBOT_STATE_DIR;
  else process.env.SMITHERSBOT_STATE_DIR = previousStateDir;
  if (previousManagedRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
  else process.env.SMITHERSBOT_GOALS_ROOT = previousManagedRoot;
  fs.rmSync(testStateDir, { recursive: true, force: true });
  fs.rmSync(testManagedRoot, { recursive: true, force: true });
});

function makeRun(overrides: Partial<SerializedRun> = {}): SerializedRun {
  return {
    runId: "11111111-2222-4333-8444-555555555555",
    goal: "Improve the local status command",
    state: "done",
    plan: {
      goal: "Improve the local status command",
      workingDir: "/tmp/workspace",
      summary: "Update status output.",
      shortSummary: "Improve status",
      steps: [
        {
          id: "update-status",
          description: "Update the status command.",
          shortSummary: "Update status command",
          dependsOn: [],
          status: "done",
        },
      ],
    },
    stepResults: {
      "update-status": {
        stepId: "update-status",
        success: true,
        output: "done",
        durationMs: 1,
      },
    },
    blocked: null,
    answers: {},
    workingDir: "/tmp/workspace",
    model: undefined,
    dryRun: false,
    createdAt: "2026-01-30T00:00:00.000Z",
    updatedAt: "2026-01-30T00:00:00.000Z",
    planRevision: 2,
    planNumber: 3,
    completionSummary: "Implemented and verified the status command change.",
    ...overrides,
  };
}

function makeClient(response: string): GoalLlmClient {
  return {
    complete: vi.fn(async () => ({ text: response })),
  };
}

function twoPartPromptLongerThanCap(): string {
  const padding = " Keep this continuation planning context intact.".repeat(45);
  return [
    "Part A: remove and suppress DEV GATEWAY VERIFICATION prompt injection.",
    padding,
    "Part B: update README without mentioning dev gateway.",
  ].join("\n");
}

function writeTextFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function attachGoalBrief(run: SerializedRun, content: string): SerializedRun {
  const goalBriefPath = path.join(testManagedRoot, "history", run.runId, "wiki", "goal-brief.md");
  writeTextFile(goalBriefPath, content);
  return { ...run, goalBriefPath };
}

function attachPlanReport(run: SerializedRun, content: string): SerializedRun {
  const historyDir = path.join(testManagedRoot, "history", run.runId, "report");
  const markdownPath = path.join(historyDir, "post-execution-report.md");
  const jsonPath = path.join(historyDir, "post-execution-report.json");
  writeTextFile(markdownPath, content);
  writeTextFile(jsonPath, "{}\n");
  return {
    ...run,
    postExecutionReportArtifacts: {
      historyDir,
      markdownPath,
      jsonPath,
    },
  };
}

function anchoredHistoryPath(runId: string, workspaceSlug: string, ...segments: string[]): string {
  return path.join(testManagedRoot, "agent", "history", "goals", workspaceSlug, runId, ...segments);
}

function fakeClaudeSandbox(): ClaudeCodeLaunchSandboxConfig {
  return { settingsPath: path.join(testManagedRoot, "claude-settings.json"), args: [] };
}

function fakeCodexSandbox(workingDir: string): CodexNativeSandboxConfig {
  const sandboxRoot = path.join(testManagedRoot, "codex-sandbox");
  return {
    profileName: "smithersbot",
    executionRoot: workingDir,
    codexHome: path.join(sandboxRoot, "home"),
    configPath: path.join(sandboxRoot, "home", "config.toml"),
    helperDir: path.join(sandboxRoot, "bin"),
    helperPath: path.join(sandboxRoot, "bin", "codex-linux-sandbox"),
    codexPath: "/usr/bin/codex",
    authReferencePath: path.join(sandboxRoot, "home", "auth.json"),
    authSourcePath: path.join(sandboxRoot, "real-auth.json"),
    env: { CODEX_HOME: path.join(sandboxRoot, "home"), PATH: process.env.PATH ?? "" },
    args: [],
    configToml: "",
    deniedReadPaths: [],
    allowedReadPaths: [],
    writablePaths: [],
  };
}

function makeCliClient(params: {
  backends: Array<"codex" | "claude_code">;
  runCliProcess: NonNullable<
    NonNullable<Parameters<typeof createContinuationCliClient>[0]["deps"]>["runCliProcess"]
  >;
  availability?: Array<{ id: "pi" | "codex" | "claude_code"; available: boolean; reason?: string }>;
}): GoalLlmClient {
  const client = createContinuationCliClient({
    backends: params.backends,
    workingDir: "/tmp/workspace",
    deps: {
      runCliProcess: params.runCliProcess,
      detectBackendAvailability: () =>
        params.availability ?? [
          { id: "pi", available: false, reason: "disabled" },
          { id: "codex", available: true },
          { id: "claude_code", available: true },
        ],
      resolveClaudeBinary: () => "/usr/bin/claude",
      buildClaudeSandbox: () => fakeClaudeSandbox(),
      writeCodexSandbox: ({ workingDir }) => fakeCodexSandbox(workingDir),
      getCodexAskForApprovalPlacement: () => "after_exec",
    },
  });
  if (!client) throw new Error("expected CLI client");
  return client;
}

describe("continuation generator", () => {
  it("carries decision-readiness gate logic without test or diagnosis guide links", () => {
    expect(CONTINUATION_SYSTEM_PROMPT).toContain(
      "Only proceed to create a Plan when the goal is specific, measurable, and attainable; otherwise surface Decision(s) needed.",
    );
    expect(CONTINUATION_SYSTEM_PROMPT).toContain(
      "If a question can be answered by exploring the codebase, explore instead of asking.",
    );
    expect(CONTINUATION_SYSTEM_PROMPT).toContain(
      "Present all open Decisions in one message, each as multiple-choice with a recommended option.",
    );
    expect(CONTINUATION_SYSTEM_PROMPT).not.toContain("docs/goal-engine-guides/testing-guidance.md");
    expect(CONTINUATION_SYSTEM_PROMPT).not.toContain("docs/goal-engine-guides/diagnosis-guide.md");
  });

  it("loads Goal Brief and latest Plan Report from the stored history anchor", () => {
    const workingDir = path.join(testManagedRoot, "agent", "workspaces", "smithersbot-dev");
    const run = makeRun({
      runId: "run-anchor-continuation",
      workingDir,
      historyWorkspaceSlug: "test-workspace",
      goalBriefPath: anchoredHistoryPath(
        "run-anchor-continuation",
        "smithersbot-dev",
        "wiki",
        "goal-brief.md",
      ),
      postExecutionReportArtifacts: {
        historyDir: anchoredHistoryPath("run-anchor-continuation", "smithersbot-dev"),
        markdownPath: anchoredHistoryPath(
          "run-anchor-continuation",
          "smithersbot-dev",
          "post-execution-report.md",
        ),
        jsonPath: anchoredHistoryPath(
          "run-anchor-continuation",
          "smithersbot-dev",
          "post-execution-report.json",
        ),
      },
    });
    const finalBriefPath = anchoredHistoryPath(
      "run-anchor-continuation",
      "test-workspace",
      "wiki",
      "goal-brief.md",
    );
    const finalReportPath = anchoredHistoryPath(
      "run-anchor-continuation",
      "test-workspace",
      "post-execution-report.md",
    );
    writeTextFile(finalBriefPath, "## Remaining Work\n\nFinish stage two.\n");
    writeTextFile(finalReportPath, "# Plan Report\n\nAnchored report evidence.\n");

    const message = buildContinuationUserMessage(run);

    expect(message).toContain(`Goal Brief path: ${finalBriefPath}`);
    expect(message).toContain("Finish stage two.");
    expect(message).toContain(`Latest Plan Report path: ${finalReportPath}`);
    expect(message).toContain("Anchored report evidence.");
    expect(message).not.toContain("smithersbot-dev/run-anchor-continuation/wiki/goal-brief.md");
  });

  it("classifies achieved goals without recommending a continuation", async () => {
    const run = makeRun();
    const assessment = await generateContinuationAssessment({
      run,
      client: makeClient(
        JSON.stringify({
          outcome: "goal-achieved-no-continuation",
          goalAchieved: true,
          briefSummary: "The requested change is complete.",
          proposedPrompt: "",
          decisions: [],
        }),
      ),
    });

    expect(assessment).toEqual({
      outcome: "goal-achieved-no-continuation",
      goalAchieved: true,
      briefSummary: "The requested change is complete.",
    });
  });

  it("stores continuation API prompts under the selected workspace history", async () => {
    const run = makeRun({
      runId: "run-continuation-prompts",
      historyWorkspaceSlug: "test-workspace",
      workingDir: "/tmp/agent/workspaces/smithersbot-dev",
      model: "claude-test-model",
    });
    const client = makeClient(
      JSON.stringify({
        outcome: "continuation-recommended-now",
        goalAchieved: false,
        briefSummary: "A follow-up plan should add coverage.",
        proposedPrompt: "Add focused regression tests for status formatting.",
      }),
    );

    const assessment = await generateContinuationAssessment({ run, client });

    expect(assessment.outcome).toBe("continuation-recommended-now");
    const historyDir = anchoredHistoryPath(run.runId, "test-workspace");
    const promptDir = path.join(historyDir, "prompts");
    const promptFiles = fs.readdirSync(promptDir);
    expect(promptFiles).toHaveLength(1);
    expect(promptFiles[0]).toContain("-continuation-assessment-api-");
    const promptText = fs.readFileSync(path.join(promptDir, promptFiles[0]!), "utf8");
    expect(promptText).toContain(CONTINUATION_SYSTEM_PROMPT);
    expect(promptText).toContain("Goal ID: run-continuation-prompts");
    expect(promptText).not.toContain("DEV GATEWAY VERIFICATION");

    const events = fs
      .readFileSync(path.join(historyDir, "events.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { phase: string; backend: string; model?: string });
    expect(events).toEqual([
      expect.objectContaining({
        phase: "continuation-assessment",
        backend: "api",
        model: "claude-test-model",
      }),
    ]);
  });

  it("classifies recommended-now continuations and normalizes decisions", async () => {
    const run = makeRun();
    const assessment = await generateContinuationAssessment({
      run,
      client: makeClient(
        JSON.stringify({
          outcome: "continuation-recommended-now",
          goalAchieved: false,
          briefSummary: "A follow-up plan should add coverage.",
          proposedPrompt: "Add focused regression tests for status formatting.",
          decisions: [
            {
              question: "How broad should the tests be?",
              options: ["Focused", "Broad"],
              recommendedOption: "Focused",
              rationale: "The change is narrow.",
              promptImpact: "Keep the next plan limited to status tests.",
            },
          ],
          runAt: "now",
        }),
      ),
    });

    expect(assessment).toMatchObject({
      outcome: "continuation-recommended-now",
      briefSummary: "A follow-up plan should add coverage.",
      proposedPrompt: "Add focused regression tests for status formatting.",
      decisions: [
        {
          question: "How broad should the tests be?",
          recommendedOption: "Focused",
          promptImpact: "Keep the next plan limited to status tests.",
        },
      ],
    });
  });

  it("drafts useful decisions when Continue Goal is pressed from an achieved state", async () => {
    const run = makeRun({
      goal: "Report today's date and post-execution reporting live smoke completion.",
      completionSummary: "Reported today's date and the live smoke completion.",
    });

    const assessment = await generateContinuationFromAchievedState({ run });

    expect(assessment).toMatchObject({
      outcome: "continuation-recommended-now",
      goalAchieved: true,
    });
    if (assessment.outcome !== "continuation-recommended-now") {
      throw new Error("expected continuation");
    }
    expect(assessment.briefSummary).not.toMatch(
      /Another plan can be drafted|Continuation prompt edited|Another plan is recommended|🔁/,
    );
    expect(assessment.briefSummary).not.toMatch(/Draft a follow-up plan|decide what should happen/);
    expect(assessment.proposedPrompt).not.toBe("");
    expect(assessment.proposedPrompt).not.toMatch(
      /Draft a follow-up plan|decide what should happen/,
    );
    expect(assessment.decisions).toBeDefined();
    expect(assessment.decisions?.length).toBeGreaterThan(0);
    expect(assessment.decisions?.[0]?.question).toContain("What should the next plan do?");
    expect(assessment.decisions?.[0]?.options.join("\n")).toContain(
      "Something else. Use Request Edit.",
    );
  });

  it("sanitizes banned filler from model-generated continuation content", async () => {
    const assessment = await generateContinuationAssessment({
      run: makeRun(),
      client: makeClient(
        JSON.stringify({
          outcome: "continuation-recommended-now",
          goalAchieved: false,
          briefSummary: "Another plan is recommended. Add coverage. 🔁",
          proposedPrompt: "Next:\nAnother plan can be drafted under this goal. Add focused tests.",
          decisions: [
            {
              question: "Recommendation:\nWhich follow-up?",
              options: ["Focused tests", "-", "Broad tests"],
              recommendedOption: "Focused tests",
              rationale: "Continuation prompt edited. Narrow work is enough.",
            },
          ],
          runAt: "now",
        }),
      ),
    });

    expect(JSON.stringify(assessment)).not.toMatch(
      /Another plan can be drafted|Continuation prompt edited|Another plan is recommended|🔁/,
    );
    expect(JSON.stringify(assessment)).not.toContain("Next:");
    expect(JSON.stringify(assessment)).not.toContain("Recommendation:");
  });

  it("includes inline Goal Brief and latest Plan Report content in assessment context", async () => {
    const run = attachPlanReport(
      attachGoalBrief(
        makeRun(),
        [
          "# Goal Brief",
          "## Long Goal Summary",
          "Improve status output without changing unrelated commands.",
          "## Remaining Work",
          "None.",
          "## Observation Point",
          "After the status command is verified.",
        ].join("\n"),
      ),
      [
        "**Post-Execution Report:**",
        "**Summary:** Status output was improved.",
        "**Outcome:**",
        "- Plan completed: Yes",
        "- Goal appears achieved: Yes",
        "- Another plan recommended: No",
        "**Next Plan:** No next plan is recommended right now.",
      ].join("\n"),
    );
    const complete = vi.fn(async () => ({
      text: JSON.stringify({
        outcome: "goal-achieved-no-continuation",
        goalAchieved: true,
        briefSummary: "The requested change is complete.",
      }),
    }));

    await generateContinuationAssessment({ run, client: { complete } });

    const userMessage = complete.mock.calls[0]?.[0]?.userMessage ?? "";
    expect(userMessage).toContain("Goal Brief path:");
    expect(userMessage).toContain("Improve status output without changing unrelated commands.");
    expect(userMessage).toContain("Latest Plan Report path:");
    expect(userMessage).toContain("Status output was improved.");
    expect(userMessage).toContain("Remaining-work guidance:");
  });

  it("uses a CLI backend response through the same JSON normalization path", async () => {
    const runCliProcess = vi.fn(async () => ({
      stdout: JSON.stringify({
        type: "result",
        result: JSON.stringify({
          outcome: "continuation-recommended-now",
          goalAchieved: false,
          briefSummary: "Another plan is recommended. Add coverage. 🔁",
          proposedPrompt: "Next:\nAnother plan can be drafted under this goal. Add tests.",
          runAt: "now",
        }),
      }),
      stderr: "",
      timedOut: false,
      exitCode: 0,
      signal: null,
      durationMs: 10,
    }));
    const client = makeCliClient({ backends: ["codex"], runCliProcess });

    const assessment = await generateContinuationAssessment({
      run: makeRun(),
      client,
    });

    expect(runCliProcess).toHaveBeenCalledOnce();
    expect(assessment).toMatchObject({
      outcome: "continuation-recommended-now",
      goalAchieved: false,
    });
    expect(JSON.stringify(assessment)).not.toMatch(
      /Another plan can be drafted|Another plan is recommended|🔁|Next:/,
    );
  });

  it("falls back from a usage-limited CLI backend to the next configured backend", async () => {
    const runCliProcess = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "Claude Code usage limit reached; resets at 3pm.",
        timedOut: false,
        exitCode: 1,
        signal: null,
        durationMs: 10,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          type: "result",
          result: JSON.stringify({
            outcome: "continuation-recommended-now",
            goalAchieved: false,
            briefSummary: "Codex recovered and proposed tests.",
            proposedPrompt: "Add focused tests for the remaining work.",
            runAt: "now",
          }),
        }),
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 10,
      });
    const client = makeCliClient({ backends: ["claude_code", "codex"], runCliProcess });

    const assessment = await generateContinuationAssessment({ run: makeRun(), client });

    expect(runCliProcess).toHaveBeenCalledTimes(2);
    expect(runCliProcess.mock.calls.map((call) => call[0].command)).toEqual([
      "/usr/bin/claude",
      "codex",
    ]);
    expect(assessment).toMatchObject({
      outcome: "continuation-recommended-now",
      briefSummary: "Codex recovered and proposed tests.",
    });
  });

  it("wires the continuation resolver to a CLI client when no raw Anthropic key exists", async () => {
    const cliClient = makeClient(
      JSON.stringify({
        outcome: "goal-achieved-no-continuation",
        goalAchieved: true,
        briefSummary: "Complete.",
      }),
    );
    const createCliClient = vi.fn(() => cliClient);
    const client = resolveContinuationClient(
      { goal: { enabledWorkers: ["codex"], defaultWorkingDir: "/tmp/workspace" } },
      {
        env: {},
        createCliClient,
        cwd: () => "/tmp/unused",
      },
    );

    expect(client).toBe(cliClient);
    expect(createCliClient).toHaveBeenCalledWith(
      expect.objectContaining({
        backends: ["codex"],
        workingDir: "/tmp/workspace",
      }),
    );
  });

  it("turns stored remaining-work evidence into a non-achieved Stage 2 proposal", async () => {
    const run = attachPlanReport(
      attachGoalBrief(
        makeRun({
          goal: "Stage 1: create goal1.txt. Stage 2: continue this same goal with another plan that creates goal2.txt with goal 2 completed!",
          completionSummary: "Created goal1.txt only.",
        }),
        [
          "# Goal Brief",
          "## Long Goal Summary",
          "This goal has two stages.",
          "## Remaining Work",
          "Stage 2 remains: create goal2.txt in test-workspace with the exact text: goal 2 completed!",
          "## Observation Point",
          "After Stage 1, propose Plan 2 for Stage 2 only.",
        ].join("\n"),
      ),
      [
        "**Post-Execution Report:**",
        "**Summary:** Stage 1 created goal1.txt only.",
        "**Outcome:**",
        "- Plan completed: Yes",
        "- Goal appears achieved: No",
        "- Another plan recommended: Yes",
        "**Next Plan:** Create goal2.txt in test-workspace with the exact text: goal 2 completed!",
        "**Proposed prompt:**",
        "Create Plan 2 under the same Goal ID to do Stage 2 only: create goal2.txt with the exact text goal 2 completed!",
      ].join("\n"),
    );

    const assessment = await generateContinuationAssessment({
      run,
      client: makeClient(
        JSON.stringify({
          outcome: "goal-achieved-no-continuation",
          goalAchieved: true,
          briefSummary: "Stage 2 is already complete.",
        }),
      ),
    });

    expect(assessment).toMatchObject({
      outcome: "continuation-recommended-now",
      goalAchieved: false,
    });
    if (assessment.outcome !== "continuation-recommended-now") {
      throw new Error("expected continuation");
    }
    expect(assessment.briefSummary).toContain("goal2.txt");
    expect(assessment.proposedPrompt).toContain("Stage 2");
    expect(assessment.proposedPrompt).toContain("goal 2 completed");
    expect(assessment.proposedPrompt).not.toMatch(/already complete|validate Stage 1/i);
  });

  it("downgrades future-time recommendations instead of scheduling them", async () => {
    const run = makeRun();
    const assessment = await generateContinuationAssessment({
      run,
      client: makeClient(
        JSON.stringify({
          outcome: "continuation-recommended-now",
          goalAchieved: true,
          briefSummary: "Check back after the next release.",
          proposedPrompt: "Review post-release telemetry.",
          runAt: "2026-02-01T00:00:00.000Z",
        }),
      ),
    });

    expect(assessment.outcome).toBe("goal-achieved-no-continuation");
    expect(assessment.briefSummary).toContain("Future continuation scheduling is not implemented");
  });

  it("stores a pending continuation proposal using fromPlanNumber", async () => {
    const run = makeRun({ planNumber: 7, planRevision: 12 });
    saveRun(run, testGoalsDir);

    const proposal = await generateAndStoreContinuationProposal({
      runId: run.runId,
      goalsDir: testGoalsDir,
      client: makeClient(
        JSON.stringify({
          outcome: "continuation-recommended-now",
          goalAchieved: false,
          briefSummary: "A follow-up plan should document the behavior.",
          proposedPrompt: "Document the new status behavior.",
        }),
      ),
    });

    const stored = loadRun(run.runId, testGoalsDir);
    expect(proposal).toBeDefined();
    expect(stored?.pendingContinuation).toMatchObject({
      fromPlanNumber: 7,
      fromRevision: 12,
      status: "pending",
      runAt: "now",
      briefSummary: "A follow-up plan should document the behavior.",
      proposedPrompt: "Document the new status behavior.",
    });
  });

  it("preserves operational proposedPrompt beyond the display cap through assessment and report evidence", async () => {
    const longPrompt = twoPartPromptLongerThanCap();
    expect(longPrompt.length).toBeGreaterThan(1_500);
    const run = attachPlanReport(
      makeRun({
        postExecutionContinuation: {
          nextPlanRecommended: true,
          nextPlanSummary: "Follow up on the README and prompt-injection cleanup.",
          nextPlanPrompt: longPrompt,
          decisions: [],
        },
      }),
      [
        "**Post-Execution Report:**",
        "**Outcome:**",
        "- Plan completed: Yes",
        "- Goal appears achieved: No",
        "- Another plan recommended: Yes",
        "**Next Plan:** Follow up on the README and prompt-injection cleanup.",
        "**Proposed prompt:**",
        longPrompt,
      ].join("\n"),
    );

    const assessment = await generateContinuationAssessment({
      run,
      client: makeClient(
        JSON.stringify({
          outcome: "goal-achieved-no-continuation",
          goalAchieved: true,
          briefSummary: "The model incorrectly says no continuation is needed.",
        }),
      ),
    });

    expect(assessment.outcome).toBe("continuation-recommended-now");
    if (assessment.outcome !== "continuation-recommended-now") {
      throw new Error("expected continuation");
    }
    expect(assessment.proposedPrompt).toContain(
      "Part A: remove and suppress DEV GATEWAY VERIFICATION prompt injection.",
    );
    expect(assessment.proposedPrompt).toContain(
      "Part B: update README without mentioning dev gateway.",
    );
    expect(assessment.briefSummary.length).toBeLessThanOrEqual(503);
  });

  it("revises a continuation proposal without replacing the prompt verbatim", async () => {
    const run = makeRun({
      goal: "This goal has two stages: first create one artifact, then continue with a second plan.",
    });
    const proposal = buildContinuationProposal({
      run,
      assessment: {
        outcome: "continuation-recommended-now",
        goalAchieved: false,
        briefSummary: "Create the second-stage artifact.",
        proposedPrompt: "Create the second-stage artifact and verify it exists.",
        decisions: [
          {
            question: "Which artifact should be created?",
            options: ["Original second artifact", "Different second artifact"],
            recommendedOption: "Original second artifact",
            rationale: "It matches the original goal.",
          },
        ],
      },
      now: new Date("2026-01-30T00:00:00.000Z"),
    });
    const client: GoalLlmClient = {
      complete: vi.fn(async () => ({
        text: JSON.stringify({
          briefSummary: "Create the edited second artifact instead.",
          runAt: "now",
          proposedPrompt:
            "Create the edited second artifact instead, preserving the prior second-stage artifact verification intent.",
          decisions: [],
        }),
      })),
    };

    const revised = await reviseContinuationProposal({
      run,
      proposal,
      editInstruction: "Make the next plan create the edited second artifact instead.",
      client,
    });

    expect(revised.status).toBe("edited");
    expect(revised.runAt).toBe("now");
    expect(revised.briefSummary).toBe("Create the edited second artifact instead.");
    expect(revised.proposedPrompt).toContain("edited second artifact");
    expect(revised.proposedPrompt).not.toBe(
      "Make the next plan create the edited second artifact instead.",
    );
    expect(revised.briefSummary).not.toContain("Revise the next plan to incorporate");
    expect(revised.proposedPrompt).not.toContain("applying this edit");
    expect(revised.decisions).toBeUndefined();
  });

  it("preserves operational proposedPrompt beyond the display cap through Request Edit revision", async () => {
    const longPrompt = twoPartPromptLongerThanCap();
    expect(longPrompt.length).toBeGreaterThan(1_500);
    const run = makeRun();
    const proposal = buildContinuationProposal({
      run,
      assessment: {
        outcome: "continuation-recommended-now",
        goalAchieved: false,
        briefSummary: "Follow up on continuation behavior.",
        proposedPrompt: "Original shorter prompt.",
      },
      now: new Date("2026-01-30T00:00:00.000Z"),
    });
    const client: GoalLlmClient = {
      complete: vi.fn(async () => ({
        text: JSON.stringify({
          briefSummary: "Follow up on prompt-injection cleanup and README updates.",
          runAt: "now",
          proposedPrompt: longPrompt,
          decisions: [],
        }),
      })),
    };

    const revised = await reviseContinuationProposal({
      run,
      proposal,
      editInstruction: "Keep both requested parts.",
      client,
    });

    expect(revised.proposedPrompt).toContain(
      "Part A: remove and suppress DEV GATEWAY VERIFICATION prompt injection.",
    );
    expect(revised.proposedPrompt).toContain(
      "Part B: update README without mentioning dev gateway.",
    );
  });

  it("uses structured revision for the date-to-date-and-time continuation edit", async () => {
    const expectedPrompt =
      'Report today\'s date and current time and one sentence saying: "post-execution reporting UX smoke complete." Do NOT modify, create, or delete any files. Read-only only.';
    const run = makeRun({
      goal: 'Report today\'s date and one sentence saying: "post-execution reporting UX smoke complete." Do NOT modify, create, or delete any files. Read-only only.',
      completionSummary:
        'Reported today\'s date and one sentence saying: "post-execution reporting UX smoke complete."',
    });
    const assessment = await generateContinuationFromAchievedState({ run });
    if (assessment.outcome !== "continuation-recommended-now") {
      throw new Error("expected achieved continuation proposal");
    }
    const proposal = buildContinuationProposal({
      run,
      assessment,
      now: new Date("2026-01-30T00:00:00.000Z"),
    });
    const complete = vi.fn(async () => ({
      text: JSON.stringify({
        briefSummary: "Read-only report: today's date and time + smoke-complete sentence",
        runAt: "now",
        decisions: [],
        proposedPrompt: expectedPrompt,
      }),
    }));
    const client: GoalLlmClient = { complete };

    const revised = await reviseContinuationProposal({
      run,
      proposal,
      editInstruction: "the next one should do date and time, not just date",
      client,
    });

    expect(revised).toMatchObject({
      briefSummary: "Read-only report: today's date and time + smoke-complete sentence",
      proposedPrompt: expectedPrompt,
      runAt: "now",
      status: "edited",
    });
    expect(revised.decisions).toBeUndefined();
    expect(revised.proposedPrompt).not.toContain("the next one should do date and time");
    expect(complete).toHaveBeenCalledOnce();
  });

  it("stores an achieved/no-next-plan proposal when no continuation is recommended", async () => {
    const run = makeRun();
    saveRun(run, testGoalsDir);

    const proposal = await generateAndStoreContinuationProposal({
      runId: run.runId,
      goalsDir: testGoalsDir,
      client: makeClient(
        JSON.stringify({
          outcome: "goal-achieved-no-continuation",
          goalAchieved: true,
          briefSummary: "No further work is useful right now.",
        }),
      ),
    });

    expect(proposal).toMatchObject({
      goalAchieved: true,
      briefSummary: "No further work is useful right now.",
      proposedPrompt: "",
      status: "pending",
    });
    expect(loadRun(run.runId, testGoalsDir)?.pendingContinuation).toMatchObject({
      goalAchieved: true,
      briefSummary: "No further work is useful right now.",
      proposedPrompt: "",
      status: "pending",
    });
  });

  it("surfaces a recoverable failure without storing a false achieved proposal when no client is available", async () => {
    const run = makeRun();
    saveRun(run, testGoalsDir);
    const onError = vi.fn();

    const proposal = await generateAndStoreContinuationProposal({
      runId: run.runId,
      goalsDir: testGoalsDir,
      onError,
    });

    const stored = loadRun(run.runId, testGoalsDir);
    expect(proposal).toBeUndefined();
    expect(stored?.state).toBe("done");
    expect(stored?.pendingContinuation).toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
    expect(String(onError.mock.calls[0]?.[0])).toContain(CONTINUATION_BACKEND_UNAVAILABLE_MESSAGE);
  });

  it("surfaces a recoverable failure without storing a false achieved proposal when generation fails", async () => {
    const run = makeRun();
    saveRun(run, testGoalsDir);
    const onError = vi.fn();

    const proposal = await generateAndStoreContinuationProposal({
      runId: run.runId,
      goalsDir: testGoalsDir,
      client: {
        complete: vi.fn(async () => {
          throw new Error("model unavailable");
        }),
      },
      onError,
    });

    const stored = loadRun(run.runId, testGoalsDir);
    expect(proposal).toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
    expect(stored?.state).toBe("done");
    expect(stored?.pendingContinuation).toBeUndefined();
  });

  it("can regenerate a pending proposal after a completed feedback pass", async () => {
    const run = makeRun({
      planRevision: 4,
      pendingContinuation: {
        proposalId: "old-proposal",
        fromPlanNumber: 3,
        fromRevision: 3,
        goalAchieved: false,
        briefSummary: "Old proposal",
        proposedPrompt: "Old prompt",
        runAt: "now",
        status: "pending",
        createdAt: "2026-01-30T00:00:00.000Z",
      },
    });
    saveRun(run, testGoalsDir);

    const proposal = await generateAndStoreContinuationProposal({
      runId: run.runId,
      goalsDir: testGoalsDir,
      client: makeClient(
        JSON.stringify({
          outcome: "continuation-recommended-now",
          goalAchieved: false,
          briefSummary: "Feedback is complete; add the next polish plan.",
          proposedPrompt: "Polish the behavior after incorporated feedback.",
        }),
      ),
    });

    const stored = loadRun(run.runId, testGoalsDir);
    expect(proposal?.proposalId).not.toBe("old-proposal");
    expect(stored?.pendingContinuation).toMatchObject({
      fromPlanNumber: 3,
      fromRevision: 4,
      briefSummary: "Feedback is complete; add the next polish plan.",
      proposedPrompt: "Polish the behavior after incorporated feedback.",
      status: "pending",
    });
  });
});
