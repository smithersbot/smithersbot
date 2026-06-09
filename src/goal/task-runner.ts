import type { AttemptBundle } from "./attempt-bundle.js";
import type { HardDenyList } from "./hard-deny.js";
import type {
  FailedDetail,
  Plan,
  PlanStep,
  RalphDetail,
  ResumeNote,
  WorkerContextSummary,
} from "./types.js";

export interface TaskRunnerContext {
  task: PlanStep;
  plan: Plan;
  goal: string;
  workingDir: string;
  runId: string;
  historyWorkspaceSlug?: string;
  denyPolicy: HardDenyList;
  completedSummaries: WorkerContextSummary[];
  resumeAnswer?: string;
  resumeQuestion?: string;
  resumeNotes?: ResumeNote[];
  attemptBundles?: AttemptBundle[];
  onProgress?: (text: string) => void;
  abortSignal: AbortSignal;
  timeoutMs: number;
}

export interface TaskRunnerResult {
  status: "complete" | "blocked" | "failed" | "ralph";
  summary?: string;
  question?: string;
  failedDetail?: FailedDetail;
  ralphDetail?: RalphDetail;
  turnsUsed: number;
  /** Backend-native session/thread id from the executing CLI worker, when available. */
  executionSessionId?: string;
  artifacts?: string[];
  blockedReason?: PlanStep["blockedReason"];
}

export interface TaskRunner {
  execute(context: TaskRunnerContext): Promise<TaskRunnerResult>;
}
