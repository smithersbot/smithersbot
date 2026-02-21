// Shared error-classification regex patterns used by both pi-runner and cli-worker.

export const RATE_LIMIT_RE =
  /rate.?limit|429|too many requests|overloaded|usage.limit|you(?:'|’)?ve hit your (?:usage )?limit|you have hit your (?:usage )?limit|resets?\s+\d/i;
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
