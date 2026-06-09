import type { GoalBackendId } from "../goal/backend-types.js";
import { splitAttemptHistory } from "../goal/blocked.js";
import {
  classifyUsageLimit,
  isUsageLimitClassReason,
  type UsageLimitBackend,
} from "../goal/error-patterns.js";
import { classifyRunCategory, type RunCategory } from "../goal/run-category.js";
import type { ScoutDecision } from "../goal/scout.js";
import type { BlockedDetail, PlanStep } from "../goal/types.js";
import { describeUsageLimitEvent, type UsageLimitEvent } from "../goal/usage-limit-message.js";
import { buildInlineKeyboard } from "./send.js";

export type BlockedSurfaceLevel = "task" | "goal";

/**
 * Build the inline keyboard for a blocked/interrupted surface, driven by the
 * derived {@link RunCategory} so task-level and goal-level surfaces stay
 * consistent. Callback prefixes are reused as-is (gAD/gResume/gStop):
 *
 *  - blocked  Add Details (answer). Goal-level keeps Resume next to Stop
 *             (historical behavior); task-level offers Stop only.
 *  - paused   Resume is the action for both levels; no Add Details (the user
 *             does not need to provide anything, just resume).
 *  - failed   User may fix/accept the issue and retry with Resume/Add Details.
 *  - retrying Auto-retrying; no user-input prompt, only Stop.
 */
function buildBlockedKeyboard(
  runIdPrefix: string,
  level: BlockedSurfaceLevel,
  category: RunCategory,
  opts: { planningDecision?: boolean } = {},
) {
  const addDetails = { text: "✏️ Add Details", callback_data: `gAD:${runIdPrefix}` };
  const resume = { text: "▶️ Resume Goal", callback_data: `gResume:${runIdPrefix}` };
  const stop = { text: "⏹️ Stop Goal", callback_data: `gStop:${runIdPrefix}` };
  // The planning Needs Decision surface answers via the existing reply/answer
  // flow, so the button reuses the gAD force-reply callback — no second
  // answer mechanism is introduced.
  const makeDecisions = { text: "☑️ Make Decision(s)", callback_data: `gAD:${runIdPrefix}` };

  switch (category) {
    case "blocked":
      if (opts.planningDecision) {
        return buildInlineKeyboard([[makeDecisions]]);
      }
      return buildInlineKeyboard(
        level === "goal" ? [[addDetails], [resume, stop]] : [[addDetails], [stop]],
      );
    case "paused":
      return buildInlineKeyboard([[resume, stop]]);
    case "failed":
      return buildInlineKeyboard([[addDetails], [resume, stop]]);
    case "retrying":
      return buildInlineKeyboard([[stop]]);
  }
}

export function buildGoalBlockedInlineKeyboard(
  runIdPrefix: string,
  category: RunCategory = "blocked",
  opts: { planningDecision?: boolean } = {},
) {
  return buildBlockedKeyboard(runIdPrefix, "goal", category, opts);
}

export function buildTaskBlockedInlineKeyboard(
  runIdPrefix: string,
  category: RunCategory = "blocked",
  opts: { planningDecision?: boolean } = {},
) {
  return buildBlockedKeyboard(runIdPrefix, "task", category, opts);
}

/**
 * Derive the user-facing {@link RunCategory} for a blocked notification.
 *
 * The {@link BlockedDetail.requiredInputKey} is authoritative for whether the
 * user must answer: goal-formatting persists a `task:<id>:input` / planning key
 * for genuine user-input blocks and `resume_execution` for technical/retryable
 * ones. A user-input key always reads as "blocked" (even when the underlying
 * step is already "done", e.g. a final build-gate escalation). For the
 * technical/resume bucket the blocked step's reason splits failed vs paused.
 */
