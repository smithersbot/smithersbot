import { confirm, isCancel } from "@clack/prompts";
import path from "node:path";
import fs from "node:fs";

import { JsonExitError } from "../cli/cli-utils.js";
import { createCliProgress } from "../cli/progress.js";
import { executeGoalWithAgent, type GoalStatusChangeEvent } from "../goal/agent-executor.js";
import { runCliPlanning, type CliPlanningResult } from "../goal/cli-planner.js";
import { ensureGlobalConventions } from "../goal/conventions.js";
import { formatPlanOutput } from "../goal/format-output.js";
import { ensureWorkingDir } from "../goal/git-checkpoint.js";
import {
  loadRun,
  saveRun,
  serializedToSession,
  sessionToSerialized,
  resolveGoalsDir,
  resolveRunId,
} from "../goal/run-store.js";
import { PlanParseError, persistRawPlanResponse } from "../goal/planner.js";
import {
  resolveScoutDir,
  SCOUT_PLAN_DRAFT_FILE,
  SCOUT_REPORT_FILE,
  type ScoutResult,
} from "../goal/scout.js";
import type { MoltbotConfig } from "../config/types.clawdbot.js";
import type { GoalOutcome, OutputFormat, SerializedRun } from "../goal/types.js";
import type { RuntimeEnv } from "../runtime.js";

export type GoalResumeOptions = {
  yes?: boolean;
  json?: boolean;
  output?: OutputFormat;
  quiet?: boolean;
  replan?: boolean;
  config?: MoltbotConfig;
  /** Allow /goal feedback flow to resume a run even if persisted state is done. */
  allowDoneStateResume?: boolean;
  onStatusChange?: (event: GoalStatusChangeEvent) => void | Promise<void>;
};

/** Resolve whether JSON mode is active: --output wins over --json. */
function resolveIsJson(opts: GoalResumeOptions): boolean {
  if (opts.output) return opts.output === "json";
  return Boolean(opts.json);
}

const AUTO_RETRY_EXECUTION_KEYS = new Set(["git", "resume_execution"]);

function formatPlannerFallbackNotice(params: {
  degradedReason: NonNullable<SerializedRun["plannerDegradedReason"]>;
  resetHint?: string;
}): string {
  const reasonLabel =
    params.degradedReason === "anthropic_usage_limit"
      ? "usage limit"
      : params.degradedReason === "anthropic_rate_limit"
        ? "rate limit"
        : "availability issue";
  const resetSuffix = params.resetHint ? ` (${params.resetHint})` : "";
  return (
    `Planner notice: Anthropic ${reasonLabel} reached${resetSuffix}. ` +
    "Falling back to Codex planning for this run."
  );
}

/**
 * For execution-time blocked runs, only user_input blocks must require
 * an explicit answer before resume. Error-class blocks should be retriable
 * via /goal_resume so backend/env fixes can take effect without fake input.
 */
function requiresExecutionAnswer(run: SerializedRun, requiredKey?: string): boolean {
  if (requiredKey && AUTO_RETRY_EXECUTION_KEYS.has(requiredKey)) {
    return false;
  }
  if (requiredKey && run.answers?.[requiredKey]) return false;

  const steps = run.plan?.steps ?? [];
  const blockedSteps = steps.filter((step) => step.status === "blocked");
  if (blockedSteps.length === 0) return true;

  return blockedSteps.some((step) => (step.blockedReason ?? "user_input") === "user_input");
}

type ScoutArtifactFiles = {
  reportFile: string;
  planDraftFile: string;
};

const CANONICAL_SCOUT_ARTIFACTS: ScoutArtifactFiles = {
  // Canonical names must match the planning writer (src/goal/scout.ts constants).
  reportFile: SCOUT_REPORT_FILE,
  planDraftFile: SCOUT_PLAN_DRAFT_FILE,
};

const LEGACY_SCOUT_ARTIFACTS: ScoutArtifactFiles = {
  // Backward-compat: older runs wrote these pre-canonical names.
  reportFile: "report.json",
  planDraftFile: "plan.md",
};

