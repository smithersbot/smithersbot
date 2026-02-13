import fs from "node:fs";
import path from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";

import { resolveMoltbotAgentDir } from "../agents/agent-paths.js";
import { ensureMoltbotModelsJson } from "../agents/models-config.js";
import { resolveApiKeyForProvider } from "../agents/model-auth.js";
import type { MoltbotConfig } from "../config/config.js";
import {
  collectGitDiffSummary,
  formatAttemptBundleSummary,
  resolveWorkerDir,
  writeAttemptBundle,
} from "./attempt-bundle.js";
import { createEnforcedCodingTools } from "./capability-enforcement.js";
import { createGoalTools, createTurnTracker, type TurnTracker } from "./goal-tools.js";
import { formatPlanAsContext } from "./planner.js";
import {
  resolveAgentTaskSessionFile,
  resolveWorkingFile,
  resolveGoalWorkingFile,
} from "./run-store.js";
import { resolveScoutDir } from "./scout.js";
import type { HardDenyList } from "./hard-deny.js";
import type { TaskRunner, TaskRunnerContext, TaskRunnerResult } from "./task-runner.js";
import type { Plan, PlanStep } from "./types.js";
import { RATE_LIMIT_RE, CREDITS_RE, AUTH_RE, NETWORK_RE } from "./error-patterns.js";
import { WORKER_CONTEXT } from "./worker-context.js";

const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL_ID = "claude-sonnet-4-20250514";

type ExecutorErrorKind = "rate_limit" | "out_of_credits" | "auth" | "network" | "timeout" | "other";

type AssistantErrorInfo = {
  message: string;
  requestId?: string;
};

export class PiTaskRunner implements TaskRunner {
  private config?: MoltbotConfig;
  private providerId: string;
  private modelId: string;
  private maxTurnsPerTask: number;
  private goalTools: ReturnType<typeof createGoalTools>;
  private agentDir: string;
  private authStorage: AuthStorage;
  private modelRegistry: ModelRegistry;
  private settingsManager: SettingsManager;
  private modelReady: boolean;

