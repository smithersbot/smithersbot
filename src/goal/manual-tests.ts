import fs from "node:fs";
import path from "node:path";
import { MANUAL_TESTS_SYSTEM_PROMPT } from "../prompts/manual-tests/system-prompt.js";
import { redactSecretValues } from "../security/secret-paths.js";
import { buildClaudeCodeEnv, buildCredentialStrippedEnv } from "./claude-code-env.js";
import {
  detectBackendAvailability,
  getCodexAskForApprovalPlacement,
} from "./backend-availability.js";
import { collectText, isRecord, parseJsonLines } from "./cli-output-parsing.js";
import { runCliProcess } from "./cli-process.js";
import { extractJson, PlanParseError } from "./planner.js";
import { resolveClaudeBinary } from "./scout.js";
import type { GoalLlmClient, ManualTestSuggestion, PlanStep } from "./types.js";

const DEFAULT_MIN_TESTS = 0;
const DEFAULT_MAX_TESTS = 5;
const MANUAL_TESTS_TIMEOUT_MS = 300_000;
const MANUAL_TESTS_PARSE_MAX_ATTEMPTS = 2;
const MANUAL_TESTS_PARSE_RETRY_DELAY_MS = 2_000;

/**
 * Sentinel error message used when manual-test generation is skipped because
 * no LLM backend is installed. Callers branch on this to distinguish
 * "skipped_no_backend" from a genuine "failed" status in the goal-completion
 * notice.
 */
export const NO_BACKEND_MANUAL_TESTS_ERROR =
  "no worker backend available — install Codex or Claude Code";

export function isNoBackendManualTestsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message.includes("no worker backend available");
}

export type GenerateManualTestsParams = {
  goal: string;
  steps: PlanStep[];
  client?: GoalLlmClient;
  minTests?: number;
  maxTests?: number;
  /** Goal run directory. When provided, CLI stdout/stderr are persisted under <runDir>/manual-tests/. */
  runDir?: string;
};

const MANUAL_TESTS_ARTIFACT_DIR = "manual-tests";
const MANUAL_TESTS_STDOUT_FILE = "stdout.txt";
const MANUAL_TESTS_STDERR_FILE = "stderr.txt";

type ManualTestsArtifactPaths = {
  dir: string;
  stdoutPath: string;
  stderrPath: string;
};

function ensureManualTestsArtifactDir(runDir: string): ManualTestsArtifactPaths {
  const dir = path.join(runDir, MANUAL_TESTS_ARTIFACT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    stdoutPath: path.join(dir, MANUAL_TESTS_STDOUT_FILE),
    stderrPath: path.join(dir, MANUAL_TESTS_STDERR_FILE),
  };
}

function redactArtifactFile(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    fs.writeFileSync(filePath, redactSecretValues(fs.readFileSync(filePath, "utf8")), "utf8");
  } catch {
    // Best-effort: artifact persistence must not make manual-test generation fail.
  }
}

function isTestEnv(): boolean {
  return (
    process.env.VITEST === "true" ||
    process.env.VITEST_POOL_ID != null ||
    process.env.VITEST_WORKER_ID != null ||
    process.env.NODE_ENV === "test"
  );
}

function buildCombinedManualTestsPrompt(userMessage: string): string {
  return ["## System Prompt", MANUAL_TESTS_SYSTEM_PROMPT, "", "## User Message", userMessage].join(
    "\n",
  );
}

function isAssistantLikeEvent(entry: Record<string, unknown>): boolean {
  const type = typeof entry.type === "string" ? entry.type.toLowerCase() : "";
  const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
  if (role === "assistant") return true;
  if (!type) return false;
  return (
    type.includes("assistant") ||
    type === "agent_message" ||
    type === "agent_message_delta" ||
    type === "item.completed" ||
    type === "item.text"
  );
}

function extractAssistantTextFromEvent(entry: Record<string, unknown>): string {
  return (
    collectText(entry.message).trim() ||
    collectText(entry.content).trim() ||
    collectText(entry.item).trim() ||
    collectText(entry.delta).trim() ||
    collectText(entry).trim()
  );
}

function extractAssistantTextFromJsonLines(rawStdout: string): string | undefined {
  const lines = parseJsonLines(rawStdout);
  if (lines.length === 0) return undefined;

  // Prefer the final non-error type:"result" event (Codex/Claude stream-json convention).
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const entry = lines[i];
    if (!entry) continue;
    const type = typeof entry.type === "string" ? entry.type : "";
    if (type !== "result") continue;
    if (entry.is_error === true) continue;
    const text =
      collectText(entry.result).trim() ||
      collectText(entry.message).trim() ||
      collectText(entry.content).trim();
    if (text) return text;
  }

  // Fall back to the latest assistant/item.completed/agent_message/item.text event.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const entry = lines[i];
    if (!entry || !isAssistantLikeEvent(entry)) continue;
    const text = extractAssistantTextFromEvent(entry);
    if (text) return text;
  }

  return undefined;
}

