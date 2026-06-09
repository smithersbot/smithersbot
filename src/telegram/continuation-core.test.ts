import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { acquireGoalOpLock } from "../goal/goal-lock.js";
import { loadRun, saveRun } from "../goal/run-store.js";
import type { ContinuationProposal, Plan, SerializedRun } from "../goal/types.js";
import {
  applyContinuationEditReply,
  applyResumeDetailsReply,
  handleContinuationProposalAction,
  openAddDetailsReply,
} from "./continuation-core.js";

let testGoalsDir: string;

vi.mock("../goal/run-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../goal/run-store.js")>();
  return {
    ...actual,
    resolveGoalsDir: () => testGoalsDir,
    listRuns: (dir?: string) => actual.listRuns(dir ?? testGoalsDir),
    loadRun: (id: string, dir?: string) => actual.loadRun(id, dir ?? testGoalsDir),
    saveRun: (run: SerializedRun, dir?: string) => actual.saveRun(run, dir ?? testGoalsDir),
    resolveRunId: (partial: string, dir?: string) =>
      actual.resolveRunId(partial, dir ?? testGoalsDir),
  };
});

const RUN_ID = "aaaaaaaa-1111-2222-3333-444444444444";
const PROPOSAL_ID = "bbbbbbbb-2222-3333-4444-555555555555";

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    goal: "Test continuation",
    workingDir: "/tmp/ws",
    summary: "Plan summary",
    shortSummary: "Plan summary",
    steps: [
      {
        id: "blocked-step",
        description: "Blocked step",
        shortSummary: "Blocked step",
        dependsOn: [],
        status: "blocked",
        blockedReason: "user_input",
        blockedQuestion: "Need details",
      },
    ],
    ...overrides,
  };
}

function proposal(overrides: Partial<ContinuationProposal> = {}): ContinuationProposal {
  return {
    proposalId: PROPOSAL_ID,
    fromPlanNumber: 1,
    fromRevision: 3,
    goalAchieved: false,
    briefSummary: "Continue verification.",
    proposedPrompt: "Draft the next verification plan.",
    runAt: "now",
    status: "pending",
    createdAt: "2026-05-31T12:00:00.000Z",
    ...overrides,
  };
}

function run(overrides: Partial<SerializedRun> = {}): SerializedRun {
  return {
    runId: RUN_ID,
    goal: "Test continuation",
    state: "done",
    plan: plan(),
    stepResults: {},
    blocked: null,
    answers: {},
    workingDir: "/tmp/ws",
    model: undefined,
    dryRun: false,
    createdAt: "2026-05-31T00:00:00.000Z",
    updatedAt: "2026-05-31T00:00:00.000Z",
    planRevision: 3,
    activePlanRevision: 3,
    planNumber: 1,
    pendingContinuation: proposal(),
    ...overrides,
  };
}

