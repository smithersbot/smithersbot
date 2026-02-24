import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InputFile, type Bot, type Context } from "grammy";
import type { InlineKeyboardMarkup, ReactionTypeEmoji } from "grammy/types";

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
import type { CliWorkerId, PlanAutocheckMode } from "../config/types.goal.js";
import type {
  TelegramAccountConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "../config/types.js";
import type { GoalStatusChangeEvent } from "../goal/agent-executor.js";
import { resolveEnabledWorkers } from "../goal/backend-types.js";
import { formatCompactGoalCompletionSummary } from "../goal/compact-output.js";
import { runCliPlanRevision } from "../goal/cli-planner.js";
import { computeCpm } from "../goal/cpm.js";
import { AUTH_RE } from "../goal/error-patterns.js";
import { formatGoalError } from "../goal/errors.js";
import { computeDisplayStatuses } from "../goal/execution-status.js";
import {
  buildFeedbackRevisionInstructions,
  mergeRevisedPlanWithDoneSteps,
} from "../goal/feedback.js";
import { formatPlanOutput } from "../goal/format-output.js";
import { generateManualTests } from "../goal/manual-tests.js";
import { runPlanAutocheck } from "../goal/plan-autocheck.js";
import { renderMermaid } from "../goal/mermaid-render.js";
import { renderMermaidToPng } from "../goal/mermaid-png.js";
import { ensureWorkingDir } from "../goal/git-checkpoint.js";
import { clearLessons, loadLessons } from "../goal/lessons.js";
import { PlanParseError, persistRawPlanResponse } from "../goal/planner.js";
import { acquireGoalOpLock, forceReleaseGoalOpLock } from "../goal/goal-lock.js";
import { listRuns, loadRun, resolveGoalsDir, resolveRunId, saveRun } from "../goal/run-store.js";
import { formatAge } from "../infra/channel-summary.js";
import type {
  ManualTestSuggestion,
  Plan,
  PlanStep,
  SerializedRun,
  StepResult,
} from "../goal/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { markdownToTelegramChunks, markdownToTelegramHtml } from "./format.js";
import { buildInlineKeyboard } from "./send.js";
import { recordSentMessage } from "./sent-message-cache.js";
import { findRunByPlanMessageIdIndexed, indexPlanMessage } from "./goal-message-index.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import { resolveTelegramCommandAuth } from "./telegram-auth.js";
import {
  buildCommandFragmentKey,
  type CommandFragmentBuffer,
  normalizeCommandFragmentParams,
} from "./command-fragments.js";

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

function serializedStepResultsToMap(
  run: SerializedRun | undefined,
): ReadonlyMap<string, StepResult> {
  return new Map(Object.entries(run?.stepResults ?? {}));
}

const GOAL_PLAN_AUTOCHECK_USAGE = "Usage: /goal_plan_autocheck <codex|claude_code|off>";
const GOAL_WORKERS_USAGE = "Usage: /goal_workers <codex|claude_code|both|all>";
const GOAL_LESSONS_USAGE = "Usage: /goal\\_lessons \\[clear \\[workingDir\\]\\]";
const GOAL_GITHUB_PUSH_USAGE = "Usage: /goal\\_github\\_push \\[on|off]";
const GOAL_PLAN_AUTOCHECK_MAX_ROUNDS = 3;

type PlanAutocheckDisplayInfo = {
  rounds: number;
  maxRounds: number;
  exhausted: boolean;
};

function parseGoalPlanAutocheckMode(raw: string): PlanAutocheckMode | undefined {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "codex" || normalized === "claude_code" || normalized === "off") {
    return normalized;
  }
  return undefined;
}

function parseGoalWorkersArg(raw: string): CliWorkerId[] | undefined {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "codex") return ["codex"];
  if (normalized === "claude_code") return ["claude_code"];
  if (normalized === "both" || normalized === "all") return ["codex", "claude_code"];
  return undefined;
}

function formatGoalWorkers(workers: CliWorkerId[]): string {
  return workers.join(", ");
}

function isPlanAutocheckBackend(
  mode: PlanAutocheckMode | undefined,
): mode is Exclude<PlanAutocheckMode, "off"> {
  return mode === "codex" || mode === "claude_code";
}

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
  if (!run || run.state === "awaiting_approval") return run;
  run.state = "awaiting_approval";
  run.updatedAt = new Date().toISOString();
  saveRun(run);
  return run;
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
// Inline keyboard builder
// ---------------------------------------------------------------------------

function buildGoalInlineKeyboard(runIdPrefix: string, revision: number) {
  return buildInlineKeyboard([
    [
      { text: "\u2764\uFE0F Approve", callback_data: `ga:${runIdPrefix}:${revision}` },
      { text: "\uD83D\uDD0D Plan Detail", callback_data: `gD:${runIdPrefix}:${revision}` },
    ],
    [
      { text: "\u270F\uFE0F Request changes", callback_data: `ge:${runIdPrefix}:${revision}` },
      { text: "\uD83D\uDC4E Reject", callback_data: `gr:${runIdPrefix}:${revision}` },
    ],
  ]);
}

function resolveBlockedRequiredInputKey(run: SerializedRun): string | undefined {
  if (run.blocked?.requiredInputKey?.trim()) {
    return run.blocked.requiredInputKey;
  }
  const firstBlockedStep = run.plan?.steps.find((step) => step.status === "blocked");
  return firstBlockedStep ? `task:${firstBlockedStep.id}:input` : undefined;
}

/** Inline keyboard for blocked/failed goal messages: Add Details + Resume + Stop. */
function buildGoalBlockedInlineKeyboard(runIdPrefix: string) {
  return buildInlineKeyboard([
    [{ text: "✏️ Add Details", callback_data: `gAD:${runIdPrefix}` }],
    [
      { text: "\u25B6\uFE0F Resume Goal", callback_data: `gResume:${runIdPrefix}` },
      { text: "\u23F9\uFE0F Stop Goal", callback_data: `gStop:${runIdPrefix}` },
    ],
  ]);
}

/** Inline keyboard for task-blocked goal messages: Add Details + Stop. */
function buildTaskBlockedInlineKeyboard(runIdPrefix: string) {
  return buildInlineKeyboard([
    [{ text: "✏️ Add Details", callback_data: `gAD:${runIdPrefix}` }],
    [{ text: "\u23F9\uFE0F Stop Goal", callback_data: `gStop:${runIdPrefix}` }],
  ]);
}

