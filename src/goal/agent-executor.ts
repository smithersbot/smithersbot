import fs from "node:fs";
import path from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  createCodingTools,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";

import { resolveMoltbotAgentDir } from "../agents/agent-paths.js";
import { ensureMoltbotModelsJson } from "../agents/models-config.js";
import { resolveEnvApiKey } from "../agents/model-auth.js";
import type { MoltbotConfig } from "../config/config.js";
import { createGoalTools, createTurnTracker, type TurnTracker } from "./goal-tools.js";
import {
  createCheckpoint,
  isGitRepo,
  isWorkingTreeClean,
  resetToCheckpoint,
  type GitCheckpoint,
} from "./git-checkpoint.js";
import { formatPlanAsContext } from "./planner.js";
import {
  resolveAgentTaskSessionFile,
  resolveWorkingFile,
  resolveGoalWorkingFile,
} from "./run-store.js";
import { resolveScoutDir } from "./scout.js";
import {
  computeCriticalPathScores,
  orderStepsCriticalPathFirst,
  type CriticalPathScores,
} from "./plan-order.js";
import { aggregateBlockedDetails } from "./blocked.js";
import type {
  GitCheckpointConfig,
  GoalOutcome,
  GoalSession,
  Plan,
  PlanStep,
  RetryConfig,
  TaskExecutionResult,
} from "./types.js";

const DEFAULT_MAX_TURNS_PER_TASK = 5;
const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes per prompt (fallback when step has no durationMinutes)
const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL_ID = "claude-sonnet-4-20250514";

const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 1000;

// Conservative: only clearly transient errors
const RETRYABLE_REASONS: PlanStep["blockedReason"][] = ["timeout", "network", "rate_limit"];

function isRetryable(reason: PlanStep["blockedReason"]): boolean {
  return reason != null && RETRYABLE_REASONS.includes(reason);
}

// --- Executor error classification ---
type ExecutorErrorKind = "rate_limit" | "out_of_credits" | "auth" | "network" | "timeout" | "other";

const RATE_LIMIT_RE = /rate.?limit|429|too many requests|overloaded/i;
const CREDITS_RE = /credit|balance|billing|insufficient.*funds|payment|quota.*exceeded/i;
const AUTH_RE = /401|403|unauthorized|forbidden|invalid.*key|authentication/i;
const NETWORK_RE =
  /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|socket hang up|EAI_AGAIN/i;

/** Errors that should stop the entire goal, not just the current task. */
const FATAL_ERRORS: ExecutorErrorKind[] = ["out_of_credits", "auth"];

function classifyExecutorError(errMsg: string): ExecutorErrorKind {
  if (RATE_LIMIT_RE.test(errMsg)) return "rate_limit";
  if (CREDITS_RE.test(errMsg)) return "out_of_credits";
  if (AUTH_RE.test(errMsg)) return "auth";
  if (NETWORK_RE.test(errMsg)) return "network";
  if (/abort|timeout/i.test(errMsg)) return "timeout";
  return "other";
}

function formatExecutorError(
  kind: ExecutorErrorKind,
  rawMsg: string,
  requestId?: string,
  providerId?: string,
  modelId?: string,
): string {
  const suffix = requestId ? ` (request_id: ${requestId})` : "";
  const providerLabel = providerId ? ` for ${providerId}` : "";
  const modelLabel = modelId ? ` (${modelId})` : "";
  switch (kind) {
    case "out_of_credits":
      return `Out of API credits${providerLabel}${modelLabel}. Add credits to your account and resume with /goal_resume.${suffix}`;
    case "auth":
      return `API authentication failed${providerLabel}${modelLabel}. Check your API key configuration.${suffix}`;
    case "rate_limit":
      return `Rate limited by API${providerLabel}${modelLabel}. Wait a few minutes and resume with /goal_resume.${suffix}`;
    case "network":
      return `Network error reaching API. Check your connection and resume with /goal_resume.${suffix}`;
    case "timeout":
      return "Task timed out during execution.";
    default:
      return `Agent error: ${rawMsg}${suffix}`;
  }
}

