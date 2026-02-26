import * as crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadAttemptBundles, resolveWorkerDir } from "./attempt-bundle.js";
import { getCodexAskForApprovalPlacement } from "./backend-availability.js";
import { buildClaudeCodeEnv } from "./claude-code-env.js";
import { runCliProcess } from "./cli-process.js";
import { repairJsonText } from "./json-repair.js";
import { extractJson } from "./planner.js";
import { loadRun } from "./run-store.js";
import { resolveClaudeBinary } from "./scout.js";
import type { SerializedRun } from "./types.js";

const LESSONS_FILENAME = "goal-lessons.json";
const LESSON_EXTRACTION_TIMEOUT_MS = 120_000;
const MAX_EXISTING_LESSONS_FOR_PROMPT = 25;
const MAX_PLAN_HISTORY_FOR_PROMPT = 12;
const MAX_RALPH_INSIGHTS_FOR_PROMPT = 20;
const MAX_STEP_RESULTS_FOR_PROMPT = 20;
const MAX_SUMMARY_TEXT_CHARS = 500;
const CLAUDE_ALLOWED_TOOLS = "Read,Glob,Grep,Bash";
const CLAUDE_READ_ONLY_PROMPT = "This is READ-ONLY. Do NOT create, modify, or delete any files.";

const LESSON_SOURCES = new Set(["ralph", "autocheck", "user_edit", "feedback", "worker"]);

export type LessonSource = "ralph" | "autocheck" | "user_edit" | "feedback" | "worker";

export type Lesson = {
  id: string;
  workingDir: string;
  pattern: string;
  lesson: string;
  source: LessonSource;
  runId: string;
  stepId?: string;
  createdAt: string;
};

type LessonCandidate = {
  pattern: string;
  lesson: string;
  stepId?: string;
};

type ParsedLessonCandidates = {
  parsed: boolean;
  lessons: LessonCandidate[];
};

