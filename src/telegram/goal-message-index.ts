import { listRuns, loadRun } from "../goal/run-store.js";
import type { SerializedRun } from "../goal/types.js";

// ---------------------------------------------------------------------------
// In-memory index for O(1) plan-message → runId lookups
//
// Replaces the full-disk scan in findRunByPlanMessageId.
// Lazily populated on first access; write-through on persist.
// ---------------------------------------------------------------------------

/** Key format: "chatId:messageId" */
type IndexKey = string;

const index = new Map<IndexKey, string>(); // key → runId
let populated = false;

function makeKey(chatId: number, messageId: number): IndexKey {
  return `${chatId}:${messageId}`;
}

/** One-time scan of all runs to build the index. */
function ensurePopulated(): void {
  if (populated) return;

  for (const summary of listRuns()) {
    const run = loadRun(summary.runId);
    if (!run?.telegramPlanMessage) continue;
    const { chatId, messageId, messageHistory } = run.telegramPlanMessage;
    index.set(makeKey(chatId, messageId), run.runId);
    if (messageHistory) {
      for (const histMsgId of messageHistory) {
        index.set(makeKey(chatId, histMsgId), run.runId);
      }
    }
  }
  populated = true;
}

/**
 * Look up a run by its Telegram plan message ID.
 * Uses the in-memory index for O(1) lookups; falls through to a full scan on cache miss.
 */
export function findRunByPlanMessageIdIndexed(
  chatId: number,
  messageId: number,
): SerializedRun | undefined {
  ensurePopulated();

  const key = makeKey(chatId, messageId);
  const cachedRunId = index.get(key);

  if (cachedRunId) {
    const run = loadRun(cachedRunId);
    if (run) return run;
    // Run was deleted — evict stale entry and fall through to scan
    index.delete(key);
  }

  // Cache miss — full scan fallback (rare after warmup)
  for (const summary of listRuns()) {
    const run = loadRun(summary.runId);
    if (!run?.telegramPlanMessage) continue;
    if (run.telegramPlanMessage.chatId !== chatId) continue;
    if (
      run.telegramPlanMessage.messageId === messageId ||
      run.telegramPlanMessage.messageHistory?.includes(messageId)
    ) {
      // Backfill the index for future lookups
      index.set(key, run.runId);
      return run;
    }
  }
  return undefined;
}

/**
 * Write-through: call after persisting a plan message so the index stays current.
 * Also indexes old messageIds moved to history.
 */
export function indexPlanMessage(
  chatId: number,
  messageId: number,
  runId: string,
  oldMessageId?: number,
): void {
  index.set(makeKey(chatId, messageId), runId);
  if (oldMessageId != null) {
    index.set(makeKey(chatId, oldMessageId), runId);
  }
}

/** Reset the index (for testing). */
export function resetMessageIndex(): void {
  index.clear();
  populated = false;
}
