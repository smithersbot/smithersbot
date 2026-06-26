import { InputFile, type Bot } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";

import { warn } from "../globals.js";
import { getCodexAskForApprovalPlacement } from "../goal/backend-availability.js";
import { buildClaudeCodeEnv, buildCredentialStrippedEnv } from "../goal/claude-code-env.js";
import { CLAUDE_ALLOWED_TOOLS_READ_ONLY } from "../goal/claude-code-constants.js";
import { runCliProcess } from "../goal/cli-process.js";
import { computeCpm } from "../goal/cpm.js";
import { computeDisplayStatuses } from "../goal/execution-status.js";
import { renderMermaid } from "../goal/mermaid-render.js";
import {
  renderMermaidToPng,
  repairMermaidDiagram,
  type MermaidRenderResult,
} from "../goal/mermaid-png.js";
import { extractGoalBriefSection, loadGoalBriefContent } from "../goal/goal-brief.js";
import { loadRun, saveRun } from "../goal/run-store.js";
import { resolveClaudeBinary } from "../goal/scout.js";
import type {
  BlockedDetail,
  ManualTestSuggestion,
  Plan,
  GoalImageFailureReason,
  PlanStep,
  PlannerBackendId,
  SerializedRun,
  StepResult,
} from "../goal/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { redactSecretValues } from "../security/secret-paths.js";
import { shortenHomePath } from "../utils.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { markdownToTelegramChunks, markdownToTelegramHtml } from "./format.js";
import {
  buildBlockedCaption,
  buildBlockedSurfaceCopy,
  buildGoalBlockedInlineKeyboard,
  buildTaskBlockedInlineKeyboard,
  classifyBlockedNotification,
} from "./goal-blocked-ui.js";
import { indexPlanMessage } from "./goal-message-index.js";
import { buildInlineKeyboard } from "./send.js";
import { recordSentMessage } from "./sent-message-cache.js";
import type { GoalPlanResult } from "./goal-commands.js";

// ---------------------------------------------------------------------------
// Telegram reply delivery
// ---------------------------------------------------------------------------

type SendMessageOptions = Parameters<Bot["api"]["sendMessage"]>[2];
type SendPhotoOptions = Parameters<Bot["api"]["sendPhoto"]>[2];
type SendMessageResult = Awaited<ReturnType<Bot["api"]["sendMessage"]>>;
type SendPhotoResult = Awaited<ReturnType<Bot["api"]["sendPhoto"]>>;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isStaleReplyTargetError(err: unknown): boolean {
  const message = describeError(err).toLowerCase();
  return (
    (message.includes("reply") || message.includes("replied")) &&
    (message.includes("not found") ||
      message.includes("not exist") ||
      message.includes("message_id_invalid") ||
      message.includes("replied message not found"))
  );
}

function withReplyTarget<T extends Record<string, unknown>>(params: {
  base: T;
  threadId?: number;
  replyToMessageId?: number;
}): T & { message_thread_id?: number; reply_parameters?: { message_id: number } } {
  return {
    ...params.base,
    ...(params.threadId != null ? { message_thread_id: params.threadId } : {}),
    ...(params.replyToMessageId != null
      ? { reply_parameters: { message_id: params.replyToMessageId } }
      : {}),
  };
}

function withoutReplyParameters<T extends { reply_parameters?: unknown }>(options: T): T {
  const { reply_parameters: _replyParameters, ...rest } = options;
  return rest as T;
}

export async function sendGoalTelegramMessage(params: {
  bot: Bot;
  chatId: number;
  text: string;
  runtime: RuntimeEnv;
  threadId?: number;
  replyToMessageId?: number;
  options?: SendMessageOptions;
  operation?: string;
}): Promise<SendMessageResult> {
  const operation = params.operation ?? "sendMessage";
  const options = withReplyTarget({
    base: params.options ?? {},
    threadId: params.threadId,
    replyToMessageId: params.replyToMessageId,
  });
  try {
    return await params.bot.api.sendMessage(params.chatId, params.text, options);
  } catch (err) {
    if (params.replyToMessageId != null && isStaleReplyTargetError(err)) {
      params.runtime.error?.(
        `telegram goal ${operation} reply target ${params.replyToMessageId} rejected; retrying without reply_parameters: ${describeError(err)}`,
      );
      return params.bot.api.sendMessage(
        params.chatId,
        params.text,
        withoutReplyParameters(options),
      );
    }
    throw err;
  }
}