/** Load scout data from a previous run if it exists and was successful. */
function loadScoutData(runId: string): Extract<ScoutResult, { status: "success" }> | undefined {
  try {
    const scoutDir = resolveScoutDir(runId, resolveGoalsDir());
    const candidates = [CANONICAL_SCOUT_ARTIFACTS, LEGACY_SCOUT_ARTIFACTS];

    for (const candidate of candidates) {
      const scoutReportPath = path.join(scoutDir, candidate.reportFile);
      const scoutPlanPath = path.join(scoutDir, candidate.planDraftFile);

      if (!fs.existsSync(scoutReportPath) || !fs.existsSync(scoutPlanPath)) {
        continue;
      }

      const report = JSON.parse(fs.readFileSync(scoutReportPath, "utf8"));
      const planDraft = fs.readFileSync(scoutPlanPath, "utf8");
      return {
        status: "success",
        report,
        planDraft,
      };
    }

    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Retry planning phase for a run that stalled during planning.
 * Reuses the original goal text; preserves prior scout/no-scout mode.
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
  session.blocked = null;
  run.state = "planning";
  run.blocked = null;
  run.updatedAt = new Date().toISOString();
  saveRun(run);

  try {
    ensureGlobalConventions();

    const includeScoutArtifacts = !(
      run.scoutStatus === "skipped" && run.scoutSkipReason === "--no-scout flag"
    );
    const scoutData = loadScoutData(run.runId);

    if (!isJson && !quiet) {
      if (!includeScoutArtifacts) {
        runtime.log("Replanning (--no-scout mode)...");
      } else if (scoutData) {
        runtime.log("Replanning with cached scout data...");
      } else {
        runtime.log("Replanning (no scout data available)...");
      }
    }

    const planningAnswer = session.answers["step:planning:input"];
    const goalText = planningAnswer
      ? `${session.goal}\n\nUser clarification: ${planningAnswer}`
      : session.goal;

    // Generate plan + scout artifacts in one CLI planning pass
    let planningResult: CliPlanningResult;
    {
      const progress = createCliProgress({
        label: "Generating plan...",
        indeterminate: true,
        enabled: !isJson && !quiet,
      });
      try {
        planningResult = await runCliPlanning({
          runId: run.runId,
          goalText,
          cwd: run.workingDir,
          ...(opts.config?.goal?.enabledWorkers
            ? { enabledWorkers: opts.config.goal.enabledWorkers }
            : {}),
          includeScoutArtifacts,
        });
      } finally {
        progress.done();
      }
    }

    // Handle blocked-at-planning (pre-plan clarification)
    run.scoutStatus = planningResult.scoutStatus;
    if (planningResult.scoutSkipReason) {
      run.scoutSkipReason = planningResult.scoutSkipReason;
    } else {
      delete run.scoutSkipReason;
    }
    if (planningResult.plannerBackendUsed) {
      run.plannerBackendUsed = planningResult.plannerBackendUsed;
    } else {
      delete run.plannerBackendUsed;
    }
    if (planningResult.plannerDegradedReason) {
      run.plannerDegradedReason = planningResult.plannerDegradedReason;
    } else {
      delete run.plannerDegradedReason;
    }
    if (planningResult.plannerDegradedResetHint) {
      run.plannerDegradedResetHint = planningResult.plannerDegradedResetHint;
    } else {
      delete run.plannerDegradedResetHint;
    }

    if (!isJson && !quiet && planningResult.plannerDegradedReason) {
      runtime.log(
        formatPlannerFallbackNotice({
          degradedReason: planningResult.plannerDegradedReason,
          resetHint: planningResult.plannerDegradedResetHint,
        }),
      );
    }

    if (planningResult.status === "blocked") {
      session.state = "blocked";
      session.blocked = {
        blockedAt: "planning",
        prompt: planningResult.question,
        requiredInputKey: "step:planning:input",
      };
      run.state = "blocked";
      run.blocked = session.blocked;
      run.updatedAt = new Date().toISOString();
      saveRun(run);

      const outcome: GoalOutcome = {
        status: "blocked",
        question: planningResult.question,
        requiredInputKey: "step:planning:input",
        blockedAt: "planning",
      };
      if (isJson) {
        runtime.log(JSON.stringify(outcome, null, 2));
      } else if (!quiet) {
        runtime.log(`\nCLARIFICATION NEEDED: ${planningResult.question}`);
      }
      return outcome;
    }

    const planResult = planningResult.plan;

    // Success! Update session with plan
    session.plan = planResult;
    session.state = "awaiting_approval";
    if (planningAnswer) delete session.answers["step:planning:input"];
    run.plan = planResult;
    run.workingDir = planResult.workingDir;
    run.state = "awaiting_approval";
    run.lastError = undefined;
    run.updatedAt = new Date().toISOString();
    saveRun(run);

    // Display plan
    if (!isJson && !quiet) {
      runtime.log("\n");
      runtime.log(
        formatPlanOutput(planResult, {
          diagram: "both",
          format: "md",
          stepResults: session.stepResults,
        }),
      );
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
    session.state = "planning";
    run.lastError = errorMsg;
    run.state = "planning";
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

  // Terminal: done is not resumable (except explicit feedback re-execution path).
  if (run.state === "done" && !opts.allowDoneStateResume) {
    if (isJson) {
      runtime.log(JSON.stringify({ error: "Run already completed." }));
      throw new JsonExitError(1);
    }
    runtime.error("Run already completed.");
    return undefined;
  }

  if (run.state === "blocked") {
    const blockedAt = run.blocked?.blockedAt ?? "execution";
    const requiredKey = run.blocked?.requiredInputKey;
    const answer = requiredKey ? run.answers?.[requiredKey] : undefined;

    if (blockedAt === "planning") {
      if (answer) {
        return await retryPlanning(run, opts, runtime);
      }

      if (isJson) {
        runtime.log(
          JSON.stringify({
            status: "blocked",
            question: run.blocked?.prompt ?? null,
            requiredInputKey: requiredKey ?? null,
            blockedAt,
          }),
        );
      } else {
        runtime.log(`Blocked (planning): ${run.blocked?.prompt ?? "Unknown reason"}`);
        runtime.log(`Required input: ${requiredKey ?? "unknown"}`);
        runtime.log(
          `Answer:  moltbot goal answer ${run.runId.slice(0, 8)} --key ${requiredKey ?? "KEY"} --value <VALUE>`,
        );
      }
      return {
        status: "blocked",
        question: run.blocked?.prompt ?? "",
        requiredInputKey: requiredKey ?? "unknown",
        blockedAt,
      };
    }

    // blockedAt === "execution"
    if (!answer && requiresExecutionAnswer(run, requiredKey)) {
      if (isJson) {
        runtime.log(
          JSON.stringify({
            status: "blocked",
            question: run.blocked?.prompt ?? null,
            requiredInputKey: requiredKey ?? null,
            blockedAt,
          }),
        );
      } else {
        runtime.log(`Blocked: ${run.blocked?.prompt ?? "Unknown reason"}`);
        runtime.log(`Required input: ${requiredKey ?? "unknown"}`);
        runtime.log(
          `Answer:  moltbot goal answer ${run.runId.slice(0, 8)} --key ${requiredKey ?? "KEY"} --value <VALUE>`,
        );
      }
      return {
        status: "blocked",
        question: run.blocked?.prompt ?? "",
        requiredInputKey: requiredKey ?? "unknown",
        blockedAt,
      };
    }
  }

  // Stale/incomplete states - but can be recovered with --replan
  if (run.state === "planning") {
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

  if (run.state === "cancelled" && !run.plan) {
    if (!opts.replan) {
      const msg = "Run has no plan. Use --replan to retry planning from the original goal.";
      if (isJson) {
        runtime.log(JSON.stringify({ error: msg }));
        throw new JsonExitError(1);
      }
      runtime.error(msg);
      return undefined;
    }
    return await retryPlanning(run, opts, runtime);
  }

  // Resumable: awaiting_approval, cancelled, executing

  // Capture run fields for closure (TypeScript can't narrow across closures)
  const { runId: savedRunId, workingDir, model, dryRun, createdAt } = run;

  // Ensure checkpoint-compatible workspace state before execution resumes.
  ensureWorkingDir(workingDir);

  // Reconstruct in-memory session
  const session = serializedToSession(run);
  let executionStartPersisted = false;

  // Helper to persist
  function persistRun(): void {
    const previousRun = loadRun(savedRunId);
    if (executionStartPersisted && previousRun?.state === "cancelled") {
      session.state = "cancelled";
    }

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

    if (!executionStartPersisted && session.state === "executing") {
      executionStartPersisted = true;
    }
  }

  // --- Approval flow: awaiting_approval, cancelled ---
  const needsApproval = run.state === "awaiting_approval" || run.state === "cancelled";

  if (needsApproval) {
    if (session.plan) {
      if (!isJson && !quiet) {
        runtime.log(
          formatPlanOutput(session.plan, {
            diagram: "both",
            format: "md",
            stepResults: session.stepResults,
          }),
        );
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
        return { status: "cancelled" };
      }
      if (isCancel(approved)) {
        session.state = "cancelled";
        persistRun();
        runtime.log("Cancelled.");
        return { status: "cancelled" };
      }
      if (!approved) {
        session.state = "cancelled";
        persistRun();
        runtime.log("Plan rejected.");
        return { status: "cancelled" };
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
    session.blocked = null;
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

  // Critical invariant: persist resume transition before starting executor.
  // The executor checks the persisted run state for external cancellation.
  session.state = "executing";
  session.blocked = null;
  persistRun();

  const disableCheckpoints = process.env.MOLTBOT_NO_GIT_CHECKPOINTS === "1";
  if (
    !isJson &&
    !quiet &&
    run.backendOverride === "claude_code" &&
    (run.plannerDegradedReason === "anthropic_rate_limit" ||
      run.plannerDegradedReason === "anthropic_usage_limit")
  ) {
    runtime.log(
      "Warning: Planner degraded away from Claude due to Anthropic limits. " +
        "--backend claude_code is overriding that safeguard for this execution.",
    );
    runtime.log("");
  }
  const outcome = await executeGoalWithAgent({
    session,
    runId: savedRunId,
    workingDir,
    config: opts.config,
    ...(opts.config?.goal?.enabledWorkers
      ? { enabledWorkers: opts.config.goal.enabledWorkers }
      : {}),
    model,
    maxTurnsPerTask: 5,
    timeoutMs: 300_000,
    gitCheckpointConfig: disableCheckpoints ? undefined : { enabled: true },
    serializedRun: run,
    onTaskUpdate: () => persistRun(),
    onTaskStart: () => persistRun(),
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
      runtime.log(outcome.summary);
    } else if (outcome.status === "blocked") {
      runtime.log(`BLOCKED: ${outcome.question}`);
    } else if (outcome.status === "cancelled") {
      runtime.log("CANCELLED.");
    }
  }

  return outcome;
}
