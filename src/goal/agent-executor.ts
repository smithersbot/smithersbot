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
import { createGoalTools } from "./goal-tools.js";
import { formatPlanAsContext } from "./planner.js";
import { resolveAgentSessionFile } from "./run-store.js";
import {
  computeCriticalPathScores,
  orderStepsCriticalPathFirst,
  type CriticalPathScores,
} from "./plan-order.js";
import type { GoalOutcome, GoalSession, Plan, PlanStep, TaskExecutionResult } from "./types.js";

const DEFAULT_MAX_TURNS_PER_TASK = 5;
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes per prompt
const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL_ID = "claude-sonnet-4-20250514";

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
  onTaskUpdate?: (result: TaskExecutionResult) => void;
  onProgress?: (text: string) => void;
  onStatusChange?: (event: GoalStatusChangeEvent) => void | Promise<void>;
  abortSignal?: AbortSignal;
};

/** Build the goal-level system prompt set once at session creation. */
function buildGoalSystemPrompt(goal: string, plan: Plan | null): string {
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
  lines.push("");
  lines.push("TASK MANAGEMENT TOOLS:");
  lines.push("- mark_task_complete(summary): Call when done with the current task.");
  lines.push("- request_user_input(question): Call ONLY when genuinely stuck and need the user.");
  lines.push("- delete_path(path, recursive?): Delete a file or directory within the workspace.");
  lines.push("");
  lines.push("RULES:");
  lines.push("- Focus exclusively on the current task you are given.");
  lines.push("- Debug and fix errors yourself. Only call request_user_input as a last resort.");
  lines.push("- Always call mark_task_complete with a brief summary when a task is done.");
  return lines.join("\n");
}

