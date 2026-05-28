import fs from "node:fs";
import path from "node:path";
import { MANUAL_TESTS_SYSTEM_PROMPT } from "../prompts/manual-tests/system-prompt.js";
import { redactSecretValues } from "../security/secret-paths.js";
import { resolveAgentGoalHistoryDir } from "../config/managed-paths.js";
import {
  appendAgentHistoryEventBestEffort,
  parseBackendUsage,
  resolveAgentHistoryEventsPath,
  writeCriticalAgentLaunchEvent,
  type AgentBackendUsage,
} from "./agent-history-events.js";
import { workspaceNameFromWorkingDir } from "./agent-history.js";
import { buildClaudeCodeEnv, buildCredentialStrippedEnv } from "./claude-code-env.js";
import {
  detectBackendAvailability,
  getCodexAskForApprovalPlacement,
} from "./backend-availability.js";
import {
  appendClaudeCodeSandboxArgs,
  appendCodexNativeSandboxExecArgs,
  buildClaudeCodeSandboxLaunchConfig,
  mergeCodexNativeSandboxEnv,
  writeCodexNativeSandboxConfig,
  type ClaudeCodeLaunchSandboxConfig,
  type CodexNativeSandboxConfig,
} from "./backend-sandbox.js";
import { collectText, isRecord, parseJsonLines } from "./cli-output-parsing.js";
import { runCliProcess } from "./cli-process.js";
import { runWithBackendFallback, type PhaseAttempt } from "./phase-fallback.js";
import { extractJson, PlanParseError } from "./planner.js";
import { resolveClaudeBinary } from "./scout.js";
import type { CliWorkerId } from "../config/types.goal.js";
import type { GoalLlmClient, ManualTestSuggestion, PlanStep } from "./types.js";

const DEFAULT_MIN_TESTS = 0;
const DEFAULT_MAX_TESTS = 5;
const MANUAL_TESTS_TIMEOUT_MS = 300_000;
const MANUAL_TESTS_PARSE_MAX_ATTEMPTS = 2;
const MANUAL_TESTS_PARSE_RETRY_DELAY_MS = 2_000;
const MAX_MANUAL_PROMPT_STEPS = 8;
const MAX_MANUAL_PROMPT_TEXT_CHARS = 260;
const MAX_MANUAL_LIVE_GAPS = 8;

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

/**
 * Classifies optional-embedded-agent auth failures (e.g. anthropic API key
 * missing from the auth store). These come from src/agents/model-auth.ts when
 * the embedded `pi-ai` LLM client cannot find a credential for the configured
 * provider. The optional embellishment paths (manual-tests, summaries,
 * lesson extraction) treat this as non-fatal so deterministic slash commands
 * and goal completion keep working without an Anthropic API key.
 */
export function isOptionalEmbeddedAgentAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!message) return false;
  return /No API key found for provider\s+"[^"]+"/i.test(message);
}

export type ManualTestsResultStatus = "generated" | "skipped_no_embedded_auth";

export type ManualTestsResult = {
  status: ManualTestsResultStatus;
  tests: ManualTestSuggestion[];
  /** Redacted short reason when status !== "generated". */
  error?: string;
};

const OPTIONAL_EMBEDDED_AUTH_FALLBACK_REASON =
  "Embedded-agent auth unavailable — using deterministic fallback.";

function redactedOptionalEmbeddedAuthMessage(): string {
  return "embedded-agent auth unavailable (no Anthropic API key configured)";
}

export type GenerateManualTestsParams = {
  goal: string;
  steps: PlanStep[];
  client?: GoalLlmClient;
  minTests?: number;
  maxTests?: number;
  /** Goal run directory. When provided, CLI stdout/stderr are persisted under <runDir>/manual-tests/. */
  runDir?: string;
  runId?: string;
  workingDir?: string;
};

const MANUAL_TESTS_ARTIFACT_DIR = "manual-tests";
const MANUAL_TESTS_STDOUT_FILE = "stdout.txt";
const MANUAL_TESTS_STDERR_FILE = "stderr.txt";

type ManualTestsArtifactPaths = {
  dir: string;
  stdoutPath: string;
  stderrPath: string;
};

function resolveManualTestsRunId(params: { runId?: string; runDir?: string }): string | undefined {
  return params.runId ?? (params.runDir ? path.basename(params.runDir) : undefined);
}

