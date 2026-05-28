import { confirm, isCancel } from "@clack/prompts";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { JsonExitError } from "../cli/cli-utils.js";
import { createCliProgress } from "../cli/progress.js";
import { executeGoalWithAgent } from "../goal/agent-executor.js";
import { runCliPlanning } from "../goal/cli-planner.js";
import { ensureGlobalConventions } from "../goal/conventions.js";
import { formatPlanOutput, formatPlannerFallbackNotice } from "../goal/format-output.js";
import { ensureWorkingDir, isGitRepo } from "../goal/git-checkpoint.js";
import { PlanParseError, persistRawPlanResponse } from "../goal/planner.js";
import { loadRun, saveRun, sessionToSerialized } from "../goal/run-store.js";
import type { GoalBackendId } from "../goal/backend-types.js";
import type {
  DiagramMode,
  GoalOutcome,
  GoalSession,
  OutputFormat,
  SerializedRun,
} from "../goal/types.js";
import type { ClaudeCodeAuthMode } from "../config/types.goal.js";
import type { MoltbotConfig } from "../config/types.clawdbot.js";
import { resolveWorkspaceRepoDir, slugifyWorkspaceName } from "../config/managed-paths.js";
import type { RuntimeEnv } from "../runtime.js";

export type GoalCommandOptions = {
  goal: string;
  model?: string;
  workingDir?: string;
  yes?: boolean;
  json?: boolean;
  dryRun?: boolean;
  diagram?: DiagramMode;
  output?: OutputFormat;
  /** Stop after planning; keep state as planning for channel-specific approval delivery. */
  planOnly?: boolean;
  /** Use this run ID instead of generating a new one. */
  runId?: string;
  /** Skip the scout pre-pass (claude -p codebase analysis). */
  noScout?: boolean;
  /** Scout timeout in milliseconds. */
  scoutTimeoutMs?: number;
  /** Disable git checkpoints during execution. */
  noGitCheckpoints?: boolean;
  /** Override execution backend for all steps. */
  backend?: GoalBackendId;
  /** Config object for goal-specific settings (defaultWorkingDir, readOnlyRoots). */
  config?: MoltbotConfig;
  /** How Claude Code workers authenticate: subscription (default) or api_key. */
  claudeCodeAuth?: ClaudeCodeAuthMode;
};

/** Resolve effective output format: --output wins over --json. */
function resolveOutputFormat(opts: GoalCommandOptions): OutputFormat {
  if (opts.output) return opts.output;
  if (opts.json) return "json";
  return "md";
}

/** Resolve effective diagram mode. Default depends on output format. */
function resolveDiagramMode(opts: GoalCommandOptions, outputFormat: OutputFormat): DiagramMode {
  if (opts.diagram) return opts.diagram;
  return outputFormat === "json" ? "none" : "both";
}

/**
 * Resolve the effective working directory.
 *
 * Precedence (highest to lowest):
 * 1. Explicit --working-dir flag
 * 2. config.goal.defaultWorkingDir
 * 3. parsed user instruction (handled by channel-specific callers before this helper)
 * 4. managed workspace project: <root>/agent/workspaces/<workspace-name>
 *
 * Stage 2S is transitional: explicit/configured legacy workingDir values remain
 * supported by worker launch policy unless goal.allowLegacyWorkingDir is false.
 * Project code should read normal process env variables; real workspace env
 * files live host-side under private/env and are never the worker default env.
 */
export function resolveWorkingDir(
  explicit: string | undefined,
  config: MoltbotConfig | undefined,
  cwd: string,
): string {
  if (explicit) return path.resolve(explicit);
  const configDir = config?.goal?.defaultWorkingDir;
  if (configDir) return path.resolve(configDir);
  return resolveWorkspaceRepoDir(resolveDefaultWorkspaceName(config, cwd));
}

function resolveDefaultWorkspaceName(config: MoltbotConfig | undefined, cwd: string): string {
  const configured = config?.goal?.defaultWorkspaceName;
  if (configured) return slugifyWorkspaceName(configured);
  const gitRoot = resolveGitTopLevel(cwd);
  if (gitRoot) return slugifyWorkspaceName(path.basename(gitRoot));
  return "default";
}

function resolveGitTopLevel(cwd: string): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    if (isGitRepo(cwd)) return cwd;
    return undefined;
  }
}

