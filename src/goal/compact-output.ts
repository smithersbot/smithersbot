import type { GoalState } from "./types.js";

export type GoalOutputMode = "concise" | "verbose" | "full";
export type GoalOutputChannel = "cli" | "telegram";
export type GoalOutputTextFormat = "markdown" | "plain";
export type GoalStateIndicatorStyle = "emoji" | "text";

type KnownGoalState = GoalState;

export type AttemptBadgeInput = {
  attemptsUsed?: number | null;
  attemptsTotal?: number | null;
};

export type CompactGoalStep = {
  id: string;
  text: string;
  attempt?: AttemptBadgeInput;
  state?: string;
};

export type CompactGoalRenderInput = {
  state: KnownGoalState | string;
  title: string;
  progress?: {
    completed: number;
    total: number;
  };
  blockerSummary?: string | null;
  retrySummary?: string | null;
  steps?: CompactGoalStep[];
  mode?: GoalOutputMode;
  channel?: GoalOutputChannel;
  textFormat?: GoalOutputTextFormat;
  stateIndicatorStyle?: GoalStateIndicatorStyle;
  maxSteps?: number;
  maxLines?: number;
  maxStepTextChars?: number;
  maxTitleChars?: number;
};

export type CompactGoalRenderResult = {
  mode: GoalOutputMode;
  channel: GoalOutputChannel;
  lines: string[];
  text: string;
  shownStepCount: number;
  hiddenStepCount: number;
};

export type CompactGoalRenderOptions = {
  mode: GoalOutputMode;
  channel: GoalOutputChannel;
  textFormat: GoalOutputTextFormat;
  stateIndicatorStyle: GoalStateIndicatorStyle;
  maxSteps: number;
  maxLines: number;
  maxStepTextChars: number;
  maxTitleChars: number;
};

const DEFAULT_MAX_STEPS_BY_MODE: Record<GoalOutputMode, number> = {
  concise: 5,
  verbose: 8,
  full: Number.POSITIVE_INFINITY,
};

const DEFAULT_MAX_LINES_BY_CHANNEL: Record<GoalOutputChannel, number> = {
  cli: Number.POSITIVE_INFINITY,
  telegram: 15,
};

const DEFAULT_STEP_TEXT_CHARS_BY_CHANNEL: Record<GoalOutputChannel, number> = {
  cli: 100,
  telegram: 72,
};

const DEFAULT_TITLE_CHARS_BY_CHANNEL: Record<GoalOutputChannel, number> = {
  cli: 70,
  telegram: 52,
};

const STATE_INDICATORS: Record<KnownGoalState, { emoji: string; text: string }> = {
  planning: { emoji: "\uD83E\uDDED", text: "Planning" },
  awaiting_approval: { emoji: "\u2705", text: "Awaiting Approval" },
  executing: { emoji: "\u23F3", text: "Executing" },
  blocked: { emoji: "\u26D4", text: "Blocked" },
  done: { emoji: "\u2705", text: "Done" },
  cancelled: { emoji: "\u23F9", text: "Cancelled" },
};

function normalizeCount(value: number | null | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.floor(value);
  return rounded >= 0 ? rounded : undefined;
}

export function formatAttemptBadge(input: AttemptBadgeInput | undefined): string {
  if (!input) return "";
  const used = normalizeCount(input.attemptsUsed);
  if (!used || used <= 0) return "";

  const total = normalizeCount(input.attemptsTotal);
  if (total && total > 0) {
    if (used === 1 && total === 1) return "";
    return `[${Math.min(used, total)}/${total}]`;
  }

  return `[${used} ${used === 1 ? "attempt" : "attempts"}]`;
}

export function truncateSingleLine(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (maxChars <= 0) return "";
  if (compact.length <= maxChars) return compact;
  if (maxChars === 1) return "\u2026";
  return `${compact.slice(0, maxChars - 1)}\u2026`;
}

export function formatGoalSectionTitle(
  title: string,
  format: GoalOutputTextFormat = "markdown",
): string {
  const cleanTitle = truncateSingleLine(title, 40);
  if (format === "plain") return `${cleanTitle}:`;
  return `**${cleanTitle}**`;
}

export function formatGoalStateIndicator(
  state: KnownGoalState | string,
  style: GoalStateIndicatorStyle = "emoji",
): string {
  const known = STATE_INDICATORS[state as KnownGoalState];
  if (known) {
    return style === "text" ? known.text : `${known.emoji} ${known.text}`;
  }

  const normalized = truncateSingleLine(state, 24) || "Unknown";
  const text = normalized
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
  if (style === "text") return text;
  return `\u2139\uFE0F ${text}`;
}

