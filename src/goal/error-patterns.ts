// Shared error-classification regex patterns used by both pi-runner and cli-worker.

export const RATE_LIMIT_RE =
  /rate.?limit|429|too many requests|overloaded|usage.limit|you(?:'|’)?ve hit your (?:usage )?limit|you have hit your (?:usage )?limit|resets?\s+\d/i;
export const PROVIDER_TRANSIENT_OVERLOAD_RE =
  /\b(?:5\d{2}|529)\b|overloaded|server-side issue|service unavailable/i;
export const CREDITS_RE = /credit|balance|billing|insufficient.*funds|payment|quota.*exceeded/i;
export const AUTH_RE =
  /401|403|unauthorized|forbidden|invalid.*key|authentication|not logged in|log in|login/i;
export const NETWORK_RE =
  /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|socket hang up|EAI_AGAIN/i;

export type ProviderErrorKind = "rate_limit" | "out_of_credits" | "auth" | "network";

/**
 * Block reasons that all represent a backend usage/quota/rate limit. These three
 * are treated uniformly: out-of-credits, a usage (quota) limit, and a transient
 * rate limit are all eligible for cross-backend fallback and render as
 * "usage-limited" rather than as a fatal/global-stop or a user-input blocker.
 */
export type UsageLimitClassReason = "out_of_credits" | "usage_limit" | "rate_limit";

/**
 * True when a blocked-step reason represents a backend usage limit of any kind.
 * Used by the scheduler fallback gate, fallback-backend selection, usage-limited
 * display, and resume so the three reasons stay in lockstep.
 */
export function isUsageLimitClassReason(
  reason: string | null | undefined,
): reason is UsageLimitClassReason {
  return reason === "out_of_credits" || reason === "usage_limit" || reason === "rate_limit";
}

/**
 * True when an error/blocked text represents a *transient* provider/server
 * overload (HTTP 5xx, 529, "overloaded", "server-side issue", "service
 * unavailable") rather than a quota/usage limit. Such failures clear on their
 * own, so — unlike a usage/quota limit — they are safe to auto-retry on the same
 * backend with exponential backoff before surfacing a user-facing (paused)
 * block. This mirrors how the planner already treats Anthropic 529s as transient
 * overload (anthropic_overloaded), distinct from a rate/usage limit.
 */
export function isTransientOverloadText(text: string | null | undefined): boolean {
  if (!text) return false;
  return PROVIDER_TRANSIENT_OVERLOAD_RE.test(text);
}

function matchesErrorKind(kind: ProviderErrorKind, text: string): boolean {
  switch (kind) {
    case "rate_limit":
      return RATE_LIMIT_RE.test(text);
    case "out_of_credits":
      return CREDITS_RE.test(text);
    case "auth":
      return AUTH_RE.test(text);
    case "network":
      return NETWORK_RE.test(text);
    default:
      return false;
  }
}

export function classifyProviderError(params: {
  text: string;
  assistantError?: string | null;
  preferCredits?: boolean;
}): ProviderErrorKind | undefined {
  const assistantError = params.assistantError?.trim() ?? "";
  if (/billing|credit|balance|insufficient/i.test(assistantError)) return "out_of_credits";
  if (/auth|login|logged.?in|unauthorized|forbidden/i.test(assistantError)) return "auth";
  if (/rate.?limit|usage.?limit|429|too.?many.?requests/i.test(assistantError)) {
    return "rate_limit";
  }
  if (/network|fetch|socket|connection|timeout/i.test(assistantError)) return "network";

  const orderedKinds: ProviderErrorKind[] = params.preferCredits
    ? ["out_of_credits", "auth", "rate_limit", "network"]
    : ["rate_limit", "out_of_credits", "auth", "network"];

  for (const kind of orderedKinds) {
    if (matchesErrorKind(kind, params.text)) return kind;
  }
  return undefined;
}

// --- Backend-attributed usage-limit classification ---------------------------
// A usage/rate limit always originates from a specific backend (the CLI that ran
// the task), so the backend is supplied by the caller rather than inferred from
// text. The limit *type* and reset hint, however, are recovered from the error
// message when the provider includes them.

/** The CLI backend that produced a usage/rate limit. */
export type UsageLimitBackend = "claude_code" | "codex";

/**
 * Best-effort classification of the usage-limit window the provider reported.
 * `unknown` is used when the message gives no recognizable hint.
 */
export type UsageLimitType = "five_hour" | "weekly" | "burst" | "monthly_extra" | "unknown";

export interface UsageLimitClassification {
  backend: UsageLimitBackend;
  limitType: UsageLimitType;
  /** Human-readable reset phrase extracted from the error (e.g. "resets at 3pm"). */
  resetHint?: string;
}

const USAGE_LIMIT_BURST_RE = /\bburst\b/i;
const USAGE_LIMIT_FIVE_HOUR_RE = /\b(?:5|five)[\s-]?hour\b|\bhourly\b/i;
const USAGE_LIMIT_WEEKLY_RE = /\bweekly\b|\b(?:7|seven)[\s-]?day\b|\bthis week\b|\bper week\b/i;
const USAGE_LIMIT_MONTHLY_RE =
  /\bmonthly\b|\bper month\b|\bthis month\b|extra[\s-]?usage|monthly extra/i;

/**
 * Extract a reset-time phrase from a usage-limit error message, if present.
 * Returns the matched phrase (e.g. "resets at 3:00pm") trimmed of trailing
 * punctuation, or undefined when no reset hint is found.
 */
export function extractUsageLimitResetHint(text: string): string | undefined {
  if (!text) return undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = /\b(resets?(?:\s+(?:at|in|on|by))?\s+[^.;,\n\r]+)/i.exec(line);
    if (match?.[1]) {
      const cleaned = match[1].trim().replace(/[).,;:\s]+$/, "");
      if (cleaned) return cleaned;
    }
  }
  return undefined;
}

/**
 * Classify a usage/rate limit for a known backend, recovering the limit window
 * type and reset hint from the error text where possible.
 */
export function classifyUsageLimit(params: {
  backend: UsageLimitBackend;
  text: string;
}): UsageLimitClassification {
  const text = params.text ?? "";
  const limitType: UsageLimitType = USAGE_LIMIT_BURST_RE.test(text)
    ? "burst"
    : USAGE_LIMIT_FIVE_HOUR_RE.test(text)
      ? "five_hour"
      : USAGE_LIMIT_WEEKLY_RE.test(text)
        ? "weekly"
        : USAGE_LIMIT_MONTHLY_RE.test(text)
          ? "monthly_extra"
          : "unknown";
  const resetHint = extractUsageLimitResetHint(text);
  return { backend: params.backend, limitType, ...(resetHint ? { resetHint } : {}) };
}
