import * as crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import {
  buildClaudeExtractionPrompt,
  buildLessonExtractionPrompt,
} from "../prompts/lessons/extraction-prompt.js";
import { redactSecretValues } from "../security/secret-paths.js";
import {
  appendAgentHistoryEventBestEffort,
  parseBackendUsage,
  writeCriticalAgentLaunchEvent,
  type AgentBackendUsage,
} from "./agent-history-events.js";
import { workspaceNameFromWorkingDir } from "./agent-history.js";
import { loadAttemptBundles, resolveWorkerDir } from "./attempt-bundle.js";
import { getCodexAskForApprovalPlacement } from "./backend-availability.js";
import { buildClaudeCodeEnv, buildCredentialStrippedEnv } from "./claude-code-env.js";
import {
  CLAUDE_ALLOWED_TOOLS_READ_ONLY,
  CLAUDE_READ_ONLY_PROMPT,
} from "./claude-code-constants.js";
import {
  collectText,
  collapseWhitespace,
  formatCliFailure,
  isRecord,
  parseJsonLines,
} from "./cli-output-parsing.js";
import { runCliProcess } from "./cli-process.js";
import { runWithBackendFallback } from "./phase-fallback.js";
import { extractJson } from "./planner.js";
import { loadRun } from "./run-store.js";
import { resolveClaudeBinary } from "./scout.js";
import type { CliWorkerId } from "../config/types.goal.js";
import type { SerializedRun } from "./types.js";

const LESSONS_FILENAME = "goal-lessons.json";
const LESSON_EXTRACTION_TIMEOUT_MS = 120_000;
const MAX_PLAN_HISTORY_FOR_PROMPT = 12;
const MAX_RALPH_INSIGHTS_FOR_PROMPT = 20;
const MAX_STEP_RESULTS_FOR_PROMPT = 20;
const MAX_SUMMARY_TEXT_CHARS = 500;
const LESSONS_LOCK_RETRY_DELAY_MS = 20;
const LESSONS_LOCK_TIMEOUT_MS = 5_000;

const LESSON_SOURCES = new Set(["ralph", "autocheck", "user_edit", "feedback", "worker"]);
const LESSON_SCOPES = new Set(["global", "project"]);
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export type LessonSource = "ralph" | "autocheck" | "user_edit" | "feedback" | "worker";
export type LessonScope = "global" | "project";

export type Lesson = {
  id: string;
  workingDir: string;
  pattern: string;
  lesson: string;
  source: LessonSource;
  scope?: LessonScope;
  runId: string;
  stepId?: string;
  createdAt: string;
};

type LessonCandidate = {
  pattern: string;
  lesson: string;
  scope: LessonScope;
  stepId?: string;
};

type ParsedLessonCandidates = {
  parsed: boolean;
  lessons: LessonCandidate[];
};

type LessonExtractionResult = {
  lessons: LessonCandidate[];
  tokenUsage: AgentBackendUsage;
};

function resolveLessonsPath(stateDir: string = resolveStateDir()): string {
  return path.join(stateDir, LESSONS_FILENAME);
}

function resolveLessonsLockPath(stateDir: string = resolveStateDir()): string {
  return `${resolveLessonsPath(stateDir)}.lock`;
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, redactSecretValues(`${JSON.stringify(data, null, 2)}\n`), "utf8");
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
}

function isLesson(value: unknown): value is Lesson {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string") return false;
  if (typeof record.workingDir !== "string") return false;
  if (typeof record.pattern !== "string") return false;
  if (typeof record.lesson !== "string") return false;
  if (typeof record.runId !== "string") return false;
  if (record.stepId != null && typeof record.stepId !== "string") return false;
  if (
    record.scope != null &&
    (typeof record.scope !== "string" || !LESSON_SCOPES.has(record.scope))
  )
    return false;
  if (typeof record.createdAt !== "string") return false;
  if (typeof record.source !== "string" || !LESSON_SOURCES.has(record.source)) return false;
  return true;
}

export function loadLessons(): Lesson[] {
  const lessonsPath = resolveLessonsPath();
  if (!fs.existsSync(lessonsPath)) return [];

  try {
    const raw = fs.readFileSync(lessonsPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isLesson);
  } catch {
    return [];
  }
}

