import { confirm, isCancel } from "@clack/prompts";
import path from "node:path";
import fs from "node:fs";

import { JsonExitError } from "../cli/cli-utils.js";
import { createCliProgress } from "../cli/progress.js";
import { executeGoalWithAgent, type GoalStatusChangeEvent } from "../goal/agent-executor.js";
import {
  clampBackendForEnabledWorkers,
  pickFallbackBackend,
  resolveBackendForStep,
} from "../goal/agent-executor-helpers.js";
import { detectBackendAvailability, isBackendAvailable } from "../goal/backend-availability.js";
import { resolveEffectiveEnabledWorkers } from "../goal/effective-workers.js";
import {
  resolveEnabledWorkers,
  type BackendAvailability,
  type GoalBackendId,
} from "../goal/backend-types.js";
import { isUsageLimitClassReason } from "../goal/error-patterns.js";
import { runCliPlanning, type CliPlanningResult } from "../goal/cli-planner.js";
import { ensureGlobalConventions } from "../goal/conventions.js";
import { formatPlanOutput, formatPlannerFallbackNotice } from "../goal/format-output.js";
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
import type { CliWorkerId } from "../config/types.goal.js";
import type { GoalOutcome, OutputFormat, PlanStep, SerializedRun } from "../goal/types.js";
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

const AUTO_RETRY_EXECUTION_KEYS = new Set(["git", "resume_execution", "none"]);

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

/**
 * Re-check backend availability for usage-limit-blocked steps before a resume.
 *
 * A usage-limit / out-of-credits / rate-limit block is sticky to the backend
 * that hit it (step.executedBackend). On resume that backend may be gone (e.g.
 * uninstalled or no longer on PATH). When it is, and a compatible enabled CLI
 * backend IS available, retarget the step so the executor retries it there
 * instead of dead-ending on "backend not available" (which would re-block it as
 * a generic error). When the sticky backend is still available the step is left
 * untouched — the executor retries it and, if it hits the limit again, performs
 * its own runtime fallback. When no compatible backend is available the step is
 * left usage-limit blocked. An explicit backendOverride lock is always honored.
 *
 * Fallback-backend selection reuses the executor's pickFallbackBackend so the
 * resume path never duplicates that logic.
 */
export function recheckUsageLimitBackends(params: {
  steps: PlanStep[];
  availability: BackendAvailability[];
  enabledWorkers: CliWorkerId[];
  backendOverride?: GoalBackendId;
  onProgress?: (text: string) => void;
}): { reassigned: string[]; stillBlocked: string[] } {
  const { steps, availability, enabledWorkers, backendOverride, onProgress } = params;
  const reassigned: string[] = [];
  const stillBlocked: string[] = [];
  const defaultBackend: CliWorkerId =
    enabledWorkers.length === 1 ? enabledWorkers[0]! : "claude_code";

  for (const step of steps) {
    if (step.status !== "blocked" || !isUsageLimitClassReason(step.blockedReason)) continue;

    // An explicit backend lock pins the step to one backend; never reassign it.
    if (backendOverride) {
      stillBlocked.push(step.id);
      continue;
    }

    const sticky = clampBackendForEnabledWorkers(
      resolveBackendForStep(step, undefined, defaultBackend),
      enabledWorkers,
    );
    if (sticky === "pi") continue; // pi has no usage limits to recover from

    if (isBackendAvailable(sticky, availability).available) {
      // Sticky backend is available again — let the executor retry on it.
      continue;
    }

    const fallback = pickFallbackBackend(
      sticky,
      { status: "blocked", blockedReason: step.blockedReason },
      enabledWorkers,
      availability,
      backendOverride,
    );
    if (fallback.backend) {
      step.executedBackend = fallback.backend;
      reassigned.push(step.id);
      onProgress?.(
        `  [usage-limit] Step ${step.id}: ${sticky} unavailable; retrying on ${fallback.backend}.`,
      );
    } else {
      stillBlocked.push(step.id);
      onProgress?.(
        `  [usage-limit] Step ${step.id}: ${sticky} unavailable and no compatible backend available; staying usage-limit blocked.`,
      );
    }
  }

  return { reassigned, stillBlocked };
}

/**
 * Pi is disabled for launch. Older runs may have steps assigned to the pi
 * backend (step.backend === "pi", or a sticky step.executedBackend === "pi").
 * On resume, remap any not-yet-completed pi step onto a supported, currently
 * available backend (Codex / Claude Code) so the run can continue. Completed
 * steps are left untouched — their backend assignment is historical and they
 * will not re-run.
 *
 * Returns the list of remapped step ids and the list that could not be remapped
 * because no supported backend is available (rejected). The two lists are
 * mutually exclusive: when a target backend exists, every pi step is remapped;
 * when none exists, every pi step is rejected.
 */
