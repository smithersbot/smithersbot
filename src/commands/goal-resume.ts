import { confirm, isCancel } from "@clack/prompts";
import { mkdirSync } from "node:fs";
import path from "node:path";
import fs from "node:fs";

import { JsonExitError } from "../cli/cli-utils.js";
import { createCliProgress } from "../cli/progress.js";
import { resolveEnvApiKey } from "../agents/model-auth.js";
import { executeGoalWithAgent, type GoalStatusChangeEvent } from "../goal/agent-executor.js";
import { aggregateBlockedDetails } from "../goal/blocked.js";
import { formatPlanOutput } from "../goal/format-output.js";
import {
  loadRun,
  saveRun,
  serializedToSession,
  sessionToSerialized,
  resolveRunId,
  resolveRunDir,
} from "../goal/run-store.js";
import { createGoalLlmClient } from "../goal/llm-client.js";
import { generatePlan, PlanParseError, persistRawPlanResponse } from "../goal/planner.js";
import { type ScoutResult } from "../goal/scout.js";
import type { GoalOutcome, OutputFormat, SerializedRun } from "../goal/types.js";
import type { RuntimeEnv } from "../runtime.js";

export type GoalResumeOptions = {
  yes?: boolean;
  json?: boolean;
  output?: OutputFormat;
  quiet?: boolean;
  replan?: boolean;
  onStatusChange?: (event: GoalStatusChangeEvent) => void | Promise<void>;
};

/** Resolve whether JSON mode is active: --output wins over --json. */
function resolveIsJson(opts: GoalResumeOptions): boolean {
  if (opts.output) return opts.output === "json";
  return Boolean(opts.json);
}

/** Load scout data from a previous run if it exists and was successful. */
function loadScoutData(runId: string): ScoutResult | undefined {
  try {
    const runDir = resolveRunDir(runId);
    const scoutReportPath = path.join(runDir, "scout", "report.json");
    const scoutPlanPath = path.join(runDir, "scout", "plan.md");

    if (!fs.existsSync(scoutReportPath) || !fs.existsSync(scoutPlanPath)) {
      return undefined;
    }

    const report = JSON.parse(fs.readFileSync(scoutReportPath, "utf8"));
    const planDraft = fs.readFileSync(scoutPlanPath, "utf8");

    return {
      status: "success",
      report,
      planDraft,
    };
  } catch {
    return undefined;
  }
}

/**
 * Retry planning phase for a run that failed during planning.
 * Reuses the original goal text and scout data (if available).
 */
