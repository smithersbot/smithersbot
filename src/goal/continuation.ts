import { randomUUID } from "node:crypto";
import fs from "node:fs";

import { CONTINUATION_SYSTEM_PROMPT } from "../prompts/continuation/system-prompt.js";
import { redactSecretValues } from "../security/secret-paths.js";
import { workspaceNameFromWorkingDir } from "./agent-history.js";
import { loadGoalBriefContent } from "./goal-brief.js";
import { completeGoalLlmWithHistory } from "./llm-client.js";
import { resolvePostExecutionReportArtifactPaths } from "./post-execution-report.js";
import { extractJson } from "./planner.js";
import { loadRun, saveRun } from "./run-store.js";
import type {
  ContinuationProposal,
  ContinuationProposalDecision,
  GoalLlmClient,
  PlanStep,
  SerializedRun,
} from "./types.js";

function continuationPromptScope(run: SerializedRun): {
  kind: "goal";
  workspaceName: string;
  goalId: string;
} {
  return {
    kind: "goal",
    workspaceName: run.historyWorkspaceSlug ?? workspaceNameFromWorkingDir(run.workingDir),
    goalId: run.runId,
  };
}

export type ContinuationAssessment =
  | {
      outcome: "goal-achieved-no-continuation";
      goalAchieved: true;
      briefSummary: string;
    }
  | {
      outcome: "continuation-recommended-now";
      goalAchieved: boolean;
      briefSummary: string;
      proposedPrompt: string;
      decisions?: ContinuationProposalDecision[];
    };

export type GenerateContinuationAssessmentParams = {
  run: SerializedRun;
  client: GoalLlmClient;
};

export type GenerateAndStoreContinuationProposalParams = {
  runId: string;
  client?: GoalLlmClient;
  goalsDir?: string;
  onError?: (error: unknown) => void;
};

export type GenerateContinuationFromAchievedParams = {
  run: SerializedRun;
  client?: GoalLlmClient;
};

export type ReviseContinuationProposalParams = {
  run?: SerializedRun;
  proposal: ContinuationProposal;
  editInstruction: string;
  client?: GoalLlmClient;
};

export const CONTINUATION_BACKEND_UNAVAILABLE_MESSAGE =
  "Continuation proposal failed because no continuation backend was available. Retry later or resume post-execution.";
export const CONTINUATION_REVISION_BACKEND_UNAVAILABLE_MESSAGE =
  "Continuation revision failed because no continuation backend was available. Retry later or resume post-execution.";

const BANNED_GENERATED_PHRASES = [
  "Another plan can be drafted under this goal.",
  "Continuation prompt edited.",
  "Another plan is recommended.",
];

function cleanGeneratedText(value: string): string {
  let text = value;
  for (const phrase of BANNED_GENERATED_PHRASES) {
    text = text.replaceAll(phrase, "");
  }
  return text
    .replaceAll("🔁", "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^[-*]\s*$/.test(line) && !/^(Next|Recommendation):$/i.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(value: unknown, fallback: string, maxLength = 1_200): string {
  const text = typeof value === "string" ? cleanGeneratedText(value) : "";
  if (!text) return fallback;
  return text.length > maxLength ? `${text.slice(0, maxLength - 3).trimEnd()}...` : text;
}

function normalizeTextList(value: unknown, maxItems = 5): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeText(entry, "", 180))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeDecision(value: unknown): ContinuationProposalDecision | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const question = normalizeText(record.question, "", 240);
  const options = normalizeTextList(record.options);
  const recommendedOption = normalizeText(record.recommendedOption, "", 180);
  const rationale = normalizeText(record.rationale, "", 400);
  if (!question || options.length === 0 || !recommendedOption || !rationale) return undefined;
  const promptImpact = normalizeText(record.promptImpact, "", 400);
  return {
    question,
    options,
    recommendedOption,
    rationale,
    ...(promptImpact ? { promptImpact } : {}),
  };
}

function normalizeDecisions(value: unknown): ContinuationProposalDecision[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const decisions = value
    .map((entry) => normalizeDecision(entry))
    .filter((entry): entry is ContinuationProposalDecision => Boolean(entry));
  return decisions.length > 0 ? decisions : undefined;
}