async function sendGoalTelegramHtmlMessage(params: {
  bot: Bot;
  chatId: number;
  html: string;
  text: string;
  runtime: RuntimeEnv;
  threadId?: number;
  replyToMessageId?: number;
  options?: SendMessageOptions;
  operation?: string;
}): Promise<SendMessageResult> {
  try {
    return await sendGoalTelegramMessage({
      ...params,
      text: params.html,
      options: { ...params.options, parse_mode: "HTML" },
    });
  } catch {
    return sendGoalTelegramMessage({
      ...params,
      text: params.text,
      options: { ...params.options, parse_mode: undefined },
    });
  }
}

export async function sendGoalTelegramPhoto(params: {
  bot: Bot;
  chatId: number;
  photo: InputFile;
  runtime: RuntimeEnv;
  threadId?: number;
  replyToMessageId?: number;
  options?: SendPhotoOptions;
  operation?: string;
}): Promise<SendPhotoResult> {
  const operation = params.operation ?? "sendPhoto";
  const options = withReplyTarget({
    base: params.options ?? {},
    threadId: params.threadId,
    replyToMessageId: params.replyToMessageId,
  });
  try {
    return await params.bot.api.sendPhoto(params.chatId, params.photo, options);
  } catch (err) {
    if (params.replyToMessageId != null && isStaleReplyTargetError(err)) {
      params.runtime.error?.(
        `telegram goal ${operation} reply target ${params.replyToMessageId} rejected; retrying without reply_parameters: ${describeError(err)}`,
      );
      return params.bot.api.sendPhoto(params.chatId, params.photo, withoutReplyParameters(options));
    }
    throw err;
  }
}

export async function sendGoalReply(
  bot: Bot,
  chatId: number,
  markdown: string,
  runtime: RuntimeEnv,
  threadId?: number,
  replyToMessageId?: number,
  replyMarkup?: InlineKeyboardMarkup,
  renderOptions?: { headingStyle?: "none" | "bold"; compact?: boolean },
): Promise<number | undefined> {
  const safeMarkdown = redactSecretValues(markdown);
  if (!safeMarkdown.trim()) {
    const sent = await withTelegramApiErrorLogging({
      operation: "sendMessage",
      runtime,
      fn: () =>
        sendGoalTelegramMessage({
          bot,
          chatId,
          text: "No output.",
          runtime,
          threadId,
          replyToMessageId,
          options: replyMarkup ? { reply_markup: replyMarkup } : {},
        }),
    });
    return sent?.message_id;
  }
  let lastMessageId: number | undefined;
  const chunks = markdownToTelegramChunks(safeMarkdown, 4000, renderOptions);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const isLast = i === chunks.length - 1;
    const keyboardParams = isLast && replyMarkup ? { reply_markup: replyMarkup } : {};
    const sent = await withTelegramApiErrorLogging({
      operation: "sendMessage",
      runtime,
      fn: () =>
        sendGoalTelegramHtmlMessage({
          bot,
          chatId,
          html: chunk.html,
          text: chunk.text,
          runtime,
          threadId,
          replyToMessageId: i === 0 ? replyToMessageId : undefined,
          options: {
            link_preview_options: { is_disabled: true },
            ...keyboardParams,
          },
        }),
    });
    if (sent?.message_id != null) {
      lastMessageId = sent.message_id;
    }
  }
  return lastMessageId;
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
      { text: "\uD83D\uDCD8 Goal Brief", callback_data: `gB:${runIdPrefix}:${revision}` },
      { text: "\u270F\uFE0F Edit Plan", callback_data: `ge:${runIdPrefix}:${revision}` },
    ],
  ]);
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
  const safeMarkdown = redactSecretValues(markdown);
  if (!safeMarkdown.trim()) return undefined;

  const chunks = markdownToTelegramChunks(safeMarkdown, 4000);
  const replyMarkup = buildGoalInlineKeyboard(runIdPrefix, revision);
  let lastMessageId: number | undefined;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const isLast = i === chunks.length - 1;
    const keyboardParams = isLast && replyMarkup ? { reply_markup: replyMarkup } : {};

    try {
      const sent = await sendGoalTelegramHtmlMessage({
        bot,
        chatId,
        html: chunk.html,
        text: chunk.text,
        runtime,
        threadId,
        replyToMessageId: i === 0 ? replyToMessageId : undefined,
        options: keyboardParams,
      });
      lastMessageId = sent.message_id;
    } catch (err) {
      runtime.error?.(`telegram goal sendMessage failed: ${describeError(err)}`);
    }
  }

  if (lastMessageId != null) {
    recordSentMessage(chatId, lastMessageId);
  }

  return lastMessageId;
}