function writeTextArtifact(filePath: string, content: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function withGoalBrief(baseRun: SerializedRun, content: string): SerializedRun {
  const goalBriefPath = writeTextArtifact(
    path.join(testGoalsDir, baseRun.runId, "wiki", "goal-brief.md"),
    content,
  );
  return { ...baseRun, goalBriefPath };
}

function withPlanReport(baseRun: SerializedRun, content: string): SerializedRun {
  const historyDir = path.join(testGoalsDir, baseRun.runId, "reports");
  const markdownPath = writeTextArtifact(
    path.join(historyDir, "post-execution-report.md"),
    content,
  );
  return {
    ...baseRun,
    postExecutionReportArtifacts: {
      historyDir,
      markdownPath,
      jsonPath: path.join(historyDir, "post-execution-report.json"),
    },
  };
}

describe("continuation core", () => {
  beforeEach(() => {
    testGoalsDir = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-core-"));
  });

  afterEach(() => {
    fs.rmSync(testGoalsDir, { recursive: true, force: true });
  });

  it("returns View Prompt surface without a grammY context and without buttons", async () => {
    saveRun(run());

    const result = await handleContinuationProposalAction({
      action: "more_details",
      runId: "aaaaaaaa",
      proposalIdPrefix: "bbbbbbbb",
    });

    expect(result.messages[0]?.text).toContain("Draft the next verification plan.");
    expect(result.messages[0]?.text).toBe(
      [
        "**Proposed next plan prompt for Goal aaaaaaaa:**",
        "Draft the next verification plan.",
      ].join("\n"),
    );
    expect(result.messages[0]?.replyMarkup).toBeUndefined();
    expect(result.messages[0]?.text).not.toContain("**Next Plan Summary:**");
    expect(result.messages[0]?.text).not.toContain("**Decision(s) needed:**");
    expect(loadRun(RUN_ID)?.pendingContinuation?.status).toBe("pending");
  });

  it("silently resolves stale non-Approve actions against the current pending proposal", async () => {
    saveRun(run());

    const staleView = await handleContinuationProposalAction({
      action: "more_details",
      runId: "aaaaaaaa",
      proposalIdPrefix: "deadbeef",
    });
    const staleEdit = await handleContinuationProposalAction({
      action: "request_edit",
      runId: "aaaaaaaa",
      proposalIdPrefix: "deadbeef",
      notify: { chatId: 42, messageId: 700 },
    });
    const staleApprove = await handleContinuationProposalAction({
      action: "approve_prompt",
      runId: "aaaaaaaa",
      proposalIdPrefix: "deadbeef",
    });

    expect(staleView.messages[0]?.text).toContain("Draft the next verification plan.");
    expect(staleEdit.messages[0]?.text).toContain("Reply with edits");
    expect(loadRun(RUN_ID)?.pendingContinuation?.notify).toEqual({ chatId: 42, messageId: 700 });
    expect(staleApprove.messages[0]?.text).toBe("That continuation prompt is no longer current.");
  });

  it("records Request Edit pending notify state by run and action", async () => {
    saveRun(run());

    const result = await handleContinuationProposalAction({
      action: "request_edit",
      runId: "aaaaaaaa",
      proposalIdPrefix: "bbbbbbbb",
      notify: { chatId: 42, messageId: 700 },
    });

    expect(result.messages[0]?.text).toContain("Reply with edits");
    expect(loadRun(RUN_ID)?.pendingContinuation?.notify).toEqual({ chatId: 42, messageId: 700 });
  });

  it("applies Request Edit by recomputing structured fields with full context", async () => {
    const editText = "Make the next plan verify goal2-edited.txt instead of goal2.txt.";
    const goalBriefContent = [
      "# Goal Brief",
      "",
      "## Remaining Work",
      "Create goal2.txt as Stage 2.",
      "",
      "## Next Observation Point",
      "After Plan 2 has a concrete artifact.",
    ].join("\n");
    const planReportContent = [
      "# Plan Report",
      "",
      "**Goal appears achieved:** No",
      "**Another plan recommended:** Yes",
      "**Next Plan:** Create the Stage 2 artifact.",
    ].join("\n");
    saveRun(
      withPlanReport(
        withGoalBrief(
          run({
            goal: "Stage 1 is done; Stage 2 still needs a goal2 artifact.",
            completionSummary: "Stage 1 created goal1.txt only.",
          }),
          goalBriefContent,
        ),
        planReportContent,
      ),
    );
    const client = {
      complete: vi.fn(async () => ({
        text: JSON.stringify({
          briefSummary: "Verify goal2-edited.txt instead of goal2.txt.",
          runAt: "now",
          proposedPrompt:
            "Draft the next verification plan for goal2-edited.txt instead of goal2.txt.",
          decisions: [],
        }),
      })),
    };

    const result = await applyContinuationEditReply({
      runId: "aaaaaaaa",
      text: editText,
      client,
    });

    expect(result.messages[0]?.text).toContain("Continue this goal with a new plan?");
    expect(result.messages[0]?.text).toContain("Verify goal2-edited.txt instead of goal2.txt.");
    expect(result.messages[0]?.text).toContain("goal2-edited.txt");
    expect(result.messages[0]?.text).toContain("**Decision(s) needed:**\nNone");
    expect(result.messages[0]?.text).not.toContain("Continuation prompt edited");
    expect(result.messages[0]?.text).not.toContain("Revise the next plan to incorporate");
    expect(loadRun(RUN_ID)?.pendingContinuation).toMatchObject({
      briefSummary: "Verify goal2-edited.txt instead of goal2.txt.",
      proposedPrompt: "Draft the next verification plan for goal2-edited.txt instead of goal2.txt.",
      status: "edited",
      lastContinuationEditMessage: editText,
    });
    expect(loadRun(RUN_ID)?.pendingContinuation?.decisions).toBeUndefined();
    expect(loadRun(RUN_ID)?.pendingContinuation?.proposedPrompt).not.toBe(editText);
    expect(loadRun(RUN_ID)?.pendingContinuation?.proposedPrompt).not.toContain(
      "Draft the next verification plan.\n\n",
    );
    expect(client.complete).toHaveBeenCalledOnce();
    const userMessage = client.complete.mock.calls[0]?.[0].userMessage ?? "";
    expect(userMessage).toContain(`Goal ID: ${RUN_ID}`);
    expect(userMessage).toContain("Goal: Stage 1 is done; Stage 2 still needs a goal2 artifact.");
    expect(userMessage).toContain("Completion summary:\nStage 1 created goal1.txt only.");
    expect(userMessage).toContain("Current plan result evidence:");
    expect(userMessage).toContain("Goal Brief path:");
    expect(userMessage).toContain("Create goal2.txt as Stage 2.");
    expect(userMessage).toContain("Latest Plan Report path:");
    expect(userMessage).toContain("Next Plan:** Create the Stage 2 artifact.");
    expect(userMessage).toContain("Existing continuation proposal:");
    expect(userMessage).toContain(`User edit instruction: ${editText}`);

    const current = await handleContinuationProposalAction({
      action: "more_details",
      runId: "aaaaaaaa",
      proposalIdPrefix: "bbbbbbbb",
    });
    expect(current.messages[0]?.text).toContain(
      "Draft the next verification plan for goal2-edited.txt instead of goal2.txt.",
    );
    expect(current.messages[0]?.text).not.toContain(
      "That continuation prompt is no longer current.",
    );
  });

  it("surfaces missing revision backends without mutating the proposal or Goal Brief", async () => {
    const original = withGoalBrief(run(), "# Goal Brief\n\n## Remaining Work\nKeep this intact.");
    saveRun(original);

    const result = await applyContinuationEditReply({
      runId: "aaaaaaaa",
      text: "Make the next plan do something else.",
    });

    const stored = loadRun(RUN_ID);
    expect(result.messages[0]?.text).toContain(
      "Continuation revision failed because no continuation backend was available.",
    );
    expect(stored?.pendingContinuation).toEqual(original.pendingContinuation);
    expect(fs.readFileSync(original.goalBriefPath!, "utf8")).toBe(
      "# Goal Brief\n\n## Remaining Work\nKeep this intact.",
    );
  });

  it("records an already-joined Request Edit message as one logical edit", async () => {
    const joinedEditText = "First continuation edit chunk. Second continuation edit chunk.";
    saveRun(run());
    const client = {
      complete: vi.fn(async () => ({
        text: JSON.stringify({
          briefSummary: "Continue with the joined edit.",
          runAt: "now",
          proposedPrompt: "Draft the next plan from the joined edit.",
          decisions: [],
        }),
      })),
    };

    await applyContinuationEditReply({
      runId: "aaaaaaaa",
      text: joinedEditText,
      client,
    });

    expect(client.complete).toHaveBeenCalledTimes(1);
    expect(loadRun(RUN_ID)?.pendingContinuation).toMatchObject({
      status: "edited",
      lastContinuationEditMessage: joinedEditText,
    });
  });

  it("archives No Further Plan and leaves the run done", async () => {
    saveRun(run());

    const result = await handleContinuationProposalAction({
      action: "no_further_plan",
      runId: "aaaaaaaa",
      proposalIdPrefix: "bbbbbbbb",
    });

    const stored = loadRun(RUN_ID)!;
    expect(result.messages[0]?.text).toContain("No further plan");
    expect(stored.state).toBe("done");
    expect(stored.pendingContinuation).toBeUndefined();
    expect(stored.continuationHistory?.[0]).toMatchObject({ status: "superseded" });
  });

  it("Make Another Plan turns an achieved surface into an approvable Plan 2 prompt", async () => {
    saveRun(
      run({
        pendingContinuation: proposal({
          goalAchieved: true,
          briefSummary: "No next plan needed.",
          proposedPrompt: "",
        }),
      }),
    );

    const result = await handleContinuationProposalAction({
      action: "make_another_plan",
      runId: "aaaaaaaa",
      proposalIdPrefix: "bbbbbbbb",
    });

    const stored = loadRun(RUN_ID);
    expect(result.messages[0]?.text).toContain("🧭 **Continue this goal with a new plan?**");
    expect(result.messages[0]?.text).toContain("**Decision 1.** What should the next plan do?");
    expect(result.messages[0]?.text).toContain("Something else. Use Request Edit.");
    expect(result.messages[0]?.text).not.toContain("**Decision(s) needed:**\nNone");
    expect(result.messages[0]?.text).not.toContain("Another plan can be drafted under this goal.");
    expect(result.messages[0]?.text).not.toContain("Another plan is recommended.");
    expect(result.messages[0]?.text).not.toContain("🔁");
    expect(result.messages[0]?.text.toLowerCase()).not.toContain("cycle");
    expect(result.messages[0]?.replyMarkup).toEqual({
      inline_keyboard: [
        [
          { text: "❤️ Approve", callback_data: "gca:aaaaaaaa:bbbbbbbb" },
          { text: "🔍 View Prompt", callback_data: "gcm:aaaaaaaa:bbbbbbbb" },
        ],
        [{ text: "📝 Request Edit", callback_data: "gce:aaaaaaaa:bbbbbbbb" }],
      ],
    });
    expect(stored?.pendingContinuation).toMatchObject({
      goalAchieved: false,
      status: "pending",
    });
    expect(stored?.pendingContinuation?.briefSummary).not.toContain(
      "Another plan can be drafted under this goal.",
    );
    expect(stored?.pendingContinuation?.decisions?.length).toBeGreaterThan(0);
    expect(stored?.state).toBe("done");
    expect(stored?.planNumber).toBe(1);
  });

  it("returns Approve Prompt preface without starting Telegram background work", async () => {
    saveRun(run());

    const result = await handleContinuationProposalAction({
      action: "approve_prompt",
      runId: "aaaaaaaa",
      proposalIdPrefix: "bbbbbbbb",
    });

    expect(result.messages[0]?.text).toBe("Right away, sir. Drafting Plan 2 now.");
    expect(loadRun(RUN_ID)?.pendingContinuation?.status).toBe("pending");
  });

  it("treats a deterministic post-Done achieved proposal as current for continuation actions", async () => {
    for (const action of [
      "more_details",
      "approve_prompt",
      "make_another_plan",
      "no_further_plan",
    ] as const) {
      saveRun(
        run({
          pendingContinuation: proposal({
            goalAchieved: true,
            briefSummary: "Goal appears achieved; no next plan is recommended right now.",
            proposedPrompt: "",
          }),
        }),
      );

      const result = await handleContinuationProposalAction({
        action,
        runId: "aaaaaaaa",
        proposalIdPrefix: "bbbbbbbb",
      });

      expect(result.messages[0]?.text).not.toContain(
        "That continuation prompt is no longer current",
      );
    }
  });

  it("opens Add Details and records follow-up text as a goal-level note", () => {
    saveRun(
      run({
        state: "blocked",
        blocked: {
          blockedAt: "execution",
          prompt: "Need input",
          requiredInputKey: "task:blocked-step:input",
        },
        pendingContinuation: undefined,
      }),
    );

    const opened = openAddDetailsReply({ runId: "aaaaaaaa" });
    const lock = acquireGoalOpLock(RUN_ID, "resume");
    expect(lock.acquired).toBe(true);
    let applied: ReturnType<typeof applyResumeDetailsReply> | undefined;
    let stored: SerializedRun | undefined;
    try {
      applied = applyResumeDetailsReply({
        runId: "aaaaaaaa",
        source: "add_details",
        text: "Use postgres.",
        now: () => "2026-06-01T00:00:00.000Z",
      });
      stored = loadRun(RUN_ID)!;
    } finally {
      if (lock.acquired) lock.release();
    }

    expect(opened.messages[0]?.text).toContain("unblocking details");
    expect(applied?.messages[0]?.text).toBe("Right away, sir. Resuming the goal now.");
    expect(applied?.messages[0]?.text).not.toContain("rescheduled");
    expect(applied?.messages[0]?.text).not.toContain("did not start");
    expect(applied?.state).toBe("blocked");
    expect(stored?.resumeNotes?.[0]).toMatchObject({
      source: "add_details",
      userText: "Use postgres.",
      affectedStepIds: ["blocked-step"],
    });
  });

  it("Add Details resumes a run-level resume_execution marker before acknowledging resume", () => {
    saveRun(
      run({
        state: "blocked",
        blocked: {
          blockedAt: "execution",
          prompt: "Worker interrupted.",
          requiredInputKey: "resume_execution",
        },
        plan: plan({
          steps: [
            {
              id: "resume-work",
              description: "Resume work",
              shortSummary: "Resume work",
              dependsOn: [],
              status: "pending",
              durationMinutes: 1,
            },
          ],
        }),
        pendingContinuation: undefined,
        resumeNotes: [],
      }),
    );

    const lock = acquireGoalOpLock(RUN_ID, "resume");
    expect(lock.acquired).toBe(true);
    let result: ReturnType<typeof applyResumeDetailsReply> | undefined;
    let stored: SerializedRun | undefined;
    try {
      result = applyResumeDetailsReply({
        runId: "aaaaaaaa",
        source: "add_details",
        text: "Continue from the last checkpoint.",
        now: () => "2026-06-01T00:00:00.000Z",
      });
      stored = loadRun(RUN_ID)!;
    } finally {
      if (lock.acquired) lock.release();
    }

    expect(result?.status).toBe("applied");
    expect(result?.state).toBe("blocked");
    expect(result?.messages[0]?.text).toBe("Right away, sir. Resuming the goal now.");
    expect(result?.messages[0]?.text).not.toContain("rescheduled");
    expect(result?.messages[0]?.text).not.toContain("did not start");
    expect(stored?.state).toBe("blocked");
    expect(stored?.blocked).toBeNull();
    expect(stored?.resumeNotes?.[0]).toMatchObject({
      source: "add_details",
      userText: "Continue from the last checkpoint.",
      affectedStepIds: [],
    });
  });

  it("records Add Details without the resume ack when no execution operation is scheduled", () => {
    saveRun(
      run({
        state: "blocked",
        blocked: {
          blockedAt: "execution",
          prompt: "Need input",
          requiredInputKey: "task:blocked-step:input",
        },
        pendingContinuation: undefined,
        resumeNotes: [],
      }),
    );

    const result = applyResumeDetailsReply({
      runId: "aaaaaaaa",
      source: "add_details",
      text: "Use postgres.",
      now: () => "2026-06-01T00:00:00.000Z",
    });

    const stored = loadRun(RUN_ID)!;
    expect(result.status).toBe("applied");
    expect(result.messages[0]?.text).toBe("Right away, sir. Resuming the goal now.");
    expect(result.messages[0]?.text).not.toContain("did not start");
    expect(result.messages[0]?.text).not.toContain("rescheduled");
    expect(stored.resumeNotes?.[0]).toMatchObject({
      source: "add_details",
      userText: "Use postgres.",
      affectedStepIds: ["blocked-step"],
    });
  });

  it("explains a non-resumable Add Details reply instead of claiming resume", () => {
    saveRun(
      run({
        state: "blocked",
        blocked: {
          blockedAt: "execution",
          prompt: "Which database?",
          requiredInputKey: "task:missing-step:input",
        },
        plan: plan({
          steps: [
            {
              id: "pending-work",
              description: "Pending work",
              shortSummary: "Pending work",
              dependsOn: [],
              status: "pending",
              durationMinutes: 1,
            },
          ],
        }),
        pendingContinuation: undefined,
        resumeNotes: [],
      }),
    );

    const result = applyResumeDetailsReply({
      runId: "aaaaaaaa",
      source: "add_details",
      text: "Use postgres.",
      now: () => "2026-06-01T00:00:00.000Z",
    });

    const stored = loadRun(RUN_ID)!;
    expect(result.status).toBe("noop");
    expect(result.state).toBe("blocked");
    expect(result.messages[0]?.text).toBe(
      "No blocked, paused, or failed steps need input/resume right now. The goal is currently blocked.",
    );
    expect(result.messages[0]?.text).not.toContain("Added those details");
    expect(result.messages[0]?.text).not.toContain("rescheduled");
    expect(stored.state).toBe("blocked");
    expect(stored.blocked?.requiredInputKey).toBe("task:missing-step:input");
    expect(stored.resumeNotes).toEqual([]);
  });

  it("records Resume button intent as a resume note", () => {
    saveRun(
      run({
        state: "blocked",
        blocked: {
          blockedAt: "execution",
          prompt: "Need input",
          requiredInputKey: "task:blocked-step:input",
        },
        pendingContinuation: undefined,
      }),
    );

    const lock = acquireGoalOpLock(RUN_ID, "resume");
    expect(lock.acquired).toBe(true);
    let result: ReturnType<typeof applyResumeDetailsReply> | undefined;
    let stored: SerializedRun | undefined;
    try {
      result = applyResumeDetailsReply({
        runId: "aaaaaaaa",
        source: "resume",
        now: () => "2026-06-01T00:00:00.000Z",
      });
      stored = loadRun(RUN_ID)!;
    } finally {
      if (lock.acquired) lock.release();
    }

    expect(result?.messages[0]?.text).toContain("Resuming 1 step");
    expect(stored?.resumeNotes?.[0]).toMatchObject({ source: "resume" });
  });
});
