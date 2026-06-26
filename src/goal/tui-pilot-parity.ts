// Shadow-parity harness for the Claude prompt-run migration (S1).
//
// Source of truth: docs/tui-pilot-parity/implementation-plan.md and
// docs/tui-pilot-parity/implementation-detail.md ("Shadow Parity Harness",
// "Passing Parity Definition"). Sample captures backing the fixtures live under
// docs/tui-pilot-parity/samples/.
//
// The harness drives representative prompts through BOTH the `direct`
// (`claude -p`) and `tui-pilot` driver legs with identical generated
// settings.json, equivalent cwd, equivalent allowed tools, equivalent model
// setting, and per-leg session ids (Claude rejects a reused session id, so the
// legs use fresh comparable ids and we assert on semantic output fields rather
// than raw transcript identity — see implementation-detail.md "Shadow Parity
// Harness" note).
//
// Process execution is INJECTED via a ParityLegExecutor. Under test we supply a
// mock executor that writes fixture stdout and a fixture worker_result.json with
// no live Claude, tmux, uv, network, or host auth. The host operator supplies a
// live executor (see makeLiveParityExecutor) to run real shadow parity against
// the installed tui-pilot artifact BETWEEN plans; that live run is not part of
// this plan's worker-completable scope.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildClaudeDriverSpawnCommand, runCliProcess } from "./cli-process.js";
import { collapseWhitespace, extractCliTextAndSession } from "./cli-output-parsing.js";
import {
  classifyAttemptOutcome,
  deriveFailureOutput,
  parseClaudeCodePreflightError,
  parseClaudeCodeStreamError,
  readWorkerResultFile,
  type StreamError,
} from "./cli-worker.js";
import type { GoalWorkerOutput } from "./backend-types.js";
import type { AttemptOutcome } from "./attempt-bundle.js";
import type { ClaudeDriver } from "../config/types.goal.js";

export type ParityDriverMode = ClaudeDriver; // "direct" | "tui-pilot"

export const PARITY_DRIVER_MODES: readonly ParityDriverMode[] = ["direct", "tui-pilot"];

const WORKER_RESULT_FILENAME = "worker_result.json";
// A path guaranteed not to exist, used to force a clean "missing" classification
// when a worker case produced no worker_result.json.
const WORKER_RESULT_MISSING_DIR = path.join(
  "/nonexistent-parity",
  "no-worker-result-dir-d0e1f2a3b4c5",
);
// Only affects the timeout *message* text; classification keys on the timedOut
// flag, so the exact value is immaterial to parity comparison.
const DEFAULT_PARITY_TIMEOUT_MS = 30 * 60_000;

/**
 * One representative parity case. `settings` is the generated settings.json body
 * shared verbatim by both legs. `expectsWorkerResult` is true for goal-worker
 * style prompt runs that report through worker_result.json, and false for
 * single-turn callers (lessons, manual-tests, nightwatch, goal-sending) that
 * read only final assistant text.
 */
export type ParityCase = {
  name: string;
  prompt: string;
  allowedTools: string[];
  model?: string;
  maxTurns?: string;
  appendSystemPrompt?: string;
  settings: Record<string, unknown>;
  expectsWorkerResult: boolean;
  /**
   * When true, the prompt is delivered via stdin instead of as a trailing positional
   * arg — the convention several real call sites use for large prompts (e.g. the
   * ~36KB planner brief). This exercises the seam's empty-positional → stdin path and
   * tui-pilot's large-prompt feeding, which a positional-only case does not.
   */
  promptViaStdin?: boolean;
};

/** The concrete spawn command + inputs the harness built for one leg. */
export type ParityLegSpawn = {
  mode: ParityDriverMode;
  command: string;
  args: string[];
  cwd: string;
  sessionId: string;
  settingsPath: string;
};

/** Raw process result for one leg, plus the worker_result.json path if any. */
export type ParityProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  workerResultPath?: string;
};

/**
 * Executes one parity leg. Production/live drives the real binary; tests inject a
 * mock. The executor is responsible for producing stdout and (for worker cases)
 * writing worker_result.json into the leg cwd.
 */
export type ParityLegExecutor = (
  spawn: ParityLegSpawn,
  parityCase: ParityCase,
) => Promise<ParityProcessResult>;

