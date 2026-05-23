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
import { loadRun, saveRun } from "../goal/run-store.js";
import { resolveClaudeBinary } from "../goal/scout.js";
import type {
  BlockedDetail,
  ManualTestSuggestion,
  Plan,
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
  buildGoalBlockedInlineKeyboard,
  buildTaskBlockedInlineKeyboard,
} from "./goal-blocked-ui.js";
import { indexPlanMessage } from "./goal-message-index.js";
import { buildInlineKeyboard } from "./send.js";
import { recordSentMessage } from "./sent-message-cache.js";
import type { GoalPlanResult } from "./goal-commands.js";

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
  replyMarkup?: InlineKeyboardMarkup,
): Promise<number | undefined> {
  const safeMarkdown = redactSecretValues(markdown);
  if (!safeMarkdown.trim()) {
    const threadParams = threadId != null ? { message_thread_id: threadId } : {};
    const replyParams =
      replyToMessageId != null ? { reply_parameters: { message_id: replyToMessageId } } : {};
    const keyboardParams = replyMarkup ? { reply_markup: replyMarkup } : {};
    const sent = await withTelegramApiErrorLogging({
      operation: "sendMessage",
      runtime,
      fn: () =>
        bot.api.sendMessage(chatId, "No output.", {
          ...threadParams,
          ...replyParams,
          ...keyboardParams,
        }),
    });
    return sent?.message_id;
  }
  let lastMessageId: number | undefined;
  const chunks = markdownToTelegramChunks(safeMarkdown, 4000);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const isLast = i === chunks.length - 1;
    const threadParams = threadId != null ? { message_thread_id: threadId } : {};
    const keyboardParams = isLast && replyMarkup ? { reply_markup: replyMarkup } : {};
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
            ...keyboardParams,
          })
          .catch(() =>
            bot.api.sendMessage(chatId, chunk.text, {
              link_preview_options: { is_disabled: true },
              ...threadParams,
              ...replyParams,
              ...keyboardParams,
            }),
          ),
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
      { text: "\u270F\uFE0F Request changes", callback_data: `ge:${runIdPrefix}:${revision}` },
      { text: "\uD83D\uDC4E Reject", callback_data: `gr:${runIdPrefix}:${revision}` },
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

/** Build a metadata caption header for plan messages. */
function buildCaptionHeader(result: GoalPlanResult): string {
  const lines: string[] = [];
  if (result.runId) {
    lines.push(formatCaptionLabel("Goal ID", result.runId.slice(0, 8)));
  }
  // Load run to get workingDir (already persisted before planning)
  const run = result.runId ? loadRun(result.runId) : undefined;
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
  const replyMarkup = blockedDetail.stepId
    ? buildTaskBlockedInlineKeyboard(runIdPrefix)
    : buildGoalBlockedInlineKeyboard(runIdPrefix);
  const isUserInputBlock = blockedDetail.requiredInputKey !== "resume_execution";
  const title = blockedDetail.stepId
    ? isUserInputBlock
      ? `**TASK BLOCKED** (${runIdPrefix}): Step ${blockedDetail.stepId} needs input`
      : `**TASK INTERRUPTED** (${runIdPrefix}): Step ${blockedDetail.stepId} needs resume`
    : isUserInputBlock
      ? `**GOAL BLOCKED** (${runIdPrefix}): no runnable steps - waiting for answers.`
      : `**GOAL INTERRUPTED** (${runIdPrefix}): worker failed/interrupted - resume needed.`;
  const caption = blockedCaption
    ? `${title}\n\n${blockedCaption}`
    : `${title}\n\n${blockedDetail.prompt}`;

  let messageId: number | undefined;
  try {
    messageId = await sendDagPng({
      bot,
      chatId,
      threadId,
      runtime,
      runId,
      plan,
      steps,
      stepResults,
      caption,
      replyMarkup,
      replyToMessageId,
    });
  } catch (err) {
    runtime.error?.(
      `telegram goal sendBlockedNotification DAG failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    messageId = undefined;
  }

  if (messageId == null) {
    messageId = await sendGoalReply(
      bot,
      chatId,
      caption,
      runtime,
      threadId,
      replyToMessageId,
      replyMarkup,
    );
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

    try {
      // Build a rich caption header with metadata
      const captionHeader = redactSecretValues(
        result.plan ? buildCaptionHeader(result) : formatCaptionLabel("Plan", runIdPrefix),
      );

      // Try to send plan DAG as a single PNG photo with inline keyboard
      if (result.plan) {
        const pngId = await sendDagPng({
          bot,
          chatId,
          threadId,
          runtime,
          runId: result.runId,
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
      redactSecretValues(result.text),
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
  const renderResult: MermaidRenderResult = renderMermaidToPng(mermaidText);
  let pngBuffer: Buffer | undefined;

  if (renderResult && "buffer" in renderResult) {
    pngBuffer = renderResult.buffer;
  } else if (renderResult && "error" in renderResult) {
    if (!runId) return undefined;
    const run = loadRun(runId);
    const backend = run?.plannerBackendUsed;
    if (!run?.workingDir || !backend) return undefined;
    const repaired = await repairMermaidDiagram({
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
    if (!repaired) return undefined;
    pngBuffer = repaired;
  } else {
    // Timeout render path: let caller fall back to keyboarded text plan delivery.
    return undefined;
  }

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
      await sendGoalReply(bot, chatId, split.remainder, runtime, threadId, replyToMessageId);
    }
    return sent.message_id;
  } catch (err) {
    runtime.error?.(
      `telegram goal sendPhoto failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}