export function classifyBlockedNotification(
  steps: PlanStep[],
  blockedDetail: Pick<BlockedDetail, "stepId" | "requiredInputKey">,
): RunCategory {
  if (blockedDetail.requiredInputKey !== "resume_execution") return "blocked";

  const reasons: NonNullable<PlanStep["blockedReason"]>[] = [];
  if (blockedDetail.stepId) {
    const named = steps.find((s) => s.id === blockedDetail.stepId);
    if (named?.blockedReason) reasons.push(named.blockedReason);
  }
  for (const step of steps) {
    if (step.status === "blocked" && step.blockedReason) reasons.push(step.blockedReason);
  }
  const categories = reasons.map((reason) => classifyRunCategory({ blockedReason: reason }));
  if (categories.includes("failed")) return "failed";
  // A retryable block that has been persisted (auto-retries exhausted) or any
  // unidentified resume_execution block reads as paused — the action is Resume.
  return "paused";
}

export interface BlockedSurfaceCopy {
  /**
   * Bold title line for the surface (markdown). Omitted for planning-decision
   * blocks, whose only heading is the bold "Decision(s) Needed:" inside body.
   */
  title?: string;
  /** Optional body override for structured planning-decision blocks. */
  body?: string;
  /** One-line hint making the next user action obvious. */
  actionHint: string;
}

function normalizeDecisionText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Render the planning Needs Decision body in the continuation-decision style:
 * one bold "Decision(s) Needed:" heading, then per decision a bold
 * "Decision N." label, then per option a bold "(KEY)" marker with a bold
 * "(Recommended)" suffix when applicable. Only those fixed markers are bold —
 * the model-provided question/label text stays plain and is HTML-escaped
 * downstream by markdownToTelegramHtml (escapeHtml). Output is compact: a single
 * newline between every line, with no blank-line separators between decisions.
 */
export function formatPlanningDecisionMarkdown(decisions: readonly ScoutDecision[]): string {
  const lines = ["**Decision(s) Needed:**"];
  decisions.forEach((decision, index) => {
    const question = normalizeDecisionText(decision.question) || "Decision needed";
    lines.push(`**Decision ${index + 1}.** ${question}`);
    for (const option of decision.options) {
      const key = normalizeDecisionText(option.key) || "?";
      const label = normalizeDecisionText(option.label) || "Option";
      const recommended = option.recommended === true ? " **(Recommended)**" : "";
      lines.push(`**(${key})** ${label}${recommended}`);
    }
  });
  return lines.join("\n");
}

/**
 * Title + action-hint copy for a blocked/interrupted surface, selected by the
 * derived category so the next action is obvious and consistent across the
 * task-level and goal-level surfaces.
 */
export function buildBlockedSurfaceCopy(params: {
  level: BlockedSurfaceLevel;
  category: RunCategory;
  runIdPrefix: string;
  stepId?: string;
  blockedAt?: BlockedDetail["blockedAt"];
  decisions?: readonly ScoutDecision[];
}): BlockedSurfaceCopy {
  const { level, category, runIdPrefix, stepId } = params;
  if (params.blockedAt === "planning" && params.decisions && params.decisions.length > 0) {
    // No separate title heading — the bold "Decision(s) Needed:" inside body is
    // the only heading. The runIdPrefix lives in the action hint, not a heading.
    return {
      body: formatPlanningDecisionMarkdown(params.decisions),
      actionHint: `**Goal ID:** ${runIdPrefix}`,
    };
  }

  const subject = level === "task" ? `Step ${stepId}` : "Goal";
  switch (category) {
    case "blocked":
      return {
        title:
          level === "task"
            ? `**TASK BLOCKED** (${runIdPrefix}): ${subject} needs input`
            : `**GOAL BLOCKED** (${runIdPrefix}): no runnable steps - waiting for answers.`,
        actionHint: `Reply to this message, tap ✏️ Add Details, or use /goal_answer ${runIdPrefix} <answer>.`,
      };
    case "paused":
      return {
        title:
          level === "task"
            ? `**TASK PAUSED** (${runIdPrefix}): ${subject} - resume needed.`
            : `**GOAL PAUSED** (${runIdPrefix}): worker interrupted - resume needed.`,
        actionHint: `Tap ▶️ Resume Goal or use /goal_resume ${runIdPrefix} when you're ready. No details needed.`,
      };
    case "failed":
      return {
        title:
          level === "task"
            ? `**TASK FAILED** (${runIdPrefix}): ${subject} hit a non-retryable error.`
            : `**GOAL FAILED** (${runIdPrefix}): a non-retryable error needs fixing.`,
        actionHint: `Fix or accept the underlying issue, then tap ▶️ Resume Goal, tap ✏️ Add Details, or use /goal_resume ${runIdPrefix}.`,
      };
    case "retrying":
      return {
        title:
          level === "task"
            ? `**TASK RETRYING** (${runIdPrefix}): ${subject} - temporary backend issue, retrying automatically.`
            : `**GOAL RETRYING** (${runIdPrefix}): temporary backend issue, retrying automatically.`,
        actionHint: `No action needed - SmithersBot is retrying with backoff.`,
      };
  }
}