export function saveLessons(lessons: Lesson[]): void {
  atomicWriteJson(resolveLessonsPath(), lessons);
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(LOCK_WAIT_BUFFER, 0, 0, ms);
}

function acquireLessonsWriteLock(stateDir: string = resolveStateDir()): () => void {
  const lockPath = resolveLessonsLockPath(stateDir);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  const deadline = Date.now() + LESSONS_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          fs.rmdirSync(lockPath);
        } catch {
          // Best-effort cleanup; another caller may have already removed it.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for lessons lock: ${lockPath}`);
      }
      sleepSync(LESSONS_LOCK_RETRY_DELAY_MS);
    }
  }
}

export function addLesson(lesson: Omit<Lesson, "id" | "createdAt">): Lesson {
  const next: Lesson = {
    ...lesson,
    pattern: redactSecretValues(lesson.pattern),
    lesson: redactSecretValues(lesson.lesson),
    scope: lesson.scope ?? "project",
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };

  const release = acquireLessonsWriteLock();
  try {
    const lessons = loadLessons();
    lessons.push(next);
    saveLessons(lessons);
    return next;
  } finally {
    release();
  }
}

export function getLessonsForContext(workingDir: string): Lesson[] {
  return loadLessons().filter((lesson) => {
    const scope = lesson.scope ?? "project";
    if (scope === "global") return true;
    return lesson.workingDir === workingDir;
  });
}

export function clearLessons(workingDir?: string): number {
  const lessons = loadLessons();
  if (workingDir === undefined) {
    const removed = lessons.length;
    saveLessons([]);
    return removed;
  }

  const kept = lessons.filter((lesson) => lesson.workingDir !== workingDir);
  const removed = lessons.length - kept.length;
  if (removed > 0) {
    saveLessons(kept);
  }
  return removed;
}

export function removeLessons(ids: string[]): number {
  if (ids.length === 0) return 0;

  const idSet = new Set(ids);
  const lessons = loadLessons();
  const kept = lessons.filter((lesson) => !idSet.has(lesson.id));
  const removed = lessons.length - kept.length;
  if (removed > 0) {
    saveLessons(kept);
  }
  return removed;
}