function formatStepForPrompt(step: PlanStep, index: number): string {
  const status = step.status ? ` [${step.status}]` : "";
  const summary = step.shortSummary?.trim() || step.description.trim() || step.id;
  return `${index + 1}. ${summary}${status}`;
}

function formatStepResultForPrompt(run: SerializedRun): string {
  const entries = Object.values(run.stepResults ?? {});
  if (entries.length === 0) return "No structured step results are available.";
  return entries
    .slice(0, 12)
    .map((result) => {
      const outcome = result.success ? "success" : "failed";
      const detail = (result.error || result.output || "").trim();
      return `- ${result.stepId}: ${outcome}${detail ? ` - ${normalizeText(detail, "", 500)}` : ""}`;
    })
    .join("\n");
}

type LoadedContinuationArtifact =
  | { ok: true; path: string; content: string }
  | { ok: false; path?: string; message: string };

function loadLatestPlanReportContent(run: SerializedRun): LoadedContinuationArtifact {
  const reportPath = run.historyWorkspaceSlug
    ? resolvePostExecutionReportArtifactPaths({
        runId: run.runId,
        workingDir: run.workingDir,
        historyWorkspaceSlug: run.historyWorkspaceSlug,
      }).markdownPath
    : run.postExecutionReportArtifacts?.markdownPath;
  if (!reportPath) {
    return {
      ok: false,
      message: "Latest Plan Report is missing; do not infer goal achievement from its absence.",
    };
  }
  try {
    const content = fs.readFileSync(reportPath, "utf8").trim();
    if (content) return { ok: true, path: reportPath, content };
  } catch {
    // Reported uniformly below.
  }
  return {
    ok: false,
    path: reportPath,
    message:
      "Latest Plan Report is missing or empty; do not infer goal achievement from its absence.",
  };
}

function formatArtifactForPrompt(title: string, artifact: LoadedContinuationArtifact): string[] {
  if (artifact.ok) {
    return [`${title} path: ${artifact.path}`, `${title} content:`, artifact.content, ""];
  }
  return [
    artifact.path ? `${title} path: ${artifact.path}` : `${title} path: unavailable`,
    `${title} status: ${artifact.message}`,
    "",
  ];
}

export function buildContinuationUserMessage(run: SerializedRun): string {
  const plan = run.plan;
  const steps = plan?.steps ?? [];
  const goalBrief = loadGoalBriefContent(run);
  const goalBriefArtifact: LoadedContinuationArtifact = goalBrief.ok
    ? goalBrief
    : { ok: false, path: goalBrief.path, message: goalBrief.message };
  const planReport = loadLatestPlanReportContent(run);
  const stepLines =
    steps.length > 0
      ? steps.slice(0, 12).map(formatStepForPrompt).join("\n")
      : "No plan steps are available.";
  return [
    `Goal ID: ${run.runId}`,
    `Current user-visible plan number: ${run.planNumber ?? 1}`,
    `Internal plan revision: ${run.planRevision ?? run.activePlanRevision ?? 1}`,
    `Goal: ${run.goal}`,
    "",
    "Plan summary:",
    plan?.summary?.trim() || "No summary available.",
    "",
    "Completion summary:",
    run.completionSummary?.trim() || "No completion summary available.",
    "",
    "Completed plan steps:",
    stepLines,
    "",
    "Current plan result evidence:",
    formatStepResultForPrompt(run),
    "",
    ...formatArtifactForPrompt("Goal Brief", goalBriefArtifact),
    ...formatArtifactForPrompt("Latest Plan Report", planReport),
    "Remaining-work guidance:",
    "Use the Goal Brief's Remaining Work and Observation Point/Next Observation Point sections, plus the latest Plan Report, to decide whether the original goal is achieved.",
    "If either artifact identifies unfinished work, a later stage, or an actionable next plan, set goalAchieved=false and propose that remaining work directly.",
    "Do not claim a later stage was completed unless the current plan result or Plan Report gives concrete evidence that it was completed.",
    "",
    "Decide whether to propose another plan now under the same goal ID.",
  ].join("\n");
}

