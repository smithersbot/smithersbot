import { JsonExitError } from "../cli/cli-utils.js";
import type { GoalStatusChangeEvent } from "../goal/agent-executor.js";
import { loadRun, resolveRunId, saveRun } from "../goal/run-store.js";
import type { GoalOutcome, OutputFormat } from "../goal/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { goalResumeCommand } from "./goal-resume.js";

export type GoalAnswerOptions = {
  key: string;
  value: string;
  json?: boolean;
  output?: OutputFormat;
  quiet?: boolean;
  onStatusChange?: (event: GoalStatusChangeEvent) => void | Promise<void>;
};

/** Resolve whether JSON mode is active: --output wins over --json. */
function resolveIsJson(opts: GoalAnswerOptions): boolean {
  if (opts.output) return opts.output === "json";
  return Boolean(opts.json);
}

const PLAINTEXT_WARNING =
  "Answers are stored in plain text. Do not store secrets without additional protection.";

function parseTasksKey(key: string): string[] | null {
  if (!key.startsWith("tasks:") || !key.endsWith(":input")) return null;
  const raw = key.slice("tasks:".length, -":input".length);
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length > 0 ? ids : null;
}

export async function goalAnswerCommand(
  runId: string,
  opts: GoalAnswerOptions,
  runtime: RuntimeEnv,
): Promise<GoalOutcome | undefined> {
  const isJson = resolveIsJson(opts);

  const resolvedId = resolveRunId(runId);
  if (!resolvedId) {
    if (isJson) {
      runtime.log(JSON.stringify({ error: `Run not found: ${runId}` }));
      throw new JsonExitError(1);
    }
    runtime.error(`Run not found: ${runId}`);
    return;
  }

  const run = loadRun(resolvedId);
  if (!run) {
    if (isJson) {
      runtime.log(JSON.stringify({ error: `Run file missing: ${resolvedId}` }));
      throw new JsonExitError(1);
    }
    runtime.error(`Run file missing: ${resolvedId}`);
    return;
  }

  if (run.state !== "blocked") {
    const msg = `Run is not awaiting input (state: ${run.state}).`;
    if (isJson) {
      runtime.log(JSON.stringify({ error: msg }));
      throw new JsonExitError(1);
    }
    runtime.error(msg);
    return;
  }

  if (!run.blocked) {
    const msg = "Run is blocked but has no blocked details.";
    if (isJson) {
      runtime.log(JSON.stringify({ error: msg }));
      throw new JsonExitError(1);
    }
    runtime.error(msg);
    return;
  }

  if (opts.key !== run.blocked.requiredInputKey) {
    const msg = `Key mismatch: expected "${run.blocked.requiredInputKey}", got "${opts.key}".`;
    if (isJson) {
      runtime.log(JSON.stringify({ error: msg }));
      throw new JsonExitError(1);
    }
    runtime.error(msg);
    return;
  }

  // Persist the answer and transition state
  const blockedAt = run.blocked.blockedAt ?? "execution";
  const taskIds = parseTasksKey(opts.key);
  if (taskIds) {
    for (const id of taskIds) {
      run.answers[`task:${id}:input`] = opts.value;
    }
  } else {
    run.answers[opts.key] = opts.value;
  }
  if (blockedAt === "execution") {
    run.blocked = null;
    run.state = "executing";
  }
  run.updatedAt = new Date().toISOString();
  saveRun(run);

  if (!isJson) {
    runtime.log(`Answer saved for key "${opts.key}".`);
    runtime.log(`Warning: ${PLAINTEXT_WARNING}`);
  }

  // Auto-resume execution for blocked (execution-time) runs
  if (blockedAt === "execution") {
    if (!isJson) runtime.log("");
    const outcome = await goalResumeCommand(
      resolvedId,
      {
        yes: true,
        json: isJson,
        output: opts.output,
        quiet: opts.quiet,
        onStatusChange: opts.onStatusChange,
      },
      runtime,
    );
    return outcome;
  }

  // planning block: confirm the answer was saved (planning resumes separately)
  if (isJson) {
    runtime.log(
      JSON.stringify({ status: "answered", key: opts.key, warning: PLAINTEXT_WARNING }, null, 2),
    );
  }
  return undefined;
}