/** Comparable, driver-agnostic outcome extracted from one leg. */
export type NormalizedLegOutcome = {
  mode: ParityDriverMode;
  /** Normalized (whitespace-collapsed) final assistant text. */
  finalText: string;
  /** Parsed worker_result.json, or null for non-worker cases / failures. */
  workerResult: GoalWorkerOutput | null;
  /** Provider-error class (out_of_credits | auth | rate_limit | network |
   * process_error) or null when no provider/process error was surfaced. */
  providerErrorClass: string | null;
  /** Goal-worker attempt outcome; null for non-worker (final-text-only) cases. */
  attemptOutcome: AttemptOutcome | null;
  /** Session id observed in stream output, if emitted. */
  sessionId?: string;
};

export type ParityMismatch = {
  field: "finalText" | "workerResult" | "providerErrorClass" | "attemptOutcome";
  direct: unknown;
  tuiPilot: unknown;
};

/** Effective, comparable inputs for one leg (used to assert input parity). */
export type ParityLegInputs = {
  mode: ParityDriverMode;
  command: string;
  cwd: string;
  sessionId: string;
  hasSettings: boolean;
  effectiveModel: string | null;
  allowedTools: string[];
  maxTurns: string | null;
};

export type ParityCaseResult = {
  name: string;
  passed: boolean;
  mismatches: ParityMismatch[];
  /** Discrepancies in the leg INPUTS (settings/cwd/tools/model). */
  inputDiscrepancies: string[];
  direct: NormalizedLegOutcome;
  tuiPilot: NormalizedLegOutcome;
  directInputs: ParityLegInputs;
  tuiPilotInputs: ParityLegInputs;
};

export type ParityReport = {
  passed: boolean;
  cases: ParityCaseResult[];
};

// --- Leg construction --------------------------------------------------------

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Per-leg session id. Claude's `--session-id` MUST be a valid UUID and it rejects a
 * reused one (implementation-detail.md "Shadow Parity Harness"), so each leg gets a
 * fresh random UUID. The harness asserts on semantic output fields, not on the raw
 * transcript identity, so the id value itself is immaterial to parity. */
export function parityLegSessionId(): string {
  return randomUUID();
}

/** Build the canonical `claude -p` argument list a SmithersBot prompt-run uses. */
function buildCanonicalClaudeArgs(params: {
  parityCase: ParityCase;
  sessionId: string;
  settingsPath: string;
}): string[] {
  const { parityCase, sessionId, settingsPath } = params;
  // `claude --allowedTools` is VARIADIC: it consumes every following token until the
  // next flag. So the allowed-tools flags must NOT be the last thing before the
  // positional prompt, or Claude swallows the prompt ("Input must be provided …").
  // Production cli-worker is safe because --append-system-prompt always follows
  // --allowedTools; here we guarantee it by emitting --allowedTools BEFORE the other
  // flags, so --settings (a flag) always terminates the variadic and the prompt stays
  // a clean trailing positional.
  const args: string[] = ["-p", "--output-format", "stream-json", "--verbose"];
  for (const tool of parityCase.allowedTools) {
    args.push("--allowedTools", tool);
  }
  args.push(
    "--settings",
    settingsPath,
    "--setting-sources",
    "",
    "--permission-mode",
    "default",
    "--session-id",
    sessionId,
  );
  if (parityCase.maxTurns !== undefined) args.push("--max-turns", parityCase.maxTurns);
  if (parityCase.model !== undefined) args.push("--model", parityCase.model);
  if (parityCase.appendSystemPrompt !== undefined) {
    args.push("--append-system-prompt", parityCase.appendSystemPrompt);
  }
  // For stdin-fed prompts, omit the trailing positional so `claude -p` (and the seam's
  // `tui-pilot print ""`) read the prompt from stdin instead.
  if (!parityCase.promptViaStdin) {
    args.push(parityCase.prompt);
  }
  return args;
}

/**
 * Build one leg's spawn command. Writes the (identical) generated settings.json
 * into the leg cwd, then routes the canonical claude args through the real driver
 * seam with an explicit mode so direct keeps `claude ...` and tui-pilot produces
 * the tui-pilot translation — proving the argument/settings mapping.
 */
