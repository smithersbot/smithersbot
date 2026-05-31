import { applyResumeNote } from "../goal/resume-note.js";
import { loadRun, resolveRunId, saveRun, serializedToSession } from "../goal/run-store.js";
import type { ResumeNoteSource, SerializedRun } from "../goal/types.js";

export type GoalResumeNoteResult =
  | {
      status: "not_found";
      message: string;
    }
  | {
      status: "missing";
      message: string;
    }
  | {
      status: "noop";
      run: SerializedRun;
      message: string;
    }
  | {
      status: "applied";
      run: SerializedRun;
      rescheduledStepIds: string[];
      message: string;
    };

function formatNoEligibleMessage(state: string): string {
  return `No blocked, paused, or failed steps need input/resume right now. The goal is currently ${state}.`;
}

function formatAppliedMessage(source: ResumeNoteSource, count: number): string {
  if (source === "goal_resume" || source === "resume") {
    return `Got it. Resuming ${count} step${count === 1 ? "" : "s"}.`;
  }
  return `Got it. Added your note and rescheduled ${count} step${count === 1 ? "" : "s"}.`;
}

export function applyGoalResumeNoteById(params: {
  runId: string;
  source: ResumeNoteSource;
  userText?: string;
  now?: () => string;
}): GoalResumeNoteResult {
  const resolvedId = resolveRunId(params.runId);
  if (!resolvedId) {
    return { status: "not_found", message: `Run not found: ${params.runId}` };
  }

  const run = loadRun(resolvedId);
  if (!run) {
    return { status: "missing", message: `Run file missing: ${resolvedId}` };
  }

  if (run.state === "done") {
    return {
      status: "noop",
      run,
      message: formatNoEligibleMessage(run.state),
    };
  }

  const session = serializedToSession(run);
  const result = applyResumeNote(session, {
    source: params.source,
    now: params.now?.() ?? new Date().toISOString(),
    ...(params.userText?.trim() ? { userText: params.userText.trim() } : {}),
  });

  if (!result.noteAdded) {
    return {
      status: "noop",
      run,
      message: formatNoEligibleMessage(run.state),
    };
  }

  run.plan = session.plan;
  run.state = session.state;
  run.blocked = session.blocked;
  run.resumeNotes = session.resumeNotes ?? [];
  run.updatedAt = new Date().toISOString();
  saveRun(run);

  return {
    status: "applied",
    run,
    rescheduledStepIds: result.rescheduledStepIds,
    message: formatAppliedMessage(params.source, result.rescheduledStepIds.length),
  };
}