function appendManualTestsHistory(params: {
  runId?: string;
  workingDir: string;
  backend: string;
  event: string;
  status?: string;
  attemptNumber?: number;
  tokenUsage?: AgentBackendUsage;
  errorClass?: string;
  outputSummary?: string;
  promptArtifactPath?: string;
  artifactPaths?: readonly string[];
}): void {
  if (!params.runId) return;
  appendAgentHistoryEventBestEffort(
    {
      kind: "goal",
      workspaceName: workspaceNameFromWorkingDir(params.workingDir),
      goalId: params.runId,
    },
    {
      event: params.event,
      phase: "manual-tests",
      backend: params.backend,
      runId: params.runId,
      goalId: params.runId,
      status: params.status,
      attemptNumber: params.attemptNumber,
      tokenUsage: params.tokenUsage,
      errorClass: params.errorClass,
      outputSummary: params.outputSummary,
      promptArtifactPath: params.promptArtifactPath,
      artifactPaths: params.artifactPaths,
    },
  );
}

function usageFromGoalLlmClient(response: {
  usage?: { inputTokens: number; outputTokens: number };
}): AgentBackendUsage {
  if (!response.usage) {
    return { available: false, reason: "GoalLlmClient response did not include usage metadata" };
  }
  return {
    available: true,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    totalTokens: response.usage.inputTokens + response.usage.outputTokens,
    source: "codex-json",
  };
}

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

function buildCodexManualTestsArgs(params: {
  prompt: string;
  sandboxConfig: CodexNativeSandboxConfig;
}): string[] {
  const codexAskForApproval = getCodexAskForApprovalPlacement();
  const args = [
    ...(codexAskForApproval === "before_exec" ? ["--ask-for-approval", "never"] : []),
    "exec",
    "--json",
    ...(codexAskForApproval === "after_exec" ? ["--ask-for-approval", "never"] : []),
  ];
  appendCodexNativeSandboxExecArgs(args, params.sandboxConfig);
  args.push(params.prompt);
  return args;
}

function buildClaudeManualTestsArgs(params: {
  sandboxConfig: ClaudeCodeLaunchSandboxConfig;
}): string[] {
  const args = ["-p", "--output-format", "json", "--max-turns", "1"];
  appendClaudeCodeSandboxArgs(args, params.sandboxConfig);
  return args;
}

