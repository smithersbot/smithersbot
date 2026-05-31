import { JsonExitError } from "../cli/cli-utils.js";
import type { MoltbotConfig } from "../config/types.clawdbot.js";
import type { GoalStatusChangeEvent } from "../goal/agent-executor.js";
import type { GoalOutcome, OutputFormat } from "../goal/types.js";
import type { RuntimeEnv } from "../runtime.js";
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