  constructor(params: {
    workingDir: string;
    runId: string;
    config?: MoltbotConfig;
    provider?: string;
    model?: string;
    maxTurnsPerTask: number;
  }) {
    this.config = params.config;
    this.providerId = params.provider ?? DEFAULT_PROVIDER;
    this.modelId = params.model ?? DEFAULT_MODEL_ID;
    this.maxTurnsPerTask = params.maxTurnsPerTask;
    this.goalTools = createGoalTools(params.workingDir, params.runId);
    this.agentDir = resolveMoltbotAgentDir();
    this.authStorage = new AuthStorage(path.join(this.agentDir, "auth.json"));
    this.modelRegistry = new ModelRegistry(
      this.authStorage,
      path.join(this.agentDir, "models.json"),
    );
    this.settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 2 },
    });
    this.modelReady = false;
  }

  async execute(context: TaskRunnerContext): Promise<TaskRunnerResult> {
    await this.ensureModelReady();

    this.goalTools.reset();
    this.goalTools.setActiveTask(context.task.id);

    const attemptBundles = context.attemptBundles ?? [];
    const attemptNumber = attemptBundles.length + 1;
    const priorAttempt =
      attemptBundles.length > 0
        ? formatAttemptBundleSummary(attemptBundles[attemptBundles.length - 1]!)
        : null;

    const turnTracker = createTurnTracker();
    this.goalTools.setTurnTracker(turnTracker);

    const attemptStartMs = Date.now();
    const taskSessionFile = resolveAgentTaskSessionFile(context.runId, context.task.id);
    const sessionsDir = path.dirname(taskSessionFile);
    if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

    context.onProgress?.(
      `Creating agent session for task ${context.task.id} (${this.providerId}/${this.modelId})...`,
    );

    const workingJournal = loadGoalWorkingJournal(context.runId);
    const resourceLoader = new DefaultResourceLoader({
      cwd: context.workingDir,
      agentDir: this.agentDir,
      settingsManager: this.settingsManager,
      systemPrompt: buildGoalSystemPrompt(
        context.goal,
        context.plan,
        context.completedSummaries,
        workingJournal,
        context.denyPolicy,
      ),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await resourceLoader.reload();

    const codingTools = createEnforcedCodingTools(
      context.workingDir,
      context.denyPolicy,
      (detail) => {
        context.onProgress?.(`  [denied] ${detail.reason}`);
      },
    );

    const model = getModel(
      this.providerId as Parameters<typeof getModel>[0],
      this.modelId as Parameters<typeof getModel>[1],
    );
    if (!model) {
      throw new Error(`Model not found: ${this.providerId}/${this.modelId}`);
    }

    const { session: piSession } = await createAgentSession({
      cwd: context.workingDir,
      agentDir: this.agentDir,
      model,
      thinkingLevel: "low",
      tools: codingTools,
      customTools: this.goalTools.tools,
      sessionManager: SessionManager.open(taskSessionFile),
      settingsManager: this.settingsManager,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      resourceLoader,
    });

    const unsubscribe = piSession.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        context.onProgress?.(`  [tool] ${event.toolName}`);
        turnTracker.recordTool(event.toolName);
      }
    });

    let result: TaskRunnerResult | null = null;
    const attemptToolCalls = new Set<string>();
    try {
      let turnsUsed = 0;

      while (turnsUsed < this.maxTurnsPerTask) {
        if (context.abortSignal.aborted) {
          result = {
            status: "blocked",
            question: "Task aborted.",
            blockedReason: "timeout",
            turnsUsed,
          };
          break;
        }

        turnTracker.reset();

        const firstTurnOpts =
          turnsUsed === 0
            ? {
                nodeSpec: loadNodeSpec(context.runId, context.task.id),
                workingNotes: loadWorkingNotes(context.runId, context.task.id),
                priorAttempt,
              }
            : undefined;
        const prompt =
          turnsUsed === 0 && context.resumeAnswer
            ? buildResumeTaskPrompt(
                context.task,
                context.plan.steps.length,
                context.resumeAnswer,
                context.resumeQuestion,
                firstTurnOpts,
              )
            : turnsUsed === 0
              ? buildFirstTaskPrompt(context.task, context.plan.steps.length, firstTurnOpts)
              : buildContinuePrompt(context.task, turnsUsed, this.maxTurnsPerTask);

        context.onProgress?.(`  [turn ${turnsUsed + 1}/${this.maxTurnsPerTask}]`);

        let promptError: AssistantErrorInfo | null = null;
        try {
          const timeoutController = new AbortController();
          const timer = setTimeout(() => timeoutController.abort(), context.timeoutMs);
          const combinedAbort = AbortSignal.any([context.abortSignal, timeoutController.signal]);

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
        for (const tool of turnTracker.toolCalls) {
          attemptToolCalls.add(tool);
        }

        const taskCompleting = turnTracker.toolCalls.includes("mark_task_complete");
        if (!turnTracker.notesWritten && !taskCompleting) {
          autoGenerateWorkingNotes(
            context.runId,
            context.task.id,
            attemptNumber,
            turnsUsed,
            turnTracker,
            promptError?.message,
          );
        }

        if (!promptError) {
          promptError = getLastAssistantError(piSession);
        }

        if (promptError) {
          const errorKind = classifyExecutorError(promptError.message);
          const formatted = formatExecutorError(
            errorKind,
            promptError.message,
            promptError.requestId,
            this.providerId,
            this.modelId,
          );
          result = {
            status: "blocked",
            question: formatted,
            blockedReason: errorKind,
            turnsUsed,
          };
          break;
        }

        const signal = this.goalTools.getSignal();
        if (signal) {
          if (signal.type === "user_input_needed") {
            result = {
              status: "blocked",
              question: signal.question,
              blockedReason: "user_input",
              turnsUsed,
            };
            break;
          }
          if (signal.type === "task_failed") {
            result = {
              status: "failed",
              question: signal.reason,
              failedDetail: {
                whatTried: signal.whatTried,
                errorType: signal.errorType,
                suggestedNext: signal.suggestedNext,
                needsRevert: signal.needsRevert,
              },
              turnsUsed,
            };
            break;
          }
          if (signal.type === "task_complete") {
            result = { status: "complete", summary: signal.summary, turnsUsed };
            break;
          }
        }
      }

      if (!result && !context.abortSignal.aborted) {
        result = {
          status: "blocked",
          question: `Task did not complete within ${this.maxTurnsPerTask} turns.`,
          blockedReason: "turn_limit",
          turnsUsed: this.maxTurnsPerTask,
        };
      }
    } finally {
      unsubscribe();
      piSession.dispose();
      this.goalTools.setTurnTracker(null);
    }

    const attemptDurationMs = Date.now() - attemptStartMs;
    const { diffstat, changedFiles } = collectGitDiffSummary(context.workingDir);
    writeAttemptBundle(resolveWorkerDir(context.runId, context.task.id), {
      attemptNumber,
      backend: "pi",
      outcome: classifyAttemptOutcome(result),
      errorClassification: classifyAttemptError(result),
      diffstat,
      changedFiles,
      durationMs: attemptDurationMs,
      toolCalls: [...attemptToolCalls],
    });

    return result!;
  }

  private async ensureModelReady(): Promise<void> {
    if (this.modelReady) return;
    await ensureMoltbotModelsJson(this.config);

    try {
      const envAuth = await resolveApiKeyForProvider({ provider: this.providerId });
      if (envAuth.apiKey) {
        this.authStorage.setRuntimeApiKey(this.providerId, envAuth.apiKey);
      }
    } catch {
      // No API key found via profiles/env; PI session may have its own auth
    }

    this.modelReady = true;
  }
}

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
      return `Out of API credits${providerLabel}${modelLabel}. Add credits to your account.${suffix}`;
    case "auth":
      return `API authentication failed${providerLabel}${modelLabel}. Check your API key configuration.${suffix}`;
    case "rate_limit":
      return `Rate limited by API${providerLabel}${modelLabel}. Wait a few minutes.${suffix}`;
    case "network":
      return `Network error reaching API. Check your connection.${suffix}`;
    case "timeout":
      return "Task timed out during execution.";
    default:
      return `Agent error: ${rawMsg}${suffix}`;
  }
}

