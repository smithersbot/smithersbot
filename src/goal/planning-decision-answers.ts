import type { BlockedDetail, PlanningDecisionAnswer, ResumeNote, SerializedRun } from "./types.js";
import type { ScoutDecision, ScoutDecisionOption } from "./scout.js";

export const PLANNING_INPUT_KEY = "step:planning:input";

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function parseJsonAnswerMap(rawAnswer: string): Map<string, string> {
  const trimmed = rawAnswer.trim();
  if (!trimmed.startsWith("{")) return new Map();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return new Map();
    const entries = Object.entries(parsed)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, value]) => [normalizeText(key), value.trim()] as const)
      .filter(([, value]) => value.length > 0);
    return new Map(entries);
  } catch {
    return new Map();
  }
}

function parseDelimitedAnswerMap(rawAnswer: string): Map<string, string> {
  const map = new Map<string, string>();
  const segments = rawAnswer
    .split(/\r?\n|;/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  for (const segment of segments) {
    const match = segment.match(
      /^(?:decision\s*)?([A-Za-z0-9][A-Za-z0-9._-]*|\d+)\s*[:=]\s*(.+)$/i,
    );
    if (!match) continue;
    map.set(normalizeText(match[1]!), match[2]!.trim());
  }

  return map;
}

function parseAnswerMap(rawAnswer: string): Map<string, string> {
  const json = parseJsonAnswerMap(rawAnswer);
  if (json.size > 0) return json;
  return parseDelimitedAnswerMap(rawAnswer);
}

function orderedAnswerTokens(rawAnswer: string): string[] {
  return rawAnswer
    .split(/\r?\n|,|;/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function formatOptionAnswer(option: ScoutDecisionOption): string {
  return `(${option.key}) ${option.label}`;
}

function findSelectedOption(
  decision: ScoutDecision,
  answer: string,
): ScoutDecisionOption | undefined {
  const normalized = normalizeText(answer).replace(/^\(([^)]+)\)$/, "$1");
  return decision.options.find((option) => {
    const optionKey = normalizeText(option.key);
    const optionLabel = normalizeText(option.label);
    return (
      normalized === optionKey || normalized === optionLabel || normalized === `(${optionKey})`
    );
  });
}

function answerForDecision(params: {
  decision: ScoutDecision;
  decisionIndex: number;
  decisionCount: number;
  inputKey: string;
  rawAnswer: string;
  answerMap: Map<string, string>;
  orderedTokens: string[];
}): string {
  const { decision, decisionIndex, decisionCount, inputKey, rawAnswer, answerMap, orderedTokens } =
    params;
  const normalizedInputKey = normalizeText(inputKey);
  if (normalizedInputKey === normalizeText(decision.id)) return rawAnswer;

  const mapped =
    answerMap.get(normalizeText(decision.id)) ??
    answerMap.get(String(decisionIndex + 1)) ??
    answerMap.get(`decision ${decisionIndex + 1}`);
  if (mapped) return mapped;

  if (decisionCount > 1 && orderedTokens.length === decisionCount) {
    return orderedTokens[decisionIndex]!;
  }

  return rawAnswer;
}

export function isPlanningDecisionBlock(run: Pick<SerializedRun, "state" | "blocked">): boolean {
  return run.state === "blocked" && run.blocked?.blockedAt === "planning";
}

export function buildPlanningDecisionAnswers(params: {
  decisions: readonly ScoutDecision[];
  inputKey: string;
  rawAnswer: string;
  answeredAt: string;
}): Record<string, PlanningDecisionAnswer> {
  const rawAnswer = params.rawAnswer.trim();
  const answerMap = parseAnswerMap(rawAnswer);
  const orderedTokens = orderedAnswerTokens(rawAnswer);
  const answers: Record<string, PlanningDecisionAnswer> = {};

  params.decisions.forEach((decision, decisionIndex) => {
    const answer = answerForDecision({
      decision,
      decisionIndex,
      decisionCount: params.decisions.length,
      inputKey: params.inputKey,
      rawAnswer,
      answerMap,
      orderedTokens,
    });
    const selectedOption = findSelectedOption(decision, answer);
    answers[decision.id] = {
      decisionId: decision.id,
      question: decision.question,
      answer,
      ...(selectedOption
        ? { optionKey: selectedOption.key, optionLabel: selectedOption.label }
        : {}),
      answeredAt: params.answeredAt,
    };
  });

  return answers;
}

export function recordPlanningDecisionAnswer(params: {
  run: SerializedRun;
  inputKey: string;
  value: string;
  now: string;
}): boolean {
  const answer = params.value.trim();
  if (!answer || !isPlanningDecisionBlock(params.run)) return false;

  const requiredInputKey = params.run.blocked?.requiredInputKey ?? PLANNING_INPUT_KEY;
  params.run.answers = {
    ...params.run.answers,
    [requiredInputKey]: answer,
  };

  const decisions = params.run.blocked?.decisions ?? [];
  if (decisions.length > 0) {
    params.run.planningDecisionAnswers = {
      ...params.run.planningDecisionAnswers,
      ...buildPlanningDecisionAnswers({
        decisions,
        inputKey: params.inputKey,
        rawAnswer: answer,
        answeredAt: params.now,
      }),
    };
  }

  const note: ResumeNote = {
    timestamp: params.now,
    source: "goal_answer",
    affectedStepIds: [],
    userText: answer,
  };
  params.run.resumeNotes = [...(params.run.resumeNotes ?? []), note];
  params.run.updatedAt = params.now;
  return true;
}

function answerLine(answer: PlanningDecisionAnswer): string {
  if (answer.optionKey && answer.optionLabel) {
    const selected = formatOptionAnswer({ key: answer.optionKey, label: answer.optionLabel });
    if (answer.answer.trim() === answer.optionKey || answer.answer.trim() === answer.optionLabel) {
      return selected;
    }
    return `${selected} (raw answer: ${answer.answer})`;
  }
  return answer.answer;
}

export function buildPlanningDecisionResumeGoalText(params: {
  goal: string;
  blocked: BlockedDetail | null;
  answers: Record<string, string>;
  planningDecisionAnswers?: Record<string, PlanningDecisionAnswer>;
}): { goalText: string; consumedRequiredInputKey?: string } {
  const requiredInputKey = params.blocked?.requiredInputKey ?? PLANNING_INPUT_KEY;
  const rawAnswer = params.answers[requiredInputKey]?.trim();
  const decisionAnswers = params.planningDecisionAnswers ?? {};
  const hasDecisionAnswers = Object.keys(decisionAnswers).length > 0;

  if (params.blocked?.blockedAt !== "planning" || (!rawAnswer && !hasDecisionAnswers)) {
    return { goalText: params.goal };
  }

  const lines = ["Original /new_goal prompt:", params.goal.trim(), "", "User decision answers:"];

  const decisions = params.blocked.decisions ?? [];
  if (decisions.length > 0) {
    for (const decision of decisions) {
      const recorded = decisionAnswers[decision.id];
      lines.push(`- Decision ${decision.id}: ${decision.question}`);
      if (recorded) {
        lines.push(`  Answer: ${answerLine(recorded)}`);
      } else if (rawAnswer) {
        lines.push(`  Answer: ${rawAnswer}`);
      } else {
        lines.push("  Answer: (not provided)");
      }
    }
  } else if (rawAnswer) {
    lines.push(`- Planning decision response: ${rawAnswer}`);
  }

  lines.push(
    "",
    "Use these answers to pass the Needs Decision gate before creating wiki/goal-brief.md and execution_plan.json.",
  );

  return {
    goalText: lines.join("\n"),
    consumedRequiredInputKey: requiredInputKey,
  };
}

export function clearPlanningDecisionAnswerState(params: {
  answers: Record<string, string>;
  requiredInputKey?: string;
  clearPlanningDecisionAnswers: () => void;
}): void {
  delete params.answers[params.requiredInputKey ?? PLANNING_INPUT_KEY];
  params.clearPlanningDecisionAnswers();
}