/** Inline keyboard for done goal messages: test details + feedback loop. */
export function buildGoalDoneInlineKeyboard(runIdPrefix: string) {
  return buildInlineKeyboard([
    [{ text: "🔍 Test Detail", callback_data: `gTD:${runIdPrefix}` }],
    [{ text: "🔄 Incorporate Feedback", callback_data: `gIF:${runIdPrefix}` }],
  ]);
}

function clampCriticality(value: number): number {
  return Math.max(1, Math.min(10, Math.round(value)));
}

function splitStructuredDetailLines(value: string | undefined): string[] {
  if (!value) return [];
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  return normalized
    .split(/\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

function formatTaskDetailSections(plan: Plan): string {
  if (plan.steps.length === 0) return "";
  const lines: string[] = ["", "**Tasks**", ""];

  plan.steps.forEach((step, index) => {
    const taskTitle =
      (typeof step.shortSummary === "string" ? step.shortSummary.trim() : "") || step.id;
    lines.push(`**Task ${index + 1}: ${taskTitle}**`);
    const descriptionBullets = splitStructuredDetailLines(step.description);
    if (descriptionBullets.length > 0) {
      for (const bullet of descriptionBullets) {
        lines.push(`• ${bullet}`);
      }
    } else {
      lines.push("• No description provided.");
    }
    if (step.dependsOn.length > 0) {
      lines.push(`• Depends on: ${step.dependsOn.join(", ")}`);
    }
    if (index < plan.steps.length - 1) lines.push("");
  });

  return lines.join("\n");
}

function formatManualTestDetails(
  runIdPrefix: string,
  tests: ManualTestSuggestion[] | null | undefined,
  manualTestsError?: string,
): string {
  if (Array.isArray(tests) && tests.length === 0) {
    return [
      "No manual tests needed — all functionality was verified automatically.",
      "",
      'Use "Incorporate Feedback" if you notice any issues.',
    ].join("\n");
  }
  if (!tests) {
    const lines = [`Manual test details are unavailable for run ${runIdPrefix}.`];
    if (manualTestsError?.trim()) {
      lines.push(`Reason: ${manualTestsError.trim()}`);
    } else {
      lines.push(
        "Manual test generation did not return suggestions. This can happen when model auth fails or no valid response is produced.",
      );
    }
    lines.push('Use "Incorporate Feedback" to share what failed and what you expected.');
    return lines.join("\n");
  }
  const lines = [`Manual test details for ${runIdPrefix}:`, ""];
  tests.forEach((test, index) => {
    const description = test.description.trim() || "Manual test";
    lines.push(
      `**Test ${index + 1}: ${description} [${clampCriticality(test.criticality)}/10 Critical]**`,
    );
    const reason = test.reason?.trim();
    if (reason) {
      lines.push(`_Reason: ${reason}_`);
    }
    const detail = test.detail
      .replace(/\r\n/g, "\n")
      .trim()
      // Normalize both plain and already-bold Step markers so Telegram output is consistent.
      .replace(/(?:\*\*)?\bStep (\d+)\.(?:\*\*)?/g, "**Step $1.**");
    lines.push("");
    lines.push(detail || "No additional detail provided.");
    if (index < tests.length - 1) lines.push("");
  });
  return lines.join("\n");
}

function appendGoalIdFooter(summary: string, runId: string): string {
  return `${summary.trimEnd()}\n**Goal ID:** ${runId.slice(0, 8)}`;
}

const MANUAL_TEST_GENERATION_FAILED_NOTICE = "Note: Manual test generation failed.";

function appendManualTestGenerationFailureNotice(
  summary: string,
  manualTestsError?: string,
): string {
  if (!manualTestsError?.trim()) return summary;
  if (summary.includes(MANUAL_TEST_GENERATION_FAILED_NOTICE)) return summary;
  return `${summary.trimEnd()}\n${MANUAL_TEST_GENERATION_FAILED_NOTICE}`;
}

function buildDoneSummaryWithManualTests(run: SerializedRun): string {
  const summary = formatCompactGoalCompletionSummary({
    title:
      run.plan && typeof run.plan.shortSummary === "string"
        ? run.plan.shortSummary.trim() || run.goal
        : run.goal,
    steps:
      run.plan?.steps.map((step) => ({
        id: step.id,
        description: step.description,
        summary: step.taskSummary,
        status: step.status,
        turnsUsed: step.turnsUsed,
      })) ?? [],
    channel: "telegram",
    manualTests: run.manualTests,
  }).text;
  return appendGoalIdFooter(
    appendManualTestGenerationFailureNotice(summary, run.manualTestsError),
    run.runId,
  );
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
// Planning feedback: preface message + delayed typing
// ---------------------------------------------------------------------------

export const PLANNING_PREFACE = "Right away, sir.";
export const START_PREFACE = "Right away, sir. Starting the goal now.";
export const RESUME_PREFACE = "Right away, sir. Resuming the goal now.";

export function getGoalExecutionPreface(state: SerializedRun["state"] | undefined): string {
  if (state === "awaiting_approval" || state === "cancelled") {
    return START_PREFACE;
  }
  return RESUME_PREFACE;
}

type WorkingDirInstructionHint = {
  requestedPath: string;
  resolvedPath?: string;
};

// Word boundaries + trailing lookaheads avoid camelCase false matches (e.g. workingDir, workingDirectory).
const WORKING_DIR_INSTRUCTION_PATTERNS = [
  /(?:\bworking\b\s*dir(?!\w)|\bworking\b\s*directory(?!\w)|\bworkdir(?!\w))[^\n]{0,200}?\bshould\s*be\s+([^\n]+)/i,
  /set\s+(?:the\s+)?(?:\bworking\b\s*dir(?!\w)|\bworking\b\s*directory(?!\w)|\bworkdir(?!\w))\s+to\s+([^\n]+)/i,
  /(?:\bworking\b\s*dir(?!\w)|\bworking\b\s*directory(?!\w)|\bworkdir(?!\w))\s*(?:should\s*be|is|=|:)\s*([^\n]+)/i,
];
const WORKING_DIR_INSTRUCTION_PREFIX_PATTERN =
  /^(?:(?:in|at)\s+)?(?:(?:a|an|the)\s+)?(?:new\s+)?(?:folder|directory|dir)\b(?:\s+(?:called|named))?(?:\s*[:=-])?\s+/i;

function cleanWorkingDirInstructionPath(rawPath: string): string {
  let value = rawPath.trim();
  value = value.replace(/\s*\(.*$/, "").trim();
  value = value.replace(/\s+\b(?:when|where|which)\b.*$/i, "").trim();
  value = value.replace(/\s+\b(?:and|but)\b\s+(?:it\s+)?should\s+be\b.*$/i, "").trim();
  value = value
    .replace(/^[`'"]+/, "")
    .replace(/[`'"]+$/, "")
    .trim();
  value = value.replace(/[.,;:!?]+$/, "").trim();
  value = value.replace(WORKING_DIR_INSTRUCTION_PREFIX_PATTERN, "").trim();
  if (/^~[^/\\]/.test(value)) {
    value = `~/${value.slice(1)}`;
  }
  return value;
}

function normalizeDirectoryToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function resolveByNormalizedDirectoryName(value: string, roots: string[]): string | undefined {
  const target = normalizeDirectoryToken(value);
  if (!target) return undefined;

  for (const root of new Set(roots)) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (normalizeDirectoryToken(entry.name) !== target) continue;
        return path.join(root, entry.name);
      }
    } catch {
      // Ignore missing/inaccessible roots.
    }
  }

  return undefined;
}

function resolveWorkingDirInstructionPath(
  value: string,
  currentWorkingDir: string,
): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("~") || path.isAbsolute(value)) {
    return resolveUserPath(value);
  }

  const candidates = new Set<string>();
  candidates.add(path.resolve(currentWorkingDir, value));
  candidates.add(path.resolve(process.cwd(), value));
  candidates.add(path.resolve(path.dirname(currentWorkingDir), value));
  candidates.add(path.resolve(path.dirname(process.cwd()), value));
  candidates.add(path.resolve(os.homedir(), value));

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // Keep trying candidates.
    }
  }

  // Fuzzy fallback for conversational directory names, e.g. "earnlayermarketing"
  // matching sibling folder "earnlayer-marketing".
  if (
    !value.startsWith("~") &&
    !path.isAbsolute(value) &&
    !value.includes("/") &&
    !value.includes("\\")
  ) {
    return resolveByNormalizedDirectoryName(value, [
      currentWorkingDir,
      process.cwd(),
      path.dirname(currentWorkingDir),
      path.dirname(process.cwd()),
      os.homedir(),
    ]);
  }

  return undefined;
}

