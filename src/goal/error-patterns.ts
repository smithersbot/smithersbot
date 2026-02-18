// Shared error-classification regex patterns used by both pi-runner and cli-worker.

export const RATE_LIMIT_RE =
  /rate.?limit|429|too many requests|overloaded|usage.limit|you(?:'|’)?ve hit your (?:usage )?limit|you have hit your (?:usage )?limit|resets?\s+\d/i;
export const CREDITS_RE = /credit|balance|billing|insufficient.*funds|payment|quota.*exceeded/i;
export const AUTH_RE = /401|403|unauthorized|forbidden|invalid.*key|authentication/i;
export const NETWORK_RE =
  /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|socket hang up|EAI_AGAIN/i;