export async function goalCommand(
  opts: GoalCommandOptions,
  runtime: RuntimeEnv,
): Promise<GoalOutcome | undefined> {
  const goal = opts.goal.trim();
  if (!goal) throw new Error("Goal text is required");

  const outputFormat = resolveOutputFormat(opts);
  const diagramMode = resolveDiagramMode(opts, outputFormat);
  const isJson = outputFormat === "json";
  const isDryRun = Boolean(opts.dryRun);

  const cwd = process.cwd();
  let workingDir = resolveWorkingDir(opts.workingDir, opts.config, cwd);

  mkdirSync(workingDir, { recursive: true });

  // Generate run ID and timestamp for persistence
  const runId = opts.runId ?? crypto.randomUUID();
  const createdAt = new Date().toISOString();
  let scoutStatus: SerializedRun["scoutStatus"];
  let scoutSkipReason: string | undefined;
  let plannerBackendUsed: SerializedRun["plannerBackendUsed"];
  let plannerDegradedReason: SerializedRun["plannerDegradedReason"];
  let plannerDegradedResetHint: SerializedRun["plannerDegradedResetHint"];

  if (!isJson) {
    runtime.log(`Run: ${runId}`);
    runtime.log(`Workspace: ${workingDir}`);
  }

  // In-memory session state
  const session: GoalSession = {
    goal,
    state: "planning",
    plan: null,
    stepResults: new Map(),
    blocked: null,
    answers: {},
  };

  // Persist the current session state to disk
  function persistRun(): void {
    const serialized = sessionToSerialized({
      session,
      runId,
      workingDir,
      model: opts.model,
      dryRun: isDryRun,
      createdAt,
      scoutStatus,
      scoutSkipReason,
      backendOverride: opts.backend,
      plannerBackendUsed,
      plannerDegradedReason,
      plannerDegradedResetHint,
    });
    saveRun(serialized);
  }

  // Persist immediately so the run record exists before anything can fail
  persistRun();

  try {
    // Resolve auth mode early so planner and executor stay in sync
    const resolvedAuthMode = opts.claudeCodeAuth ?? opts.config?.goal?.claudeCodeAuth;
    ensureGlobalConventions();

    // Phase 1: Single CLI planning pass (plan + scout artifacts)
    session.state = "planning";
    persistRun();
    const planningResult = await (async () => {
      const progress = createCliProgress({
        label: "Generating plan...",
        indeterminate: true,
        enabled: !isJson,
      });
      try {
        return await runCliPlanning({
          runId,
          goalText: goal,
          cwd: workingDir,
          timeoutMs: opts.scoutTimeoutMs,
          claudeCodeAuth: resolvedAuthMode,
          ...(opts.config?.goal?.enabledWorkers
            ? { enabledWorkers: opts.config.goal.enabledWorkers }
            : {}),
          includeScoutArtifacts: !opts.noScout,
        });
      } finally {
        progress.done();
      }
    })();

    const latestRun = loadRun(runId);
    if (latestRun?.state === "cancelled") {
      session.state = "cancelled";
      return { status: "cancelled" };
    }

    scoutStatus = planningResult.scoutStatus;
    scoutSkipReason = planningResult.scoutSkipReason;
    plannerBackendUsed = planningResult.plannerBackendUsed;
    plannerDegradedReason = planningResult.plannerDegradedReason;
    plannerDegradedResetHint = planningResult.plannerDegradedResetHint;
    if (!isJson && plannerDegradedReason) {
      runtime.log(
        formatPlannerFallbackNotice({
          degradedReason: plannerDegradedReason,
          resetHint: plannerDegradedResetHint,
        }),
      );
    }
    if (scoutStatus === "skipped" && scoutSkipReason && !isJson) {
      runtime.log(`Scout skipped: ${scoutSkipReason}`);
    }
    if (!isJson && opts.backend === "claude_code" && plannerDegradedReason) {
      runtime.log(
        "Warning: Planner degraded away from Claude due to Anthropic limits. " +
          "--backend claude_code will override that safeguard for execution.",
      );
    }

    // Handle blocked-at-planning (pre-plan clarification, not execution-time block)
    if (planningResult.status === "blocked") {
      session.state = "blocked";
      session.blocked = {
        blockedAt: "planning",
        prompt: planningResult.question,
        requiredInputKey: "step:planning:input",
      };
      persistRun();
      const outcome: GoalOutcome = {
        status: "blocked",
        question: planningResult.question,
        requiredInputKey: "step:planning:input",
        blockedAt: "planning",
      };
      if (isJson) {
        runtime.log(JSON.stringify(outcome, null, 2));
      } else {
        runtime.log(`\nCLARIFICATION NEEDED: ${planningResult.question}`);
      }
      return outcome;
    }

    const planResult = planningResult.plan;

    // After the blocked check, planResult is narrowed to Plan
    session.plan = planResult;
    workingDir = planResult.workingDir;
    persistRun();

    // Display plan (human-readable only; JSON mode emits a single combined object later)
    if (!isJson) {
      runtime.log("\n");
      runtime.log(
        formatPlanOutput(planResult, {
          diagram: diagramMode,
          format: outputFormat,
          workingDir,
          stepResults: session.stepResults,
        }),
      );
      runtime.log("");
    }

    // Plan-only mode: stop after planning and keep run in planning state.
    // Channel adapters transition to awaiting_approval after they deliver the plan to users.
    // Only reached when planResult is a Plan (blocked/failed paths return earlier).
    if (opts.planOnly) {
      session.state = "planning";
      persistRun();
      return undefined;
    }

    if (isDryRun) {
      session.state = "done";
      persistRun();
      const outcome: GoalOutcome = {
        status: "done",
        summary: "Dry run complete (plan generated, no execution)",
      };
      if (isJson) {
        const planData = JSON.parse(
          formatPlanOutput(planResult, {
            diagram: diagramMode,
            format: "json",
            stepResults: session.stepResults,
          }),
        );
        runtime.log(JSON.stringify({ ...outcome, plan: planData }, null, 2));
      }
      return outcome;
    }

    // Phase 2: Approval gate
    session.state = "awaiting_approval";
    persistRun();
    if (!opts.yes) {
      // JSON mode requires --yes because interactive prompts break strict JSON output
      if (isJson) {
        throw new Error(
          "--output json requires --yes to skip interactive approval. Add --yes to auto-approve.",
        );
      }
      let approved: boolean | symbol;
      try {
        approved = await confirm({
          message: `Execute this ${planResult.steps.length}-step plan?`,
        });
      } catch {
        // SIGINT / stdin closed during prompt — persist as cancelled
        session.state = "cancelled";
        persistRun();
        runtime.log("Cancelled.");
        runtime.exit(130);
      }
      if (isCancel(approved)) {
        // Ctrl+C / ESC via clack — persist as cancelled, not rejected
        session.state = "cancelled";
        persistRun();
        runtime.log("Cancelled.");
        runtime.exit(130);
      }
      if (!approved) {
        // Explicit "No" — persist as cancelled
        session.state = "cancelled";
        persistRun();
        runtime.log("Plan rejected.");
        return { status: "cancelled" };
      }
    }

    // Phase 3: Execution
    if (!isJson) runtime.log("");
    // Ensure checkpoint-compatible workspace state before execution starts.
    ensureWorkingDir(workingDir);

    const disableCheckpoints =
      Boolean(opts.noGitCheckpoints) || process.env.MOLTBOT_NO_GIT_CHECKPOINTS === "1";
    const outcome = await executeGoalWithAgent({
      session,
      runId,
      workingDir,
      config: opts.config,
      ...(opts.config?.goal?.enabledWorkers
        ? { enabledWorkers: opts.config.goal.enabledWorkers }
        : {}),
      model: opts.model,
      maxTurnsPerTask: 5,
      timeoutMs: 300_000,
      gitCheckpointConfig: disableCheckpoints ? undefined : { enabled: true },
      serializedRun: {
        createdAt,
        backendOverride: opts.backend,
        plannerBackendUsed,
        plannerDegradedReason,
        plannerDegradedResetHint,
      } as SerializedRun,
      claudeCodeAuth: resolvedAuthMode,
      onTaskUpdate: () => persistRun(),
      onRunStatePersist: () => persistRun(),
      onProgress: (text) => {
        if (!isJson) runtime.log(text);
      },
    });

    persistRun();

    // Final result
    if (isJson) {
      const planData = JSON.parse(
        formatPlanOutput(planResult, {
          diagram: diagramMode,
          format: "json",
          stepResults: session.stepResults,
        }),
      );
      runtime.log(JSON.stringify({ ...outcome, plan: planData }, null, 2));
    } else {
      runtime.log("");
      if (outcome.status === "done") {
        runtime.log(outcome.summary);
      } else if (outcome.status === "blocked") {
        runtime.log(`BLOCKED: ${outcome.question}`);
      } else if (outcome.status === "cancelled") {
        runtime.log("CANCELLED.");
      }
    }

    return outcome;
  } catch (err) {
    // Persist the failure so the run record is always available
    const errorMsg = err instanceof Error ? err.message : String(err);
    session.lastError = errorMsg;
    session.state = session.plan ? "cancelled" : "planning";
    persistRun();

    // Persist raw LLM response for post-mortem when JSON parsing fails
    if (err instanceof PlanParseError) {
      persistRawPlanResponse(runId, err.rawResponse);
    }

    if (isJson) {
      runtime.log(JSON.stringify({ error: errorMsg, runId }));
      throw new JsonExitError(1);
    }
    throw err;
  }
}