function truncateText(value: string, maxChars = MAX_SUMMARY_TEXT_CHARS): string {
  const normalized = collapseWhitespace(value);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trimEnd()}...`;
}

function normalizeCandidate(value: unknown): LessonCandidate | undefined {
  if (!isRecord(value)) return undefined;
  const pattern =
    typeof value.pattern === "string"
      ? collapseWhitespace(value.pattern)
      : typeof value.tag === "string"
        ? collapseWhitespace(value.tag)
        : "";
  const lesson =
    typeof value.lesson === "string"
      ? collapseWhitespace(value.lesson)
      : typeof value.text === "string"
        ? collapseWhitespace(value.text)
        : "";
  if (!pattern || !lesson) return undefined;
  const scope = value.scope === "global" ? "global" : "project";
  const stepId = typeof value.stepId === "string" ? value.stepId.trim() : "";
  return { pattern, lesson, scope, ...(stepId ? { stepId } : {}) };
}

function parseCandidatesFromUnknown(value: unknown): ParsedLessonCandidates {
  if (Array.isArray(value)) {
    return {
      parsed: true,
      lessons: value
        .map((entry) => normalizeCandidate(entry))
        .filter((entry): entry is LessonCandidate => Boolean(entry)),
    };
  }

  if (!isRecord(value)) return { parsed: false, lessons: [] };

  if (Array.isArray(value.lessons)) {
    return {
      parsed: true,
      lessons: value.lessons
        .map((entry) => normalizeCandidate(entry))
        .filter((entry): entry is LessonCandidate => Boolean(entry)),
    };
  }

  if (Array.isArray(value.items)) {
    return {
      parsed: true,
      lessons: value.items
        .map((entry) => normalizeCandidate(entry))
        .filter((entry): entry is LessonCandidate => Boolean(entry)),
    };
  }

  const direct = normalizeCandidate(value);
  if (direct) return { parsed: true, lessons: [direct] };

  return { parsed: false, lessons: [] };
}

function parseCandidatesFromCliOutput(stdout: string): ParsedLessonCandidates {
  const trimmed = stdout.trim();
  if (!trimmed) return { parsed: false, lessons: [] };

  try {
    const raw = extractJson(trimmed);
    const parsed = parseCandidatesFromUnknown(raw);
    if (parsed.parsed) return parsed;
  } catch {
    // Fall through to line-level parsing.
  }

  const lines = parseJsonLines(trimmed);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const entry = lines[i]!;
    const parsedEntry = parseCandidatesFromUnknown(entry);
    if (parsedEntry.parsed) return parsedEntry;

    if (entry.result !== undefined) {
      const parsedResult = parseCandidatesFromUnknown(entry.result);
      if (parsedResult.parsed) return parsedResult;
    }

    const text = collectText(entry).trim();
    if (!text) continue;
    try {
      const nested = extractJson(text);
      const parsedNested = parseCandidatesFromUnknown(nested);
      if (parsedNested.parsed) return parsedNested;
    } catch {
      continue;
    }
  }

  return { parsed: false, lessons: [] };
}

function buildCodexExtractionArgs(params: { workingDir: string; prompt: string }): string[] {
  const askForApprovalPlacement = getCodexAskForApprovalPlacement();
  const args = [
    ...(askForApprovalPlacement === "before_exec" ? ["--ask-for-approval", "never"] : []),
    "exec",
    ...(askForApprovalPlacement === "after_exec" ? ["--ask-for-approval", "never"] : []),
    "--json",
    "--color",
    "never",
    "--sandbox",
    "read-only",
    "--cd",
    params.workingDir,
    "--skip-git-repo-check",
    params.prompt,
  ];
  return args;
}

function appendLessonHistory(params: {
  runId: string;
  workingDir: string;
  backend: CliWorkerId;
  event: string;
  status?: string;
  attemptNumber?: number;
  tokenUsage?: AgentBackendUsage;
  errorClass?: string;
  outputSummary?: string;
  promptArtifactPath?: string;
}): void {
  appendAgentHistoryEventBestEffort(
    {
      kind: "goal",
      workspaceName: workspaceNameFromWorkingDir(params.workingDir),
      goalId: params.runId,
    },
    {
      event: params.event,
      phase: "lessons",
      backend: params.backend,
      runId: params.runId,
      goalId: params.runId,
      status: params.status,
      attemptNumber: params.attemptNumber,
      tokenUsage: params.tokenUsage,
      errorClass: params.errorClass,
      outputSummary: params.outputSummary,
      promptArtifactPath: params.promptArtifactPath,
    },
  );
}

async function runClaudeLessonExtraction(params: {
  runId: string;
  claudeBinary: string;
  workingDir: string;
  prompt: string;
  attemptNumber: number;
}): Promise<LessonExtractionResult> {
  const stdin = buildClaudeExtractionPrompt(params.prompt);
  const args = [
    "-p",
    "--output-format",
    "json",
    "--max-turns",
    "1",
    "--allowedTools",
    CLAUDE_ALLOWED_TOOLS_READ_ONLY,
    "--append-system-prompt",
    CLAUDE_READ_ONLY_PROMPT,
  ];
  const launchHistory = writeCriticalAgentLaunchEvent({
    scope: {
      kind: "goal",
      workspaceName: workspaceNameFromWorkingDir(params.workingDir),
      goalId: params.runId,
    },
    phase: "lessons",
    backend: "claude_code",
    prompt: stdin,
    command: params.claudeBinary,
    argv: args,
    event: {
      runId: params.runId,
      goalId: params.runId,
      attemptNumber: params.attemptNumber,
      status: "started",
    },
  });
  const result = await runCliProcess({
    command: params.claudeBinary,
    args,
    cwd: params.workingDir,
    timeoutMs: LESSON_EXTRACTION_TIMEOUT_MS,
    stdin,
    env: buildClaudeCodeEnv("subscription"),
  });
  const tokenUsage = parseBackendUsage(`${result.stdout}\n${result.stderr}`);

  if (result.timedOut) {
    appendLessonHistory({
      runId: params.runId,
      workingDir: params.workingDir,
      backend: "claude_code",
      event: "failure",
      status: "error",
      attemptNumber: params.attemptNumber,
      tokenUsage,
      errorClass: "timeout",
      promptArtifactPath: launchHistory.promptArtifactPath,
    });
    throw new Error("lesson extraction via claude timed out");
  }
  if ((result.exitCode && result.exitCode !== 0) || result.signal) {
    const failure = formatCliFailure(
      redactSecretValues(result.stdout),
      redactSecretValues(result.stderr),
      result.signal,
    );
    appendLessonHistory({
      runId: params.runId,
      workingDir: params.workingDir,
      backend: "claude_code",
      event: "failure",
      status: "error",
      attemptNumber: params.attemptNumber,
      tokenUsage,
      errorClass: "nonzero_exit",
      outputSummary: failure,
      promptArtifactPath: launchHistory.promptArtifactPath,
    });
    throw new Error(`lesson extraction via claude failed: ${failure}`);
  }

  const parsed = parseCandidatesFromCliOutput(redactSecretValues(result.stdout));
  if (!parsed.parsed) {
    appendLessonHistory({
      runId: params.runId,
      workingDir: params.workingDir,
      backend: "claude_code",
      event: "failure",
      status: "error",
      attemptNumber: params.attemptNumber,
      tokenUsage,
      errorClass: "invalid_result",
      outputSummary: "lesson extraction via claude returned unparseable output",
      promptArtifactPath: launchHistory.promptArtifactPath,
    });
    throw new Error("lesson extraction via claude returned unparseable output");
  }
  appendLessonHistory({
    runId: params.runId,
    workingDir: params.workingDir,
    backend: "claude_code",
    event: "result",
    status: "success",
    attemptNumber: params.attemptNumber,
    tokenUsage,
    outputSummary: `extracted ${parsed.lessons.length} lesson candidate(s)`,
    promptArtifactPath: launchHistory.promptArtifactPath,
  });
  return { lessons: parsed.lessons, tokenUsage };
}

async function runCodexLessonExtraction(params: {
  runId: string;
  workingDir: string;
  prompt: string;
  attemptNumber: number;
}): Promise<LessonExtractionResult> {
  const args = buildCodexExtractionArgs(params);
  const launchHistory = writeCriticalAgentLaunchEvent({
    scope: {
      kind: "goal",
      workspaceName: workspaceNameFromWorkingDir(params.workingDir),
      goalId: params.runId,
    },
    phase: "lessons",
    backend: "codex",
    prompt: params.prompt,
    command: "codex",
    argv: args.map((arg, index) =>
      index === args.length - 1 ? "<prompt redacted; see prompt artifact>" : arg,
    ),
    event: {
      runId: params.runId,
      goalId: params.runId,
      attemptNumber: params.attemptNumber,
      status: "started",
    },
  });
  const result = await runCliProcess({
    command: "codex",
    args,
    cwd: params.workingDir,
    timeoutMs: LESSON_EXTRACTION_TIMEOUT_MS,
    env: buildCredentialStrippedEnv(process.env, { stripAuthKeys: true }),
  });
  const tokenUsage = parseBackendUsage(`${result.stdout}\n${result.stderr}`);

  if (result.timedOut) {
    appendLessonHistory({
      runId: params.runId,
      workingDir: params.workingDir,
      backend: "codex",
      event: "failure",
      status: "error",
      attemptNumber: params.attemptNumber,
      tokenUsage,
      errorClass: "timeout",
      promptArtifactPath: launchHistory.promptArtifactPath,
    });
    throw new Error("lesson extraction via codex timed out");
  }
  if ((result.exitCode && result.exitCode !== 0) || result.signal) {
    const failure = formatCliFailure(
      redactSecretValues(result.stdout),
      redactSecretValues(result.stderr),
      result.signal,
    );
    appendLessonHistory({
      runId: params.runId,
      workingDir: params.workingDir,
      backend: "codex",
      event: "failure",
      status: "error",
      attemptNumber: params.attemptNumber,
      tokenUsage,
      errorClass: "nonzero_exit",
      outputSummary: failure,
      promptArtifactPath: launchHistory.promptArtifactPath,
    });
    throw new Error(`lesson extraction via codex failed: ${failure}`);
  }

  const parsed = parseCandidatesFromCliOutput(redactSecretValues(result.stdout));
  if (!parsed.parsed) {
    appendLessonHistory({
      runId: params.runId,
      workingDir: params.workingDir,
      backend: "codex",
      event: "failure",
      status: "error",
      attemptNumber: params.attemptNumber,
      tokenUsage,
      errorClass: "invalid_result",
      outputSummary: "lesson extraction via codex returned unparseable output",
      promptArtifactPath: launchHistory.promptArtifactPath,
    });
    throw new Error("lesson extraction via codex returned unparseable output");
  }
  appendLessonHistory({
    runId: params.runId,
    workingDir: params.workingDir,
    backend: "codex",
    event: "result",
    status: "success",
    attemptNumber: params.attemptNumber,
    tokenUsage,
    outputSummary: `extracted ${parsed.lessons.length} lesson candidate(s)`,
    promptArtifactPath: launchHistory.promptArtifactPath,
  });
  return { lessons: parsed.lessons, tokenUsage };
}

function collectStepIds(run: SerializedRun): string[] {
  const ids = new Set<string>();
  for (const step of run.plan?.steps ?? []) ids.add(step.id);
  for (const historyEntry of run.planHistory ?? []) {
    for (const step of historyEntry.plan.steps) ids.add(step.id);
  }
  for (const stepId of Object.keys(run.stepResults ?? {})) ids.add(stepId);
  return [...ids];
}

function collectRalphInsights(
  runId: string,
  run: SerializedRun,
): Array<{
  stepId: string;
  attemptNumber: number;
  keyInsight: string;
  specificErrors?: string;
  suggestedApproach?: string;
}> {
  const insights: Array<{
    stepId: string;
    attemptNumber: number;
    keyInsight: string;
    specificErrors?: string;
    suggestedApproach?: string;
  }> = [];

  for (const stepId of collectStepIds(run)) {
    const bundles = loadAttemptBundles(resolveWorkerDir(runId, stepId));
    for (const bundle of bundles) {
      const detail = bundle.ralphDetail;
      const keyInsight = detail?.keyInsight ? truncateText(detail.keyInsight, 220) : "";
      if (!keyInsight) continue;
      const specificErrors = detail?.specificErrors ? truncateText(detail.specificErrors, 220) : "";
      const suggestedApproach = detail?.suggestedApproach
        ? truncateText(detail.suggestedApproach, 220)
        : "";
      insights.push({
        stepId,
        attemptNumber: bundle.attemptNumber,
        keyInsight,
        ...(specificErrors ? { specificErrors } : {}),
        ...(suggestedApproach ? { suggestedApproach } : {}),
      });
    }
  }

  return insights.slice(-MAX_RALPH_INSIGHTS_FOR_PROMPT);
}

function buildCorrectionSummary(
  runId: string,
  workingDir: string,
  run: SerializedRun,
): {
  hasCorrections: boolean;
  summary: string;
} {
  const lines: string[] = [
    `Run ID: ${runId}`,
    `Working directory: ${workingDir}`,
    `Goal: ${truncateText(run.goal, 260)}`,
    "",
  ];

  const planHistory = (run.planHistory ?? []).slice(-MAX_PLAN_HISTORY_FOR_PROMPT);
  const hasPlanCorrections =
    planHistory.length > 1 || planHistory.some((entry) => Boolean(entry.editInstructions?.trim()));
  if (planHistory.length > 0) {
    lines.push("Plan history:");
    for (const entry of planHistory) {
      lines.push(`- Revision ${entry.revision} (source: ${entry.source ?? "unknown"})`);
      const summary = truncateText(entry.plan.shortSummary || entry.plan.summary || "", 220);
      if (summary) lines.push(`  Summary: ${summary}`);
      if (entry.editInstructions) {
        lines.push(`  Edit instructions: ${truncateText(entry.editInstructions, 240)}`);
      }
    }
    lines.push("");
  }

  const ralphInsights = collectRalphInsights(runId, run);
  if (ralphInsights.length > 0) {
    lines.push("Ralph key insights:");
    for (const insight of ralphInsights) {
      lines.push(`- ${insight.stepId} attempt ${insight.attemptNumber}: ${insight.keyInsight}`);
      if (insight.specificErrors) lines.push(`  Errors: ${insight.specificErrors}`);
      if (insight.suggestedApproach)
        lines.push(`  Suggested next approach: ${insight.suggestedApproach}`);
    }
    lines.push("");
  }

  const stepIds = collectStepIds(run);
  const stepResults = stepIds
    .map((stepId) => [stepId, run.stepResults[stepId]] as const)
    .filter((entry): entry is [string, NonNullable<SerializedRun["stepResults"][string]>] =>
      Boolean(entry[1]),
    )
    .slice(0, MAX_STEP_RESULTS_FOR_PROMPT);
  const hasStepFailures = stepResults.some(
    ([, result]) => !result.success || Boolean(result.error),
  );
  if (stepResults.length > 0) {
    lines.push("Step results:");
    for (const [stepId, result] of stepResults) {
      lines.push(`- ${stepId}: ${result.success ? "success" : "failed"}`);
      if (result.error) lines.push(`  Error: ${truncateText(result.error, 220)}`);
      if (result.output) lines.push(`  Output: ${truncateText(result.output, 220)}`);
    }
  }

  return {
    hasCorrections: hasPlanCorrections || hasStepFailures || ralphInsights.length > 0,
    summary: lines.join("\n").trim(),
  };
}

export async function extractRunLessons(
  runId: string,
  workingDir: string,
  existingLessons: Array<Pick<Lesson, "pattern" | "lesson">>,
): Promise<Lesson[]> {
  try {
    const run = loadRun(runId);
    if (!run) return [];

    const correction = buildCorrectionSummary(runId, workingDir, run);
    if (!correction.hasCorrections) return [];

    const prompt = buildLessonExtractionPrompt({
      runId,
      workingDir,
      existingLessons,
      correctionSummary: correction.summary,
    });

    // Prefer Claude Code, then fall back to Codex. Lesson extraction is
    // fail-open (returns [] when both backends are exhausted), so the
    // usage-limit history is classified for diagnostics but never surfaced as a
    // blocker. Each backend is tried at most once.
    const claudeBinary = resolveClaudeBinary();
    const backends: CliWorkerId[] = [];
    if (claudeBinary) backends.push("claude_code");
    backends.push("codex");

    const outcome = await runWithBackendFallback<LessonCandidate[]>({
      backends,
      fallbackOnAnyError: true,
      attempt: async (backend) => {
        try {
          const result =
            backend === "claude_code"
              ? await runClaudeLessonExtraction({
                  runId,
                  claudeBinary: claudeBinary!,
                  workingDir,
                  prompt,
                  attemptNumber: backends.indexOf(backend) + 1,
                })
              : await runCodexLessonExtraction({
                  runId,
                  workingDir,
                  prompt,
                  attemptNumber: backends.indexOf(backend) + 1,
                });
          return { ok: true, value: result.lessons };
        } catch (error) {
          const errorText = error instanceof Error ? error.message : String(error);
          appendLessonHistory({
            runId,
            workingDir,
            backend,
            event: "fallback",
            status: "failed",
            attemptNumber: backends.indexOf(backend) + 1,
            errorClass: "backend_failed",
            outputSummary: errorText,
          });
          return { ok: false, errorText };
        }
      },
    });

    const candidates = outcome.status === "success" ? outcome.value : [];
    if (candidates.length === 0) return [];

    const recorded: Lesson[] = [];
    for (const candidate of candidates) {
      const added = addLesson({
        workingDir,
        pattern: candidate.pattern,
        lesson: candidate.lesson,
        source: "autocheck",
        runId,
        scope: candidate.scope,
        ...(candidate.stepId ? { stepId: candidate.stepId } : {}),
      });
      recorded.push(added);
    }
    return recorded;
  } catch {
    return [];
  }
}
