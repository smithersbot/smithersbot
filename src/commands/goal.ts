import { confirm, isCancel } from "@clack/prompts";
import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { JsonExitError } from "../cli/cli-utils.js";
import { createCliProgress } from "../cli/progress.js";
import { resolveApiKeyForProvider } from "../agents/model-auth.js";
import { executeGoalWithAgent } from "../goal/agent-executor.js";
import { formatPlanOutput } from "../goal/format-output.js";
import { isGitRepo } from "../goal/git-checkpoint.js";
import { createGoalLlmClient } from "../goal/llm-client.js";
import { generatePlan, PlanParseError, persistRawPlanResponse } from "../goal/planner.js";
import { saveRun, sessionToSerialized } from "../goal/run-store.js";
import { runScoutWithRetry, type ScoutResult } from "../goal/scout.js";
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
import type { RuntimeEnv } from "../runtime.js";

const DEFAULT_WORKSPACE_DIR = ".moltbot-goal-workspace";

export type GoalCommandOptions = {
  goal: string;
  model?: string;
  workingDir?: string;
  yes?: boolean;
  json?: boolean;
  dryRun?: boolean;
  diagram?: DiagramMode;
  output?: OutputFormat;
  /** Stop after planning; set state to awaiting_approval without entering the approval gate. */
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
 * 3. cwd is a git repo → use cwd
 * 4. Fallback to .moltbot-goal-workspace sandbox
 */
export function resolveWorkingDir(
  explicit: string | undefined,
  config: MoltbotConfig | undefined,
  cwd: string,
): string {
  if (explicit) return path.resolve(explicit);
  const configDir = config?.goal?.defaultWorkingDir;
  if (configDir) return path.resolve(configDir);
  if (isGitRepo(cwd)) return cwd;
  return path.resolve(cwd, DEFAULT_WORKSPACE_DIR);
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
  const workingDir = resolveWorkingDir(opts.workingDir, opts.config, cwd);

  mkdirSync(workingDir, { recursive: true });

  // Generate run ID and timestamp for persistence
  const runId = opts.runId ?? crypto.randomUUID();
  const createdAt = new Date().toISOString();
  let scoutStatus: SerializedRun["scoutStatus"];
  let scoutSkipReason: string | undefined;

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
    });
    saveRun(serialized);
  }

  // Persist immediately so the run record exists before anything can fail
  persistRun();

  try {
    // Resolve API key
    const authResult = await resolveApiKeyForProvider({ provider: "anthropic" });
    if (!authResult.apiKey) {
      throw new Error(
        "Anthropic auth resolved but no API key available (mode: " + authResult.mode + ").",
      );
    }

    const client = createGoalLlmClient({
      apiKey: authResult.apiKey,
      modelOverride: opts.model,
    });

    // Resolve auth mode early so both scout and executor can use it
    const resolvedAuthMode = opts.claudeCodeAuth ?? opts.config?.goal?.claudeCodeAuth;

    // Phase 0: Scout pre-pass (optional, best-effort)
    let scoutData: ScoutResult | undefined;
    if (!opts.noScout) {
      const scoutProgress = createCliProgress({
        label: "Running scout analysis...",
        indeterminate: true,
        enabled: !isJson,
      });
      try {
        scoutData = await runScoutWithRetry({
          runId,
          goalText: goal,
          timeoutMs: opts.scoutTimeoutMs,
          claudeCodeAuth: resolvedAuthMode,
        });
        if (scoutData.status === "skipped") {
          scoutStatus = "skipped";
          scoutSkipReason = scoutData.reason;
          if (!isJson) {
            runtime.log(`Scout skipped: ${scoutData.reason}`);
          }
        }
        if (scoutData.status === "needs_clarification") {
          scoutStatus = "needs_clarification";
          session.state = "blocked";
          session.blocked = {
            blockedAt: "planning",
            prompt: scoutData.question,
            requiredInputKey: "step:planning:input",
          };
          persistRun();
          const outcome: GoalOutcome = {
            status: "blocked",
            question: scoutData.question,
            requiredInputKey: "step:planning:input",
            blockedAt: "planning",
          };
          if (isJson) {
            runtime.log(JSON.stringify(outcome, null, 2));
          } else {
            runtime.log(`\nCLARIFICATION NEEDED: ${scoutData.question}`);
          }
          return outcome;
        }
        if (scoutData.status === "error") {
          const errorKind = scoutData.errorKind ?? "unknown";
          const errorDetail = scoutData.error ?? "unknown error";
          scoutStatus = "skipped";
          scoutSkipReason = `scout_error(${errorKind}): ${errorDetail}`;
          if (!isJson) {
            runtime.log(`Scout failed (${errorKind}), continuing without scout data.`);
          }
          scoutData = undefined;
        }
        if (scoutData?.status === "success") {
          scoutStatus = "success";
        }
      } finally {
        scoutProgress.done();
      }
    } else {
      scoutStatus = "skipped";
      scoutSkipReason = "--no-scout flag";
    }

    // Phase 1: Planning (enriched with scout data when available)
    session.state = "planning";
    persistRun();
    let planResult;
    {
      const progress = createCliProgress({
        label: "Generating plan...",
        indeterminate: true,
        enabled: !isJson,
      });
      try {
        planResult = await generatePlan(client, goal, scoutData);
      } finally {
        progress.done();
      }
    }

    // Handle blocked-at-planning (pre-plan clarification, not execution-time block)
    if ("blocked" in planResult) {
      session.state = "blocked";
      session.blocked = {
        blockedAt: "planning",
        prompt: planResult.question,
        requiredInputKey: "step:planning:input",
      };
      persistRun();
      const outcome: GoalOutcome = {
        status: "blocked",
        question: planResult.question,
        requiredInputKey: "step:planning:input",
        blockedAt: "planning",
      };
      if (isJson) {
        runtime.log(JSON.stringify(outcome, null, 2));
      } else {
        runtime.log(`\nCLARIFICATION NEEDED: ${planResult.question}`);
      }
      return outcome;
    }

    // After the blocked check, planResult is narrowed to Plan
    session.plan = planResult;
    persistRun();

    // Display plan (human-readable only; JSON mode emits a single combined object later)
    if (!isJson) {
      runtime.log("\n");
      runtime.log(
        formatPlanOutput(planResult, { diagram: diagramMode, format: outputFormat, workingDir }),
      );
      runtime.log("");
    }

    // Plan-only mode: stop after planning, leave state as awaiting_approval.
    // Only reached when planResult is a Plan (blocked/failed paths return earlier).
    if (opts.planOnly) {
      session.state = "awaiting_approval";
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
          formatPlanOutput(planResult, { diagram: diagramMode, format: "json" }),
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

    const disableCheckpoints =
      Boolean(opts.noGitCheckpoints) || process.env.MOLTBOT_NO_GIT_CHECKPOINTS === "1";
    const outcome = await executeGoalWithAgent({
      session,
      runId,
      workingDir,
      model: opts.model,
      maxTurnsPerTask: 5,
      timeoutMs: 300_000,
      gitCheckpointConfig: disableCheckpoints ? undefined : { enabled: true },
      serializedRun: { backendOverride: opts.backend } as SerializedRun,
      claudeCodeAuth: resolvedAuthMode,
      onTaskUpdate: () => persistRun(),
      onProgress: (text) => {
        if (!isJson) runtime.log(text);
      },
    });

    persistRun();

    // Final result
    if (isJson) {
      const planData = JSON.parse(
        formatPlanOutput(planResult, { diagram: diagramMode, format: "json" }),
      );
      runtime.log(JSON.stringify({ ...outcome, plan: planData }, null, 2));
    } else {
      runtime.log("");
      if (outcome.status === "done") {
        runtime.log(`DONE: ${outcome.summary}`);
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
