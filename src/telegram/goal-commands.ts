import path from "node:path";
import { type Bot, type Context } from "grammy";
import type { ReactionTypeEmoji } from "grammy/types";

import { resolveChannelConfigWrites } from "../channels/plugins/config-writes.js";
import { warn } from "../globals.js";
import { type ChatAction, logTyping, startTypingLoop } from "./typing-loop.js";
import { JsonExitError } from "../cli/cli-utils.js";
import { goalCommand } from "../commands/goal.js";
import { goalAnswerCommand } from "../commands/goal-answer.js";
import { goalDetailCommand } from "../commands/goal-detail.js";
import { goalResumeCommand } from "../commands/goal-resume.js";
import { goalStatusCommand } from "../commands/goal-status.js";
import { loadConfig, type MoltbotConfig } from "../config/config.js";
import type { ChannelGroupPolicy } from "../config/group-policy.js";
import { writeConfigFile } from "../config/io.js";
import type {
  TelegramAccountConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "../config/types.js";
import type { GoalStatusChangeEvent } from "../goal/agent-executor.js";
import { resolveEnabledWorkers } from "../goal/backend-types.js";
import { runCliPlanRevision } from "../goal/cli-planner.js";
import { AUTH_RE } from "../goal/error-patterns.js";
import { formatGoalError } from "../goal/errors.js";
import {
  buildFeedbackRevisionInstructions,
  mergeRevisedPlanWithDoneSteps,
} from "../goal/feedback.js";
import { formatPlanOutput, formatPlannerFallbackNotice } from "../goal/format-output.js";
import { generateManualTests } from "../goal/manual-tests.js";
import { runPlanAutocheck } from "../goal/plan-autocheck.js";
import { ensureWorkingDir } from "../goal/git-checkpoint.js";
import { PlanParseError, persistRawPlanResponse } from "../goal/planner.js";
import {
  acquireGoalOpLock,
  forceReleaseGoalOpLock,
  isGoalOpLocked,
  type GoalOpLockResult,
} from "../goal/goal-lock.js";
import {
  loadRun,
  resolveGoalsDir,
  resolveRunDir,
  resolveRunId,
  saveRun,
} from "../goal/run-store.js";
import type { Plan, SerializedRun, StepResult } from "../goal/types.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  buildGoalDoneInlineKeyboard,
  buildOnStatusChange,
  buildDoneSummaryWithManualTests,
  formatGoalLockedMessage,
  formatManualTestDetails,
  formatGoalWorkers,
  formatTaskDetailSections,
  getGoalExecutionPreface,
  handleGoalLessons,
  handleGoalList,
  isPlanAutocheckBackend,
  parseGoalPlanAutocheckMode,
  parseGoalWorkersArg,
  parseWorkingDirInstruction,
  PLANNING_PREFACE,
  RESUME_PREFACE,
  resolveBlockedRequiredInputKey,
  serializedStepResultsToMap,
  START_PREFACE,
} from "./goal-formatting.js";
import {
  persistEditPromptMessage,
  persistFeedbackPromptMessage,
  persistTelegramQuestionMessage,
  sendDagPng,
  sendBlockedNotification,
  sendGoalBackgroundResult,
  sendGoalPlanResult,
  sendGoalReply,
} from "./goal-sending.js";
import { findRunByPlanMessageIdIndexed } from "./goal-message-index.js";
import { shortenHomePath } from "../utils.js";
import { resolveTelegramCommandAuth } from "./telegram-auth.js";
import {
  buildCommandFragmentKey,
  type CommandFragmentBuffer,
  normalizeCommandFragmentParams,
} from "./command-fragments.js";

export { sendGoalBackgroundResult, sendGoalPlanResult, sendGoalReply };
export {
  buildGoalDoneInlineKeyboard,
  buildOnStatusChange,
  formatGoalLockedMessage,
  getGoalExecutionPreface,
  handleGoalLessons,
  handleGoalList,
  PLANNING_PREFACE,
  RESUME_PREFACE,
  START_PREFACE,
};

// ---------------------------------------------------------------------------
// Telegram command menu entries for the goal subsystem
// ---------------------------------------------------------------------------

export const GOAL_COMMAND_SPECS: Array<{ command: string; description: string }> = [
  { command: "new_goal", description: "Plan a new goal (shows plan for approval)" },
  { command: "goal_approve", description: "Approve and execute a goal plan" },
  { command: "goal_resume", description: "Resume a goal run (alias of /goal_approve)" },
  { command: "goal_reject", description: "Reject a goal plan" },
  { command: "goal_edit", description: "Edit a goal plan" },
  {
    command: "goal_plan_autocheck",
    description: "Set plan autocheck backend: codex, claude_code, or off",
  },
  {
    command: "goal_semgrep",
    description: "Set semgrep SAST mode: off, step, or goal",
  },
  {
    command: "goal_workers",
    description: "Set enabled CLI workers: codex, claude_code, or both",
  },
  {
    command: "goal_status",
    description: "Show concise run status (state, progress, blocker, retries)",
  },
  {
    command: "goal_detail",
    description: "Show detailed run status (includes all steps)",
  },
  { command: "goal_answer", description: "Answer a goal's clarification question" },
  {
    command: "goal_feedback",
    description: "Incorporate manual-test feedback into a completed run",
  },
  { command: "goal_stop", description: "Stop a running goal" },
  { command: "goal_list", description: "List recent goal runs" },
  { command: "goal_lessons", description: "List or clear persistent goal lessons" },
  { command: "goal_github_push", description: "Toggle auto GitHub push + PR for completed runs" },
];

// ---------------------------------------------------------------------------
// Capture RuntimeEnv -- routes log/error to string buffers
// ---------------------------------------------------------------------------

class RuntimeExitError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