/** Extract request_id from error if present (providers often include it). */
function extractRequestId(err: unknown): string | undefined {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e.request_id === "string") return e.request_id;
    if (typeof e.requestId === "string") return e.requestId;
  }
  // Try to extract from error message: "request_id: abc123" or similar
  const msg = err instanceof Error ? err.message : String(err);
  const match = /request[_-]?id[:\s]+([a-zA-Z0-9_-]+)/i.exec(msg);
  return match?.[1];
}

type AssistantErrorInfo = {
  message: string;
  requestId?: string;
};

function getLastAssistantError(session: { messages?: unknown[] }): AssistantErrorInfo | null {
  const messages = session.messages;
  if (!Array.isArray(messages)) return null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    const record = msg as Record<string, unknown>;
    if (record.role !== "assistant") continue;

    const stopReason = typeof record.stopReason === "string" ? record.stopReason : undefined;
    if (stopReason !== "error" && stopReason !== "aborted") return null;

    const errorMessage = typeof record.errorMessage === "string" ? record.errorMessage : "";
    return {
      message: errorMessage || "Unknown error",
      requestId: extractRequestId(msg),
    };
  }

  return null;
}

export type GoalStatusChangeEvent =
  | { type: "step_blocked"; stepId: string; question: string; steps: PlanStep[] }
  | { type: "fully_blocked"; steps: PlanStep[] }
  | { type: "all_done"; steps: PlanStep[]; summary: string };

export type ExecuteGoalParams = {
  session: GoalSession;
  runId: string;
  workingDir: string;
  config?: MoltbotConfig;
  provider?: string;
  model?: string;
  maxTurnsPerTask?: number;
  timeoutMs?: number;
  retryConfig?: Partial<RetryConfig>;
  gitCheckpointConfig?: Partial<GitCheckpointConfig>;
  onTaskUpdate?: (result: TaskExecutionResult) => void;
  onProgress?: (text: string) => void;
  onStatusChange?: (event: GoalStatusChangeEvent) => void | Promise<void>;
  abortSignal?: AbortSignal;
};

/** Load a scout node spec file for a given step. Returns null if not found. */
function loadNodeSpec(runId: string, stepId: string): string | null {
  try {
    const specPath = path.join(resolveScoutDir(runId), "node_specs", `${stepId}.md`);
    return fs.readFileSync(specPath, "utf8");
  } catch {
    return null;
  }
}

/** Load working notes for a given step. Returns null if not found or empty. */
function loadWorkingNotes(runId: string, stepId: string): string | null {
  try {
    const notesPath = resolveWorkingFile(runId, stepId);
    const content = fs.readFileSync(notesPath, "utf8").trim();
    return content || null;
  } catch {
    return null;
  }
}

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

/** Auto-generate working notes when the agent skips update_working_notes. */
function autoGenerateWorkingNotes(
  runId: string,
  stepId: string,
  attempt: number,
  turnNumber: number,
  tracker: TurnTracker,
  errorInfo?: string,
): void {
  try {
    const filePath = resolveWorkingFile(runId, stepId);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const tools = [...new Set(tracker.toolCalls)];
    const lines = [
      `\n## Auto-note Attempt ${attempt} Turn ${turnNumber} (${new Date().toISOString()})\n`,
      `Tools: ${tools.length ? tools.join(", ") : "none"}`,
      errorInfo ? `Error: ${errorInfo}` : null,
      ``,
      `Next attempt must change strategy.`,
      `StrategyChange: <to be filled by agent>`,
    ].filter(Boolean);

    fs.appendFileSync(filePath, lines.join("\n") + "\n", "utf8");
  } catch {
    // Best-effort
  }
}