export function buildParityLeg(params: {
  parityCase: ParityCase;
  mode: ParityDriverMode;
  legDir: string;
  env?: Record<string, string | undefined>;
}): ParityLegSpawn {
  const { parityCase, mode, legDir } = params;
  fs.mkdirSync(legDir, { recursive: true });
  const settingsPath = path.join(legDir, "settings.json");
  fs.writeFileSync(settingsPath, `${JSON.stringify(parityCase.settings, null, 2)}\n`, "utf8");

  const sessionId = parityLegSessionId();
  const canonicalArgs = buildCanonicalClaudeArgs({ parityCase, sessionId, settingsPath });
  const env = params.env ?? process.env;
  const spawn = buildClaudeDriverSpawnCommand(
    { command: "claude", args: canonicalArgs, cwd: legDir, env },
    mode,
  );
  return {
    mode,
    command: spawn.command,
    args: spawn.args,
    cwd: legDir,
    sessionId,
    settingsPath,
  };
}

function takeFlag(args: readonly string[], name: string): string | null {
  const idx = args.lastIndexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1] ?? null;
}

function takeAllFlags(args: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name && i + 1 < args.length) {
      values.push(args[i + 1]!);
      i += 1;
    }
  }
  return values;
}

function readSettingsModel(settingsPath: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const model = (parsed as Record<string, unknown>).model;
      return typeof model === "string" ? model : null;
    }
  } catch {
    // fall through
  }
  return null;
}

/** Derive the effective, comparable inputs for one built leg. The model may live
 * on the CLI (direct) or be folded into settings.json (tui-pilot); we compare the
 * effective value across both homes. */
export function parityLegInputs(spawn: ParityLegSpawn): ParityLegInputs {
  const settingsModel = readSettingsModel(spawn.settingsPath);
  const cliModel = takeFlag(spawn.args, "--model");
  return {
    mode: spawn.mode,
    command: spawn.command,
    cwd: spawn.cwd,
    sessionId: spawn.sessionId,
    hasSettings: takeFlag(spawn.args, "--settings") !== null,
    effectiveModel: settingsModel ?? cliModel,
    allowedTools: takeAllFlags(spawn.args, "--allowedTools"),
    maxTurns: takeFlag(spawn.args, "--max-turns"),
  };
}

function compareLegInputs(direct: ParityLegInputs, tuiPilot: ParityLegInputs): string[] {
  const issues: string[] = [];
  if (!direct.hasSettings || !tuiPilot.hasSettings) {
    issues.push("both legs must forward generated settings.json");
  }
  if ((direct.effectiveModel ?? null) !== (tuiPilot.effectiveModel ?? null)) {
    issues.push(
      `effective model differs: direct=${direct.effectiveModel ?? "none"} tui-pilot=${tuiPilot.effectiveModel ?? "none"}`,
    );
  }
  if (JSON.stringify(direct.allowedTools) !== JSON.stringify(tuiPilot.allowedTools)) {
    issues.push("allowedTools differ between legs");
  }
  if ((direct.maxTurns ?? null) !== (tuiPilot.maxTurns ?? null)) {
    issues.push("max-turns differs between legs");
  }
  if (!direct.sessionId || !tuiPilot.sessionId) {
    issues.push("each leg must carry a session id");
  }
  return issues;
}

// --- Normalization -----------------------------------------------------------

/** Normalize one leg's raw process result into comparable, driver-agnostic
 * fields, reusing the exact production parsing/classification helpers so a
 * tui-pilot transcript-derived stream and a direct stream classify identically. */