type RemainingWorkEvidence = {
  hasRemainingWork: boolean;
  summary: string;
  proposedPrompt: string;
};

function buildRemainingWorkPrompt(run: SerializedRun, summary: string): string {
  return [
    `Create the next plan under the same Goal ID (${run.runId}) to complete only the remaining work recorded in the Goal Brief or latest Plan Report.`,
    `Remaining Work: ${summary}`,
    "Do not redo completed work and do not claim the remaining work is already complete without concrete evidence.",
  ].join("\n");
}

function normalizeReportContinuationEvidence(
  run: SerializedRun,
): RemainingWorkEvidence | undefined {
  const continuation = run.postExecutionContinuation;
  if (!continuation?.nextPlanRecommended) return undefined;
  const summary = normalizeText(
    continuation.nextPlanSummary,
    "The latest Plan Report recommends another plan.",
    500,
  );
  const proposedPrompt = normalizeText(continuation.nextPlanPrompt, "", Number.MAX_SAFE_INTEGER);
  return {
    hasRemainingWork: true,
    summary,
    proposedPrompt: proposedPrompt || buildRemainingWorkPrompt(run, summary),
  };
}

function extractMarkdownLabel(content: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bold = new RegExp(`\\*\\*${escaped}:\\*\\*\\s*([^\\n]+)`, "i").exec(content);
  if (bold?.[1]) return bold[1].trim();
  const list = new RegExp(`(?:^|\\n)\\s*[-*]\\s*${escaped}:\\s*([^\\n]+)`, "i").exec(content);
  return list?.[1]?.trim() ?? "";
}

function extractBlockAfterLabel(content: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `\\*\\*${escaped}:\\*\\*\\s*\\n([\\s\\S]*?)(?:\\n\\*\\*[^\\n]+:\\*\\*|$)`,
    "i",
  ).exec(content);
  return match?.[1]?.trim() ?? "";
}

function isActionableRemainingText(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return !/^(?:none|n\/a|not applicable|no remaining work|nothing remains|complete|completed)\.?$/i.test(
    normalized,
  );
}

function extractBriefSection(content: string, sectionName: string): string {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^#{1,6}\\s*${escaped}\\s*:?[ \\t]*$`, "im").exec(content);
  if (heading?.index != null) {
    const start = heading.index + heading[0].length;
    const rest = content.slice(start);
    const nextHeading = /^#{1,6}\s+\S.*$/m.exec(rest);
    return rest.slice(0, nextHeading?.index ?? rest.length).trim();
  }

  const inline = new RegExp(`(?:^|\\n)(?:\\*\\*)?${escaped}(?:\\*\\*)?:\\s*([^\\n]+)`, "i").exec(
    content,
  );
  return inline?.[1]?.trim() ?? "";
}

function normalizePlanReportEvidence(
  content: string,
  run: SerializedRun,
): RemainingWorkEvidence | undefined {
  const goalAppearsAchieved = extractMarkdownLabel(content, "Goal appears achieved");
  const anotherPlan = extractMarkdownLabel(content, "Another plan recommended");
  const nextPlan = extractMarkdownLabel(content, "Next Plan");
  const proposedPrompt = extractBlockAfterLabel(content, "Proposed prompt");
  if (!/^yes$/i.test(anotherPlan) && !/^no$/i.test(goalAppearsAchieved)) return undefined;
  if (!isActionableRemainingText(nextPlan)) return undefined;
  const summary = normalizeText(nextPlan, "The latest Plan Report recommends another plan.", 500);
  return {
    hasRemainingWork: true,
    summary,
    proposedPrompt: isActionableRemainingText(proposedPrompt)
      ? normalizeText(proposedPrompt, "", Number.MAX_SAFE_INTEGER)
      : buildRemainingWorkPrompt(run, summary),
  };
}

