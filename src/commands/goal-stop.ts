import { JsonExitError } from "../cli/cli-utils.js";
import { forceReleaseGoalOpLock } from "../goal/goal-lock.js";
import { loadRun, saveRun, resolveRunId } from "../goal/run-store.js";
import type { RuntimeEnv } from "../runtime.js";

export type GoalStopOptions = {
  json?: boolean;
  force?: boolean;
};

/**
 * Stop a running goal execution.
 *
 * Transitions the goal state to 'cancelled' and marks any in-progress steps
 * as blocked so they can be resumed later if needed.
 *
 * Works on goals in 'executing' and 'planning' states. For goals in other states:
 * - awaiting_approval: use goal_reject instead
 * - done/cancelled: already terminal
 */
export async function goalStopCommand(
  runId: string,
  opts: GoalStopOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const isJson = Boolean(opts.json);
  const force = Boolean(opts.force);

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

  // Check state validity for stopping
  if (run.state === "cancelled") {
    if (isJson) {
      runtime.log(JSON.stringify({ status: "already_cancelled", runId: resolvedId }));
      return;
    }
    runtime.log(`Goal ${resolvedId.slice(0, 8)} is already cancelled.`);
    return;
  }

  if (run.state === "done") {
    if (isJson) {
      runtime.log(
        JSON.stringify({ error: "Cannot stop: goal already completed.", runId: resolvedId }),
      );
      throw new JsonExitError(1);
    }
    runtime.error("Cannot stop: goal already completed.");
    return;
  }

  // For states other than executing/planning, provide guidance.
  if (run.state !== "executing" && run.state !== "planning" && !force) {
    const stateGuidance: Record<string, string> = {
      planning: "Goal is still planning. It will complete or block soon.",
      awaiting_approval:
        "Goal is waiting for approval. Use /goal_reject to decline or /goal_approve to continue.",
      blocked: "Goal is blocked waiting for input. Use /goal_answer to continue or /goal_reject.",
      done: "Goal is already completed.",
      cancelled: "Goal is already cancelled.",
    };

    const guidance = stateGuidance[run.state] ?? "Unknown state.";

    if (isJson) {
      runtime.log(
        JSON.stringify({
          error: `Cannot stop: goal is in "${run.state}" state.`,
          guidance,
          runId: resolvedId,
        }),
      );
      throw new JsonExitError(1);
    }
    runtime.error(`Cannot stop: goal is in "${run.state}" state.`);
    runtime.log(guidance);
    runtime.log("Use --force to cancel anyway.");
    return;
  }

  // Perform the cancellation
  const previousState = run.state;
  run.state = "cancelled";
  run.updatedAt = new Date().toISOString();

  // Mark any in-progress steps as blocked so they can be resumed
  if (run.plan) {
    for (const step of run.plan.steps) {
      if (step.status === "in_progress") {
        step.status = "blocked";
        step.blockedReason = "other";
        step.blockedQuestion = "Task was interrupted when goal was stopped by user.";
      }
    }
  }

  // Clear any active blocked state since we're transitioning to cancelled
  run.blocked = null;

  saveRun(run);
  forceReleaseGoalOpLock(resolvedId);

  if (isJson) {
    runtime.log(
      JSON.stringify({
        status: "stopped",
        runId: resolvedId,
        previousState,
        stepsCompleted: run.plan?.steps.filter((s) => s.status === "done").length ?? 0,
        stepsTotal: run.plan?.steps.length ?? 0,
      }),
    );
    return;
  }

  const prefix = resolvedId.slice(0, 8);
  runtime.log(`Goal ${prefix} stopped.`);

  if (run.plan) {
    const completed = run.plan.steps.filter((s) => s.status === "done").length;
    const total = run.plan.steps.length;
    runtime.log(`Progress: ${completed}/${total} tasks completed.`);
  }

  runtime.log(`**Goal ID:** ${prefix}`);
}
