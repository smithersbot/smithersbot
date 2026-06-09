import { applyGoalResumeNoteById } from "../commands/goal-resume-note.js";
import type { MoltbotConfig } from "../config/types.js";
import { sanitizeUserFacingText } from "../agents/pi-embedded-helpers.js";
import {
  buildContinuationProposal,
  CONTINUATION_REVISION_BACKEND_UNAVAILABLE_MESSAGE,
  generateContinuationFromAchievedState,
  reviseContinuationProposal,
} from "../goal/continuation.js";
import { loadRun, resolveRunId, saveRun } from "../goal/run-store.js";
import type { GoalLlmClient, ResumeNoteSource, SerializedRun } from "../goal/types.js";
import {
  renderContinuationDetailsSurface,
  renderRecommendedContinuationSurface,
} from "./goal-continuation.js";
import { resolveContinuationClient } from "./continuation-client.js";
import {
  buildContinuationApprovePreface,
  resolveGoalOperatorHonorific,
} from "./goal-formatting.js";

export type ContinuationCoreMessage = {
  text: string;
  replyMarkup?: unknown;
};

export type ContinuationCoreResult = {
  runId?: string;
  messages: ContinuationCoreMessage[];
  state?: SerializedRun["state"];
  run?: SerializedRun;
};

export type ContinuationProposalAction =
  | "approve_prompt"
  | "more_details"
  | "request_edit"
  | "no_further_plan"
  | "make_another_plan";

export type PendingActionKind = "continuation_edit" | "add_details";

export type PendingContinuationNotify = NonNullable<
  NonNullable<SerializedRun["pendingContinuation"]>["notify"]
>;

export type ApplyResumeDetailsResult = ContinuationCoreResult & {
  status: "not_found" | "missing" | "noop" | "applied";
  rescheduledStepIds?: string[];
};

const ADD_DETAILS_PROMPT = "Reply to the blocked message with unblocking details.";
const CONTINUATION_EDIT_PROMPT = "✏️ Reply with edits to the continuation prompt.";

function message(text: string, replyMarkup?: unknown): ContinuationCoreMessage {
  return replyMarkup == null ? { text } : { text, replyMarkup };
}

function formatContinuationRevisionFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const sanitized = sanitizeUserFacingText(text);
  return sanitized.trim() || CONTINUATION_REVISION_BACKEND_UNAVAILABLE_MESSAGE;
}

export function archiveContinuationCore(
  run: SerializedRun,
  status: NonNullable<SerializedRun["pendingContinuation"]>["status"],
): void {
  if (!run.pendingContinuation) return;
  const archived = {
    ...run.pendingContinuation,
    status,
  };
  run.continuationHistory = [...(run.continuationHistory ?? []), archived];
  run.pendingContinuation = undefined;
}

function resolveRunForCore(rawId: string): { runId?: string; run?: SerializedRun; error?: string } {
  const trimmed = rawId.trim();
  const resolvedId = resolveRunId(trimmed);
  if (!resolvedId) return { error: `Run not found: ${trimmed}` };
  const run = loadRun(resolvedId);
  if (!run) return { runId: resolvedId, error: `Run file missing: ${resolvedId}` };
  return { runId: resolvedId, run };
}

function resolveContinuationForCore(params: { runId: string; proposalIdPrefix: string }): {
  runId?: string;
  run?: SerializedRun;
  error?: string;
} {
  const resolved = resolveRunForCore(params.runId);
  if (!resolved.run || !resolved.runId) return resolved;
  const proposal = resolved.run.pendingContinuation;
  const isCurrentProposal =
    proposal?.proposalId.startsWith(params.proposalIdPrefix) &&
    (proposal.status === "pending" || proposal.status === "edited");
  if (!isCurrentProposal || !proposal) {
    return {
      runId: resolved.runId,
      run: resolved.run,
      error: "That continuation prompt is no longer current.",
    };
  }
  return resolved;
}