/** Append retry context to working notes when an attempt fails with a retryable error. */
function appendRetryContext(
  runId: string,
  stepId: string,
  attempt: number,
  reason: string,
  detail: string,
): void {
  try {
    const filePath = resolveWorkingFile(runId, stepId);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const content = [
      `\n## Attempt #${attempt} FAILED (${new Date().toISOString()})\n`,
      `**Reason:** ${reason}`,
      `**Detail:** ${detail}`,
      ``,
      `DO NOT repeat the same approach. Try a different strategy.`,
      `StrategyChange: <describe what will be different>`,
    ].join("\n");
    fs.appendFileSync(filePath, content + "\n", "utf8");
  } catch {
    // Best-effort
  }
}

/** Build the goal-level system prompt, optionally including completed task summaries. */
function buildGoalSystemPrompt(
  goal: string,
  plan: Plan | null,
  completedSummaries?: Array<{ id: string; summary: string }>,
): string {
  const lines: string[] = [];
  lines.push("You are executing tasks for a goal. You will receive tasks one at a time.");
  lines.push("For each task, use your tools (read, write, edit, bash) to complete it.");
  lines.push("");
  lines.push(`GOAL: ${goal}`);
  if (plan) {
    lines.push("");
    lines.push("FULL PLAN (for context — you will work on tasks one at a time):");
    lines.push(formatPlanAsContext(plan));
  }
  if (completedSummaries && completedSummaries.length > 0) {
    lines.push("");
    lines.push("COMPLETED TASKS:");
    for (const { id, summary } of completedSummaries) {
      lines.push(`- ${id}: ${summary}`);
    }
  }
  lines.push("");
  lines.push("TASK MANAGEMENT TOOLS:");
  lines.push("- mark_task_complete(summary): Call when done with the current task.");
  lines.push(
    "- mark_task_failed(reason, whatTried, errorType, suggestedNext, needsRevert): " +
      "Call when you have genuinely tried and cannot complete the task. Provide what you tried and what went wrong.",
  );
  lines.push("- request_user_input(question): Call ONLY when genuinely stuck and need the user.");
  lines.push("- delete_path(path, recursive?): Delete a file or directory within the workspace.");
  lines.push(
    "- update_working_notes(notes): Record what you've tried and learned. Persists across retries.",
  );
  lines.push("");
  lines.push("RULES:");
  lines.push("- Focus exclusively on the current task you are given.");
  lines.push("- Debug and fix errors yourself. Only call request_user_input as a last resort.");
  lines.push("- Always call mark_task_complete with a brief summary when a task is done.");
  lines.push(
    "- When you encounter difficulty: write working notes capturing what failed, " +
      "key hypotheses tried, and the unblocker or next step.",
  );
  lines.push(
    "- When you complete a task: write a brief completion note (3–6 bullets max) " +
      "covering what changed, what verification ran, and any follow-ups.",
  );
  lines.push("- If you didn't struggle, keep the completion note minimal.");
  return lines.join("\n");
}

/** Build the prompt for the first turn of a task. */
function buildFirstTaskPrompt(
  task: PlanStep,
  totalTasks: number,
  opts?: { nodeSpec?: string | null; workingNotes?: string | null },
): string {
  const lines: string[] = [];
  lines.push(`Work on this task: ${task.description}`);
  lines.push("");
  lines.push(`Task ${task.id} of ${totalTasks}.`);
  if (task.dependsOn.length > 0) {
    lines.push(`Dependencies completed: ${task.dependsOn.join(", ")}.`);
  }
  if (opts?.nodeSpec) {
    lines.push("");
    lines.push("NODE SPEC (from scout analysis):");
    lines.push(opts.nodeSpec);
  }
  if (opts?.workingNotes) {
    lines.push("");
    lines.push("WORKING NOTES (from previous attempts):");
    lines.push(opts.workingNotes);
    lines.push("");
    lines.push("Do NOT repeat approaches that already failed.");
  }
  lines.push("");
  lines.push(
    "When you have completed this task, call the mark_task_complete tool with a brief summary.",
  );
  lines.push(
    "If you are stuck and need information from the user, call request_user_input with your question.",
  );
  return lines.join("\n");
}