export function resolveCompactGoalRenderOptions(
  input: Pick<
    CompactGoalRenderInput,
    | "mode"
    | "channel"
    | "textFormat"
    | "stateIndicatorStyle"
    | "maxSteps"
    | "maxLines"
    | "maxStepTextChars"
    | "maxTitleChars"
  > = {},
): CompactGoalRenderOptions {
  const mode = input.mode ?? "concise";
  const channel = input.channel ?? "cli";
  const textFormat = input.textFormat ?? "markdown";
  const stateIndicatorStyle = input.stateIndicatorStyle ?? "emoji";

  const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS_BY_MODE[mode];
  const maxLines = input.maxLines ?? DEFAULT_MAX_LINES_BY_CHANNEL[channel];
  const maxStepTextChars = input.maxStepTextChars ?? DEFAULT_STEP_TEXT_CHARS_BY_CHANNEL[channel];
  const maxTitleChars = input.maxTitleChars ?? DEFAULT_TITLE_CHARS_BY_CHANNEL[channel];

  return {
    mode,
    channel,
    textFormat,
    stateIndicatorStyle,
    maxSteps,
    maxLines,
    maxStepTextChars,
    maxTitleChars,
  };
}

function formatStepLine(step: CompactGoalStep, maxStepTextChars: number): string {
  const id = truncateSingleLine(step.id, 20) || "?";
  const statePrefix = step.state ? `${truncateSingleLine(step.state, 18)} ` : "";
  const stepText = truncateSingleLine(step.text, maxStepTextChars);
  const badge = formatAttemptBadge(step.attempt);
  return `- ${id}. ${statePrefix}${stepText}${badge ? ` ${badge}` : ""}`;
}

function fitStepLinesToBudget(params: {
  stepLines: string[];
  originalStepCount: number;
  maxSteps: number;
  availableLines: number;
}): { lines: string[]; shownStepCount: number; hiddenStepCount: number } {
  const cappedLines = params.stepLines.slice(0, params.maxSteps);
  let shown = cappedLines.length;
  let hidden = Math.max(0, params.originalStepCount - shown);

  while (shown + (hidden > 0 ? 1 : 0) > params.availableLines && shown > 0) {
    shown -= 1;
    hidden += 1;
  }

  const lines = cappedLines.slice(0, shown);
  if (hidden > 0 && lines.length < params.availableLines) {
    lines.push(`+ ${hidden} more steps not shown`);
  }

  return {
    lines,
    shownStepCount: shown,
    hiddenStepCount: hidden,
  };
}

export function formatCompactGoalOutput(input: CompactGoalRenderInput): CompactGoalRenderResult {
  const options = resolveCompactGoalRenderOptions(input);
  const lines: string[] = [];

  const headlineState = formatGoalStateIndicator(input.state, options.stateIndicatorStyle);
  const headlineTitle = truncateSingleLine(input.title, options.maxTitleChars);
  lines.push(`${headlineState}: ${headlineTitle}`);

  const progress = input.progress ?? { completed: 0, total: 0 };
  lines.push(
    `${formatGoalSectionTitle("Progress", options.textFormat)} ${progress.completed}/${progress.total}`,
  );

  if (input.blockerSummary) {
    lines.push(
      `${formatGoalSectionTitle("Blocker", options.textFormat)} ${truncateSingleLine(
        input.blockerSummary,
        options.maxStepTextChars,
      )}`,
    );
  }

  if (input.retrySummary) {
    lines.push(
      `${formatGoalSectionTitle("Retries", options.textFormat)} ${truncateSingleLine(
        input.retrySummary,
        options.maxStepTextChars,
      )}`,
    );
  }

  const steps = input.steps ?? [];
  let shownStepCount = 0;
  let hiddenStepCount = 0;
  if (steps.length > 0) {
    const header = formatGoalSectionTitle("Top Steps", options.textFormat);
    const baseLineCount = lines.length + 1;
    const availableLines = Number.isFinite(options.maxLines)
      ? Math.max(0, options.maxLines - baseLineCount)
      : Number.POSITIVE_INFINITY;

    const stepLines = steps.map((step) => formatStepLine(step, options.maxStepTextChars));
    const fitted = fitStepLinesToBudget({
      stepLines,
      originalStepCount: steps.length,
      maxSteps: options.maxSteps,
      availableLines,
    });

    lines.push(header);
    lines.push(...fitted.lines);
    shownStepCount = fitted.shownStepCount;
    hiddenStepCount = fitted.hiddenStepCount;
  }

  const boundedLines = Number.isFinite(options.maxLines) ? lines.slice(0, options.maxLines) : lines;

  return {
    mode: options.mode,
    channel: options.channel,
    lines: boundedLines,
    text: boundedLines.join("\n"),
    shownStepCount,
    hiddenStepCount,
  };
}