function resolveCurrentContinuationForCore(params: {
  runId: string;
  proposalIdPrefix: string;
  strictProposalMatch: boolean;
}): {
  runId?: string;
  run?: SerializedRun;
  error?: string;
} {
  if (params.strictProposalMatch) {
    return resolveContinuationForCore(params);
  }

  const resolved = resolveRunForCore(params.runId);
  if (!resolved.run || !resolved.runId) return resolved;
  const proposal = resolved.run.pendingContinuation;
  if (!proposal || (proposal.status !== "pending" && proposal.status !== "edited")) {
    return {
      runId: resolved.runId,
      run: resolved.run,
      error: "That continuation prompt is no longer current.",
    };
  }
  return resolved;
}

export async function handleContinuationProposalAction(params: {
  action: ContinuationProposalAction;
  runId: string;
  proposalIdPrefix: string;
  notify?: PendingContinuationNotify;
  client?: GoalLlmClient;
  config?: MoltbotConfig;
}): Promise<ContinuationCoreResult> {
  const resolved = resolveCurrentContinuationForCore({
    runId: params.runId,
    proposalIdPrefix: params.proposalIdPrefix,
    strictProposalMatch: params.action === "approve_prompt",
  });
  if (!resolved.run || !resolved.runId) {
    return { runId: resolved.runId, messages: [message(resolved.error ?? "Run not found.")] };
  }
  if (resolved.error) {
    return {
      runId: resolved.runId,
      run: resolved.run,
      state: resolved.run.state,
      messages: [message(resolved.error)],
    };
  }

  const run = resolved.run;
  const proposal = run.pendingContinuation!;

  if (params.action === "more_details") {
    const surface = renderContinuationDetailsSurface({ runId: resolved.runId, proposal });
    return {
      runId: resolved.runId,
      run,
      state: run.state,
      messages: [message(surface.text, surface.replyMarkup)],
    };
  }

  if (params.action === "request_edit") {
    if (params.notify) {
      const latest = loadRun(resolved.runId);
      if (latest?.pendingContinuation?.proposalId === proposal.proposalId) {
        latest.pendingContinuation = {
          ...latest.pendingContinuation,
          notify: params.notify,
        };
        latest.updatedAt = new Date().toISOString();
        saveRun(latest);
        return {
          runId: resolved.runId,
          run: latest,
          state: latest.state,
          messages: [message(CONTINUATION_EDIT_PROMPT)],
        };
      }
    }
    return {
      runId: resolved.runId,
      run,
      state: run.state,
      messages: [message(CONTINUATION_EDIT_PROMPT)],
    };
  }

  if (params.action === "no_further_plan") {
    const latest = loadRun(resolved.runId) ?? run;
    archiveContinuationCore(latest, "superseded");
    latest.state = "done";
    latest.updatedAt = new Date().toISOString();
    saveRun(latest);
    return {
      runId: resolved.runId,
      run: latest,
      state: latest.state,
      messages: [message("🛑 No further plan will be created for this goal.")],
    };
  }

  if (params.action === "make_another_plan") {
    const latest = loadRun(resolved.runId) ?? run;
    if (latest.pendingContinuation?.proposalId !== proposal.proposalId) {
      return {
        runId: resolved.runId,
        run: latest,
        state: latest.state,
        messages: [message("That continuation prompt is no longer current.")],
      };
    }
    const assessment = await generateContinuationFromAchievedState({
      run: latest,
      client: params.client,
    });
    latest.pendingContinuation = {
      ...buildContinuationProposal({ run: latest, assessment }),
      proposalId: latest.pendingContinuation.proposalId,
      goalAchieved: false,
      status: "pending",
      createdAt: latest.pendingContinuation.createdAt,
      ...(latest.pendingContinuation.notify ? { notify: latest.pendingContinuation.notify } : {}),
    };
    latest.updatedAt = new Date().toISOString();
    saveRun(latest);
    const surface = renderRecommendedContinuationSurface({
      runId: resolved.runId,
      proposal: latest.pendingContinuation,
    });
    return {
      runId: resolved.runId,
      run: latest,
      state: latest.state,
      messages: [message(surface.text, surface.replyMarkup)],
    };
  }

  return {
    runId: resolved.runId,
    run,
    state: run.state,
    messages: [
      message(
        buildContinuationApprovePreface(
          run,
          params.config ? resolveGoalOperatorHonorific(params.config) : undefined,
        ),
      ),
    ],
  };
}