/** Build the prompt for subsequent turns of a task. */
function buildContinuePrompt(task: PlanStep, turnsUsed: number, maxTurns: number): string {
  const remaining = maxTurns - turnsUsed;
  const lines: string[] = [];
  lines.push(`Continue working on task ${task.id}: ${task.description}`);
  lines.push("");
  lines.push(`You have used ${turnsUsed} of ${maxTurns} turns for this task.`);
  lines.push(`${remaining} turn(s) remaining. Focus on completing this task.`);
  lines.push("");
  lines.push("Remember to call mark_task_complete when done.");
  return lines.join("\n");
}

/** Build the prompt for resuming a previously-blocked task with the user's answer. */
function buildResumeTaskPrompt(
  task: PlanStep,
  totalTasks: number,
  answer: string,
  question?: string,
  opts?: { nodeSpec?: string | null; workingNotes?: string | null },
): string {
  const lines: string[] = [];
  lines.push(`Continue working on this task: ${task.description}`);
  lines.push("");
  lines.push(`Task ${task.id} of ${totalTasks}.`);
  if (opts?.nodeSpec) {
    lines.push("");
    lines.push("NODE SPEC (from scout analysis):");
    lines.push(opts.nodeSpec);
  }
  if (opts?.workingNotes) {
    lines.push("");
    lines.push("WORKING NOTES (from previous attempts):");
    lines.push(opts.workingNotes);
    lines.push("");
    lines.push("Do NOT repeat approaches that already failed.");
  }
  lines.push("");
  lines.push(`You previously asked the user: ${question ?? "a question"}`);
  lines.push(`The user answered: ${answer}`);
  lines.push("");
  lines.push("Use this information to continue and complete the task.");
  lines.push("");
  lines.push(
    "When you have completed this task, call the mark_task_complete tool with a brief summary.",
  );
  lines.push(
    "If you are stuck and need information from the user, call request_user_input with your question.",
  );
  return lines.join("\n");
}

/** Check if a blocked task has a matching answer in the session. */
function hasAnswerForTask(taskId: string, answers: Record<string, string>): boolean {
  // Direct single-task key
  if (answers[`task:${taskId}:input`] != null) return true;
  // Aggregated multi-task key (tasks:id1,id2,...:input)
  for (const key of Object.keys(answers)) {
    const match = /^tasks:([^:]+):input$/.exec(key);
    if (match && match[1]!.split(",").includes(taskId)) return true;
  }
  return false;
}

/** Get the answer text for a blocked task from the session answers. */
function getAnswerForTask(taskId: string, answers: Record<string, string>): string | undefined {
  const direct = answers[`task:${taskId}:input`];
  if (direct != null) return direct;
  for (const [key, value] of Object.entries(answers)) {
    const match = /^tasks:([^:]+):input$/.exec(key);
    if (match && match[1]!.split(",").includes(taskId)) return value;
  }
  return undefined;
}

/** Find tasks that are runnable: pending with all deps done, or blocked with an answer. */
function findRunnableTasks(steps: PlanStep[], answers?: Record<string, string>): PlanStep[] {
  return steps.filter((step) => {
    const depsReady = step.dependsOn.every((depId) => {
      const dep = steps.find((s) => s.id === depId);
      return dep?.status === "done";
    });
    if (!depsReady) return false;
    if (step.status === "pending") return true;
    // A blocked task is runnable if the user has provided an answer
    if (step.status === "blocked" && answers && hasAnswerForTask(step.id, answers)) return true;
    return false;
  });
}

