// Shared single-attempt backend fallback for lightweight backend-driven phases
// (post-execution review, planner/scout, plan autocheck, manual tests, lessons,
// repo-chat). The worker execution loop in agent-executor.ts has its own
// attempt/fallback machinery; this helper gives every *other* phase the same
// usage-limit classification, single-attempt fallback, and consistent messaging
// without duplicating classification logic.
//
// Each backend in `backends` is tried at most once (the list is iterated once
// and de-duplicated), so there is no risk of an infinite fallback loop.

import type { CliWorkerId } from "../config/types.goal.js";
import { CREDITS_RE, RATE_LIMIT_RE, classifyUsageLimit } from "./error-patterns.js";
import {
  describeUsageLimitEvent,
  formatResetSummary,
  formatUsageLimitFallbackMessage,
  formatUsageLimitRecoveryMessage,
  type UsageLimitEvent,
  type UsageLimitKind,
} from "./usage-limit-message.js";

// An explicit quota/usage/monthly/weekly/burst cap reads as a usage limit; a
// bare 429 / "too many requests" / "overloaded" reads as a transient rate
// limit. These words are specific enough to avoid matching unrelated errors
// (e.g. "ralph limit reached" or "git reset failed").
const USAGE_LIMIT_WORDS_RE =
  /usage.?limit|monthly|weekly|burst|quota|extra[\s-]?usage|hit your (?:usage )?limit/i;

/**
 * Classify a backend failure message as a usage limit, a transient rate limit,
 * or neither. Returns undefined when the failure is not a usage/rate limit so
 * callers can preserve their existing handling for unrelated errors.
 */
export function detectUsageLimitKind(text: string | undefined | null): UsageLimitKind | undefined {
  if (!text) return undefined;
  const hasUsageWords = USAGE_LIMIT_WORDS_RE.test(text) || CREDITS_RE.test(text);
  const hasRateSignal = RATE_LIMIT_RE.test(text);
  if (!hasUsageWords && !hasRateSignal) return undefined;
  return hasUsageWords ? "usage_limit" : "rate_limit";
}

/** Result of a single backend attempt inside a fallback-driven phase. */
export type PhaseAttempt<T> = { ok: true; value: T } | { ok: false; errorText: string };

export type PhaseFallbackResult<T> =
  | {
      status: "success";
      value: T;
      backend: CliWorkerId;
      usageLimitEvents: UsageLimitEvent[];
      /** Set when an earlier backend hit a limit and this backend recovered it. */
      recoveryMessage?: string;
    }
  | {
      status: "exhausted";
      usageLimitEvents: UsageLimitEvent[];
      /** The last raw error text, for non-usage-limit failures. */
      lastErrorText: string;
      /** One clean final message preserving history + reset times where known. */
      message: string;
    };

/**
 * Run `attempt` against each backend in order, falling back to the next backend
 * once on a usage/rate limit (and, when `fallbackOnAnyError` is set, on any
 * error). Accumulates per-backend usage-limit events so the surfaced message
 * preserves the failure history, e.g. "Claude Code hit a usage limit (resets at
 * 3pm). Falling back to Codex." then "... Fell back to Codex. Codex succeeded."
 */
export async function runWithBackendFallback<T>(params: {
  backends: CliWorkerId[];
  attempt: (backend: CliWorkerId) => Promise<PhaseAttempt<T>>;
  onProgress?: (text: string) => void;
  /** Fall back to the next backend on ANY error, not just usage/rate limits. */
  fallbackOnAnyError?: boolean;
}): Promise<PhaseFallbackResult<T>> {
  const { attempt, onProgress, fallbackOnAnyError = false } = params;
  // De-duplicate while preserving order so each backend is tried at most once.
  const backends = [...new Set(params.backends)];
  const usageLimitEvents: UsageLimitEvent[] = [];
  let lastErrorText = "";

  for (let i = 0; i < backends.length; i += 1) {
    const backend = backends[i]!;
    const result = await attempt(backend);

    if (result.ok) {
      const recoveryMessage =
        usageLimitEvents.length > 0
          ? formatUsageLimitRecoveryMessage({
              events: usageLimitEvents,
              succeededBackend: backend,
            })
          : undefined;
      if (recoveryMessage) onProgress?.(`  [usage-limit] ${recoveryMessage}`);
      return {
        status: "success",
        value: result.value,
        backend,
        usageLimitEvents,
        ...(recoveryMessage ? { recoveryMessage } : {}),
      };
    }

    lastErrorText = result.errorText;
    const kind = detectUsageLimitKind(result.errorText);
    const nextBackend = backends[i + 1];

    if (kind) {
      const event: UsageLimitEvent = {
        kind,
        ...classifyUsageLimit({ backend, text: result.errorText }),
      };
      usageLimitEvents.push(event);
      if (nextBackend) {
        onProgress?.(
          `  [usage-limit] ${formatUsageLimitFallbackMessage({ event, fallbackBackend: nextBackend })}`,
        );
      }
      continue;
    }

    if (fallbackOnAnyError && nextBackend) continue;
    break;
  }

  return {
    status: "exhausted",
    usageLimitEvents,
    lastErrorText,
    message: buildExhaustedMessage(usageLimitEvents, lastErrorText),
  };
}

/**
 * Build one clean final message when no backend recovered the phase. When usage
 * limits were involved, preserves the per-backend history and a reset-time
 * summary; otherwise falls back to the last raw error text.
 */
export function buildExhaustedMessage(events: UsageLimitEvent[], lastErrorText: string): string {
  if (events.length === 0) return lastErrorText || "all compatible backends failed";
  const history = events.map((event) => `${describeUsageLimitEvent(event)}.`);
  const parts = [...history, "All compatible backends are exhausted."];
  const resetSummary = formatResetSummary(events);
  if (resetSummary) parts.push(resetSummary);
  return parts.join(" ");
}
