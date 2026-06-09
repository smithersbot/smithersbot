import { JsonExitError } from "../cli/cli-utils.js";
import type { MoltbotConfig } from "../config/types.clawdbot.js";
import type { GoalStatusChangeEvent } from "../goal/agent-executor.js";
import { recordPlanningDecisionAnswer } from "../goal/planning-decision-answers.js";
import { loadRun, resolveRunId, saveRun } from "../goal/run-store.js";
import type { GoalOutcome, OutputFormat } from "../goal/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { goalResumeCommand } from "./goal-resume.js";
import { applyGoalResumeNoteById } from "./goal-resume-note.js";

export type GoalAnswerOptions = {
  key: string;
  value: string;
  json?: boolean;
  output?: OutputFormat;
  quiet?: boolean;
  config?: MoltbotConfig;
  onStatusChange?: (event: GoalStatusChangeEvent) => void | Promise<void>;
};

/** Resolve whether JSON mode is active: --output wins over --json. */
function resolveIsJson(opts: GoalAnswerOptions): boolean {
  if (opts.output) return opts.output === "json";
  return Boolean(opts.json);
}

const PLAINTEXT_WARNING =
  "Answers are stored in plain text. Do not store secrets without additional protection.";

export async function goalAnswerCommand(
  runId: string,
  opts: GoalAnswerOptions,
  runtime: RuntimeEnv,
): Promise<GoalOutcome | undefined> {
  const isJson = resolveIsJson(opts);
  const resolvedId = resolveRunId(runId);
  const run = resolvedId ? loadRun(resolvedId) : undefined;

  if (
    run &&
    resolvedId &&
    recordPlanningDecisionAnswer({
      run,
      inputKey: opts.key,
      value: opts.value,
      now: new Date().toISOString(),
    })
  ) {
    saveRun(run);
    // The recorded answer passes the planning Needs Decision gate. Auto-resume
    // planning instead of asking the user to run /goal_resume — goalResumeCommand
    // routes a blocked planning run that has a recorded answer to retryPlanning.
    // On a real backend/env failure retryPlanning surfaces its own clear blocker
    // and leaves the run in "planning" (with lastError), never silently stuck.
    return await goalResumeCommand(
      resolvedId,
      {
        ...(opts.json !== undefined ? { json: opts.json } : {}),
        ...(opts.output !== undefined ? { output: opts.output } : {}),
        ...(opts.quiet !== undefined ? { quiet: opts.quiet } : {}),
        ...(opts.config !== undefined ? { config: opts.config } : {}),
        ...(opts.onStatusChange !== undefined ? { onStatusChange: opts.onStatusChange } : {}),
      },
      runtime,
    );
  }

  const result = applyGoalResumeNoteById({
    runId,
    source: "goal_answer",
    userText: opts.value,
  });

  if (result.status === "not_found" || result.status === "missing") {
    if (isJson) {
      runtime.log(JSON.stringify({ error: result.message }));
      throw new JsonExitError(1);
    }
    runtime.error(result.message);
    return;
  }

  if (result.status === "noop") {
    if (isJson) {
      runtime.log(
        JSON.stringify({
          status: "noop",
          message: result.message,
          state: result.run.state,
        }),
      );
    } else if (!opts.quiet) {
      runtime.log(result.message);
    }
    return undefined;
  }

  if (isJson) {
    runtime.log(
      JSON.stringify(
        {
          status: "resumed",
          message: result.message,
          rescheduledStepIds: result.rescheduledStepIds,
          warning: PLAINTEXT_WARNING,
        },
        null,
        2,
      ),
    );
  } else if (!opts.quiet) {
    runtime.log(result.message);
    runtime.log(`Warning: ${PLAINTEXT_WARNING}`);
  }

  return undefined;
}