async function runManualTestsForBackend(params: {
  backend: CliWorkerId;
  claudeBin: string | null;
  combinedPrompt: string;
  artifacts?: ManualTestsArtifactPaths;
  artifactHint: string;
  runId?: string;
  workingDir: string;
  attemptNumber: number;
}): Promise<PhaseAttempt<string>> {
  const { backend, claudeBin, combinedPrompt, artifacts, artifactHint } = params;
  const useCodex = backend === "codex";
  const claudeSandbox = !useCodex
    ? buildClaudeCodeSandboxLaunchConfig({
        workingDir: params.workingDir,
        runId: `${params.runId ?? "manual-tests"}-manual-tests-${params.attemptNumber}`,
        purpose: "repo-chat",
      })
    : undefined;
  const codexSandbox = useCodex
    ? writeCodexNativeSandboxConfig({
        workingDir: params.workingDir,
        runId: `${params.runId ?? "manual-tests"}-manual-tests-${params.attemptNumber}`,
        purpose: "repo-chat",
        requiresNetwork: true,
        sandboxRoot: process.env.SMITHERSBOT_CODEX_SANDBOX_ROOT,
      })
    : undefined;
  const args = useCodex
    ? buildCodexManualTestsArgs({ prompt: combinedPrompt, sandboxConfig: codexSandbox! })
    : buildClaudeManualTestsArgs({ sandboxConfig: claudeSandbox! });
  let promptArtifactPath: string | undefined;
  if (params.runId) {
    const launchHistory = writeCriticalAgentLaunchEvent({
      scope: {
        kind: "goal",
        workspaceName: workspaceNameFromWorkingDir(params.workingDir),
        goalId: params.runId,
      },
      phase: "manual-tests",
      backend,
      prompt: combinedPrompt,
      command: useCodex ? "codex" : claudeBin!,
      argv: useCodex
        ? args.map((arg, index) =>
            index === args.length - 1 ? "<prompt redacted; see prompt artifact>" : arg,
          )
        : args,
      event: {
        runId: params.runId,
        goalId: params.runId,
        attemptNumber: params.attemptNumber,
        status: "started",
        artifactPaths: artifacts ? [artifacts.stdoutPath, artifacts.stderrPath] : undefined,
      },
    });
    promptArtifactPath = launchHistory.promptArtifactPath;
  }

  const procResult = await runCliProcess({
    command: useCodex ? "codex" : claudeBin!,
    args,
    cwd: params.workingDir,
    timeoutMs: MANUAL_TESTS_TIMEOUT_MS,
    ...(useCodex ? {} : { stdin: combinedPrompt }),
    env: useCodex
      ? mergeCodexNativeSandboxEnv(
          buildCredentialStrippedEnv(process.env, { stripAuthKeys: true }),
          codexSandbox!,
        )
      : buildClaudeCodeEnv("subscription"),
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
  const tokenUsage = parseBackendUsage(`${procResult.stdout}\n${procResult.stderr}`);

  if (redactedProcResult.timedOut) {
    appendManualTestsHistory({
      runId: params.runId,
      workingDir: params.workingDir,
      backend,
      event: "failure",
      status: "error",
      attemptNumber: params.attemptNumber,
      tokenUsage,
      errorClass: "timeout",
      promptArtifactPath,
      artifactPaths: artifacts ? [artifacts.stdoutPath, artifacts.stderrPath] : undefined,
    });
    return {
      ok: false,
      errorText: `Manual test generation timed out after ${(MANUAL_TESTS_TIMEOUT_MS / 1000).toFixed(0)} seconds.${artifactHint}`,
    };
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
    const errorText = `Manual test generation failed: ${detail}${artifactHint}`;
    appendManualTestsHistory({
      runId: params.runId,
      workingDir: params.workingDir,
      backend,
      event: "failure",
      status: "error",
      attemptNumber: params.attemptNumber,
      tokenUsage,
      errorClass: "nonzero_exit",
      outputSummary: errorText,
      promptArtifactPath,
      artifactPaths: artifacts ? [artifacts.stdoutPath, artifacts.stderrPath] : undefined,
    });
    return { ok: false, errorText };
  }

  try {
    const value = redactSecretValues(extractAssistantTextFromCliResult(redactedProcResult.stdout));
    appendManualTestsHistory({
      runId: params.runId,
      workingDir: params.workingDir,
      backend,
      event: "result",
      status: "success",
      attemptNumber: params.attemptNumber,
      tokenUsage,
      outputSummary: "manual test suggestions generated",
      promptArtifactPath,
      artifactPaths: artifacts ? [artifacts.stdoutPath, artifacts.stderrPath] : undefined,
    });
    return { ok: true, value };
  } catch (error) {
    const baseMessage = error instanceof Error ? error.message : String(error);
    appendManualTestsHistory({
      runId: params.runId,
      workingDir: params.workingDir,
      backend,
      event: "failure",
      status: "error",
      attemptNumber: params.attemptNumber,
      tokenUsage,
      errorClass: "invalid_result",
      outputSummary: baseMessage,
      promptArtifactPath,
      artifactPaths: artifacts ? [artifacts.stdoutPath, artifacts.stderrPath] : undefined,
    });
    return { ok: false, errorText: `${baseMessage}${artifactHint}` };
  }
}

async function generateManualTestsViaCli(params: {
  userMessage: string;
  runDir?: string;
  runId?: string;
  workingDir: string;
}): Promise<string> {
  const claudeBin = resolveClaudeBinary();
  const combinedPrompt = buildCombinedManualTestsPrompt(params.userMessage);
  const codexAvailable =
    detectBackendAvailability().find((entry) => entry.id === "codex")?.available === true;
  if (!claudeBin && !codexAvailable) {
    appendManualTestsHistory({
      runId: params.runId,
      workingDir: params.workingDir,
      backend: "none",
      event: "failure",
      status: "error",
      errorClass: "no_backend",
      outputSummary: NO_BACKEND_MANUAL_TESTS_ERROR,
      tokenUsage: { available: false, reason: "no backend was available" },
    });
    throw new Error(NO_BACKEND_MANUAL_TESTS_ERROR);
  }

  // Prefer Claude Code, then fall back to Codex once on a usage/rate limit.
  const backends: CliWorkerId[] = [];
  if (claudeBin) backends.push("claude_code");
  if (codexAvailable) backends.push("codex");

  let artifacts: ManualTestsArtifactPaths | undefined;
  if (params.runDir) {
    try {
      artifacts = ensureManualTestsArtifactDir(params.runDir);
    } catch {
      // Best-effort: continue without persisted artifacts if mkdir fails.
      artifacts = undefined;
    }
  }
  const artifactHint = artifacts
    ? ` (stdout: ${artifacts.stdoutPath}, stderr: ${artifacts.stderrPath})`
    : "";

  const outcome = await runWithBackendFallback<string>({
    backends,
    attempt: async (backend) => {
      const attemptNumber = backends.indexOf(backend) + 1;
      const result = await runManualTestsForBackend({
        backend,
        claudeBin,
        combinedPrompt,
        artifacts,
        artifactHint,
        runId: params.runId,
        workingDir: params.workingDir,
        attemptNumber,
      });
      if (!result.ok) {
        appendManualTestsHistory({
          runId: params.runId,
          workingDir: params.workingDir,
          backend,
          event: "fallback",
          status: "failed",
          attemptNumber,
          errorClass: "backend_failed",
          outputSummary: result.errorText,
        });
      }
      return result;
    },
  });

  if (outcome.status === "success") return outcome.value;
  throw new Error(outcome.message);
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

function compactManualPromptText(value: string, maxChars = MAX_MANUAL_PROMPT_TEXT_CHARS): string {
  const redacted = redactSecretValues(value).replace(/\s+/g, " ").trim();
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, maxChars).trimEnd()}...`;
}

function collectChangedSurfaces(doneSteps: PlanStep[]): string[] {
  const surfaces: string[] = [];
  const seen = new Set<string>();
  for (const step of doneSteps) {
    const label = step.shortSummary?.trim() || step.description;
    const summary = step.taskSummary?.trim();
    const value = summary
      ? `[${step.id}] ${label}: ${compactManualPromptText(summary, 180)}`
      : `[${step.id}] ${label}`;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    surfaces.push(value);
    if (surfaces.length >= MAX_MANUAL_PROMPT_STEPS) break;
  }
  return surfaces;
}

function collectLiveGaps(params: { runId?: string; workingDir: string }): string[] {
  if (!params.runId) return [];
  try {
    const eventsPath = resolveAgentHistoryEventsPath({
      kind: "goal",
      workspaceName: workspaceNameFromWorkingDir(params.workingDir),
      goalId: params.runId,
    });
    if (!fs.existsSync(eventsPath)) return [];
    const gaps: string[] = [];
    const seen = new Set<string>();
    for (const line of fs.readFileSync(eventsPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const phase = typeof event.phase === "string" ? event.phase : "unknown";
      const status = typeof event.status === "string" ? event.status : "";
      const errorClass = typeof event.errorClass === "string" ? event.errorClass : "";
      const summary = typeof event.outputSummary === "string" ? event.outputSummary : "";
      const isGap =
        status === "failed" ||
        status === "error" ||
        status === "skipped" ||
        errorClass.length > 0 ||
        /\b(manual|live|external|telegram|browser|device|visual|not verified|gap)\b/i.test(summary);
      if (!isGap) continue;
      const detail = compactManualPromptText(summary || errorClass || status, 180);
      const value = `${phase}: ${detail}`;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      gaps.push(value);
      if (gaps.length >= MAX_MANUAL_LIVE_GAPS) break;
    }
    return gaps;
  } catch {
    return [];
  }
}

function buildRuntimeArtifactReferences(params: { runId?: string; workingDir: string }): string[] {
  if (!params.runId) {
    return [
      "<managed-root>/agent/history/goals/<workspace>/<goalId>/runtime/ (available when a run id is provided)",
    ];
  }
  const workspace = workspaceNameFromWorkingDir(params.workingDir);
  const runtimeDir = path.join(resolveAgentGoalHistoryDir(workspace, params.runId), "runtime");
  return [
    `${runtimeDir}/index.json`,
    `${runtimeDir}/workers/`,
    `${runtimeDir}/autocheck/`,
    `${runtimeDir}/manual-tests/`,
  ];
}

function buildManualTestsUserPrompt(params: {
  goal: string;
  doneSteps: PlanStep[];
  runId?: string;
  workingDir: string;
}): string {
  const changedSurfaces = collectChangedSurfaces(params.doneSteps);
  const lines: string[] = [
    `Goal summary: ${compactManualPromptText(params.goal, 320)}`,
    "",
    "Changed surfaces:",
  ];
  if (changedSurfaces.length === 0) {
    lines.push("- No completed implementation surfaces were recorded.");
  } else {
    for (const surface of changedSurfaces) {
      lines.push(`- ${surface}`);
    }
  }

  const automatedChecks = collectAutomatedChecks(params.doneSteps);
  lines.push("");
  lines.push("Automated checks already performed:");
  if (automatedChecks.length === 0) {
    lines.push("- None explicitly recorded in task summaries.");
  } else {
    for (const check of automatedChecks) {
      lines.push(`- ${check}`);
    }
  }

  const liveGaps = collectLiveGaps({ runId: params.runId, workingDir: params.workingDir });
  lines.push("");
  lines.push("Live/manual gaps from runtime events:");
  if (liveGaps.length === 0) {
    lines.push("- No live-environment gaps were explicitly recorded.");
  } else {
    for (const gap of liveGaps) {
      lines.push(`- ${gap}`);
    }
  }

  lines.push("");
  lines.push("Agent-history runtime artifacts for debugging context:");
  for (const artifact of buildRuntimeArtifactReferences({
    runId: params.runId,
    workingDir: params.workingDir,
  })) {
    lines.push(`- ${artifact}`);
  }

  lines.push("");
  lines.push("Generate only the minimum manual tests needed for behavior not covered above.");
  lines.push(
    "Do not suggest re-running any deterministic build, lint, type-check, test, or CLI checks listed above.",
  );
  return redactSecretValues(lines.join("\n"));
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

function buildOptionalEmbeddedAuthFallback(doneSteps: PlanStep[]): ManualTestSuggestion[] {
  return buildFallbackTests(doneSteps, doneSteps.length, new Set<string>()).map((entry) => ({
    ...entry,
    reason: OPTIONAL_EMBEDDED_AUTH_FALLBACK_REASON,
  }));
}

export async function generateManualTests(
  params: GenerateManualTestsParams,
): Promise<ManualTestsResult> {
  const minTests = Math.max(0, params.minTests ?? DEFAULT_MIN_TESTS);
  const maxTests = Math.max(minTests, params.maxTests ?? DEFAULT_MAX_TESTS);
  const doneSteps = params.steps.filter((step) => (step.status ?? "done") === "done");
  if (doneSteps.length === 0) return { status: "generated", tests: [] };

  const runId = resolveManualTestsRunId(params);
  const workingDir = params.workingDir ?? process.cwd();
  const userMessage = buildManualTestsUserPrompt({
    goal: params.goal,
    doneSteps,
    runId,
    workingDir,
  });
  let parsed: Record<string, unknown> | undefined;

  for (let attempt = 1; attempt <= MANUAL_TESTS_PARSE_MAX_ATTEMPTS; attempt += 1) {
    let modelResponseText: string;
    if (params.client) {
      let promptArtifactPath: string | undefined;
      if (runId) {
        const launchHistory = writeCriticalAgentLaunchEvent({
          scope: {
            kind: "goal",
            workspaceName: workspaceNameFromWorkingDir(workingDir),
            goalId: runId,
          },
          phase: "manual-tests",
          backend: "goal-llm-client",
          prompt: buildCombinedManualTestsPrompt(userMessage),
          command: "GoalLlmClient.complete",
          event: {
            runId,
            goalId: runId,
            attemptNumber: attempt,
            status: "started",
          },
        });
        promptArtifactPath = launchHistory.promptArtifactPath;
      }
      let response: Awaited<ReturnType<GoalLlmClient["complete"]>>;
      try {
        response = await params.client.complete({
          systemPrompt: MANUAL_TESTS_SYSTEM_PROMPT,
          userMessage,
          maxTokens: 900,
        });
      } catch (error) {
        const isAuthFallback = isOptionalEmbeddedAgentAuthError(error);
        appendManualTestsHistory({
          runId,
          workingDir,
          backend: "goal-llm-client",
          event: "failure",
          status: "error",
          attemptNumber: attempt,
          tokenUsage: {
            available: false,
            reason: "GoalLlmClient call failed before usage metadata",
          },
          errorClass: isAuthFallback ? "embedded_agent_auth_unavailable" : "client_error",
          outputSummary: isAuthFallback
            ? redactedOptionalEmbeddedAuthMessage()
            : error instanceof Error
              ? error.message
              : String(error),
          promptArtifactPath,
        });
        if (isAuthFallback) {
          return {
            status: "skipped_no_embedded_auth",
            tests: buildOptionalEmbeddedAuthFallback(doneSteps).slice(0, maxTests),
            error: redactedOptionalEmbeddedAuthMessage(),
          };
        }
        throw error;
      }
      appendManualTestsHistory({
        runId,
        workingDir,
        backend: "goal-llm-client",
        event: "result",
        status: "success",
        attemptNumber: attempt,
        tokenUsage: usageFromGoalLlmClient(response),
        outputSummary: "manual test suggestions generated",
        promptArtifactPath,
      });
      modelResponseText = redactSecretValues(response.text);
    } else {
      if (isTestEnv()) {
        throw new Error("Manual test generation requires an injected client in tests.");
      }
      modelResponseText = redactSecretValues(
        await generateManualTestsViaCli({
          userMessage,
          runDir: params.runDir,
          runId,
          workingDir,
        }),
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

  return { status: "generated", tests: suggestions.slice(0, maxTests) };
}
