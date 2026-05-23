// Shared, channel-agnostic formatting for backend usage/rate-limit messaging.
// Used by every backend-driven phase that can fall back between Claude Code and
// Codex so users see a consistent, accurate explanation: which backend hit the
// limit, what kind of limit it was (when known), when it resets (when known),
// and whether the system fell back to another backend.

import type { CliWorkerId } from "../config/types.goal.js";
import type { UsageLimitType } from "./error-patterns.js";

/** Whether the underlying blocker was a quota/usage limit or a transient rate limit. */
export type UsageLimitKind = "rate_limit" | "usage_limit";

/** A single usage/rate-limit occurrence attributed to a specific backend. */
export interface UsageLimitEvent {
  backend: CliWorkerId;
  kind: UsageLimitKind;
  limitType: UsageLimitType;
  resetHint?: string;
}

/** User-facing display name for a backend id. */
export function backendDisplayName(backend: CliWorkerId): string {
  switch (backend) {
    case "claude_code":
      return "Claude Code";
    case "codex":
      return "Codex";
    default:
      return backend;
  }
}

/** Human-readable label for a limit window type, or undefined when unknown. */
export function limitTypeLabel(limitType: UsageLimitType): string | undefined {
  switch (limitType) {
    case "five_hour":
      return "5-hour limit";
    case "weekly":
      return "weekly limit";
    case "burst":
      return "burst limit";
    case "monthly_extra":
      return "monthly extra-usage limit";
    case "unknown":
      return undefined;
  }
}

function limitKindLabel(kind: UsageLimitKind): string {
  return kind === "usage_limit" ? "usage limit" : "rate limit";
}

/**
 * Describe one usage-limit event as a sentence fragment, e.g.
 * "Claude Code hit a usage limit (5-hour limit, resets at 3pm)".
 * The limit type and reset hint are only included when known.
 */
export function describeUsageLimitEvent(event: UsageLimitEvent): string {
  const name = backendDisplayName(event.backend);
  const detailParts: string[] = [];
  const typeLabel = limitTypeLabel(event.limitType);
  if (typeLabel) detailParts.push(typeLabel);
  if (event.resetHint) detailParts.push(normalizeResetHint(event.resetHint));
  const detail = detailParts.length > 0 ? ` (${detailParts.join(", ")})` : "";
  return `${name} hit a ${limitKindLabel(event.kind)}${detail}`;
}

/** Lower-cases a leading "Resets"/"Reset" so it reads naturally inside parentheses. */
function normalizeResetHint(resetHint: string): string {
  return resetHint.replace(/^reset/i, (m) => m.toLowerCase());
}

/**
 * Progress message emitted when one backend hit a limit and we are about to try
 * the other backend, e.g.
 * "Claude Code hit a usage limit (resets at 3pm). Falling back to Codex."
 */
export function formatUsageLimitFallbackMessage(params: {
  event: UsageLimitEvent;
  fallbackBackend: CliWorkerId;
}): string {
  return `${describeUsageLimitEvent(params.event)}. Falling back to ${backendDisplayName(
    params.fallbackBackend,
  )}.`;
}

/**
 * Message emitted once a fallback backend recovered the task, preserving the
 * failure history, e.g.
 * "Claude Code hit a usage limit (resets at 3pm). Fell back to Codex. Codex succeeded."
 */
export function formatUsageLimitRecoveryMessage(params: {
  events: UsageLimitEvent[];
  succeededBackend: CliWorkerId;
}): string {
  const history = params.events.map((event) => `${describeUsageLimitEvent(event)}.`);
  const succeeded = backendDisplayName(params.succeededBackend);
  return [...history, `Fell back to ${succeeded}.`, `${succeeded} succeeded.`].join(" ");
}

/**
 * Final message when no fallback backend could recover the task. Preserves the
 * full usage-limit history (including reset times when available), states why no
 * fallback was used, and appends the original blocking question/detail.
 */
export function formatUsageLimitExhaustedMessage(params: {
  events: UsageLimitEvent[];
  noFallbackReason: string;
  originalQuestion: string;
}): string {
  const history = params.events.map((event) => `${describeUsageLimitEvent(event)}.`);
  const lines: string[] = [
    ...history,
    `No fallback backend was used because ${params.noFallbackReason}.`,
  ];

  const resetSummary = formatResetSummary(params.events);
  if (resetSummary) lines.push(resetSummary);

  const original = params.originalQuestion.trim();
  if (original) lines.push(original);

  return lines.join(" ");
}

/**
 * Compact summary of reset times across events, e.g.
 * "Reset times: Claude Code resets at 3pm; Codex resets weekly on Monday."
 * Returns undefined when no event carries a reset hint.
 */
export function formatResetSummary(events: UsageLimitEvent[]): string | undefined {
  const withResets = events.filter((event) => event.resetHint);
  if (withResets.length === 0) return undefined;
  const parts = withResets.map(
    (event) => `${backendDisplayName(event.backend)} ${normalizeResetHint(event.resetHint!)}`,
  );
  return `Reset times: ${parts.join("; ")}.`;
}
