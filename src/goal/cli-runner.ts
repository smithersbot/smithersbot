import fs from "node:fs";
import path from "node:path";
import type { ClaudeCodeAuthMode } from "../config/types.goal.js";
import type { GoalBackendId, GoalWorkerOutput } from "./backend-types.js";
import { executeTaskWithCliWorker } from "./cli-worker.js";
import { formatAttemptBundleSummary } from "./attempt-bundle.js";
import { getLessonsForContext } from "./lessons.js";
import type { TaskRunner, TaskRunnerContext, TaskRunnerResult } from "./task-runner.js";
import type { FailedDetail, PlanStep } from "./types.js";

export class CliTaskRunner implements TaskRunner {
  private backend: GoalBackendId;
  private model?: string;
  private claudeCodeAuth?: ClaudeCodeAuthMode;

  constructor(params: {
    backend: GoalBackendId;
    model?: string;
    claudeCodeAuth?: ClaudeCodeAuthMode;
  }) {
    this.backend = params.backend;
    this.model = params.model;
    this.claudeCodeAuth = params.claudeCodeAuth;
  }

  async execute(context: TaskRunnerContext): Promise<TaskRunnerResult> {
    const attemptBundles = context.attemptBundles ?? [];
    const attemptNumber = attemptBundles.length + 1;
    const previousAttempt =
      attemptBundles.length > 0
        ? formatAttemptBundleSummary(attemptBundles[attemptBundles.length - 1]!)
        : null;
    const lessons = getLessonsForContext(context.workingDir).map((lesson) => ({
      pattern: lesson.pattern,
      lesson: lesson.lesson,
    }));
    const projectConventions =
      this.backend === "codex" ? readProjectConventions(context.workingDir) : undefined;

    const cliResult = await executeTaskWithCliWorker({
      backend: this.backend,
      step: context.task,
      plan: context.plan,
      goal: context.goal,
      workingDir: context.workingDir,
      runId: context.runId,
      hardDenies: context.denyPolicy,
      timeoutMs: context.timeoutMs,
      abortSignal: context.abortSignal,
      model: this.model,
      completedSummaries: context.completedSummaries,
      lessons,
      onProgress: context.onProgress,
      resumeAnswer: context.resumeAnswer,
      resumeQuestion: context.resumeQuestion,
      attemptNumber,
      previousAttempt,
      claudeCodeAuth: this.claudeCodeAuth,
      projectConventions,
    });

    const output = cliResult.output;
    if (!output) {
      return {
        status: "blocked",
        question: "CLI worker did not produce a valid result artifact.",
        blockedReason: "error",
        turnsUsed: cliResult.turnsUsed,
      };
    }

    return mapWorkerOutput(output, cliResult.turnsUsed);
  }
}

function readProjectConventions(workingDir: string): string | undefined {
  try {
    const conventionsPath = path.join(workingDir, "CLAUDE.md");
    const conventions = fs.readFileSync(conventionsPath, "utf8").trim();
    return conventions.length > 0 ? conventions : undefined;
  } catch {
    return undefined;
  }
}

function mapWorkerOutput(output: GoalWorkerOutput, turnsUsed: number): TaskRunnerResult {
  if (output.status === "complete") {
    return { status: "complete", summary: output.summary, turnsUsed };
  }

  if (output.status === "blocked") {
    return {
      status: "blocked",
      question: output.question,
      blockedReason: "user_input",
      turnsUsed,
    };
  }

  if (output.status === "ralph") {
    return {
      status: "ralph",
      ralphDetail: {
        approachTried: output.approachTried,
        specificErrors: output.specificErrors,
        keyInsight: output.keyInsight,
        suggestedApproach: output.suggestedApproach,
      },
      turnsUsed,
    };
  }

  const blockedReason = mapWorkerErrorTypeToBlockedReason(output.errorType);
  if (blockedReason === "task_failed") {
    return {
      status: "failed",
      question: output.reason,
      failedDetail: toFailedDetail(output),
      turnsUsed,
    };
  }

  return {
    status: "blocked",
    question: output.reason,
    blockedReason,
    turnsUsed,
  };
}

function toFailedDetail(output: Extract<GoalWorkerOutput, { status: "failed" }>): FailedDetail {
  return {
    whatTried: output.whatTried,
    errorType: output.errorType,
    suggestedNext: output.suggestedNext,
    needsRevert: output.needsRevert,
  };
}

function mapWorkerErrorTypeToBlockedReason(errorType: string): PlanStep["blockedReason"] {
  const normalized = errorType.toLowerCase();
  if (normalized === "timeout") return "timeout";
  if (normalized === "rate_limit") return "rate_limit";
  if (normalized === "out_of_credits") return "out_of_credits";
  if (normalized === "auth") return "auth";
  if (normalized === "network") return "network";
  if (normalized === "missing_result") return "error";
  if (normalized === "invalid_result") return "error";
  if (normalized === "process_error") return "error";
  if (normalized === "unknown") return "error";
  return "task_failed";
}
