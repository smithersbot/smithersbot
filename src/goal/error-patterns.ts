// Shared error-classification regex patterns used by both pi-runner and cli-worker.

export const RATE_LIMIT_RE =
  /rate.?limit|429|too many requests|overloaded|usage.limit|you(?:'|’)?ve hit your (?:usage )?limit|you have hit your (?:usage )?limit|resets?\s+\d/i;
export const PROVIDER_TRANSIENT_OVERLOAD_RE =
  /\b(?:5\d{2}|529)\b|overloaded|server-side issue|service unavailable/i;
export const CREDITS_RE = /credit|balance|billing|insufficient.*funds|payment|quota.*exceeded/i;
export const AUTH_RE = /401|403|unauthorized|forbidden|invalid.*key|authentication/i;
export const NETWORK_RE =
  /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|socket hang up|EAI_AGAIN/i;

export type ProviderErrorKind = "rate_limit" | "out_of_credits" | "auth" | "network";

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
  if (params.assistantError === "billing_error") return "out_of_credits";

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
