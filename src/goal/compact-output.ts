import type { GoalState, ManualTestSuggestion, SerializedRun } from "./types.js";

export type GoalOutputMode = "concise" | "verbose" | "full";
export type GoalOutputChannel = "cli" | "telegram";
export type GoalOutputTextFormat = "markdown" | "plain";
export type GoalStateIndicatorStyle = "emoji" | "text";

type KnownGoalState = GoalState;

export type AttemptBadgeInput = {
  attemptsUsed?: number | null;
  attemptsTotal?: number | null;
};

export type GoalRetrySummaryStepInput = {
  id: string;
  turnsUsed?: number | null;
};

export type GoalRetrySummaryInput = {
  steps: GoalRetrySummaryStepInput[];
  attemptsTotal?: number | null;
  resolveStepAttemptsUsed?: (stepId: string) => number | undefined;
};

export type GoalRetrySummaryResult = {
  text: string;
  retriesUsed: number;
  retriedStepCount: number;
  attemptsByStepId: Map<string, AttemptBadgeInput>;
};

export type CompactGoalStep = {
  id: string;
  text: string;
  attempt?: AttemptBadgeInput;
  state?: string;
  suffix?: string;
};

export type CompactGoalStepLineStyle = "bullet" | "numbered";

export type CompactGoalRenderInput = {
  state: string;
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
  stepsTitle?: string;
  stepLineStyle?: CompactGoalStepLineStyle;
  numberedStepLabel?: string;
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

export type CompactGoalCompletionStep = {
  id: string;
  description: string;
  summary?: string | null;
  status?: string;
  turnsUsed?: number | null;
};

export type CompactGoalCompletionInput = {
  title: string;
  steps: CompactGoalCompletionStep[];
  manualTests?: ManualTestSuggestion[] | null;
  attemptsTotal?: number | null;
  resolveStepAttemptsUsed?: (stepId: string) => number | undefined;
  mode?: GoalOutputMode;
  channel?: GoalOutputChannel;
  textFormat?: GoalOutputTextFormat;
  stateIndicatorStyle?: GoalStateIndicatorStyle;
  maxSteps?: number;
  maxLines?: number;
  maxStepTextChars?: number;
  maxTitleChars?: number;
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
  telegram: 120,
};

const DEFAULT_TITLE_CHARS_BY_CHANNEL: Record<GoalOutputChannel, number> = {
  cli: 70,
  telegram: 100,
};

const STATE_INDICATORS: Record<KnownGoalState, { emoji: string; text: string }> = {
  planning: { emoji: "\uD83E\uDDED", text: "Planning" },
  awaiting_approval: { emoji: "\u2705", text: "Awaiting Approval" },
  executing: { emoji: "\u23F3", text: "Executing" },
  reporting: { emoji: "\uD83D\uDCC4", text: "Reporting" },
  reporting_failed: { emoji: "\u26A0\uFE0F", text: "Reporting Failed" },
  blocked: { emoji: "\u26D4", text: "Blocked" },
  done: { emoji: "\u2705", text: "Done" },
  cancelled: { emoji: "\u23F9", text: "Cancelled" },
};

function normalizeCount(value: number | null | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.floor(value);
  return rounded >= 0 ? rounded : undefined;
}

function normalizePositiveCount(value: number | null | undefined): number | undefined {
  const normalized = normalizeCount(value);
  if (!normalized || normalized <= 0) return undefined;
  return normalized;
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
  state: string,
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

function formatStepLine(
  step: CompactGoalStep,
  index: number,
  maxStepTextChars: number,
  style: CompactGoalStepLineStyle,
  numberedStepLabel?: string,
): string {
  const statePrefix = step.state ? `${truncateSingleLine(step.state, 18)} ` : "";
  const badge = formatAttemptBadge(step.attempt);
  const normalizedSuffix = step.suffix?.trim();
  const stepText = normalizedSuffix
    ? (() => {
        const suffixText = ` ${normalizedSuffix}`;
        // Reserve width for suffixes like "[8/10 Critical]" so the criticality marker is always visible.
        const textBudget = Math.max(0, maxStepTextChars - suffixText.length);
        const truncatedText = truncateSingleLine(step.text, textBudget);
        return truncatedText ? `${truncatedText}${suffixText}` : normalizedSuffix;
      })()
    : truncateSingleLine(step.text, maxStepTextChars);
  const decoratedText = `${stepText}${badge ? ` ${badge}` : ""}`;
  if (style === "numbered") {
    const normalizedLabel = numberedStepLabel?.trim();
    if (normalizedLabel) {
      return `**${normalizedLabel} ${index + 1}:** ${statePrefix}${decoratedText}`;
    }
    return `${index + 1}. ${statePrefix}${decoratedText}`;
  }
  const id = truncateSingleLine(step.id, 20) || "?";
  return `- ${id}. ${statePrefix}${decoratedText}`;
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

/** Narrow view of a run needed to decide whether a top-level blocker renders. */
export type RunBlockerInput = Pick<SerializedRun, "state" | "blocked" | "lastError">;

/**
 * Decide whether a top-level "Blocker" line should render for a run, and what
 * text it should contain.
 *
 * A blocker must only surface when the run is *currently* blocked with an
 * unresolved blocker, or when planning failed and left the run stuck. Stale
 * `blocked`/`lastError` fields carried over from a prior interruption must NOT
 * render once the run has resumed (executing), completed (done), or been
 * cancelled — otherwise a recovered or finished goal still shows a phantom
 * blocker such as "Blocker You've hit your usage limit...". Returns undefined
 * when no blocker should render.
 */
export function buildRunBlockerSummary(run: RunBlockerInput): string | undefined {
  if (run.state === "blocked") {
    if (run.blocked) {
      const blockedAt = run.blocked.blockedAt === "planning" ? "Planning" : "Execution";
      const keySuffix = run.blocked.requiredInputKey
        ? ` (key: ${run.blocked.requiredInputKey})`
        : "";
      return `${blockedAt}: ${run.blocked.prompt}${keySuffix}`;
    }
    // Blocked without a structured blocker: surface the last error as the reason.
    return run.lastError;
  }
  // Planning can fail and leave a lastError the operator still needs to see; the
  // run is effectively stuck even though its state is not "blocked".
  if (run.state === "planning") {
    return run.lastError;
  }
  // executing / awaiting_approval / done / cancelled: never render a stale blocker.
  return undefined;
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
    const header = formatGoalSectionTitle(input.stepsTitle ?? "Top Steps", options.textFormat);
    const baseLineCount = lines.length + 1;
    const availableLines = Number.isFinite(options.maxLines)
      ? Math.max(0, options.maxLines - baseLineCount)
      : Number.POSITIVE_INFINITY;
    const stepLineStyle = input.stepLineStyle ?? "bullet";

    const stepLines = steps.map((step, index) =>
      formatStepLine(step, index, options.maxStepTextChars, stepLineStyle, input.numberedStepLabel),
    );
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

export function buildGoalRetrySummary(input: GoalRetrySummaryInput): GoalRetrySummaryResult {
  const attemptsByStepId = new Map<string, AttemptBadgeInput>();
  const attemptsTotal = normalizePositiveCount(input.attemptsTotal);
  let retriesUsed = 0;
  let retriedStepCount = 0;

  for (const step of input.steps) {
    const turnsUsed = normalizePositiveCount(step.turnsUsed);
    const usesTurnCount = Boolean(turnsUsed && turnsUsed > 1);
    let stepAttempts = 0;

    if (usesTurnCount) {
      stepAttempts = turnsUsed ?? 0;
    } else if (input.resolveStepAttemptsUsed) {
      const resolved = normalizePositiveCount(input.resolveStepAttemptsUsed(step.id));
      stepAttempts = resolved ?? 0;
    }

    if (stepAttempts <= 1) continue;

    attemptsByStepId.set(
      step.id,
      usesTurnCount && attemptsTotal
        ? { attemptsUsed: stepAttempts, attemptsTotal }
        : { attemptsUsed: stepAttempts },
    );

    retriesUsed += stepAttempts - 1;
    retriedStepCount += 1;
  }

  return {
    text:
      retriesUsed <= 0
        ? "0 retries"
        : `${retriesUsed} ${retriesUsed === 1 ? "retry" : "retries"} across ${retriedStepCount} ${
            retriedStepCount === 1 ? "step" : "steps"
          }`,
    retriesUsed,
    retriedStepCount,
    attemptsByStepId,
  };
}

export function formatCompactGoalCompletionSummary(
  input: CompactGoalCompletionInput,
): CompactGoalRenderResult {
  const doneSteps = input.steps.filter((step) => (step.status ?? "done") === "done");
  const manualTestsInput = input.manualTests;
  const hasManualTests = manualTestsInput !== undefined && manualTestsInput !== null;
  let manualTests: Array<{ description: string; criticality: number }> = [];
  if (hasManualTests) {
    manualTests = manualTestsInput
      .map((test) => {
        const description = test.description.trim();
        if (!description) return undefined;
        const criticality = Number.isFinite(test.criticality)
          ? Math.min(10, Math.max(1, Math.round(test.criticality)))
          : 5;
        return {
          description,
          criticality,
        };
      })
      .filter((test): test is { description: string; criticality: number } => Boolean(test))
      .slice(0, 5);
  }
  const retrySummary = buildGoalRetrySummary({
    steps: input.steps.map((step) => ({ id: step.id, turnsUsed: step.turnsUsed })),
    attemptsTotal: input.attemptsTotal,
    resolveStepAttemptsUsed: input.resolveStepAttemptsUsed,
  });

  return formatCompactGoalOutput({
    state: "done",
    title: input.title,
    progress: {
      completed: doneSteps.length,
      total: input.steps.length,
    },
    retrySummary: retrySummary.text,
    steps: hasManualTests
      ? manualTests.length > 0
        ? manualTests.map((test) => ({
            id: "",
            text: test.description,
            suffix: `[${test.criticality}/10 Critical]`,
          }))
        : [{ id: "", text: "No manual tests needed", suffix: "" }]
      : doneSteps.map((step) => ({
          id: step.id,
          text: step.summary?.trim() ? step.summary : step.description,
          attempt: retrySummary.attemptsByStepId.get(step.id),
        })),
    ...(hasManualTests
      ? { stepsTitle: "Manual Tests", stepLineStyle: "numbered", numberedStepLabel: "Test" }
      : {}),
    mode: input.mode,
    channel: input.channel ?? "telegram",
    textFormat: input.textFormat ?? "markdown",
    stateIndicatorStyle: input.stateIndicatorStyle,
    maxSteps: input.maxSteps,
    maxLines: input.maxLines,
    maxStepTextChars: input.maxStepTextChars,
    maxTitleChars: input.maxTitleChars,
  });
}
