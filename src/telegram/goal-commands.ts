import { InputFile, type Bot, type Context } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";

import { resolveEnvApiKey } from "../agents/model-auth.js";
import { warn } from "../globals.js";
import { type ChatAction, logTyping, startTypingLoop } from "./typing-loop.js";
import { JsonExitError } from "../cli/cli-utils.js";
import { goalCommand } from "../commands/goal.js";
import { goalAnswerCommand } from "../commands/goal-answer.js";
import { goalResumeCommand } from "../commands/goal-resume.js";
import { goalStatusCommand } from "../commands/goal-status.js";
import type { ChannelGroupPolicy } from "../config/group-policy.js";
import type { MoltbotConfig } from "../config/config.js";
import type {
  TelegramAccountConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "../config/types.js";
import type { GoalStatusChangeEvent } from "../goal/agent-executor.js";
import { computeCpm } from "../goal/cpm.js";
import { formatGoalError } from "../goal/errors.js";
import { computeDisplayStatuses } from "../goal/execution-status.js";
import { formatPlanOutput } from "../goal/format-output.js";
import { createGoalLlmClient } from "../goal/llm-client.js";
import { renderMermaid } from "../goal/mermaid-render.js";
import { renderMermaidToPng } from "../goal/mermaid-png.js";
import {
  generatePlan,
  generatePlanRevision,
  PlanParseError,
  persistRawPlanResponse,
} from "../goal/planner.js";
import { listRuns, loadRun, resolveRunId, saveRun } from "../goal/run-store.js";
import type { Plan, PlanStep, SerializedRun } from "../goal/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { markdownToTelegramChunks } from "./format.js";
import { buildInlineKeyboard } from "./send.js";
import { recordSentMessage } from "./sent-message-cache.js";
import { resolveTelegramCommandAuth } from "./telegram-auth.js";

// ---------------------------------------------------------------------------
// Telegram command menu entries for the goal subsystem
// ---------------------------------------------------------------------------

export const GOAL_COMMAND_SPECS: Array<{ command: string; description: string }> = [
  { command: "new_goal", description: "Plan a new goal (shows plan for approval)" },
  { command: "goal_approve", description: "Approve and execute a goal plan" },
  { command: "goal_reject", description: "Reject a goal plan" },
  { command: "goal_edit", description: "Edit a goal plan" },
  { command: "goal_status", description: "Show goal run details" },
  { command: "goal_answer", description: "Answer a goal's clarification question" },
  { command: "goal_list", description: "List recent goal runs" },
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
};

// ---------------------------------------------------------------------------
// Inline keyboard builder
// ---------------------------------------------------------------------------

function buildGoalInlineKeyboard(runIdPrefix: string, revision: number) {
  return buildInlineKeyboard([
    [
      { text: "\u2764\uFE0F Approve", callback_data: `ga:${runIdPrefix}:${revision}` },
      { text: "\uD83D\uDC4D Approve", callback_data: `gA:${runIdPrefix}:${revision}` },
    ],
    [
      { text: "\u270F\uFE0F Request changes", callback_data: `ge:${runIdPrefix}:${revision}` },
      { text: "\uD83D\uDC4E Reject", callback_data: `gr:${runIdPrefix}:${revision}` },
    ],
  ]);
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
// Lookup helper: find a run by its Telegram plan message ID
// ---------------------------------------------------------------------------

export function findRunByPlanMessageId(
  chatId: number,
  messageId: number,
): SerializedRun | undefined {
  for (const summary of listRuns()) {
    const run = loadRun(summary.runId);
    if (!run?.telegramPlanMessage) continue;
    if (run.telegramPlanMessage.chatId !== chatId) continue;
    if (run.telegramPlanMessage.messageId === messageId) return run;
    if (run.telegramPlanMessage.messageHistory?.includes(messageId)) return run;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Handler functions (exported for testing)
// ---------------------------------------------------------------------------

/** /goal <text> -- generate a plan (planOnly mode). */
export async function handleGoal(text: string): Promise<GoalPlanResult> {
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
      },
      cap.runtime,
    );

    const logs = cap.getLogs();
    const errors = cap.getErrors();
    const parts: string[] = [];

    if (logs) parts.push(logs);
    if (errors) parts.push(errors);

    if (outcome?.status === "needs_clarification" || outcome?.status === "blocked") {
      parts.push(`\nAnswer: /goal_answer ${runId.slice(0, 8)} <your answer>`);
      return { text: parts.join("\n") || "More information needed.", runId, blocked: true };
    }

    // Successful plan — load plan for PNG rendering in sendGoalPlanResult
    const savedRun = loadRun(runId);
    parts.push(`\nRun ID: \`${runId.slice(0, 8)}\``);
    return {
      text: parts.join("\n") || "No plan output.",
      runId,
      revision: 1,
      plan: savedRun?.plan ?? undefined,
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
): Promise<string | GoalPlanResult | undefined> {
  if (!rawId.trim()) {
    return "Usage: /goal_approve <runId>";
  }

  const resolvedId = resolveRunId(rawId.trim());
  if (!resolvedId) return `Run not found: ${rawId.trim()}`;

  // Idempotent state check
  const run = loadRun(resolvedId);
  if (!run) return `Run file missing: ${resolvedId}`;
  if (run.state === "done" || run.state === "executing") {
    return "Run is already executing or complete.";
  }
  if (run.state === "rejected") {
    return "Run was rejected. Start a new /goal.";
  }

  const prefix = resolvedId.slice(0, 8);
  const stepCount = run.plan?.steps?.length ?? 0;
  const cap = createCaptureRuntime();
  try {
    const outcome = await goalResumeCommand(
      resolvedId,
      { yes: true, quiet: true, onStatusChange },
      cap.runtime,
    );

    const errors = cap.getErrors();
    if (errors) return errors;

    if (outcome?.status === "failed") {
      return `Run failed: ${outcome.error}`;
    }

    // When onStatusChange is wired, it already sent DAG PNGs for blocked/done —
    // return undefined so callers don't send a stray message after the notifications.
    if (onStatusChange) return undefined;

    if (outcome?.status === "blocked" || outcome?.status === "needs_clarification") {
      return `Executing: ${prefix} (0/${stepCount}). I'll notify you if input is needed.`;
    }

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

  // Idempotent: already rejected is a no-op
  if (run.state === "rejected") {
    return "Run is already rejected.";
  }
  if (run.state !== "awaiting_approval") {
    return `Cannot reject: run is in "${run.state}" state.`;
  }

  run.state = "rejected";
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
    await goalStatusCommand(rawId.trim(), { diagram: "none" }, cap.runtime);
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

/** /goal_answer <runId> <value> -- answer a blocked/needs_clarification goal's question. */
export async function handleGoalAnswer(
  rawId: string,
  value: string,
  onStatusChange?: (event: GoalStatusChangeEvent) => void | Promise<void>,
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
    try {
      const outcome = await goalResumeCommand(
        resolvedId,
        { yes: true, quiet: true, onStatusChange },
        cap.runtime,
      );

      const errors = cap.getErrors();
      if (errors) return errors;

      if (onStatusChange) return undefined;

      if (outcome?.status === "failed") {
        return `Run failed: ${outcome.error}`;
      }

      return `Resuming interrupted run: ${prefix}...`;
    } catch (err) {
      if (err instanceof RuntimeExitError || err instanceof JsonExitError) {
        return cap.getErrors() || "Resume command failed.";
      }
      return formatGoalError(err, resolvedId);
    }
  }

  if (run.state !== "blocked" && run.state !== "needs_clarification") {
    return `Run is not awaiting input (state: ${run.state}).`;
  }
  if (!run.blocked) {
    return `Run is in "${run.state}" but has no blocked details.`;
  }

  // needs_clarification: re-run planning with the answer as additional context
  if (run.state === "needs_clarification") {
    const keyResult = resolveEnvApiKey("anthropic");
    if (!keyResult) return "No Anthropic API key found. Set ANTHROPIC_API_KEY.";

    const client = createGoalLlmClient({ apiKey: keyResult.apiKey, modelOverride: run.model });
    const enrichedGoal = `${run.goal}\n\nAdditional context: ${value}`;

    // Save the answer
    run.answers[run.blocked.requiredInputKey] = value;
    run.updatedAt = new Date().toISOString();
    saveRun(run);

    try {
      const planResult = await generatePlan(client, enrichedGoal);

      if ("blocked" in planResult) {
        // Still needs clarification — update question
        run.blocked = { prompt: planResult.question, requiredInputKey: "step:planning:input" };
        run.updatedAt = new Date().toISOString();
        saveRun(run);
        return {
          text: `Still need more info:\n\n${planResult.question}\n\nAnswer: /goal_answer ${resolvedId.slice(0, 8)} <your answer>`,
          runId: resolvedId,
          blocked: true,
        };
      }

      // Plan succeeded — transition to awaiting_approval
      run.plan = planResult;
      run.state = "awaiting_approval";
      run.blocked = null;
      run.planRevision = (run.planRevision ?? 0) + 1;
      run.updatedAt = new Date().toISOString();
      saveRun(run);

      const planText = formatPlanOutput(planResult, { diagram: "none", format: "md" });
      const parts: string[] = [planText, `\nRun ID: \`${resolvedId.slice(0, 8)}\``];
      return {
        text: parts.join("\n"),
        runId: resolvedId,
        revision: run.planRevision,
        plan: planResult,
      };
    } catch (err) {
      if (err instanceof PlanParseError) {
        persistRawPlanResponse(resolvedId, err.rawResponse);
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

    if (outcome?.status === "failed") {
      return `Run failed: ${outcome.error}`;
    }

    // When onStatusChange is wired, it already sent DAG PNGs for blocked/done —
    // return undefined so callers don't send a stray message after the notifications.
    if (onStatusChange) return undefined;

    if (outcome?.status === "blocked" || outcome?.status === "needs_clarification") {
      return `Resuming: ${prefix}...`;
    }

    return `Resuming: ${prefix}...`;
  } catch (err) {
    if (err instanceof RuntimeExitError || err instanceof JsonExitError) {
      return cap.getErrors() || "Answer command failed.";
    }
    return formatGoalError(err, resolvedId);
  }
}

const GOAL_LIST_LIMIT = 15;

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
    const goal = run.goal.length > 22 ? `${run.goal.slice(0, 19)}...` : run.goal;
    lines.push(`${id} ${state} ${steps}${goal}`);
  }
  lines.push("```");
  return lines.join("\n");
}

/** /goal_edit <runId> <instructions> -- revise a plan via LLM re-planning. */
export async function handleGoalEdit(rawId: string, instructions: string): Promise<GoalPlanResult> {
  if (!rawId.trim() || !instructions.trim()) {
    return { text: "Usage: /goal_edit <runId> <edit instructions>" };
  }

  const resolvedId = resolveRunId(rawId.trim());
  if (!resolvedId) return { text: `Run not found: ${rawId.trim()}` };

  const run = loadRun(resolvedId);
  if (!run) return { text: `Run file missing: ${resolvedId}` };

  if (run.state !== "awaiting_approval") {
    return { text: `Cannot edit: run is in "${run.state}" state (expected "awaiting_approval").` };
  }
  if (!run.plan) {
    return { text: "Run has no plan to edit." };
  }

  const keyResult = resolveEnvApiKey("anthropic");
  if (!keyResult) {
    return { text: "No Anthropic API key found. Set ANTHROPIC_API_KEY." };
  }

  const client = createGoalLlmClient({ apiKey: keyResult.apiKey, modelOverride: run.model });

  try {
    const result = await generatePlanRevision(client, run.goal, run.plan, instructions.trim());

    if ("blocked" in result) {
      return { text: `Revision blocked: ${result.question}`, blocked: true };
    }

    // Update run with new plan revision
    const oldRevision = run.planRevision ?? 1;
    const newRevision = oldRevision + 1;
    const history = run.planHistory ?? [];
    history.push({
      revision: oldRevision,
      plan: run.plan,
      editInstructions: instructions.trim(),
    });

    run.plan = result;
    run.planRevision = newRevision;
    run.activePlanRevision = newRevision;
    run.planHistory = history;
    run.updatedAt = new Date().toISOString();
    saveRun(run);

    const planText = formatPlanOutput(result, { diagram: "none", format: "md" });
    const parts: string[] = [];
    parts.push(`**Revision ${newRevision}**\n`);
    parts.push(planText);
    parts.push(`\nRun ID: \`${resolvedId.slice(0, 8)}\``);

    return { text: parts.join("\n"), runId: resolvedId, revision: newRevision, plan: result };
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
): Promise<number | undefined> {
  if (!markdown.trim()) {
    const threadParams = threadId != null ? { message_thread_id: threadId } : {};
    const sent = await withTelegramApiErrorLogging({
      operation: "sendMessage",
      runtime,
      fn: () => bot.api.sendMessage(chatId, "No output.", threadParams),
    });
    return sent?.message_id;
  }
  let lastMessageId: number | undefined;
  const chunks = markdownToTelegramChunks(markdown, 4000);
  for (const chunk of chunks) {
    const threadParams = threadId != null ? { message_thread_id: threadId } : {};
    const sent = await withTelegramApiErrorLogging({
      operation: "sendMessage",
      runtime,
      fn: () =>
        bot.api
          .sendMessage(chatId, chunk.html, { parse_mode: "HTML", ...threadParams })
          .catch(() => bot.api.sendMessage(chatId, chunk.text, threadParams)),
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
}): Promise<number | undefined> {
  const { bot, chatId, markdown, runtime, runIdPrefix, revision, threadId } = params;
  if (!markdown.trim()) return undefined;

  const chunks = markdownToTelegramChunks(markdown, 4000);
  const replyMarkup = buildGoalInlineKeyboard(runIdPrefix, revision);
  let lastMessageId: number | undefined;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const isLast = i === chunks.length - 1;
    const threadParams = threadId != null ? { message_thread_id: threadId } : {};
    const keyboardParams = isLast && replyMarkup ? { reply_markup: replyMarkup } : {};

    try {
      const sent = await bot.api.sendMessage(chatId, chunk.html, {
        parse_mode: "HTML",
        ...threadParams,
        ...keyboardParams,
      });
      lastMessageId = sent.message_id;
    } catch {
      try {
        const sent = await bot.api.sendMessage(chatId, chunk.text, {
          ...threadParams,
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

// ---------------------------------------------------------------------------
// Exported send helper
// ---------------------------------------------------------------------------

export async function sendGoalPlanResult(params: {
  bot: Bot;
  chatId: number;
  runtime: RuntimeEnv;
  result: GoalPlanResult;
  threadId?: number;
}): Promise<void> {
  const { bot, chatId, runtime, result, threadId } = params;
  if (result.runId && result.revision) {
    const runIdPrefix = result.runId.slice(0, 8);
    const replyMarkup = buildGoalInlineKeyboard(runIdPrefix, result.revision);

    // Try to send plan DAG as a single PNG photo with inline keyboard
    if (result.plan) {
      const pngId = await sendDagPng({
        bot,
        chatId,
        threadId,
        runtime,
        plan: result.plan,
        steps: result.plan.steps,
        caption: `Plan: ${result.plan.summary}`,
        replyMarkup,
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
    let markdown = result.text;
    if (result.plan) {
      let cpm: ReturnType<typeof computeCpm> | undefined;
      try {
        cpm = computeCpm(result.plan);
      } catch {
        /* non-critical */
      }
      const mermaidText = renderMermaid(result.plan, cpm);
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
    });
    if (sentId != null) {
      persistTelegramPlanMessage({
        runId: result.runId,
        chatId,
        messageId: sentId,
        threadId,
      });
    }
  } else if (result.runId && result.blocked) {
    // Question/clarification message — track for reply-to-answer routing
    const sentId = await sendGoalReply(bot, chatId, result.text, runtime, threadId);
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
    await sendGoalReply(bot, chatId, result.text, runtime, threadId);
  }
}

// ---------------------------------------------------------------------------
// DAG PNG delivery (status-coloured Mermaid diagram via Telegram photo)
// ---------------------------------------------------------------------------

async function sendDagPng(params: {
  bot: Bot;
  chatId: number;
  threadId?: number;
  runtime: RuntimeEnv;
  plan: Plan;
  steps: PlanStep[];
  caption: string;
  replyMarkup?: InlineKeyboardMarkup;
}): Promise<number | undefined> {
  const { bot, chatId, threadId, runtime, plan, steps, caption, replyMarkup } = params;
  const threadParams = threadId != null ? { message_thread_id: threadId } : {};

  const displayStatuses = computeDisplayStatuses(steps);
  let cpm: ReturnType<typeof computeCpm> | undefined;
  try {
    cpm = computeCpm(plan);
  } catch {
    // CPM not critical for visual output
  }
  const mermaidText = renderMermaid(plan, cpm, displayStatuses);
  const pngBuffer = renderMermaidToPng(mermaidText);

  if (pngBuffer) {
    try {
      const sent = await bot.api.sendPhoto(chatId, new InputFile(pngBuffer, "dag.png"), {
        caption,
        ...threadParams,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
      if (process.env.MOLTBOT_DEBUG_TELEGRAM === "1") {
        warn(`telegram-goal: sendDagPng OK messageId=${sent.message_id} chatId=${chatId}`);
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
  return async (event: GoalStatusChangeEvent) => {
    const run = loadRun(runId);
    const plan = run?.plan;
    if (!plan) return;

    if (event.type === "step_blocked") {
      const caption = [
        `BLOCKED (${prefix}): Step ${event.stepId} needs input`,
        "",
        event.question,
        "",
        `Next: /goal_answer ${prefix} <your answer>`,
      ].join("\n");
      const sentId = await sendDagPng({
        bot,
        chatId,
        threadId,
        runtime,
        plan,
        steps: event.steps,
        caption,
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
    } else if (event.type === "fully_blocked") {
      const lines: string[] = [
        `FULLY BLOCKED (${prefix}): no runnable steps — waiting for answers.`,
      ];
      const blocked = event.steps.filter((s) => s.status === "blocked");
      if (blocked.length > 0) {
        lines.push("");
        for (const s of blocked.slice(0, 3)) {
          lines.push(`• Step ${s.id}: ${s.blockedQuestion ?? s.blockedReason ?? "needs input"}`);
        }
        if (blocked.length > 3) lines.push(`  …and ${blocked.length - 3} more`);
      }
      lines.push("");
      lines.push(`Next: /goal_answer ${prefix} <answer>`);
      await sendDagPng({
        bot,
        chatId,
        threadId,
        runtime,
        plan,
        steps: event.steps,
        caption: lines.join("\n"),
      });
    } else if (event.type === "all_done") {
      await sendDagPng({
        bot,
        chatId,
        threadId,
        runtime,
        plan,
        steps: event.steps,
        caption: `DONE (${prefix}): ${event.summary}`,
      });
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
};

const APPROVE_EMOJIS = new Set(["\u2764", "\u2764\uFE0F", "\uD83D\uDC4D"]);
const REJECT_EMOJIS = new Set(["\uD83D\uDC4E"]);

export function registerTelegramGoalCommands({
  bot,
  cfg,
  runtime,
  telegramCfg,
  allowFrom,
  groupAllowFrom,
  useAccessGroups,
  resolveGroupPolicy,
  resolveTelegramGroupConfig,
  shouldSkipUpdate,
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
  ): Promise<void> {
    await sendGoalPlanResult({ bot, chatId, runtime, result, threadId });
  }

  // -----------------------------------------------------------------------
  // Callback query handler for inline buttons
  // -----------------------------------------------------------------------
  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    const match = /^(ga|gA|gr|ge):([a-f0-9-]+):(\d+)$/.exec(data);
    if (!match) {
      await next?.();
      return;
    }

    await bot.api.answerCallbackQuery(ctx.callbackQuery.id).catch(() => {});
    const [, action, runIdPrefix] = match;
    const chatId = ctx.callbackQuery.message?.chat.id;
    if (!chatId) return;
    const threadId = (ctx.callbackQuery.message as { message_thread_id?: number } | undefined)
      ?.message_thread_id;

    if (action === "ge") {
      await sendGoalReply(
        bot,
        chatId,
        "Reply to the plan message above with your change request.",
        runtime,
        threadId,
      );
      return;
    }

    const resolvedId = resolveRunId(runIdPrefix!);
    if (!resolvedId) {
      await sendGoalReply(bot, chatId, `Run not found: ${runIdPrefix}`, runtime, threadId);
      return;
    }

    if (action === "ga" || action === "gA") {
      const statusCb = buildOnStatusChange({ bot, chatId, threadId, runtime, runId: resolvedId });
      const reply = await withPlanningFeedback({
        bot,
        chatId,
        threadId,
        label: "callback:approve",
        fn: () => handleGoalApprove(resolvedId, statusCb),
      });
      if (reply == null) return;
      if (typeof reply === "string") {
        await sendGoalReply(bot, chatId, reply, runtime, threadId);
      } else {
        await sendGoalPlanResult({ bot, chatId, runtime, result: reply, threadId });
      }
    } else if (action === "gr") {
      const reply = await handleGoalReject(resolvedId);
      await sendGoalReply(bot, chatId, reply, runtime, threadId);
    }
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
      const statusCb = buildOnStatusChange({ bot, chatId, threadId, runtime, runId: run.runId });
      const reply = await withPlanningFeedback({
        bot,
        chatId,
        threadId,
        label: "reaction:approve",
        fn: () => handleGoalApprove(run.runId, statusCb),
      });
      if (reply == null) return;
      if (typeof reply === "string") {
        await sendGoalReply(bot, chatId, reply, runtime, threadId);
      } else {
        await sendGoalPlanResult({ bot, chatId, runtime, result: reply, threadId });
      }
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
    const text = ctx.match?.trim() ?? "";
    if (!text) {
      const result = await handleGoal("");
      await sendPlanResult(resolved.chatId, result, resolved.threadIdForSend);
      return;
    }
    const result = await withPlanningFeedback({
      bot,
      chatId: resolved.chatId,
      threadId: resolved.threadIdForSend,
      label: "goal",
      fn: () => handleGoal(text),
    });
    await sendPlanResult(resolved.chatId, result, resolved.threadIdForSend);
  });

  // /goal_approve <runId>
  bot.command("goal_approve", async (ctx: TelegramGoalCommandContext) => {
    const resolved = await authAndResolve(ctx);
    if (!resolved) return;
    const rawId = ctx.match?.trim() ?? "";
    const approveRunId = resolveRunId(rawId);
    const statusCb = approveRunId
      ? buildOnStatusChange({
          bot,
          chatId: resolved.chatId,
          threadId: resolved.threadIdForSend,
          runtime,
          runId: approveRunId,
        })
      : undefined;
    const reply = await withPlanningFeedback({
      bot,
      chatId: resolved.chatId,
      threadId: resolved.threadIdForSend,
      label: "goal_approve",
      fn: () => handleGoalApprove(rawId, statusCb),
    });
    if (reply == null) return;
    if (typeof reply === "string") {
      await sendGoalReply(bot, resolved.chatId, reply, runtime, resolved.threadIdForSend);
    } else {
      await sendGoalPlanResult({
        bot,
        chatId: resolved.chatId,
        runtime,
        result: reply,
        threadId: resolved.threadIdForSend,
      });
    }
  });

  // /goal_reject <runId>
  bot.command("goal_reject", async (ctx: TelegramGoalCommandContext) => {
    const resolved = await authAndResolve(ctx);
    if (!resolved) return;
    const reply = await handleGoalReject(ctx.match?.trim() ?? "");
    await sendGoalReply(bot, resolved.chatId, reply, runtime, resolved.threadIdForSend);
  });

  // /goal_edit <runId> <instructions>
  bot.command("goal_edit", async (ctx: TelegramGoalCommandContext) => {
    const resolved = await authAndResolve(ctx);
    if (!resolved) return;
    const raw = ctx.match?.trim() ?? "";
    const spaceIdx = raw.indexOf(" ");
    if (spaceIdx === -1) {
      await sendGoalReply(
        bot,
        resolved.chatId,
        "Usage: /goal_edit <runId> <edit instructions>",
        runtime,
        resolved.threadIdForSend,
      );
      return;
    }
    const runId = raw.slice(0, spaceIdx);
    const instructions = raw.slice(spaceIdx + 1).trim();
    const result = await withPlanningFeedback({
      bot,
      chatId: resolved.chatId,
      threadId: resolved.threadIdForSend,
      label: "goal_edit",
      fn: () => handleGoalEdit(runId, instructions),
    });
    await sendPlanResult(resolved.chatId, result, resolved.threadIdForSend);
  });

  // /goal_status <runId>
  bot.command("goal_status", async (ctx: TelegramGoalCommandContext) => {
    const resolved = await authAndResolve(ctx);
    if (!resolved) return;
    const reply = await handleGoalStatus(ctx.match?.trim() ?? "");
    await sendGoalReply(bot, resolved.chatId, reply, runtime, resolved.threadIdForSend);
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
    const runId = raw.slice(0, spaceIdx);
    const value = raw.slice(spaceIdx + 1).trim();
    const answerRunId = resolveRunId(runId);
    const statusCb = answerRunId
      ? buildOnStatusChange({
          bot,
          chatId: resolved.chatId,
          threadId: resolved.threadIdForSend,
          runtime,
          runId: answerRunId,
        })
      : undefined;
    const result = await withPlanningFeedback({
      bot,
      chatId: resolved.chatId,
      threadId: resolved.threadIdForSend,
      label: "goal_answer",
      fn: () => handleGoalAnswer(runId, value, statusCb),
    });
    if (result == null) return;
    if (typeof result === "string") {
      await sendGoalReply(bot, resolved.chatId, result, runtime, resolved.threadIdForSend);
    } else {
      await sendPlanResult(resolved.chatId, result, resolved.threadIdForSend);
    }
  });

  // /goal_list
  bot.command("goal_list", async (ctx: TelegramGoalCommandContext) => {
    const resolved = await authAndResolve(ctx);
    if (!resolved) return;
    const reply = await handleGoalList();
    await sendGoalReply(bot, resolved.chatId, reply, runtime, resolved.threadIdForSend);
  });
}
