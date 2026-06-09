import type { Bot } from "grammy";

import { hasCurrentDeliveredSurface } from "../goal/continuation-delivery.js";
import { acquireGoalOpLock } from "../goal/goal-lock.js";
import { loadRun, saveRun } from "../goal/run-store.js";
import type { ContinuationProposal, SerializedRun } from "../goal/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { renderRecommendedContinuationSurface } from "./goal-continuation.js";
import { sendGoalReply } from "./goal-sending.js";

type ChatTarget = {
  chatId: number;
  threadId?: number;
};

export type ReconcileContinuationSurfaceParams = {
  runId: string;
  bot: Bot;
  runtime: RuntimeEnv;
  chat?: Partial<ChatTarget>;
  force?: boolean;
  assumeRunLockHeld?: boolean;
};

export type ReconcileContinuationSurfaceResult =
  | { status: "noop"; reason: "not_pending" | "already_delivered" | "locked" | "missing_run" }
  | { status: "sent"; messageId: number; proposalId: string }
  | { status: "failed"; proposalId?: string; error: string };

type DeliveryReservation = {
  runId: string;
  proposal: ContinuationProposal;
  chat: ChatTarget;
  replyToMessageId?: number;
};

type LockProtected<T> = T | { status: "noop"; reason: "locked" };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isActionableContinuation(run: SerializedRun): boolean {
  const status = run.pendingContinuation?.status;
  return status === "pending" || status === "edited";
}

function resolveChatTarget(
  run: SerializedRun,
  chat: Partial<ChatTarget> | undefined,
): ChatTarget | undefined {
  if (typeof chat?.chatId === "number") {
    return { chatId: chat.chatId, threadId: chat.threadId };
  }
  if (typeof run.telegramDoneMessage?.chatId === "number") {
    return {
      chatId: run.telegramDoneMessage.chatId,
      threadId: run.telegramDoneMessage.threadId,
    };
  }
  if (typeof run.telegramPlanMessage?.chatId === "number") {
    return {
      chatId: run.telegramPlanMessage.chatId,
      threadId: run.telegramPlanMessage.threadId,
    };
  }
  return undefined;
}

function withRunLock<T>(
  runId: string,
  assumeRunLockHeld: boolean | undefined,
  fn: () => T,
): LockProtected<T> {
  if (assumeRunLockHeld) return fn();

  const lock = acquireGoalOpLock(runId, "continuation-delivery");
  if (!lock.acquired) return { status: "noop", reason: "locked" };
  try {
    return fn();
  } finally {
    lock.release();
  }
}

function reserveDeliveryLocked(
  params: ReconcileContinuationSurfaceParams,
): ReconcileContinuationSurfaceResult | DeliveryReservation {
  const run = loadRun(params.runId);
  if (!run) return { status: "noop", reason: "missing_run" };
  if (!isActionableContinuation(run) || !run.pendingContinuation) {
    return { status: "noop", reason: "not_pending" };
  }
  if (!params.force && hasCurrentDeliveredSurface(run)) {
    return { status: "noop", reason: "already_delivered" };
  }

  const proposal = run.pendingContinuation;
  const chat = resolveChatTarget(run, params.chat);
  if (!chat) {
    const error = "No Telegram chat target available for continuation delivery.";
    run.continuationDelivery = {
      proposalId: proposal.proposalId,
      failed: true,
      error,
      failedAt: new Date().toISOString(),
    };
    saveRun(run);
    return { status: "failed", proposalId: proposal.proposalId, error };
  }

  run.continuationDelivery = {
    proposalId: proposal.proposalId,
    chatId: chat.chatId,
    threadId: chat.threadId,
    inProgress: { startedAt: new Date().toISOString() },
  };
  saveRun(run);
  return {
    runId: run.runId,
    proposal,
    chat,
    replyToMessageId: run.telegramDoneMessage?.messageId ?? run.telegramPlanMessage?.messageId,
  };
}

function reserveDelivery(
  params: ReconcileContinuationSurfaceParams,
): ReconcileContinuationSurfaceResult | DeliveryReservation {
  return withRunLock(params.runId, params.assumeRunLockHeld, () => reserveDeliveryLocked(params));
}

function persistDeliverySuccessLocked(reservation: DeliveryReservation, messageId: number): void {
  const run = loadRun(reservation.runId);
  if (run?.pendingContinuation?.proposalId !== reservation.proposal.proposalId) return;

  run.continuationDelivery = {
    proposalId: reservation.proposal.proposalId,
    chatId: reservation.chat.chatId,
    messageId,
    threadId: reservation.chat.threadId,
    deliveredAt: new Date().toISOString(),
  };
  run.pendingContinuation = {
    ...run.pendingContinuation,
    notify: {
      chatId: reservation.chat.chatId,
      messageId,
      threadId: reservation.chat.threadId,
    },
  };
  saveRun(run);
}

function persistDeliverySuccess(
  reservation: DeliveryReservation,
  messageId: number,
  assumeRunLockHeld?: boolean,
): void {
  withRunLock(reservation.runId, assumeRunLockHeld, () =>
    persistDeliverySuccessLocked(reservation, messageId),
  );
}

function persistDeliveryFailureLocked(reservation: DeliveryReservation, error: string): void {
  const run = loadRun(reservation.runId);
  if (run?.pendingContinuation?.proposalId !== reservation.proposal.proposalId) return;

  run.continuationDelivery = {
    proposalId: reservation.proposal.proposalId,
    chatId: reservation.chat.chatId,
    threadId: reservation.chat.threadId,
    failed: true,
    error,
    failedAt: new Date().toISOString(),
  };
  saveRun(run);
}

function persistDeliveryFailure(
  reservation: DeliveryReservation,
  error: string,
  assumeRunLockHeld?: boolean,
): void {
  withRunLock(reservation.runId, assumeRunLockHeld, () =>
    persistDeliveryFailureLocked(reservation, error),
  );
}

export async function reconcileContinuationSurface(
  params: ReconcileContinuationSurfaceParams,
): Promise<ReconcileContinuationSurfaceResult> {
  const reservation = reserveDelivery(params);
  if ("status" in reservation) return reservation;

  const surface = renderRecommendedContinuationSurface({
    runId: reservation.runId,
    proposal: reservation.proposal,
  });

  try {
    const messageId = await sendGoalReply(
      params.bot,
      reservation.chat.chatId,
      surface.text,
      params.runtime,
      reservation.chat.threadId,
      reservation.replyToMessageId,
      surface.replyMarkup,
    );
    if (typeof messageId !== "number") {
      throw new Error("Telegram did not return a message id.");
    }
    persistDeliverySuccess(reservation, messageId, params.assumeRunLockHeld);
    return { status: "sent", messageId, proposalId: reservation.proposal.proposalId };
  } catch (error) {
    const message = describeError(error);
    persistDeliveryFailure(reservation, message, params.assumeRunLockHeld);
    return { status: "failed", proposalId: reservation.proposal.proposalId, error: message };
  }
}
