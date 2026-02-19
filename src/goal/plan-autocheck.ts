import fs from "node:fs";
import path from "node:path";
import type { ClaudeCodeAuthMode, PlanAutocheckMode } from "../config/types.goal.js";
import { getCodexAskForApprovalPlacement } from "./backend-availability.js";
import { buildClaudeCodeEnv } from "./claude-code-env.js";
import { runCliPlanRevision } from "./cli-planner.js";
import { runCliProcess, type RunCliProcessResult } from "./cli-process.js";
import { computeCpm } from "./cpm.js";
import { computeDisplayStatuses } from "./execution-status.js";
import { formatPlanOutput } from "./format-output.js";
import { renderMermaid } from "./mermaid-render.js";
import { extractJson } from "./planner.js";
import { resolveClaudeBinary } from "./scout.js";
import type { Plan } from "./types.js";

const DEFAULT_AUTOCHECK_MAX_ROUNDS = 3;
const DEFAULT_AUTOCHECK_TIMEOUT_MS = 1_200_000;
const CLAUDE_ALLOWED_TOOLS = "Read,Glob,Grep,Bash";
const CLAUDE_READ_ONLY_PROMPT = "This is READ-ONLY. Do NOT create, modify, or delete any files.";
const SESSION_NOT_FOUND_RE =
  /(session|thread|conversation|resume)[^.\n\r]{0,80}(not found|unknown|expired|invalid)/i;
const MAX_DETAIL_CHARS = 1_200;

const REVIEW_INSTRUCTION = [
  "You have access to the full codebase in the current working directory.",
  "Before answering, inspect relevant source files to validate that the plan references",
  "correct file paths, function names, module structures, and patterns.",
  'Then respond ONLY with JSON: {"approved": true} or {"approved": false, "editInstructions": "..."}',
].join(" ");

export type PlanAutocheckBackend = Exclude<PlanAutocheckMode, "off">;

export type PlanAutocheckCommitRevisionParams = {
  round: number;
  editInstructions: string;
  previousPlan: Plan;
  revisedPlan: Plan;
};

export type PlanAutocheckParams = {
  plan: Plan;
  goalText: string;
  mode: PlanAutocheckBackend;
  maxRounds?: number;
  workingDir: string;
  claudeCodeAuth?: ClaudeCodeAuthMode;
  runDir: string;
  existingSessionId?: string;
  existingBackend?: string;
  commitRevision: (params: PlanAutocheckCommitRevisionParams) => Promise<void> | void;
  model?: string;
  timeoutMs?: number;
};

export type PlanAutocheckResult = {
  plan: Plan;
  autocheckRounds: number;
  autocheckMaxRounds: number;
  approved: boolean;
  exhausted: boolean;
  sessionId: string | undefined;
  backend: PlanAutocheckBackend;
};

type AutocheckDecision = { approved: true } | { approved: false; editInstructions: string };

type ParsedReviewerOutput = {
  text: string;
  sessionId?: string;
  decision?: AutocheckDecision;
};

type ReviewerAttemptResult = {
  stdout: string;
  stderr: string;
  durationMs: number;
  responseText: string;
  sessionId?: string;
  decision: AutocheckDecision;
};

class ReviewerCliError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;

  constructor(message: string, result: RunCliProcessResult) {
    super(message);
    this.name = "ReviewerCliError";
    this.stdout = result.stdout;
    this.stderr = result.stderr;
    this.timedOut = result.timedOut;
    this.exitCode = result.exitCode;
    this.signal = result.signal;
    this.durationMs = result.durationMs;
  }
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