function parseWorkingDirInstruction(
  instructions: string,
  currentWorkingDir: string,
): WorkingDirInstructionHint | undefined {
  for (const pattern of WORKING_DIR_INSTRUCTION_PATTERNS) {
    const match = pattern.exec(instructions);
    if (!match?.[1]) continue;
    const requestedPath = cleanWorkingDirInstructionPath(match[1]);
    if (!requestedPath) continue;
    return {
      requestedPath,
      resolvedPath: resolveWorkingDirInstructionPath(requestedPath, currentWorkingDir),
    };
  }
  return undefined;
}

/**
 * Send a short preface message, then run `fn` with an immediate typing loop.
 * Applied only to planning / replanning paths.
 */
export async function withPlanningFeedback<T>(params: {
  bot: Bot;
  chatId: number;
  threadId?: number;
  label?: string;
  fn: () => Promise<T>;
}): Promise<T> {
  const { bot, chatId, threadId, label, fn } = params;
  const threadParams = threadId != null ? { message_thread_id: threadId } : {};
  const tag = label ? `${label} ` : "";

  // Preface: instant acknowledgement
  logTyping(`${tag}preface chatId=${chatId}${threadId != null ? ` threadId=${threadId}` : ""}`);
  await bot.api.sendMessage(chatId, PLANNING_PREFACE, threadParams).catch((err: unknown) => {
    logTyping(
      `${tag}preface error chatId=${chatId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  // Start typing immediately (no delay)
  const loop = startTypingLoop({ bot, chatId, threadId, label });
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

    if (outcome?.status === "blocked") {
      parts.push(`\nAnswer: /goal_answer ${runId.slice(0, 8)} <your answer>`);
      return { text: parts.join("\n") || "More information needed.", runId, blocked: true };
    }

    // Successful plan — load run for PNG rendering in sendGoalPlanResult
    let run = loadRun(runId);
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
  if (run?.plan) {
    await sendDagPng({
      bot,
      chatId,
      threadId,
      runtime,
      plan: run.plan,
      steps: run.plan.steps,
      stepResults: serializedStepResultsToMap(run),
      caption: reply,
      replyToMessageId,
    });
    return;
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
    await sendDagPng({
      bot,
      chatId,
      threadId,
      runtime,
      plan: run.plan,
      steps: run.plan.steps,
      stepResults: serializedStepResultsToMap(run),
      caption: reply,
      replyToMessageId,
    });
    return;
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
      await goalAnswerCommand(resolvedId, { key, value, quiet: true }, cap.runtime);

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
  try {
    const outcome = await goalAnswerCommand(
      resolvedId,
      { key, value, quiet: true, onStatusChange },
      cap.runtime,
    );

    const errors = cap.getErrors();
    if (errors) return errors;

    // When onStatusChange is wired, it already sent DAG PNGs for blocked/done —
    // return undefined so callers don't send a stray message after the notifications.
    if (onStatusChange) return undefined;

    if (outcome?.status === "blocked") {
      return `Still blocked: ${outcome.question}\n\nAnswer: /goal_answer ${prefix} <your answer>`;
    }

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
    const outcome = await goalResumeCommand(
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

const GOAL_LIST_LIMIT = 15;

type GoalLessonsAction =
  | { kind: "list" }
  | { kind: "clear"; workingDir?: string }
  | { kind: "invalid" };

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseGoalLessonsAction(rawArg: string): GoalLessonsAction {
  const raw = rawArg.trim();
  if (!raw) return { kind: "list" };

  const clearMatch = /^clear(?:\s+(.+))?$/i.exec(raw);
  if (!clearMatch) return { kind: "invalid" };
  const rawWorkingDir = clearMatch[1]?.trim();
  if (!rawWorkingDir) return { kind: "clear" };
  return {
    kind: "clear",
    workingDir: rawWorkingDir === "*" ? "*" : resolveUserPath(rawWorkingDir),
  };
}

function formatGoalLessonAge(createdAt: string): string {
  const createdAtMs = parseTimestamp(createdAt);
  if (!createdAtMs) return "unknown";
  return formatAge(Math.max(0, Date.now() - createdAtMs));
}

function formatGoalLessonsList(): string {
  const lessons = loadLessons();
  if (lessons.length === 0) return "No lessons recorded yet.";

  const sortedLessons = [...lessons].sort(
    (a, b) => parseTimestamp(b.createdAt) - parseTimestamp(a.createdAt),
  );
  const grouped = new Map<string, typeof sortedLessons>();
  for (const lesson of sortedLessons) {
    const existing = grouped.get(lesson.workingDir);
    if (existing) existing.push(lesson);
    else grouped.set(lesson.workingDir, [lesson]);
  }

  const workingDirs = [...grouped.keys()].sort((a, b) => {
    if (a === "*") return -1;
    if (b === "*") return 1;
    return a.localeCompare(b);
  });

  const lines: string[] = ["Lessons by working directory:"];
  for (const workingDir of workingDirs) {
    lines.push("");
    lines.push(`**${workingDir === "*" ? "*" : shortenHomePath(workingDir)}**`);
    for (const lesson of grouped.get(workingDir) ?? []) {
      lines.push(
        `- **${lesson.pattern}**: ${lesson.lesson} _(${formatGoalLessonAge(lesson.createdAt)})_`,
      );
    }
  }

  return lines.join("\n");
}

export async function handleGoalLessons(rawArg: string): Promise<string> {
  const action = parseGoalLessonsAction(rawArg);
  if (action.kind === "invalid") return GOAL_LESSONS_USAGE;

  if (action.kind === "clear") {
    const removed = clearLessons(action.workingDir);
    if (action.workingDir) {
      const displayDir = action.workingDir === "*" ? "*" : shortenHomePath(action.workingDir);
      return `Cleared ${removed} lesson(s) for \`${displayDir}\`.`;
    }
    return `Cleared ${removed} lesson(s) across all working directories.`;
  }

  return formatGoalLessonsList();
}

/** /goal_list -- list recent goal runs (Telegram-formatted code block). */
export async function handleGoalList(): Promise<string> {
  const runs = listRuns().slice(0, GOAL_LIST_LIMIT);
  if (runs.length === 0) return "No goal runs found.";

  const lines: string[] = ["```"];
  lines.push("ID       State               Steps Goal");
  lines.push("\u2500".repeat(58));
  for (const run of runs) {
    const id = run.runId.slice(0, 8);
    const state = run.state.padEnd(20);
    const steps =
      run.stepCount > 0 ? `${run.completedSteps}/${run.stepCount}`.padEnd(6) : "\u2014".padEnd(6);
    const goal = run.goal.length > 43 ? `${run.goal.slice(0, 40)}...` : run.goal;
    lines.push(`${id} ${state} ${steps}${goal}`);
  }
  lines.push("```");
  return lines.join("\n");
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
// Telegram reply delivery
// ---------------------------------------------------------------------------

export async function sendGoalReply(
  bot: Bot,
  chatId: number,
  markdown: string,
  runtime: RuntimeEnv,
  threadId?: number,
  replyToMessageId?: number,
): Promise<number | undefined> {
  if (!markdown.trim()) {
    const threadParams = threadId != null ? { message_thread_id: threadId } : {};
    const replyParams =
      replyToMessageId != null ? { reply_parameters: { message_id: replyToMessageId } } : {};
    const sent = await withTelegramApiErrorLogging({
      operation: "sendMessage",
      runtime,
      fn: () => bot.api.sendMessage(chatId, "No output.", { ...threadParams, ...replyParams }),
    });
    return sent?.message_id;
  }
  let lastMessageId: number | undefined;
  const chunks = markdownToTelegramChunks(markdown, 4000);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const threadParams = threadId != null ? { message_thread_id: threadId } : {};
    const replyParams =
      replyToMessageId != null && i === 0
        ? { reply_parameters: { message_id: replyToMessageId } }
        : {};
    const sent = await withTelegramApiErrorLogging({
      operation: "sendMessage",
      runtime,
      fn: () =>
        bot.api
          .sendMessage(chatId, chunk.html, {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
            ...threadParams,
            ...replyParams,
          })
          .catch(() =>
            bot.api.sendMessage(chatId, chunk.text, {
              link_preview_options: { is_disabled: true },
              ...threadParams,
              ...replyParams,
            }),
          ),
    });
    if (sent?.message_id != null) {
      lastMessageId = sent.message_id;
    }
  }
  return lastMessageId;
}

/** Send plan with inline keyboard, return last message ID for tracking. */
async function sendGoalPlanMessage(params: {
  bot: Bot;
  chatId: number;
  markdown: string;
  runtime: RuntimeEnv;
  runIdPrefix: string;
  revision: number;
  threadId?: number;
  replyToMessageId?: number;
}): Promise<number | undefined> {
  const { bot, chatId, markdown, runtime, runIdPrefix, revision, threadId, replyToMessageId } =
    params;
  if (!markdown.trim()) return undefined;

  const chunks = markdownToTelegramChunks(markdown, 4000);
  const replyMarkup = buildGoalInlineKeyboard(runIdPrefix, revision);
  let lastMessageId: number | undefined;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const isLast = i === chunks.length - 1;
    const threadParams = threadId != null ? { message_thread_id: threadId } : {};
    const keyboardParams = isLast && replyMarkup ? { reply_markup: replyMarkup } : {};
    const replyParams =
      replyToMessageId != null && i === 0
        ? { reply_parameters: { message_id: replyToMessageId } }
        : {};

    try {
      const sent = await bot.api.sendMessage(chatId, chunk.html, {
        parse_mode: "HTML",
        ...threadParams,
        ...replyParams,
        ...keyboardParams,
      });
      lastMessageId = sent.message_id;
    } catch {
      try {
        const sent = await bot.api.sendMessage(chatId, chunk.text, {
          ...threadParams,
          ...replyParams,
          ...keyboardParams,
        });
        lastMessageId = sent.message_id;
      } catch (err) {
        runtime.error?.(
          `telegram goal sendMessage failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  if (lastMessageId != null) {
    recordSentMessage(chatId, lastMessageId);
  }

  return lastMessageId;
}

/** Persist Telegram plan message tracking on a run. */
function persistTelegramPlanMessage(params: {
  runId: string;
  chatId: number;
  messageId: number;
  threadId?: number;
}): void {
  const run = loadRun(params.runId);
  if (!run) return;
  const oldMsgId = run.telegramPlanMessage?.messageId;
  const history = run.telegramPlanMessage?.messageHistory ?? [];
  if (oldMsgId) history.push(oldMsgId);
  run.telegramPlanMessage = {
    chatId: params.chatId,
    messageId: params.messageId,
    threadId: params.threadId,
    messageHistory: history,
  };
  saveRun(run);
  // Write-through to the in-memory message index
  indexPlanMessage(params.chatId, params.messageId, params.runId, oldMsgId);
}

const TELEGRAM_QUESTION_MESSAGE_CAP = 10;

/** Persist Telegram question/clarification message tracking on a run. */
function persistTelegramQuestionMessage(params: {
  runId: string;
  chatId: number;
  messageId: number;
  threadId?: number;
  requiredInputKey?: string;
}): void {
  const run = loadRun(params.runId);
  if (!run) return;
  const entry = {
    chatId: params.chatId,
    messageId: params.messageId,
    threadId: params.threadId,
    requiredInputKey: params.requiredInputKey,
  };
  const existing = run.telegramQuestionMessages ?? [];
  run.telegramQuestionMessages = [entry, ...existing].slice(0, TELEGRAM_QUESTION_MESSAGE_CAP);
  saveRun(run);
}

const TELEGRAM_EDIT_PROMPT_MESSAGE_CAP = 5;

/** Persist Telegram edit-prompt message tracking on a run (for ForceReply routing). */
function persistEditPromptMessage(params: {
  runId: string;
  chatId: number;
  messageId: number;
  threadId?: number;
}): void {
  const run = loadRun(params.runId);
  if (!run) return;
  const entry = {
    chatId: params.chatId,
    messageId: params.messageId,
    threadId: params.threadId,
  };
  const existing = run.telegramEditPromptMessages ?? [];
  run.telegramEditPromptMessages = [entry, ...existing].slice(0, TELEGRAM_EDIT_PROMPT_MESSAGE_CAP);
  saveRun(run);
}

/** Persist Telegram done message tracking on a run. */
function persistTelegramDoneMessage(params: {
  runId: string;
  chatId: number;
  messageId: number;
  threadId?: number;
}): void {
  const run = loadRun(params.runId);
  if (!run) return;
  run.telegramDoneMessage = {
    chatId: params.chatId,
    messageId: params.messageId,
    threadId: params.threadId,
  };
  saveRun(run);
}

/** Persist manual test suggestions on a run. */
function persistManualTests(
  runId: string,
  manualTests: ManualTestSuggestion[] | null | undefined,
  manualTestsError?: string,
): void {
  const run = loadRun(runId);
  if (!run) return;
  if (manualTests !== undefined && manualTests !== null) {
    run.manualTests = manualTests;
    delete run.manualTestsError;
  } else {
    delete run.manualTests;
    if (manualTestsError?.trim()) {
      run.manualTestsError = manualTestsError.trim();
    } else {
      delete run.manualTestsError;
    }
  }
  run.updatedAt = new Date().toISOString();
  saveRun(run);
}

const TELEGRAM_FEEDBACK_PROMPT_MESSAGE_CAP = 5;

/** Persist Telegram feedback-prompt message tracking on a run (for ForceReply routing). */
function persistFeedbackPromptMessage(params: {
  runId: string;
  chatId: number;
  messageId: number;
  threadId?: number;
}): void {
  const run = loadRun(params.runId);
  if (!run) return;
  const entry = {
    chatId: params.chatId,
    messageId: params.messageId,
    threadId: params.threadId,
  };
  const existing = run.telegramFeedbackPromptMessages ?? [];
  run.telegramFeedbackPromptMessages = [entry, ...existing].slice(
    0,
    TELEGRAM_FEEDBACK_PROMPT_MESSAGE_CAP,
  );
  saveRun(run);
}

// ---------------------------------------------------------------------------
// Exported send helper
// ---------------------------------------------------------------------------

/** Friendly display names for backend IDs. */
const BACKEND_DISPLAY_NAMES: Record<string, string> = {
  codex: "Codex",
  claude_code: "Claude Code",
  pi: "Pi",
};

const DEFAULT_BACKEND_DISPLAY = BACKEND_DISPLAY_NAMES.claude_code!;

/** Resolve which backend a step would use based on planner hints/default. */
function resolveStepWorker(step: import("../goal/types.js").PlanStep): string {
  const backend = step.backend ?? "claude_code";
  return BACKEND_DISPLAY_NAMES[backend] ?? DEFAULT_BACKEND_DISPLAY;
}

function formatPlannerFallbackLine(run: SerializedRun): string | undefined {
  const reason = run.plannerDegradedReason;
  if (!reason) return undefined;

  const reasonLabel =
    reason === "anthropic_usage_limit"
      ? "usage limit"
      : reason === "anthropic_rate_limit"
        ? "rate limit"
        : "availability issue";
  const resetSuffix = run.plannerDegradedResetHint ? ` (${run.plannerDegradedResetHint})` : "";
  return `Anthropic ${reasonLabel}${resetSuffix} -> Codex`;
}

function formatCaptionLabel(label: string, value: string): string {
  return `**${label}:** ${value}`;
}

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

/** Build a metadata caption header for plan messages. */
function buildCaptionHeader(result: GoalPlanResult): string {
  const lines: string[] = [];
  if (result.runId) {
    lines.push(formatCaptionLabel("Goal ID", result.runId.slice(0, 8)));
  }
  // Load run to get workingDir (already persisted before planning)
  const run = result.runId ? loadRun(result.runId) : undefined;
  if (run?.workingDir) {
    lines.push(formatCaptionLabel("Working dir", shortenHomePath(run.workingDir)));
  }
  const plannerFallbackLine = run ? formatPlannerFallbackLine(run) : undefined;
  if (plannerFallbackLine) {
    lines.push(formatCaptionLabel("Planner notice", plannerFallbackLine));
  }
  if (result.autocheckRounds != null && result.autocheckMaxRounds != null) {
    lines.push(
      formatCaptionLabel("Replanned", `${result.autocheckRounds}/${result.autocheckMaxRounds}`),
    );
    if (result.autocheckExhausted) {
      lines.push(
        formatCaptionLabel(
          "Autocheck warning",
          `hit max rounds (${result.autocheckRounds}/${result.autocheckMaxRounds})`,
        ),
      );
    }
  }
  if (result.autocheckSkipped) {
    lines.push("Note: Plan autocheck was skipped due to an error.");
  }
  if (result.plan) {
    // Resolve workers from classification + planner hints, deduplicated
    const workers = new Set<string>();
    for (const step of result.plan.steps) {
      workers.add(resolveStepWorker(step));
    }
    lines.push(formatCaptionLabel("Workers", [...workers].join(", ")));
    lines.push(
      formatCaptionLabel(
        "Plan",
        (typeof result.plan.shortSummary === "string" ? result.plan.shortSummary.trim() : "") ||
          result.plan.summary,
      ),
    );
  }
  return lines.join("\n");
}

export async function sendGoalPlanResult(params: {
  bot: Bot;
  chatId: number;
  runtime: RuntimeEnv;
  result: GoalPlanResult;
  threadId?: number;
  replyToMessageId?: number;
}): Promise<void> {
  const { bot, chatId, runtime, result, threadId, replyToMessageId } = params;
  if (result.runId && result.revision) {
    const runIdPrefix = result.runId.slice(0, 8);
    const replyMarkup = buildGoalInlineKeyboard(runIdPrefix, result.revision);

    try {
      // Build a rich caption header with metadata
      const captionHeader = result.plan
        ? buildCaptionHeader(result)
        : formatCaptionLabel("Plan", runIdPrefix);

      // Try to send plan DAG as a single PNG photo with inline keyboard
      if (result.plan) {
        const pngId = await sendDagPng({
          bot,
          chatId,
          threadId,
          runtime,
          plan: result.plan,
          steps: result.plan.steps,
          stepResults: result.stepResults,
          caption: captionHeader,
          replyMarkup,
          replyToMessageId,
        });
        if (pngId != null) {
          // Single-message success: photo with keyboard is the plan message
          persistTelegramPlanMessage({ runId: result.runId, chatId, messageId: pngId, threadId });
          if (process.env.MOLTBOT_DEBUG_TELEGRAM === "1") {
            warn(
              `telegram-goal: plan sent as single photo messageId=${pngId} (sendGoalPlanMessage skipped)`,
            );
          }
          return;
        }
      }

      // PNG failed — fall back to text message with Mermaid code block
      let markdown = captionHeader;
      if (result.plan) {
        let cpm: ReturnType<typeof computeCpm> | undefined;
        try {
          cpm = computeCpm(result.plan);
        } catch {
          /* non-critical */
        }
        const mermaidText = renderMermaid(result.plan, cpm, undefined, result.stepResults);
        markdown += `\n\n\`\`\`mermaid\n${mermaidText}\n\`\`\``;
      }

      if (process.env.MOLTBOT_DEBUG_TELEGRAM === "1") {
        warn("telegram-goal: PNG failed, falling back to sendGoalPlanMessage text");
      }

      const sentId = await sendGoalPlanMessage({
        bot,
        chatId,
        markdown,
        runtime,
        runIdPrefix,
        revision: result.revision,
        threadId,
        replyToMessageId,
      });
      if (sentId != null) {
        persistTelegramPlanMessage({
          runId: result.runId,
          chatId,
          messageId: sentId,
          threadId,
        });
        return;
      }
    } catch (deliveryErr) {
      warn(
        `[goal] plan delivery threw for ${runIdPrefix}: ${deliveryErr instanceof Error ? deliveryErr.message : String(deliveryErr)}`,
      );
    }

    // All delivery attempts failed — send a minimal fallback so the user is not left hanging
    warn(`[goal] plan delivery failed for ${runIdPrefix}; sending minimal fallback`);
    const threadParams = threadId != null ? { message_thread_id: threadId } : {};
    const replyParams =
      replyToMessageId != null ? { reply_parameters: { message_id: replyToMessageId } } : {};
    await bot.api
      .sendMessage(
        chatId,
        `Plan ready for review (Goal ID: ${runIdPrefix}). Use /goal_detail ${runIdPrefix} to view.`,
        { ...threadParams, ...replyParams, reply_markup: replyMarkup },
      )
      .catch(() => {});
  } else if (result.runId && result.blocked) {
    // Question/clarification message — track for reply-to-answer routing
    const sentId = await sendGoalReply(
      bot,
      chatId,
      result.text,
      runtime,
      threadId,
      replyToMessageId,
    );
    if (sentId != null) {
      const run = loadRun(result.runId);
      persistTelegramQuestionMessage({
        runId: result.runId,
        chatId,
        messageId: sentId,
        threadId,
        requiredInputKey: run?.blocked?.requiredInputKey,
      });
    }
  } else {
    await sendGoalReply(bot, chatId, result.text, runtime, threadId, replyToMessageId);
  }
}

export async function sendGoalBackgroundResult(
  params: {
    bot: Bot;
    chatId: number;
    runtime: RuntimeEnv;
    threadId?: number;
    replyToMessageId?: number;
  },
  reply: GoalPlanResult | string | undefined,
): Promise<void> {
  if (reply == null) return;
  if (typeof reply === "string") {
    await sendGoalReply(
      params.bot,
      params.chatId,
      reply,
      params.runtime,
      params.threadId,
      params.replyToMessageId,
    );
    return;
  }
  await sendGoalPlanResult({
    bot: params.bot,
    chatId: params.chatId,
    runtime: params.runtime,
    result: reply,
    threadId: params.threadId,
    replyToMessageId: params.replyToMessageId,
  });
}

// ---------------------------------------------------------------------------
// DAG PNG delivery (status-coloured Mermaid diagram via Telegram photo)
// ---------------------------------------------------------------------------

const TELEGRAM_CAPTION_LIMIT = 1024;

function splitTelegramCaption(caption: string): { caption: string; remainder?: string } {
  const fullCaptionHtml = markdownToTelegramHtml(caption);
  if (fullCaptionHtml.length <= TELEGRAM_CAPTION_LIMIT) return { caption: fullCaptionHtml };

  // Keep the split based on rendered HTML length (Telegram's parse_mode content)
  // while preserving markdown remainder for sendGoalReply chunking.
  let lo = 0;
  let hi = caption.length;
  let splitAt = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = caption.slice(0, mid);
    const candidateHtml = markdownToTelegramHtml(candidate);
    if (candidateHtml.length <= TELEGRAM_CAPTION_LIMIT) {
      splitAt = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const preferred = caption.lastIndexOf("\n", splitAt);
  const minSplit = Math.floor(TELEGRAM_CAPTION_LIMIT * 0.6);
  const effectiveSplitAt = preferred >= minSplit ? preferred : splitAt;
  const headMarkdown = caption.slice(0, effectiveSplitAt).trimEnd();
  const tailMarkdown = caption.slice(effectiveSplitAt).trimStart();
  const headHtml = markdownToTelegramHtml(headMarkdown);

  if (!headMarkdown) {
    const fallbackHead = caption.slice(0, 1);
    return {
      caption: markdownToTelegramHtml(fallbackHead),
      remainder: caption.slice(1).trimStart(),
    };
  }
  return { caption: headHtml, remainder: tailMarkdown || undefined };
}

async function sendDagPng(params: {
  bot: Bot;
  chatId: number;
  threadId?: number;
  runtime: RuntimeEnv;
  plan: Plan;
  steps: PlanStep[];
  stepResults?: ReadonlyMap<string, StepResult>;
  caption: string;
  replyMarkup?: InlineKeyboardMarkup;
  replyToMessageId?: number;
}): Promise<number | undefined> {
  const {
    bot,
    chatId,
    threadId,
    runtime,
    plan,
    steps,
    stepResults,
    caption,
    replyMarkup,
    replyToMessageId,
  } = params;
  const threadParams = threadId != null ? { message_thread_id: threadId } : {};
  const replyParams =
    replyToMessageId != null ? { reply_parameters: { message_id: replyToMessageId } } : {};

  const displayStatuses = computeDisplayStatuses(steps);
  let cpm: ReturnType<typeof computeCpm> | undefined;
  try {
    cpm = computeCpm(plan);
  } catch {
    // CPM not critical for visual output
  }
  const mermaidText = renderMermaid(plan, cpm, displayStatuses, stepResults);
  const pngBuffer = renderMermaidToPng(mermaidText);

  if (pngBuffer) {
    // Keep PNG rendering ahead of any text chunking/fallback logic.
    const split = splitTelegramCaption(caption);
    try {
      const sent = await bot.api.sendPhoto(chatId, new InputFile(pngBuffer, "dag.png"), {
        caption: split.caption,
        parse_mode: "HTML",
        ...threadParams,
        ...replyParams,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
      if (process.env.MOLTBOT_DEBUG_TELEGRAM === "1") {
        warn(`telegram-goal: sendDagPng OK messageId=${sent.message_id} chatId=${chatId}`);
      }
      if (split.remainder) {
        await sendGoalReply(bot, chatId, split.remainder, runtime, threadId);
      }
      return sent.message_id;
    } catch {
      // Fall through to text fallback
    }
  }

  // Fallback: send Mermaid code block as text
  return await sendGoalReply(
    bot,
    chatId,
    `${caption}\n\n\`\`\`mermaid\n${mermaidText}\n\`\`\``,
    runtime,
    threadId,
    replyToMessageId,
  );
}

/** Build an onStatusChange callback wired to a specific Telegram chat. */
export function buildOnStatusChange(params: {
  bot: Bot;
  chatId: number;
  threadId?: number;
  runtime: RuntimeEnv;
  runId: string;
}): (event: GoalStatusChangeEvent) => Promise<void> {
  const { bot, chatId, threadId, runtime, runId } = params;
  const prefix = runId.slice(0, 8);
  const threadParams = threadId != null ? { message_thread_id: threadId } : {};
  return async (event: GoalStatusChangeEvent) => {
    const run = loadRun(runId);
    const plan = run?.plan;
    if (!plan) return;
    const stepResults = serializedStepResultsToMap(run);
    const sendDeliveryFallback = async () => {
      const msg = `⚠️ Goal ${prefix}: ${event.type} - update delivery failed, check /goal_status`;
      await bot.api.sendMessage(chatId, msg, { ...threadParams }).catch(() => {});
    };

    if (event.type === "step_blocked") {
      try {
        const caption = [
          `**TASK BLOCKED** (${prefix}): Step ${event.stepId} needs input`,
          "",
          event.question,
          "",
          `**Next:** I will continue to complete tasks that aren't dependent on this blocked task.`,
        ].join("\n");
        const sentId = await sendDagPng({
          bot,
          chatId,
          threadId,
          runtime,
          plan,
          steps: event.steps,
          stepResults,
          caption,
          replyMarkup: buildTaskBlockedInlineKeyboard(prefix),
        });
        // Persist the photo message ID so reply-to routing works
        if (sentId != null) {
          persistTelegramQuestionMessage({
            runId,
            chatId,
            messageId: sentId,
            threadId,
            requiredInputKey: `task:${event.stepId}:input`,
          });
        }
      } catch {
        await sendDeliveryFallback();
      }
    } else if (event.type === "fully_blocked") {
      try {
        const lines: string[] = [
          `**GOAL BLOCKED** (${prefix}): no runnable steps — waiting for answers.`,
        ];
        const blocked = event.steps.filter((s) => s.status === "blocked");
        if (blocked.length > 0) {
          lines.push("");
          for (const s of blocked.slice(0, 3)) {
            lines.push(`• Step ${s.id}: ${s.blockedQuestion ?? s.blockedReason ?? "needs input"}`);
          }
          if (blocked.length > 3) lines.push(`  …and ${blocked.length - 3} more`);
        }
        const sentId = await sendDagPng({
          bot,
          chatId,
          threadId,
          runtime,
          plan,
          steps: event.steps,
          stepResults,
          caption: lines.join("\n"),
          replyMarkup: buildGoalBlockedInlineKeyboard(prefix),
        });
        if (sentId != null) {
          const blockedSteps =
            blocked.length > 0 ? blocked : event.steps.filter((s) => s.status === "blocked");
          const requiredInputKey =
            blockedSteps.length <= 1
              ? blockedSteps[0]
                ? `task:${blockedSteps[0].id}:input`
                : undefined
              : `tasks:${blockedSteps.map((s) => s.id).join(",")}:input`;
          persistTelegramQuestionMessage({
            runId,
            chatId,
            messageId: sentId,
            threadId,
            requiredInputKey,
          });
        }
      } catch {
        await sendDeliveryFallback();
      }
    } else if (event.type === "plan_revised") {
      try {
        await sendDagPng({
          bot,
          chatId,
          threadId,
          runtime,
          plan,
          steps: event.steps,
          stepResults,
          caption: event.summary,
        });
      } catch {
        await sendDeliveryFallback();
      }
    } else if (event.type === "all_done") {
      try {
        persistManualTests(runId, event.manualTests, event.manualTestsError);
        const baseCaption = appendManualTestGenerationFailureNotice(
          event.summary,
          event.manualTestsError,
        );
        const caption = event.prUrl
          ? `${baseCaption}\n\n📎 Review on GitHub: ${event.prUrl}`
          : baseCaption;
        const sentId = await sendDagPng({
          bot,
          chatId,
          threadId,
          runtime,
          plan,
          steps: event.steps,
          stepResults,
          caption,
          replyMarkup: buildGoalDoneInlineKeyboard(prefix),
        });
        if (sentId != null) {
          persistTelegramDoneMessage({
            runId,
            chatId,
            messageId: sentId,
            threadId,
          });
        }
      } catch {
        await sendDeliveryFallback();
      }
    }
  };
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
        `Goal \`${resolvedId.slice(0, 8)}\` is already being processed (${lockResult.existingLabel ?? "unknown"}).`,
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
      await bot.api.answerCallbackQuery(ctx.callbackQuery.id).catch(() => {});
      const [, action, runIdPrefix] = planMatch;
      const chatId = ctx.callbackQuery.message?.chat.id;
      if (!chatId) return;
      const messageId = ctx.callbackQuery.message?.message_id;
      const threadId = (ctx.callbackQuery.message as { message_thread_id?: number } | undefined)
        ?.message_thread_id;

      // React with the corresponding emoji on the plan message
      // (Plan detail should not set a reaction.)
      if (messageId && action !== "gD") {
        const emoji: ReactionTypeEmoji["emoji"] =
          action === "ga"
            ? "\u2764" // ❤ for approve
            : action === "gr"
              ? "\uD83D\uDC4E" // 👎 for reject
              : "\u270D"; // ✍ for edit
        await bot.api
          .setMessageReaction(chatId, messageId, [{ type: "emoji", emoji }])
          .catch(() => {});
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
          .catch(() => undefined);
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
      await bot.api.answerCallbackQuery(ctx.callbackQuery.id).catch(() => {});
      const [, action, runIdPrefix] = doneMatch;
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
      const run = loadRun(resolvedId);
      if (!run) {
        await sendGoalReply(bot, chatId, `Run file missing: ${resolvedId}`, runtime, threadId);
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
        .catch(() => undefined);
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
      await bot.api.answerCallbackQuery(ctx.callbackQuery.id).catch(() => {});
      const [, runIdPrefix] = blockedDetailsMatch;
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

      const run = loadRun(resolvedId);
      if (!run) {
        await sendGoalReply(bot, chatId, `Run file missing: ${resolvedId}`, runtime, threadId);
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
        .catch(() => undefined);
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
      await bot.api.answerCallbackQuery(ctx.callbackQuery.id).catch(() => {});
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
          .catch(() => {});
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
          `Goal \`${run.runId.slice(0, 8)}\` is already being processed (${lockResult.existingLabel ?? "unknown"}).`,
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
      await sendGoalReply(bot, chatId, reply, runtime, threadId);
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
            await sendGoalReply(bot, resolved.chatId, result, runtime, resolved.threadIdForSend);
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
      const rawCommand = (msg.text ?? "").trim().slice(1).split(/\s+/, 1)[0] ?? "";
      const commandName = rawCommand.split("@")[0] || "new_goal";
      commandFragmentBuffer.bufferCommand(key, {
        commandName,
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
    await writeConfigFile(nextConfig);

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
    await writeConfigFile(nextConfig);

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
    await writeConfigFile(nextConfig);

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
    const rawId = ctx.match?.trim() ?? "";
    if (!rawId) {
      await sendGoalReply(
        bot,
        resolved.chatId,
        "Usage: /goal_approve <runId>",
        runtime,
        resolved.threadIdForSend,
      );
      return;
    }
    await startGoalResume({
      rawId,
      chatId: resolved.chatId,
      threadId: resolved.threadIdForSend,
      replyToMessageId: ctx.message?.message_id,
      lockLabel: "approve",
      backgroundLabel: "goal_approve",
    });
  });

  // /goal_resume <runId> (alias of /goal_approve)
  bot.command("goal_resume", async (ctx: TelegramGoalCommandContext) => {
    const resolved = await authAndResolve(ctx);
    if (!resolved) return;
    const rawId = ctx.match?.trim() ?? "";
    if (!rawId) {
      await sendGoalReply(
        bot,
        resolved.chatId,
        "Usage: /goal_resume <runId>",
        runtime,
        resolved.threadIdForSend,
      );
      return;
    }
    await startGoalResume({
      rawId,
      chatId: resolved.chatId,
      threadId: resolved.threadIdForSend,
      replyToMessageId: ctx.message?.message_id,
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
        `Goal \`${editRunId.slice(0, 8)}\` is already being processed (${editLock.existingLabel ?? "unknown"}).`,
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
    const raw = ctx.match?.trim() ?? "";
    const spaceIdx = raw.indexOf(" ");
    if (spaceIdx === -1) {
      await sendGoalReply(
        bot,
        resolved.chatId,
        "Usage: /goal_answer <runId> <value>",
        runtime,
        resolved.threadIdForSend,
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
      );
      return;
    }
    const answerLock = acquireGoalOpLock(answerRunId, "answer");
    if (!answerLock.acquired) {
      await sendGoalReply(
        bot,
        resolved.chatId,
        `Goal \`${answerRunId.slice(0, 8)}\` is already being processed (${answerLock.existingLabel ?? "unknown"}).`,
        runtime,
        resolved.threadIdForSend,
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
      releaseGoalLock: answerLock.release,
      fn: () => handleGoalAnswer(answerRunIdRaw, value, statusCb, cfg),
      onResult: async (result) => {
        if (result == null) return;
        if (typeof result === "string") {
          await sendGoalReply(bot, resolved.chatId, result, runtime, resolved.threadIdForSend);
        } else {
          await sendPlanResult(resolved.chatId, result, resolved.threadIdForSend);
        }
      },
    });
  });

  // /goal_feedback <runId> <feedback>
  bot.command("goal_feedback", async (ctx: TelegramGoalCommandContext) => {
    const resolved = await authAndResolve(ctx);
    if (!resolved) return;
    const raw = ctx.match?.trim() ?? "";
    const spaceIdx = raw.indexOf(" ");
    if (spaceIdx === -1) {
      await sendGoalReply(
        bot,
        resolved.chatId,
        "Usage: /goal_feedback <runId> <feedback>",
        runtime,
        resolved.threadIdForSend,
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
      );
      return;
    }
    const feedbackLock = acquireGoalOpLock(feedbackRunId, "feedback");
    if (!feedbackLock.acquired) {
      await sendGoalReply(
        bot,
        resolved.chatId,
        `Goal \`${feedbackRunId.slice(0, 8)}\` is already being processed (${feedbackLock.existingLabel ?? "unknown"}).`,
        runtime,
        resolved.threadIdForSend,
      );
      return;
    }
    runGoalInBackground({
      bot,
      chatId: resolved.chatId,
      threadId: resolved.threadIdForSend,
      runtime,
      label: "goal_feedback",
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
          await sendGoalReply(bot, resolved.chatId, result, runtime, resolved.threadIdForSend);
        } else {
          await sendPlanResult(resolved.chatId, result, resolved.threadIdForSend);
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
    const reply = await handleGoalLessons(ctx.match?.trim() ?? "");
    await sendGoalReply(
      bot,
      resolved.chatId,
      reply,
      runtime,
      resolved.threadIdForSend,
      ctx.message?.message_id,
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
