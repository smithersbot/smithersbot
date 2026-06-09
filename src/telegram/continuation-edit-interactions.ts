import { COMMAND_ANCHOR_TTL_MS } from "./command-fragments.js";

export type PendingContinuationEditInteraction = {
  chatId: number;
  threadId?: number;
  senderId: string;
  runId: string;
  originalMessageId?: number;
  promptMessageId?: number;
  supersededMessageIds?: number[];
  createdAtMs: number;
  expiresAtMs: number;
};

type PendingContinuationEditKey = {
  chatId: number;
  threadId?: number;
  senderId: string;
  runId: string;
};

const pendingContinuationEdits = new Map<string, PendingContinuationEditInteraction>();

function buildKey(params: PendingContinuationEditKey): string {
  return [params.chatId, params.threadId ?? "main", params.senderId, params.runId].join(":");
}

function isExpired(interaction: PendingContinuationEditInteraction, nowMs: number): boolean {
  return nowMs >= interaction.expiresAtMs;
}

export function recordPendingContinuationEditInteraction(
  params: Omit<PendingContinuationEditInteraction, "createdAtMs" | "expiresAtMs"> & {
    nowMs?: number;
    ttlMs?: number;
  },
): PendingContinuationEditInteraction {
  const nowMs = params.nowMs ?? Date.now();
  const key = buildKey(params);
  const existing = pendingContinuationEdits.get(key);
  const supersededMessageIds = new Set(params.supersededMessageIds ?? []);
  for (const id of existing?.supersededMessageIds ?? []) {
    supersededMessageIds.add(id);
  }
  if (
    existing?.originalMessageId != null &&
    existing.originalMessageId !== params.originalMessageId
  ) {
    supersededMessageIds.add(existing.originalMessageId);
  }
  if (existing?.promptMessageId != null && existing.promptMessageId !== params.promptMessageId) {
    supersededMessageIds.add(existing.promptMessageId);
  }
  const interaction: PendingContinuationEditInteraction = {
    chatId: params.chatId,
    threadId: params.threadId,
    senderId: params.senderId,
    runId: params.runId,
    originalMessageId: params.originalMessageId,
    promptMessageId: params.promptMessageId,
    supersededMessageIds: [...supersededMessageIds],
    createdAtMs: nowMs,
    expiresAtMs: nowMs + (params.ttlMs ?? COMMAND_ANCHOR_TTL_MS),
  };
  pendingContinuationEdits.set(key, interaction);
  return interaction;
}

export function getPendingContinuationEditInteraction(
  params: PendingContinuationEditKey,
): PendingContinuationEditInteraction | undefined {
  const key = buildKey(params);
  const interaction = pendingContinuationEdits.get(key);
  if (!interaction) return undefined;
  if (isExpired(interaction, Date.now())) {
    pendingContinuationEdits.delete(key);
    return undefined;
  }
  return interaction;
}

export function findPendingContinuationEditInteraction(params: {
  chatId: number;
  threadId?: number;
  senderId: string;
  runIds?: readonly string[];
}): PendingContinuationEditInteraction | undefined {
  const nowMs = Date.now();
  for (const [key, interaction] of pendingContinuationEdits) {
    if (isExpired(interaction, nowMs)) {
      pendingContinuationEdits.delete(key);
      continue;
    }
    if (interaction.chatId !== params.chatId) continue;
    if ((interaction.threadId ?? "main") !== (params.threadId ?? "main")) continue;
    if (interaction.senderId !== params.senderId) continue;
    if (params.runIds && !params.runIds.includes(interaction.runId)) continue;
    return interaction;
  }
  return undefined;
}

export function clearPendingContinuationEditInteraction(params: PendingContinuationEditKey): void {
  pendingContinuationEdits.delete(buildKey(params));
}

export function clearAllPendingContinuationEditInteractionsForTest(): void {
  pendingContinuationEdits.clear();
}