function extractAssistantTextFromSingleObject(rawStdout: string): string | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = extractJson(rawStdout);
  } catch {
    return undefined;
  }
  const result = parsed.result;

  if (Array.isArray(result)) {
    for (let i = result.length - 1; i >= 0; i -= 1) {
      const entry = result[i];
      if (!isRecord(entry)) continue;
      const type = typeof entry.type === "string" ? entry.type.toLowerCase() : "";
      const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
      if (type.includes("assistant") || role === "assistant") {
        const assistantText =
          collectText(entry.message).trim() ||
          collectText(entry.content).trim() ||
          collectText(entry).trim();
        if (assistantText) return assistantText;
      }
    }

    for (let i = result.length - 1; i >= 0; i -= 1) {
      const text = collectText(result[i]).trim();
      if (text) return text;
    }
  }

  if (typeof result === "string" && result.trim()) return result.trim();
  if (result != null) {
    const text = collectText(result).trim();
    if (text) return text;
  }

  const fallbackText =
    collectText(parsed.message).trim() ||
    collectText(parsed.content).trim() ||
    collectText(parsed).trim();
  if (fallbackText) return fallbackText;

  return undefined;
}

function extractAssistantTextFromCliResult(rawStdout: string): string {
  // Codex --json emits a JSONL event stream (thread.started, item.completed, agent_message,
  // and a final type:"result"). Walk from the end and prefer the final result event;
  // otherwise fall back to assistant/item.completed/agent_message/item.text events.
  const jsonlText = extractAssistantTextFromJsonLines(rawStdout);
  if (jsonlText) return jsonlText;

  // Claude `--output-format json --max-turns 1` emits a single JSON object with `result: [...]`.
  const singleObjectText = extractAssistantTextFromSingleObject(rawStdout);
  if (singleObjectText) return singleObjectText;

  throw new Error("Manual test CLI response did not include assistant text.");
}

function buildCodexManualTestsArgs(prompt: string): string[] {
  const codexAskForApproval = getCodexAskForApprovalPlacement();
  return [
    ...(codexAskForApproval === "before_exec" ? ["--ask-for-approval", "never"] : []),
    "exec",
    "--json",
    ...(codexAskForApproval === "after_exec" ? ["--ask-for-approval", "never"] : []),
    "--sandbox",
    "workspace-write",
    "--cd",
    process.cwd(),
    "-c",
    "net.allowed=true",
    prompt,
  ];
}

async function generateManualTestsViaCli(userMessage: string, runDir?: string): Promise<string> {
  const claudeBin = resolveClaudeBinary();
  const combinedPrompt = buildCombinedManualTestsPrompt(userMessage);
  const codexAvailable =
    detectBackendAvailability().find((entry) => entry.id === "codex")?.available === true;
  if (!claudeBin && !codexAvailable) {
    throw new Error(NO_BACKEND_MANUAL_TESTS_ERROR);
  }
  const useCodex = !claudeBin && codexAvailable;

  let artifacts: ManualTestsArtifactPaths | undefined;
  if (runDir) {
    try {
      artifacts = ensureManualTestsArtifactDir(runDir);
    } catch {
      // Best-effort: continue without persisted artifacts if mkdir fails.
      artifacts = undefined;
    }
  }
  const artifactHint = artifacts
    ? ` (stdout: ${artifacts.stdoutPath}, stderr: ${artifacts.stderrPath})`
    : "";

  const procResult = await runCliProcess({
    command: useCodex ? "codex" : claudeBin!,
    args: useCodex
      ? buildCodexManualTestsArgs(combinedPrompt)
      : ["-p", "--output-format", "json", "--max-turns", "1"],
    cwd: process.cwd(),
    timeoutMs: MANUAL_TESTS_TIMEOUT_MS,
    ...(useCodex ? {} : { stdin: combinedPrompt }),
    env: useCodex ? buildCredentialStrippedEnv() : buildClaudeCodeEnv("subscription"),
    ...(artifacts ? { stdoutPath: artifacts.stdoutPath, stderrPath: artifacts.stderrPath } : {}),
  });
  if (artifacts) {
    redactArtifactFile(artifacts.stdoutPath);
    redactArtifactFile(artifacts.stderrPath);
  }
  const redactedProcResult = {
    ...procResult,
    stdout: redactSecretValues(procResult.stdout),
    stderr: redactSecretValues(procResult.stderr),
  };

  if (redactedProcResult.timedOut) {
    throw new Error(
      `Manual test generation timed out after ${(MANUAL_TESTS_TIMEOUT_MS / 1000).toFixed(0)} seconds.${artifactHint}`,
    );
  }

  if (
    (redactedProcResult.exitCode && redactedProcResult.exitCode !== 0) ||
    redactedProcResult.signal
  ) {
    const detail =
      redactedProcResult.stderr.trim() ||
      redactedProcResult.stdout.trim() ||
      (redactedProcResult.signal
        ? `Manual test generation process terminated by ${redactedProcResult.signal}.`
        : "Manual test generation process failed.");
    throw new Error(`Manual test generation failed: ${detail}${artifactHint}`);
  }

  try {
    return redactSecretValues(extractAssistantTextFromCliResult(redactedProcResult.stdout));
  } catch (error) {
    const baseMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`${baseMessage}${artifactHint}`);
  }
}

