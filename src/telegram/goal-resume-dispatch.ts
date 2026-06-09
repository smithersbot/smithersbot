import { applyGoalResumeNoteById } from "../commands/goal-resume-note.js";
import type { MoltbotConfig } from "../config/config.js";
import { acquireGoalOpLock } from "../goal/goal-lock.js";
import type { ResumeNoteSource } from "../goal/types.js";
import { buildResumePreface, resolveGoalOperatorHonorific } from "./goal-formatting.js";

export type ResumeGoalFromAnswerResult =
  | { status: "launched" }
  | { status: "recorded_lock_held" }
  | { status: "not_applied"; message: string };

export function resumeGoalFromAnswer(params: {
  runId: string;
  answerText: string;
  source: ResumeNoteSource;
  config: MoltbotConfig;
  sendRecordFailure: (message: string) => Promise<void>;
  launchResume: (params: { preface: string; releaseGoalLock: () => void }) => void;
}): ResumeGoalFromAnswerResult {
  const result = applyGoalResumeNoteById({
    runId: params.runId,
    source: params.source,
    userText: params.answerText,
  });

  if (result.status !== "applied") {
    const message = result.message ?? "Could not record those details.";
    void params.sendRecordFailure(message);
    return { status: "not_applied", message };
  }

  const lock = acquireGoalOpLock(params.runId, "resume");
  if (!lock.acquired) {
    return { status: "recorded_lock_held" };
  }

  try {
    params.launchResume({
      preface: buildResumePreface(resolveGoalOperatorHonorific(params.config)),
      releaseGoalLock: lock.release,
    });
  } catch (error) {
    lock.release();
    throw error;
  }

  return { status: "launched" };
}