export function normalizeLegOutcome(params: {
  mode: ParityDriverMode;
  parityCase: ParityCase;
  result: ParityProcessResult;
}): NormalizedLegOutcome {
  const { mode, parityCase, result } = params;
  const { text, sessionId } = extractCliTextAndSession(result.stdout);
  const finalText = collapseWhitespace(text);

  const streamError: StreamError | null = parseClaudeCodeStreamError(result.stdout, result.stderr);
  const preflightError: StreamError | null =
    !streamError && ((result.exitCode != null && result.exitCode !== 0) || result.signal)
      ? parseClaudeCodePreflightError(result.stdout, result.stderr)
      : null;
  const providerErrorClass = (streamError ?? preflightError)?.errorType ?? null;

  let workerResult: GoalWorkerOutput | null = null;
  let attemptOutcome: AttemptOutcome | null = null;

  if (parityCase.expectsWorkerResult) {
    // When no worker_result.json was written, point at a path that cannot exist
    // so readWorkerResultFile reports a clean "missing" (not invalid) result.
    const resultRead = readWorkerResultFile({
      primaryPath:
        result.workerResultPath ?? path.join(WORKER_RESULT_MISSING_DIR, WORKER_RESULT_FILENAME),
    });
    workerResult = resultRead.output;
    const output =
      workerResult ??
      deriveFailureOutput({
        resultRead,
        streamError,
        preflightError,
        timedOut: result.timedOut,
        exitCode: result.exitCode,
        signal: result.signal,
        timeoutMs: DEFAULT_PARITY_TIMEOUT_MS,
      });
    attemptOutcome = classifyAttemptOutcome(
      output,
      result.timedOut,
      result.exitCode,
      result.signal,
    );
  }

  return {
    mode,
    finalText,
    workerResult,
    providerErrorClass,
    attemptOutcome,
    ...(sessionId ? { sessionId } : {}),
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** Compare two normalized leg outcomes on the parity-relevant fields. Cost,
 * duration, and unconsumed reconstructed fields are excluded by construction —
 * they never enter NormalizedLegOutcome. */
export function compareLegOutcomes(
  direct: NormalizedLegOutcome,
  tuiPilot: NormalizedLegOutcome,
): ParityMismatch[] {
  const mismatches: ParityMismatch[] = [];
  if (direct.finalText !== tuiPilot.finalText) {
    mismatches.push({ field: "finalText", direct: direct.finalText, tuiPilot: tuiPilot.finalText });
  }
  if (stableStringify(direct.workerResult) !== stableStringify(tuiPilot.workerResult)) {
    mismatches.push({
      field: "workerResult",
      direct: direct.workerResult,
      tuiPilot: tuiPilot.workerResult,
    });
  }
  if (direct.providerErrorClass !== tuiPilot.providerErrorClass) {
    mismatches.push({
      field: "providerErrorClass",
      direct: direct.providerErrorClass,
      tuiPilot: tuiPilot.providerErrorClass,
    });
  }
  if (direct.attemptOutcome !== tuiPilot.attemptOutcome) {
    mismatches.push({
      field: "attemptOutcome",
      direct: direct.attemptOutcome,
      tuiPilot: tuiPilot.attemptOutcome,
    });
  }
  return mismatches;
}

// --- Orchestration -----------------------------------------------------------

/**
 * Run one parity case through both legs and compare. `rootDir` is a scratch
 * directory; each leg gets its own subdir (equivalent cwd, isolated
 * worker_result.json). The executor performs the actual (mocked or live) run.
 */
export async function runParityCase(params: {
  parityCase: ParityCase;
  rootDir: string;
  executor: ParityLegExecutor;
  env?: Record<string, string | undefined>;
}): Promise<ParityCaseResult> {
  const { parityCase, rootDir, executor, env } = params;
  const caseDir = path.join(rootDir, slugify(parityCase.name));

  const normalized: Partial<Record<ParityDriverMode, NormalizedLegOutcome>> = {};
  const inputs: Partial<Record<ParityDriverMode, ParityLegInputs>> = {};

  for (const mode of PARITY_DRIVER_MODES) {
    const legDir = path.join(caseDir, mode);
    const spawn = buildParityLeg({ parityCase, mode, legDir, env });
    inputs[mode] = parityLegInputs(spawn);
    const result = await executor(spawn, parityCase);
    normalized[mode] = normalizeLegOutcome({ mode, parityCase, result });
  }

  const direct = normalized.direct!;
  const tuiPilot = normalized["tui-pilot"]!;
  const directInputs = inputs.direct!;
  const tuiPilotInputs = inputs["tui-pilot"]!;

  const mismatches = compareLegOutcomes(direct, tuiPilot);
  const inputDiscrepancies = compareLegInputs(directInputs, tuiPilotInputs);

  return {
    name: parityCase.name,
    passed: mismatches.length === 0 && inputDiscrepancies.length === 0,
    mismatches,
    inputDiscrepancies,
    direct,
    tuiPilot,
    directInputs,
    tuiPilotInputs,
  };
}

/** Run the full case set and produce a report. */
export async function runShadowParity(params: {
  cases: ParityCase[];
  rootDir: string;
  executor: ParityLegExecutor;
  env?: Record<string, string | undefined>;
}): Promise<ParityReport> {
  const cases: ParityCaseResult[] = [];
  for (const parityCase of params.cases) {
    cases.push(
      await runParityCase({
        parityCase,
        rootDir: params.rootDir,
        executor: params.executor,
        env: params.env,
      }),
    );
  }
  return { passed: cases.every((c) => c.passed), cases };
}

/** Operator-facing one-page summary, used both for mocked self-test output and
 * for the live host run between plans against installed tui-pilot v0.8.60. */
export function formatParityReport(report: ParityReport): string {
  const lines: string[] = [];
  lines.push(`Shadow parity: ${report.passed ? "PASS" : "FAIL"} (${report.cases.length} cases)`);
  for (const c of report.cases) {
    lines.push(`  ${c.passed ? "✓" : "✗"} ${c.name}`);
    for (const issue of c.inputDiscrepancies) {
      lines.push(`      input: ${issue}`);
    }
    for (const m of c.mismatches) {
      lines.push(
        `      ${m.field}: direct=${JSON.stringify(m.direct)} tui-pilot=${JSON.stringify(m.tuiPilot)}`,
      );
    }
  }
  return lines.join("\n");
}

// --- Executors ---------------------------------------------------------------

/** Fixture describing one mode's simulated process output. */
export type ParityLegFixture = {
  stdout: string;
  stderr?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  /** worker_result.json content to write into the leg cwd (worker cases). */
  workerResult?: unknown;
};

/**
 * Build a mock executor from per-case, per-mode fixtures. Writes the fixture
 * worker_result.json into the leg cwd and returns the fixture stdout. No live
 * process, network, tmux, uv, or auth is touched.
 */
export function createMockParityExecutor(
  fixtures: Record<string, Partial<Record<ParityDriverMode, ParityLegFixture>>>,
): ParityLegExecutor {
  return async (spawn, parityCase) => {
    const fixture = fixtures[parityCase.name]?.[spawn.mode];
    if (!fixture) {
      throw new Error(`No parity fixture for case "${parityCase.name}" mode "${spawn.mode}"`);
    }
    let workerResultPath: string | undefined;
    if (fixture.workerResult !== undefined) {
      workerResultPath = path.join(spawn.cwd, WORKER_RESULT_FILENAME);
      fs.writeFileSync(workerResultPath, `${JSON.stringify(fixture.workerResult)}\n`, "utf8");
    }
    return {
      stdout: fixture.stdout,
      stderr: fixture.stderr ?? "",
      exitCode: fixture.exitCode ?? 0,
      signal: fixture.signal ?? null,
      timedOut: fixture.timedOut ?? false,
      durationMs: 0,
      ...(workerResultPath ? { workerResultPath } : {}),
    };
  };
}

/**
 * Live executor for the host operator's between-plans shadow-parity run against
 * installed tui-pilot. NOT used by sandbox tests (it spawns the real binary via
 * runCliProcess). Provided so the harness is runnable end to end on the host.
 */
export function makeLiveParityExecutor(params: {
  env: Record<string, string | undefined>;
  timeoutMs?: number;
}): ParityLegExecutor {
  return async (spawn, parityCase) => {
    const res = await runCliProcess({
      command: spawn.command,
      args: spawn.args,
      cwd: spawn.cwd,
      timeoutMs: params.timeoutMs ?? DEFAULT_PARITY_TIMEOUT_MS,
      env: params.env,
      ...(parityCase.promptViaStdin ? { stdin: parityCase.prompt } : {}),
    });
    return {
      stdout: res.stdout,
      stderr: res.stderr,
      exitCode: res.exitCode,
      signal: res.signal,
      timedOut: res.timedOut,
      durationMs: res.durationMs,
      workerResultPath: path.join(spawn.cwd, WORKER_RESULT_FILENAME),
    };
  };
}