function resolveLessonsPath(stateDir: string = resolveStateDir()): string {
  return path.join(stateDir, LESSONS_FILENAME);
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
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

export function addLesson(lesson: Omit<Lesson, "id" | "createdAt">): Lesson {
  const next: Lesson = {
    ...lesson,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const lessons = loadLessons();
  lessons.push(next);
  saveLessons(lessons);
  return next;
}

export function getLessonsForContext(workingDir: string): Lesson[] {
  return loadLessons().filter((lesson) => lesson.workingDir === workingDir);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxChars = MAX_SUMMARY_TEXT_CHARS): string {
  const normalized = collapseWhitespace(value);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trimEnd()}...`;
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

function parseJsonLines(text: string): Record<string, unknown>[] {
  const parsed: Record<string, unknown>[] = [];
  const lines = text.split(/\r?\n/g);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (isRecord(value)) parsed.push(value);
    } catch {
      try {
        const repairedValue = JSON.parse(repairJsonText(trimmed)) as unknown;
        if (isRecord(repairedValue)) parsed.push(repairedValue);
      } catch {
        // Ignore non-JSON lines.
      }
    }
  }
  return parsed;
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
  const stepId = typeof value.stepId === "string" ? value.stepId.trim() : "";
  return { pattern, lesson, ...(stepId ? { stepId } : {}) };
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

function formatCliFailure(stdout: string, stderr: string, signal: NodeJS.Signals | null): string {
  const detail = truncateText(stderr || stdout, 250);
  if (detail) return detail;
  if (signal) return `terminated by ${signal}`;
  return "unknown CLI error";
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

function buildClaudeExtractionPrompt(userPrompt: string): string {
  const systemPrompt = [
    "You extract reusable lessons from a completed engineering goal run.",
    'Output only JSON with shape: {"lessons":[{"pattern":"...","lesson":"...","stepId":"optional"}]}',
    'Return {"lessons":[]} when there are no useful new lessons.',
  ].join(" ");
  return ["## System Prompt", systemPrompt, "", "## User Message", userPrompt].join("\n");
}

async function runClaudeLessonExtraction(params: {
  claudeBinary: string;
  workingDir: string;
  prompt: string;
}): Promise<LessonCandidate[]> {
  const result = await runCliProcess({
    command: params.claudeBinary,
    args: [
      "-p",
      "--output-format",
      "json",
      "--max-turns",
      "1",
      "--allowedTools",
      CLAUDE_ALLOWED_TOOLS,
      "--append-system-prompt",
      CLAUDE_READ_ONLY_PROMPT,
    ],
    cwd: params.workingDir,
    timeoutMs: LESSON_EXTRACTION_TIMEOUT_MS,
    stdin: buildClaudeExtractionPrompt(params.prompt),
    env: buildClaudeCodeEnv("subscription"),
  });

  if (result.timedOut) {
    throw new Error("lesson extraction via claude timed out");
  }
  if ((result.exitCode && result.exitCode !== 0) || result.signal) {
    throw new Error(
      `lesson extraction via claude failed: ${formatCliFailure(result.stdout, result.stderr, result.signal)}`,
    );
  }

  const parsed = parseCandidatesFromCliOutput(result.stdout);
  if (!parsed.parsed) {
    throw new Error("lesson extraction via claude returned unparseable output");
  }
  return parsed.lessons;
}

async function runCodexLessonExtraction(params: {
  workingDir: string;
  prompt: string;
}): Promise<LessonCandidate[]> {
  const result = await runCliProcess({
    command: "codex",
    args: buildCodexExtractionArgs(params),
    cwd: params.workingDir,
    timeoutMs: LESSON_EXTRACTION_TIMEOUT_MS,
  });

  if (result.timedOut) {
    throw new Error("lesson extraction via codex timed out");
  }
  if ((result.exitCode && result.exitCode !== 0) || result.signal) {
    throw new Error(
      `lesson extraction via codex failed: ${formatCliFailure(result.stdout, result.stderr, result.signal)}`,
    );
  }

  const parsed = parseCandidatesFromCliOutput(result.stdout);
  if (!parsed.parsed) {
    throw new Error("lesson extraction via codex returned unparseable output");
  }
  return parsed.lessons;
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

function buildExistingLessonsSummary(
  existingLessons: Array<Pick<Lesson, "pattern" | "lesson">>,
): string {
  const entries = existingLessons
    .map((entry) => ({
      pattern: collapseWhitespace(entry.pattern),
      lesson: collapseWhitespace(entry.lesson),
    }))
    .filter((entry) => entry.pattern.length > 0 && entry.lesson.length > 0)
    .slice(0, MAX_EXISTING_LESSONS_FOR_PROMPT);
  if (entries.length === 0) return "None.";
  return entries.map((entry) => `- [${entry.pattern}] ${entry.lesson}`).join("\n");
}

function buildLessonExtractionPrompt(params: {
  runId: string;
  workingDir: string;
  existingLessons: Array<Pick<Lesson, "pattern" | "lesson">>;
  correctionSummary: string;
}): string {
  return [
    "Extract reusable project lessons from this completed goal run.",
    "",
    `Run: ${params.runId}`,
    `Working directory: ${params.workingDir}`,
    "",
    "Existing lessons (do not duplicate or paraphrase these):",
    buildExistingLessonsSummary(params.existingLessons),
    "",
    "Correction summary artifacts:",
    params.correctionSummary,
    "",
    "Return ONLY JSON with this shape:",
    '{ "lessons": [{ "pattern": "short-keyword", "lesson": "1-3 sentence insight", "stepId": "optional step id" }] }',
    "",
    "Rules:",
    "- Focus on non-obvious lessons that improve future implementation reliability in this project.",
    "- Pattern should be short and specific (kebab-case preferred).",
    "- Lesson text should be concrete and generalizable.",
    '- If no useful new lessons exist, return exactly: {"lessons":[]}.',
  ].join("\n");
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

    let candidates: LessonCandidate[] | undefined;
    const claudeBinary = resolveClaudeBinary();
    if (claudeBinary) {
      try {
        candidates = await runClaudeLessonExtraction({
          claudeBinary,
          workingDir,
          prompt,
        });
      } catch {
        candidates = undefined;
      }
    }

    if (!candidates) {
      try {
        candidates = await runCodexLessonExtraction({
          workingDir,
          prompt,
        });
      } catch {
        return [];
      }
    }

    if (candidates.length === 0) return [];

    const recorded: Lesson[] = [];
    for (const candidate of candidates) {
      const added = addLesson({
        workingDir,
        pattern: candidate.pattern,
        lesson: candidate.lesson,
        source: "autocheck",
        runId,
        ...(candidate.stepId ? { stepId: candidate.stepId } : {}),
      });
      recorded.push(added);
    }
    return recorded;
  } catch {
    return [];
  }
}