function extractRequestId(err: unknown): string | undefined {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e.request_id === "string") return e.request_id;
    if (typeof e.requestId === "string") return e.requestId;
  }
  const msg = err instanceof Error ? err.message : String(err);
  const match = /request[_-]?id[:\s]+([a-zA-Z0-9_-]+)/i.exec(msg);
  return match?.[1];
}

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

function classifyAttemptOutcome(
  result: TaskRunnerResult | null,
): "complete" | "blocked" | "failed" | "timeout" {
  if (!result) return "failed";
  if (result.status === "complete") return "complete";
  if (result.status === "failed") return "failed";
  if (result.status === "blocked" && result.blockedReason === "timeout") return "timeout";
  return "blocked";
}

function classifyAttemptError(result: TaskRunnerResult | null): string | undefined {
  if (!result) return "error";
  if (result.status === "failed") return result.failedDetail?.errorType ?? "task_failed";
  if (result.status === "blocked") return result.blockedReason ?? "other";
  return undefined;
}

function loadNodeSpec(runId: string, stepId: string): string | null {
  try {
    const specPath = path.join(resolveScoutDir(runId), "node_specs", `${stepId}.md`);
    return fs.readFileSync(specPath, "utf8");
  } catch {
    return null;
  }
}

function loadWorkingNotes(runId: string, stepId: string): string | null {
  try {
    const notesPath = resolveWorkingFile(runId, stepId);
    const content = fs.readFileSync(notesPath, "utf8").trim();
    return content || null;
  } catch {
    return null;
  }
}

function loadGoalWorkingJournal(runId: string): string | null {
  try {
    const filePath = resolveGoalWorkingFile(runId);
    const content = fs.readFileSync(filePath, "utf8").trim();
    return content || null;
  } catch {
    return null;
  }
}

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

function buildGoalSystemPrompt(
  goal: string,
  plan: Plan | null,
  completedSummaries: Array<{ id: string; summary: string }>,
  workingJournal: string | null,
  hardDenies: HardDenyList,
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
  if (completedSummaries.length > 0) {
    lines.push("");
    lines.push("COMPLETED TASKS:");
    for (const { id, summary } of completedSummaries) {
      lines.push(`- ${id}: ${summary}`);
    }
  }
  if (workingJournal) {
    const MAX_JOURNAL_CHARS = 4000;
    const truncated =
      workingJournal.length > MAX_JOURNAL_CHARS
        ? workingJournal.slice(-MAX_JOURNAL_CHARS) + "\n...(truncated, showing recent entries)"
        : workingJournal;
    lines.push("");
    lines.push("WORKING JOURNAL (accumulated context from completed and attempted tasks):");
    lines.push(truncated);
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
  lines.push("HARD DENIES (never do these):");
  for (const deny of hardDenies) {
    lines.push(`- ${deny.pattern}: ${deny.reason}`);
  }
  lines.push("- Do NOT retry operations that return DENIED errors.");
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
  if (WORKER_CONTEXT) {
    lines.push("");
    lines.push(WORKER_CONTEXT);
  }
  return lines.join("\n");
}

function buildFirstTaskPrompt(
  task: PlanStep,
  totalTasks: number,
  opts?: { nodeSpec?: string | null; workingNotes?: string | null; priorAttempt?: string | null },
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
  if (opts?.priorAttempt) {
    lines.push("");
    lines.push("PREVIOUS ATTEMPT FAILED:");
    lines.push(opts.priorAttempt);
    lines.push("");
    lines.push("Try a different approach. Do not repeat what failed.");
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

function buildResumeTaskPrompt(
  task: PlanStep,
  totalTasks: number,
  answer: string,
  question?: string,
  opts?: { nodeSpec?: string | null; workingNotes?: string | null; priorAttempt?: string | null },
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
  if (opts?.priorAttempt) {
    lines.push("");
    lines.push("PREVIOUS ATTEMPT FAILED:");
    lines.push(opts.priorAttempt);
    lines.push("");
    lines.push("Try a different approach. Do not repeat what failed.");
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