export async function applyContinuationEditReply(params: {
  runId: string;
  text: string;
  client?: GoalLlmClient;
  config?: MoltbotConfig;
}): Promise<ContinuationCoreResult> {
  const resolved = resolveRunForCore(params.runId);
  if (!resolved.run || !resolved.runId) {
    return { runId: resolved.runId, messages: [message(resolved.error ?? "Run not found.")] };
  }
  const proposal = resolved.run.pendingContinuation;
  if (!proposal || (proposal.status !== "pending" && proposal.status !== "edited")) {
    return {
      runId: resolved.runId,
      run: resolved.run,
      state: resolved.run.state,
      messages: [message("No pending continuation prompt is awaiting edits for this goal.")],
    };
  }
  const trimmed = params.text.trim();
  if (!trimmed) {
    return {
      runId: resolved.runId,
      run: resolved.run,
      state: resolved.run.state,
      messages: [message("Reply with edits to the continuation prompt.")],
    };
  }
  let revised: NonNullable<SerializedRun["pendingContinuation"]>;
  try {
    revised = await reviseContinuationProposal({
      run: resolved.run,
      proposal,
      editInstruction: trimmed,
      client:
        params.client ?? (params.config ? resolveContinuationClient(params.config) : undefined),
    });
  } catch (error) {
    return {
      runId: resolved.runId,
      run: resolved.run,
      state: resolved.run.state,
      messages: [message(formatContinuationRevisionFailure(error))],
    };
  }
  resolved.run.pendingContinuation = revised;
  resolved.run.updatedAt = new Date().toISOString();
  saveRun(resolved.run);
  const surface = renderRecommendedContinuationSurface({
    runId: resolved.runId,
    proposal: resolved.run.pendingContinuation,
  });
  return {
    runId: resolved.runId,
    run: resolved.run,
    state: resolved.run.state,
    messages: [message(surface.text, surface.replyMarkup)],
  };
}

export function openAddDetailsReply(params: { runId: string }): ContinuationCoreResult {
  const resolved = resolveRunForCore(params.runId);
  if (!resolved.run || !resolved.runId) {
    return { runId: resolved.runId, messages: [message(resolved.error ?? "Run not found.")] };
  }
  return {
    runId: resolved.runId,
    run: resolved.run,
    state: resolved.run.state,
    messages: [message(ADD_DETAILS_PROMPT)],
  };
}

export function applyResumeDetailsReply(params: {
  runId: string;
  text?: string;
  source: ResumeNoteSource;
  now?: () => string;
}): ApplyResumeDetailsResult {
  const resolved = resolveRunForCore(params.runId);
  if (!resolved.run || !resolved.runId) {
    return {
      status: resolved.runId ? "missing" : "not_found",
      runId: resolved.runId,
      messages: [message(resolved.error ?? "Run not found.")],
    };
  }

  const result = applyGoalResumeNoteById({
    runId: resolved.runId,
    source: params.source,
    userText: params.text,
    now: params.now,
  });

  if (result.status === "not_found" || result.status === "missing") {
    return {
      status: result.status,
      runId: resolved.runId,
      messages: [message(result.message)],
    };
  }

  if (result.status === "noop") {
    return {
      status: "noop",
      runId: resolved.runId,
      run: result.run,
      state: result.run.state,
      messages: [message(result.message)],
    };
  }

  return {
    status: "applied",
    runId: resolved.runId,
    run: result.run,
    state: result.run.state,
    rescheduledStepIds: result.rescheduledStepIds,
    messages: [message(result.message)],
  };
}

export const CONTINUATION_CORE_MESSAGES = {
  ADD_DETAILS_PROMPT,
  CONTINUATION_EDIT_PROMPT,
};
