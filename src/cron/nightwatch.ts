import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Bot } from "grammy";
import type { MoltbotConfig } from "../config/config.js";
import type { NightwatchConfig } from "../config/types.cron.js";
import { getCodexAskForApprovalPlacement } from "../goal/backend-availability.js";
import { buildClaudeCodeEnv, buildCredentialStrippedEnv } from "../goal/claude-code-env.js";
import {
  CLAUDE_ALLOWED_TOOLS_READ_ONLY,
  CLAUDE_READ_ONLY_PROMPT,
} from "../goal/claude-code-constants.js";
import {
  collectText,
  collapseWhitespace,
  formatCliFailure,
  isRecord,
  parseJsonLines,
} from "../goal/cli-output-parsing.js";
import { runCliProcess } from "../goal/cli-process.js";
import { extractJsonObjectCandidates } from "../goal/json-repair.js";
import { addLesson, loadLessons, removeLessons, type Lesson } from "../goal/lessons.js";
import { resolveClaudeBinary } from "../goal/scout.js";
import { getChildLogger } from "../logging.js";
import { resolveTelegramAccount } from "../telegram/accounts.js";
import { createCaptureRuntime, handleGoal, sendGoalPlanResult } from "../telegram/goal-commands.js";
import { CronService } from "./service.js";
import type { Logger } from "tslog";

export const NIGHTWATCH_DEFAULTS = {
  cronExpr: "0 3 * * *",
  repoPath: "~/moltbot",
  timezone: "America/New_York",
} as const;

export const NIGHTWATCH_JOB_NAME = "nightwatch-daily";
const NIGHTWATCH_SENTINEL_MESSAGE = "__nightwatch__";
const LESSON_CONDENSE_TIMEOUT_MS = 120_000;
const MAX_CONDENSED_LESSONS_PER_DIR = 25;
const MAX_CONDENSED_GLOBAL_LESSONS = 25;
let nightwatchLogger: Logger<Record<string, unknown>> | null = null;

function getNightwatchLogger(): Logger<Record<string, unknown>> {
  nightwatchLogger ??= getChildLogger({ module: "cron-nightwatch" });
  return nightwatchLogger;
}

export type NightwatchRunResult =
  | { status: "ok"; summary: string }
  | { status: "skipped"; summary: string }
  | { status: "error"; error: string; summary?: string };

type CondensedLesson = {
  pattern: string;
  lesson: string;
  scope?: "global" | "project";
  category?: "already-fixed-bug" | "flaky-path-workaround" | "cant-control" | "genuine";
  sourceLessonIds: string[];
};

type ParsedCondensedLessons = {
  parsed: boolean;
  lessons: CondensedLesson[];
};

export function expandTilde(p: string): string {
  if (!p.startsWith("~")) return p;
  return `${os.homedir()}${p.slice(1)}`;
}

function runExecFileUtf8(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function normalizeSourceLessonIds(value: unknown, validIds: Set<string>): string[] {
  if (!Array.isArray(value)) return [];
  const unique = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const id = entry.trim();
    if (!id || !validIds.has(id)) continue;
    unique.add(id);
  }
  return [...unique];
}

function normalizeCondenseCategory(
  value: unknown,
): "already-fixed-bug" | "flaky-path-workaround" | "cant-control" | "genuine" | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = collapseWhitespace(value).toLowerCase();
  if (
    normalized === "already-fixed-bug" ||
    normalized === "flaky-path-workaround" ||
    normalized === "cant-control" ||
    normalized === "genuine"
  ) {
    return normalized;
  }
  return undefined;
}

export function normalizeCondensedLesson(
  value: unknown,
  validIds: Set<string>,
): CondensedLesson | undefined {
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

  const directSourceIds = normalizeSourceLessonIds(value.sourceLessonIds, validIds);
  const sourceIdsAlias = normalizeSourceLessonIds(value.sourceIds, validIds);
  const lessonIdsAlias = normalizeSourceLessonIds(value.lessonIds, validIds);
  const sourceLessonIds =
    directSourceIds.length > 0
      ? directSourceIds
      : sourceIdsAlias.length > 0
        ? sourceIdsAlias
        : lessonIdsAlias;

  const scope = value.scope === "global" ? "global" : "project";
  const category = normalizeCondenseCategory(
    value.category ?? value.phase1Category ?? value.classification,
  );

  return { pattern, lesson, scope, category, sourceLessonIds };
}

