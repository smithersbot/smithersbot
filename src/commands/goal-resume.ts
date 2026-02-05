import { confirm, isCancel } from "@clack/prompts";
import { mkdirSync } from "node:fs";

import { JsonExitError } from "../cli/cli-utils.js";
import { executeGoalWithAgent, type GoalStatusChangeEvent } from "../goal/agent-executor.js";
import { aggregateBlockedDetails } from "../goal/blocked.js";
import { formatPlanOutput } from "../goal/format-output.js";
import {
  loadRun,
  saveRun,
  serializedToSession,
  sessionToSerialized,
  resolveRunId,
} from "../goal/run-store.js";
import type { GoalOutcome, OutputFormat } from "../goal/types.js";
import type { RuntimeEnv } from "../runtime.js";

export type GoalResumeOptions = {
  yes?: boolean;
  json?: boolean;
  output?: OutputFormat;
  quiet?: boolean;
  onStatusChange?: (event: GoalStatusChangeEvent) => void | Promise<void>;
};

/** Resolve whether JSON mode is active: --output wins over --json. */
function resolveIsJson(opts: GoalResumeOptions): boolean {
  if (opts.output) return opts.output === "json";
  return Boolean(opts.json);
}

export async function goalResumeCommand(
  runId: string,
  opts: GoalResumeOptions,
  runtime: RuntimeEnv,
): Promise<GoalOutcome | undefined> {
  const isJson = resolveIsJson(opts);
  const quiet = Boolean(opts.quiet);

  const resolvedId = resolveRunId(runId);
  if (!resolvedId) {
    if (isJson) {
      runtime.log(JSON.stringify({ error: `Run not found: ${runId}` }));
      throw new JsonExitError(1);
    }
    runtime.error(`Run not found: ${runId}`);
    return undefined;
  }

  const run = loadRun(resolvedId);
  if (!run) {
    if (isJson) {
      runtime.log(JSON.stringify({ error: `Run file missing: ${resolvedId}` }));
      throw new JsonExitError(1);
    }
    runtime.error(`Run file missing: ${resolvedId}`);
    return undefined;
  }

  // Terminal: done is not resumable
  if (run.state === "done") {
    if (isJson) {
      runtime.log(JSON.stringify({ error: "Run already completed." }));
      throw new JsonExitError(1);
    }
    runtime.error("Run already completed.");
    return undefined;
  }

  // Failed can be recoverable if we can synthesize blocked details from the plan.
  if (run.state === "failed") {
    const synthesized = run.blocked ?? (run.plan ? aggregateBlockedDetails(run.plan.steps) : null);
    if (synthesized) {
      run.blocked = synthesized;
      run.state = "blocked";
      run.updatedAt = new Date().toISOString();
      saveRun(run);
    } else {
      if (isJson) {
        runtime.log(JSON.stringify({ error: "Run failed.", lastError: run.lastError ?? null }));
        throw new JsonExitError(1);
      }
      runtime.error(`Run failed: ${run.lastError ?? "Unknown error"}`);
      return undefined;
    }
  }

  // Blocked (execution-time) or needs_clarification (pre-plan): print details and exit
  if (run.state === "blocked" || run.state === "needs_clarification") {
    if (isJson) {
      runtime.log(
        JSON.stringify({
          status: run.state === "needs_clarification" ? "needs_clarification" : "blocked",
          question: run.blocked?.prompt ?? null,
          requiredInputKey: run.blocked?.requiredInputKey ?? null,
        }),
      );
    } else {
      const label = run.state === "needs_clarification" ? "Needs clarification" : "Blocked";
      runtime.log(`${label}: ${run.blocked?.prompt ?? "Unknown reason"}`);
      runtime.log(`Required input: ${run.blocked?.requiredInputKey ?? "unknown"}`);
      runtime.log(
        `Answer:  moltbot goal answer ${run.runId.slice(0, 8)} --key ${run.blocked?.requiredInputKey ?? "KEY"} --value <VALUE>`,
      );
    }
    return {
      status: run.state === "needs_clarification" ? "needs_clarification" : "blocked",
      question: run.blocked?.prompt ?? "",
      requiredInputKey: run.blocked?.requiredInputKey ?? "unknown",
    } as GoalOutcome;
  }

  // Stale/incomplete states
  if (run.state === "init" || run.state === "planning") {
    if (isJson) {
      runtime.log(JSON.stringify({ error: "Run is in an incomplete state." }));
      throw new JsonExitError(1);
    }
    runtime.error("Run is in an incomplete state.");
    return undefined;
  }

  // Resumable: awaiting_approval, rejected, cancelled, executing
  // (rejected and cancelled both return to the approval flow)

  // Capture run fields for closure (TypeScript can't narrow across closures)
  const { runId: savedRunId, workingDir, model, dryRun, createdAt } = run;

  // Ensure workspace directory exists
  mkdirSync(workingDir, { recursive: true });

  // Reconstruct in-memory session
  const session = serializedToSession(run);

  // Helper to persist
  function persistRun(): void {
    const previousRun = loadRun(savedRunId);
    saveRun(
      sessionToSerialized({
        session,
        runId: savedRunId,
        workingDir,
        model,
        dryRun,
        createdAt,
        previousRun,
      }),
    );
  }

  // --- Approval flow: awaiting_approval, rejected, cancelled ---
  const needsApproval =
    run.state === "awaiting_approval" || run.state === "rejected" || run.state === "cancelled";

  if (needsApproval) {
    if (session.plan) {
      if (!isJson && !quiet) {
        runtime.log(formatPlanOutput(session.plan, { diagram: "both", format: "md" }));
        runtime.log("");
      }
    }

    if (!opts.yes) {
      if (isJson) {
        runtime.log(
          JSON.stringify({ error: "--yes is required in JSON mode to approve the plan." }),
        );
        throw new JsonExitError(1);
      }
      let approved: boolean | symbol;
      try {
        approved = await confirm({
          message: `Execute this ${session.plan?.steps.length ?? 0}-step plan?`,
        });
      } catch {
        session.state = "cancelled";
        persistRun();
        runtime.log("Cancelled.");
        return { status: "rejected" };
      }
      if (isCancel(approved)) {
        session.state = "cancelled";
        persistRun();
        runtime.log("Cancelled.");
        return { status: "rejected" };
      }
      if (!approved) {
        session.state = "rejected";
        persistRun();
        runtime.log("Plan rejected.");
        return { status: "rejected" };
      }
    }
  }

  // --- Executing (interrupted): restore step statuses ---
  if (session.plan) {
    for (const step of session.plan.steps) {
      const result = session.stepResults.get(step.id);
      if (result) {
        step.status = result.success ? "done" : "blocked";
        if (!result.success) {
          step.blockedReason = "error";
          step.blockedQuestion = result.error ?? "Step failed in a previous run.";
        }
      }
    }
  }

  const resumableSteps =
    session.plan?.steps.filter((s) => s.status === "pending" || s.status === "blocked") ?? [];
  if (resumableSteps.length === 0) {
    session.state = "done";
    persistRun();
    const outcome: GoalOutcome = {
      status: "done",
      summary: "All steps already completed.",
    };
    if (isJson) {
      runtime.log(JSON.stringify(outcome, null, 2));
    } else if (!quiet) {
      runtime.log("All steps already completed.");
    }
    return outcome;
  }

  if (!isJson && !quiet) {
    runtime.log(`Resuming: ${resumableSteps.length} remaining step(s).`);
    runtime.log("");
  }

  const outcome = await executeGoalWithAgent({
    session,
    runId: savedRunId,
    workingDir,
    model,
    maxTurnsPerTask: 5,
    timeoutMs: 300_000,
    onTaskUpdate: () => persistRun(),
    onProgress: (text) => {
      if (!isJson && !quiet) runtime.log(text);
    },
    onStatusChange: opts.onStatusChange,
  });

  persistRun();

  if (!isJson && !quiet) runtime.log("");
  if (isJson) {
    runtime.log(JSON.stringify(outcome, null, 2));
  } else if (!quiet) {
    if (outcome.status === "done") {
      runtime.log(`DONE: ${outcome.summary}`);
    } else if (outcome.status === "blocked") {
      runtime.log(`BLOCKED: ${outcome.question}`);
    } else if (outcome.status === "failed") {
      runtime.log(`FAILED: ${outcome.error}`);
    }
  }

  return outcome;
}