export function createCaptureRuntime(): {
  runtime: RuntimeEnv;
  getLogs(): string;
  getErrors(): string;
} {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    runtime: {
      log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
      error: (...args: unknown[]) => errors.push(args.map(String).join(" ")),
      exit: ((code: number) => {
        throw new RuntimeExitError(code);
      }) as never,
    },
    getLogs: () => logs.join("\n"),
    getErrors: () => errors.join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Structured result type for plan handlers
// ---------------------------------------------------------------------------

export type GoalPlanResult = {
  text: string;
  runId?: string;
  revision?: number;
  blocked?: boolean;
  /** Plan object for PNG rendering (when available, sendGoalPlanResult renders a DAG photo). */
  plan?: Plan;
  /** Runtime results used to show actual elapsed durations for completed steps. */
  stepResults?: ReadonlyMap<string, StepResult>;
  /** Number of autocheck-driven replans before showing this plan to the user. */
  autocheckRounds?: number;
  /** Configured upper bound for autocheck-driven replans. */
  autocheckMaxRounds?: number;
  /** Whether autocheck hit max rounds before user review. */
  autocheckExhausted?: boolean;
  /** Whether autocheck failed and was skipped. */
  autocheckSkipped?: boolean;
};

const GOAL_PLAN_AUTOCHECK_USAGE = "Usage: /goal_plan_autocheck <codex|claude_code|off>";
const GOAL_SEMGREP_USAGE = "Usage: /goal_semgrep <off|step|goal>";
const GOAL_WORKERS_USAGE = "Usage: /goal_workers <codex|claude_code|both|all>";
const GOAL_GITHUB_PUSH_USAGE = "Usage: /goal\\_github\\_push \\[on|off]";
const GOAL_PLAN_AUTOCHECK_MAX_ROUNDS = 3;

type PlanAutocheckDisplayInfo = {
  rounds: number;
  maxRounds: number;
  exhausted: boolean;
};

function commitPlanRevision(params: {
  run: SerializedRun;
  revisedPlan: Plan;
  editInstructions: string;
  source?: "user" | "autocheck";
  previousPlan?: Plan;
}): number {
  const { run, revisedPlan, editInstructions, source } = params;
  const oldRevision = run.planRevision ?? 1;
  const newRevision = oldRevision + 1;
  const history = run.planHistory ?? [];
  history.push({
    revision: oldRevision,
    plan: params.previousPlan ?? run.plan ?? revisedPlan,
    editInstructions,
    source,
  });

  run.plan = revisedPlan;
  if (revisedPlan.workingDir !== run.workingDir) {
    run.workingDir = revisedPlan.workingDir;
  }
  run.planRevision = newRevision;
  run.activePlanRevision = newRevision;
  run.planHistory = history;
  run.updatedAt = new Date().toISOString();
  return newRevision;
}

async function runGoalPlanAutocheck(params: {
  runId: string;
  run: SerializedRun;
  plan: Plan;
  config?: MoltbotConfig;
  existingSessionId?: string;
  existingBackend?: SerializedRun["autocheckBackend"];
}): Promise<{ run: SerializedRun; plan: Plan; display: PlanAutocheckDisplayInfo } | undefined> {
  const mode = params.config?.goal?.planAutocheck;
  if (!isPlanAutocheckBackend(mode)) return undefined;
  const userEditInstructions = (params.run.planHistory ?? [])
    .filter((entry) => entry.source === "user")
    .map((entry) => entry.editInstructions?.trim() ?? "")
    .filter((instruction) => instruction.length > 0);

  const autocheckResult = await runPlanAutocheck({
    plan: params.plan,
    goalText: params.run.goal,
    userEditInstructions,
    mode,
    maxRounds: GOAL_PLAN_AUTOCHECK_MAX_ROUNDS,
    workingDir: params.run.workingDir,
    claudeCodeAuth: params.config?.goal?.claudeCodeAuth ?? "subscription",
    ...(params.config?.goal?.enabledWorkers
      ? { enabledWorkers: params.config.goal.enabledWorkers }
      : {}),
    runDir: path.join(resolveGoalsDir(), params.runId),
    existingSessionId: params.existingSessionId,
    existingBackend: params.existingBackend,
    model: params.run.model,
    commitRevision: async ({ editInstructions, previousPlan, revisedPlan }) => {
      const latestRun = loadRun(params.runId);
      if (!latestRun) return;
      const workingDirBeforeRevision = latestRun.workingDir;
      commitPlanRevision({
        run: latestRun,
        revisedPlan,
        editInstructions,
        source: "autocheck",
        previousPlan,
      });
      if (latestRun.workingDir !== workingDirBeforeRevision) {
        ensureWorkingDir(latestRun.workingDir);
      }
      saveRun(latestRun);
    },
  });

  const nextRun = loadRun(params.runId) ?? params.run;
  nextRun.plan = autocheckResult.plan;
  nextRun.autocheckRounds = autocheckResult.autocheckRounds;
  nextRun.autocheckMaxRounds = autocheckResult.autocheckMaxRounds;
  nextRun.autocheckBackend = autocheckResult.backend;
  nextRun.autocheckSessionId = autocheckResult.sessionId;
  nextRun.updatedAt = new Date().toISOString();
  saveRun(nextRun);

  return {
    run: nextRun,
    plan: nextRun.plan ?? autocheckResult.plan,
    display: {
      rounds: autocheckResult.autocheckRounds,
      maxRounds: autocheckResult.autocheckMaxRounds,
      exhausted: autocheckResult.exhausted,
    },
  };
}

function markRunAwaitingApproval(run: SerializedRun | undefined): SerializedRun | undefined {
  if (!run) return run;
  const latestRun = loadRun(run.runId) ?? run;
  if (latestRun.state === "awaiting_approval" || latestRun.state === "cancelled") {
    return latestRun;
  }
  latestRun.state = "awaiting_approval";
  latestRun.updatedAt = new Date().toISOString();
  saveRun(latestRun);
  return latestRun;
}

function trackBlockedStatusChange(
  onStatusChange?: (event: GoalStatusChangeEvent) => void | Promise<void>,
): {
  onStatusChange?: (event: GoalStatusChangeEvent) => Promise<void>;
  didSendFullyBlocked: () => boolean;
} {
  let sentFullyBlocked = false;
  if (!onStatusChange) {
    return {
      onStatusChange: undefined,
      didSendFullyBlocked: () => false,
    };
  }
  return {
    onStatusChange: async (event: GoalStatusChangeEvent) => {
      await onStatusChange(event);
      if (event.type === "fully_blocked") {
        sentFullyBlocked = true;
      }
    },
    didSendFullyBlocked: () => sentFullyBlocked,
  };
}

// ---------------------------------------------------------------------------
// Typing indicator helpers (loop logic lives in typing-loop.ts)
// ---------------------------------------------------------------------------

/** Send repeated chat actions (e.g. "typing") while an async function runs. */
export async function withChatAction<T>(params: {
  bot: Bot;
  chatId: number;
  action: ChatAction;
  threadId?: number;
  label?: string;
  fn: () => Promise<T>;
}): Promise<T> {
  const { bot, chatId, action, threadId, label, fn } = params;
  const loop = startTypingLoop({ bot, chatId, action, threadId, label });
  try {
    return await fn();
  } finally {
    loop.stop();
  }
}

// ---------------------------------------------------------------------------
// Fire-and-forget helper for long-running goal ops
// ---------------------------------------------------------------------------

/**
 * Run a long-running goal operation (approve, plan, answer, edit) in the
 * background without blocking the Grammy middleware slot.
 * Sends an immediate ack, manages typing loop, and delivers results.
 */
export function runGoalInBackground(params: {
  bot: Bot;
  chatId: number;
  threadId?: number;
  runtime: RuntimeEnv;
  label?: string;
  preface?: string;
  replyToMessageId?: number;
  /** When set, called in `finally` to release per-runId file lock. */
  releaseGoalLock?: () => void;
  fn: () => Promise<GoalPlanResult | string | undefined>;
  onResult: (result: GoalPlanResult | string | undefined) => Promise<void>;
}): void {
  const { bot, chatId, threadId, runtime, label, fn, onResult } = params;
  const threadParams = threadId != null ? { message_thread_id: threadId } : {};
  const replyParams =
    params.replyToMessageId != null
      ? { reply_parameters: { message_id: params.replyToMessageId } }
      : {};
  const tag = label ? `${label} ` : "";
  const preface = params.preface ?? PLANNING_PREFACE;

  // Immediate ack
  void bot.api
    .sendMessage(chatId, preface, { ...threadParams, ...replyParams })
    .catch((err: unknown) => {
      logTyping(
        `${tag}preface error chatId=${chatId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

  const loop = startTypingLoop({ bot, chatId, threadId, label });
  void (async () => {
    try {
      const result = await fn();
      try {
        await onResult(result);
      } catch (onResultErr) {
        warn(
          `[goal] ${tag}onResult failed chatId=${chatId}: ${onResultErr instanceof Error ? onResultErr.message : String(onResultErr)}`,
        );
        const fallback =
          typeof result === "string" ? result : (result?.text ?? "Goal operation completed.");
        const truncated =
          fallback.length > 4000 ? `${fallback.slice(0, 3900)}\n\n(truncated)` : fallback;
        await bot.api
          .sendMessage(chatId, truncated, { ...threadParams, ...replyParams })
          .catch(() => {});
      }
    } catch (err) {
      warn(
        `[goal] ${tag}fn failed chatId=${chatId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      const msg = formatGoalError(err);
      await sendGoalReply(bot, chatId, msg, runtime, threadId, params.replyToMessageId).catch(
        () => {
          void bot.api
            .sendMessage(chatId, `Error: ${err instanceof Error ? err.message : String(err)}`, {
              ...threadParams,
              ...replyParams,
            })
            .catch(() => {});
        },
      );
    } finally {
      loop.stop();
      params.releaseGoalLock?.();
    }
  })();
}

// ---------------------------------------------------------------------------
// Lookup helper: find a run by its Telegram plan message ID (indexed)
// ---------------------------------------------------------------------------

export function findRunByPlanMessageId(
  chatId: number,
  messageId: number,
): SerializedRun | undefined {
  return findRunByPlanMessageIdIndexed(chatId, messageId);
}

// ---------------------------------------------------------------------------
// Handler functions (exported for testing)
// ---------------------------------------------------------------------------

/** /goal <text> -- generate a plan (planOnly mode). */
export async function handleGoal(text: string, config?: MoltbotConfig): Promise<GoalPlanResult> {
  if (!text.trim()) {
    return { text: "Usage: /new_goal <description of what you want to achieve>" };
  }

  const cap = createCaptureRuntime();
  const crypto = await import("node:crypto");
  const runId = crypto.randomUUID();

  try {
    const outcome = await goalCommand(
      {
        goal: text.trim(),
        planOnly: true,
        runId,
        diagram: "none",
        config,
      },
      cap.runtime,
    );

    const logs = cap.getLogs();
    const errors = cap.getErrors();
    const parts: string[] = [];

    if (logs) parts.push(logs);
    if (errors) parts.push(errors);

    const latestRun = loadRun(runId);
    if (outcome?.status === "cancelled" || latestRun?.state === "cancelled") {
      return { text: "Goal was stopped.", runId };
    }

    if (outcome?.status === "blocked") {
      parts.push(`\nAnswer: /goal_answer ${runId.slice(0, 8)} <your answer>`);
      return { text: parts.join("\n") || "More information needed.", runId, blocked: true };
    }

    // Successful plan — load run for PNG rendering in sendGoalPlanResult
    let run = latestRun;
    let autocheckDisplay: PlanAutocheckDisplayInfo | undefined;
    let autocheckSkipped = false;
    if (run?.plan) {
      try {
        const autocheckResult = await runGoalPlanAutocheck({
          runId,
          run,
          plan: run.plan,
          config,
          existingSessionId: undefined,
          existingBackend: undefined,
        });
        if (autocheckResult) {
          run = autocheckResult.run;
          autocheckDisplay = autocheckResult.display;
        }
      } catch (autocheckErr) {
        warn(
          `[goal] autocheck failed for run ${runId.slice(0, 8)}: ${autocheckErr instanceof Error ? autocheckErr.message : String(autocheckErr)}`,
        );
        autocheckSkipped = true;
        // Re-load the run in case autocheck partially modified it
        run = loadRun(runId) ?? run;
      }
    }
    if (run?.scoutStatus === "skipped") {
      parts.push(
        `\n_Scout analysis was skipped (${run.scoutSkipReason ?? "unknown"}). Plan may be less informed._`,
      );
    }
    if (run?.plan) {
      run = markRunAwaitingApproval(run) ?? run;
    }
    parts.push(`\nRun ID: \`${runId.slice(0, 8)}\``);

    return {
      text: parts.join("\n") || "No plan output.",
      runId,
      revision: run?.planRevision ?? 1,
      plan: run?.plan ?? undefined,
      stepResults: serializedStepResultsToMap(run),
      autocheckRounds: autocheckDisplay?.rounds,
      autocheckMaxRounds: autocheckDisplay?.maxRounds,
      autocheckExhausted: autocheckDisplay?.exhausted,
      autocheckSkipped: autocheckSkipped || undefined,
    };
  } catch (err) {
    if (err instanceof RuntimeExitError || err instanceof JsonExitError) {
      const logs = cap.getLogs();
      const errors = cap.getErrors();
      return { text: errors || logs || "Goal command failed." };
    }
    return { text: formatGoalError(err, runId) };
  }
}

/** /goal_approve <runId> -- approve and execute a plan (idempotent). */
export async function handleGoalApprove(
  rawId: string,
  onStatusChange?: (event: GoalStatusChangeEvent) => void | Promise<void>,
  config?: MoltbotConfig,
): Promise<string | GoalPlanResult | undefined> {
  if (!rawId.trim()) {
    return "Usage: /goal_approve <runId>";
  }

  const resolvedId = resolveRunId(rawId.trim());
  if (!resolvedId) return `Run not found: ${rawId.trim()}`;

  // Idempotent state check
  const run = loadRun(resolvedId);
  if (!run) return `Run file missing: ${resolvedId}`;
  if (run.state === "done") {
    return "Run is already complete.";
  }

  const prefix = resolvedId.slice(0, 8);
  const stepCount = run.plan?.steps?.length ?? 0;
  const cap = createCaptureRuntime();
  const trackedStatus = trackBlockedStatusChange(onStatusChange);
  try {
    const outcome = await goalResumeCommand(
      resolvedId,
      {
        yes: true,
        quiet: true,
        config,
        onStatusChange: trackedStatus.onStatusChange,
      },
      cap.runtime,
    );

    const errors = cap.getErrors();
    if (errors) return errors;

    // Pre-execution blocks (e.g. git errors) fire before onStatusChange
    // has a chance to notify — only suppress when fully_blocked was already emitted.
    if (outcome?.status === "blocked") {
      if (trackedStatus.didSendFullyBlocked()) return undefined;
      return `Run blocked: ${outcome.question ?? "Unknown reason"}`;
    }

    if (outcome?.status === "cancelled") {
      return "Run cancelled.";
    }

    // When onStatusChange is wired, it already sent DAG PNGs for done/step events —
    // return undefined so callers don't send a stray message after the notifications.
    if (trackedStatus.onStatusChange && outcome?.status === "done") return undefined;

    return `Executing: ${prefix} (0/${stepCount}). I'll notify you if input is needed.`;
  } catch (err) {
    if (err instanceof RuntimeExitError || err instanceof JsonExitError) {
      const errors = cap.getErrors();
      return errors || "Approve command failed.";
    }
    return formatGoalError(err, resolvedId);
  }
}

/** /goal_reject <runId> -- reject a pending plan (idempotent). */
export async function handleGoalReject(rawId: string): Promise<string> {
  if (!rawId.trim()) {
    return "Usage: /goal_reject <runId>";
  }

  const resolvedId = resolveRunId(rawId.trim());
  if (!resolvedId) return `Run not found: ${rawId.trim()}`;

  const run = loadRun(resolvedId);
  if (!run) return `Run file missing: ${resolvedId}`;

  // Idempotent: already cancelled is a no-op
  if (run.state === "cancelled") {
    return "Run is already cancelled.";
  }
  if (run.state !== "awaiting_approval") {
    return `Cannot reject: run is in "${run.state}" state.`;
  }

  run.state = "cancelled";
  run.updatedAt = new Date().toISOString();
  saveRun(run);

  return `Plan rejected (run ${resolvedId.slice(0, 8)}).`;
}

/** /goal_status <runId> -- show run details. */
export async function handleGoalStatus(rawId: string): Promise<string> {
  if (!rawId.trim()) {
    return "Usage: /goal_status <runId>";
  }

  const cap = createCaptureRuntime();
  try {
    await goalStatusCommand(rawId.trim(), { diagram: "none", channel: "telegram" }, cap.runtime);
    const logs = cap.getLogs();
    const errors = cap.getErrors();
    return errors || logs || "No status output.";
  } catch (err) {
    if (err instanceof RuntimeExitError || err instanceof JsonExitError) {
      return cap.getErrors() || cap.getLogs() || "Status command failed.";
    }
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** /goal_detail <runId> -- show detailed run info and all steps. */
export async function handleGoalDetail(rawId: string): Promise<string> {
  const trimmedId = rawId.trim();
  if (!trimmedId) {
    return "Usage: /goal_detail <runId>";
  }

  const resolvedId = resolveRunId(trimmedId);
  const cap = createCaptureRuntime();
  try {
    await goalDetailCommand(trimmedId, { diagram: "none", channel: "telegram" }, cap.runtime);
    const logs = cap.getLogs();
    const errors = cap.getErrors();
    if (errors) return errors;

    const run = resolvedId ? loadRun(resolvedId) : undefined;
    const base = logs || "No detail output.";
    const taskDetails = run?.plan ? formatTaskDetailSections(run.plan) : "";
    return taskDetails ? `${base}\n${taskDetails}` : base;
  } catch (err) {
    if (err instanceof RuntimeExitError || err instanceof JsonExitError) {
      return cap.getErrors() || cap.getLogs() || "Detail command failed.";
    }
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Send `/goal_status` reply text and attach DAG PNG when the run has a plan. */
export async function sendGoalStatusResponse(params: {
  bot: Bot;
  chatId: number;
  runtime: RuntimeEnv;
  rawId: string;
  threadId?: number;
  replyToMessageId?: number;
}): Promise<void> {
  const { bot, chatId, runtime, rawId, threadId, replyToMessageId } = params;
  const reply = await handleGoalStatus(rawId);
  const resolvedId = rawId.trim() ? resolveRunId(rawId.trim()) : undefined;
  const run = resolvedId ? loadRun(resolvedId) : undefined;
  if (run?.plan && resolvedId) {
    if (run.state === "blocked" && run.blocked) {
      const blockedMessageId = await sendBlockedNotification({
        bot,
        chatId,
        threadId,
        runtime,
        runId: resolvedId,
        plan: run.plan,
        steps: run.plan.steps,
        stepResults: serializedStepResultsToMap(run),
        blockedDetail: run.blocked,
        replyToMessageId,
      });
      if (blockedMessageId != null) return;
    } else {
      const pngId = await sendDagPng({
        bot,
        chatId,
        threadId,
        runtime,
        runId: resolvedId,
        plan: run.plan,
        steps: run.plan.steps,
        stepResults: serializedStepResultsToMap(run),
        caption: reply,
        replyToMessageId,
      });
      if (pngId != null) return;
    }
  }
  await sendGoalReply(bot, chatId, reply, runtime, threadId, replyToMessageId);
}

/** Send `/goal_detail` reply text and attach DAG PNG when the run has a plan. */
export async function sendGoalDetailResponse(params: {
  bot: Bot;
  chatId: number;
  runtime: RuntimeEnv;
  rawId: string;
  threadId?: number;
  replyToMessageId?: number;
}): Promise<void> {
  const { bot, chatId, runtime, rawId, threadId, replyToMessageId } = params;
  const reply = await handleGoalDetail(rawId);
  const resolvedId = rawId.trim() ? resolveRunId(rawId.trim()) : undefined;
  const run = resolvedId ? loadRun(resolvedId) : undefined;
  if (run?.plan) {
    const pngId = await sendDagPng({
      bot,
      chatId,
      threadId,
      runtime,
      runId: resolvedId,
      plan: run.plan,
      steps: run.plan.steps,
      stepResults: serializedStepResultsToMap(run),
      caption: reply,
      replyToMessageId,
    });
    if (pngId != null) return;
  }
  await sendGoalReply(bot, chatId, reply, runtime, threadId, replyToMessageId);
}

/** /goal_answer <runId> <value> -- answer a blocked goal's question. */
export async function handleGoalAnswer(
  rawId: string,
  value: string,
  onStatusChange?: (event: GoalStatusChangeEvent) => void | Promise<void>,
  config?: MoltbotConfig,
): Promise<GoalPlanResult | string | undefined> {
  if (!rawId.trim() || !value) {
    return "Usage: /goal_answer <runId> <value>";
  }

  const resolvedId = resolveRunId(rawId.trim());
  if (!resolvedId) return `Run not found: ${rawId.trim()}`;

  const run = loadRun(resolvedId);
  if (!run) return `Run file missing: ${resolvedId}`;

  // "executing" state means process crashed mid-execution - resume directly without needing an answer
  if (run.state === "executing") {
    const prefix = resolvedId.slice(0, 8);
    const cap = createCaptureRuntime();
    const trackedStatus = trackBlockedStatusChange(onStatusChange);
    try {
      const outcome = await goalResumeCommand(
        resolvedId,
        {
          yes: true,
          quiet: true,
          config,
          onStatusChange: trackedStatus.onStatusChange,
        },
        cap.runtime,
      );

      const errors = cap.getErrors();
      if (errors) return errors;

      if (outcome?.status === "blocked") {
        if (trackedStatus.didSendFullyBlocked()) return undefined;
        return `Run blocked: ${outcome.question}`;
      }

      // onStatusChange already sent notifications for done/step-level events
      if (trackedStatus.onStatusChange) return undefined;

      return `Resuming interrupted run: ${prefix}...`;
    } catch (err) {
      if (err instanceof RuntimeExitError || err instanceof JsonExitError) {
        return cap.getErrors() || "Resume command failed.";
      }
      return formatGoalError(err, resolvedId);
    }
  }

  if (run.state !== "blocked") {
    const normalizedValue = value.trim().toLowerCase();
    // Defensive fallback: some Telegram resume flows can end up on /goal_answer.
    // If the user sent "resume", treat it as an explicit resume request.
    if (
      normalizedValue === "resume" &&
      (run.state === "awaiting_approval" || run.state === "cancelled")
    ) {
      return handleGoalApprove(resolvedId, onStatusChange, config);
    }
    const suffix = run.lastError ? ` Last error: ${run.lastError}` : "";
    return `Run is not awaiting input (state: ${run.state}).${suffix}`;
  }
  if (!run.blocked) {
    return `Run is in "${run.state}" but has no blocked details.`;
  }

  const blockedAt = run.blocked.blockedAt ?? "execution";

  if (blockedAt === "planning") {
    const key = run.blocked.requiredInputKey;
    const prefix = resolvedId.slice(0, 8);
    const cap = createCaptureRuntime();
    try {
      await goalAnswerCommand(resolvedId, { key, value, quiet: true, config }, cap.runtime);

      const answerErrors = cap.getErrors();
      if (answerErrors) return answerErrors;

      const outcome = await goalResumeCommand(resolvedId, { quiet: true, config }, cap.runtime);
      const errors = cap.getErrors();
      if (errors) return errors;

      if (outcome?.status === "blocked") {
        return {
          text: `Still need more info:\n\n${outcome.question}\n\nAnswer: /goal_answer ${prefix} <your answer>`,
          runId: resolvedId,
          blocked: true,
        };
      }

      const updated = loadRun(resolvedId);
      const plan = updated?.plan;
      if (plan) {
        const stepResults = serializedStepResultsToMap(updated);
        const planText = formatPlanOutput(plan, {
          diagram: "none",
          format: "md",
          stepResults,
        });
        const parts: string[] = [planText, `\nRun ID: \`${prefix}\``];
        return {
          text: parts.join("\n"),
          runId: resolvedId,
          revision: updated?.planRevision ?? 1,
          plan,
          stepResults,
        };
      }

      return `Replanned: ${prefix}. Use /goal_approve ${prefix} to execute.`;
    } catch (err) {
      if (err instanceof RuntimeExitError || err instanceof JsonExitError) {
        return cap.getErrors() || "Answer command failed.";
      }
      return formatGoalError(err, resolvedId);
    }
  }

  // blocked (execution-time): save answer and auto-resume execution
  const key = run.blocked.requiredInputKey;
  const prefix = resolvedId.slice(0, 8);
  const cap = createCaptureRuntime();
  const trackedStatus = trackBlockedStatusChange(onStatusChange);
  try {
    const outcome = await goalAnswerCommand(
      resolvedId,
      { key, value, quiet: true, config, onStatusChange: trackedStatus.onStatusChange },
      cap.runtime,
    );

    const errors = cap.getErrors();
    if (errors) return errors;

    if (outcome?.status === "blocked") {
      if (trackedStatus.didSendFullyBlocked()) return undefined;
      return `Still blocked: ${outcome.question}\n\nAnswer: /goal_answer ${prefix} <your answer>`;
    }

    // When onStatusChange is wired, it already sent DAG PNGs for done/step-level events —
    // return undefined so callers don't send a stray message after the notifications.
    if (trackedStatus.onStatusChange) return undefined;

    return `Resuming: ${prefix}...`;
  } catch (err) {
    if (err instanceof RuntimeExitError || err instanceof JsonExitError) {
      return cap.getErrors() || "Answer command failed.";
    }
    return formatGoalError(err, resolvedId);
  }
}

/** /goal_feedback <runId> <feedback> -- incorporate feedback from manual tests. */
export async function handleGoalFeedback(
  rawId: string,
  feedbackText: string,
  config?: MoltbotConfig,
  onStatusChange?: (event: GoalStatusChangeEvent) => void | Promise<void>,
): Promise<string | GoalPlanResult | undefined> {
  if (!rawId.trim() || !feedbackText.trim()) {
    return "Usage: /goal_feedback <runId> <feedback>";
  }

  const resolvedId = resolveRunId(rawId.trim());
  if (!resolvedId) return `Run not found: ${rawId.trim()}`;

  const run = loadRun(resolvedId);
  if (!run) return `Run file missing: ${resolvedId}`;
  if (run.state !== "done") {
    return `Cannot incorporate feedback: run is in "${run.state}" state (expected "done").`;
  }
  if (!run.plan) {
    return "Run has no plan to revise.";
  }

  const prefix = resolvedId.slice(0, 8);
  const trimmedFeedback = feedbackText.trim();
  const currentPlan = run.plan;
  const revisionInstructions = buildFeedbackRevisionInstructions(trimmedFeedback);
  const preferredAuthMode = config?.goal?.claudeCodeAuth ?? "subscription";
  let resumeCapture: ReturnType<typeof createCaptureRuntime> | undefined;

  try {
    const authModesToTry =
      preferredAuthMode === "api_key"
        ? (["api_key", "subscription"] as const)
        : [preferredAuthMode];
    let revisionResult: Awaited<ReturnType<typeof runCliPlanRevision>> | undefined;

    for (const authMode of authModesToTry) {
      try {
        revisionResult = await runCliPlanRevision({
          runId: resolvedId,
          goalText: run.goal,
          currentPlan,
          editInstructions: revisionInstructions,
          cwd: run.workingDir,
          model: run.model,
          claudeCodeAuth: authMode,
          ...(config?.goal?.enabledWorkers ? { enabledWorkers: config.goal.enabledWorkers } : {}),
        });
        break;
      } catch (err) {
        const errText = err instanceof Error ? err.message : String(err);
        const shouldRetryWithSubscription =
          authMode === "api_key" && authModesToTry.length > 1 && AUTH_RE.test(errText);
        if (!shouldRetryWithSubscription) throw err;
        warn(
          `[goal] feedback revision auth failed for ${prefix} in api_key mode; retrying with subscription auth`,
        );
      }
    }
    if (!revisionResult) {
      throw new Error("Plan revision failed for unknown reason.");
    }

    if (revisionResult.plannerBackendUsed) {
      run.plannerBackendUsed = revisionResult.plannerBackendUsed;
    } else {
      delete run.plannerBackendUsed;
    }
    if (revisionResult.plannerDegradedReason) {
      run.plannerDegradedReason = revisionResult.plannerDegradedReason;
    } else {
      delete run.plannerDegradedReason;
    }
    if (revisionResult.plannerDegradedResetHint) {
      run.plannerDegradedResetHint = revisionResult.plannerDegradedResetHint;
    } else {
      delete run.plannerDegradedResetHint;
    }

    if ("blocked" in revisionResult.plan) {
      run.updatedAt = new Date().toISOString();
      saveRun(run);
      return `Feedback replan blocked: ${revisionResult.plan.question}`;
    }

    const mergedPlan = mergeRevisedPlanWithDoneSteps({
      originalPlan: currentPlan,
      revisedPlan: revisionResult.plan,
    });

    const revisionNumber = commitPlanRevision({
      run,
      revisedPlan: mergedPlan,
      editInstructions: `Incorporate feedback: ${trimmedFeedback}`,
      source: "user",
      previousPlan: currentPlan,
    });
    if (run.workingDir !== currentPlan.workingDir) {
      ensureWorkingDir(run.workingDir);
    }
    run.blocked = null;
    run.lastError = undefined;
    run.state = "executing";
    delete run.manualTests;
    delete run.manualTestsError;
    run.updatedAt = new Date().toISOString();
    saveRun(run);

    if (onStatusChange) {
      await onStatusChange({
        type: "plan_revised",
        revision: revisionNumber,
        summary: `Feedback incorporated for ${prefix}. Auto-executing new fix steps.`,
        steps: [...mergedPlan.steps],
      });
    }

    const pendingSteps = mergedPlan.steps.filter(
      (step) => step.status === "pending" || step.status === "blocked",
    );
    if (pendingSteps.length === 0) {
      try {
        run.manualTests = await generateManualTests({
          goal: run.goal,
          steps: mergedPlan.steps,
          runDir: resolveRunDir(run.runId),
        });
        delete run.manualTestsError;
      } catch (err) {
        delete run.manualTests;
        run.manualTestsError = err instanceof Error ? err.message : String(err);
      }
      run.state = "done";
      run.updatedAt = new Date().toISOString();
      saveRun(run);

      const summary = buildDoneSummaryWithManualTests(run);
      if (onStatusChange) {
        await onStatusChange({
          type: "all_done",
          steps: [...mergedPlan.steps],
          summary,
          ...(run.manualTests !== undefined ? { manualTests: run.manualTests } : {}),
          ...(run.manualTestsError ? { manualTestsError: run.manualTestsError } : {}),
        });
        return undefined;
      }

      return `No new execution steps were required for ${prefix}.`;
    }

    const cap = createCaptureRuntime();
    resumeCapture = cap;
    const trackedStatus = trackBlockedStatusChange(onStatusChange);
    let transientRunLock: Extract<GoalOpLockResult, { acquired: true }> | undefined;
    if (!isGoalOpLocked(resolvedId).locked) {
      const lock = acquireGoalOpLock(resolvedId, "feedback");
      if (lock.acquired) transientRunLock = lock;
    }
    let outcome: Awaited<ReturnType<typeof goalResumeCommand>>;
    try {
      outcome = await goalResumeCommand(
        resolvedId,
        {
          yes: true,
          quiet: true,
          config,
          allowDoneStateResume: true,
          onStatusChange: trackedStatus.onStatusChange,
        },
        cap.runtime,
      );
    } finally {
      transientRunLock?.release();
    }

    const errors = cap.getErrors();
    if (errors) return errors;

    if (outcome?.status === "blocked") {
      if (trackedStatus.didSendFullyBlocked()) return undefined;
      return `Run blocked: ${outcome.question ?? "Unknown reason"}`;
    }
    if (outcome?.status === "cancelled") {
      return "Run cancelled.";
    }
    if (trackedStatus.onStatusChange && outcome?.status === "done") {
      return undefined;
    }

    return `Incorporating feedback: ${prefix} (${pendingSteps.length} step(s)).`;
  } catch (err) {
    if (err instanceof RuntimeExitError || err instanceof JsonExitError) {
      return resumeCapture?.getErrors() || "Feedback command failed.";
    }
    if (err instanceof PlanParseError) {
      persistRawPlanResponse(resolvedId, err.rawResponse);
    }
    return formatGoalError(err, resolvedId);
  }
}

/** /goal_stop <runId> -- stop a running goal execution. */
export async function handleGoalStop(rawId: string, force?: boolean): Promise<string> {
  if (!rawId.trim()) {
    return "Usage: /goal_stop <runId>";
  }

  const resolvedId = resolveRunId(rawId.trim());
  const cap = createCaptureRuntime();
  try {
    const { goalStopCommand } = await import("../commands/goal-stop.js");
    await goalStopCommand(rawId.trim(), { force: Boolean(force) }, cap.runtime);
    // Release the file lock so /goal_resume can re-acquire it.
    // The background fn() promise may still be hanging (awaiting the killed worker),
    // so the normal finally-based release in runGoalInBackground won't fire.
    if (resolvedId) forceReleaseGoalOpLock(resolvedId);
    const logs = cap.getLogs();
    const errors = cap.getErrors();
    return errors || logs || "Goal stopped.";
  } catch (err) {
    if (err instanceof RuntimeExitError || err instanceof JsonExitError) {
      return cap.getErrors() || cap.getLogs() || "Stop command failed.";
    }
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** /goal_edit <runId> <instructions> -- revise a plan via LLM re-planning. */
export async function handleGoalEdit(
  rawId: string,
  instructions: string,
  config?: MoltbotConfig,
): Promise<GoalPlanResult> {
  if (!rawId.trim() || !instructions.trim()) {
    return { text: "Usage: /goal_edit <runId> <edit instructions>" };
  }

  const resolvedId = resolveRunId(rawId.trim());
  if (!resolvedId) return { text: `Run not found: ${rawId.trim()}` };

  let run = loadRun(resolvedId);
  if (!run) return { text: `Run file missing: ${resolvedId}` };

  if (run.state !== "awaiting_approval") {
    return { text: `Cannot edit: run is in "${run.state}" state (expected "awaiting_approval").` };
  }
  if (!run.plan) {
    return { text: "Run has no plan to edit." };
  }
  const originalWorkingDir = run.workingDir;
  const trimmedInstructions = instructions.trim();
  const workingDirHint = parseWorkingDirInstruction(trimmedInstructions, run.workingDir);
  if (workingDirHint && !workingDirHint.resolvedPath) {
    return {
      text:
        `Could not resolve working directory: "${workingDirHint.requestedPath}". ` +
        "Please provide an absolute path, ~/path, or an existing relative directory.",
    };
  }
  const nextWorkingDir = workingDirHint?.resolvedPath;
  if (nextWorkingDir && nextWorkingDir !== run.workingDir) {
    ensureWorkingDir(nextWorkingDir);
    run.workingDir = nextWorkingDir;
    run.updatedAt = new Date().toISOString();
    saveRun(run);
  }
  const authMode = config?.goal?.claudeCodeAuth ?? "subscription";

  try {
    const revisionResult = await runCliPlanRevision({
      runId: resolvedId,
      goalText: run.goal,
      currentPlan: run.plan,
      editInstructions: trimmedInstructions,
      cwd: run.workingDir,
      model: run.model,
      claudeCodeAuth: authMode,
      ...(config?.goal?.enabledWorkers ? { enabledWorkers: config.goal.enabledWorkers } : {}),
    });
    const result = revisionResult.plan;
    const plannerFallbackNotice = revisionResult.plannerDegradedReason
      ? formatPlannerFallbackNotice({
          degradedReason: revisionResult.plannerDegradedReason,
          resetHint: revisionResult.plannerDegradedResetHint,
        })
      : undefined;
    if (revisionResult.plannerBackendUsed) {
      run.plannerBackendUsed = revisionResult.plannerBackendUsed;
    } else {
      delete run.plannerBackendUsed;
    }
    if (revisionResult.plannerDegradedReason) {
      run.plannerDegradedReason = revisionResult.plannerDegradedReason;
    } else {
      delete run.plannerDegradedReason;
    }
    if (revisionResult.plannerDegradedResetHint) {
      run.plannerDegradedResetHint = revisionResult.plannerDegradedResetHint;
    } else {
      delete run.plannerDegradedResetHint;
    }

    if ("blocked" in result) {
      run.updatedAt = new Date().toISOString();
      saveRun(run);
      const lines: string[] = [];
      if (run.workingDir !== originalWorkingDir) {
        lines.push(`Working dir updated: ${shortenHomePath(run.workingDir)}`);
      }
      if (plannerFallbackNotice) {
        lines.push(plannerFallbackNotice);
      }
      lines.push(`Revision blocked: ${result.question}`);
      return { text: lines.join("\n"), blocked: true };
    }

    const workingDirBeforeRevision = run.workingDir;
    const newRevision = commitPlanRevision({
      run,
      revisedPlan: result,
      editInstructions: trimmedInstructions,
      source: "user",
      previousPlan: run.plan,
    });
    if (run.workingDir !== workingDirBeforeRevision) {
      ensureWorkingDir(run.workingDir);
    }
    run.state = "planning";
    run.updatedAt = new Date().toISOString();
    saveRun(run);

    let finalPlan = result;
    let autocheckDisplay: PlanAutocheckDisplayInfo | undefined;
    let autocheckSkipped = false;
    try {
      const autocheckResult = await runGoalPlanAutocheck({
        runId: resolvedId,
        run,
        plan: finalPlan,
        config,
        existingSessionId: run.autocheckSessionId,
        existingBackend: run.autocheckBackend,
      });
      if (autocheckResult) {
        run = autocheckResult.run;
        finalPlan = autocheckResult.plan;
        autocheckDisplay = autocheckResult.display;
      }
    } catch (autocheckErr) {
      warn(
        `[goal] autocheck failed for run ${resolvedId.slice(0, 8)}: ${autocheckErr instanceof Error ? autocheckErr.message : String(autocheckErr)}`,
      );
      autocheckSkipped = true;
      // Re-load the run in case autocheck partially modified it
      run = loadRun(resolvedId) ?? run;
    }
    run = markRunAwaitingApproval(run) ?? run;

    const finalRevision = run.planRevision ?? newRevision;
    const stepResults = serializedStepResultsToMap(run);
    const planText = formatPlanOutput(finalPlan, {
      diagram: "none",
      format: "md",
      stepResults,
    });
    const parts: string[] = [];
    parts.push(`**Revision ${finalRevision}**\n`);
    if (run.workingDir !== originalWorkingDir) {
      parts.push(`Working dir: \`${shortenHomePath(run.workingDir)}\`\n`);
    }
    if (plannerFallbackNotice) {
      parts.push(`${plannerFallbackNotice}\n`);
    }
    parts.push(planText);
    parts.push(`\nRun ID: \`${resolvedId.slice(0, 8)}\``);

    return {
      text: parts.join("\n"),
      runId: resolvedId,
      revision: finalRevision,
      plan: finalPlan,
      stepResults,
      autocheckRounds: autocheckDisplay?.rounds,
      autocheckMaxRounds: autocheckDisplay?.maxRounds,
      autocheckExhausted: autocheckDisplay?.exhausted,
      autocheckSkipped: autocheckSkipped || undefined,
    };
  } catch (err) {
    if (err instanceof PlanParseError) {
      persistRawPlanResponse(resolvedId, err.rawResponse);
    }
    return { text: formatGoalError(err, resolvedId) };
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

type TelegramGoalCommandContext = Context & { match?: string };

export type RegisterGoalCommandsParams = {
  bot: Bot;
  cfg: MoltbotConfig;
  runtime: RuntimeEnv;
  accountId: string;
  telegramCfg: TelegramAccountConfig;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  useAccessGroups: boolean;
  resolveGroupPolicy: (chatId: string | number) => ChannelGroupPolicy;
  resolveTelegramGroupConfig: (
    chatId: string | number,
    messageThreadId?: number,
  ) => { groupConfig?: TelegramGroupConfig; topicConfig?: TelegramTopicConfig };
  shouldSkipUpdate: (ctx: unknown) => boolean;
  textLimit: number;
  commandFragmentBuffer?: CommandFragmentBuffer;
};

const APPROVE_EMOJIS = new Set(["\u2764", "\u2764\uFE0F", "\uD83D\uDC4D"]);
const REJECT_EMOJIS = new Set(["\uD83D\uDC4E"]);

export function registerTelegramGoalCommands({
  bot,
  cfg,
  runtime,
  accountId,
  telegramCfg,
  allowFrom,
  groupAllowFrom,
  useAccessGroups,
  resolveGroupPolicy,
  resolveTelegramGroupConfig,
  shouldSkipUpdate,
  commandFragmentBuffer,
}: RegisterGoalCommandsParams): void {
  // Helper: authenticate and resolve thread context
  async function authAndResolve(ctx: TelegramGoalCommandContext) {
    const msg = ctx.message;
    if (!msg) return null;
    if (shouldSkipUpdate(ctx)) return null;

    const auth = await resolveTelegramCommandAuth({
      msg,
      bot,
      cfg,
      telegramCfg,
      allowFrom,
      groupAllowFrom,
      useAccessGroups,
      resolveGroupPolicy,
      resolveTelegramGroupConfig,
      requireAuth: true,
    });
    if (!auth) return null;

    const messageThreadId = (msg as { message_thread_id?: number }).message_thread_id;
    const threadIdForSend = auth.isGroup ? auth.resolvedThreadId : messageThreadId;

    return { chatId: auth.chatId, threadIdForSend };
  }

  /** Send a GoalPlanResult: plan message with keyboard or plain reply. */
  async function sendPlanResult(
    chatId: number,
    result: GoalPlanResult,
    threadId?: number,
    replyToMessageId?: number,
  ): Promise<void> {
    await sendGoalPlanResult({ bot, chatId, runtime, result, threadId, replyToMessageId });
  }

  async function startGoalResume(params: {
    rawId: string;
    chatId: number;
    threadId?: number;
    replyToMessageId?: number;
    lockLabel: "approve" | "resume";
    backgroundLabel: string;
  }): Promise<void> {
    const { rawId, chatId, threadId, replyToMessageId, lockLabel, backgroundLabel } = params;
    const resolvedId = resolveRunId(rawId);
    if (!resolvedId) {
      await sendGoalReply(
        bot,
        chatId,
        `Run not found: ${rawId}`,
        runtime,
        threadId,
        replyToMessageId,
      );
      return;
    }
    const lockResult = acquireGoalOpLock(resolvedId, lockLabel);
    if (!lockResult.acquired) {
      await sendGoalReply(
        bot,
        chatId,
        formatGoalLockedMessage(resolvedId, lockResult.existingLabel),
        runtime,
        threadId,
        replyToMessageId,
      );
      return;
    }
    const run = loadRun(resolvedId);
    if (!run) {
      lockResult.release();
      await sendGoalReply(
        bot,
        chatId,
        `Run file missing: ${resolvedId}`,
        runtime,
        threadId,
        replyToMessageId,
      );
      return;
    }
    const statusCb = buildOnStatusChange({ bot, chatId, threadId, runtime, runId: resolvedId });
    runGoalInBackground({
      bot,
      chatId,
      threadId,
      runtime,
      label: backgroundLabel,
      preface: getGoalExecutionPreface(run.state),
      replyToMessageId,
      releaseGoalLock: lockResult.release,
      fn: () => handleGoalApprove(rawId, statusCb, cfg),
      onResult: async (reply) =>
        sendGoalBackgroundResult({ bot, chatId, runtime, threadId, replyToMessageId }, reply),
    });
  }

  // -----------------------------------------------------------------------
  // Callback query handler for inline buttons (plan approve/reject/edit)
  // -----------------------------------------------------------------------
  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;

    // --- Plan buttons: ga/gD/gr/ge:<runIdPrefix>:<revision> ---
    const planMatch = /^(ga|gD|gr|ge):([a-f0-9-]+):(\d+)$/.exec(data);
    if (planMatch) {
      await bot.api.answerCallbackQuery(ctx.callbackQuery.id).catch((err) => {
        runtime.error?.(
          `[goal-callback] failed to answer plan callback query: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
      const [, action, runIdPrefix] = planMatch;
      const chatId = ctx.callbackQuery.message?.chat.id;
      if (!chatId) return;
      const messageId = ctx.callbackQuery.message?.message_id;
      const threadId = (ctx.callbackQuery.message as { message_thread_id?: number } | undefined)
        ?.message_thread_id;

      // React with the corresponding emoji on the plan message.
      if (messageId) {
        const emoji: ReactionTypeEmoji["emoji"] =
          action === "ga"
            ? "\u2764" // ❤ for approve
            : action === "gD"
              ? "\uD83D\uDC40" // 👀 for detail
              : action === "gr"
                ? "\uD83D\uDC4E" // 👎 for reject
                : "\u270D"; // ✍ for edit
        await bot.api
          .setMessageReaction(chatId, messageId, [{ type: "emoji", emoji }])
          .catch((err) => {
            runtime.error?.(
              `[goal-callback] failed to set plan reaction: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
      }

      if (action === "ge") {
        const threadParams = threadId != null ? { message_thread_id: threadId } : {};
        // Reply to the plan message so users see which plan to edit;
        // also use ForceReply to open the reply UI pre-filled.
        const replyParams = messageId ? { reply_parameters: { message_id: messageId } } : {};
        const sent = await bot.api
          .sendMessage(chatId, "Reply to the plan message with your change request.", {
            ...threadParams,
            ...replyParams,
            reply_markup: {
              force_reply: true,
              input_field_placeholder: "Describe your changes...",
            },
          })
          .catch(async (err) => {
            runtime.error?.(
              `[goal-callback] failed to send edit prompt: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            await sendGoalReply(
              bot,
              chatId,
              "Could not open the edit reply prompt. Use /goal_edit RUN_ID CHANGE_REQUEST.",
              runtime,
              threadId,
              messageId,
            );
            return undefined;
          });
        // Track the prompt message so the router can map replies back to GOAL_EDIT
        if (sent?.message_id && runIdPrefix) {
          const resolvedId = resolveRunId(runIdPrefix);
          if (resolvedId) {
            persistEditPromptMessage({
              runId: resolvedId,
              chatId,
              messageId: sent.message_id,
              threadId,
            });
          }
        }
        return;
      }

      const resolvedId = resolveRunId(runIdPrefix!);
      if (!resolvedId) {
        await sendGoalReply(
          bot,
          chatId,
          `Run not found: ${runIdPrefix}`,
          runtime,
          threadId,
          messageId,
        );
        return;
      }

      if (action === "ga") {
        await startGoalResume({
          rawId: resolvedId,
          chatId,
          threadId,
          replyToMessageId: messageId,
          lockLabel: "approve",
          backgroundLabel: "callback:approve",
        });
      } else if (action === "gD") {
        await sendGoalDetailResponse({
          bot,
          chatId,
          runtime,
          rawId: resolvedId,
          threadId,
          replyToMessageId: messageId,
        });
      } else if (action === "gr") {
        const reply = await handleGoalReject(resolvedId);
        await sendGoalReply(bot, chatId, reply, runtime, threadId, messageId);
      }
      return;
    }

    // --- Done buttons: gTD/gIF:<runIdPrefix> ---
    const doneMatch = /^(gTD|gIF):([a-f0-9-]+)$/.exec(data);
    if (doneMatch) {
      await bot.api.answerCallbackQuery(ctx.callbackQuery.id).catch((err) => {
        runtime.error?.(
          `[goal-callback] failed to answer done callback query: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
      const [, action, runIdPrefix] = doneMatch;
      const chatId = ctx.callbackQuery.message?.chat.id;
      if (!chatId) return;
      const messageId = ctx.callbackQuery.message?.message_id;
      const threadId = (ctx.callbackQuery.message as { message_thread_id?: number } | undefined)
        ?.message_thread_id;

      // React with the corresponding emoji on the done message.
      if (messageId) {
        const emoji: ReactionTypeEmoji["emoji"] = action === "gTD" ? "\uD83D\uDC40" : "\u270D";
        await bot.api
          .setMessageReaction(chatId, messageId, [{ type: "emoji", emoji }])
          .catch((err) => {
            runtime.error?.(
              `[goal-callback] failed to set done action reaction: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
      }

      const resolvedId = resolveRunId(runIdPrefix!);
      if (!resolvedId) {
        await sendGoalReply(
          bot,
          chatId,
          `Run not found: ${runIdPrefix}`,
          runtime,
          threadId,
          messageId,
        );
        return;
      }
      const run = loadRun(resolvedId);
      if (!run) {
        await sendGoalReply(
          bot,
          chatId,
          `Run file missing: ${resolvedId}`,
          runtime,
          threadId,
          messageId,
        );
        return;
      }

      if (action === "gTD") {
        const detailText = formatManualTestDetails(
          resolvedId.slice(0, 8),
          run.manualTests,
          run.manualTestsError,
        );
        await sendGoalReply(bot, chatId, detailText, runtime, threadId, messageId);
        return;
      }

      const threadParams = threadId != null ? { message_thread_id: threadId } : {};
      const replyToMessageId = messageId ?? run.telegramDoneMessage?.messageId;
      const replyParams = replyToMessageId
        ? { reply_parameters: { message_id: replyToMessageId } }
        : {};
      const sent = await bot.api
        .sendMessage(chatId, "Reply with feedback from your manual tests.", {
          ...threadParams,
          ...replyParams,
          reply_markup: {
            force_reply: true,
            input_field_placeholder: "Describe your feedback or what needs to change...",
          },
        })
        .catch(async (err) => {
          runtime.error?.(
            `[goal-callback] failed to send feedback prompt: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          await sendGoalReply(
            bot,
            chatId,
            "Could not open the feedback reply prompt. Use /goal_feedback RUN_ID FEEDBACK.",
            runtime,
            threadId,
            messageId,
          );
          return undefined;
        });
      if (sent?.message_id) {
        persistFeedbackPromptMessage({
          runId: resolvedId,
          chatId,
          messageId: sent.message_id,
          threadId,
        });
      }
      return;
    }

    // --- Blocked message detail button: gAD:<runIdPrefix> ---
    const blockedDetailsMatch = /^gAD:([a-f0-9-]+)$/.exec(data);
    if (blockedDetailsMatch) {
      await bot.api.answerCallbackQuery(ctx.callbackQuery.id).catch((err) => {
        runtime.error?.(
          `[goal-callback] failed to answer blocked detail callback query: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
      const [, runIdPrefix] = blockedDetailsMatch;
      const chatId = ctx.callbackQuery.message?.chat.id;
      if (!chatId) return;
      const messageId = ctx.callbackQuery.message?.message_id;
      const threadId = (ctx.callbackQuery.message as { message_thread_id?: number } | undefined)
        ?.message_thread_id;

      // React on the blocked details message to acknowledge Add Details.
      if (messageId) {
        const emoji: ReactionTypeEmoji["emoji"] = "\u270D";
        await bot.api
          .setMessageReaction(chatId, messageId, [{ type: "emoji", emoji }])
          .catch((err) => {
            runtime.error?.(
              `[goal-callback] failed to set blocked detail reaction: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
      }

      const resolvedId = resolveRunId(runIdPrefix!);
      if (!resolvedId) {
        await sendGoalReply(
          bot,
          chatId,
          `Run not found: ${runIdPrefix}`,
          runtime,
          threadId,
          messageId,
        );
        return;
      }

      const run = loadRun(resolvedId);
      if (!run) {
        await sendGoalReply(
          bot,
          chatId,
          `Run file missing: ${resolvedId}`,
          runtime,
          threadId,
          messageId,
        );
        return;
      }

      const threadParams = threadId != null ? { message_thread_id: threadId } : {};
      const replyParams = messageId ? { reply_parameters: { message_id: messageId } } : {};
      const sent = await bot.api
        .sendMessage(chatId, "Reply to the blocked message with unblocking details.", {
          ...threadParams,
          ...replyParams,
          reply_markup: {
            force_reply: true,
            input_field_placeholder: "Describe your answer...",
          },
        })
        .catch(async (err) => {
          runtime.error?.(
            `[goal-callback] failed to send blocked answer prompt: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          await sendGoalReply(
            bot,
            chatId,
            "Could not open the answer reply prompt. Use /goal_answer RUN_ID YOUR_ANSWER.",
            runtime,
            threadId,
            messageId,
          );
          return undefined;
        });
      if (sent?.message_id) {
        persistTelegramQuestionMessage({
          runId: resolvedId,
          chatId,
          messageId: sent.message_id,
          threadId,
          requiredInputKey: resolveBlockedRequiredInputKey(run),
        });
      }
      return;
    }

    // --- Blocked buttons: gResume/gStop:<runIdPrefix> ---
    const blockedMatch = /^(gResume|gStop):([a-f0-9-]+)$/.exec(data);
    if (blockedMatch) {
      await bot.api.answerCallbackQuery(ctx.callbackQuery.id).catch((err) => {
        runtime.error?.(
          `[goal-callback] failed to answer blocked action callback query: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
      const [, action, runIdPrefix] = blockedMatch;
      const chatId = ctx.callbackQuery.message?.chat.id;
      if (!chatId) return;
      const messageId = ctx.callbackQuery.message?.message_id;
      const threadId = (ctx.callbackQuery.message as { message_thread_id?: number } | undefined)
        ?.message_thread_id;

      const resolvedId = resolveRunId(runIdPrefix!);
      if (!resolvedId) {
        await sendGoalReply(
          bot,
          chatId,
          `Run not found: ${runIdPrefix}`,
          runtime,
          threadId,
          messageId,
        );
        return;
      }

      // React with the corresponding emoji on the blocked message
      // (Telegram restricts reactions to a fixed set; use closest match)
      if (messageId) {
        const emoji: ReactionTypeEmoji["emoji"] =
          action === "gResume" ? "\uD83D\uDC4D" : "\uD83D\uDC4E";
        await bot.api
          .setMessageReaction(chatId, messageId, [{ type: "emoji", emoji }])
          .catch((err) => {
            runtime.error?.(
              `[goal-callback] failed to set blocked action reaction: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
      }

      if (action === "gStop") {
        const reply = await handleGoalStop(resolvedId);
        await sendGoalReply(bot, chatId, reply, runtime, threadId, messageId);
      } else {
        await startGoalResume({
          rawId: resolvedId,
          chatId,
          threadId,
          replyToMessageId: messageId,
          lockLabel: "resume",
          backgroundLabel: "callback:resume",
        });
      }
      return;
    }

    await next?.();
  });

  // -----------------------------------------------------------------------
  // Reaction handler (best-effort; inline buttons + commands are primary)
  // -----------------------------------------------------------------------
  bot.on("message_reaction", async (ctx, next) => {
    type ReactionEntry = { type: string; emoji?: string };
    type ReactionUpdate = {
      chat: { id: number };
      message_id: number;
      old_reaction: ReactionEntry[];
      new_reaction: ReactionEntry[];
    };

    const reaction = (ctx.update as { message_reaction?: ReactionUpdate }).message_reaction;
    if (!reaction) {
      await next?.();
      return;
    }

    const chatId = reaction.chat.id;
    const messageId = reaction.message_id;

    const run = findRunByPlanMessageId(chatId, messageId);
    if (!run) {
      await next?.();
      return;
    }
    // Only react to the latest plan message
    if (run.telegramPlanMessage?.messageId !== messageId) {
      await next?.();
      return;
    }

    // Compute newly-added emojis (old->new diff)
    const oldEmojis = new Set(
      (reaction.old_reaction ?? [])
        .filter((r) => r.type === "emoji" && r.emoji)
        .map((r) => r.emoji!),
    );
    const newEmojis = (reaction.new_reaction ?? [])
      .filter((r) => r.type === "emoji" && r.emoji)
      .map((r) => r.emoji!)
      .filter((e) => !oldEmojis.has(e));

    const threadId = run.telegramPlanMessage?.threadId;
    const hasApprove = newEmojis.some((e) => APPROVE_EMOJIS.has(e));
    const hasReject = newEmojis.some((e) => REJECT_EMOJIS.has(e));

    if (hasApprove) {
      const lockResult = acquireGoalOpLock(run.runId, "approve");
      if (!lockResult.acquired) {
        await sendGoalReply(
          bot,
          chatId,
          formatGoalLockedMessage(run.runId, lockResult.existingLabel),
          runtime,
          threadId,
        );
        return;
      }
      const statusCb = buildOnStatusChange({ bot, chatId, threadId, runtime, runId: run.runId });
      runGoalInBackground({
        bot,
        chatId,
        threadId,
        runtime,
        label: "reaction:approve",
        preface: getGoalExecutionPreface(run.state),
        replyToMessageId: messageId,
        releaseGoalLock: lockResult.release,
        fn: () => handleGoalApprove(run.runId, statusCb, cfg),
        onResult: async (reply) =>
          sendGoalBackgroundResult(
            { bot, chatId, runtime, threadId, replyToMessageId: messageId },
            reply,
          ),
      });
    } else if (hasReject) {
      const reply = await handleGoalReject(run.runId);
      await sendGoalReply(bot, chatId, reply, runtime, threadId, messageId);
    } else {
      await next?.();
    }
  });

  // -----------------------------------------------------------------------
  // Command handlers
  // -----------------------------------------------------------------------

  // /new_goal <text> (with /goal as backward-compatible alias)
  bot.command(["new_goal", "goal"], async (ctx: TelegramGoalCommandContext) => {
    const resolved = await authAndResolve(ctx);
    if (!resolved) return;
    const replyToMessageId = ctx.message?.message_id;
    const text = ctx.match?.trim() ?? "";
    if (!text) {
      const result = await handleGoal("", cfg);
      await sendPlanResult(resolved.chatId, result, resolved.threadIdForSend, replyToMessageId);
      return;
    }

    const runGoal = (goalText: string) => {
      runGoalInBackground({
        bot,
        chatId: resolved.chatId,
        threadId: resolved.threadIdForSend,
        runtime,
        label: "goal",
        replyToMessageId,
        fn: () => handleGoal(goalText, cfg),
        onResult: async (result) => {
          if (result == null) return;
          if (typeof result === "string") {
            await sendGoalReply(
              bot,
              resolved.chatId,
              result,
              runtime,
              resolved.threadIdForSend,
              replyToMessageId,
            );
          } else {
            await sendPlanResult(
              resolved.chatId,
              result,
              resolved.threadIdForSend,
              replyToMessageId,
            );
          }
        },
      });
    };

    const msg = ctx.message;
    if (msg && commandFragmentBuffer && text) {
      const normalized = normalizeCommandFragmentParams(msg, accountId);
      const key = buildCommandFragmentKey(normalized);
      if (commandFragmentBuffer.hasPending(key)) {
        await commandFragmentBuffer.cancelAndFlush(key);
      }
      commandFragmentBuffer.bufferCommand(key, {
        commandName: "new_goal",
        text,
        firstMessageId: msg.message_id,
        receivedAtMs: Date.now(),
        dispatch: {
          chatId: resolved.chatId,
          threadIdForSend: resolved.threadIdForSend,
          senderId: normalized.senderId,
          replyToMessageId,
          sourceMessageId: msg.message_id,
          accountId,
        },
        flushCallback: (combinedText) => {
          runGoal(combinedText);
          const anchoredAtMs = Date.now();
          commandFragmentBuffer.setAnchor(key, {
            commandName: "new_goal",
            anchoredAtMs,
            expiresAtMs: anchoredAtMs + commandFragmentBuffer.getAnchorTtlMs(),
            sourceMessageId: msg.message_id,
            appendHandler: async (appendedText) => {
              runGoal(appendedText);
            },
          });
        },
      });
      return;
    }

    runGoal(text);
  });

  // /goal_plan_autocheck [codex|claude_code|off]
  bot.command("goal_plan_autocheck", async (ctx: TelegramGoalCommandContext) => {
    const resolved = await authAndResolve(ctx);
    if (!resolved) return;
    const replyToMessageId = ctx.message?.message_id;

    const rawMode = ctx.match?.trim() ?? "";
    if (!rawMode) {
      const currentMode = cfg.goal?.planAutocheck ?? "off";
      await sendGoalReply(
        bot,
        resolved.chatId,
        `Goal plan autocheck mode: \`${currentMode}\`.\n${GOAL_PLAN_AUTOCHECK_USAGE}`,
        runtime,
        resolved.threadIdForSend,
        replyToMessageId,
      );
      return;
    }

    const nextMode = parseGoalPlanAutocheckMode(rawMode);
    if (!nextMode) {
      const currentMode = cfg.goal?.planAutocheck ?? "off";
      await sendGoalReply(
        bot,
        resolved.chatId,
        `Invalid mode: \`${rawMode}\`.\n${GOAL_PLAN_AUTOCHECK_USAGE}\nCurrent: \`${currentMode}\``,
        runtime,
        resolved.threadIdForSend,
        replyToMessageId,
      );
      return;
    }

    if (!resolveChannelConfigWrites({ cfg, channelId: "telegram", accountId })) {
      await sendGoalReply(
        bot,
        resolved.chatId,
        "Config writes are disabled for this Telegram account.",
        runtime,
        resolved.threadIdForSend,
        replyToMessageId,
      );
      return;
    }

    const nextConfig = loadConfig();
    nextConfig.goal ??= {};
    nextConfig.goal.planAutocheck = nextMode;
    try {
      await writeConfigFile(nextConfig);
    } catch (error) {
      runtime.error?.(
        `[goal_plan_autocheck] failed to write config: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await sendGoalReply(
        bot,
        resolved.chatId,
        "Could not save goal plan autocheck mode. Check logs and try again.",
        runtime,
        resolved.threadIdForSend,
        replyToMessageId,
      );
      return;
    }

    cfg.goal ??= {};
    cfg.goal.planAutocheck = nextMode;

    const confirmation =
      nextMode === "off"
        ? "Goal plan autocheck disabled."
        : `Goal plan autocheck set to \`${nextMode}\`.`;
    await sendGoalReply(
      bot,
      resolved.chatId,
      confirmation,
      runtime,
      resolved.threadIdForSend,
      replyToMessageId,
    );
  });

  // /goal_semgrep [off|step|goal]
  bot.command("goal_semgrep", async (ctx: TelegramGoalCommandContext) => {
    const resolved = await authAndResolve(ctx);
    if (!resolved) return;
    const replyToMessageId = ctx.message?.message_id;

    const rawMode = ctx.match?.trim() ?? "";
    if (!rawMode) {
      const currentMode = cfg.goal?.semgrep ?? "step";
      await sendGoalReply(
        bot,
        resolved.chatId,
        `Goal semgrep mode: \`${currentMode}\`.\n${GOAL_SEMGREP_USAGE}`,
        runtime,
        resolved.threadIdForSend,
        replyToMessageId,
      );
      return;
    }

    const normalized = rawMode.toLowerCase();
    const nextMode: "off" | "step" | "goal" | undefined =
      normalized === "off" || normalized === "step" || normalized === "goal"
        ? normalized
        : undefined;
    if (!nextMode) {
      const currentMode = cfg.goal?.semgrep ?? "step";
      await sendGoalReply(
        bot,
        resolved.chatId,
        `Invalid mode: \`${rawMode}\`.\n${GOAL_SEMGREP_USAGE}\nCurrent: \`${currentMode}\``,
        runtime,
        resolved.threadIdForSend,
        replyToMessageId,
      );
      return;
    }

    if (!resolveChannelConfigWrites({ cfg, channelId: "telegram", accountId })) {
      await sendGoalReply(
        bot,
        resolved.chatId,
        "Config writes are disabled for this Telegram account.",
        runtime,
        resolved.threadIdForSend,
        replyToMessageId,
      );
      return;
    }

    const nextConfig = loadConfig();
    nextConfig.goal ??= {};
    nextConfig.goal.semgrep = nextMode;
    try {
      await writeConfigFile(nextConfig);
    } catch (error) {
      runtime.error?.(
        `[goal_semgrep] failed to write config: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await sendGoalReply(
        bot,
        resolved.chatId,
        "Could not save goal semgrep mode. Check logs and try again.",
        runtime,
        resolved.threadIdForSend,
        replyToMessageId,
      );
      return;
    }

    cfg.goal ??= {};
    cfg.goal.semgrep = nextMode;

    const confirmation =
      nextMode === "off"
        ? "Semgrep SAST scanning disabled."
        : nextMode === "step"
          ? "Semgrep will run after each completed step."
          : "Semgrep will run only after the last step completes.";
    await sendGoalReply(
      bot,
      resolved.chatId,
      confirmation,
      runtime,
      resolved.threadIdForSend,
      replyToMessageId,
    );
  });

  // /goal_workers [codex|claude_code|both|all]
  bot.command("goal_workers", async (ctx: TelegramGoalCommandContext) => {
    const resolved = await authAndResolve(ctx);
    if (!resolved) return;
    const replyToMessageId = ctx.message?.message_id;

    const rawWorkers = ctx.match?.trim() ?? "";
    const currentWorkers = resolveEnabledWorkers(cfg.goal);
    const currentWorkersText = formatGoalWorkers(currentWorkers);
    if (!rawWorkers) {
      await sendGoalReply(
        bot,
        resolved.chatId,
        `Enabled goal workers: \`${currentWorkersText}\`.\n${GOAL_WORKERS_USAGE}`,
        runtime,
        resolved.threadIdForSend,
        replyToMessageId,
      );
      return;
    }

    const nextWorkers = parseGoalWorkersArg(rawWorkers);
    if (!nextWorkers) {
      await sendGoalReply(
        bot,
        resolved.chatId,
        `Invalid workers: \`${rawWorkers}\`.\n${GOAL_WORKERS_USAGE}\nCurrent: \`${currentWorkersText}\``,
        runtime,
        resolved.threadIdForSend,
        replyToMessageId,
      );
      return;
    }

    if (!resolveChannelConfigWrites({ cfg, channelId: "telegram", accountId })) {
      await sendGoalReply(
        bot,
        resolved.chatId,
        "Config writes are disabled for this Telegram account.",
        runtime,
        resolved.threadIdForSend,
        replyToMessageId,
      );
      return;
    }

    const nextConfig = loadConfig();
    nextConfig.goal ??= {};
    nextConfig.goal.enabledWorkers = [...nextWorkers];
    try {
      await writeConfigFile(nextConfig);
    } catch (error) {
      runtime.error?.(
        `[goal_workers] failed to write config: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await sendGoalReply(
        bot,
        resolved.chatId,
        "Could not save goal workers setting. Check logs and try again.",
        runtime,
        resolved.threadIdForSend,
        replyToMessageId,
      );
      return;
    }

    cfg.goal ??= {};
    cfg.goal.enabledWorkers = [...nextWorkers];

    await sendGoalReply(
      bot,
      resolved.chatId,
      `Enabled goal workers set to \`${formatGoalWorkers(nextWorkers)}\`.`,
      runtime,
      resolved.threadIdForSend,
      replyToMessageId,
    );
  });

  // /goal_github_push [on|off]
  bot.command("goal_github_push", async (ctx: TelegramGoalCommandContext) => {
    const resolved = await authAndResolve(ctx);
    if (!resolved) return;
    const replyToMessageId = ctx.message?.message_id;

    const rawArg = ctx.match?.trim().toLowerCase() ?? "";
    if (!rawArg) {
      const current = cfg.goal?.githubPush?.enabled ? "on" : "off";
      await sendGoalReply(
        bot,
        resolved.chatId,
        `GitHub push is currently \`${current}\`.\n${GOAL_GITHUB_PUSH_USAGE}`,
        runtime,
        resolved.threadIdForSend,
        replyToMessageId,
      );
      return;
    }

    if (rawArg !== "on" && rawArg !== "off") {
      const current = cfg.goal?.githubPush?.enabled ? "on" : "off";
      await sendGoalReply(
        bot,
        resolved.chatId,
        `Invalid argument: \`${rawArg}\`.\n${GOAL_GITHUB_PUSH_USAGE}\nCurrent: \`${current}\``,
        runtime,
        resolved.threadIdForSend,
        replyToMessageId,
      );
      return;
    }

    if (!resolveChannelConfigWrites({ cfg, channelId: "telegram", accountId })) {
      await sendGoalReply(
        bot,
        resolved.chatId,
        "Config writes are disabled for this Telegram account.",
        runtime,
        resolved.threadIdForSend,
        replyToMessageId,
      );
      return;
    }

    const enabled = rawArg === "on";
    const nextConfig = loadConfig();
    nextConfig.goal ??= {};
    nextConfig.goal.githubPush = { ...nextConfig.goal.githubPush, enabled };
    try {
      await writeConfigFile(nextConfig);
    } catch (error) {
      runtime.error?.(
        `[goal_github_push] failed to write config: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await sendGoalReply(
        bot,
        resolved.chatId,
        "Could not save GitHub push setting. Check logs and try again.",
        runtime,
        resolved.threadIdForSend,
        replyToMessageId,
      );
      return;
    }

    cfg.goal ??= {};
    cfg.goal.githubPush = { ...cfg.goal.githubPush, enabled };

    const confirmation = enabled
      ? "GitHub push enabled. Completed runs will push branch + open PR."
      : "GitHub push disabled.";
    await sendGoalReply(
      bot,
      resolved.chatId,
      confirmation,
      runtime,
      resolved.threadIdForSend,
      replyToMessageId,
    );
  });

  // /goal_approve <runId>
  bot.command("goal_approve", async (ctx: TelegramGoalCommandContext) => {
    const resolved = await authAndResolve(ctx);
    if (!resolved) return;
    const replyToMessageId = ctx.message?.message_id;
    const rawId = ctx.match?.trim() ?? "";
    if (!rawId) {
      await sendGoalReply(
        bot,
        resolved.chatId,
        "Usage: /goal_approve <runId>",
        runtime,
        resolved.threadIdForSend,
        replyToMessageId,
      );
      return;
    }
    await startGoalResume({
      rawId,
      chatId: resolved.chatId,
      threadId: resolved.threadIdForSend,
      replyToMessageId,
      lockLabel: "approve",
      backgroundLabel: "goal_approve",
    });
  });

  // /goal_resume <runId> (alias of /goal_approve)
  bot.command("goal_resume", async (ctx: TelegramGoalCommandContext) => {
    const resolved = await authAndResolve(ctx);
    if (!resolved) return;
    const replyToMessageId = ctx.message?.message_id;
    const rawId = ctx.match?.trim() ?? "";
    if (!rawId) {
      await sendGoalReply(
        bot,
        resolved.chatId,
        "Usage: /goal_resume <runId>",
        runtime,
        resolved.threadIdForSend,
        replyToMessageId,
      );
      return;
    }
    await startGoalResume({
      rawId,
      chatId: resolved.chatId,
      threadId: resolved.threadIdForSend,
      replyToMessageId,
      lockLabel: "resume",
      backgroundLabel: "goal_resume",
    });
  });

  // /goal_reject <runId>
  bot.command("goal_reject", async (ctx: TelegramGoalCommandContext) => {
    const resolved = await authAndResolve(ctx);
    if (!resolved) return;
    const reply = await handleGoalReject(ctx.match?.trim() ?? "");
    await sendGoalReply(
      bot,
      resolved.chatId,
      reply,
      runtime,
      resolved.threadIdForSend,
      ctx.message?.message_id,
    );
  });

  // /goal_edit <runId> <instructions>
  bot.command("goal_edit", async (ctx: TelegramGoalCommandContext) => {
    const resolved = await authAndResolve(ctx);
    if (!resolved) return;
    const replyToMessageId = ctx.message?.message_id;
    const raw = ctx.match?.trim() ?? "";
    const spaceIdx = raw.indexOf(" ");
    if (spaceIdx === -1) {
      await sendGoalReply(
        bot,
        resolved.chatId,
        "Usage: /goal_edit <runId> <edit instructions>",
        runtime,
        resolved.threadIdForSend,
        replyToMessageId,
      );
      return;
    }
    const editRunIdRaw = raw.slice(0, spaceIdx);
    const instructions = raw.slice(spaceIdx + 1).trim();
    const editRunId = resolveRunId(editRunIdRaw);
    if (!editRunId) {
      await sendGoalReply(
        bot,
        resolved.chatId,
        `Run not found: ${editRunIdRaw}`,
        runtime,
        resolved.threadIdForSend,
        replyToMessageId,
      );
      return;
    }
    const editLock = acquireGoalOpLock(editRunId, "edit");
    if (!editLock.acquired) {
      await sendGoalReply(
        bot,
        resolved.chatId,
        formatGoalLockedMessage(editRunId, editLock.existingLabel),
        runtime,
        resolved.threadIdForSend,
        replyToMessageId,
      );
      return;
    }
    runGoalInBackground({
      bot,
      chatId: resolved.chatId,
      threadId: resolved.threadIdForSend,
      runtime,
      label: "goal_edit",
      replyToMessageId,
      releaseGoalLock: editLock.release,
      fn: () => handleGoalEdit(editRunIdRaw, instructions, cfg),
      onResult: async (result) => {
        if (result == null) return;
        if (typeof result === "string") {
          await sendGoalReply(
            bot,
            resolved.chatId,
            result,
            runtime,
            resolved.threadIdForSend,
            replyToMessageId,
          );
        } else {
          await sendPlanResult(resolved.chatId, result, resolved.threadIdForSend, replyToMessageId);
        }
      },
    });
  });

  // /goal_status <runId>
  bot.command("goal_status", async (ctx: TelegramGoalCommandContext) => {
    const resolved = await authAndResolve(ctx);
    if (!resolved) return;
    const raw = ctx.match?.trim() ?? "";
    await sendGoalStatusResponse({
      bot,
      chatId: resolved.chatId,
      threadId: resolved.threadIdForSend,
      runtime,
      rawId: raw,
      replyToMessageId: ctx.message?.message_id,
    });
  });

  // /goal_detail <runId>
  bot.command("goal_detail", async (ctx: TelegramGoalCommandContext) => {
    const resolved = await authAndResolve(ctx);
    if (!resolved) return;
    const raw = ctx.match?.trim() ?? "";
    await sendGoalDetailResponse({
      bot,
      chatId: resolved.chatId,
      threadId: resolved.threadIdForSend,
      runtime,
      rawId: raw,
      replyToMessageId: ctx.message?.message_id,
    });
  });

  // /goal_answer <runId> <value>
  bot.command("goal_answer", async (ctx: TelegramGoalCommandContext) => {
    const resolved = await authAndResolve(ctx);
    if (!resolved) return;
    const replyToMessageId = ctx.message?.message_id;
    const raw = ctx.match?.trim() ?? "";
    const spaceIdx = raw.indexOf(" ");
    if (spaceIdx === -1) {
      await sendGoalReply(
        bot,
        resolved.chatId,
        "Usage: /goal_answer <runId> <value>",
        runtime,
        resolved.threadIdForSend,
        replyToMessageId,
      );
      return;
    }
    const answerRunIdRaw = raw.slice(0, spaceIdx);
    const value = raw.slice(spaceIdx + 1).trim();
    const answerRunId = resolveRunId(answerRunIdRaw);
    if (!answerRunId) {
      await sendGoalReply(
        bot,
        resolved.chatId,
        `Run not found: ${answerRunIdRaw}`,
        runtime,
        resolved.threadIdForSend,
        replyToMessageId,
      );
      return;
    }
    const answerLock = acquireGoalOpLock(answerRunId, "answer");
    if (!answerLock.acquired) {
      await sendGoalReply(
        bot,
        resolved.chatId,
        formatGoalLockedMessage(answerRunId, answerLock.existingLabel),
        runtime,
        resolved.threadIdForSend,
        replyToMessageId,
      );
      return;
    }
    const statusCb = buildOnStatusChange({
      bot,
      chatId: resolved.chatId,
      threadId: resolved.threadIdForSend,
      runtime,
      runId: answerRunId,
    });
    runGoalInBackground({
      bot,
      chatId: resolved.chatId,
      threadId: resolved.threadIdForSend,
      runtime,
      label: "goal_answer",
      replyToMessageId,
      releaseGoalLock: answerLock.release,
      fn: () => handleGoalAnswer(answerRunIdRaw, value, statusCb, cfg),
      onResult: async (result) => {
        if (result == null) return;
        if (typeof result === "string") {
          await sendGoalReply(
            bot,
            resolved.chatId,
            result,
            runtime,
            resolved.threadIdForSend,
            replyToMessageId,
          );
        } else {
          await sendPlanResult(resolved.chatId, result, resolved.threadIdForSend, replyToMessageId);
        }
      },
    });
  });

  // /goal_feedback <runId> <feedback>
  bot.command("goal_feedback", async (ctx: TelegramGoalCommandContext) => {
    const resolved = await authAndResolve(ctx);
    if (!resolved) return;
    const replyToMessageId = ctx.message?.message_id;
    const raw = ctx.match?.trim() ?? "";
    const spaceIdx = raw.indexOf(" ");
    if (spaceIdx === -1) {
      await sendGoalReply(
        bot,
        resolved.chatId,
        "Usage: /goal_feedback <runId> <feedback>",
        runtime,
        resolved.threadIdForSend,
        replyToMessageId,
      );
      return;
    }
    const feedbackRunIdRaw = raw.slice(0, spaceIdx);
    const feedbackText = raw.slice(spaceIdx + 1).trim();
    const feedbackRunId = resolveRunId(feedbackRunIdRaw);
    if (!feedbackRunId) {
      await sendGoalReply(
        bot,
        resolved.chatId,
        `Run not found: ${feedbackRunIdRaw}`,
        runtime,
        resolved.threadIdForSend,
        replyToMessageId,
      );
      return;
    }
    const feedbackLock = acquireGoalOpLock(feedbackRunId, "feedback");
    if (!feedbackLock.acquired) {
      await sendGoalReply(
        bot,
        resolved.chatId,
        formatGoalLockedMessage(feedbackRunId, feedbackLock.existingLabel),
        runtime,
        resolved.threadIdForSend,
        replyToMessageId,
      );
      return;
    }
    runGoalInBackground({
      bot,
      chatId: resolved.chatId,
      threadId: resolved.threadIdForSend,
      runtime,
      label: "goal_feedback",
      replyToMessageId,
      releaseGoalLock: feedbackLock.release,
      fn: () => {
        const statusCb = buildOnStatusChange({
          bot,
          chatId: resolved.chatId,
          threadId: resolved.threadIdForSend,
          runtime,
          runId: feedbackRunId,
        });
        return handleGoalFeedback(feedbackRunIdRaw, feedbackText, cfg, statusCb);
      },
      onResult: async (result) => {
        if (result == null) return;
        if (typeof result === "string") {
          await sendGoalReply(
            bot,
            resolved.chatId,
            result,
            runtime,
            resolved.threadIdForSend,
            replyToMessageId,
          );
        } else {
          await sendPlanResult(resolved.chatId, result, resolved.threadIdForSend, replyToMessageId);
        }
      },
    });
  });

  // /goal_list
  bot.command("goal_list", async (ctx: TelegramGoalCommandContext) => {
    const resolved = await authAndResolve(ctx);
    if (!resolved) return;
    const reply = await handleGoalList();
    await sendGoalReply(
      bot,
      resolved.chatId,
      reply,
      runtime,
      resolved.threadIdForSend,
      ctx.message?.message_id,
    );
  });

  // /goal_lessons [clear [workingDir]]
  bot.command("goal_lessons", async (ctx: TelegramGoalCommandContext) => {
    const resolved = await authAndResolve(ctx);
    if (!resolved) return;
    const replyToMessageId = ctx.message?.message_id;
    const arg = ctx.match?.trim() ?? "";
    if (arg.startsWith("clear")) {
      if (!resolveChannelConfigWrites({ cfg, channelId: "telegram", accountId })) {
        await sendGoalReply(
          bot,
          resolved.chatId,
          "Config writes are disabled for this Telegram account.",
          runtime,
          resolved.threadIdForSend,
          replyToMessageId,
        );
        return;
      }
    }

    const reply = await handleGoalLessons(arg);
    await sendGoalReply(
      bot,
      resolved.chatId,
      reply,
      runtime,
      resolved.threadIdForSend,
      replyToMessageId,
    );
  });

  // /goal_stop <runId>
  bot.command("goal_stop", async (ctx: TelegramGoalCommandContext) => {
    const resolved = await authAndResolve(ctx);
    if (!resolved) return;
    const reply = await handleGoalStop(ctx.match?.trim() ?? "");
    await sendGoalReply(
      bot,
      resolved.chatId,
      reply,
      runtime,
      resolved.threadIdForSend,
      ctx.message?.message_id,
    );
  });
}