export function remapDisabledPiSteps(params: {
  steps: PlanStep[];
  supportedWorkers: CliWorkerId[];
}): { reassigned: string[]; rejected: string[]; target?: CliWorkerId } {
  const { steps, supportedWorkers } = params;
  // Deterministic target preference: Claude Code, then Codex.
  const target = (["claude_code", "codex"] as CliWorkerId[]).find((worker) =>
    supportedWorkers.includes(worker),
  );

  const reassigned: string[] = [];
  const rejected: string[] = [];
  for (const step of steps) {
    if (step.status === "done") continue;
    const usesPi = step.backend === "pi" || step.executedBackend === "pi";
    if (!usesPi) continue;

    if (!target) {
      rejected.push(step.id);
      continue;
    }
    step.backend = target;
    if (step.executedBackend === "pi") step.executedBackend = target;
    reassigned.push(step.id);
  }

  return { reassigned, rejected, ...(target ? { target } : {}) };
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
  const claudeCodeAuth = opts.config?.goal?.claudeCodeAuth ?? "subscription";

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
          claudeCodeAuth,
          ...(opts.config?.goal?.enabledWorkers
            ? { enabledWorkers: opts.config.goal.enabledWorkers }
            : {}),
          includeScoutArtifacts,
        });
      } finally {
        progress.done();
      }
    }

    // If /goal_stop cancelled this run while planning was in-flight, do not
    // overwrite cancelled state with planning results.
    const latestRun = loadRun(run.runId);
    if (latestRun?.state === "cancelled") {
      session.state = "cancelled";
      return { status: "cancelled" };
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
  const claudeCodeAuth = opts.config?.goal?.claudeCodeAuth ?? "subscription";

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
          // Preserve the persisted block classification (usage_limit / rate_limit /
          // out_of_credits / user_input / task_failed / ...) so resume can tell a
          // backend usage-limit blocker apart from a generic failure and recompute
          // the right display state. Only default to a generic "error" when the
          // prior run recorded no reason at all.
          step.blockedReason = step.blockedReason ?? "error";
          step.blockedQuestion =
            step.blockedQuestion ?? result.error ?? "Step failed in a previous run.";
        }
      }
    }

    const availability = detectBackendAvailability();

    // Pi is disabled for launch. Remap any not-yet-completed pi step onto a
    // supported, available backend so an old run with pi steps can resume. If
    // none is available, reject the resume with a clear message rather than
    // dead-ending on an unavailable backend at execution time.
    const supportedWorkers = resolveEffectiveEnabledWorkers({
      ...(opts.config?.goal ? { config: opts.config.goal } : {}),
      availability,
    });
    const piRemap = remapDisabledPiSteps({ steps: session.plan.steps, supportedWorkers });
    if (piRemap.rejected.length > 0) {
      const msg =
        `Cannot resume: step(s) ${piRemap.rejected.join(", ")} use the pi backend, which is ` +
        "disabled for launch, and no supported backend (Codex or Claude Code) is available to " +
        "take over. Install Codex or Claude Code and resume again.";
      if (isJson) {
        runtime.log(JSON.stringify({ error: msg }));
        throw new JsonExitError(1);
      }
      runtime.error(msg);
      return undefined;
    }
    if (piRemap.reassigned.length > 0 && !isJson && !quiet) {
      runtime.log(
        `  [pi-disabled] Remapped step(s) ${piRemap.reassigned.join(", ")} from pi to ${piRemap.target}.`,
      );
    }

    // Before re-executing, re-check backends for usage-limit-blocked steps so a
    // step pinned to an exhausted/unavailable backend is retried on a compatible
    // available one (e.g. Codex out → Claude) instead of staying stale-blocked.
    const hasUsageLimitBlocked = session.plan.steps.some(
      (step) => step.status === "blocked" && isUsageLimitClassReason(step.blockedReason),
    );
    if (hasUsageLimitBlocked) {
      recheckUsageLimitBackends({
        steps: session.plan.steps,
        availability,
        enabledWorkers: resolveEnabledWorkers(opts.config?.goal),
        ...(run.backendOverride ? { backendOverride: run.backendOverride } : {}),
        onProgress: !isJson && !quiet ? (text) => runtime.log(text) : undefined,
      });
    }
  }

  const resumableSteps =
    session.plan?.steps.filter((s) => s.status === "pending" || s.status === "blocked") ?? [];
  if (resumableSteps.length === 0) {
    const finalGateFailed =
      session.buildGateResults?.["__final__"]?.passed === false ||
      run.blocked?.prompt.startsWith("Final build gate failed") === true;
    if (finalGateFailed) {
      // Final build gate failures can be retried without /goal_answer.
      session.blocked = null;
    } else {
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
    claudeCodeAuth,
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