function parseCondensedLessonsFromUnknown(
  value: unknown,
  validIds: Set<string>,
): ParsedCondensedLessons {
  if (Array.isArray(value)) {
    return {
      parsed: true,
      lessons: value
        .map((entry) => normalizeCondensedLesson(entry, validIds))
        .filter((entry): entry is CondensedLesson => Boolean(entry)),
    };
  }

  if (!isRecord(value)) return { parsed: false, lessons: [] };

  if (Array.isArray(value.lessons)) {
    return {
      parsed: true,
      lessons: value.lessons
        .map((entry) => normalizeCondensedLesson(entry, validIds))
        .filter((entry): entry is CondensedLesson => Boolean(entry)),
    };
  }

  if (Array.isArray(value.items)) {
    return {
      parsed: true,
      lessons: value.items
        .map((entry) => normalizeCondensedLesson(entry, validIds))
        .filter((entry): entry is CondensedLesson => Boolean(entry)),
    };
  }

  const direct = normalizeCondensedLesson(value, validIds);
  if (direct) return { parsed: true, lessons: [direct] };

  return { parsed: false, lessons: [] };
}

function parseCondensedLessonsFromCliOutput(
  stdout: string,
  validIds: Set<string>,
): ParsedCondensedLessons {
  const trimmed = stdout.trim();
  if (!trimmed) return { parsed: false, lessons: [] };

  try {
    const parsed = parseCondensedLessonsFromUnknown(JSON.parse(trimmed), validIds);
    if (parsed.parsed) return parsed;
  } catch {
    // Fall through to line/object extraction.
  }

  for (const line of trimmed.split(/\r?\n/g)) {
    const candidate = line.trim();
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) continue;
    try {
      const parsed = parseCondensedLessonsFromUnknown(JSON.parse(candidate), validIds);
      if (parsed.parsed) return parsed;
    } catch {
      continue;
    }
  }

  for (const candidate of extractJsonObjectCandidates(trimmed)) {
    try {
      const parsed = parseCondensedLessonsFromUnknown(JSON.parse(candidate), validIds);
      if (parsed.parsed) return parsed;
    } catch {
      continue;
    }
  }

  const lines = parseJsonLines(trimmed);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const entry = lines[i]!;
    const parsed = parseCondensedLessonsFromUnknown(entry, validIds);
    if (parsed.parsed) return parsed;

    const parsedResult = parseCondensedLessonsFromUnknown(entry.result, validIds);
    if (parsedResult.parsed) return parsedResult;

    const text = collectText(entry).trim();
    if (!text) continue;

    for (const textCandidate of extractJsonObjectCandidates(text)) {
      try {
        const parsedNested = parseCondensedLessonsFromUnknown(JSON.parse(textCandidate), validIds);
        if (parsedNested.parsed) return parsedNested;
      } catch {
        continue;
      }
    }
  }

  return { parsed: false, lessons: [] };
}

