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

export function renderResumeNoteBody(note: ResumeNote): string {
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

export function applyResumeNote(
  session: GoalSession,
  params: ApplyResumeNoteParams,
): ApplyResumeNoteResult {
  const blockedSteps = session.plan?.steps.filter((step) => step.status === "blocked") ?? [];
  const rescheduledStepIds = blockedSteps.map((step) => step.id);
  if (rescheduledStepIds.length === 0) {
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

  for (const step of blockedSteps) {
    clearBlockedStepForResume(step);
  }

  if (session.state === "blocked") {
    session.state = "executing";
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
