import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import type { MoltbotConfig } from "../config/config.js";
import type { ClaudeCodeAuthMode, CliWorkerId } from "../config/types.goal.js";
import {
  loadAttemptBundles,
  resolveWorkerDir,
  formatAttemptBundleSummary,
  writeAttemptBundle,
  type AttemptBundle,
} from "./attempt-bundle.js";
import { aggregateBlockedDetails } from "./blocked.js";
import { detectBackendAvailability, isBackendAvailable } from "./backend-availability.js";
import { resolveEnabledWorkers, type GoalBackendId } from "./backend-types.js";
import { buildClaudeCodeEnv } from "./claude-code-env.js";
import { runCliProcess, type RunCliProcessResult } from "./cli-process.js";
import { formatCompactGoalCompletionSummary, type GoalOutputChannel } from "./compact-output.js";
import { CliTaskRunner } from "./cli-runner.js";
import { HARD_DENIES } from "./hard-deny.js";
import {
  autosaveIfDirty,
  buildRunBranchName,
  canRunGit,
  createRunPullRequest,
  ensureRunBranch,
  finalizeTaskCheckpoint,
  isGitRepo,
  isWorkingTreeClean,
  pushRunBranch,
  startTaskCheckpoint,
} from "./git-checkpoint.js";
import { isRepoPrivate } from "./git-privacy.js";
import {
  orderStepsCriticalPathFirst,
  computeCriticalPathScores,
  type CriticalPathScores,
} from "./plan-order.js";
import { extractRunLessons, getLessonsForContext } from "./lessons.js";
import { generateManualTests } from "./manual-tests.js";
import { PiTaskRunner } from "./pi-runner.js";
import { loadRun, resolveGoalWorkingFile, resolveWorkingFile } from "./run-store.js";
import { resolveClaudeBinary } from "./scout.js";
import type {
  GitCheckpointConfig,
  GoalLlmClient,
  GoalOutcome,
  GoalSession,
  ManualTestSuggestion,
  PlanStep,
  RetryConfig,
  SerializedRun,
  TaskExecutionResult,
} from "./types.js";
import type { TaskRunner, TaskRunnerContext, TaskRunnerResult } from "./task-runner.js";

const DEFAULT_MAX_TURNS_PER_TASK = 5;
const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes per prompt
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_MAX_RALPH_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_BACKEND: CliWorkerId = "claude_code";
const DEFAULT_MAX_BUILD_GATE_FIX_CYCLES = 2;
const BUILD_GATE_COMMAND_TIMEOUT_MS = 5 * 60_000;
const BUILD_GATE_OUTPUT_MAX_CHARS = 16_000;
const POST_EXECUTION_REVIEW_TIMEOUT_MS = 120_000;
const POST_EXECUTION_REVIEW_MAX_ISSUES = 8;
const POST_EXECUTION_REVIEW_ERROR_MAX_CHARS = 400;
const CLAUDE_REVIEW_ALLOWED_TOOLS = "Read,Glob,Grep,Bash";
const CLAUDE_REVIEW_READ_ONLY_PROMPT =
  "This is READ-ONLY. Do NOT create, modify, or delete any files.";

const MIN_TASK_TIMEOUT_MS = 10 * 60_000;
const MAX_TASK_TIMEOUT_MS = 2 * 60 * 60_000;

const PI_RETRYABLE: PlanStep["blockedReason"][] = ["timeout", "network", "rate_limit"];
const FATAL_ERRORS: PlanStep["blockedReason"][] = ["out_of_credits", "auth"];

type PostExecutionReviewDecision = {
  approved: boolean;
  issues: string[];
};

type PostExecutionReviewResult =
  | { status: "approved"; issues: string[] }
  | { status: "rejected"; issues: string[] }
  | { status: "error"; reason: string };

function isAnthropicPlannerDegraded(
  reason: string | undefined,
): reason is "anthropic_rate_limit" | "anthropic_usage_limit" {
  return reason === "anthropic_rate_limit" || reason === "anthropic_usage_limit";
}

function rewriteStepBackendsForDegradedPlanner(
  step: PlanStep,
  enabledWorkers: CliWorkerId[],
): void {
  if (!enabledWorkers.includes("codex")) return;
  if (!step.backend || step.backend === "claude_code") {
    step.backend = "codex";
  }
  if (step.executedBackend === "claude_code") {
    step.executedBackend = "codex";
  }
}

export type GoalStatusChangeEvent =
  | { type: "step_blocked"; stepId: string; question: string; steps: PlanStep[] }
  | { type: "fully_blocked"; steps: PlanStep[] }
  | { type: "plan_revised"; revision: number; summary: string; steps: PlanStep[] }
  | {
      type: "all_done";
      steps: PlanStep[];
      summary: string;
      prUrl?: string;
      manualTests?: ManualTestSuggestion[];
      manualTestsError?: string;
    };

export type ExecuteGoalParams = {
  session: GoalSession;
  runId: string;
  workingDir: string;
  config?: MoltbotConfig;
  enabledWorkers?: CliWorkerId[];
  provider?: string;
  model?: string;
  maxTurnsPerTask?: number;
  timeoutMs?: number;
  retryConfig?: Partial<RetryConfig>;
  gitCheckpointConfig?: Partial<GitCheckpointConfig>;
  onTaskUpdate?: (result: TaskExecutionResult) => void;
  /** Called when a task transitions to in_progress (before execution). */
  onTaskStart?: (taskId: string) => void;
  onProgress?: (text: string) => void;
  onStatusChange?: (event: GoalStatusChangeEvent) => void | Promise<void>;
  abortSignal?: AbortSignal;
  serializedRun?: SerializedRun;
  /** How Claude Code workers authenticate: subscription (default) or api_key. */
  claudeCodeAuth?: ClaudeCodeAuthMode;
  /** Optional LLM client for generating manual test suggestions on completion. */
  manualTestsClient?: GoalLlmClient;
  /** Output channel for formatting the completion summary. */
  channel?: GoalOutputChannel;
};

/** Append a summary line to the top-level WORKING.md for this goal run. */
function appendGoalWorkingEntry(
  runId: string,
  stepId: string,
  status: string,
  detail: string,
): void {
  try {
    const filePath = resolveGoalWorkingFile(runId);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const entry = `\n## ${stepId} — ${status}\n${detail}\n`;
    fs.appendFileSync(filePath, entry, "utf8");
  } catch {
    // Best-effort; don't mask task execution errors.
  }
}

function appendRetryContext(
  runId: string,
  stepId: string,
  summary: string,
  attemptNumber: number,
): void {
  try {
    const filePath = resolveWorkingFile(runId, stepId);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const entry = [
      `\n## Retry Context Attempt ${attemptNumber} (${new Date().toISOString()})`,
      summary,
      "",
    ].join("\n");
    fs.appendFileSync(filePath, entry, "utf8");
  } catch {
    // Best-effort
  }
}

function appendRalphContext(
  runId: string,
  stepId: string,
  attemptNumber: number,
  detail: {
    approachTried: string;
    specificErrors: string;
    keyInsight: string;
    suggestedApproach: string;
  },
): void {
  try {
    const filePath = resolveWorkingFile(runId, stepId);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const timestamp = new Date().toISOString();
    const entry = [
      `\n## Ralph (attempt ${attemptNumber}) — ${timestamp}`,
      "### Approach tried",
      detail.approachTried,
      "### Errors encountered",
      detail.specificErrors,
      "### Key insight",
      detail.keyInsight,
      "### Suggested approach for next attempt",
      detail.suggestedApproach,
      "",
    ].join("\n");
    fs.appendFileSync(filePath, entry, "utf8");
  } catch {
    // Best-effort; don't mask task execution errors.
  }
}