function pickSessionId(parsed: Record<string, unknown>): string | undefined {
  const fields = [
    "session_id",
    "sessionId",
    "conversation_id",
    "conversationId",
    "thread_id",
    "threadId",
  ];
  for (const field of fields) {
    const value = parsed[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function parseJsonLines(raw: string): Array<Record<string, unknown>> {
  return raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is Record<string, unknown> => isRecord(entry));
}

function parseTextAndSessionFromJsonLines(raw: string): { text: string; sessionId?: string } {
  const lines = parseJsonLines(raw);
  let sessionId: string | undefined;
  let finalResultText: string | undefined;
  const parts: string[] = [];

  for (const parsed of lines) {
    sessionId = sessionId ?? pickSessionId(parsed);
    const type = typeof parsed.type === "string" ? parsed.type : "";
    const isError = parsed.is_error === true;
    if (type === "result" && !isError) {
      const resultText = collectText(parsed.result).trim();
      if (resultText) {
        finalResultText = resultText;
      }
      continue;
    }
    const eventText = collectText(parsed).trim();
    if (!eventText) continue;
    if (parts.at(-1) !== eventText) {
      parts.push(eventText);
    }
  }

  return { text: (finalResultText ?? parts.join("\n")).trim(), sessionId };
}

function parseDecisionRecord(raw: Record<string, unknown>): AutocheckDecision | undefined {
  if (typeof raw.approved !== "boolean") return undefined;
  if (raw.approved) return { approved: true };
  const editInstructions =
    typeof raw.editInstructions === "string" ? raw.editInstructions.trim() : "";
  if (!editInstructions) {
    return {
      approved: false,
      editInstructions:
        "Reviewer rejected the plan but did not provide editInstructions. Return specific edits.",
    };
  }
  return { approved: false, editInstructions };
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

function parseDecisionFromText(raw: string): AutocheckDecision | undefined {
  const text = raw.trim();
  if (!text) return undefined;

  try {
    const extracted = extractJson(text);
    const decision = parseDecisionRecord(extracted);
    if (decision) return decision;
  } catch {
    // Continue to lenient extraction.
  }

  for (const line of text.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!isRecord(parsed)) continue;
      const decision = parseDecisionRecord(parsed);
      if (decision) return decision;
    } catch {
      continue;
    }
  }

  for (const candidate of extractJsonObjectCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!isRecord(parsed)) continue;
      const decision = parseDecisionRecord(parsed);
      if (decision) return decision;
    } catch {
      continue;
    }
  }

  return undefined;
}

function parseDecisionFromUnknown(raw: unknown): AutocheckDecision | undefined {
  if (isRecord(raw)) {
    const fromObject = parseDecisionRecord(raw);
    if (fromObject) return fromObject;
  }
  const text = collectText(raw).trim();
  return text ? parseDecisionFromText(text) : undefined;
}

function parseClaudeReviewerOutput(stdout: string): ParsedReviewerOutput {
  const lines = parseJsonLines(stdout);
  let sessionId: string | undefined;
  let decision: AutocheckDecision | undefined;
  let resultText: string | undefined;

  for (const parsed of lines) {
    sessionId = sessionId ?? pickSessionId(parsed);
    const type = typeof parsed.type === "string" ? parsed.type : "";
    const isError = parsed.is_error === true;
    if (type !== "result" || isError) continue;

    const parsedDecision = parseDecisionFromUnknown(parsed.result);
    if (parsedDecision) {
      decision = parsedDecision;
    }
    const text = collectText(parsed.result).trim();
    if (text) {
      resultText = text;
    }
  }

  const streamParsed = parseTextAndSessionFromJsonLines(stdout);
  const responseText = (resultText ?? streamParsed.text ?? stdout.trim()).trim();
  const parsedDecision =
    decision ?? parseDecisionFromText(responseText) ?? parseDecisionFromText(stdout);

  return {
    text: responseText,
    sessionId: sessionId ?? streamParsed.sessionId,
    decision: parsedDecision,
  };
}

function parseCodexReviewerOutput(stdout: string): ParsedReviewerOutput {
  const streamParsed = parseTextAndSessionFromJsonLines(stdout);
  const responseText = (streamParsed.text || stdout.trim()).trim();
  const decision = parseDecisionFromText(stdout) ?? parseDecisionFromText(responseText);
  return {
    text: responseText,
    sessionId: streamParsed.sessionId,
    decision,
  };
}