/** Persist Telegram plan message tracking on a run. */
export function persistTelegramPlanMessage(params: {
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
export function persistTelegramQuestionMessage(params: {
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
export function persistEditPromptMessage(params: {
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
export function persistTelegramDoneMessage(params: {
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
export function persistManualTests(
  runId: string,
  manualTests: ManualTestSuggestion[] | null | undefined,
  manualTestsError?: string,
): void {
  const run = loadRun(runId);
  if (!run) return;
  if (manualTests !== undefined && manualTests !== null) {
    run.manualTests = manualTests.map((test) => ({
      ...test,
      description: redactSecretValues(test.description),
      reason: test.reason == null ? undefined : redactSecretValues(test.reason),
      detail: redactSecretValues(test.detail),
    }));
    delete run.manualTestsError;
  } else {
    delete run.manualTests;
    if (manualTestsError?.trim()) {
      run.manualTestsError = redactSecretValues(manualTestsError.trim());
    } else {
      delete run.manualTestsError;
    }
  }
  run.updatedAt = new Date().toISOString();
  saveRun(run);
}

/** Persist failed Telegram completion notification state on a run. */
export function persistCompletionDeliveryFailure(runId: string, deliveryError: string): void {
  const run = loadRun(runId);
  if (!run) return;
  run.deliveryFailed = true;
  run.deliveryError = redactSecretValues(deliveryError.trim() || "unknown delivery failure");
  run.updatedAt = new Date().toISOString();
  saveRun(run);
}

/** Persist failed Telegram DAG image generation/send state on a run. */
export function persistGoalImageFailure(params: {
  runId: string;
  reason: GoalImageFailureReason;
  error: string;
}): void {
  const run = loadRun(params.runId);
  if (!run) return;
  const at = new Date().toISOString();
  const event = {
    reason: params.reason,
    error: redactSecretValues(params.error.trim() || "unknown image failure"),
    at,
  };
  run.imageFailure = {
    ...event,
    events: [...(run.imageFailure?.events ?? []), event].slice(-10),
  };
  run.updatedAt = at;
  saveRun(run);
}

const TELEGRAM_FEEDBACK_PROMPT_MESSAGE_CAP = 5;

/** Persist Telegram feedback-prompt message tracking on a run (for ForceReply routing). */
export function persistFeedbackPromptMessage(params: {
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

export type GoalDagDeliveryResult =
  | { ok: true; path: "image" | "text" | "minimal"; messageId: number }
  | { ok: false; error: string };

export async function sendGoalDagWithFallback(params: {
  bot: Bot;
  chatId: number;
  threadId?: number;
  runtime: RuntimeEnv;
  runId?: string;
  plan: Plan;
  steps: PlanStep[];
  stepResults?: ReadonlyMap<string, StepResult>;
  caption: string;
  textMarkdown?: string;
  minimalMarkdown?: string;
  replyMarkup?: InlineKeyboardMarkup;
  replyToMessageId?: number;
  textReplyToMessageId?: number | null;
  minimalReplyToMessageId?: number | null;
}): Promise<GoalDagDeliveryResult> {
  const failures: string[] = [];
  try {
    const imageMessageId = await sendDagPng({
      bot: params.bot,
      chatId: params.chatId,
      threadId: params.threadId,
      runtime: params.runtime,
      runId: params.runId,
      plan: params.plan,
      steps: params.steps,
      stepResults: params.stepResults,
      caption: params.caption,
      replyMarkup: params.replyMarkup,
      replyToMessageId: params.replyToMessageId,
    });
    if (imageMessageId != null) {
      return { ok: true, path: "image", messageId: imageMessageId };
    }
    failures.push("image delivery returned no message");
  } catch (err) {
    failures.push(`image delivery threw: ${describeError(err)}`);
  }

  const textMarkdown = params.textMarkdown ?? params.caption;
  if (textMarkdown.trim()) {
    try {
      const textMessageId = await sendGoalReply(
        params.bot,
        params.chatId,
        textMarkdown,
        params.runtime,
        params.threadId,
        params.textReplyToMessageId !== undefined
          ? (params.textReplyToMessageId ?? undefined)
          : params.replyToMessageId,
        params.replyMarkup,
      );
      if (textMessageId != null) {
        return { ok: true, path: "text", messageId: textMessageId };
      }
      failures.push("text fallback returned no message");
    } catch (err) {
      failures.push(`text fallback threw: ${describeError(err)}`);
    }
  }

  if (params.minimalMarkdown?.trim()) {
    try {
      const minimalMessageId = await sendGoalReply(
        params.bot,
        params.chatId,
        params.minimalMarkdown,
        params.runtime,
        params.threadId,
        params.minimalReplyToMessageId !== undefined
          ? (params.minimalReplyToMessageId ?? undefined)
          : params.replyToMessageId,
        params.replyMarkup,
      );
      if (minimalMessageId != null) {
        return { ok: true, path: "minimal", messageId: minimalMessageId };
      }
      failures.push("minimal fallback returned no message");
    } catch (err) {
      failures.push(`minimal fallback threw: ${describeError(err)}`);
    }
  }

  return { ok: false, error: failures.join("; ") || "goal delivery failed" };
}

export function formatGoalDagTextFallback(params: {
  plan: Plan;
  caption: string;
  stepResults?: ReadonlyMap<string, StepResult>;
}): string {
  let cpm: ReturnType<typeof computeCpm> | undefined;
  try {
    cpm = computeCpm(params.plan);
  } catch {
    /* non-critical; renderMermaid can render without CPM styling */
  }
  const mermaidText = renderMermaid(params.plan, cpm, undefined, params.stepResults);
  return `${params.caption}\n\n\`\`\`mermaid\n${mermaidText}\n\`\`\``;
}

// ---------------------------------------------------------------------------
// Exported send helpers
// ---------------------------------------------------------------------------

/** Friendly display names for backend IDs. */
const BACKEND_DISPLAY_NAMES: Record<string, string> = {
  codex: "Codex",
  claude_code: "Claude Code",
  pi: "Pi",
};

const DEFAULT_BACKEND_DISPLAY = BACKEND_DISPLAY_NAMES.claude_code!;

/** Resolve which backend a step would use based on planner hints/default. */
function resolveStepWorker(step: PlanStep): string {
  const backend = step.executedBackend ?? step.backend ?? "claude_code";
  return BACKEND_DISPLAY_NAMES[backend] ?? DEFAULT_BACKEND_DISPLAY;
}

function formatPlannerFallbackLine(run: SerializedRun): string | undefined {
  const reason = run.plannerDegradedReason;
  if (!reason) return undefined;

  if (reason === "anthropic_overloaded") {
    return "Anthropic Claude Code temporarily overloaded (529/provider 5xx) -> Codex";
  }
  const reasonLabel = reason === "anthropic_usage_limit" ? "usage limit" : "rate limit";
  const resetSuffix = run.plannerDegradedResetHint ? ` (${run.plannerDegradedResetHint})` : "";
  return `Anthropic ${reasonLabel}${resetSuffix} -> Codex`;
}

function formatCaptionLabel(label: string, value: string): string {
  return `**${label}:** ${value}`;
}

/** Plan-specific summary text (the short plan summary, full summary fallback). */
function planSummaryText(plan: Plan): string {
  return (typeof plan.shortSummary === "string" ? plan.shortSummary.trim() : "") || plan.summary;
}

/**
 * Full-goal summary from the run's Goal Brief. Prefers the brief's "Goal
 * Summary" section, falling back to "Long Goal Summary". Returns undefined when
 * the brief is missing/empty so callers can fall back to the plan summary.
 */
function resolveGoalBriefSummary(run: SerializedRun | undefined): string | undefined {
  if (!run) return undefined;
  const brief = loadGoalBriefContent(run);
  if (!brief.ok) return undefined;
  const section =
    extractGoalBriefSection(brief.content, ["Goal Summary"]) ??
    extractGoalBriefSection(brief.content, ["Long Goal Summary"]);
  const summary = section?.replace(/\s+/g, " ").trim();
  return summary ? summary : undefined;
}

/** Build a metadata caption header for plan messages. */
function buildCaptionHeader(result: GoalPlanResult): string {
  const lines: string[] = [];
  // Load run early: the Goal Summary line, workspace, planner notice, and plan
  // number all derive from it (the run was persisted before planning).
  const run = result.runId ? loadRun(result.runId) : undefined;
  const planNumber = run?.planNumber ?? 1;

  if (result.plan) {
    // Goal Summary is the FULL-goal summary from the Goal Brief — not the
    // plan-specific summary. Fall back to the plan summary only when the brief
    // is missing/empty.
    lines.push(
      formatCaptionLabel(
        "Goal Summary",
        resolveGoalBriefSummary(run) ?? planSummaryText(result.plan),
      ),
    );
    // The plan-specific summary lives on its own Plan N line, directly beneath
    // the Goal Summary and before the Goal ID.
    lines.push(formatCaptionLabel(`Plan ${planNumber}`, planSummaryText(result.plan)));
  }
  if (result.runId) {
    lines.push(formatCaptionLabel("Goal ID", result.runId.slice(0, 8)));
  }
  if (run?.workingDir) {
    lines.push(formatCaptionLabel("Workspace", shortenHomePath(run.workingDir)));
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
    const reason = result.autocheckSkipReason ? `: ${result.autocheckSkipReason}` : "";
    lines.push(`Note: Plan autocheck was skipped due to an error${reason}.`);
  }
  if (result.plan) {
    // Resolve workers from classification + planner hints, deduplicated
    const workers = new Set<string>();
    for (const step of result.plan.steps) {
      workers.add(resolveStepWorker(step));
    }
    lines.push(formatCaptionLabel("Workers", [...workers].join(", ")));
  }
  return lines.join("\n");
}

export async function sendBlockedNotification(params: {
  bot: Bot;
  chatId: number;
  threadId?: number;
  runtime: RuntimeEnv;
  runId: string;
  plan: Plan;
  steps: PlanStep[];
  stepResults?: ReadonlyMap<string, StepResult>;
  blockedDetail: BlockedDetail;
  replyToMessageId?: number;
}): Promise<number | undefined> {
  const {
    bot,
    chatId,
    threadId,
    runtime,
    runId,
    plan,
    steps,
    stepResults,
    blockedDetail,
    replyToMessageId,
  } = params;

  const runIdPrefix = runId.slice(0, 8);
  const blockedCaption = buildBlockedCaption(steps);
  // Drive the surface — keyboard, title and action hint — from the derived
  // user-facing category so task-level and goal-level behave consistently.
  const level = blockedDetail.stepId ? "task" : "goal";
  const category = classifyBlockedNotification(steps, blockedDetail);
  const planningDecision =
    blockedDetail.blockedAt === "planning" &&
    !!blockedDetail.decisions &&
    blockedDetail.decisions.length > 0;
  const keyboardOpts = { planningDecision };
  const replyMarkup =
    level === "task"
      ? buildTaskBlockedInlineKeyboard(runIdPrefix, category, keyboardOpts)
      : buildGoalBlockedInlineKeyboard(runIdPrefix, category, keyboardOpts);
  const copy = buildBlockedSurfaceCopy({
    level,
    category,
    runIdPrefix,
    stepId: blockedDetail.stepId,
    blockedAt: blockedDetail.blockedAt,
    decisions: blockedDetail.decisions,
  });
  const body = copy.body ?? (blockedCaption || blockedDetail.prompt);
  // Planning-decision blocks omit copy.title (the bold "Decision(s) Needed:" in
  // body is the only heading) — filter empty parts so no leading blank lines.
  const caption = [copy.title, body, copy.actionHint].filter(Boolean).join("\n\n");

  const delivery = await sendGoalDagWithFallback({
    bot,
    chatId,
    threadId,
    runtime,
    runId,
    plan,
    steps,
    stepResults,
    caption,
    textMarkdown: caption,
    minimalMarkdown: [copy.title, copy.actionHint].filter(Boolean).join("\n\n"),
    replyMarkup,
    replyToMessageId,
  });
  const messageId = delivery.ok ? delivery.messageId : undefined;
  if (!delivery.ok) {
    runtime.error?.(`telegram goal blocked notification delivery failed: ${delivery.error}`);
  }

  if (messageId != null) {
    persistTelegramQuestionMessage({
      runId,
      chatId,
      messageId,
      threadId,
      requiredInputKey: blockedDetail.requiredInputKey,
    });
  }

  return messageId;
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
  // A run cancelled by /goal_stop is already reported by the stop flow's single
  // authoritative response; suppress the redundant "Goal was stopped." notice.
  if (result.cancelled) return;
  if (result.runId && result.revision) {
    const runIdPrefix = result.runId.slice(0, 8);
    const replyMarkup = buildGoalInlineKeyboard(runIdPrefix, result.revision);
    let deliveryError = "goal delivery failed";

    // Build a rich caption header with metadata.
    const captionHeader = redactSecretValues(
      result.plan ? buildCaptionHeader(result) : formatCaptionLabel("Plan", runIdPrefix),
    );

    try {
      if (result.plan) {
        const delivery = await sendGoalDagWithFallback({
          bot,
          chatId,
          threadId,
          runtime,
          runId: result.runId,
          plan: result.plan,
          steps: result.plan.steps,
          stepResults: result.stepResults,
          caption: captionHeader,
          textMarkdown: formatGoalDagTextFallback({
            plan: result.plan,
            caption: captionHeader,
            stepResults: result.stepResults,
          }),
          minimalMarkdown: `Plan ready for review (Goal ID: ${runIdPrefix}). Use /goal_detail ${runIdPrefix} to view.`,
          replyMarkup,
          replyToMessageId,
          // Text/minimal fallbacks must not depend on the original message
          // still being a valid reply target.
          textReplyToMessageId: null,
          minimalReplyToMessageId: null,
        });
        if (delivery.ok) {
          persistTelegramPlanMessage({
            runId: result.runId,
            chatId,
            messageId: delivery.messageId,
            threadId,
          });
          if (process.env.MOLTBOT_DEBUG_TELEGRAM === "1") {
            warn(
              `telegram-goal: plan delivered via ${delivery.path} messageId=${delivery.messageId}`,
            );
          }
          return;
        }
        deliveryError = delivery.error;
      } else {
        const sentId = await sendGoalPlanMessage({
          bot,
          chatId,
          markdown: captionHeader,
          runtime,
          runIdPrefix,
          revision: result.revision,
          threadId,
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
        deliveryError = "plan text delivery returned no message";
      }
    } catch (deliveryErr) {
      deliveryError =
        deliveryErr instanceof Error ? deliveryErr.message : String(deliveryErr) || deliveryError;
      warn(
        `[goal] plan delivery threw for ${runIdPrefix}: ${deliveryErr instanceof Error ? deliveryErr.message : String(deliveryErr)}`,
      );
    }

    warn(`[goal] plan delivery failed for ${runIdPrefix}: ${deliveryError}`);
    persistCompletionDeliveryFailure(result.runId, deliveryError);
  } else if (result.runId && result.blocked) {
    // Question/clarification message — track for reply-to-answer routing
    const replyMarkup =
      result.decisions && result.decisions.length > 0
        ? buildGoalBlockedInlineKeyboard(result.runId.slice(0, 8), "blocked", {
            planningDecision: true,
          })
        : undefined;
    const sentId = await sendGoalReply(
      bot,
      chatId,
      redactSecretValues(result.text),
      runtime,
      threadId,
      replyToMessageId,
      replyMarkup,
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
    await sendGoalReply(
      bot,
      chatId,
      redactSecretValues(result.text),
      runtime,
      threadId,
      replyToMessageId,
    );
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

const MERMAID_REPAIR_TIMEOUT_MS = 60_000;

function recordDagImageFailure(params: {
  runtime: RuntimeEnv;
  runId?: string;
  reason: GoalImageFailureReason;
  error: string;
}): void {
  const message = redactSecretValues(params.error.trim() || "unknown image failure");
  params.runtime.error?.(`telegram goal DAG image ${params.reason}: ${message}`);
  if (params.runId) {
    persistGoalImageFailure({
      runId: params.runId,
      reason: params.reason,
      error: message,
    });
  }
}

function buildCodexMermaidRepairArgs(params: {
  workingDir: string;
  prompt: string;
  model?: string;
}): string[] {
  const askForApprovalPlacement = getCodexAskForApprovalPlacement();
  const args = [
    ...(askForApprovalPlacement === "before_exec" ? ["--ask-for-approval", "never"] : []),
    "exec",
    ...(askForApprovalPlacement === "after_exec" ? ["--ask-for-approval", "never"] : []),
    "--sandbox",
    "workspace-write",
    "--cd",
    params.workingDir,
    "-c",
    "net.allowed=true",
  ];
  if (params.model) args.push("--model", params.model);
  args.push(params.prompt);
  return args;
}

function extractCliErrorDetail(stdout: string, stderr: string): string {
  const detail = (stderr || stdout).trim();
  return detail || "unknown CLI failure";
}

async function askPlannerBackendForMermaidRepair(params: {
  backend: PlannerBackendId;
  workingDir: string;
  prompt: string;
  model?: string;
}): Promise<string> {
  if (params.backend === "codex") {
    const result = await runCliProcess({
      command: "codex",
      args: buildCodexMermaidRepairArgs({
        workingDir: params.workingDir,
        prompt: params.prompt,
        model: params.model,
      }),
      cwd: params.workingDir,
      timeoutMs: MERMAID_REPAIR_TIMEOUT_MS,
      env: buildCredentialStrippedEnv(process.env, { stripAuthKeys: true }),
    });
    if (result.timedOut || (result.exitCode && result.exitCode !== 0) || result.signal) {
      throw new Error(extractCliErrorDetail(result.stdout, result.stderr));
    }
    return result.stdout.trim();
  }

  const claudeBinary = resolveClaudeBinary();
  if (!claudeBinary) {
    throw new Error("claude binary not found on PATH");
  }
  const args = ["-p", "--allowedTools", CLAUDE_ALLOWED_TOOLS_READ_ONLY];
  if (params.model) args.push("--model", params.model);
  const result = await runCliProcess({
    command: claudeBinary,
    args,
    cwd: params.workingDir,
    timeoutMs: MERMAID_REPAIR_TIMEOUT_MS,
    stdin: params.prompt,
    claudeDriverSite: "goal-sending",
    env: buildClaudeCodeEnv("subscription"),
  });
  if (result.timedOut || (result.exitCode && result.exitCode !== 0) || result.signal) {
    throw new Error(extractCliErrorDetail(result.stdout, result.stderr));
  }
  return result.stdout.trim();
}

export async function sendDagPng(params: {
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
  runId?: string;
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
    runId,
  } = params;
  const displayStatuses = computeDisplayStatuses(steps);
  let cpm: ReturnType<typeof computeCpm> | undefined;
  try {
    cpm = computeCpm(plan);
  } catch {
    // CPM not critical for visual output
  }
  const mermaidText = renderMermaid(plan, cpm, displayStatuses, stepResults);
  const renderResult: MermaidRenderResult = renderMermaidToPng(mermaidText);
  let pngBuffer: Buffer | undefined;

  if (renderResult && "buffer" in renderResult) {
    pngBuffer = renderResult.buffer;
  } else if (renderResult && "error" in renderResult) {
    recordDagImageFailure({
      runtime,
      runId,
      reason: "render-syntax-failure",
      error: renderResult.error,
    });
    if (!runId) {
      recordDagImageFailure({
        runtime,
        runId,
        reason: "repair-unavailable",
        error: "runId unavailable for Mermaid repair",
      });
      return undefined;
    }
    const run = loadRun(runId);
    const backend = run?.plannerBackendUsed;
    if (!run?.workingDir || !backend) {
      const missing = [
        !run ? "run" : undefined,
        run && !run.workingDir ? "workingDir" : undefined,
        run && !backend ? "plannerBackendUsed" : undefined,
      ]
        .filter(Boolean)
        .join(", ");
      recordDagImageFailure({
        runtime,
        runId,
        reason: "repair-unavailable",
        error: `Mermaid repair unavailable: missing ${missing || "repair context"}`,
      });
      return undefined;
    }
    let repaired: Buffer | null | undefined;
    try {
      repaired = await repairMermaidDiagram({
        source: mermaidText,
        error: renderResult.error,
        askFn: (prompt) =>
          askPlannerBackendForMermaidRepair({
            backend,
            workingDir: run.workingDir,
            prompt,
            model: run.model,
          }),
      });
    } catch (err) {
      recordDagImageFailure({
        runtime,
        runId,
        reason: "repair-failure",
        error: describeError(err),
      });
      return undefined;
    }
    if (!repaired) {
      recordDagImageFailure({
        runtime,
        runId,
        reason: "repair-failure",
        error: "Mermaid repair did not produce a PNG",
      });
      return undefined;
    }
    pngBuffer = repaired;
  } else {
    recordDagImageFailure({
      runtime,
      runId,
      reason: "render-timeout",
      error: "Mermaid PNG renderer timed out",
    });
    return undefined;
  }

  const split = splitTelegramCaption(caption);
  try {
    const sent = await sendGoalTelegramPhoto({
      bot,
      chatId,
      photo: new InputFile(pngBuffer, "dag.png"),
      runtime,
      threadId,
      replyToMessageId,
      options: {
        caption: split.caption,
        parse_mode: "HTML",
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      },
    });
    if (process.env.MOLTBOT_DEBUG_TELEGRAM === "1") {
      warn(`telegram-goal: sendDagPng OK messageId=${sent.message_id} chatId=${chatId}`);
    }
    if (split.remainder) {
      await sendGoalReply(bot, chatId, split.remainder, runtime, threadId, replyToMessageId);
    }
    return sent.message_id;
  } catch (err) {
    recordDagImageFailure({
      runtime,
      runId,
      reason: "photo-send-failure",
      error: describeError(err),
    });
    return undefined;
  }
}
