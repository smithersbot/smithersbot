import fs from "node:fs";
import path from "node:path";
import { resolveAgentGoalHistoryDir } from "../config/managed-paths.js";
import { resolveHistoryWorkspaceSlug } from "./history-anchor.js";
import type { ContinuationProposal, SerializedRun } from "./types.js";

const GOAL_BRIEF_FILE = "goal-brief.md";

type GoalBriefRun = Pick<
  SerializedRun,
  "runId" | "workingDir" | "goalBriefPath" | "historyWorkspaceSlug"
>;

export type GoalBriefContent =
  | {
      ok: true;
      path: string;
      content: string;
    }
  | {
      ok: false;
      path: string;
      message: string;
    };

export function resolveComputedGoalBriefPath(
  runId: string,
  workingDir: string,
  historyWorkspaceSlug?: string,
): string {
  return path.join(
    resolveAgentGoalHistoryDir(
      resolveHistoryWorkspaceSlug({
        runId,
        workingDir,
        ...(historyWorkspaceSlug ? { historyWorkspaceSlug } : {}),
      }),
      runId,
    ),
    "wiki",
    GOAL_BRIEF_FILE,
  );
}

export function resolveStoredGoalBriefPath(run: GoalBriefRun): string {
  if (run.historyWorkspaceSlug) {
    return resolveComputedGoalBriefPath(run.runId, run.workingDir, run.historyWorkspaceSlug);
  }
  return run.goalBriefPath || resolveComputedGoalBriefPath(run.runId, run.workingDir);
}