function truncateDetail(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (!singleLine) return "";
  if (singleLine.length <= MAX_DETAIL_CHARS) return singleLine;
  return `${singleLine.slice(0, MAX_DETAIL_CHARS)}...`;
}

function describeCliFailure(result: RunCliProcessResult): string {
  if (result.timedOut) {
    return "Reviewer process timed out.";
  }
  const detail = truncateDetail(result.stderr) || truncateDetail(result.stdout);
  if (detail) return detail;
  if (result.signal) return `signal=${result.signal}`;
  return `exit=${result.exitCode ?? "unknown"}`;
}

function parseFailureEditInstructions(backend: PlanAutocheckBackend, raw: string): string {
  const excerpt = truncateDetail(raw);
  return [
    `Autocheck (${backend}) reviewer response could not be parsed as decision JSON.`,
    "Please tighten the plan with clearer concrete file/function references, dependency ordering, and verification steps.",
    excerpt ? `Raw response excerpt: ${excerpt}` : "Raw response excerpt: (empty)",
  ].join(" ");
}

function normalizeSessionId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeBackend(value: string | undefined): PlanAutocheckBackend | undefined {
  return value === "codex" || value === "claude_code" ? value : undefined;
}

function buildClaudeReviewerArgs(params: {
  prompt: string;
  sessionId?: string;
  model?: string;
}): string[] {
  const args = [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--allowedTools",
    CLAUDE_ALLOWED_TOOLS,
    "--append-system-prompt",
    CLAUDE_READ_ONLY_PROMPT,
  ];
  if (params.model) args.push("--model", params.model);
  if (params.sessionId) args.push("--resume", params.sessionId);
  args.push(params.prompt);
  return args;
}

function buildCodexReviewerArgs(params: {
  prompt: string;
  workingDir: string;
  sessionId?: string;
  model?: string;
}): string[] {
  const askForApprovalPlacement = getCodexAskForApprovalPlacement();
  const args = [
    ...(askForApprovalPlacement === "before_exec" ? ["--ask-for-approval", "never"] : []),
    "exec",
    ...(askForApprovalPlacement === "after_exec" ? ["--ask-for-approval", "never"] : []),
  ];

  if (params.sessionId) {
    args.push("resume", params.sessionId);
  }
  if (!params.sessionId) {
    args.push("--json", "--color", "never", "--sandbox", "read-only");
    args.push("--cd", params.workingDir);
  }

  args.push("--skip-git-repo-check");

  if (params.model) {
    args.push("--model", params.model);
  }

  args.push(params.prompt);
  return args;
}

function resolveRunIdentity(runDir: string): { runId: string; goalsDir: string } {
  const absoluteRunDir = path.resolve(runDir);
  const runId = path.basename(absoluteRunDir);
  const goalsDir = path.dirname(absoluteRunDir);
  return { runId, goalsDir };
}

function renderMermaidDag(plan: Plan): string {
  let cpm: ReturnType<typeof computeCpm> | undefined;
  try {
    cpm = computeCpm(plan);
  } catch {
    cpm = undefined;
  }
  const displayStatuses = computeDisplayStatuses(plan.steps);
  return renderMermaid(plan, cpm, displayStatuses);
}

function summarizeFeedback(history: string[]): string {
  if (history.length === 0) return "None.";
  return history.map((entry, idx) => `${idx + 1}. ${entry}`).join("\n");
}

function buildPlanSnapshot(plan: Plan): string {
  return JSON.stringify(
    {
      workingDir: plan.workingDir,
      summary: plan.summary,
      shortSummary: plan.shortSummary,
      steps: plan.steps.map((step) => ({
        id: step.id,
        description: step.description,
        shortSummary: step.shortSummary,
        backend: step.backend,
        dependsOn: step.dependsOn,
        durationMinutes: step.durationMinutes,
      })),
    },
    null,
    2,
  );
}