function normalizeGoalBriefEvidence(
  content: string,
  run: SerializedRun,
): RemainingWorkEvidence | undefined {
  const remainingWork = extractBriefSection(content, "Remaining Work");
  if (!isActionableRemainingText(remainingWork)) return undefined;
  const observationPoint =
    extractBriefSection(content, "Next Observation Point") ||
    extractBriefSection(content, "Observation Point");
  const summary = normalizeText(remainingWork, "The Goal Brief records remaining work.", 500);
  const proposedPrompt = [
    `Create the next plan under the same Goal ID (${run.runId}) to complete only the remaining work recorded in the Goal Brief.`,
    `Remaining Work: ${summary}`,
    observationPoint ? `Next Observation Point: ${normalizeText(observationPoint, "", 500)}` : "",
    "Do not redo completed work and do not claim the remaining work is already complete without concrete evidence.",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    hasRemainingWork: true,
    summary,
    proposedPrompt,
  };
}

function mergeRemainingWorkEvidence(
  primary: RemainingWorkEvidence | undefined,
  secondary: RemainingWorkEvidence | undefined,
): RemainingWorkEvidence | undefined {
  if (!primary) return secondary;
  if (!secondary) return primary;
  return {
    hasRemainingWork: true,
    summary: primary.summary || secondary.summary,
    proposedPrompt: primary.proposedPrompt || secondary.proposedPrompt,
  };
}

function collectRemainingWorkEvidence(run: SerializedRun): RemainingWorkEvidence | undefined {
  let evidence = normalizeReportContinuationEvidence(run);

  const report = loadLatestPlanReportContent(run);
  if (report.ok) {
    evidence = mergeRemainingWorkEvidence(
      evidence,
      normalizePlanReportEvidence(report.content, run),
    );
  }

  const brief = loadGoalBriefContent(run);
  if (brief.ok) {
    evidence = mergeRemainingWorkEvidence(evidence, normalizeGoalBriefEvidence(brief.content, run));
  }

  return evidence?.hasRemainingWork ? evidence : undefined;
}

function normalizeAssessment(
  parsed: Record<string, unknown>,
  options: { remainingWorkEvidence?: RemainingWorkEvidence } = {},
): ContinuationAssessment {
  const rawOutcome = normalizeText(parsed.outcome, "goal-achieved-no-continuation", 80);
  const briefSummary = normalizeText(
    parsed.briefSummary ?? parsed.summary,
    "Goal appears achieved; no next plan is recommended right now.",
    500,
  );
  const rawRunAt = typeof parsed.runAt === "string" ? parsed.runAt.trim().toLowerCase() : "";

  if (rawOutcome === "continuation-recommended-now" && (!rawRunAt || rawRunAt === "now")) {
    const proposedPrompt = normalizeText(parsed.proposedPrompt, "", Number.MAX_SAFE_INTEGER);
    if (!proposedPrompt) {
      if (options.remainingWorkEvidence) {
        return {
          outcome: "continuation-recommended-now",
          goalAchieved: false,
          briefSummary: options.remainingWorkEvidence.summary,
          proposedPrompt: options.remainingWorkEvidence.proposedPrompt,
        };
      }
      return {
        outcome: "goal-achieved-no-continuation",
        goalAchieved: true,
        briefSummary,
      };
    }
    const decisions = normalizeDecisions(parsed.decisions);
    return {
      outcome: "continuation-recommended-now",
      goalAchieved: options.remainingWorkEvidence ? false : parsed.goalAchieved === true,
      briefSummary,
      proposedPrompt,
      ...(decisions ? { decisions } : {}),
    };
  }

  if (options.remainingWorkEvidence) {
    return {
      outcome: "continuation-recommended-now",
      goalAchieved: false,
      briefSummary: options.remainingWorkEvidence.summary,
      proposedPrompt: options.remainingWorkEvidence.proposedPrompt,
    };
  }

  return {
    outcome: "goal-achieved-no-continuation",
    goalAchieved: true,
    briefSummary:
      rawOutcome === "continuation-recommended-future" || rawRunAt
        ? `${briefSummary} Future continuation scheduling is not implemented in v1.`
        : briefSummary,
  };
}