export function loadGoalBriefContent(run: GoalBriefRun): GoalBriefContent {
  const briefPath = resolveStoredGoalBriefPath(run);
  try {
    const content = fs.readFileSync(briefPath, "utf8").trim();
    if (content) return { ok: true, path: briefPath, content };
  } catch {
    // Missing/empty is reported uniformly below for user-facing surfaces.
  }
  return {
    ok: false,
    path: briefPath,
    message: [
      `Goal Brief is missing for ${run.runId.slice(0, 8)}.`,
      "",
      `Expected: ${briefPath}`,
      "",
      "The file was not found or was empty.",
    ].join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Goal Brief update on continuation Approve
// ---------------------------------------------------------------------------

/**
 * Canonical section headings the updated Goal Brief carries forward from the
 * prior brief. The approve rewrite renames the bounded-Plan sections to their
 * "Next" form: First Plan Intent -> Next Plan Intent, Observation Point ->
 * Next Observation Point.
 */
const CARRIED_BRIEF_SECTIONS = [
  "Goal Summary",
  "Long Goal Summary",
  "Original User Ask",
  "Key Decision summaries",
] as const;

/**
 * Extract the body text for a markdown section keyed by one of several possible
 * heading labels. Tolerates `# Heading`, `## Heading`, `**Heading**`, and
 * inline `Heading: value` styles so we can carry forward an LLM-authored brief
 * regardless of exact formatting.
 */
export function extractGoalBriefSection(
  content: string,
  headingLabels: readonly string[],
): string | undefined {
  const labels = headingLabels.map((label) => label.toLowerCase());
  const lines = content.split(/\r?\n/);
  const normalizeHeading = (line: string): { label: string; inline: string } | undefined => {
    const stripped = line.trim();
    if (!stripped) return undefined;
    // Strip leading markdown heading/bold markers and a trailing colon.
    const withoutMarkers = stripped
      .replace(/^#{1,6}\s*/, "")
      .replace(/^\*\*\s*/, "")
      .replace(/\*\*\s*$/, "");
    const colonIdx = withoutMarkers.indexOf(":");
    const headingText =
      colonIdx >= 0 ? withoutMarkers.slice(0, colonIdx).trim() : withoutMarkers.trim();
    const inline = colonIdx >= 0 ? withoutMarkers.slice(colonIdx + 1).trim() : "";
    return {
      label: headingText
        .replace(/\*\*\s*$/, "")
        .trim()
        .toLowerCase(),
      inline,
    };
  };

  let capturing = false;
  const collected: string[] = [];
  for (const line of lines) {
    const heading = normalizeHeading(line);
    if (heading && capturing && !labels.includes(heading.label)) {
      // Any recognized-looking heading other than ours ends the section.
      // Treat known brief section labels as terminators.
      const isKnownSection = ALL_BRIEF_SECTION_LABELS.has(heading.label);
      if (isKnownSection) break;
    }
    if (heading && labels.includes(heading.label)) {
      capturing = true;
      if (heading.inline) collected.push(heading.inline);
      continue;
    }
    if (capturing) collected.push(line);
  }
  const text = collected.join("\n").trim();
  return text.length > 0 ? text : undefined;
}

const ALL_BRIEF_SECTION_LABELS = new Set(
  [
    "Goal Summary",
    "Long Goal Summary",
    "Original User Ask",
    "Key Decision summaries",
    "First Plan Intent",
    "Next Plan Intent",
    "Remaining Work",
    "Observation Point",
    "Next Observation Point",
    "Manual Tests",
    "Sources",
  ].map((label) => label.toLowerCase()),
);

function nextGoalBriefSnapshotPath(wikiDir: string): string {
  let maxNumber = 1; // canonical goal-brief.md is implicitly version 001
  try {
    for (const entry of fs.readdirSync(wikiDir)) {
      const match = /^goal-brief-(\d+)\.md$/.exec(entry);
      if (match) {
        const n = Number.parseInt(match[1], 10);
        if (Number.isFinite(n) && n > maxNumber) maxNumber = n;
      }
    }
  } catch {
    // No directory yet; first snapshot will be 002.
  }
  const nextNumber = maxNumber + 1;
  const padded = String(nextNumber).padStart(3, "0");
  return path.join(wikiDir, `goal-brief-${padded}.md`);
}

function formatProposalDecisions(proposal: ContinuationProposal): string {
  if (!proposal.decisions || proposal.decisions.length === 0) return "None";
  return proposal.decisions
    .map((decision, index) => {
      const options =
        decision.options.length > 0 ? ` Options: ${decision.options.join("; ")}.` : "";
      const recommended = decision.recommendedOption
        ? ` Recommended: ${decision.recommendedOption}.`
        : "";
      return `Decision ${index + 1}: ${decision.question}${options}${recommended}`;
    })
    .join("\n");
}

function clampGoalSummary(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 140) return normalized;
  const clipped = normalized.slice(0, 140).trimEnd();
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace >= 80 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}...`;
}

function wholeGoalSummaryFallback(
  carried: Map<string, string | undefined>,
  runGoal: string,
): string {
  return clampGoalSummary(
    carried.get("Long Goal Summary") ??
      carried.get("Original User Ask") ??
      runGoal ??
      "Continue the approved goal across plans.",
  );
}

function sentence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function deriveNextPlanBriefFields(params: {
  proposal: ContinuationProposal;
  reportPath?: string;
  editMessage?: string;
}): {
  remainingWork: string;
  nextObservationPoint: string;
  manualTests: string;
} {
  const summary = params.proposal.briefSummary.trim();
  const prompt = params.proposal.proposedPrompt.trim();
  const edit = params.editMessage?.trim();
  const nextPlanWork = summary || prompt || "the approved next plan";
  const reportSource = params.reportPath
    ? ` Latest Plan Report source: ${params.reportPath}.`
    : " Latest Plan Report source: none recorded.";
  const editSource = edit ? ` User Request Edit guidance: ${sentence(edit)}` : "";

  return {
    remainingWork: [
      `After the approved next plan is done, reassess the whole goal against the original request and the latest Plan Report.`,
      `The next plan should complete or materially advance: ${sentence(nextPlanWork)}`,
      `Do not carry forward prior-plan remaining-work text as fact; recompute any still-open work from the next plan outcome.${reportSource}${editSource}`,
    ].join(" "),
    nextObservationPoint: [
      `Stop after the approved next plan has attempted: ${sentence(nextPlanWork)}`,
      "At that point, write the next Plan Report and decide whether more original-goal work remains.",
    ].join(" "),
    manualTests: [
      `After the approved next plan is done, run or propose manual tests that validate its observable result: ${sentence(nextPlanWork)}`,
      "If the next Plan Report proves the whole goal automatically, state that no manual tests are needed.",
    ].join(" "),
  };
}

export type GoalBriefApproveUpdate = {
  /** Canonical (latest) brief path that was rewritten. */
  briefPath: string;
  /** Path the prior brief was snapshotted to, or null when no prior brief existed. */
  snapshotPath: string | null;
  /** Updated brief markdown written to {@link briefPath}. */
  content: string;
};

/**
 * On continuation Approve, snapshot the prior canonical brief to an immutable
 * numbered sibling, then rewrite wiki/goal-brief.md as the updated latest brief
 * using Next Plan Intent / Next Observation Point and a Sources section. Does
 * NOT call the planner — callers create Plan 2 separately. Returns the canonical
 * path so callers can pin run.goalBriefPath.
 */
export function snapshotAndRewriteGoalBriefOnApprove(params: {
  run: Pick<SerializedRun, "runId" | "goal" | "workingDir" | "goalBriefPath"> & {
    historyWorkspaceSlug?: SerializedRun["historyWorkspaceSlug"];
    postExecutionReportArtifacts?: SerializedRun["postExecutionReportArtifacts"];
  };
  proposal: ContinuationProposal;
}): GoalBriefApproveUpdate {
  const { run, proposal } = params;
  const briefPath = resolveStoredGoalBriefPath(run);
  const wikiDir = path.dirname(briefPath);

  let priorContent = "";
  try {
    priorContent = fs.readFileSync(briefPath, "utf8");
  } catch {
    priorContent = "";
  }
  const priorTrimmed = priorContent.trim();

  let snapshotPath: string | null = null;
  if (priorTrimmed.length > 0) {
    snapshotPath = nextGoalBriefSnapshotPath(wikiDir);
    fs.mkdirSync(wikiDir, { recursive: true });
    fs.writeFileSync(snapshotPath, priorContent, "utf8");
  } else {
    fs.mkdirSync(wikiDir, { recursive: true });
  }

  const carried = new Map<string, string | undefined>();
  for (const section of CARRIED_BRIEF_SECTIONS) {
    carried.set(section, extractGoalBriefSection(priorTrimmed, [section]));
  }
  const reportPath = run.postExecutionReportArtifacts?.markdownPath;
  const editMessage = proposal.lastContinuationEditMessage?.trim();
  const nextPlanFields = deriveNextPlanBriefFields({
    proposal,
    reportPath,
    editMessage,
  });

  const nextPlanIntent = [
    proposal.briefSummary.trim() || "Continue the goal with the approved next plan.",
    "",
    "Approved next plan prompt:",
    proposal.proposedPrompt.trim() || "(no proposed prompt recorded)",
  ].join("\n");

  const sources = [
    `- Prior Goal Brief snapshot: ${snapshotPath ?? "none (no prior brief)"}`,
    `- Latest Plan Report: ${reportPath ?? "none"}`,
    `- Previous proposed next plan prompt: ${proposal.proposedPrompt.trim() || "(none)"}`,
    `- Previous Next Plan Summary: ${proposal.briefSummary.trim() || "(none)"}`,
    `- Previous When: ${proposal.runAt}`,
    `- Previous Decision(s) needed: ${formatProposalDecisions(proposal)}`,
    `- User Request Edit message: ${editMessage && editMessage.length > 0 ? editMessage : "None"}`,
    `- Approved continuation proposal: ${proposal.proposalId}`,
  ].join("\n");

  const section = (heading: string, body: string | undefined, fallback: string): string =>
    `## ${heading}\n\n${body && body.trim().length > 0 ? body.trim() : fallback}\n`;

  const content = [
    "# Goal Brief",
    "",
    section(
      "Goal Summary",
      carried.get("Goal Summary"),
      wholeGoalSummaryFallback(carried, run.goal),
    ),
    section("Long Goal Summary", carried.get("Long Goal Summary"), run.goal),
    section("Original User Ask", carried.get("Original User Ask"), run.goal),
    section("Key Decision summaries", carried.get("Key Decision summaries"), "None yet."),
    section("Next Plan Intent", nextPlanIntent, nextPlanIntent),
    section("Remaining Work", nextPlanFields.remainingWork, nextPlanFields.remainingWork),
    section(
      "Next Observation Point",
      nextPlanFields.nextObservationPoint,
      nextPlanFields.nextObservationPoint,
    ),
    section("Manual Tests", nextPlanFields.manualTests, nextPlanFields.manualTests),
    section("Sources", sources, sources),
  ].join("\n");

  fs.writeFileSync(briefPath, content, "utf8");
  return { briefPath, snapshotPath, content };
}