function buildAutocheckPrompt(params: {
  goalText: string;
  plan: Plan;
  workingDir: string;
  resume: boolean;
  priorFeedback: string[];
  contextNotes: string[];
}): string {
  const planDetail = formatPlanOutput(params.plan, {
    diagram: "none",
    format: "md",
    workingDir: params.workingDir,
  });
  const mermaidDag = renderMermaidDag(params.plan);
  const snapshot = buildPlanSnapshot(params.plan);

  if (params.resume) {
    return [
      "You are continuing plan review in an existing reviewer session.",
      "Re-review this updated plan and answer: Is this plan ready to execute?",
      "",
      "Original goal (verbatim):",
      params.goalText,
      "",
      "Updated /plan_detail output:",
      planDetail,
      "",
      "Updated plan snapshot JSON:",
      snapshot,
      "",
      "Updated mermaid DAG:",
      "```mermaid",
      mermaidDag,
      "```",
      "",
      REVIEW_INSTRUCTION,
    ].join("\n");
  }

  const contextSection =
    params.contextNotes.length > 0 ? ["Context continuity notes:", ...params.contextNotes, ""] : [];
  const feedbackSection = [
    "Prior reviewer feedback summary:",
    summarizeFeedback(params.priorFeedback),
    "",
  ];

  return [
    "You are an independent plan reviewer.",
    "Question: Is this plan ready to execute?",
    "",
    "Original goal (verbatim):",
    params.goalText,
    "",
    ...contextSection,
    ...feedbackSection,
    "Current /plan_detail output:",
    planDetail,
    "",
    "Current plan snapshot JSON:",
    snapshot,
    "",
    "Current mermaid DAG:",
    "```mermaid",
    mermaidDag,
    "```",
    "",
    REVIEW_INSTRUCTION,
  ].join("\n");
}

function writeTextArtifact(filePath: string, value: string): void {
  try {
    fs.writeFileSync(filePath, value, "utf8");
  } catch {
    // Best-effort diagnostics.
  }
}

function writeJsonArtifact(filePath: string, value: unknown): void {
  try {
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } catch {
    // Best-effort diagnostics.
  }
}

async function runReviewerAttempt(params: {
  backend: PlanAutocheckBackend;
  prompt: string;
  workingDir: string;
  timeoutMs: number;
  claudeCodeAuth: ClaudeCodeAuthMode;
  sessionId?: string;
  model?: string;
  stdoutPath: string;
  stderrPath: string;
}): Promise<ReviewerAttemptResult> {
  const command = params.backend === "claude_code" ? resolveClaudeBinary() : "codex";
  if (!command) {
    throw new Error("claude binary not found on PATH");
  }

  const args =
    params.backend === "claude_code"
      ? buildClaudeReviewerArgs({
          prompt: params.prompt,
          sessionId: params.sessionId,
          model: params.model,
        })
      : buildCodexReviewerArgs({
          prompt: params.prompt,
          workingDir: params.workingDir,
          sessionId: params.sessionId,
          model: params.model,
        });

  const procResult = await runCliProcess({
    command,
    args,
    cwd: params.workingDir,
    timeoutMs: params.timeoutMs,
    stdoutPath: params.stdoutPath,
    stderrPath: params.stderrPath,
    env:
      params.backend === "claude_code"
        ? buildClaudeCodeEnv(params.claudeCodeAuth)
        : { ...process.env },
  });

  if (procResult.timedOut) {
    throw new ReviewerCliError(
      `Plan autocheck worker timed out after ${(params.timeoutMs / 60_000).toFixed(0)} minutes.`,
      procResult,
    );
  }

  if ((procResult.exitCode && procResult.exitCode !== 0) || procResult.signal) {
    throw new ReviewerCliError(
      `Plan autocheck worker failed: ${describeCliFailure(procResult)}`,
      procResult,
    );
  }

  if (params.sessionId && SESSION_NOT_FOUND_RE.test(`${procResult.stderr}\n${procResult.stdout}`)) {
    throw new ReviewerCliError(
      `Plan autocheck resume failed: reviewer session "${params.sessionId}" was not found.`,
      procResult,
    );
  }

  const parsed =
    params.backend === "claude_code"
      ? parseClaudeReviewerOutput(procResult.stdout)
      : parseCodexReviewerOutput(procResult.stdout);
  const sessionId = parsed.sessionId ?? params.sessionId;
  const decision =
    parsed.decision ??
    ({
      approved: false,
      editInstructions: parseFailureEditInstructions(
        params.backend,
        parsed.text || procResult.stdout,
      ),
    } satisfies AutocheckDecision);

  return {
    stdout: procResult.stdout,
    stderr: procResult.stderr,
    durationMs: procResult.durationMs,
    responseText: parsed.text,
    sessionId,
    decision,
  };
}