type BuildGateResult = { passed: true } | { passed: false; failedCommand: string; output: string };

function truncateForPrompt(text: string): string {
  if (!text) return "";
  const trimmed = text.trim();
  if (trimmed.length <= BUILD_GATE_OUTPUT_MAX_CHARS) return trimmed;
  return trimmed.slice(-BUILD_GATE_OUTPUT_MAX_CHARS);
}

function formatExecError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const maybeStdout = (error as { stdout?: Buffer | string }).stdout;
  const maybeStderr = (error as { stderr?: Buffer | string }).stderr;
  const stdout =
    typeof maybeStdout === "string"
      ? maybeStdout
      : maybeStdout instanceof Buffer
        ? maybeStdout.toString("utf8")
        : "";
  const stderr =
    typeof maybeStderr === "string"
      ? maybeStderr
      : maybeStderr instanceof Buffer
        ? maybeStderr.toString("utf8")
        : "";
  return [error.message, stdout, stderr]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function collectText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((entry) => collectText(entry)).join("");
  if (!isRecord(value)) return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content))
    return value.content.map((entry) => collectText(entry)).join("");
  if (isRecord(value.message)) return collectText(value.message);
  if (isRecord(value.delta)) return collectText(value.delta);
  if (isRecord(value.item)) return collectText(value.item);
  if (isRecord(value.result)) return collectText(value.result);
  return "";
}

function extractJsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaping = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (!ch) continue;
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (ch === "\\") {
        escaping = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === "}") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

function normalizeReviewIssues(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const normalized = raw
    .map((issue) => (typeof issue === "string" ? issue.trim() : ""))
    .filter((issue) => issue.length > 0);
  return normalized.slice(0, POST_EXECUTION_REVIEW_MAX_ISSUES);
}

function parsePostExecutionReviewDecisionRecord(
  raw: unknown,
): PostExecutionReviewDecision | undefined {
  if (!isRecord(raw) || typeof raw.approved !== "boolean") return undefined;
  return { approved: raw.approved, issues: normalizeReviewIssues(raw.issues) };
}

function parsePostExecutionReviewDecisionFromText(
  text: string,
): PostExecutionReviewDecision | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const decision = parsePostExecutionReviewDecisionRecord(parsed);
    if (decision) return decision;
  } catch {
    // Fall through to lenient extraction.
  }

  for (const line of trimmed.split(/\r?\n/g)) {
    const candidate = line.trim();
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const decision = parsePostExecutionReviewDecisionRecord(parsed);
      if (decision) return decision;
    } catch {
      continue;
    }
  }

  for (const candidate of extractJsonObjectCandidates(trimmed)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const decision = parsePostExecutionReviewDecisionRecord(parsed);
      if (decision) return decision;
    } catch {
      continue;
    }
  }

  return undefined;
}

function parsePostExecutionReviewDecision(stdout: string): PostExecutionReviewDecision | undefined {
  const fromText = parsePostExecutionReviewDecisionFromText(stdout);
  if (fromText) return fromText;

  for (const line of stdout.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const direct = parsePostExecutionReviewDecisionRecord(parsed);
      if (direct) return direct;
      const viaResult = isRecord(parsed)
        ? parsePostExecutionReviewDecisionRecord(parsed.result)
        : undefined;
      if (viaResult) return viaResult;
      const text = collectText(parsed).trim();
      if (!text) continue;
      const fromLineText = parsePostExecutionReviewDecisionFromText(text);
      if (fromLineText) return fromLineText;
    } catch {
      continue;
    }
  }

  return undefined;
}

function truncateSingleLine(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= POST_EXECUTION_REVIEW_ERROR_MAX_CHARS) return normalized;
  return `${normalized.slice(0, POST_EXECUTION_REVIEW_ERROR_MAX_CHARS).trimEnd()}...`;
}

function describeCliFailure(result: RunCliProcessResult): string {
  const detail = truncateSingleLine(result.stderr) || truncateSingleLine(result.stdout);
  if (detail) return detail;
  if (result.signal) return `terminated by ${result.signal}`;
  return `exit=${result.exitCode ?? "unknown"}`;
}

function resolvePostExecutionReviewBaseSha(
  steps: PlanStep[],
  checkpoints?: GoalSession["taskCheckpoints"],
): string | undefined {
  if (!checkpoints) return undefined;
  const firstStepId = steps[0]?.id;
  const firstSha = firstStepId ? checkpoints[firstStepId]?.baseSha : undefined;
  if (firstSha) return firstSha;

  for (const step of steps) {
    const candidate = checkpoints[step.id]?.baseSha;
    if (candidate) return candidate;
  }

  return undefined;
}

function buildPostExecutionReviewPrompt(params: {
  goal: string;
  steps: PlanStep[];
  diff: string;
}): string {
  const stepLines = params.steps.map((step, index) => {
    const headline = step.shortSummary?.trim() || step.description.trim();
    const summary = step.taskSummary?.trim();
    return `${index + 1}. ${step.id} — ${headline}${summary ? `\n   Result: ${summary}` : ""}`;
  });

  return [
    "Review this diff for: code quality issues, missed edge cases, unnecessary complexity, security concerns, leftover debug code, incomplete error handling.",
    "",
    "Goal description:",
    params.goal,
    "",
    "Plan step summaries:",
    ...(stepLines.length > 0 ? stepLines : ["(no steps)"]),
    "",
    "Full diff:",
    "```diff",
    params.diff || "(no diff output)",
    "```",
    "",
    'Return ONLY JSON with shape: {"approved": boolean, "issues": string[]}.',
    "When approved is true, issues may be empty.",
    "When approved is false, include concrete actionable issues.",
  ].join("\n");
}

async function runPostExecutionReview(params: {
  goal: string;
  steps: PlanStep[];
  diff: string;
  workingDir: string;
  claudeCodeAuth: ClaudeCodeAuthMode;
  abortSignal: AbortSignal;
}): Promise<PostExecutionReviewResult> {
  const claudeBinary = resolveClaudeBinary();
  if (!claudeBinary) {
    return { status: "error", reason: "claude binary not found on PATH" };
  }

  const reviewPrompt = buildPostExecutionReviewPrompt({
    goal: params.goal,
    steps: params.steps,
    diff: params.diff,
  });

  let result: RunCliProcessResult;
  try {
    result = await runCliProcess({
      command: claudeBinary,
      args: [
        "-p",
        "--output-format",
        "json",
        "--max-turns",
        "1",
        "--allowedTools",
        CLAUDE_REVIEW_ALLOWED_TOOLS,
        "--append-system-prompt",
        CLAUDE_REVIEW_READ_ONLY_PROMPT,
      ],
      cwd: params.workingDir,
      timeoutMs: POST_EXECUTION_REVIEW_TIMEOUT_MS,
      stdin: reviewPrompt,
      abortSignal: params.abortSignal,
      env: buildClaudeCodeEnv(params.claudeCodeAuth),
    });
  } catch (error) {
    return {
      status: "error",
      reason: `review process failed: ${truncateSingleLine(formatExecError(error)) || "unknown error"}`,
    };
  }

  if (result.timedOut) {
    return {
      status: "error",
      reason: `review timed out after ${(POST_EXECUTION_REVIEW_TIMEOUT_MS / 1000).toFixed(0)}s`,
    };
  }
  if ((result.exitCode && result.exitCode !== 0) || result.signal) {
    return { status: "error", reason: describeCliFailure(result) };
  }

  const decision = parsePostExecutionReviewDecision(result.stdout);
  if (!decision) {
    return { status: "error", reason: "review response was not valid JSON decision output" };
  }

  return decision.approved
    ? { status: "approved", issues: decision.issues }
    : { status: "rejected", issues: decision.issues };
}

