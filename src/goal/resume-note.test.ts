import { describe, expect, it } from "vitest";
import { applyResumeNote, renderResumeNoteBody } from "./resume-note.js";
import type { GoalSession, Plan, PlanStep } from "./types.js";

function step(overrides: Partial<PlanStep> & { id: string }): PlanStep {
  return {
    id: overrides.id,
    description: `Step ${overrides.id}`,
    shortSummary: `Step ${overrides.id}`,
    dependsOn: [],
    status: "pending",
    ...overrides,
  };
}

function session(steps: PlanStep[], overrides: Partial<GoalSession> = {}): GoalSession {
  const plan: Plan = {
    goal: "Test goal",
    workingDir: "/tmp/ws",
    summary: "Test plan",
    shortSummary: "Test goal",
    steps,
  };
  return {
    goal: "Test goal",
    state: "blocked",
    plan,
    stepResults: new Map(),
    blocked: {
      blockedAt: "execution",
      prompt: "Need input",
      requiredInputKey: "tasks:blocked-a,paused-b,failed-c:input",
    },
    answers: {},
    resumeNotes: [],
    ...overrides,
  };
}

describe("applyResumeNote", () => {
  it("reschedules blocked, paused, and failed persisted blocked steps without changing run state", () => {
    const blocked = step({
      id: "blocked-a",
      status: "blocked",
      blockedReason: "user_input",
      blockedQuestion: "Need detail.",
    });
    const paused = step({
      id: "paused-b",
      status: "blocked",
      blockedReason: "usage_limit",
      blockedQuestion: "Usage exhausted.",
      failedDetail: {
        whatTried: "Waited",
        errorType: "usage_limit",
        suggestedNext: "Resume later",
        needsRevert: false,
      },
    });
    const failed = step({
      id: "failed-c",
      status: "blocked",
      blockedReason: "task_failed",
      ralphDetail: {
        approachTried: "Old approach",
        specificErrors: "No route",
        keyInsight: "Try another route",
        suggestedApproach: "Retry",
      },
    });
    const done = step({ id: "done-d", status: "done", blockedReason: "error" });
    const executing = step({ id: "exec-e", status: "in_progress", blockedReason: "error" });
    const pending = step({ id: "pending-f", status: "pending" });
    const goal = session([blocked, paused, failed, done, executing, pending]);

    const result = applyResumeNote(goal, {
      source: "add_details",
      userText: "The service is fixed now.",
      now: "2026-05-30T12:00:00.000Z",
    });

    expect(result).toMatchObject({
      rescheduledStepIds: ["blocked-a", "paused-b", "failed-c"],
      noteAdded: true,
      goalState: "blocked",
    });
    expect(goal.resumeNotes).toEqual([
      {
        timestamp: "2026-05-30T12:00:00.000Z",
        source: "add_details",
        affectedStepIds: ["blocked-a", "paused-b", "failed-c"],
        userText: "The service is fixed now.",
      },
    ]);
    expect([blocked.status, paused.status, failed.status]).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    expect(blocked.blockedReason).toBeUndefined();
    expect(blocked.blockedQuestion).toBeUndefined();
    expect(paused.failedDetail).toBeUndefined();
    expect(failed.ralphDetail).toBeUndefined();
    expect(done.status).toBe("done");
    expect(done.blockedReason).toBe("error");
    expect(executing.status).toBe("in_progress");
    expect(executing.blockedReason).toBe("error");
    expect(pending.status).toBe("pending");
    expect(goal.state).toBe("blocked");
    expect(goal.blocked).toBeNull();
    expect(goal.answers["task:blocked-a:input"]).toBe("The service is fixed now.");
    expect(goal.answers["task:paused-b:input"]).toBeUndefined();
    expect(goal.answers["task:failed-c:input"]).toBeUndefined();
    expect(result.noteBody).toContain("Message at 2026-05-30T12:00:00.000Z to unblock step(s):");
    expect(result.noteBody).toContain("blocked-a\npaused-b\nfailed-c");
    expect(result.noteBody).toContain("User details:\nThe service is fixed now.");
  });

  it("records user details as a per-step answer when clearing a user_input block", () => {
    const needsInput = step({
      id: "needs-input",
      status: "blocked",
      blockedReason: "user_input",
      blockedQuestion: "Which database should we use?",
    });
    const goal = session([needsInput], {
      blocked: {
        blockedAt: "execution",
        prompt: "Which database should we use?",
        requiredInputKey: "task:needs-input:input",
        stepId: "needs-input",
      },
    });

    const result = applyResumeNote(goal, {
      source: "goal_answer",
      userText: "Use Postgres.",
      now: "2026-05-30T12:00:00.000Z",
    });

    expect(result).toMatchObject({
      rescheduledStepIds: ["needs-input"],
      noteAdded: true,
      goalState: "blocked",
    });
    expect(goal.answers["task:needs-input:input"]).toBe("Use Postgres.");
    expect(goal.blocked).toBeNull();
    expect(needsInput.status).toBe("pending");
    expect(needsInput.blockedReason).toBeUndefined();
    expect(goal.resumeNotes).toEqual([
      {
        timestamp: "2026-05-30T12:00:00.000Z",
        source: "goal_answer",
        affectedStepIds: ["needs-input"],
        userText: "Use Postgres.",
      },
    ]);
    expect(goal.state).not.toBe("executing");
  });

  it("clears build-gate fix state for rescheduled blocked steps", () => {
    const blocked = step({
      id: "gate-blocked",
      status: "blocked",
      blockedReason: "task_failed",
      blockedQuestion: "Build gate failed.",
    });
    const goal = session([blocked], {
      buildGateFixCounts: {
        "gate-blocked": 2,
        untouched: 1,
      },
      buildGateFixSignatures: {
        "gate-blocked": "not-ok-3",
        untouched: "not-ok-9",
      },
    });

    applyResumeNote(goal, {
      source: "goal_resume",
      now: "2026-05-30T12:00:00.000Z",
    });

    expect(goal.buildGateFixCounts).toEqual({ untouched: 1 });
    expect(goal.buildGateFixSignatures).toEqual({ untouched: "not-ok-9" });
  });

  it("records user details as a per-step answer when clearing a legacy block with no reason", () => {
    const legacyNeedsInput = step({
      id: "legacy-needs-input",
      status: "blocked",
      blockedQuestion: "Need detail.",
    });
    const goal = session([legacyNeedsInput], {
      blocked: {
        blockedAt: "execution",
        prompt: "Need detail.",
        requiredInputKey: "task:legacy-needs-input:input",
        stepId: "legacy-needs-input",
      },
    });

    applyResumeNote(goal, {
      source: "add_details",
      userText: "Legacy answer.",
      now: "2026-05-30T12:00:00.000Z",
    });

    expect(goal.answers["task:legacy-needs-input:input"]).toBe("Legacy answer.");
    expect(goal.state).not.toBe("executing");
  });

  it("does not record a per-step answer when clearing a non-user-input block", () => {
    const blocked = step({
      id: "retry-after-error",
      status: "blocked",
      blockedReason: "usage_limit",
      blockedQuestion: "Usage exhausted.",
    });
    const goal = session([blocked], {
      blocked: {
        blockedAt: "execution",
        prompt: "Usage exhausted.",
        requiredInputKey: "task:retry-after-error:input",
        stepId: "retry-after-error",
      },
    });

    const result = applyResumeNote(goal, {
      source: "add_details",
      userText: "Retry now.",
      now: "2026-05-30T12:00:00.000Z",
    });

    expect(result).toMatchObject({
      rescheduledStepIds: ["retry-after-error"],
      noteAdded: true,
      goalState: "blocked",
    });
    expect(goal.answers["task:retry-after-error:input"]).toBeUndefined();
    expect(goal.resumeNotes).toEqual([
      {
        timestamp: "2026-05-30T12:00:00.000Z",
        source: "add_details",
        affectedStepIds: ["retry-after-error"],
        userText: "Retry now.",
      },
    ]);
    expect(goal.blocked).toBeNull();
    expect(blocked.status).toBe("pending");
    expect(goal.state).not.toBe("executing");
  });

  it("does not record a per-step answer when user details are blank", () => {
    const needsInput = step({
      id: "blank-answer",
      status: "blocked",
      blockedReason: "user_input",
      blockedQuestion: "Need detail.",
    });
    const goal = session([needsInput]);

    applyResumeNote(goal, {
      source: "goal_answer",
      userText: "   ",
      now: "2026-05-30T12:00:00.000Z",
    });

    expect(goal.answers["task:blank-answer:input"]).toBeUndefined();
  });

  it("renders resume-without-text copy separately from detail notes", () => {
    const note = {
      timestamp: "2026-05-30T12:00:00.000Z",
      source: "resume" as const,
      affectedStepIds: ["task-a", "task-b"],
    };

    expect(renderResumeNoteBody(note)).toBe(
      "Message at 2026-05-30T12:00:00.000Z to resume step(s):\n" +
        "task-a\n" +
        "task-b\n" +
        "User pressed Resume. Treat this as permission/context to retry the listed steps.",
    );
  });

  it("records a run-level resume_execution marker with no step-level blocked steps", () => {
    const goal = session(
      [
        step({ id: "step-a", status: "pending" }),
        step({ id: "step-b", status: "pending", dependsOn: ["step-a"] }),
      ],
      {
        state: "blocked",
        blocked: {
          blockedAt: "execution",
          prompt:
            "Run was interrupted (gateway restart or process exit). Use goal resume to continue.",
          requiredInputKey: "resume_execution",
        },
        resumeNotes: [],
      },
    );

    const result = applyResumeNote(goal, {
      source: "add_details",
      userText: "Carry on.",
      now: "2026-05-30T12:00:00.000Z",
    });

    expect(result.rescheduledStepIds).toEqual([]);
    expect(result.noteAdded).toBe(true);
    expect(result.goalState).toBe("blocked");
    expect(goal.state).toBe("blocked");
    expect(goal.blocked).toBeNull();
    expect(goal.answers["task:step-a:input"]).toBeUndefined();
    expect(goal.answers["task:step-b:input"]).toBeUndefined();
    expect(goal.resumeNotes).toEqual([
      {
        timestamp: "2026-05-30T12:00:00.000Z",
        source: "add_details",
        affectedStepIds: [],
        userText: "Carry on.",
      },
    ]);
    // Pending steps are left runnable for the scheduler; nothing is force-blocked.
    expect(goal.plan?.steps.map((s) => s.status)).toEqual(["pending", "pending"]);
    expect(result.noteBody).toContain("to resume the interrupted run");
    expect(result.noteBody).toContain("User details:\nCarry on.");
  });

  it("clears final build-gate fix state for a run-level resume_execution marker", () => {
    const goal = session([step({ id: "step-a", status: "pending" })], {
      state: "blocked",
      blocked: {
        blockedAt: "execution",
        prompt: "Run was interrupted.",
        requiredInputKey: "resume_execution",
      },
      buildGateFixCounts: {
        __final__: 2,
        "step-a": 1,
      },
      buildGateFixSignatures: {
        __final__: "final-gate",
        "step-a": "step-gate",
      },
    });

    applyResumeNote(goal, {
      source: "goal_resume",
      now: "2026-05-30T12:00:00.000Z",
    });

    expect(goal.buildGateFixCounts).toEqual({ "step-a": 1 });
    expect(goal.buildGateFixSignatures).toEqual({ "step-a": "step-gate" });
  });

  it("preserves a follow-up reply after the first note cleared blocked steps", () => {
    const goal = session(
      [
        step({ id: "step-a", status: "pending" }),
        step({ id: "step-b", status: "pending", dependsOn: ["step-a"] }),
      ],
      {
        state: "blocked",
        blocked: null,
        resumeNotes: [
          {
            timestamp: "2026-05-30T12:00:00.000Z",
            source: "goal_answer",
            affectedStepIds: ["step-a"],
            userText: "First answer.",
          },
        ],
      },
    );

    const result = applyResumeNote(goal, {
      source: "add_details",
      userText: "Second answer with extra detail.",
      now: "2026-05-30T12:01:00.000Z",
    });

    expect(result).toMatchObject({
      rescheduledStepIds: [],
      noteAdded: true,
      goalState: "blocked",
    });
    expect(goal.state).toBe("blocked");
    expect(goal.resumeNotes).toHaveLength(2);
    expect(goal.resumeNotes?.[1]).toMatchObject({
      timestamp: "2026-05-30T12:01:00.000Z",
      source: "add_details",
      affectedStepIds: [],
      userText: "Second answer with extra detail.",
    });
    expect(result.noteBody).toContain("User details:\nSecond answer with extra detail.");
  });

  it("renders a run-level resume note without text for the Resume button", () => {
    const note = {
      timestamp: "2026-05-30T12:00:00.000Z",
      source: "resume" as const,
      affectedStepIds: [],
    };

    expect(renderResumeNoteBody(note)).toBe(
      "Message at 2026-05-30T12:00:00.000Z to resume the interrupted run. " +
        "User pressed Resume. Treat this as permission/context to continue execution.",
    );
  });

  it("is a no-op for a run-level block that is not resume_execution with no blocked steps", () => {
    const goal = session([step({ id: "pending-a", status: "pending" })], {
      state: "blocked",
      blocked: {
        blockedAt: "execution",
        prompt: "Which database?",
        requiredInputKey: "step:1:input",
      },
      resumeNotes: [],
    });

    const result = applyResumeNote(goal, {
      source: "goal_resume",
      now: "2026-05-30T12:00:00.000Z",
    });

    expect(result).toEqual({
      rescheduledStepIds: [],
      noteAdded: false,
      goalState: "blocked",
    });
    expect(goal.state).toBe("blocked");
    expect(goal.blocked).not.toBeNull();
    expect(goal.resumeNotes).toEqual([]);
  });

  it("is a no-op when no blocked steps are eligible", () => {
    const goal = session(
      [
        step({ id: "done-a", status: "done" }),
        step({ id: "exec-b", status: "in_progress" }),
        step({ id: "pending-c", status: "pending" }),
      ],
      { state: "executing", blocked: null, resumeNotes: [] },
    );

    const result = applyResumeNote(goal, {
      source: "goal_resume",
      now: "2026-05-30T12:00:00.000Z",
    });

    expect(result).toEqual({
      rescheduledStepIds: [],
      noteAdded: false,
      goalState: "executing",
    });
    expect(goal.resumeNotes).toEqual([]);
    expect(goal.plan?.steps.map((s) => s.status)).toEqual(["done", "in_progress", "pending"]);
  });
});