export function buildLessonCondensePrompt(workingDir: string, lessons: Lesson[]): string {
  const payload = lessons.map((lesson) => ({
    id: lesson.id,
    pattern: lesson.pattern,
    lesson: lesson.lesson,
    runId: lesson.runId,
    createdAt: lesson.createdAt,
  }));

  return [
    "Condense and curate these project lessons for long-term reuse.",
    `Working directory: ${workingDir}`,
    "",
    "Use a required two-phase process:",
    "Phase 1 — Categorize every input lesson into exactly one category:",
    "- already-fixed-bug: describes a specific fix that is already committed in the codebase.",
    "- flaky-path-workaround: tells the worker to work around a code issue instead of fixing the code.",
    "- cant-control: advises on things the worker cannot control (system config, build-gate policy, etc.).",
    "- genuine: a forward-looking principle that improves worker decision-making on future tasks.",
    "",
    "Phase 2 — Act on each category:",
    "- already-fixed-bug: delete.",
    "- flaky-path-workaround: delete.",
    "- cant-control: delete.",
    "- genuine: keep, classify scope, and merge duplicates.",
    "",
    "Scope classification for kept (genuine) lessons:",
    "- global: applies across any project/workspace as a general engineering/testing principle.",
    "- project: only relevant to this working directory.",
    "",
    `Return at most ${MAX_CONDENSED_LESSONS_PER_DIR} kept lessons after categorization and deduplication.`,
    "",
    "Output requirements:",
    'Return ONLY JSON with shape {"lessons":[{"pattern":"short-keyword","lesson":"1-3 sentence insight","scope":"global|project","sourceLessonIds":["input-id"]}]}',
    "- sourceLessonIds should reference the input IDs that support each output lesson.",
    '- scope is required for each kept lesson ("global" or "project").',
    `- Output must contain at most ${MAX_CONDENSED_LESSONS_PER_DIR} lessons.`,
    "- Do not invent facts that are not grounded in the input lessons.",
    '- If no lessons should remain, return {"lessons":[]}.',
    "",
    "Input lessons:",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

export function buildClaudeCondensePrompt(userPrompt: string): string {
  const systemPrompt = [
    "You condense lesson memory for a software project.",
    'Output only JSON with shape {"lessons":[{"pattern":"...","lesson":"...","scope":"global|project","sourceLessonIds":["..."]}]}',
    `Never return more than ${MAX_CONDENSED_LESSONS_PER_DIR} lessons.`,
  ].join(" ");
  return ["## System Prompt", systemPrompt, "", "## User Message", userPrompt].join("\n");
}

function buildCodexCondenseArgs(params: { workingDir: string; prompt: string }): string[] {
  const askForApprovalPlacement = getCodexAskForApprovalPlacement();
  return [
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
}

async function runClaudeLessonCondense(params: {
  claudeBinary: string;
  workingDir: string;
  prompt: string;
  validIds: Set<string>;
}): Promise<CondensedLesson[]> {
  const result = await runCliProcess({
    command: params.claudeBinary,
    args: [
      "-p",
      "--output-format",
      "json",
      "--max-turns",
      "1",
      "--allowedTools",
      CLAUDE_ALLOWED_TOOLS_READ_ONLY,
      "--append-system-prompt",
      CLAUDE_READ_ONLY_PROMPT,
    ],
    cwd: params.workingDir,
    timeoutMs: LESSON_CONDENSE_TIMEOUT_MS,
    stdin: buildClaudeCondensePrompt(params.prompt),
    env: buildClaudeCodeEnv("subscription"),
  });

  if (result.timedOut) throw new Error("timed out");
  if ((result.exitCode && result.exitCode !== 0) || result.signal) {
    throw new Error(formatCliFailure(result.stdout, result.stderr, result.signal));
  }

  const parsed = parseCondensedLessonsFromCliOutput(result.stdout, params.validIds);
  if (!parsed.parsed) throw new Error("unparseable output");
  return parsed.lessons;
}

export async function runCodexLessonCondense(params: {
  workingDir: string;
  prompt: string;
  validIds: Set<string>;
}): Promise<CondensedLesson[]> {
  const result = await runCliProcess({
    command: "codex",
    args: buildCodexCondenseArgs(params),
    cwd: params.workingDir,
    timeoutMs: LESSON_CONDENSE_TIMEOUT_MS,
    env: buildCredentialStrippedEnv(process.env, { stripAuthKeys: true }),
  });

  if (result.timedOut) throw new Error("timed out");
  if ((result.exitCode && result.exitCode !== 0) || result.signal) {
    throw new Error(formatCliFailure(result.stdout, result.stderr, result.signal));
  }

  const parsed = parseCondensedLessonsFromCliOutput(result.stdout, params.validIds);
  if (!parsed.parsed) throw new Error("unparseable output");
  return parsed.lessons;
}

function resolveCondenseWorkingDir(workingDir: string): string {
  const trimmed = workingDir.trim();
  if (!trimmed || trimmed === "*") return process.cwd();

  const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(trimmed);
  if (!fs.existsSync(resolved)) return process.cwd();
  return resolved;
}

function parseIsoTime(value: string): number {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function pickMostRecentLesson(lessons: Lesson[]): Lesson {
  return lessons.reduce((latest, current) =>
    parseIsoTime(current.createdAt) > parseIsoTime(latest.createdAt) ? current : latest,
  );
}

function groupLessonsByWorkingDir(lessons: Lesson[]): Map<string, Lesson[]> {
  const groups = new Map<string, Lesson[]>();
  for (const lesson of lessons) {
    const existing = groups.get(lesson.workingDir);
    if (existing) existing.push(lesson);
    else groups.set(lesson.workingDir, [lesson]);
  }
  return groups;
}

type LessonCondenseDeps = {
  resolveClaudeBinary: () => string | undefined;
  runClaudeLessonCondense: (params: {
    claudeBinary: string;
    workingDir: string;
    prompt: string;
    validIds: Set<string>;
  }) => Promise<CondensedLesson[]>;
  runCodexLessonCondense: (params: {
    workingDir: string;
    prompt: string;
    validIds: Set<string>;
  }) => Promise<CondensedLesson[]>;
};

export async function pruneAndCondenseLessons(
  deps: Partial<LessonCondenseDeps> = {},
): Promise<void> {
  const lessons = loadLessons();
  if (lessons.length === 0) return;

  const groups = groupLessonsByWorkingDir(lessons);
  const resolveClaudeBinaryFn = deps.resolveClaudeBinary ?? resolveClaudeBinary;
  const runClaudeCondenseFn = deps.runClaudeLessonCondense ?? runClaudeLessonCondense;
  const runCodexCondenseFn = deps.runCodexLessonCondense ?? runCodexLessonCondense;
  const claudeBinary = resolveClaudeBinaryFn();

  let totalPruned = 0;
  let totalMerged = 0;
  let processedGroups = 0;
  const condensedByGroup: Array<{
    workingDir: string;
    group: Lesson[];
    genuineLessons: CondensedLesson[];
    keptProjectLessons: CondensedLesson[];
    globalCandidates: CondensedLesson[];
  }> = [];

  for (const [workingDir, group] of groups) {
    const validIds = new Set(group.map((lesson) => lesson.id));
    const prompt = buildLessonCondensePrompt(workingDir, group);
    const condenseWorkingDir = resolveCondenseWorkingDir(workingDir);

    let condensed: CondensedLesson[] | undefined;
    if (claudeBinary) {
      try {
        condensed = await runClaudeCondenseFn({
          claudeBinary,
          workingDir: condenseWorkingDir,
          prompt,
          validIds,
        });
      } catch (err) {
        getNightwatchLogger().warn(
          {
            workingDir,
            error: err instanceof Error ? err.message : String(err),
          },
          "nightwatch: Claude lesson condense failed; falling back to Codex",
        );
      }
    }

    if (!condensed) {
      try {
        condensed = await runCodexCondenseFn({
          workingDir: condenseWorkingDir,
          prompt,
          validIds,
        });
      } catch (err) {
        getNightwatchLogger().warn(
          {
            workingDir,
            error: err instanceof Error ? err.message : String(err),
          },
          "nightwatch: skipping lesson condense for workingDir",
        );
        continue;
      }
    }

    const genuineLessons = condensed.filter(
      (entry) => !entry.category || entry.category === "genuine",
    );
    const keptProjectLessons: CondensedLesson[] = [];
    const globalCandidates: CondensedLesson[] = [];
    for (const entry of genuineLessons) {
      if (entry.scope === "global") {
        globalCandidates.push(entry);
        continue;
      }
      if (keptProjectLessons.length < MAX_CONDENSED_LESSONS_PER_DIR) {
        keptProjectLessons.push(entry);
      }
    }

    condensedByGroup.push({
      workingDir,
      group,
      genuineLessons,
      keptProjectLessons,
      globalCandidates,
    });
    processedGroups += 1;
  }

  const selectedGlobalByGroup = new Map<string, CondensedLesson[]>();
  let globalCount = 0;
  for (const group of condensedByGroup) {
    const selected: CondensedLesson[] = [];
    for (const entry of group.globalCandidates) {
      if (globalCount >= MAX_CONDENSED_GLOBAL_LESSONS) break;
      selected.push(entry);
      globalCount += 1;
    }
    selectedGlobalByGroup.set(group.workingDir, selected);
  }

  for (const groupResult of condensedByGroup) {
    const selectedGlobals = selectedGlobalByGroup.get(groupResult.workingDir) ?? [];
    const keptSet = new Set([...groupResult.keptProjectLessons, ...selectedGlobals]);
    const kept = groupResult.genuineLessons.filter((entry) => keptSet.has(entry));

    const lessonsById = new Map(groupResult.group.map((lesson) => [lesson.id, lesson] as const));
    const mostRecentLesson = pickMostRecentLesson(groupResult.group);
    const removed = removeLessons(groupResult.group.map((lesson) => lesson.id));
    let mergedCount = 0;

    for (const entry of kept) {
      const sourceLessons = entry.sourceLessonIds
        .map((sourceId) => lessonsById.get(sourceId))
        .filter((candidate): candidate is Lesson => Boolean(candidate));
      if (sourceLessons.length > 1) mergedCount += 1;
      const source =
        sourceLessons.length > 0 ? pickMostRecentLesson(sourceLessons) : mostRecentLesson;

      addLesson({
        workingDir: groupResult.workingDir,
        pattern: entry.pattern,
        lesson: entry.lesson,
        scope: entry.scope,
        source: source.source,
        runId: source.runId,
        ...(source.stepId ? { stepId: source.stepId } : {}),
      });
    }

    const prunedCount = Math.max(removed - kept.length, 0);
    totalPruned += prunedCount;
    totalMerged += mergedCount;

    getNightwatchLogger().info(
      {
        workingDir: groupResult.workingDir,
        before: groupResult.group.length,
        after: kept.length,
        pruned: prunedCount,
        merged: mergedCount,
      },
      "nightwatch: condensed lessons for workingDir",
    );
  }

  if (processedGroups > 0) {
    getNightwatchLogger().info(
      {
        groups: processedGroups,
        pruned: totalPruned,
        merged: totalMerged,
      },
      "nightwatch: lesson condensation cycle complete",
    );
  }
}

export async function checkGitChanges(
  repoPath: string,
  sinceIso?: string,
): Promise<{ hasChanges: boolean; summary: string }> {
  const expandedPath = expandTilde(repoPath);
  const sinceValue = typeof sinceIso === "string" && sinceIso.trim() ? sinceIso.trim() : "24h";
  const stdout = await runExecFileUtf8("git", [
    "-C",
    expandedPath,
    "log",
    `--since=${sinceValue}`,
    "--oneline",
  ]);
  const summary = stdout.trim();
  return { hasChanges: summary.length > 0, summary };
}

export const NIGHTWATCH_PROMPT_KEY_FILES = {
  newGoalWorkflow: [
    "src/goal/planner.ts",
    "src/goal/agent-executor.ts",
    "src/goal/cli-worker.ts",
    "src/goal/plan-autocheck.ts",
    "src/goal/goal-lock.ts",
    "src/goal/feedback.ts",
    "src/goal/backend-availability.ts",
    "src/goal/types.ts",
    "src/goal/run-store.ts",
    "src/goal/backend-types.ts",
    "src/goal/llm-client.ts",
    "src/goal/git-checkpoint.ts",
    "src/commands/goal.ts",
    "src/commands/goal-answer.ts",
    "src/commands/goal-detail.ts",
    "src/commands/goal-list.ts",
    "src/commands/goal-resume.ts",
    "src/commands/goal-status.ts",
    "src/commands/goal-stop.ts",
    "src/telegram/goal-commands.ts",
    "src/goal/goal-tools.ts",
    "src/goal/build-gate.ts",
    "src/goal/agent-executor-helpers.ts",
    "src/goal/cli-planner.ts",
    "src/goal/scout.ts",
    "src/goal/lessons.ts",
    "src/goal/execution-status.ts",
    "src/goal/manual-tests.ts",
    "src/goal/cli-runner.ts",
    "src/goal/blocked.ts",
    "src/goal/attempt-bundle.ts",
    "src/goal/task-runner.ts",
    "src/goal/pi-runner.ts",
    "src/goal/worker-context.ts",
    "src/goal/error-patterns.ts",
    "src/goal/claude-code-env.ts",
    "src/goal/claude-code-constants.ts",
    "src/goal/compact-output.ts",
    "src/goal/format-output.ts",
    "src/goal/cpm.ts",
    "src/goal/dag-render.ts",
    "src/goal/mermaid-render.ts",
    "src/goal/mermaid-png.ts",
    "src/goal/errors.ts",
    "src/goal/goal-schemas.ts",
    "src/goal/json-repair.ts",
    "src/goal/plan-order.ts",
    "src/goal/plan-text.ts",
    "src/goal/run-journal.ts",
    "src/goal/cli-process.ts",
    "src/goal/git-privacy.ts",
    "src/goal/conventions.ts",
    "src/goal/cli-output-parsing.ts",
  ],
  telegramUxIntegration: [
    "src/telegram/goal-commands.ts",
    "src/telegram/bot-native-commands.ts",
    "src/telegram/nightwatch-commands.ts",
    "src/telegram/goal-router.ts",
    "src/telegram/goal-message-index.ts",
    "src/telegram/goal-sending.ts",
    "src/telegram/goal-formatting.ts",
    "src/telegram/goal-blocked-ui.ts",
  ],
  securityConcerns: [
    "src/security/audit.ts",
    "src/security/audit-extra.ts",
    "src/security/audit-fs.ts",
    "src/goal/hard-deny.ts",
    "src/goal/capability-enforcement.ts",
    "src/goal/capability-types.ts",
    "src/security/fix.ts",
    "src/security/external-content.ts",
    "src/security/windows-acl.ts",
  ],
} as const;

function formatNightwatchKeyFiles(files: readonly string[]): string {
  return `Key files: ${files.join(", ")}.`;
}

export function buildNightwatchPrompt(): string {
  return `Nightwatch nightly review for the Moltbot repository.

You are a senior code reviewer performing a nightly audit of the Moltbot codebase. Your output will be used as a goal description for the planning system — write it as a focused, actionable goal that the planner can decompose into concrete steps.

Perform a thorough analysis of the current codebase focusing on these areas:

## 1. The /new_goal workflow (end-to-end)
Trace the full lifecycle: /new_goal command → planner → autocheck loop → approval → executor → workers → completion.
${formatNightwatchKeyFiles(NIGHTWATCH_PROMPT_KEY_FILES.newGoalWorkflow)}
Look for:
- Bugs or logic errors in the happy path
- Edge cases in blocked/failed/cancelled states and transitions between them
- Problems with /goal_answer, /goal_feedback, /goal_edit after a plan has been approved or executed
- Race conditions or lock issues (goal op locks, concurrent runs)
- Error handling gaps where failures could leave runs in a broken state

## 2. Telegram UX integration
Review how goal commands are wired up in Telegram: command registration, message formatting, button callbacks, thread handling.
${formatNightwatchKeyFiles(NIGHTWATCH_PROMPT_KEY_FILES.telegramUxIntegration)}
Look for:
- Commands that are missing or not properly registered
- Inconsistent or confusing user-facing messages
- Missing error feedback (silent failures the user would never see)
- Obvious UX improvements (e.g. missing confirmation, unclear status messages, long messages that should be truncated or paginated)

## 3. Architecture simplification opportunities
Look across the goal system and Telegram integration for:
- Dead code or unused exports
- Overly complex abstractions that could be flattened
- Duplicated logic that could be consolidated
- Indirection that makes the code harder to follow without adding real value

## 4. Cross-workflow consistency
Look for inconsistencies across workflows where a bug fix, UX pattern, or quality-of-life improvement exists in one place but is missing from analogous workflows that would benefit equally.
Concrete example:
- For /new_goal, the "Right away, sir." acknowledgment replies to the user's message so the user sees which goal is being planned.
Find and prioritize similar patterns where one workflow already has a good practice (like reply-to-message context) and other workflows lack it.
This is one example pattern — look broadly for any good practice that exists in one workflow but is missing from analogous workflows.

## 5. Security concerns
Review security posture across goal, gateway, and channel flows.
${formatNightwatchKeyFiles(NIGHTWATCH_PROMPT_KEY_FILES.securityConcerns)}
Look for:
- Input validation gaps or unsafe parsing of untrusted input
- Command or path injection risks in shell/file/process boundaries
- Credential and secret handling issues (storage, redaction, accidental exposure)
- Authentication/authorization gaps in gateway and channel handlers
- Hard-deny pattern bypass opportunities in goal execution paths
- Sensitive data leaks in logs or error messages
- OWASP Top 10 style vulnerabilities and similar high-impact patterns
Propose concrete patches with tests for each confirmed issue.

## 6. Nightwatch self-maintenance
Review the nightwatch prompt itself (in src/cron/nightwatch.ts, buildNightwatchPrompt function). Check whether the Key files references in each section are still accurate — files may have been renamed, moved, or deleted since the prompt was last updated. If any file paths are stale, include a step to update them. Also check if new important files have been added that should be reviewed but aren't listed.

## Output
Produce a goal plan with concrete, actionable steps that fix real bugs and make high-value improvements.
Prioritize correctness bugs over style issues. Do not propose changes unless you have read the actual code and confirmed the problem exists.
Each step should include both the fix and its test.
Format your output as a single coherent goal description, not as raw JSON. The planning system will decompose it into steps.`;
}

export async function runNightwatch(params: {
  cfg: MoltbotConfig;
  nightwatchCfg: NightwatchConfig | undefined;
  lastRunAtMs?: number;
}): Promise<NightwatchRunResult> {
  const { cfg, nightwatchCfg, lastRunAtMs } = params;
  if (!nightwatchCfg || nightwatchCfg.enabled !== true) {
    return { status: "skipped", summary: "Nightwatch is not configured or disabled" };
  }

  // Best-effort maintenance: this should never block nightwatch execution.
  try {
    await pruneAndCondenseLessons();
  } catch (err) {
    getNightwatchLogger().warn(
      { error: err instanceof Error ? err.message : String(err) },
      "nightwatch: lesson condensation failed",
    );
  }

  const rawChatId = nightwatchCfg.telegramChatId;
  if (rawChatId == null || String(rawChatId).trim() === "") {
    return {
      status: "error",
      error: "No Telegram chat target configured. Use /nightwatch chat to set one.",
    };
  }
  const chatId = String(rawChatId);

  const account = resolveTelegramAccount({
    cfg,
    accountId: nightwatchCfg.telegramAccountId,
  });
  if (!account.token?.trim()) {
    return {
      status: "error",
      error: "Could not resolve Telegram account token. Check your Telegram configuration.",
    };
  }

  try {
    const sinceIso =
      typeof lastRunAtMs === "number" && lastRunAtMs > 0
        ? new Date(lastRunAtMs).toISOString()
        : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const repoPath = nightwatchCfg.repoPath ?? NIGHTWATCH_DEFAULTS.repoPath;
    const gitChanges = await checkGitChanges(repoPath, sinceIso);
    if (!gitChanges.hasChanges) {
      return { status: "skipped", summary: "No git changes since last run" };
    }

    const goalPlanResult = await handleGoal(buildNightwatchPrompt(), cfg);
    const bot = new Bot(account.token);
    await sendGoalPlanResult({
      bot,
      chatId: Number(chatId),
      runtime: createCaptureRuntime().runtime,
      result: goalPlanResult,
      threadId: nightwatchCfg.telegramThreadId,
    });
    return { status: "ok", summary: "Plan delivered to Telegram" };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function registerNightwatchJob(
  cronService: CronService,
  nightwatchCfg: NightwatchConfig | undefined,
): Promise<void> {
  const jobs = (await cronService.list({ includeDisabled: true })).filter(
    (job) => job.name === NIGHTWATCH_JOB_NAME,
  );

  if (!nightwatchCfg || nightwatchCfg.enabled !== true) {
    for (const job of jobs) {
      await cronService.remove(job.id);
    }
    return;
  }

  const cronExpr = nightwatchCfg.cronExpr ?? NIGHTWATCH_DEFAULTS.cronExpr;
  const tz = nightwatchCfg.timezone ?? NIGHTWATCH_DEFAULTS.timezone;
  const [existing, ...duplicates] = jobs;

  for (const duplicate of duplicates) {
    await cronService.remove(duplicate.id);
  }

  if (existing) {
    await cronService.update(existing.id, {
      enabled: true,
      schedule: {
        kind: "cron",
        expr: cronExpr,
        tz,
      },
    });
    return;
  }

  await cronService.add({
    name: NIGHTWATCH_JOB_NAME,
    description: "Daily nightwatch code review",
    enabled: true,
    schedule: {
      kind: "cron",
      expr: cronExpr,
      tz,
    },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: NIGHTWATCH_SENTINEL_MESSAGE,
    },
  });
}