function runBuildGateCommands(commands: string[], workingDir: string): BuildGateResult {
  for (const command of commands) {
    const trimmed = command.trim();
    if (!trimmed) continue;

    const result = spawnSync("bash", ["-lc", trimmed], {
      cwd: workingDir,
      encoding: "utf8",
      timeout: BUILD_GATE_COMMAND_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    const output = truncateForPrompt([stdout, stderr].filter(Boolean).join("\n"));

    if (result.error) {
      const message = truncateForPrompt(
        [output, `Build gate command failed to execute: ${formatExecError(result.error)}`]
          .filter(Boolean)
          .join("\n"),
      );
      return {
        passed: false,
        failedCommand: trimmed,
        output: message || "Build gate command failed with an unknown process error.",
      };
    }

    if (result.status !== 0) {
      const statusBits = [
        result.status != null ? `exit code ${result.status}` : null,
        result.signal ? `signal ${result.signal}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      const message = truncateForPrompt(
        [output, statusBits ? `Build gate command failed with ${statusBits}.` : ""]
          .filter(Boolean)
          .join("\n"),
      );
      return {
        passed: false,
        failedCommand: trimmed,
        output: message || "Build gate command exited non-zero with no output.",
      };
    }
  }

  return { passed: true };
}

function resetToTaskBaseSha(
  workingDir: string,
  checkpointSha: string | undefined,
): { success: true } | { success: false; error: string } {
  if (!checkpointSha) {
    return { success: false, error: "No task checkpoint base SHA was recorded for this step." };
  }
  try {
    execFileSync("git", ["-C", workingDir, "reset", "--hard", checkpointSha], {
      encoding: "utf8",
      timeout: 15_000,
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: formatExecError(error) };
  }
}

function buildRalphHistorySummary(stepId: string, bundles: AttemptBundle[]): string {
  const entries = bundles.filter((bundle) => bundle.ralphDetail);
  if (entries.length === 0) return `Task ${stepId} ralphed repeatedly but no detail was captured.`;

  const lines: string[] = [];
  for (const [index, bundle] of entries.entries()) {
    const detail = bundle.ralphDetail!;
    lines.push(`**Ralph ${index + 1} (attempt ${bundle.attemptNumber}):**`);
    lines.push(`• **Approach tried:** ${detail.approachTried}`);
    lines.push(`• **Errors:** ${detail.specificErrors}`);
    lines.push(`• **Key insight:** ${detail.keyInsight}`);
    lines.push(`• **Suggested approach:** ${detail.suggestedApproach}`);
    if (index < entries.length - 1) lines.push("");
  }
  return lines.join("\n");
}

function makeBuildGateFailurePrompt(command: string, output: string): string {
  return [
    `The build gate (${command}) failed after you reported complete.`,
    "Fix the errors.",
    "Here is the output:",
    output,
  ].join("\n");
}

function resolveTaskTimeoutMs(durationMinutes: number | undefined, fallbackMs: number): number {
  if (!durationMinutes || durationMinutes <= 0) return Math.max(fallbackMs, MIN_TASK_TIMEOUT_MS);
  const estimateMs = durationMinutes * 2 * 60_000;
  return Math.max(MIN_TASK_TIMEOUT_MS, Math.min(estimateMs, MAX_TASK_TIMEOUT_MS));
}

export async function executeGoalWithAgent(params: ExecuteGoalParams): Promise<GoalOutcome> {
  const {
    session,
    runId,
    workingDir,
    config,
    enabledWorkers,
    maxTurnsPerTask = DEFAULT_MAX_TURNS_PER_TASK,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retryConfig,
    gitCheckpointConfig,
    onTaskUpdate,
    onTaskStart,
    onProgress,
    onStatusChange,
    abortSignal,
    claudeCodeAuth = "subscription",
  } = params;

  const plan = session.plan;
  if (!plan) throw new Error("No plan to execute");

  session.state = "executing";
  session.buildGateConfig = plan.buildGate;
  session.stepRalphCounts ??= {};
  session.buildGateFixCounts ??= {};
  session.buildGateResults ??= {};

  const effectiveAbort = abortSignal ?? new AbortController().signal;
  const resolvedEnabledWorkers = resolveEnabledWorkers(
    enabledWorkers ? { enabledWorkers } : config?.goal,
  );
  const maxRalphAttempts = retryConfig?.maxRalphAttempts ?? DEFAULT_MAX_RALPH_ATTEMPTS;
  const buildGateFixCounts = new Map<string, number>(
    Object.entries(params.serializedRun?.buildGateFixCounts ?? session.buildGateFixCounts),
  );
  const persistBuildGateFixCounts = (): void => {
    session.buildGateFixCounts = Object.fromEntries(buildGateFixCounts);
  };
  persistBuildGateFixCounts();

  const runBranchName = buildRunBranchName(runId, params.serializedRun?.createdAt);

  // --- Git setup (branch + autosave) ---
  if (gitCheckpointConfig?.enabled) {
    if (!canRunGit() || !isGitRepo(workingDir)) {
      const msg = "Git checkpoints are enabled but this working directory is not a valid git repo.";
      session.state = "blocked";
      session.blocked = { blockedAt: "execution", prompt: msg, requiredInputKey: "git" };
      return { status: "blocked", question: msg, requiredInputKey: "git", blockedAt: "execution" };
    }

    const isResume = session.stepResults.size > 0;
    if (!isWorkingTreeClean(workingDir)) {
      const message = isResume
        ? "claw: crash recovery autosave"
        : `claw: autosave before goal ${runId}`;
      const autosave = autosaveIfDirty(workingDir, message);
      if (!autosave.success) {
        const msg = `Git autosave failed: ${autosave.error}`;
        session.state = "blocked";
        session.blocked = { blockedAt: "execution", prompt: msg, requiredInputKey: "git" };
        return {
          status: "blocked",
          question: msg,
          requiredInputKey: "git",
          blockedAt: "execution",
        };
      }
      if (autosave.sha) {
        onProgress?.(`  [git] Autosaved changes (${autosave.sha.slice(0, 7)})`);
      }
    }

    const branchResult = ensureRunBranch(workingDir, runId, runBranchName);
    if (!branchResult.success) {
      const msg = `Git run branch failed: ${branchResult.error}`;
      session.state = "blocked";
      session.blocked = { blockedAt: "execution", prompt: msg, requiredInputKey: "git" };
      return { status: "blocked", question: msg, requiredInputKey: "git", blockedAt: "execution" };
    }
    onProgress?.(`  [git] Run branch at ${branchResult.sha.slice(0, 7)}`);
  }

  const scores = computeCriticalPathScores(plan.steps);
  const orderIndex = new Map(plan.steps.map((step, idx) => [step.id, idx]));
  const successors = buildSuccessorMap(plan.steps);
  let lastExecutedId: string | null = null;
  const orderedSteps = orderStepsCriticalPathFirst(plan.steps, scores);
  // Retry non-user-input blocked tasks once on resume, even without new answers.
  // This lets fixed environments (PATH/auth/network) take effect without requiring
  // fake /goal_answer input, while avoiding retry loops in a single execution run.
  const retryableBlockedIds = new Set(
    orderedSteps
      .filter(
        (step) =>
          step.status === "blocked" &&
          step.blockedReason != null &&
          step.blockedReason !== "user_input",
      )
      .map((step) => step.id),
  );

  const previouslyBlockedIds = new Set<string>();
  let stopAllTasks = false;
  let globalBlock: { kind: PlanStep["blockedReason"]; message: string } | null = null;
  let globalBlockApplied = false;

  const availability = detectBackendAvailability();
  const backendOverride = params.serializedRun?.backendOverride;
  const degradedPlanner =
    backendOverride !== "claude_code" &&
    isAnthropicPlannerDegraded(params.serializedRun?.plannerDegradedReason);
  const defaultCliBackend: CliWorkerId =
    resolvedEnabledWorkers.length === 1 ? resolvedEnabledWorkers[0]! : DEFAULT_BACKEND;
  const defaultBackend: GoalBackendId =
    degradedPlanner && resolvedEnabledWorkers.includes("codex") ? "codex" : defaultCliBackend;

  if (degradedPlanner) {
    for (const step of plan.steps) {
      rewriteStepBackendsForDegradedPlanner(step, resolvedEnabledWorkers);
    }
  }

  const piRunner = new PiTaskRunner({
    workingDir,
    runId,
    config,
    provider: params.provider,
    model: params.model,
    maxTurnsPerTask,
  });
  const cliRunners: Partial<Record<CliWorkerId, TaskRunner>> = {};
  if (resolvedEnabledWorkers.includes("codex")) {
    cliRunners.codex = new CliTaskRunner({ backend: "codex", model: params.model });
  }
  if (resolvedEnabledWorkers.includes("claude_code")) {
    cliRunners.claude_code = new CliTaskRunner({
      backend: "claude_code",
      model: params.model,
      claudeCodeAuth: params.claudeCodeAuth,
    });
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (effectiveAbort.aborted) break;

    // Check if the goal was stopped externally (e.g., via goal-stop command)
    const currentRun = loadRun(runId);
    if (currentRun?.state === "cancelled") {
      session.state = "cancelled";
      return { status: "cancelled" };
    }

    const runnable = findRunnableTasks(orderedSteps, session.answers, retryableBlockedIds);
    if (runnable.length === 0) break;

    const task = pickNextTask(runnable, scores, orderIndex, successors, lastExecutedId);

    let resumeAnswer: string | undefined;
    let resumeQuestion: string | undefined;
    if (task.status === "blocked") {
      retryableBlockedIds.delete(task.id);
      resumeAnswer = getAnswerForTask(task.id, session.answers);
      resumeQuestion = task.blockedQuestion;
      task.turnsUsed = 0;
      task.blockedReason = undefined;
      task.blockedQuestion = undefined;
      task.failedDetail = undefined;
      task.status = "pending";
      consumeAnswerForTask(task.id, session.answers);
    }

    const taskStartMs = Date.now();
    const taskTimeoutMs = resolveTaskTimeoutMs(task.durationMinutes, timeoutMs);

    const backend = clampBackendForEnabledWorkers(
      resolveBackendForStep(task, backendOverride, defaultBackend),
      resolvedEnabledWorkers,
    );
    const availabilityResult = isBackendAvailable(backend, availability);
    if (!availabilityResult.available) {
      const reason = availabilityResult.reason ? `: ${availabilityResult.reason}` : "";
      const msg = `Backend '${backend}' is not available${reason}. Install it or use --backend pi to override.`;
      task.status = "blocked";
      task.blockedReason = "error";
      task.blockedQuestion = msg;
      onProgress?.(`  [blocked] ${msg}`);
      recordTaskResult(session, task, taskStartMs, onTaskUpdate);
      lastExecutedId = task.id;
      continue;
    }

    if (task.executedBackend !== backend) task.executedBackend = backend;

    const runner = backend === "pi" ? piRunner : cliRunners[backend];
    if (!runner) {
      const msg = `Backend '${backend}' is not supported.`;
      task.status = "blocked";
      task.blockedReason = "error";
      task.blockedQuestion = msg;
      recordTaskResult(session, task, taskStartMs, onTaskUpdate);
      lastExecutedId = task.id;
      continue;
    }

    // Git task checkpoint at task start
    if (gitCheckpointConfig?.enabled) {
      session.taskCheckpoints ??= {};
      const checkpointResult = startTaskCheckpoint(workingDir, task.id);
      if (!checkpointResult.success) {
        const msg = `Git checkpoint failed: ${checkpointResult.error}`;
        task.status = "blocked";
        task.blockedReason = "error";
        task.blockedQuestion = msg;
        recordTaskResult(session, task, taskStartMs, onTaskUpdate);
        lastExecutedId = task.id;
        continue;
      }
      session.taskCheckpoints[task.id] = checkpointResult.checkpoint;
      onProgress?.(`  [git] Task base ${checkpointResult.checkpoint.baseSha.slice(0, 7)}`);
    }

    const maxAttempts = retryConfig?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const retryDelayMs = retryConfig?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const workerDir = resolveWorkerDir(runId, task.id);
    let latestResult: TaskRunnerResult | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const attemptBundles = loadAttemptBundles(workerDir);

      const completedSummaries = orderedSteps
        .filter((s) => s.status === "done" && s.taskSummary)
        .map((s) => ({ id: s.id, summary: s.taskSummary! }));

      const context: TaskRunnerContext = {
        task,
        plan,
        goal: session.goal,
        workingDir,
        runId,
        denyPolicy: HARD_DENIES,
        completedSummaries,
        resumeAnswer,
        resumeQuestion,
        attemptBundles,
        onProgress,
        abortSignal: effectiveAbort,
        timeoutMs: taskTimeoutMs,
      };

      task.status = "in_progress";
      onTaskStart?.(task.id);
      if (attempt === 1) {
        onProgress?.(`\n--- Task ${task.id} [${backend}]: ${task.description} ---`);
      }

      const result = await runner.execute(context);
      latestResult = result;
      applyTaskResult(task, result, onProgress);

      const latestBundles = loadAttemptBundles(workerDir);

      if (shouldRetry(result, backend, workerDir) && attempt < maxAttempts) {
        const latestAttempt = latestBundles.at(-1);
        if (latestAttempt) {
          appendRetryContext(
            runId,
            task.id,
            formatAttemptBundleSummary(latestAttempt),
            latestAttempt.attemptNumber,
          );
        }
        task.turnsUsed = 0;
        task.status = "pending";
        task.blockedReason = undefined;
        task.blockedQuestion = undefined;
        task.failedDetail = undefined;
        await new Promise((r) => setTimeout(r, retryDelayMs));
        continue;
      }
      break;
    }

    // Commit task changes
    if (gitCheckpointConfig?.enabled && session.taskCheckpoints?.[task.id]) {
      const commitResult = finalizeTaskCheckpoint(workingDir, task.id, task.taskSummary);
      if (commitResult.success && commitResult.sha) {
        session.taskCheckpoints[task.id] = {
          ...session.taskCheckpoints[task.id]!,
          afterCommit: commitResult.sha,
        };
        onProgress?.(`  [git] Task commit ${commitResult.sha.slice(0, 7)}`);
      } else if (!commitResult.success) {
        onProgress?.(`  [git] Task commit failed: ${commitResult.error}`);
      }
    }

    if (latestResult?.status === "ralph") {
      const ralphCount = (session.stepRalphCounts[task.id] ?? 0) + 1;
      session.stepRalphCounts[task.id] = ralphCount;
      const ralphBundles = loadAttemptBundles(workerDir);
      const ralphHistory = buildRalphHistorySummary(task.id, ralphBundles);

      if (ralphCount >= maxRalphAttempts) {
        const question = [
          `Task ${task.id} reached the ralph limit (${ralphCount}/${maxRalphAttempts}).`,
          ralphHistory,
        ].join("\n\n");
        task.status = "blocked";
        task.blockedReason = "task_failed";
        task.blockedQuestion = question;
        task.failedDetail = {
          whatTried: ralphHistory,
          errorType: "ralph_limit_reached",
          suggestedNext:
            "Review the ralph history and provide guidance or constraints for a new strategy.",
          needsRevert: false,
        };
      } else {
        const reset = resetToTaskBaseSha(workingDir, session.taskCheckpoints?.[task.id]?.baseSha);
        if (!reset.success) {
          task.status = "blocked";
          task.blockedReason = "task_failed";
          task.blockedQuestion = `Ralph reset failed: ${reset.error}`;
          task.failedDetail = {
            whatTried: ralphHistory,
            errorType: "ralph_reset_failed",
            suggestedNext: "Fix git checkpoint state and retry the task.",
            needsRevert: false,
          };
        } else if (task.ralphDetail) {
          appendRalphContext(runId, task.id, ralphCount, task.ralphDetail);
          appendGoalWorkingEntry(
            runId,
            task.id,
            "ralph",
            [
              `Attempt ${ralphCount}/${maxRalphAttempts}`,
              `Approach tried: ${task.ralphDetail.approachTried}`,
              `Key insight: ${task.ralphDetail.keyInsight}`,
              `Suggested approach: ${task.ralphDetail.suggestedApproach}`,
            ].join("\n"),
          );
          task.status = "pending";
          task.blockedReason = undefined;
          task.blockedQuestion = undefined;
          task.failedDetail = undefined;
          task.taskSummary = undefined;
        }
      }
    }

    const gateCommands = plan.buildGate?.commands?.map((cmd) => cmd.trim()).filter(Boolean) ?? [];
    if (
      task.status === "done" &&
      plan.buildGate?.runBetweenSteps === true &&
      gateCommands.length > 0
    ) {
      const gateResult = runBuildGateCommands(gateCommands, workingDir);
      const timestamp = new Date().toISOString();
      if (gateResult.passed) {
        session.buildGateResults[task.id] = { passed: true, timestamp };
        buildGateFixCounts.delete(task.id);
        persistBuildGateFixCounts();
      } else {
        session.buildGateResults[task.id] = {
          passed: false,
          failedCommand: gateResult.failedCommand,
          output: gateResult.output,
          timestamp,
        };

        const fixCount = (buildGateFixCounts.get(task.id) ?? 0) + 1;
        buildGateFixCounts.set(task.id, fixCount);
        persistBuildGateFixCounts();

        if (fixCount > DEFAULT_MAX_BUILD_GATE_FIX_CYCLES) {
          const detail = makeBuildGateFailurePrompt(gateResult.failedCommand, gateResult.output);
          task.status = "blocked";
          task.blockedReason = "task_failed";
          task.blockedQuestion = `Build gate failed after ${DEFAULT_MAX_BUILD_GATE_FIX_CYCLES} retry cycles.\n${detail}`;
          task.failedDetail = {
            whatTried: detail,
            errorType: "build_gate_failed",
            suggestedNext:
              "Review the build-gate output and provide guidance for the next attempt.",
            needsRevert: false,
          };
        } else {
          const reset = resetToTaskBaseSha(workingDir, session.taskCheckpoints?.[task.id]?.baseSha);
          if (!reset.success) {
            task.status = "blocked";
            task.blockedReason = "task_failed";
            task.blockedQuestion = `Build gate reset failed: ${reset.error}`;
            task.failedDetail = {
              whatTried: gateResult.output,
              errorType: "build_gate_reset_failed",
              suggestedNext: "Fix git checkpoint state and retry the task.",
              needsRevert: false,
            };
          } else {
            const outputForRetry = makeBuildGateFailurePrompt(
              gateResult.failedCommand,
              gateResult.output,
            );
            const attemptNumber = (loadAttemptBundles(workerDir).at(-1)?.attemptNumber ?? 0) + 1;
            const syntheticBundle: AttemptBundle = {
              attemptNumber,
              backend,
              outcome: "failed",
              errorClassification: "build_gate_failure",
              durationMs: 0,
              buildGateFailure: {
                failedCommand: gateResult.failedCommand,
                output: outputForRetry,
              },
              logExcerpt: truncateForPrompt(outputForRetry),
            };
            writeAttemptBundle(workerDir, syntheticBundle);
            appendRetryContext(
              runId,
              task.id,
              formatAttemptBundleSummary(syntheticBundle),
              syntheticBundle.attemptNumber,
            );
            appendGoalWorkingEntry(
              runId,
              task.id,
              "build-gate",
              `Build gate failed (${fixCount}/${DEFAULT_MAX_BUILD_GATE_FIX_CYCLES}) on ${gateResult.failedCommand}. Retrying after reset.`,
            );
            task.status = "pending";
            task.blockedReason = undefined;
            task.blockedQuestion = undefined;
            task.failedDetail = undefined;
            task.taskSummary = undefined;
          }
        }
      }
    }

    if (task.status === "pending") {
      lastExecutedId = task.id;
      continue;
    }

    recordTaskResult(session, task, taskStartMs, onTaskUpdate);
    lastExecutedId = task.id;

    const status: PlanStep["status"] = task.status;

    if (status === "done") {
      appendGoalWorkingEntry(runId, task.id, "done", task.taskSummary ?? "Completed.");
    } else if (task.blockedReason === "task_failed") {
      appendGoalWorkingEntry(
        runId,
        task.id,
        "failed",
        task.failedDetail?.whatTried ?? task.blockedQuestion ?? "Failed.",
      );
    }

    if (task.blockedReason && FATAL_ERRORS.includes(task.blockedReason)) {
      globalBlock = {
        kind: task.blockedReason ?? "other",
        message: task.blockedQuestion ?? "Execution blocked.",
      };
      stopAllTasks = true;
      session.lastError = task.blockedQuestion ?? session.lastError;
    }

    const hasRunnable =
      findRunnableTasks(orderedSteps, session.answers, retryableBlockedIds).length > 0;
    if (task.blockedReason && !previouslyBlockedIds.has(task.id) && onStatusChange && hasRunnable) {
      previouslyBlockedIds.add(task.id);
      await onStatusChange({
        type: "step_blocked",
        stepId: task.id,
        question: task.blockedQuestion ?? "Unknown",
        steps: [...orderedSteps],
      });
    }

    if (stopAllTasks && globalBlock && !globalBlockApplied) {
      for (const step of orderedSteps) {
        if (step.status !== "pending") continue;
        const depsReady = step.dependsOn.every((depId) => {
          const dep = orderedSteps.find((s) => s.id === depId);
          return dep?.status === "done";
        });
        if (!depsReady) continue;
        step.status = "blocked";
        step.blockedReason = globalBlock.kind;
        step.blockedQuestion = globalBlock.message;
      }
      globalBlockApplied = true;
    }

    if (stopAllTasks) break;
  }

  const finalGateCommands =
    plan.buildGate?.commands?.map((cmd) => cmd.trim()).filter(Boolean) ?? [];
  if (orderedSteps.every((s) => s.status === "done") && finalGateCommands.length > 0) {
    const finalGateResult = runBuildGateCommands(finalGateCommands, workingDir);
    const timestamp = new Date().toISOString();
    if (finalGateResult.passed) {
      session.buildGateResults["__final__"] = { passed: true, timestamp };
    } else {
      session.buildGateResults["__final__"] = {
        passed: false,
        failedCommand: finalGateResult.failedCommand,
        output: finalGateResult.output,
        timestamp,
      };

      const fallbackStep = orderedSteps.at(-1);
      const targetStep =
        (lastExecutedId ? orderedSteps.find((step) => step.id === lastExecutedId) : undefined) ??
        fallbackStep;

      if (targetStep) {
        const detail = makeBuildGateFailurePrompt(
          finalGateResult.failedCommand,
          finalGateResult.output,
        );
        targetStep.status = "blocked";
        targetStep.blockedReason = "task_failed";
        targetStep.blockedQuestion = `Final build gate failed.\n${detail}`;
        targetStep.failedDetail = {
          whatTried: detail,
          errorType: "build_gate_failed",
          suggestedNext: "Fix the build-gate failures and retry the goal step.",
          needsRevert: false,
        };
        appendGoalWorkingEntry(
          runId,
          targetStep.id,
          "failed",
          `Final build gate failed on ${finalGateResult.failedCommand}.`,
        );
        recordTaskResult(session, targetStep, Date.now(), onTaskUpdate);
      }
    }
  }

  const allDone = orderedSteps.every((s) => s.status === "done");
  if (allDone) {
    session.state = "done";
    let postExecutionReviewNote: string | undefined;
    const shouldRunPostExecutionReview = plan.buildGate?.postExecutionReview !== false;
    const reviewBaseSha = resolvePostExecutionReviewBaseSha(plan.steps, session.taskCheckpoints);

    if (!shouldRunPostExecutionReview) {
      postExecutionReviewNote =
        "Post-execution review skipped: disabled by buildGate.postExecutionReview.";
    } else if (!reviewBaseSha) {
      postExecutionReviewNote = "Post-execution review skipped: no base SHA available.";
    } else {
      let reviewDiff: string | undefined;
      try {
        reviewDiff = execFileSync("git", ["-C", workingDir, "diff", `${reviewBaseSha}...HEAD`], {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          timeout: 15_000,
        });
      } catch (error) {
        postExecutionReviewNote = `Post-execution review skipped: failed to collect diff (${truncateSingleLine(formatExecError(error))}).`;
      }

      if (reviewDiff !== undefined) {
        onProgress?.("  [review] Running post-execution code review...");
        const initialReview = await runPostExecutionReview({
          goal: session.goal,
          steps: orderedSteps,
          diff: reviewDiff,
          workingDir,
          claudeCodeAuth,
          abortSignal: effectiveAbort,
        });

        if (initialReview.status === "error") {
          postExecutionReviewNote = `Post-execution review skipped: ${initialReview.reason}.`;
        } else if (initialReview.status === "approved") {
          postExecutionReviewNote = "Approved.";
        } else {
          const actionableIssues = initialReview.issues;
          if (actionableIssues.length === 0) {
            postExecutionReviewNote =
              "Issues found, but reviewer did not provide actionable issue details.";
          } else {
            onProgress?.(
              `  [review] Found ${actionableIssues.length} issue${actionableIssues.length === 1 ? "" : "s"}; running system-polish step.`,
            );

            const dependsOn = orderedSteps
              .filter((step) => step.status === "done")
              .map((step) => step.id);
            const polishDescription = [
              "Address post-execution review issues:",
              ...actionableIssues.map((issue, index) => `${index + 1}. ${issue}`),
            ].join("\n");
            const existingPolishStep = plan.steps.find((step) => step.id === "system-polish");
            const polishStep: PlanStep =
              existingPolishStep ??
              ({
                id: "system-polish",
                description: polishDescription,
                shortSummary: "Apply review polish",
                dependsOn,
                successCriteria: "All review issues addressed",
                constraints: ["No ralph; address the review issues directly in this attempt."],
                status: "pending",
                durationMinutes: 20,
              } satisfies PlanStep);
            if (!existingPolishStep) {
              plan.steps.push(polishStep);
            } else {
              existingPolishStep.description = polishDescription;
              existingPolishStep.shortSummary = "Apply review polish";
              existingPolishStep.dependsOn = dependsOn;
              existingPolishStep.successCriteria = "All review issues addressed";
              existingPolishStep.constraints = [
                "No ralph; address the review issues directly in this attempt.",
              ];
              existingPolishStep.status = "pending";
              existingPolishStep.turnsUsed = 0;
              existingPolishStep.taskSummary = undefined;
              existingPolishStep.blockedReason = undefined;
              existingPolishStep.blockedQuestion = undefined;
              existingPolishStep.failedDetail = undefined;
              existingPolishStep.ralphDetail = undefined;
            }

            const polishBackend = clampBackendForEnabledWorkers(
              resolveBackendForStep(polishStep, backendOverride, defaultBackend),
              resolvedEnabledWorkers,
            );
            if (polishStep.executedBackend !== polishBackend) {
              polishStep.executedBackend = polishBackend;
            }
            const polishRunner = polishBackend === "pi" ? piRunner : cliRunners[polishBackend];
            let polishAttempted = false;
            if (!polishRunner) {
              postExecutionReviewNote =
                "Issues found. System polish skipped because no compatible backend was available.";
            } else {
              polishAttempted = true;
              const polishStartMs = Date.now();
              const polishWorkerDir = resolveWorkerDir(runId, polishStep.id);
              const completedSummaries = orderedSteps
                .filter((step) => step.status === "done" && step.taskSummary)
                .map((step) => ({ id: step.id, summary: step.taskSummary! }));
              const polishContext: TaskRunnerContext = {
                task: polishStep,
                plan,
                goal: session.goal,
                workingDir,
                runId,
                denyPolicy: HARD_DENIES,
                completedSummaries,
                attemptBundles: loadAttemptBundles(polishWorkerDir),
                onProgress,
                abortSignal: effectiveAbort,
                timeoutMs: resolveTaskTimeoutMs(polishStep.durationMinutes, timeoutMs),
              };

              polishStep.status = "in_progress";
              onTaskStart?.(polishStep.id);
              onProgress?.(
                `\n--- Task ${polishStep.id} [${polishBackend}]: ${polishStep.description} ---`,
              );
              const polishResult = await polishRunner.execute(polishContext);
              let polishCompleted = false;
              let polishTaskFailed = false;
              if (polishResult.status === "ralph") {
                polishStep.turnsUsed = polishResult.turnsUsed;
                polishStep.status = "blocked";
                polishStep.blockedReason = "task_failed";
                polishStep.blockedQuestion =
                  "system-polish returned ralph, and additional polish cycles are disabled.";
                polishStep.failedDetail = {
                  whatTried:
                    polishResult.ralphDetail?.approachTried ?? "system-polish returned ralph.",
                  errorType: "system_polish_ralph",
                  suggestedNext: "Proceeding without additional polish attempts.",
                  needsRevert: false,
                };
                polishStep.taskSummary = undefined;
                polishStep.ralphDetail = undefined;
                onProgress?.(
                  "  [warn] system-polish returned ralph; continuing without additional polish cycles.",
                );
                polishTaskFailed = true;
              } else {
                applyTaskResult(polishStep, polishResult, onProgress);
                polishCompleted = polishResult.status === "complete";
                polishTaskFailed = polishStep.blockedReason === "task_failed";
              }
              recordTaskResult(session, polishStep, polishStartMs, onTaskUpdate);
              if (polishCompleted) {
                appendGoalWorkingEntry(
                  runId,
                  polishStep.id,
                  "done",
                  polishStep.taskSummary ?? "Completed.",
                );
              } else if (polishTaskFailed) {
                appendGoalWorkingEntry(
                  runId,
                  polishStep.id,
                  "failed",
                  polishStep.failedDetail?.whatTried ?? polishStep.blockedQuestion ?? "Failed.",
                );
              }

              let postPolishDiff = reviewDiff;
              try {
                postPolishDiff = execFileSync(
                  "git",
                  ["-C", workingDir, "diff", `${reviewBaseSha}...HEAD`],
                  {
                    encoding: "utf8",
                    maxBuffer: 64 * 1024 * 1024,
                    timeout: 15_000,
                  },
                );
              } catch (error) {
                onProgress?.(
                  `  [warn] Post-polish diff collection failed: ${truncateSingleLine(formatExecError(error))}`,
                );
              }

              const postPolishReview = await runPostExecutionReview({
                goal: session.goal,
                steps: orderedSteps,
                diff: postPolishDiff,
                workingDir,
                claudeCodeAuth,
                abortSignal: effectiveAbort,
              });
              if (postPolishReview.status === "approved") {
                postExecutionReviewNote = "Approved after system-polish.";
              } else {
                const remainingIssues =
                  postPolishReview.status === "rejected" && postPolishReview.issues.length > 0
                    ? postPolishReview.issues
                    : actionableIssues;
                const issueLines = remainingIssues.map((issue) => `- ${issue}`).join("\n");
                const suffix =
                  postPolishReview.status === "error"
                    ? `\nReview rerun failed after polish: ${postPolishReview.reason}.`
                    : "";
                postExecutionReviewNote = [
                  "Issues found after review.",
                  polishAttempted ? "System-polish executed once." : "",
                  "Remaining issues:",
                  issueLines,
                  suffix,
                ]
                  .filter(Boolean)
                  .join("\n");
              }
            }
          }
        }
      }
    }

    let prUrl: string | undefined;
    const githubPushConfig = config?.goal?.githubPush;
    if (gitCheckpointConfig?.enabled && githubPushConfig?.enabled) {
      let isPrivateRepo = false;
      try {
        isPrivateRepo = isRepoPrivate(workingDir);
      } catch (error) {
        onProgress?.(
          `  [warn] GitHub push skipped: failed to verify repository privacy (${formatExecError(error)})`,
        );
      }

      if (!isPrivateRepo) {
        onProgress?.("  [warn] GitHub push skipped: working repository is not private.");
      } else {
        const remote = githubPushConfig.remote ?? "origin";
        const pushResult = pushRunBranch(workingDir, runId, remote, runBranchName);
        if (!pushResult.success) {
          onProgress?.(`  [warn] GitHub push failed: ${pushResult.error}`);
        } else {
          onProgress?.(`  [git] Run branch pushed to ${remote} (${pushResult.sha.slice(0, 7)})`);
          if (githubPushConfig.createPr ?? true) {
            const baseBranch = githubPushConfig.baseBranch ?? "main";
            const pullRequestResult = createRunPullRequest(
              workingDir,
              runId,
              session.goal,
              baseBranch,
              runBranchName,
            );
            if (pullRequestResult.ok) {
              prUrl = pullRequestResult.prUrl;
              onProgress?.(`  [git] Pull request created: ${pullRequestResult.prUrl}`);
            } else {
              onProgress?.(`  [warn] GitHub PR creation failed: ${pullRequestResult.error}`);
            }
          }
        }
      }
    }

    try {
      const existingLessons = getLessonsForContext(workingDir);
      const extractedLessons = await extractRunLessons(runId, workingDir, existingLessons);
      if (extractedLessons.length > 0) {
        onProgress?.(
          `  [lessons] Recorded ${extractedLessons.length} lesson${extractedLessons.length === 1 ? "" : "s"}.`,
        );
      }
    } catch {
      // Fail-open: lesson extraction should never block completion.
    }

    let manualTests: ManualTestSuggestion[] | undefined;
    let manualTestsError: string | undefined;
    try {
      manualTests = await generateManualTests({
        goal: session.goal,
        steps: orderedSteps,
        client: params.manualTestsClient,
      });
    } catch (err) {
      // Fail-open: completion should still emit even when manual test generation fails.
      manualTests = undefined;
      manualTestsError = err instanceof Error ? err.message : String(err);
    }
    const baseSummary = buildGoalSummary({
      goal: session.goal,
      goalHeadline: plan.shortSummary,
      runId,
      steps: orderedSteps,
      maxTurnsPerTask,
      manualTests,
      channel: params.channel,
    });
    const summary = postExecutionReviewNote
      ? `${baseSummary}\n\n**Post-Execution Review**\n${postExecutionReviewNote}`
      : baseSummary;
    if (onStatusChange) {
      await onStatusChange({
        type: "all_done",
        steps: [...orderedSteps],
        summary,
        ...(prUrl ? { prUrl } : {}),
        ...(manualTests !== undefined ? { manualTests } : {}),
        ...(manualTestsError ? { manualTestsError } : {}),
      });
    }
    return { status: "done", summary };
  }

  const aggregated =
    aggregateBlockedDetails(orderedSteps) ??
    ({ blockedAt: "execution", prompt: "All tasks completed.", requiredInputKey: "none" } as const);
  session.state = "blocked";
  session.blocked = aggregated;
  if (onStatusChange) {
    await onStatusChange({ type: "fully_blocked", steps: [...orderedSteps] });
  }
  return {
    status: "blocked",
    question: aggregated.prompt,
    requiredInputKey: aggregated.requiredInputKey,
    blockedAt: aggregated.blockedAt,
  };
}

function resolveBackendForStep(
  step: PlanStep,
  override: GoalBackendId | undefined,
  fallback: GoalBackendId,
): GoalBackendId {
  if (override) return override;
  if (step.executedBackend) return step.executedBackend;
  if (step.backend) return step.backend;
  return fallback;
}

function clampBackendForEnabledWorkers(
  backend: GoalBackendId,
  enabledWorkers: CliWorkerId[],
): GoalBackendId {
  if (backend === "pi") return backend;
  if (enabledWorkers.includes(backend)) return backend;
  return enabledWorkers.length === 1 ? enabledWorkers[0]! : backend;
}

function applyTaskResult(
  task: PlanStep,
  result: TaskRunnerResult,
  onProgress?: (text: string) => void,
): void {
  task.turnsUsed = result.turnsUsed;
  if (result.status === "complete") {
    task.status = "done";
    task.taskSummary = result.summary;
    task.ralphDetail = undefined;
    onProgress?.(`  [done] ${result.summary ?? "completed"}`);
    return;
  }

  if (result.status === "failed") {
    task.status = "blocked";
    task.blockedReason = "task_failed";
    task.blockedQuestion = result.question ?? "Task failed.";
    task.failedDetail = result.failedDetail;
    task.ralphDetail = undefined;
    onProgress?.(`  [failed] ${task.blockedQuestion}`);
    return;
  }

  if (result.status === "ralph") {
    task.status = "pending";
    task.ralphDetail = result.ralphDetail;
    task.blockedReason = undefined;
    task.blockedQuestion = undefined;
    task.failedDetail = undefined;
    task.taskSummary = undefined;
    return;
  }

  task.status = "blocked";
  task.blockedReason = result.blockedReason ?? "other";
  task.blockedQuestion = result.question ?? "Task blocked.";
  task.ralphDetail = undefined;
  onProgress?.(`  [blocked] ${task.blockedQuestion}`);
}

function shouldRetry(result: TaskRunnerResult, backend: GoalBackendId, workerDir: string): boolean {
  if (backend === "pi") {
    return result.status === "blocked" && PI_RETRYABLE.includes(result.blockedReason ?? "other");
  }

  const attempts = loadAttemptBundles(workerDir);
  const latest = attempts.at(-1);
  if (!latest) return false;
  return (
    latest.outcome === "timeout" || latest.outcome === "crash" || latest.outcome === "rate_limit"
  );
}

function recordTaskResult(
  session: GoalSession,
  task: PlanStep,
  taskStartMs: number,
  onTaskUpdate?: (result: TaskExecutionResult) => void,
): void {
  const elapsedMs = Math.max(0, Date.now() - taskStartMs);
  const previous = session.stepResults.get(task.id);
  const durationMs = normalizeDurationMs(previous?.durationMs) + elapsedMs;
  session.stepResults.set(task.id, {
    stepId: task.id,
    success: task.status === "done",
    output: task.taskSummary ?? "",
    error: task.status !== "done" ? (task.blockedQuestion ?? "Task did not complete.") : undefined,
    durationMs,
  });

  const result: TaskExecutionResult = {
    taskId: task.id,
    turnsUsed: task.turnsUsed ?? 0,
    durationMs,
    outcome:
      task.status === "done"
        ? "done"
        : task.blockedReason === "task_failed"
          ? "task_failed"
          : "blocked",
    summary: task.taskSummary,
    blockedQuestion: task.blockedQuestion,
    blockedReason: task.blockedReason,
  };
  onTaskUpdate?.(result);
}

function normalizeDurationMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

function hasAnswerForTask(taskId: string, answers: Record<string, string>): boolean {
  if (answers[`task:${taskId}:input`] != null) return true;
  for (const key of Object.keys(answers)) {
    const match = /^tasks:([^:]+):input$/.exec(key);
    if (match && match[1]!.split(",").includes(taskId)) return true;
  }
  return false;
}

function getAnswerForTask(taskId: string, answers: Record<string, string>): string | undefined {
  const direct = answers[`task:${taskId}:input`];
  if (direct != null) return direct;
  for (const [key, value] of Object.entries(answers)) {
    const match = /^tasks:([^:]+):input$/.exec(key);
    if (match && match[1]!.split(",").includes(taskId)) return value;
  }
  return undefined;
}

function consumeAnswerForTask(taskId: string, answers: Record<string, string>): void {
  const directKey = `task:${taskId}:input`;
  if (answers[directKey]) delete answers[directKey];

  for (const key of Object.keys(answers)) {
    const match = /^tasks:([^:]+):input$/.exec(key);
    if (!match) continue;
    if (!match[1]!.split(",").includes(taskId)) continue;

    const remaining = match[1]!
      .split(",")
      .filter((id) => id !== taskId)
      .map((id) => id.trim())
      .filter(Boolean);

    const value = answers[key]!;
    delete answers[key];
    if (remaining.length === 0) continue;
    const newKey =
      remaining.length === 1 ? `task:${remaining[0]}:input` : `tasks:${remaining.join(",")}:input`;
    answers[newKey] = value;
  }
}

function findRunnableTasks(
  steps: PlanStep[],
  answers?: Record<string, string>,
  retryableBlockedIds?: Set<string>,
): PlanStep[] {
  return steps.filter((step) => {
    const depsReady = step.dependsOn.every((depId) => {
      const dep = steps.find((s) => s.id === depId);
      return dep?.status === "done";
    });
    if (!depsReady) return false;
    if (step.status === "pending") return true;
    if (step.status === "blocked") {
      if (answers && hasAnswerForTask(step.id, answers)) return true;
      return Boolean(retryableBlockedIds?.has(step.id));
    }
    return false;
  });
}

function buildGoalSummary(params: {
  goal: string;
  goalHeadline?: string;
  runId: string;
  steps: PlanStep[];
  maxTurnsPerTask?: number;
  manualTests?: ManualTestSuggestion[];
  channel?: GoalOutputChannel;
}): string {
  const summary = formatCompactGoalCompletionSummary({
    title: params.goalHeadline?.trim() || params.goal,
    steps: params.steps.map((step) => ({
      id: step.id,
      description: step.description,
      summary: step.taskSummary,
      status: step.status,
      turnsUsed: step.turnsUsed,
    })),
    attemptsTotal: params.maxTurnsPerTask,
    resolveStepAttemptsUsed: (stepId) =>
      loadAttemptBundles(resolveWorkerDir(params.runId, stepId)).length,
    manualTests: params.manualTests,
    channel: params.channel ?? "cli",
  }).text;
  return `${summary.trimEnd()}\n**Goal ID:** ${params.runId.slice(0, 8)}`;
}

function buildSuccessorMap(steps: PlanStep[]): Map<string, Set<string>> {
  const successors = new Map<string, Set<string>>();
  for (const step of steps) {
    successors.set(step.id, new Set());
  }
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      const list = successors.get(dep);
      if (list) list.add(step.id);
    }
  }
  return successors;
}

function pickNextTask(
  runnable: PlanStep[],
  scores: CriticalPathScores,
  orderIndex: Map<string, number>,
  successors: Map<string, Set<string>>,
  lastExecutedId: string | null,
): PlanStep {
  if (runnable.length <= 1) return runnable[0]!;

  let maxScore = Number.NEGATIVE_INFINITY;
  for (const step of runnable) {
    const score = scores.get(step.id) ?? 0;
    if (score > maxScore) maxScore = score;
  }

  let candidates = runnable.filter((step) => (scores.get(step.id) ?? 0) === maxScore);
  if (lastExecutedId) {
    const successorSet = successors.get(lastExecutedId);
    if (successorSet && successorSet.size > 0) {
      const successorCandidates = candidates.filter((step) => successorSet.has(step.id));
      if (successorCandidates.length > 0) candidates = successorCandidates;
    }
  }

  candidates.sort((a, b) => {
    return (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0);
  });

  return candidates[0]!;
}
