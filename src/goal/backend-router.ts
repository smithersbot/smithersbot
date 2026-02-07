// Backend routing for /goal execution — detects available CLI backends and
// resolves which backend to use for each step.

import { execFileSync } from "node:child_process";
import type { GoalBackendId, BackendAvailability } from "./backend-types.js";
import type { PlanStep } from "./types.js";

// --- Detection cache (once per process) ---
let cachedAvailability: BackendAvailability[] | null = null;

/** Reset the detection cache (for testing). */
export function resetAvailabilityCache(): void {
  cachedAvailability = null;
}

/**
 * Check if a binary exists and its --help output contains required flags.
 * Returns { available, reason } tuple.
 */
function probeBackend(
  binary: string,
  requiredFlags: string[],
): { available: boolean; reason?: string } {
  let helpOutput: string;
  try {
    helpOutput = execFileSync(binary, ["--help"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // Binary not found or --help failed — check stderr too
    const error = err as { status?: number; stdout?: string; stderr?: string; code?: string };
    if (error.code === "ENOENT") {
      return { available: false, reason: `${binary} not found on PATH` };
    }
    // Some CLIs exit non-zero for --help but still produce output
    helpOutput = (error.stdout ?? "") + (error.stderr ?? "");
    if (!helpOutput.trim()) {
      return { available: false, reason: `${binary} --help produced no output` };
    }
  }

  const missing = requiredFlags.filter((flag) => !helpOutput.includes(flag));
  if (missing.length > 0) {
    return {
      available: false,
      reason: `${binary} found but missing flags: ${missing.join(", ")}`,
    };
  }
  return { available: true };
}

/** Detect which CLI backends are available. Cached per process. */
export function detectBackendAvailability(): BackendAvailability[] {
  if (cachedAvailability) return cachedAvailability;

  const results: BackendAvailability[] = [
    // PI is always available (embedded)
    { id: "pi", available: true },
  ];

  // Codex CLI
  const codexProbe = probeBackend("codex", ["--sandbox", "--output-schema"]);
  results.push({ id: "codex", ...codexProbe });

  // Claude Code CLI
  const claudeProbe = probeBackend("claude", ["--allowedTools", "--append-system-prompt"]);
  results.push({ id: "claude_code", ...claudeProbe });

  cachedAvailability = results;
  return results;
}

// --- Task classification ---

const CODE_KEYWORDS = [
  "implement",
  "code",
  "refactor",
  "function",
  "class",
  "module",
  "component",
  "endpoint",
  "api",
  "fix bug",
  "patch",
  "migrate",
];
const TEST_KEYWORDS = ["test", "spec", "coverage", "assert", "expect", "vitest", "jest"];
const DOCS_KEYWORDS = ["document", "docs", "readme", "changelog", "comment", "jsdoc", "markdown"];
const ANALYSIS_KEYWORDS = [
  "analyze",
  "review",
  "audit",
  "investigate",
  "research",
  "explore",
  "understand",
];

export type TaskClassification = "code" | "test" | "docs" | "analysis" | "general";

/** Keyword heuristic on step description to classify the task type. */
export function classifyTask(step: PlanStep): TaskClassification {
  const desc = step.description.toLowerCase();

  // Check narrow/specific categories first so they aren't swallowed by broad ones.
  // Docs/analysis checked before code because code keywords like "api", "code"
  // appear in many non-code descriptions.
  if (TEST_KEYWORDS.some((kw) => desc.includes(kw))) return "test";
  if (DOCS_KEYWORDS.some((kw) => desc.includes(kw))) return "docs";
  if (ANALYSIS_KEYWORDS.some((kw) => desc.includes(kw))) return "analysis";
  if (CODE_KEYWORDS.some((kw) => desc.includes(kw))) return "code";
  return "general";
}

/** Map classification → default backend. */
function classificationDefault(classification: TaskClassification): GoalBackendId {
  switch (classification) {
    case "code":
    case "test":
      return "codex";
    case "docs":
    case "analysis":
    case "general":
      return "claude_code";
  }
}

/** Check if a backend ID is available in the detection results. */
function isAvailable(id: GoalBackendId, availability: BackendAvailability[]): boolean {
  const entry = availability.find((a) => a.id === id);
  return entry?.available ?? false;
}

/**
 * Deterministic backend resolution for a step.
 *
 * Resolution order:
 * 1. override (from --backend CLI flag) — wins unconditionally
 * 2. step.executedBackend — sticky across retries/resume
 * 3. step.preferredBackend — planner hint, tried if available
 * 4. Classification default — codex for code/test, claude_code for docs/analysis/general
 * 5. Fallback chain by availability: codex → claude_code → pi
 */
export function resolveBackendForStep(
  step: PlanStep,
  availability: BackendAvailability[],
  override?: GoalBackendId,
): GoalBackendId {
  // 1. Override wins unconditionally
  if (override) return override;

  // 2. Sticky from prior execution (prevents backend-switching on retry/resume)
  if (step.executedBackend) return step.executedBackend;

  // 3. Planner hint
  if (step.preferredBackend && isAvailable(step.preferredBackend, availability)) {
    return step.preferredBackend;
  }

  // 4. Classification default
  const classification = classifyTask(step);
  const defaultBackend = classificationDefault(classification);
  if (isAvailable(defaultBackend, availability)) return defaultBackend;

  // 5. Fallback chain
  const fallbackOrder: GoalBackendId[] = ["codex", "claude_code", "pi"];
  for (const id of fallbackOrder) {
    if (isAvailable(id, availability)) return id;
  }

  // PI is always available
  return "pi";
}
