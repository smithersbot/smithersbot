import { z } from "zod";
import type { CliWorkerId, GoalConfig } from "../config/types.goal.js";
import { GoalWorkerOutputSchema } from "./goal-schemas.js";

// Types for CLI worker backends used by /goal execution.

/** Supported execution backends for goal steps. */
export type GoalBackendId = "pi" | "codex" | "claude_code";

const DEFAULT_ENABLED_WORKERS: CliWorkerId[] = ["codex", "claude_code"];

export function resolveEnabledWorkers(config?: GoalConfig): CliWorkerId[] {
  const configuredWorkers = config?.enabledWorkers;
  if (!configuredWorkers || configuredWorkers.length === 0) {
    return [...DEFAULT_ENABLED_WORKERS];
  }
  return [...configuredWorkers];
}

/** Result of probing whether a CLI backend is available. */
export type BackendAvailability = {
  id: GoalBackendId;
  available: boolean;
  /** Why unavailable. */
  reason?: string;
};

/** Structured output from any CLI worker, validated against a JSON schema. */
export type GoalWorkerOutput = z.infer<typeof GoalWorkerOutputSchema>;

/** Result of running a CLI worker for a single step. */
export type BackendTaskResult = {
  /** Parsed + schema-validated output (null if parsing/validation failed). */
  output: GoalWorkerOutput | null;
  turnsUsed: number;
  /** Backend-native session/thread id parsed from CLI JSONL/stdout, when available. */
  sessionId?: string;
  rawStdout?: string;
  rawStderr?: string;
};