export async function generateContinuationAssessment(
  params: GenerateContinuationAssessmentParams,
): Promise<ContinuationAssessment> {
  const userMessage = buildContinuationUserMessage(params.run);
  const response = await completeGoalLlmWithHistory({
    client: params.client,
    scope: continuationPromptScope(params.run),
    phase: "continuation-assessment",
    systemPrompt: CONTINUATION_SYSTEM_PROMPT,
    userMessage,
    maxTokens: 900,
    model: params.run.model,
    runId: params.run.runId,
  });
  const parsed = extractJson(redactSecretValues(response.text));
  return normalizeAssessment(parsed, {
    remainingWorkEvidence: collectRemainingWorkEvidence(params.run),
  });
}

function buildAchievedContinuationSystemPrompt(): string {
  return [
    "You draft a concrete next-plan proposal after the user pressed Continue Goal from a goal-achieved/no-next-plan state.",
    "Return ONLY JSON. Do not include markdown fences or prose outside JSON.",
    "",
    "JSON shape:",
    "{",
    '  "briefSummary": "Concrete summary of what the next plan will achieve.",',
    '  "proposedPrompt": "Prompt to create the next plan under the same goal ID.",',
    '  "decisions": [',
    "    {",
    '      "question": "What should the next plan do?",',
    '      "options": ["Concrete recommended option", "Concrete alternative", "Something else. Use Request Edit."],',
    '      "recommendedOption": "Concrete recommended option",',
    '      "rationale": "Why this is the best default.",',
    '      "promptImpact": "How accepting this option shapes the proposed prompt."',
    "    }",
    "  ]",
    "}",
    "",
    "Rules:",
    "- Because the user initiated continuation from an achieved state, do not return None or an empty decisions array unless the next action is genuinely unambiguous.",
    "- Include a recommended option, at least one concrete alternative, and an option equivalent to: Something else. Use Request Edit.",
    "- Do not use generic filler such as: Another plan can be drafted under this goal. Continuation prompt edited. Another plan is recommended. Next: Recommendation:",
    "- Do not use the 🔁 emoji.",
  ].join("\n");
}

function buildAchievedContinuationUserMessage(run: SerializedRun): string {
  return [
    `Goal ID: ${run.runId}`,
    `Goal: ${run.goal}`,
    `Current user-visible plan number: ${run.planNumber ?? 1}`,
    "",
    "Completed plan summary:",
    run.plan?.summary?.trim() || "No plan summary available.",
    "",
    "Completion summary:",
    run.completionSummary?.trim() || "No completion summary available.",
    "",
    "The prior assessment said the goal appeared achieved and no next plan was recommended.",
    "The user nevertheless pressed Continue Goal, so draft a useful next-plan decision instead of a generic placeholder.",
  ].join("\n");
}

function buildDefaultAchievedContinuationAssessment(run: SerializedRun): ContinuationAssessment {
  const goal = normalizeText(run.goal, "the completed goal", 220);
  const completion = normalizeText(run.completionSummary, "the completed work", 220);
  const recommended = `Validate the completed result for "${goal}" against the original request.`;
  const followUp = `Run a focused follow-up check based on the completed work: ${completion}.`;
  return {
    outcome: "continuation-recommended-now",
    goalAchieved: true,
    briefSummary: `Validate the completed result for "${goal}" against the original request.`,
    proposedPrompt: `Check the completed result for "${goal}" against the original goal and completion summary. Report whether the prior output remains correct and identify any concrete follow-up needed. Do not modify files unless the follow-up is clearly necessary and allowed by the original goal.`,
    decisions: [
      {
        question: "What should the next plan do?",
        options: [recommended, followUp, "Something else. Use Request Edit."],
        recommendedOption: recommended,
        rationale:
          "The original goal appeared achieved, so the safest default is a concrete validation pass before creating new work.",
        promptImpact:
          "The next plan will compare the completed outcome with the original request and report any specific follow-up.",
      },
    ],
  };
}

function ensureUsefulAchievedDecisions(
  run: SerializedRun,
  assessment: ContinuationAssessment,
): ContinuationAssessment {
  if (assessment.outcome !== "continuation-recommended-now") {
    return buildDefaultAchievedContinuationAssessment(run);
  }
  if (assessment.decisions && assessment.decisions.length > 0) return assessment;
  const fallback = buildDefaultAchievedContinuationAssessment(run);
  if (fallback.outcome !== "continuation-recommended-now") return assessment;
  return {
    ...assessment,
    decisions: fallback.decisions,
  };
}