export function clampCriticality(raw: unknown): number {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return 5;
  return Math.min(10, Math.max(1, Math.round(value)));
}

function normalizeManualTest(raw: unknown): ManualTestSuggestion | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;

  const description =
    typeof obj.description === "string"
      ? obj.description.trim()
      : typeof obj.name === "string"
        ? obj.name.trim()
        : "";
  if (!description) return undefined;

  const detail =
    typeof obj.detail === "string"
      ? obj.detail.trim()
      : typeof obj.instructions === "string"
        ? obj.instructions.trim()
        : description;
  const reason =
    typeof obj.reason === "string"
      ? obj.reason.trim()
      : typeof obj.why === "string"
        ? obj.why.trim()
        : "";

  return {
    description,
    criticality: clampCriticality(obj.criticality),
    ...(reason ? { reason } : {}),
    detail: detail || description,
  };
}

function buildFallbackDescription(stepDescription: string): string {
  const cleaned = stepDescription
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "");
  if (!cleaned) return "Test updated behavior";
  const withoutVerb = cleaned
    .replace(
      /^(implement|add|update|fix|refactor|improve|create|build|write|cover|document|set up|setup|configure|harden|optimize|adjust|change)\s+/i,
      "",
    )
    .trim();
  const phrase = withoutVerb || cleaned;
  if (/^test\b/i.test(phrase)) return phrase;
  return `Test ${phrase.charAt(0).toLowerCase()}${phrase.slice(1)}`;
}

function fallbackCriticality(index: number): number {
  return Math.max(3, 6 - index);
}

function buildFallbackDetail(step: PlanStep): string {
  const completionSummary = step.taskSummary?.trim().replace(/\s+/g, " ");
  const stepTwo = completionSummary
    ? `**Step 2.** Confirm this expected outcome: ${completionSummary}.`
    : "**Step 2.** Confirm the expected behavior and no regressions in related flows.";
  return `**Step 1.** Manually exercise the behavior described by "${step.description}".\n${stepTwo}`;
}

function buildFallbackTests(
  doneSteps: PlanStep[],
  needed: number,
  usedDescriptions: Set<string>,
): ManualTestSuggestion[] {
  const fallback: ManualTestSuggestion[] = [];
  for (const step of doneSteps) {
    if (fallback.length >= needed) break;
    const description = buildFallbackDescription(step.description);
    const key = description.toLowerCase();
    if (usedDescriptions.has(key)) continue;
    usedDescriptions.add(key);
    fallback.push({
      description,
      criticality: fallbackCriticality(fallback.length),
      reason: "Automated test generation returned fewer suggestions than expected.",
      detail: buildFallbackDetail(step),
    });
  }
  return fallback;
}

function buildManualTestsUserPrompt(goal: string, doneSteps: PlanStep[]): string {
  const lines: string[] = [`Goal: ${goal}`, "", "Completed steps:"];
  for (const step of doneSteps.slice(0, 10)) {
    lines.push(`- [${step.id}] ${step.description}`);
    if (step.taskSummary?.trim()) {
      lines.push(`  Completion summary: ${step.taskSummary.trim()}`);
    }
  }
  const automatedChecks = collectAutomatedChecks(doneSteps);
  lines.push("");
  lines.push("Automated checks already performed:");
  if (automatedChecks.length === 0) {
    lines.push("- None explicitly recorded in task summaries.");
  } else {
    for (const check of automatedChecks) {
      lines.push(`- ${check}`);
    }
  }
  lines.push("");
  lines.push("Generate only the minimum manual tests needed for behavior not covered above.");
  return lines.join("\n");
}