function describeError(err: unknown): string {
  if (err instanceof ReviewerCliError) {
    return `${err.message} (exit=${err.exitCode ?? "unknown"}, signal=${err.signal ?? "none"})`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

function clampMaxRounds(value: number | undefined): number {
  if (value == null || Number.isNaN(value)) return DEFAULT_AUTOCHECK_MAX_ROUNDS;
  if (value <= 0) return 0;
  return Math.trunc(value);
}

export async function runPlanAutocheck(params: PlanAutocheckParams): Promise<PlanAutocheckResult> {
  const maxRounds = clampMaxRounds(params.maxRounds);
  const timeoutMs = params.timeoutMs ?? DEFAULT_AUTOCHECK_TIMEOUT_MS;
  const backend = params.mode;
  const autocheckRoot = path.join(params.runDir, "autocheck");
  fs.mkdirSync(autocheckRoot, { recursive: true });

  let currentPlan = params.plan;
  let autocheckRounds = 0;
  let roundNumber = 1;
  let sessionId = normalizeSessionId(params.existingSessionId);
  let sessionBackend = normalizeBackend(params.existingBackend);
  const feedbackHistory: string[] = [];
  const contextNotes: string[] = [];

  if (sessionId && sessionBackend && sessionBackend !== backend) {
    contextNotes.push(
      `Previous reviewer backend was "${sessionBackend}" but current mode is "${backend}". Started a fresh reviewer session.`,
    );
    sessionId = undefined;
    sessionBackend = undefined;
  }

  while (true) {
    const roundDir = path.join(autocheckRoot, `round-${roundNumber}`);
    fs.mkdirSync(roundDir, { recursive: true });

    let prompt = "";
    let attemptLabel = "fresh";
    let resumeAttempted = false;
    let resumeSucceeded = false;
    let resumeFailure: string | undefined;
    let result: ReviewerAttemptResult;

    const canResume = Boolean(sessionId && sessionBackend === backend);
    if (canResume && sessionId) {
      resumeAttempted = true;
      attemptLabel = "resume";
      prompt = buildAutocheckPrompt({
        goalText: params.goalText,
        plan: currentPlan,
        workingDir: params.workingDir,
        resume: true,
        priorFeedback: feedbackHistory,
        contextNotes,
      });

      try {
        result = await runReviewerAttempt({
          backend,
          prompt,
          workingDir: params.workingDir,
          timeoutMs,
          claudeCodeAuth: params.claudeCodeAuth ?? "subscription",
          sessionId,
          model: params.model,
          stdoutPath: path.join(roundDir, `${attemptLabel}.stdout.txt`),
          stderrPath: path.join(roundDir, `${attemptLabel}.stderr.txt`),
        });
        resumeSucceeded = true;
      } catch (err) {
        resumeFailure = describeError(err);
        writeTextArtifact(path.join(roundDir, "resume_failure.txt"), `${resumeFailure}\n`);
        contextNotes.push(
          `Round ${roundNumber}: session resume failed (${resumeFailure}). Started a fresh reviewer session.`,
        );

        attemptLabel = "fresh-fallback";
        prompt = buildAutocheckPrompt({
          goalText: params.goalText,
          plan: currentPlan,
          workingDir: params.workingDir,
          resume: false,
          priorFeedback: feedbackHistory,
          contextNotes,
        });
        result = await runReviewerAttempt({
          backend,
          prompt,
          workingDir: params.workingDir,
          timeoutMs,
          claudeCodeAuth: params.claudeCodeAuth ?? "subscription",
          model: params.model,
          stdoutPath: path.join(roundDir, `${attemptLabel}.stdout.txt`),
          stderrPath: path.join(roundDir, `${attemptLabel}.stderr.txt`),
        });
      }
    } else {
      prompt = buildAutocheckPrompt({
        goalText: params.goalText,
        plan: currentPlan,
        workingDir: params.workingDir,
        resume: false,
        priorFeedback: feedbackHistory,
        contextNotes,
      });
      result = await runReviewerAttempt({
        backend,
        prompt,
        workingDir: params.workingDir,
        timeoutMs,
        claudeCodeAuth: params.claudeCodeAuth ?? "subscription",
        model: params.model,
        stdoutPath: path.join(roundDir, `${attemptLabel}.stdout.txt`),
        stderrPath: path.join(roundDir, `${attemptLabel}.stderr.txt`),
      });
    }

    sessionId = result.sessionId;
    if (sessionId) {
      sessionBackend = backend;
    }

    writeTextArtifact(path.join(roundDir, "prompt.txt"), prompt);
    writeTextArtifact(path.join(roundDir, "response.txt"), result.stdout);
    writeTextArtifact(path.join(roundDir, "response_text.txt"), result.responseText);
    writeTextArtifact(path.join(roundDir, "session_id.txt"), `${sessionId ?? ""}\n`);
    writeTextArtifact(path.join(roundDir, "backend.txt"), `${backend}\n`);
    writeJsonArtifact(path.join(roundDir, "metadata.json"), {
      backend,
      sessionId,
      resumeAttempted,
      resumeSucceeded,
      resumeFailure,
      approved: result.decision.approved,
      durationMs: result.durationMs,
      autocheckRounds,
      round: roundNumber,
    });

    if (result.decision.approved) {
      return {
        plan: currentPlan,
        autocheckRounds,
        autocheckMaxRounds: maxRounds,
        approved: true,
        exhausted: false,
        sessionId,
        backend,
      };
    }

    feedbackHistory.push(result.decision.editInstructions);

    if (autocheckRounds >= maxRounds) {
      return {
        plan: currentPlan,
        autocheckRounds,
        autocheckMaxRounds: maxRounds,
        approved: false,
        exhausted: true,
        sessionId,
        backend,
      };
    }

    const { runId, goalsDir } = resolveRunIdentity(params.runDir);
    const revision = await runCliPlanRevision({
      runId,
      goalsDir,
      goalText: params.goalText,
      currentPlan,
      editInstructions: result.decision.editInstructions,
      priorFeedback: feedbackHistory.slice(0, -1),
      cwd: params.workingDir,
      model: params.model,
      claudeCodeAuth: params.claudeCodeAuth,
    });

    if ("blocked" in revision.plan) {
      writeTextArtifact(
        path.join(roundDir, "revision_blocked.txt"),
        `Autocheck revision blocked: ${revision.plan.question}\n`,
      );
      return {
        plan: currentPlan,
        autocheckRounds,
        autocheckMaxRounds: maxRounds,
        approved: false,
        exhausted: false,
        sessionId,
        backend,
      };
    }

    const previousPlan = currentPlan;
    currentPlan = revision.plan;
    autocheckRounds += 1;
    await params.commitRevision({
      round: autocheckRounds,
      editInstructions: result.decision.editInstructions,
      previousPlan,
      revisedPlan: currentPlan,
    });

    roundNumber += 1;
  }
}
