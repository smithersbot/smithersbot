import type { InlineKeyboardMarkup } from "grammy/types";

import type { ContinuationProposal, ContinuationProposalDecision } from "../goal/types.js";
import { buildInlineKeyboard } from "./send.js";

export const CONTINUATION_APPROVE_PREFIX = "gca";
export const CONTINUATION_EDIT_PREFIX = "gce";
export const CONTINUATION_DETAILS_PREFIX = "gcm";
export const CONTINUATION_STOP_PREFIX = "gcs";
export const CONTINUATION_MAKE_ANOTHER_PREFIX = "gcn";

export type ContinuationSurface = {
  text: string;
  replyMarkup?: InlineKeyboardMarkup;
};

function formatCaptionLabel(label: string, value: string): string {
  return `**${label}:** ${value}`;
}

function formatSectionLabel(label: string): string {
  return `**${label}:**`;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function compactSurfaceLines(lines: string[]): string {
  return lines
    .flatMap((line) => line.replace(/\r\n/g, "\n").split("\n"))
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

export function buildContinuationCallbackData(
  prefix: string,
  runId: string,
  proposalId: string,
): string {
  const callbackData = `${prefix}:${shortId(runId)}:${shortId(proposalId)}`;
  if (callbackData.length > 64) {
    throw new Error("Continuation callback_data exceeds Telegram limit");
  }
  return callbackData;
}

export function buildContinuationPromptInlineKeyboard(params: {
  runId: string;
  proposalId: string;
  includeDetails?: boolean;
}): InlineKeyboardMarkup {
  return buildInlineKeyboard([
    [
      {
        text: "❤️ Approve",
        callback_data: buildContinuationCallbackData(
          CONTINUATION_APPROVE_PREFIX,
          params.runId,
          params.proposalId,
        ),
      },
      {
        text: "🔍 View Prompt",
        callback_data: buildContinuationCallbackData(
          CONTINUATION_DETAILS_PREFIX,
          params.runId,
          params.proposalId,
        ),
      },
    ],
    [
      {
        text: "📝 Request Edit",
        callback_data: buildContinuationCallbackData(
          CONTINUATION_EDIT_PREFIX,
          params.runId,
          params.proposalId,
        ),
      },
    ],
  ])!;
}

export function buildGoalAchievedContinuationInlineKeyboard(params: {
  runId: string;
  proposalId: string;
}): InlineKeyboardMarkup {
  return buildInlineKeyboard([
    [
      {
        text: "➕ Make Another Plan",
        callback_data: buildContinuationCallbackData(
          CONTINUATION_MAKE_ANOTHER_PREFIX,
          params.runId,
          params.proposalId,
        ),
      },
    ],
  ])!;
}

function formatDecisionSummary(decisions: ContinuationProposalDecision[] | undefined): string {
  const normalized = (decisions ?? [])
    .map((decision) => ({
      question: decision.question.trim(),
      options: decision.options.map((option) => option.trim()).filter(Boolean),
      recommendedOption: decision.recommendedOption.trim(),
    }))
    .filter((decision) => decision.question && decision.options.length > 0);
  if (normalized.length === 0) return "None";
  return normalized
    .map((decision, index) => {
      const question = decision.question.trim();
      const lines = [`**Decision ${index + 1}.** ${question}`];
      decision.options.forEach((option, optionIndex) => {
        const label = String.fromCharCode("A".charCodeAt(0) + optionIndex);
        const labelText =
          option === decision.recommendedOption
            ? `**(${label}): (Recommended)**`
            : `**(${label})**`;
        lines.push(`${labelText} ${option}`);
      });
      return lines.join("\n");
    })
    .join("\n");
}

export function renderRecommendedContinuationSurface(params: {
  runId: string;
  proposal: ContinuationProposal;
}): ContinuationSurface {
  const text = compactSurfaceLines([
    "🧭 **Continue this goal with a new plan?**",
    formatSectionLabel("Next Plan Summary"),
    params.proposal.briefSummary,
    formatCaptionLabel("When", "Now"),
    formatSectionLabel("Decision(s) needed"),
    formatDecisionSummary(params.proposal.decisions),
    formatCaptionLabel("Goal ID", shortId(params.runId)),
  ]);

  return {
    text,
    replyMarkup: buildContinuationPromptInlineKeyboard({
      runId: params.runId,
      proposalId: params.proposal.proposalId,
      includeDetails: true,
    }),
  };
}

export function renderGoalAchievedContinuationSurface(params: {
  runId: string;
  proposal: ContinuationProposal;
}): ContinuationSurface {
  const text = [
    "✅ Goal appears achieved",
    "No next plan is recommended right now.",
    formatCaptionLabel("Goal ID", shortId(params.runId)),
  ].join("\n");

  return {
    text,
    replyMarkup: buildGoalAchievedContinuationInlineKeyboard({
      runId: params.runId,
      proposalId: params.proposal.proposalId,
    }),
  };
}

export function renderContinuationDetailsSurface(params: {
  runId: string;
  proposal: ContinuationProposal;
}): ContinuationSurface {
  const text = [
    `**Proposed next plan prompt for Goal ${shortId(params.runId)}:**`,
    params.proposal.proposedPrompt,
  ].join("\n");

  return {
    text,
  };
}