/** Build a summary of all completed tasks. */
function buildGoalSummary(steps: PlanStep[]): string {
  const done = steps.filter((s) => s.status === "done");
  const blocked = steps.filter((s) => s.status === "blocked");
  const parts = [`${done.length}/${steps.length} tasks completed`];
  if (blocked.length > 0) parts.push(`${blocked.length} blocked`);
  const summaries = done.filter((s) => s.taskSummary).map((s) => `- ${s.id}: ${s.taskSummary}`);
  if (summaries.length > 0) {
    return `${parts.join(", ")}.\n\n${summaries.join("\n")}`;
  }
  return `${parts.join(", ")}.`;
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

/**
 * Pick the next task from runnable candidates using static critical-path scores.
 *
 * Policy:
 *   1. Prefer higher critical-path score (longer remaining path).
 *   2. When scores tie, prefer direct successors of the last executed task.
 *   3. Tie-break by original plan order.
 */
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

/**
 * Execute a goal's tasks using the PI coding agent.
 *
 * Walks plan steps in dependency order, giving each task up to
 * `maxTurnsPerTask` prompt cycles. Parks blocked tasks and moves
 * to the next. Notifies the user only when all runnable tasks are
 * exhausted (fully blocked or all done).
 */
export async function executeGoalWithAgent(params: ExecuteGoalParams): Promise<GoalOutcome> {
  const {
    session,
    runId,
    workingDir,
    config,
    maxTurnsPerTask = DEFAULT_MAX_TURNS_PER_TASK,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retryConfig,
    gitCheckpointConfig,
    onTaskUpdate,
    onProgress,
    onStatusChange,
    abortSignal,
  } = params;

  const plan = session.plan;
  if (!plan) throw new Error("No plan to execute");

  session.state = "executing";

  // --- Git dirty check: block immediately if working tree is dirty and checkpoints are enabled ---
  if (gitCheckpointConfig?.enabled && isGitRepo(workingDir) && !isWorkingTreeClean(workingDir)) {
    session.state = "blocked";
    const msg =
      "Git working tree has uncommitted changes. Commit or stash before running goal with git checkpoints.";
    session.blocked = { prompt: msg, requiredInputKey: "git_dirty" };
    onProgress?.(`[git] Blocked: dirty working tree`);
    return { status: "blocked", question: msg, requiredInputKey: "git_dirty" };
  }

  const scores = computeCriticalPathScores(plan.steps);
  const orderIndex = new Map(plan.steps.map((step, idx) => [step.id, idx]));
  const successors = buildSuccessorMap(plan.steps);
  let lastExecutedId: string | null = null;
  // Ensure steps are in dependency order (critical-path-first tie-break)
  const orderedSteps = orderStepsCriticalPathFirst(plan.steps, scores);

  // Spam control: track which steps we've already notified as blocked
  const previouslyBlockedIds = new Set<string>();
  let stopAllTasks = false;
  let globalBlock: { kind: ExecutorErrorKind; message: string } | null = null;
  let globalBlockApplied = false;

  // --- Resolve model ---
  const providerId = params.provider ?? DEFAULT_PROVIDER;
  const modelId = params.model ?? DEFAULT_MODEL_ID;
  const model = getModel(
    providerId as Parameters<typeof getModel>[0],
    modelId as Parameters<typeof getModel>[1],
  );
  if (!model) {
    throw new Error(`Model not found: ${providerId}/${modelId}`);
  }

  // --- Resolve auth ---
  const agentDir = resolveMoltbotAgentDir();
  await ensureMoltbotModelsJson(config);
  const authStorage = new AuthStorage(path.join(agentDir, "auth.json"));
  const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.json"));

  // Set runtime API key from env if available
  const envAuth = resolveEnvApiKey(providerId);
  if (envAuth) {
    authStorage.setRuntimeApiKey(providerId, envAuth.apiKey);
  }

  // --- Create goal tools (shared across tasks) ---
  const goalTools = createGoalTools(workingDir, runId);

  // --- Shared settings (reused per task session) ---
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 2 },
  });

  const codingTools = createCodingTools(workingDir);

  // --- Minimal task loop ---
  // Keep looping while there are runnable tasks
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (abortSignal?.aborted) break;

    const runnable = findRunnableTasks(orderedSteps, session.answers);
    if (runnable.length === 0) break;

    // Pick task via static critical-path scores (prefer longer path, then successor, then plan order)
    const task = pickNextTask(runnable, scores, orderIndex, successors, lastExecutedId);
    goalTools.setActiveTask(task.id);

    const maxAttempts = retryConfig?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const retryDelayMs = retryConfig?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const taskStartMs = Date.now();

    // If resuming a previously-blocked task with an answer, prepare it
    let resumeAnswer: string | undefined;
    let resumeQuestion: string | undefined;
    if (task.status === "blocked") {
      resumeAnswer = getAnswerForTask(task.id, session.answers);
      resumeQuestion = task.blockedQuestion;
      task.turnsUsed = 0;
      task.blockedReason = undefined;
      task.blockedQuestion = undefined;
      task.status = "pending";
      // Consume the answer so we don't retry infinitely if task blocks again
      const answerKey = `task:${task.id}:input`;
      if (session.answers[answerKey]) {
        delete session.answers[answerKey];
      }
    }

    // --- Git checkpoint: created once per task, persists across retry attempts ---
    let checkpoint: GitCheckpoint | null = null;
    if (gitCheckpointConfig?.enabled) {
      checkpoint = createCheckpoint(workingDir, runId, task.id);
      if (checkpoint) {
        onProgress?.(
          `  [git] Checkpoint at ${checkpoint.sha.slice(0, 7)} on ${checkpoint.branch || "current branch"}`,
        );
      }
    }

    // === ATTEMPT LOOP ===
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Fresh tracker per attempt; goalTools stays the same
      const turnTracker = createTurnTracker();
      goalTools.reset();
      goalTools.setTurnTracker(turnTracker);

      if (attempt > 1) {
        task.turnsUsed = 0;
        task.status = "pending";
        task.blockedReason = undefined;
        task.blockedQuestion = undefined;

        // Reset git state on retry if checkpoint exists
        if (checkpoint && gitCheckpointConfig?.resetOnRetry !== false) {
          const resetResult = resetToCheckpoint(workingDir, checkpoint);
          if (resetResult.success) {
            onProgress?.(`  [git] Reset to ${checkpoint.sha.slice(0, 7)}`);
          } else {
            onProgress?.(`  [git] Reset failed: ${resetResult.error}`);
          }
        }

        await new Promise((r) => setTimeout(r, retryDelayMs));
        onProgress?.(`  [ralph] Attempt ${attempt}/${maxAttempts}`);
      }

      // --- Create fresh PI session for this attempt ---
      const completedSummaries = orderedSteps
        .filter((s) => s.status === "done" && s.taskSummary)
        .map((s) => ({ id: s.id, summary: s.taskSummary! }));

      const taskSessionFile = resolveAgentTaskSessionFile(runId, task.id);
      const sessionsDir = path.dirname(taskSessionFile);
      if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

      onProgress?.(`Creating agent session for task ${task.id} (${providerId}/${modelId})...`);

      const resourceLoader = new DefaultResourceLoader({
        cwd: workingDir,
        agentDir,
        settingsManager,
        systemPrompt: buildGoalSystemPrompt(session.goal, plan, completedSummaries),
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
      });
      await resourceLoader.reload();

      const { session: piSession } = await createAgentSession({
        cwd: workingDir,
        agentDir,
        model,
        thinkingLevel: "low",
        tools: codingTools,
        customTools: goalTools.tools,
        sessionManager: SessionManager.open(taskSessionFile),
        settingsManager,
        authStorage,
        modelRegistry,
        resourceLoader,
      });

      const unsubscribe = piSession.subscribe((event) => {
        if (event.type === "tool_execution_start") {
          onProgress?.(`  [tool] ${event.toolName}`);
          turnTracker.recordTool(event.toolName);
        }
      });

      try {
        let turnsUsed = task.turnsUsed ?? 0;

        task.status = "in_progress";
        if (attempt === 1) {
          onProgress?.(`\n--- Task ${task.id}: ${task.description} ---`);
        }

        const handlePromptError = (
          errMsg: string,
          requestId?: string,
        ): { kind: ExecutorErrorKind; message: string } | null => {
          const errorKind = classifyExecutorError(errMsg);
          const formatted = formatExecutorError(errorKind, errMsg, requestId, providerId, modelId);

          task.status = "blocked";
          task.blockedReason = errorKind;
          task.blockedQuestion = formatted;

          session.stepResults.set(task.id, {
            stepId: task.id,
            success: false,
            output: "",
            error: task.blockedQuestion,
            durationMs: Date.now() - taskStartMs,
          });

          if (FATAL_ERRORS.includes(errorKind)) {
            session.lastError = task.blockedQuestion;
            return { kind: errorKind, message: formatted };
          }

          return null;
        };

        // Dynamic timeout: min(durationMinutes * 2, 2 hours), fallback to global default
        const MAX_TIMEOUT_MS = 2 * 60 * 60_000; // 2 hours
        const taskTimeoutMs = task.durationMinutes
          ? Math.min(task.durationMinutes * 2 * 60_000, MAX_TIMEOUT_MS)
          : timeoutMs;

        // Per-attempt prompt loop
        while (turnsUsed < maxTurnsPerTask) {
          if (abortSignal?.aborted) {
            task.status = "blocked";
            task.blockedReason = "timeout";
            break;
          }

          // Reset tracker at start of each turn
          turnTracker.reset();

          const firstTurnOpts =
            turnsUsed === 0
              ? {
                  nodeSpec: loadNodeSpec(runId, task.id),
                  workingNotes: loadWorkingNotes(runId, task.id),
                }
              : undefined;
          const prompt =
            turnsUsed === 0 && resumeAnswer
              ? buildResumeTaskPrompt(
                  task,
                  plan.steps.length,
                  resumeAnswer,
                  resumeQuestion,
                  firstTurnOpts,
                )
              : turnsUsed === 0
                ? buildFirstTaskPrompt(task, plan.steps.length, firstTurnOpts)
                : buildContinuePrompt(task, turnsUsed, maxTurnsPerTask);

          onProgress?.(`  [turn ${turnsUsed + 1}/${maxTurnsPerTask}]`);

          let promptError: AssistantErrorInfo | null = null;
          try {
            const timeoutController = new AbortController();
            const timer = setTimeout(() => timeoutController.abort(), taskTimeoutMs);
            const combinedAbort = abortSignal
              ? AbortSignal.any([abortSignal, timeoutController.signal])
              : timeoutController.signal;

            const onAbort = () => void piSession.abort();
            combinedAbort.addEventListener("abort", onAbort, { once: true });

            try {
              await piSession.prompt(prompt);
            } finally {
              clearTimeout(timer);
              combinedAbort.removeEventListener("abort", onAbort);
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            promptError = { message: errMsg, requestId: extractRequestId(err) };
          }

          turnsUsed++;
          task.turnsUsed = turnsUsed;

          // Auto-generate working notes if agent didn't write any and task isn't completing
          const taskCompleting = turnTracker.toolCalls.includes("mark_task_complete");
          if (!turnTracker.notesWritten && !taskCompleting) {
            autoGenerateWorkingNotes(
              runId,
              task.id,
              attempt,
              turnsUsed,
              turnTracker,
              promptError?.message,
            );
          }

          if (!promptError) {
            promptError = getLastAssistantError(piSession);
          }

          if (promptError) {
            const fatalBlock = handlePromptError(promptError.message, promptError.requestId);
            if (fatalBlock) {
              globalBlock = fatalBlock;
              stopAllTasks = true;
            }
            break;
          }

          // Check goal tool signals -- precedence: blocked > failed > complete
          const signal = goalTools.getSignal();
          if (signal) {
            if (signal.type === "user_input_needed") {
              task.status = "blocked";
              task.blockedReason = "user_input";
              task.blockedQuestion = signal.question;
              onProgress?.(`  [blocked] ${signal.question}`);
              break;
            }
            if (signal.type === "task_failed") {
              task.status = "blocked";
              task.blockedReason = "task_failed";
              task.blockedQuestion = signal.reason;
              task.failedDetail = {
                whatTried: signal.whatTried,
                errorType: signal.errorType,
                suggestedNext: signal.suggestedNext,
                needsRevert: signal.needsRevert,
              };
              onProgress?.(`  [failed] ${signal.reason}`);
              break;
            }
            if (signal.type === "task_complete") {
              task.status = "done";
              task.taskSummary = signal.summary;
              onProgress?.(`  [done] ${signal.summary}`);
              break;
            }
          }

          // No signal -- agent finished the prompt naturally; continue prompting.
        }

        // If turns exhausted without completion
        if (turnsUsed >= maxTurnsPerTask && task.status === "in_progress") {
          task.status = "blocked";
          task.blockedReason = "turn_limit";
          task.blockedQuestion = `Task did not complete within ${maxTurnsPerTask} turns.`;
          onProgress?.(`  [blocked] Turn limit reached (${maxTurnsPerTask})`);
        }
      } finally {
        unsubscribe();
        piSession.dispose();
      }

      // Check if should retry
      if (task.status === "blocked" && isRetryable(task.blockedReason)) {
        if (attempt < maxAttempts) {
          appendRetryContext(
            runId,
            task.id,
            attempt,
            task.blockedReason!,
            task.blockedQuestion ?? "Unknown",
          );
          continue;
        }
      }
      break; // Success, non-retryable, or max attempts reached
    }
    // === END ATTEMPT LOOP ===

    // Clean up tracker ref after task is done
    goalTools.setTurnTracker(null);

    // Record task result
    const durationMs = Date.now() - taskStartMs;
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
    lastExecutedId = task.id;

    // Write top-level WORKING.md entry
    if (task.status === "done") {
      appendGoalWorkingEntry(runId, task.id, "done", task.taskSummary ?? "Completed.");
    } else if (task.blockedReason === "task_failed") {
      appendGoalWorkingEntry(
        runId,
        task.id,
        "failed",
        task.failedDetail?.whatTried ?? task.blockedQuestion ?? "Failed.",
      );
    }

    // Fire step_blocked on transition (not on re-encounter of already-blocked tasks)
    if (stopAllTasks && globalBlock && !globalBlockApplied) {
      const blockedMessage = globalBlock.message;
      for (const step of orderedSteps) {
        if (step.status !== "pending") continue;
        const depsReady = step.dependsOn.every((depId) => {
          const dep = orderedSteps.find((s) => s.id === depId);
          return dep?.status === "done";
        });
        if (!depsReady) continue;
        step.status = "blocked";
        step.blockedReason = globalBlock.kind;
        step.blockedQuestion = blockedMessage;
      }
      globalBlockApplied = true;
    }

    const hasRunnable = findRunnableTasks(orderedSteps, session.answers).length > 0;

    if (
      task.status === "blocked" &&
      !previouslyBlockedIds.has(task.id) &&
      onStatusChange &&
      hasRunnable
    ) {
      previouslyBlockedIds.add(task.id);
      await onStatusChange({
        type: "step_blocked",
        stepId: task.id,
        question: task.blockedQuestion ?? "Unknown",
        steps: [...orderedSteps],
      });
    }

    if (stopAllTasks) {
      break;
    }
  }

  // --- Determine goal outcome ---
  const allDone = orderedSteps.every((s) => s.status === "done");
  if (allDone) {
    session.state = "done";
    const summary = buildGoalSummary(orderedSteps);
    if (onStatusChange) {
      await onStatusChange({ type: "all_done", steps: [...orderedSteps], summary });
    }
    return { status: "done", summary };
  }

  // Some tasks blocked
  const aggregated =
    aggregateBlockedDetails(orderedSteps) ??
    ({
      prompt: "All tasks completed.",
      requiredInputKey: "none",
    } as const);
  session.state = "blocked";
  session.blocked = aggregated;
  if (onStatusChange) {
    await onStatusChange({ type: "fully_blocked", steps: [...orderedSteps] });
  }
  return {
    status: "blocked",
    question: aggregated.prompt,
    requiredInputKey: aggregated.requiredInputKey,
  };
}
