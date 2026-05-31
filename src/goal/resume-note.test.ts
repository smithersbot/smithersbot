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
  it("reschedules blocked, paused, and failed persisted blocked steps and leaves done/executing unchanged", () => {
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
      goalState: "executing",
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
    expect(goal.blocked).toBeNull();
    expect(result.noteBody).toContain("Message at 2026-05-30T12:00:00.000Z to unblock step(s):");
    expect(result.noteBody).toContain("blocked-a\npaused-b\nfailed-c");
    expect(result.noteBody).toContain("User details:\nThe service is fixed now.");
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
