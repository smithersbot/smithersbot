import type { CliWorkerId } from "../config/types.goal.js";
import { AUTH_RE, classifyUsageLimit } from "./error-patterns.js";
import { detectUsageLimitKind } from "./phase-fallback.js";
import type { UsageLimitEvent } from "./usage-limit-message.js";

const BINARY_MISSING_RE =
  /\b(?:enoent|command not found|not recognized as (?:an internal|a) command|executable file not found|no such file or directory)\b/i;
const AUTH_MISSING_RE =
  /\b(?:not logged in|login required|please log in|authentication required|auth(?:entication)? missing|missing (?:api )?key|invalid (?:api )?key)\b/i;

export function classifyUsageLimitEvent(params: {
  backend: CliWorkerId;
  text: string | null | undefined;
}): UsageLimitEvent | undefined {
  const text = params.text?.trim();
  if (!text) return undefined;
  if (BINARY_MISSING_RE.test(text)) return undefined;
  if (AUTH_RE.test(text) || AUTH_MISSING_RE.test(text)) return undefined;

  const kind = detectUsageLimitKind(text);
  if (!kind) return undefined;

  return {
    kind,
    ...classifyUsageLimit({ backend: params.backend, text }),
  };
}