export function buildBlockedCaption(steps: PlanStep[]): string {
  const blocked = steps.filter((step) => step.status === "blocked");
  if (blocked.length === 0) return "";

  const lines: string[] = [];
  // Technical blockers carry the same attempt history on every cascaded step;
  // collect unique histories and render them once at the end of the caption.
  const histories: string[] = [];
  for (const step of blocked.slice(0, 3)) {
    const { attemptHistory } = splitAttemptHistory(step.blockedQuestion);
    if (attemptHistory && !histories.includes(attemptHistory)) histories.push(attemptHistory);
    lines.push(`• **Step ${step.id}:** ${describeBlockedStep(step)}`);
  }
  if (blocked.length > 3) lines.push(`  …and ${blocked.length - 3} more`);
  let caption = lines.join("\n");
  if (histories.length > 0) caption += `\n\n${histories.join("\n\n")}`;
  return caption;
}

function toUsageLimitBackend(backend: GoalBackendId | undefined): UsageLimitBackend | undefined {
  return backend === "claude_code" || backend === "codex" ? backend : undefined;
}

/**
 * Render a usage/rate-limit blocker with the backend name and reset time when
 * available. Reuses the shared classifier — never re-implements detection here.
 */
function describeUsageLimitBlocked(step: PlanStep): string {
  const { message } = splitAttemptHistory(step.blockedQuestion);
  const text = message.trim();
  // The worker path already formats a backend-attributed message; surface it.
  if (text && (text.includes("Claude Code") || text.includes("Codex"))) return text;

  const backend = toUsageLimitBackend(step.executedBackend ?? step.backend);
  if (!backend) return text || "worker hit a provider limit; resume needed";

  const classification = classifyUsageLimit({ backend, text });
  const event: UsageLimitEvent = {
    backend,
    // A transient rate limit reads as "rate limit"; a quota/credit exhaustion
    // (usage_limit or out_of_credits) reads as "usage limit".
    kind: step.blockedReason === "rate_limit" ? "rate_limit" : "usage_limit",
    limitType: classification.limitType,
    ...(classification.resetHint ? { resetHint: classification.resetHint } : {}),
  };
  return `${describeUsageLimitEvent(event)}; resume needed`;
}

export function describeBlockedStep(step: PlanStep): string {
  // Usage/rate limits — including out-of-credits — get backend + reset-time
  // attribution from the classifier and never read as "needs input".
  if (isUsageLimitClassReason(step.blockedReason)) {
    return describeUsageLimitBlocked(step);
  }

  // Only true user-input blockers may say "needs input".
  if (step.blockedReason === "user_input" || step.blockedReason === undefined) {
    return step.blockedQuestion?.trim() || "needs input";
  }

  // Technical blockers: categorized phrase, with attempt history stripped (it is
  // deduplicated once per report by buildBlockedCaption).
  const message = splitAttemptHistory(step.blockedQuestion).message;
  switch (step.blockedReason) {
    case "process_lost":
      return "worker process lost/interrupted; resume needed";
    case "timeout":
      return "worker timed out; resume needed";
    case "turn_limit":
      return "worker hit its turn limit; resume needed";
    case "network":
      return "worker hit a network error; resume needed";
    case "auth":
      return "worker authentication failed";
    case "capability_blocked":
      return message || "no backend could provide a required capability (e.g. network)";
    case "sandbox_blocked":
      return message || "sandbox restriction blocked the worker (network/interface isolation)";
    case "task_failed":
      return message || "worker failed";
    case "error":
      return message || "worker failed/interrupted; resume needed";
    default:
      return message || "worker failed/interrupted; resume needed";
  }
}
