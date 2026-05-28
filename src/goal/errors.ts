import { PlanParseError } from "./planner.js";

// Error classification for goal planner/LLM failures.

export type GoalErrorKind =
  | "network"
  | "auth"
  | "parse"
  | "internal"
  | "codex-helper-missing"
  | "codex-network"
  | "claude-sandbox-missing";

/** Backend hint used to disambiguate planner errors between Codex- and Claude-backed paths. */
export type GoalErrorBackendHint = "codex" | "claude_code";

/** Typed error for LLM/planner call failures with a machine-readable kind. */
export class GoalLlmError extends Error {
  readonly kind: GoalErrorKind;
  constructor(message: string, kind: GoalErrorKind, cause?: unknown) {
    super(message, { cause });
    this.name = "GoalLlmError";
    this.kind = kind;
  }
}

const NETWORK_PATTERNS =
  /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|socket hang up|network|EAI_AGAIN/i;
const AUTH_PATTERNS =
  /401|403|unauthorized|forbidden|invalid.*key|authentication|credit balance|billing/i;

// Codex-specific patterns. These intentionally cover a family of strings rather
// than one exact token so a slightly different Codex auth/network failure shape
// still routes to the actionable recovery message.
const CODEX_HELPER_MISSING_PATTERNS =
  /codex-linux-sandbox helper|locate the Codex native binary|Codex native sandbox helper/i;
const CODEX_NETWORK_HINT_PATTERNS =
  /codex|login|not authenticated|please log in|please sign in|session expired|invalid.*token|expired.*token/i;

// Claude Code native sandbox dependency patterns.
const CLAUDE_SANDBOX_REQUIRED_PATTERNS =
  /sandbox required but unavailable|dependencies are missing|sandbox is enabled but dependencies are missing/i;
const CLAUDE_SANDBOX_TOOL_PATTERNS = /socat|bubblewrap|bwrap/i;

/** Optional context used to refine classification (e.g. which backend was attempted). */
export interface ClassifyGoalErrorOptions {
  /** Backend used for the planner call, when known. */
  backend?: GoalErrorBackendHint;
}

/** Classify a raw error into a GoalErrorKind. */
export function classifyGoalError(err: unknown, options?: ClassifyGoalErrorOptions): GoalErrorKind {
  if (err instanceof GoalLlmError) return err.kind;
  if (err instanceof PlanParseError) return "parse";
  if (!(err instanceof Error)) return "internal";
  const msg = err.message;

  // Codex native sandbox helper is missing — actionable regardless of hint
  // because the message is distinctive.
  if (CODEX_HELPER_MISSING_PATTERNS.test(msg)) return "codex-helper-missing";

  // Claude Code native sandbox dependency failure. Match when the message
  // signals the sandbox is required/missing AND mentions a tool name.
  if (CLAUDE_SANDBOX_REQUIRED_PATTERNS.test(msg) && CLAUDE_SANDBOX_TOOL_PATTERNS.test(msg)) {
    return "claude-sandbox-missing";
  }

  const isNetworkLike = NETWORK_PATTERNS.test(msg);
  const isAuthLike = AUTH_PATTERNS.test(msg);
  const isCodexHinted = CODEX_NETWORK_HINT_PATTERNS.test(msg);

  // Codex-backed planner connection failures: gated on the backend hint plus a
  // network/auth/codex/login pattern match. Avoids a brittle single-token rule.
  if (options?.backend === "codex" && (isNetworkLike || isAuthLike || isCodexHinted)) {
    return "codex-network";
  }

  if (isNetworkLike) return "network";
  if (isAuthLike) return "auth";
  return "internal";
}

const CODEX_RECOVERY_COMMANDS = [
  "  sudo npm install -g @openai/codex@latest",
  "  codex login",
  '  codex "say only: codex works"',
].join("\n");

const CLAUDE_SANDBOX_RECOVERY_COMMANDS = [
  "Install the missing sandbox tools:",
  "",
  "  sudo apt install -y bubblewrap socat",
  "",
  "Then run:",
  "",
  '  claude -p "say only: claude works"',
  "",
  "Then try again.",
].join("\n");

/** Optional formatter context — currently the backend hint used for classification. */
export interface FormatGoalErrorOptions {
  /** Backend used for the planner call, when known. */
  backend?: GoalErrorBackendHint;
}

/** Produce a concise, honest user-facing error message. */
export function formatGoalError(
  err: unknown,
  runId?: string,
  options?: FormatGoalErrorOptions,
): string {
  const kind = classifyGoalError(err, options);
  switch (kind) {
    case "network":
      return "Planning failed: Network error reaching the planner API. Check your connection and try again.";
    case "auth":
      return "Authentication failed. Verify your auth configuration and try again.";
    case "parse": {
      const hint = runId
        ? `Debug: cat $STATE_DIR/goals/${runId}/plan-raw.txt`
        : "Debug: ls -lt $STATE_DIR/goals/*/plan-raw.txt";
      return `Failed to parse the planner response. ${hint}`;
    }
    case "codex-helper-missing":
      return [
        "Planning failed: Unable to locate the Codex native binary for codex-linux-sandbox helper.",
        "",
        "Try:",
        "",
        CODEX_RECOVERY_COMMANDS,
        "",
        "Then try again.",
      ].join("\n");
    case "codex-network":
      return [
        "Planning failed: Couldn't connect to Codex.",
        "",
        "Please check your network and try:",
        "",
        CODEX_RECOVERY_COMMANDS,
        "",
        "Then try again.",
      ].join("\n");
    case "claude-sandbox-missing":
      return [
        "Planning failed: Claude Code sandbox is required but unavailable.",
        "",
        CLAUDE_SANDBOX_RECOVERY_COMMANDS,
      ].join("\n");
    case "internal":
      return `Planning failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