const COMMAND_HINT =
  /\b(?:pnpm|npm|bun|bunx|node|npx|vitest|jest|playwright|cypress|pytest|go test|cargo test|swift test|xcodebuild|gradle|mvn|tsc|eslint|oxlint|oxfmt|prettier)\b/i;
const CHECK_HINT =
  /\b(?:lint|build|typecheck|type-check|compile|test|tests|coverage|verified|verification|validate)\b/i;

function collectAutomatedChecks(doneSteps: PlanStep[]): string[] {
  const checks: string[] = [];
  const seen = new Set<string>();

  const pushUnique = (value: string) => {
    const normalized = value.trim().replace(/\s+/g, " ");
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    checks.push(normalized);
  };

  for (const step of doneSteps) {
    const summary = step.taskSummary?.trim();
    if (!summary) continue;
    const lines = summary.split("\n");
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const inlineCommandMatches = Array.from(line.matchAll(/`([^`]+)`/g), (match) =>
        match[1]?.trim(),
      ).filter((value): value is string => Boolean(value));
      for (const cmd of inlineCommandMatches) {
        if (COMMAND_HINT.test(cmd) || CHECK_HINT.test(cmd)) pushUnique(cmd);
      }

      const normalizedLine = line
        .replace(/^[-*]\s+/, "")
        .replace(/^\d+\.\s+/, "")
        .trim();
      if (!normalizedLine) continue;
      if (COMMAND_HINT.test(normalizedLine) || CHECK_HINT.test(normalizedLine)) {
        pushUnique(normalizedLine);
      }
    }
  }

  return checks.slice(0, 10);
}

export async function generateManualTests(
  params: GenerateManualTestsParams,
): Promise<ManualTestSuggestion[]> {
  const minTests = Math.max(0, params.minTests ?? DEFAULT_MIN_TESTS);
  const maxTests = Math.max(minTests, params.maxTests ?? DEFAULT_MAX_TESTS);
  const doneSteps = params.steps.filter((step) => (step.status ?? "done") === "done");
  if (doneSteps.length === 0) return [];

  const userMessage = buildManualTestsUserPrompt(params.goal, doneSteps);
  let parsed: Record<string, unknown> | undefined;

  for (let attempt = 1; attempt <= MANUAL_TESTS_PARSE_MAX_ATTEMPTS; attempt += 1) {
    let modelResponseText: string;
    if (params.client) {
      const response = await params.client.complete({
        systemPrompt: MANUAL_TESTS_SYSTEM_PROMPT,
        userMessage,
        maxTokens: 900,
      });
      modelResponseText = redactSecretValues(response.text);
    } else {
      if (isTestEnv()) {
        throw new Error("Manual test generation requires an injected client in tests.");
      }
      modelResponseText = redactSecretValues(
        await generateManualTestsViaCli(userMessage, params.runDir),
      );
    }

    try {
      parsed = extractJson(modelResponseText);
      break;
    } catch (error) {
      if (!(error instanceof PlanParseError) || attempt >= MANUAL_TESTS_PARSE_MAX_ATTEMPTS) {
        throw error;
      }
      console.warn(
        `[goal] Manual test JSON parse failed on attempt ${attempt}/${MANUAL_TESTS_PARSE_MAX_ATTEMPTS}; retrying in ${MANUAL_TESTS_PARSE_RETRY_DELAY_MS}ms`,
        error,
      );
      await new Promise((resolve) => setTimeout(resolve, MANUAL_TESTS_PARSE_RETRY_DELAY_MS));
    }
  }
  if (!parsed) {
    throw new Error("Manual test generation failed to parse model response.");
  }

  const rawTests = Array.isArray(parsed.tests)
    ? parsed.tests
    : Array.isArray(parsed.manualTests)
      ? parsed.manualTests
      : undefined;
  if (!rawTests) {
    throw new Error("Manual test response must contain a tests array.");
  }

  const suggestions: ManualTestSuggestion[] = [];
  const seen = new Set<string>();
  for (const entry of rawTests) {
    const normalized = normalizeManualTest(entry);
    if (!normalized) continue;
    const key = normalized.description.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push(normalized);
    if (suggestions.length >= maxTests) break;
  }

  if (suggestions.length < minTests) {
    const fallback = buildFallbackTests(doneSteps, minTests - suggestions.length, seen);
    suggestions.push(...fallback);
  }

  return suggestions.slice(0, maxTests);
}