/** Build the prompt for the first turn of a task. */
function buildFirstTaskPrompt(task: PlanStep, totalTasks: number): string {
  const lines: string[] = [];
  lines.push(`Work on this task: ${task.description}`);
  lines.push("");
  lines.push(`Task ${task.id} of ${totalTasks}.`);
  if (task.dependsOn.length > 0) {
    lines.push(`Dependencies completed: ${task.dependsOn.join(", ")}.`);
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
): string {
  const lines: string[] = [];
  lines.push(`Continue working on this task: ${task.description}`);
  lines.push("");
  lines.push(`Task ${task.id} of ${totalTasks}.`);
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

/** Aggregate blocked task info into a single message for the user. */
function aggregateBlockedQuestions(steps: PlanStep[]): {
  prompt: string;
  requiredInputKey: string;
} {
  const blocked = steps.filter((s) => s.status === "blocked");
  if (blocked.length === 0) {
    return { prompt: "All tasks completed.", requiredInputKey: "none" };
  }
  if (blocked.length === 1) {
    const task = blocked[0]!;
    const question =
      task.blockedQuestion ?? `Task ${task.id} is blocked (${task.blockedReason ?? "unknown"}).`;
    return { prompt: question, requiredInputKey: `task:${task.id}:input` };
  }
  // Multiple blocked tasks: aggregate
  const lines = blocked.map((task) => {
    const reason = task.blockedQuestion ?? task.blockedReason ?? "unknown";
    return `- Task ${task.id} (${task.description}): ${reason}`;
  });
  return {
    prompt: `Multiple tasks need attention:\n${lines.join("\n")}`,
    requiredInputKey: `tasks:${blocked.map((t) => t.id).join(",")}:input`,
  };
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
    onTaskUpdate,
    onProgress,
    onStatusChange,
    abortSignal,
  } = params;

  const plan = session.plan;
  if (!plan) throw new Error("No plan to execute");

  session.state = "executing";

  const scores = computeCriticalPathScores(plan.steps);
  const orderIndex = new Map(plan.steps.map((step, idx) => [step.id, idx]));
  const successors = buildSuccessorMap(plan.steps);
  let lastExecutedId: string | null = null;
  // Ensure steps are in dependency order (critical-path-first tie-break)
  const orderedSteps = orderStepsCriticalPathFirst(plan.steps, scores);

  // Spam control: track which steps we've already notified as blocked
  const previouslyBlockedIds = new Set<string>();

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

  // --- Resolve session file ---
  const sessionFilePath = resolveAgentSessionFile(runId);

  // --- Create goal tools ---
  const goalTools = createGoalTools(workingDir);

  // --- Create PI agent session ---
  onProgress?.(`Creating agent session (${providerId}/${modelId})...`);

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 2 },
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd: workingDir,
    agentDir,
    settingsManager,
    systemPrompt: buildGoalSystemPrompt(session.goal, plan),
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
    tools: createCodingTools(workingDir),
    customTools: goalTools.tools,
    sessionManager: SessionManager.open(sessionFilePath),
    settingsManager,
    authStorage,
    modelRegistry,
    resourceLoader,
  });

  // Subscribe to events for progress
  const unsubscribe = piSession.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      onProgress?.(`  [tool] ${event.toolName}`);
    }
  });

  try {
    // --- Minimal task loop ---
    // Keep looping while there are runnable tasks
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (abortSignal?.aborted) break;

      const runnable = findRunnableTasks(orderedSteps, session.answers);
      if (runnable.length === 0) break;

      // Pick task via static critical-path scores (prefer longer path, then successor, then plan order)
      const task = pickNextTask(runnable, scores, orderIndex, successors, lastExecutedId);
      goalTools.reset();

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
      }

      let turnsUsed = task.turnsUsed ?? 0;
      const taskStartMs = Date.now();

      task.status = "in_progress";
      onProgress?.(`\n--- Task ${task.id}: ${task.description} ---`);

      // Per-task prompt loop
      while (turnsUsed < maxTurnsPerTask) {
        if (abortSignal?.aborted) {
          task.status = "blocked";
          task.blockedReason = "timeout";
          break;
        }

        const prompt =
          turnsUsed === 0 && resumeAnswer
            ? buildResumeTaskPrompt(task, plan.steps.length, resumeAnswer, resumeQuestion)
            : turnsUsed === 0
              ? buildFirstTaskPrompt(task, plan.steps.length)
              : buildContinuePrompt(task, turnsUsed, maxTurnsPerTask);

        onProgress?.(`  [turn ${turnsUsed + 1}/${maxTurnsPerTask}]`);

        try {
          // Create a timeout for this prompt
          const timeoutController = new AbortController();
          const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
          const combinedAbort = abortSignal
            ? AbortSignal.any([abortSignal, timeoutController.signal])
            : timeoutController.signal;

          // Listen for abort to abort the session
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
          // Check if it was a timeout/abort
          if (errMsg.includes("abort") || errMsg.includes("timeout")) {
            task.status = "blocked";
            task.blockedReason = "timeout";
            task.blockedQuestion = "Task timed out during execution.";
            break;
          }
          // Other errors: mark blocked with error
          task.status = "blocked";
          task.blockedReason = "error";
          task.blockedQuestion = `Agent error: ${errMsg}`;
          break;
        }

        turnsUsed++;
        task.turnsUsed = turnsUsed;

        // Check goal tool signals — blocked always takes precedence over complete
        const signal = goalTools.getSignal();
        if (signal) {
          if (signal.type === "user_input_needed") {
            task.status = "blocked";
            task.blockedReason = "user_input";
            task.blockedQuestion = signal.question;
            onProgress?.(`  [blocked] ${signal.question}`);
            break;
          }
          if (signal.type === "task_complete") {
            task.status = "done";
            task.taskSummary = signal.summary;
            onProgress?.(`  [done] ${signal.summary}`);
            break;
          }
        }

        // No signal — agent finished the prompt naturally.
        // If it's the last allowed turn, we'll catch it below.
        // Otherwise, continue prompting.
      }

      // If turns exhausted without completion
      if (turnsUsed >= maxTurnsPerTask && task.status === "in_progress") {
        task.status = "blocked";
        task.blockedReason = "turn_limit";
        task.blockedQuestion = `Task did not complete within ${maxTurnsPerTask} turns.`;
        onProgress?.(`  [blocked] Turn limit reached (${maxTurnsPerTask})`);
      }

      // Mark as running → final status was already set
      const durationMs = Date.now() - taskStartMs;
      const result: TaskExecutionResult = {
        taskId: task.id,
        turnsUsed,
        durationMs,
        outcome: task.status === "done" ? "done" : "blocked",
        summary: task.taskSummary,
        blockedQuestion: task.blockedQuestion,
        blockedReason: task.blockedReason,
      };
      onTaskUpdate?.(result);
      lastExecutedId = task.id;

      // Fire step_blocked on transition (not on re-encounter of already-blocked tasks)
      if (task.status === "blocked" && !previouslyBlockedIds.has(task.id) && onStatusChange) {
        previouslyBlockedIds.add(task.id);
        await onStatusChange({
          type: "step_blocked",
          stepId: task.id,
          question: task.blockedQuestion ?? "Unknown",
          steps: [...orderedSteps],
        });
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
    const aggregated = aggregateBlockedQuestions(orderedSteps);
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
  } finally {
    unsubscribe();
    piSession.dispose();
  }
}
