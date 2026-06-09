import type { GoalSession, GoalState, PlanStep, ResumeNote, ResumeNoteSource } from "./types.js";

export type ApplyResumeNoteParams = {
  source: ResumeNoteSource;
  now: string;
  userText?: string;
};

export type ApplyResumeNoteResult = {
  rescheduledStepIds: string[];
  noteAdded: boolean;
  goalState: GoalState;
  note?: ResumeNote;
  noteBody?: string;
};

/** Run-level marker for an interrupted run that needs a plain resume. */
export const RESUME_EXECUTION_KEY = "resume_execution";

export function renderResumeNoteBody(note: ResumeNote): string {
  if (note.affectedStepIds.length === 0) {
    // Run-level resume (interrupted run, no step-level blocked steps): the note
    // is permission/context to continue execution of the whole run.
    if (!note.userText) {
      return `Message at ${note.timestamp} to resume the interrupted run. User pressed Resume. Treat this as permission/context to continue execution.`;
    }
    return `Message at ${note.timestamp} to resume the interrupted run.\nUser details:\n${note.userText}`;
  }
  const affected = note.affectedStepIds.join("\n");
  if (!note.userText) {
    return `Message at ${note.timestamp} to resume step(s):\n${affected}\nUser pressed Resume. Treat this as permission/context to retry the listed steps.`;
  }
  return `Message at ${note.timestamp} to unblock step(s):\n${affected}\nUser details:\n${note.userText}`;
}

function clearBlockedStepForResume(step: PlanStep): void {
  step.status = "pending";
  step.blockedReason = undefined;
  step.blockedQuestion = undefined;
  step.failedDetail = undefined;
  step.ralphDetail = undefined;
}

function shouldRecordResumeAnswerForStep(step: PlanStep): boolean {
  return step.blockedReason == null || step.blockedReason === "user_input";
}

export function applyResumeNote(
  session: GoalSession,
  params: ApplyResumeNoteParams,
): ApplyResumeNoteResult {
  const blockedSteps = session.plan?.steps.filter((step) => step.status === "blocked") ?? [];
  const rescheduledStepIds = blockedSteps.map((step) => step.id);

  // A run can be blocked at the run level with no step-level blocked steps:
  // an interrupted run is synthesized to `blocked` + `resume_execution` with
  // all steps reset to pending. Treat that run-level marker as resumable too.
  const isRunLevelResumeExecution =
    session.state === "blocked" && session.blocked?.requiredInputKey === RESUME_EXECUTION_KEY;
  const isResumableFollowUp =
    session.state === "blocked" &&
    (session.resumeNotes?.length ?? 0) > 0 &&
    Boolean(params.userText?.trim());

  if (rescheduledStepIds.length === 0 && !isRunLevelResumeExecution && !isResumableFollowUp) {
    return {
      rescheduledStepIds,
      noteAdded: false,
      goalState: session.state,
    };
  }

  const note: ResumeNote = {
    timestamp: params.now,
    source: params.source,
    affectedStepIds: rescheduledStepIds,
    ...(params.userText ? { userText: params.userText } : {}),
  };
  session.resumeNotes = [...(session.resumeNotes ?? []), note];

  const answerText = params.userText?.trim() ? params.userText : undefined;
  for (const step of blockedSteps) {
    if (answerText != null && shouldRecordResumeAnswerForStep(step)) {
      session.answers[`task:${step.id}:input`] = answerText;
    }
    clearBlockedStepForResume(step);
  }

  if (session.state === "blocked") {
    session.blocked = null;
  }

  return {
    rescheduledStepIds,
    noteAdded: true,
    goalState: session.state,
    note,
    noteBody: renderResumeNoteBody(note),
  };
}