export async function generateContinuationFromAchievedState(
  params: GenerateContinuationFromAchievedParams,
): Promise<ContinuationAssessment> {
  if (!params.client) return buildDefaultAchievedContinuationAssessment(params.run);
  const systemPrompt = buildAchievedContinuationSystemPrompt();
  const userMessage = buildAchievedContinuationUserMessage(params.run);
  const response = await completeGoalLlmWithHistory({
    client: params.client,
    scope: continuationPromptScope(params.run),
    phase: "continuation-from-achieved",
    systemPrompt,
    userMessage,
    maxTokens: 900,
    model: params.run.model,
    runId: params.run.runId,
  });
  const parsed = extractJson(redactSecretValues(response.text));
  const assessment = normalizeAssessment({
    outcome: "continuation-recommended-now",
    goalAchieved: true,
    briefSummary: parsed.briefSummary ?? parsed.summary,
    proposedPrompt: parsed.proposedPrompt,
    decisions: parsed.decisions,
    runAt: "now",
  });
  return ensureUsefulAchievedDecisions(params.run, assessment);
}

export function buildContinuationProposal(params: {
  run: SerializedRun;
  assessment: ContinuationAssessment;
  now?: Date;
}): ContinuationProposal {
  const assessment = params.assessment;
  const continuationFields =
    assessment.outcome === "continuation-recommended-now"
      ? {
          proposedPrompt: assessment.proposedPrompt,
          ...(assessment.decisions ? { decisions: assessment.decisions } : {}),
        }
      : { proposedPrompt: "" };
  return {
    proposalId: randomUUID(),
    fromPlanNumber: params.run.planNumber ?? 1,
    ...(params.run.planRevision != null ? { fromRevision: params.run.planRevision } : {}),
    goalAchieved: assessment.goalAchieved,
    briefSummary: assessment.briefSummary,
    ...continuationFields,
    runAt: "now",
    status: "pending",
    createdAt: (params.now ?? new Date()).toISOString(),
  };
}

function buildRevisionSystemPrompt(): string {
  return [
    "You revise a pending continuation proposal using the user's edit instruction.",
    "Return ONLY JSON. Do not include markdown fences or prose outside JSON.",
    "",
    "JSON shape:",
    "{",
    '  "briefSummary": "Updated next plan summary.",',
    '  "runAt": "now",',
    '  "proposedPrompt": "Updated proposed prompt to use if approved.",',
    '  "decisions": [{"question":"...","options":["..."],"recommendedOption":"...","rationale":"...","promptImpact":"..."}]',
    "}",
    "",
    "Rules:",
    "- Apply the edit instruction to the existing proposal; do not replace the proposed prompt with the instruction verbatim.",
    "- Revise the summary, decisions, and proposed prompt. Keep runAt as now unless the user explicitly changes timing; future scheduling is not supported in v1.",
    "- Use the Goal Brief, latest Plan Report, original goal, and current plan result as source material for the revised structured fields.",
    "- If no decisions are needed, return an empty decisions array.",
    "- Do not use generic filler such as: Another plan can be drafted under this goal. Continuation prompt edited. Another plan is recommended. Next: Recommendation:",
    "- Do not use the 🔁 emoji.",
  ].join("\n");
}

