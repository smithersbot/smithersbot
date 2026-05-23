import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Bot } from "grammy";

import type { CliWorkerId, PlanAutocheckMode } from "../config/types.goal.js";
import { formatAge } from "../infra/channel-summary.js";
import type { GoalStatusChangeEvent, ManualTestsStatus } from "../goal/agent-executor.js";
import { aggregateBlockedDetails } from "../goal/blocked.js";
import { formatCompactGoalCompletionSummary } from "../goal/compact-output.js";
import { clearLessons, loadLessons } from "../goal/lessons.js";
import { clampCriticality, isNoBackendManualTestsError } from "../goal/manual-tests.js";
import { listRuns, loadRun } from "../goal/run-store.js";
import type { ManualTestSuggestion, Plan, SerializedRun, StepResult } from "../goal/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import {
  persistManualTests,
  persistTelegramDoneMessage,
  persistTelegramQuestionMessage,
  sendDagPng,
  sendGoalReply,
  sendBlockedNotification,
} from "./goal-sending.js";
import { buildInlineKeyboard } from "./send.js";

type WorkingDirInstructionHint = {
  requestedPath: string;
  resolvedPath?: string;
};

export function splitStructuredDetailLines(value: string | undefined): string[] {
  if (!value) return [];
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  return normalized
    .split(/\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

export function formatTaskDetailSections(plan: Plan): string {
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

export function formatManualTestDetails(
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

export function appendGoalIdFooter(summary: string, runId: string): string {
  return `${summary.trimEnd()}\n**Goal ID:** ${runId.slice(0, 8)}`;
}

const MANUAL_TEST_GENERATION_FAILED_NOTICE = "Note: Manual test generation failed.";
const MANUAL_TESTS_SKIPPED_NO_BACKEND_NOTICE =
  "Manual test generation skipped: no available LLM backend configured.";

const ARTIFACT_HINT_PATTERN = /\((?:stdout|stderr):[^)]+\)/;

export function resolveManualTestsStatus(
  status: ManualTestsStatus | undefined,
  manualTestsError: string | undefined,
): ManualTestsStatus {
  if (status) return status;
  if (!manualTestsError?.trim()) return "generated";
  return isNoBackendManualTestsError(manualTestsError) ? "skipped_no_backend" : "failed";
}

export function appendManualTestsStatusNotice(
  summary: string,
  status: ManualTestsStatus,
  manualTestsError?: string,
): string {
  if (status === "generated") return summary;
  if (status === "skipped_no_backend") {
    if (summary.includes(MANUAL_TESTS_SKIPPED_NO_BACKEND_NOTICE)) return summary;
    return `${summary.trimEnd()}\n${MANUAL_TESTS_SKIPPED_NO_BACKEND_NOTICE}`;
  }
  if (summary.includes(MANUAL_TEST_GENERATION_FAILED_NOTICE)) return summary;
  const artifactHint = manualTestsError?.match(ARTIFACT_HINT_PATTERN)?.[0];
  const notice = artifactHint
    ? `${MANUAL_TEST_GENERATION_FAILED_NOTICE} ${artifactHint}`
    : MANUAL_TEST_GENERATION_FAILED_NOTICE;
  return `${summary.trimEnd()}\n${notice}`;
}

export function buildDoneSummaryWithManualTests(run: SerializedRun): string {
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
  const status = resolveManualTestsStatus(undefined, run.manualTestsError);
  return appendGoalIdFooter(
    appendManualTestsStatusNotice(summary, status, run.manualTestsError),
    run.runId,
  );
}

// Word boundaries + trailing lookaheads avoid camelCase false matches (e.g. workingDir, workingDirectory).
const WORKING_DIR_INSTRUCTION_PATTERNS = [
  /(?:\bworking\b\s*dir(?!\w)|\bworking\b\s*directory(?!\w)|\bworkdir(?!\w))[^\n]{0,200}?\bshould\s*be\s+([^\n]+)/i,
  /set\s+(?:the\s+)?(?:\bworking\b\s*dir(?!\w)|\bworking\b\s*directory(?!\w)|\bworkdir(?!\w))\s+to\s+([^\n]+)/i,
  /(?:\bworking\b\s*dir(?!\w)|\bworking\b\s*directory(?!\w)|\bworkdir(?!\w))\s*(?:should\s*be|is|=|:)\s*([^\n]+)/i,
];
const WORKING_DIR_INSTRUCTION_PREFIX_PATTERN =
  /^(?:(?:in|at)\s+)?(?:(?:a|an|the)\s+)?(?:new\s+)?(?:folder|directory|dir)\b(?:\s+(?:called|named))?(?:\s*[:=-])?\s+/i;

export function cleanWorkingDirInstructionPath(rawPath: string): string {
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

export function normalizeDirectoryToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function resolveByNormalizedDirectoryName(
  value: string,
  roots: string[],
): string | undefined {
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

export function resolveWorkingDirInstructionPath(
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

export function parseWorkingDirInstruction(
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

export function serializedStepResultsToMap(
  run: SerializedRun | undefined,
): ReadonlyMap<string, StepResult> {
  return new Map(Object.entries(run?.stepResults ?? {}));
}

export function parseGoalPlanAutocheckMode(raw: string): PlanAutocheckMode | undefined {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "codex" || normalized === "claude_code" || normalized === "off") {
    return normalized;
  }
  return undefined;
}

export function parseGoalWorkersArg(raw: string): CliWorkerId[] | undefined {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "codex") return ["codex"];
  if (normalized === "claude_code") return ["claude_code"];
  if (normalized === "both" || normalized === "all") return ["codex", "claude_code"];
  return undefined;
}

export function formatGoalWorkers(workers: CliWorkerId[]): string {
  return workers.join(", ");
}

export function formatGoalLockedMessage(runId: string, existingLabel?: string): string {
  return `Goal \`${runId.slice(0, 8)}\` is already being processed (${existingLabel ?? "unknown"}).`;
}

export function isPlanAutocheckBackend(
  mode: PlanAutocheckMode | undefined,
): mode is Exclude<PlanAutocheckMode, "off"> {
  return mode === "codex" || mode === "claude_code";
}

export const PLANNING_PREFACE = "Right away, sir.";
export const START_PREFACE = "Right away, sir. Starting the goal now.";
export const RESUME_PREFACE = "Right away, sir. Resuming the goal now.";

export function getGoalExecutionPreface(state: SerializedRun["state"] | undefined): string {
  if (state === "awaiting_approval" || state === "cancelled") {
    return START_PREFACE;
  }
  return RESUME_PREFACE;
}

export function resolveBlockedRequiredInputKey(run: SerializedRun): string | undefined {
  if (run.blocked?.requiredInputKey?.trim()) {
    return run.blocked.requiredInputKey;
  }
  const firstBlockedStep = run.plan?.steps.find((step) => step.status === "blocked");
  return firstBlockedStep ? `task:${firstBlockedStep.id}:input` : undefined;
}

export function buildGoalDoneInlineKeyboard(runIdPrefix: string) {
  return buildInlineKeyboard([
    [{ text: "🔍 Test Detail", callback_data: `gTD:${runIdPrefix}` }],
    [{ text: "🔄 Incorporate Feedback", callback_data: `gIF:${runIdPrefix}` }],
  ]);
}

type GoalLessonsAction =
  | { kind: "list" }
  | { kind: "clear"; workingDir?: string }
  | { kind: "invalid" };

const GOAL_LIST_LIMIT = 15;
const GOAL_LESSONS_USAGE = "Usage: /goal\\_lessons \\[clear \\[workingDir\\]\\]";

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
    const sendDeliveryFallback = async (requiredInputKey?: string) => {
      const msg = `⚠️ Goal ${prefix}: ${event.type} - update delivery failed, check /goal_status`;
      const sent = await bot.api
        .sendMessage(chatId, msg, { ...threadParams })
        .catch(() => undefined);
      if (sent?.message_id != null && requiredInputKey) {
        persistTelegramQuestionMessage({
          runId,
          chatId,
          messageId: sent.message_id,
          threadId,
          requiredInputKey,
        });
      }
    };

    if (event.type === "step_blocked") {
      // Only a genuine user-input block routes the reply back into the task
      // (task:<id>:input → "needs input"). Backend usage-limit and other
      // technical blocks are auto-retryable, so they use resume_execution and
      // never render as "needs input".
      const blockedStep = event.steps.find((s) => s.id === event.stepId);
      const reason = blockedStep?.blockedReason;
      const isUserInputBlock = reason === "user_input" || reason === undefined;
      const blockedDetail = {
        blockedAt: "execution",
        prompt: event.question,
        requiredInputKey: isUserInputBlock ? `task:${event.stepId}:input` : "resume_execution",
        stepId: event.stepId,
      } as const;
      try {
        await sendBlockedNotification({
          bot,
          chatId,
          threadId,
          runtime,
          runId,
          plan,
          steps: event.steps,
          stepResults,
          blockedDetail,
        });
      } catch {
        await sendDeliveryFallback(blockedDetail.requiredInputKey);
      }
    } else if (event.type === "fully_blocked") {
      const aggregateDetail = aggregateBlockedDetails(event.steps);
      if (!aggregateDetail) {
        await sendDeliveryFallback("resume_execution");
        return;
      }
      const blockedDetail = {
        ...aggregateDetail,
        // fully_blocked events always represent goal-level blockers,
        // even when only one task is currently blocked.
        stepId: undefined,
      };
      try {
        await sendBlockedNotification({
          bot,
          chatId,
          threadId,
          runtime,
          runId,
          plan,
          steps: event.steps,
          stepResults,
          blockedDetail,
        });
      } catch {
        await sendDeliveryFallback(blockedDetail.requiredInputKey);
      }
    } else if (event.type === "plan_revised") {
      try {
        // A missing PNG here is acceptable because this is an informational update.
        await sendDagPng({
          bot,
          chatId,
          threadId,
          runtime,
          runId,
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
        const status = resolveManualTestsStatus(event.manualTestsStatus, event.manualTestsError);
        const baseCaption = appendManualTestsStatusNotice(
          event.summary,
          status,
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
          runId,
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
        } else {
          const textSentId = await sendGoalReply(
            bot,
            chatId,
            caption,
            runtime,
            threadId,
            undefined,
            buildGoalDoneInlineKeyboard(prefix),
          );
          if (textSentId != null) {
            persistTelegramDoneMessage({
              runId,
              chatId,
              messageId: textSentId,
              threadId,
            });
          }
        }
      } catch {
        await sendDeliveryFallback();
      }
    }
  };
}