async function retryPlanning(
  run: SerializedRun,
  opts: GoalResumeOptions,
  runtime: RuntimeEnv,
): Promise<GoalOutcome | undefined> {
  const isJson = resolveIsJson(opts);
  const quiet = Boolean(opts.quiet);

  // Reconstruct in-memory session
  const session = serializedToSession(run);

  // Reset state to planning
  session.state = "planning";
  session.lastError = undefined;
  run.state = "planning";
  run.updatedAt = new Date().toISOString();
  saveRun(run);

  try {
    // Resolve API key
    const authResult = resolveEnvApiKey("anthropic");
    if (!authResult) {
      throw new Error(
        "No Anthropic API key found. Set ANTHROPIC_API_KEY in your environment or .env file.",
      );
    }

    const client = createGoalLlmClient({
      apiKey: authResult.apiKey,
      modelOverride: run.model,
    });

    // Try to load scout data from previous run
    const scoutData = loadScoutData(run.runId);

    if (!isJson && !quiet) {
      if (scoutData) {
        runtime.log("Replanning with cached scout data...");
      } else {
        runtime.log("Replanning (no scout data available)...");
      }
    }

    // Generate plan
    let planResult;
    {
      const progress = createCliProgress({
        label: "Generating plan...",
        indeterminate: true,
        enabled: !isJson && !quiet,
      });
      try {
        planResult = await generatePlan(client, session.goal, scoutData);
      } finally {
        progress.done();
      }
    }

    // Handle blocked-at-planning (pre-plan clarification)
    if ("blocked" in planResult) {
      session.state = "needs_clarification";
      session.blocked = {
        prompt: planResult.question,
        requiredInputKey: "step:planning:input",
      };
      run.state = "needs_clarification";
      run.blocked = session.blocked;
      run.updatedAt = new Date().toISOString();
      saveRun(run);

      const outcome: GoalOutcome = {
        status: "needs_clarification",
        question: planResult.question,
        requiredInputKey: "step:planning:input",
      };
      if (isJson) {
        runtime.log(JSON.stringify(outcome, null, 2));
      } else if (!quiet) {
        runtime.log(`\nCLARIFICATION NEEDED: ${planResult.question}`);
      }
      return outcome;
    }

    // Success! Update session with plan
    session.plan = planResult;
    session.state = "awaiting_approval";
    run.plan = planResult;
    run.state = "awaiting_approval";
    run.lastError = undefined;
    run.updatedAt = new Date().toISOString();
    saveRun(run);

    // Display plan
    if (!isJson && !quiet) {
      runtime.log("\n");
      runtime.log(formatPlanOutput(planResult, { diagram: "both", format: "md" }));
      runtime.log("");
      runtime.log(
        `Plan generated successfully. Use 'moltbot goal resume ${run.runId}' to approve and execute.`,
      );
    }

    if (isJson) {
      runtime.log(
        JSON.stringify(
          {
            status: "awaiting_approval",
            runId: run.runId,
            stepCount: planResult.steps.length,
          },
          null,
          2,
        ),
      );
    }

    return undefined; // Don't proceed to execution, let user approve with another resume call
  } catch (err) {
    // Planning failed again - persist error
    const errorMsg = err instanceof Error ? err.message : String(err);
    session.lastError = errorMsg;
    session.state = "failed";
    run.lastError = errorMsg;
    run.state = "failed";
    run.updatedAt = new Date().toISOString();
    saveRun(run);

    // Persist raw LLM response for post-mortem when JSON parsing fails
    if (err instanceof PlanParseError) {
      persistRawPlanResponse(run.runId, err.rawResponse);
    }

    if (isJson) {
      runtime.log(JSON.stringify({ error: errorMsg, runId: run.runId }));
      throw new JsonExitError(1);
    }
    runtime.error(`Planning failed: ${errorMsg}`);
    return undefined;
  }
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
      // Failed with no plan means planning failed - can be retried with --replan
      if (!opts.replan) {
        if (isJson) {
          runtime.log(
            JSON.stringify({
              error:
                "Run failed during planning. Use --replan to retry planning from the original goal.",
              lastError: run.lastError ?? null,
            }),
          );
          throw new JsonExitError(1);
        }
        runtime.error(
          `Run failed during planning: ${run.lastError ?? "Unknown error"}. Use --replan to retry.`,
        );
        return undefined;
      }

      // --replan flag: retry the planning phase
      return await retryPlanning(run, opts, runtime);
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

  // Stale/incomplete states - but can be recovered with --replan
  if (run.state === "init" || run.state === "planning") {
    if (!opts.replan) {
      if (isJson) {
        runtime.log(
          JSON.stringify({
            error:
              "Run is in an incomplete state. Use --replan to retry planning from the original goal.",
          }),
        );
        throw new JsonExitError(1);
      }
      runtime.error(
        "Run is in an incomplete state. Use --replan to retry planning from the original goal.",
      );
      return undefined;
    }

    // --replan flag: retry the planning phase
    return await retryPlanning(run, opts, runtime);
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

  const disableCheckpoints = process.env.MOLTBOT_NO_GIT_CHECKPOINTS === "1";
  const outcome = await executeGoalWithAgent({
    session,
    runId: savedRunId,
    workingDir,
    model,
    maxTurnsPerTask: 5,
    timeoutMs: 300_000,
    gitCheckpointConfig: disableCheckpoints ? undefined : { enabled: true, resetOnRetry: true },
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