function buildRevisionUserMessage(params: ReviseContinuationProposalParams): string {
  const decisions = params.proposal.decisions?.length
    ? JSON.stringify(params.proposal.decisions, null, 2)
    : "None";
  const goalBrief = params.run ? loadGoalBriefContent(params.run) : undefined;
  const goalBriefArtifact: LoadedContinuationArtifact | undefined = goalBrief
    ? goalBrief.ok
      ? goalBrief
      : { ok: false, path: goalBrief.path, message: goalBrief.message }
    : undefined;
  const planReport = params.run ? loadLatestPlanReportContent(params.run) : undefined;
  return [
    params.run ? `Goal ID: ${params.run.runId}` : undefined,
    params.run ? `Goal: ${params.run.goal}` : undefined,
    params.run ? `Current user-visible plan number: ${params.run.planNumber ?? 1}` : undefined,
    params.run
      ? `Internal plan revision: ${params.run.planRevision ?? params.run.activePlanRevision ?? 1}`
      : undefined,
    params.run ? "" : undefined,
    params.run ? "Current plan summary:" : undefined,
    params.run ? params.run.plan?.summary?.trim() || "No plan summary available." : undefined,
    params.run ? "" : undefined,
    params.run ? "Completion summary:" : undefined,
    params.run
      ? params.run.completionSummary?.trim() || "No completion summary available."
      : undefined,
    params.run ? "" : undefined,
    params.run ? "Current plan result evidence:" : undefined,
    params.run ? formatStepResultForPrompt(params.run) : undefined,
    params.run ? "" : undefined,
    ...(goalBriefArtifact ? formatArtifactForPrompt("Goal Brief", goalBriefArtifact) : []),
    ...(planReport ? formatArtifactForPrompt("Latest Plan Report", planReport) : []),
    "Existing continuation proposal:",
    `Next Plan Summary: ${params.proposal.briefSummary}`,
    `When: ${params.proposal.runAt}`,
    "Decision(s) needed:",
    decisions,
    `Proposed prompt: ${params.proposal.proposedPrompt}`,
    "",
    `User edit instruction: ${params.editInstruction}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export async function reviseContinuationProposal(
  params: ReviseContinuationProposalParams,
): Promise<ContinuationProposal> {
  const trimmed = params.editInstruction.trim();
  if (!trimmed) return { ...params.proposal };
  if (!params.client) {
    throw new Error(CONTINUATION_REVISION_BACKEND_UNAVAILABLE_MESSAGE);
  }

  try {
    const systemPrompt = buildRevisionSystemPrompt();
    const userMessage = buildRevisionUserMessage(params);
    const response = params.run
      ? await completeGoalLlmWithHistory({
          client: params.client,
          scope: continuationPromptScope(params.run),
          phase: "continuation-request-edit",
          systemPrompt,
          userMessage,
          maxTokens: 900,
          model: params.run.model,
          runId: params.run.runId,
        })
      : await params.client.complete({
          systemPrompt,
          userMessage,
          maxTokens: 900,
        });
    const parsed = extractJson(redactSecretValues(response.text));
    const briefSummary = normalizeText(parsed.briefSummary ?? parsed.summary, "", 500);
    const proposedPrompt = normalizeText(parsed.proposedPrompt, "", Number.MAX_SAFE_INTEGER);
    if (!briefSummary || !proposedPrompt) {
      throw new Error("Continuation revision backend returned an incomplete proposal.");
    }
    const decisions = normalizeDecisions(parsed.decisions);
    const { decisions: _previousDecisions, ...proposalWithoutDecisions } = params.proposal;
    return {
      ...proposalWithoutDecisions,
      briefSummary,
      proposedPrompt,
      ...(decisions ? { decisions } : {}),
      lastContinuationEditMessage: trimmed,
      runAt: "now",
      status: "edited",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Continuation revision failed. ${redactSecretValues(message || "Unknown backend error.")}`,
    );
  }
}

export async function generateAndStoreContinuationProposal(
  params: GenerateAndStoreContinuationProposalParams,
): Promise<ContinuationProposal | undefined> {
  const run = loadRun(params.runId, params.goalsDir);
  if (!run || run.state !== "done" || !run.plan) return undefined;

  let assessment: ContinuationAssessment;
  if (!params.client) {
    params.onError?.(new Error(CONTINUATION_BACKEND_UNAVAILABLE_MESSAGE));
    return undefined;
  } else {
    try {
      assessment = await generateContinuationAssessment({ run, client: params.client });
    } catch (error) {
      params.onError?.(error);
      return undefined;
    }
  }

  try {
    const proposal = buildContinuationProposal({ run, assessment });
    const latest = loadRun(params.runId, params.goalsDir) ?? run;
    if (latest.state !== "done" || !latest.plan) return undefined;
    latest.pendingContinuation = proposal;
    latest.updatedAt = new Date().toISOString();
    saveRun(latest, params.goalsDir);
    return proposal;
  } catch (error) {
    params.onError?.(error);
    return undefined;
  }
}
