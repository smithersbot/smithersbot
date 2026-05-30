import fs from "node:fs";
import path from "node:path";
import type { ClaudeCodeAuthMode, CliWorkerId, PlanAutocheckMode } from "../config/types.goal.js";
import {
  DEV_GATEWAY_REVIEW_GUIDANCE,
  REVIEW_INSTRUCTION,
} from "../prompts/plan-autocheck/review-instruction.js";
import {
  appendAgentHistoryEventBestEffort,
  parseBackendUsage,
  writeCriticalAgentLaunchEvent,
  type AgentBackendUsage,
} from "./agent-history-events.js";
import { workspaceNameFromWorkingDir } from "./agent-history.js";
import { isSmithersbotDevWorkspace } from "./dev-gateway-workspace.js";
import {
  detectBackendAvailability,
  getCodexAskForApprovalPlacement,
} from "./backend-availability.js";
import { runWithBackendFallback } from "./phase-fallback.js";
import { buildClaudeCodeEnv, buildCredentialStrippedEnv } from "./claude-code-env.js";
import {
  appendClaudeCodeSandboxArgs,
  appendCodexNativeSandboxExecArgs,
  buildClaudeCodeSandboxLaunchConfig,
  writeCodexNativeSandboxConfig,
  type ClaudeCodeLaunchSandboxConfig,
  type CodexNativeSandboxConfig,
} from "./backend-sandbox.js";
import {
  CLAUDE_ALLOWED_TOOLS_READ_ONLY,
  CLAUDE_READ_ONLY_PROMPT,
} from "./claude-code-constants.js";
import { collectText, isRecord, parseJsonLines } from "./cli-output-parsing.js";
import { runCliPlanRevision } from "./cli-planner.js";
import { runCliProcess, type RunCliProcessResult } from "./cli-process.js";
import { extractJsonObjectCandidates, repairJsonText } from "./json-repair.js";
import { extractJson } from "./planner.js";
import { resolveClaudeBinary } from "./scout.js";
import type { Plan } from "./types.js";
import { assertWorkingDirInsideCurrentInstanceWorkspaces } from "./workspace-policy.js";
import type { GoalConfig } from "../config/types.goal.js";
import { redactSecretValues } from "../security/secret-paths.js";
import { mirrorGoalRuntimeToAgentHistory } from "./runtime-mirror.js";
import { resolveAgentGoalHistoryDir } from "../config/managed-paths.js";

const DEFAULT_AUTOCHECK_MAX_ROUNDS = 3;
const DEFAULT_AUTOCHECK_TIMEOUT_MS = 7_200_000;
const SESSION_NOT_FOUND_RE =
  /(session|thread|conversation|resume)[^.\n\r]{0,80}(not found|unknown|expired|invalid)/i;
const MAX_DETAIL_CHARS = 1_200;

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
  userEditInstructions?: string[];
  mode: PlanAutocheckBackend;
  maxRounds?: number;
  workingDir: string;
  claudeCodeAuth?: ClaudeCodeAuthMode;
  enabledWorkers?: CliWorkerId[];
  readOnlyRoots?: string[];
  runDir: string;
  existingSessionId?: string;
  existingBackend?: string;
  commitRevision: (params: PlanAutocheckCommitRevisionParams) => Promise<void> | void;
  model?: string;
  timeoutMs?: number;
  /**
   * Optional identity override for the up-front executable-workingDir check.
   * Defaults to the running process identity (process.env / os.homedir).
   */
  workspacePolicy?: PlanWorkingDirPolicyOptions;
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

/**
 * Override hooks that let callers/tests deterministically resolve the current
 * gateway instance identity when validating a plan's executable workingDir.
 * Mirrors the shared workspace-policy guard options — identity is taken from
 * the explicit instance/env/homedir helpers, NEVER inferred from the checkout.
 */
export type PlanWorkingDirPolicyOptions = {
  config?: GoalConfig;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  instance?: string | null;
  observedInstances?: Iterable<string> | null;
};

/**
 * Programmatic plan-autocheck layer for the executable goal working directory.
 *
 * Reuses the SAME shared rejection/identity helper as the workspace-policy
 * guard (do not fork): a plan whose workingDir does not resolve inside the
 * current gateway instance's own agent/workspaces tree is rejected with
 * actionable edit instructions that name the rejected path and the correct
 * current-instance workspaces root. This is the up-front autocheck layer — the
 * executor and build gate remain the hard enforcement boundary.
 */
export function checkPlanWorkingDir(
  workingDir: string,
  options: PlanWorkingDirPolicyOptions = {},
): AutocheckDecision {
  try {
    assertWorkingDirInsideCurrentInstanceWorkspaces({ workingDir, ...options });
    return { approved: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      approved: false,
      editInstructions:
        `Reject: the plan workingDir "${workingDir}" is not an allowed executable goal working directory. ` +
        `${detail} ` +
        "Edit the plan so workingDir resolves inside the current gateway instance's own agent/workspaces tree; " +
        "observed/foreign-instance surfaces are read-only context and must not be used as the executable workingDir.",
    };
  }
}

export type PlanAutocheckFailureMetadata = {
  runId: string;
  workingDir: string;
  backend: PlanAutocheckBackend;
  round: number;
  attemptLabel: string;
  reason: string;
  metadataPath: string;
  agentHistoryMetadataPath: string;
  artifactPaths: string[];
};

export class PlanAutocheckError extends Error {
  readonly metadata: PlanAutocheckFailureMetadata;

  constructor(message: string, metadata: PlanAutocheckFailureMetadata, cause?: unknown) {
    super(message, cause instanceof Error ? { cause } : undefined);
    this.name = "PlanAutocheckError";
    this.metadata = metadata;
  }
}

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
      try {
        const parsed = JSON.parse(repairJsonText(trimmed)) as unknown;
        if (!isRecord(parsed)) continue;
        const decision = parseDecisionRecord(parsed);
        if (decision) return decision;
      } catch {
        continue;
      }
    }
  }

  for (const candidate of extractJsonObjectCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!isRecord(parsed)) continue;
      const decision = parseDecisionRecord(parsed);
      if (decision) return decision;
    } catch {
      try {
        const parsed = JSON.parse(repairJsonText(candidate)) as unknown;
        if (!isRecord(parsed)) continue;
        const decision = parseDecisionRecord(parsed);
        if (decision) return decision;
      } catch {
        continue;
      }
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
  sandboxConfig: ClaudeCodeLaunchSandboxConfig;
  sessionId?: string;
  model?: string;
}): string[] {
  const args = [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--allowedTools",
    CLAUDE_ALLOWED_TOOLS_READ_ONLY,
    "--append-system-prompt",
    CLAUDE_READ_ONLY_PROMPT,
  ];
  appendClaudeCodeSandboxArgs(args, params.sandboxConfig);
  if (params.model) args.push("--model", params.model);
  if (params.sessionId) args.push("--resume", params.sessionId);
  args.push(params.prompt);
  return args;
}

function buildCodexReviewerArgs(params: {
  prompt: string;
  workingDir: string;
  sandboxConfig: CodexNativeSandboxConfig;
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
    args.push("--json", "--color", "never");
    appendCodexNativeSandboxExecArgs(args, params.sandboxConfig);
  }

  if (params.model) {
    args.push("--model", params.model);
  }

  args.push(params.prompt);
  return args;
}

function sanitizeReviewerArgvForHistory(args: readonly string[]): string[] {
  const sanitized = [...args];
  for (let index = 0; index < sanitized.length; index += 1) {
    const arg = sanitized[index];
    if (arg === "--append-system-prompt" && index + 1 < sanitized.length) {
      sanitized[index + 1] = "<append-system-prompt redacted; see prompt artifact>";
      index += 1;
    }
  }
  if (sanitized.length > 0) {
    sanitized[sanitized.length - 1] = "<prompt redacted; see prompt artifact>";
  }
  return sanitized;
}

function appendAutocheckHistoryBestEffort(params: {
  workingDir: string;
  runId: string;
  backend: PlanAutocheckBackend;
  event: string;
  status?: string;
  round: number;
  attemptLabel: string;
  tokenUsage?: AgentBackendUsage;
  errorClass?: string;
  outputSummary?: string;
  artifactPaths?: readonly string[];
  extra?: Record<string, unknown>;
}): void {
  appendAgentHistoryEventBestEffort(
    {
      kind: "goal",
      workspaceName: workspaceNameFromWorkingDir(params.workingDir),
      goalId: params.runId,
    },
    {
      event: params.event,
      phase: "autocheck",
      backend: params.backend,
      runId: params.runId,
      goalId: params.runId,
      status: params.status,
      attemptNumber: params.round,
      tokenUsage: params.tokenUsage,
      errorClass: params.errorClass,
      outputSummary: params.outputSummary,
      artifactPaths: params.artifactPaths,
      round: params.round,
      attemptLabel: params.attemptLabel,
      ...params.extra,
    },
  );
}

function mirrorAutocheckRuntimeBestEffort(params: {
  workingDir: string;
  runId: string;
  goalsDir: string;
  round: number;
}): void {
  const scope = {
    kind: "goal" as const,
    workspaceName: workspaceNameFromWorkingDir(params.workingDir),
    goalId: params.runId,
  };
  try {
    mirrorGoalRuntimeToAgentHistory({
      workspaceName: scope.workspaceName,
      goalId: params.runId,
      goalsDir: params.goalsDir,
    });
  } catch (error) {
    appendAgentHistoryEventBestEffort(scope, {
      event: "runtime_mirror_warning",
      phase: "autocheck",
      runId: params.runId,
      goalId: params.runId,
      status: "warning",
      attemptNumber: params.round,
      round: params.round,
      errorClass: error instanceof Error ? error.name : "runtime_mirror_error",
      outputSummary: `Runtime mirror failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
}

function resolveRunIdentity(runDir: string): { runId: string; goalsDir: string } {
  const absoluteRunDir = path.resolve(runDir);
  const runId = path.basename(absoluteRunDir);
  const goalsDir = path.dirname(absoluteRunDir);
  return { runId, goalsDir };
}

function summarizeFeedback(history: string[]): string {
  if (history.length === 0) return "None.";
  const compact = history
    .slice(-3)
    .map((entry) => truncateDetail(entry))
    .filter(Boolean);
  const omitted = history.length - compact.length;
  return [
    omitted > 0
      ? `Earlier feedback omitted for compactness: ${omitted} entr${omitted === 1 ? "y" : "ies"}.`
      : undefined,
    ...compact.map((entry, idx) => `${idx + 1}. ${entry}`),
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
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
        requiresNetwork: step.requiresNetwork,
      })),
    },
    null,
    2,
  );
}

function buildUserEditInstructionsSection(userEditInstructions: string[] | undefined): string[] {
  const normalizedInstructions = (userEditInstructions ?? [])
    .map((instruction) => instruction.trim())
    .filter(Boolean);
  if (normalizedInstructions.length === 0) return [];
  return [
    "User-requested changes (treat as authoritative requirements):",
    ...normalizedInstructions.map((instruction, idx) => `${idx + 1}. ${instruction}`),
    "",
  ];
}

export function buildAutocheckPrompt(params: {
  goalText: string;
  plan: Plan;
  workingDir: string;
  resume: boolean;
  priorFeedback: string[];
  contextNotes: string[];
  userEditInstructions?: string[];
}): string {
  const snapshot = buildPlanSnapshot(params.plan);
  const userEditInstructionsSection = buildUserEditInstructionsSection(params.userEditInstructions);
  // Guidance only — detect the dev checkout from the working dir to require
  // dev-gateway verification for runtime-affecting changes. Never flips runtime
  // instance config (see src/config/gateway-instance.ts).
  const devGatewaySection = isSmithersbotDevWorkspace(params.workingDir)
    ? [DEV_GATEWAY_REVIEW_GUIDANCE, ""]
    : [];

  if (params.resume) {
    return [
      REVIEW_INSTRUCTION,
      "",
      ...devGatewaySection,
      "You are continuing plan review in an existing reviewer session.",
      "Re-review this updated plan and answer: Is this plan ready to execute?",
      "",
      "Original goal (verbatim):",
      params.goalText,
      "",
      ...userEditInstructionsSection,
      "Scout facts/artifact references:",
      "No compact scout facts were provided to this autocheck round.",
      "",
      "Updated plan JSON:",
      snapshot,
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
    REVIEW_INSTRUCTION,
    "",
    ...devGatewaySection,
    "You are an independent plan reviewer.",
    "Question: Is this plan ready to execute?",
    "",
    "Original goal (verbatim):",
    params.goalText,
    "",
    ...userEditInstructionsSection,
    ...contextSection,
    ...feedbackSection,
    "Scout facts/artifact references:",
    "No compact scout facts were provided to this autocheck round.",
    "",
    "Current plan JSON:",
    snapshot,
  ].join("\n");
}

function writeTextArtifact(filePath: string, value: string): void {
  try {
    fs.writeFileSync(filePath, redactSecretValues(value), "utf8");
  } catch {
    // Best-effort diagnostics.
  }
}

function writeJsonArtifact(filePath: string, value: unknown): void {
  try {
    fs.writeFileSync(filePath, redactSecretValues(`${JSON.stringify(value, null, 2)}\n`), "utf8");
  } catch {
    // Best-effort diagnostics.
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function collectRoundArtifactPaths(roundDir: string): string[] {
  try {
    return fs
      .readdirSync(roundDir)
      .filter(
        (name) =>
          name.endsWith(".stdout.txt") ||
          name.endsWith(".stderr.txt") ||
          name.endsWith("_failure.txt") ||
          name === "failure.txt",
      )
      .sort()
      .map((name) => path.join(roundDir, name));
  } catch {
    return [];
  }
}

function agentHistoryRuntimePath(params: {
  workingDir: string;
  runId: string;
  runDir: string;
  artifactPath: string;
}): string {
  const workspaceName = workspaceNameFromWorkingDir(params.workingDir);
  return path.join(
    resolveAgentGoalHistoryDir(workspaceName, params.runId),
    "runtime",
    path.relative(params.runDir, params.artifactPath),
  );
}

function redactTextArtifactIfExists(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    fs.writeFileSync(filePath, redactSecretValues(fs.readFileSync(filePath, "utf8")), "utf8");
  } catch {
    // Best-effort diagnostics.
  }
}

function redactDecision(decision: AutocheckDecision): AutocheckDecision {
  if (decision.approved) return decision;
  return { approved: false, editInstructions: redactSecretValues(decision.editInstructions) };
}

async function runReviewerAttempt(params: {
  backend: PlanAutocheckBackend;
  prompt: string;
  workingDir: string;
  runId: string;
  round: number;
  attemptLabel: string;
  timeoutMs: number;
  claudeCodeAuth: ClaudeCodeAuthMode;
  readOnlyRoots?: string[];
  sessionId?: string;
  model?: string;
  stdoutPath: string;
  stderrPath: string;
}): Promise<ReviewerAttemptResult> {
  const command = params.backend === "claude_code" ? resolveClaudeBinary() : "codex";
  if (!command) {
    throw new Error("claude binary not found on PATH");
  }
  const claudeSandbox =
    params.backend === "claude_code"
      ? buildClaudeCodeSandboxLaunchConfig({
          workingDir: params.workingDir,
          runId: `${params.runId}-autocheck-r${params.round}-${params.attemptLabel}`,
          purpose: "repo-chat",
          readOnlyRoots: params.readOnlyRoots,
        })
      : undefined;
  const codexSandbox =
    params.backend === "codex"
      ? writeCodexNativeSandboxConfig({
          workingDir: params.workingDir,
          runId: `${params.runId}-autocheck-r${params.round}-${params.attemptLabel}`,
          purpose: "repo-chat",
          readOnlyRoots: params.readOnlyRoots,
          sandboxRoot: process.env.SMITHERSBOT_CODEX_SANDBOX_ROOT,
        })
      : undefined;

  const args =
    params.backend === "claude_code"
      ? buildClaudeReviewerArgs({
          prompt: params.prompt,
          sandboxConfig: claudeSandbox!,
          sessionId: params.sessionId,
          model: params.model,
        })
      : buildCodexReviewerArgs({
          prompt: params.prompt,
          workingDir: params.workingDir,
          sandboxConfig: codexSandbox!,
          sessionId: params.sessionId,
          model: params.model,
        });

  const launchHistory = writeCriticalAgentLaunchEvent({
    scope: {
      kind: "goal",
      workspaceName: workspaceNameFromWorkingDir(params.workingDir),
      goalId: params.runId,
    },
    phase: "autocheck",
    backend: params.backend,
    prompt: params.prompt,
    command,
    argv: sanitizeReviewerArgvForHistory(args),
    event: {
      runId: params.runId,
      goalId: params.runId,
      attemptNumber: params.round,
      status: "launching",
      round: params.round,
      attemptLabel: params.attemptLabel,
      sessionId: params.sessionId,
    },
  });

  const procResult = await runCliProcess({
    command,
    args,
    // Run reviewers from the project workspace so CLAUDE.md/AGENTS.md discovery stays consistent.
    cwd: params.workingDir,
    timeoutMs: params.timeoutMs,
    stdoutPath: params.stdoutPath,
    stderrPath: params.stderrPath,
    env:
      params.backend === "claude_code"
        ? buildClaudeCodeEnv(params.claudeCodeAuth)
        : {
            ...buildCredentialStrippedEnv(process.env, { stripAuthKeys: true }),
            CODEX_HOME: codexSandbox?.env.CODEX_HOME,
            PATH: codexSandbox?.env.PATH,
          },
  });
  redactTextArtifactIfExists(params.stdoutPath);
  redactTextArtifactIfExists(params.stderrPath);
  const tokenUsage = parseBackendUsage(`${procResult.stdout}\n${procResult.stderr}`);

  if (procResult.timedOut) {
    appendAutocheckHistoryBestEffort({
      workingDir: params.workingDir,
      runId: params.runId,
      backend: params.backend,
      event: "failure",
      status: "timeout",
      round: params.round,
      attemptLabel: params.attemptLabel,
      tokenUsage,
      errorClass: "timeout",
      outputSummary: describeCliFailure(procResult),
      artifactPaths: [params.stdoutPath, params.stderrPath, launchHistory.promptArtifactPath],
    });
    throw new ReviewerCliError(
      `Plan autocheck worker timed out after ${(params.timeoutMs / 60_000).toFixed(0)} minutes.`,
      procResult,
    );
  }

  if ((procResult.exitCode && procResult.exitCode !== 0) || procResult.signal) {
    appendAutocheckHistoryBestEffort({
      workingDir: params.workingDir,
      runId: params.runId,
      backend: params.backend,
      event: "failure",
      status: "crash",
      round: params.round,
      attemptLabel: params.attemptLabel,
      tokenUsage,
      errorClass: procResult.signal ? "signal" : "exit_code",
      outputSummary: describeCliFailure(procResult),
      artifactPaths: [params.stdoutPath, params.stderrPath, launchHistory.promptArtifactPath],
      extra: { exitCode: procResult.exitCode, signal: procResult.signal },
    });
    throw new ReviewerCliError(
      `Plan autocheck worker failed: ${describeCliFailure(procResult)}`,
      procResult,
    );
  }

  if (params.sessionId && SESSION_NOT_FOUND_RE.test(`${procResult.stderr}\n${procResult.stdout}`)) {
    appendAutocheckHistoryBestEffort({
      workingDir: params.workingDir,
      runId: params.runId,
      backend: params.backend,
      event: "failure",
      status: "session_not_found",
      round: params.round,
      attemptLabel: params.attemptLabel,
      tokenUsage,
      errorClass: "session_not_found",
      outputSummary: `reviewer session "${params.sessionId}" was not found`,
      artifactPaths: [params.stdoutPath, params.stderrPath, launchHistory.promptArtifactPath],
    });
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
  appendAutocheckHistoryBestEffort({
    workingDir: params.workingDir,
    runId: params.runId,
    backend: params.backend,
    event: "result",
    status: decision.approved ? "approved" : "rejected",
    round: params.round,
    attemptLabel: params.attemptLabel,
    tokenUsage,
    outputSummary: truncateDetail(parsed.text || procResult.stdout),
    artifactPaths: [params.stdoutPath, params.stderrPath, launchHistory.promptArtifactPath],
    extra: {
      sessionId,
      durationMs: procResult.durationMs,
    },
  });

  return {
    stdout: redactSecretValues(procResult.stdout),
    stderr: redactSecretValues(procResult.stderr),
    durationMs: procResult.durationMs,
    responseText: redactSecretValues(parsed.text),
    sessionId,
    decision: redactDecision(decision),
  };
}

function describeError(err: unknown): string {
  if (err instanceof ReviewerCliError) {
    return `${err.message} (exit=${err.exitCode ?? "unknown"}, signal=${err.signal ?? "none"})`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Run a fresh (no-session) reviewer attempt for the configured backend, falling
 * back once to the other backend on a usage/rate limit when it is available on
 * PATH. The fallback always starts fresh; if it is used, the returned sessionId
 * is cleared so later rounds do not try to resume a session bound to a backend
 * the caller is not tracking. Each backend is tried at most once.
 */
async function runFreshReviewerAttempt(params: {
  backend: PlanAutocheckBackend;
  prompt: string;
  workingDir: string;
  runId: string;
  round: number;
  timeoutMs: number;
  claudeCodeAuth: ClaudeCodeAuthMode;
  readOnlyRoots?: string[];
  model?: string;
  roundDir: string;
  attemptLabel: string;
  onProgress?: (text: string) => void;
}): Promise<ReviewerAttemptResult> {
  const primary = params.backend;
  const other: PlanAutocheckBackend = primary === "claude_code" ? "codex" : "claude_code";
  const otherAvailable =
    detectBackendAvailability().find((entry) => entry.id === other)?.available === true;
  const backends: PlanAutocheckBackend[] = otherAvailable ? [primary, other] : [primary];

  let lastError: unknown;
  const outcome = await runWithBackendFallback<{
    result: ReviewerAttemptResult;
    usedBackend: PlanAutocheckBackend;
  }>({
    backends,
    onProgress: params.onProgress,
    attempt: async (backend) => {
      const labelSuffix =
        backend === primary ? params.attemptLabel : `${params.attemptLabel}.fallback-${backend}`;
      try {
        const result = await runReviewerAttempt({
          backend,
          prompt: params.prompt,
          workingDir: params.workingDir,
          runId: params.runId,
          round: params.round,
          attemptLabel: labelSuffix,
          timeoutMs: params.timeoutMs,
          claudeCodeAuth: params.claudeCodeAuth,
          readOnlyRoots: params.readOnlyRoots,
          model: params.model,
          stdoutPath: path.join(params.roundDir, `${labelSuffix}.stdout.txt`),
          stderrPath: path.join(params.roundDir, `${labelSuffix}.stderr.txt`),
        });
        return { ok: true, value: { result, usedBackend: backend } };
      } catch (err) {
        lastError = err;
        appendAutocheckHistoryBestEffort({
          workingDir: params.workingDir,
          runId: params.runId,
          backend,
          event: "fallback",
          status: "backend_failed",
          round: params.round,
          attemptLabel: labelSuffix,
          errorClass: err instanceof Error ? err.name : "error",
          outputSummary: describeError(err),
        });
        return { ok: false, errorText: describeError(err) };
      }
    },
  });

  if (outcome.status === "success") {
    const { result, usedBackend } = outcome.value;
    // Clear the session id on cross-backend fallback so resume stays consistent.
    return usedBackend === primary ? result : { ...result, sessionId: undefined };
  }

  // Preserve the original error type for non-usage failures; otherwise surface
  // the consolidated usage-limit history.
  if (outcome.usageLimitEvents.length > 0) {
    throw new Error(outcome.message);
  }
  throw lastError ?? new Error("Plan autocheck reviewer attempt failed.");
}

function clampMaxRounds(value: number | undefined): number {
  if (value == null || Number.isNaN(value)) return DEFAULT_AUTOCHECK_MAX_ROUNDS;
  if (value <= 0) return 0;
  return Math.trunc(value);
}

function recordAutocheckFailure(params: {
  runId: string;
  goalsDir: string;
  runDir: string;
  workingDir: string;
  backend: PlanAutocheckBackend;
  round: number;
  attemptLabel: string;
  roundDir: string;
  err: unknown;
}): PlanAutocheckError {
  const reason = redactSecretValues(describeError(params.err));
  const failurePath = path.join(params.roundDir, "failure.txt");
  const metadataPath = path.join(params.roundDir, "metadata.json");
  writeTextArtifact(failurePath, `${reason}\n`);
  const artifactPaths = uniqueStrings([...collectRoundArtifactPaths(params.roundDir), failurePath]);
  const metadata: PlanAutocheckFailureMetadata = {
    runId: params.runId,
    workingDir: params.workingDir,
    backend: params.backend,
    round: params.round,
    attemptLabel: params.attemptLabel,
    reason,
    metadataPath,
    agentHistoryMetadataPath: agentHistoryRuntimePath({
      workingDir: params.workingDir,
      runId: params.runId,
      runDir: params.runDir,
      artifactPath: metadataPath,
    }),
    artifactPaths,
  };
  writeJsonArtifact(metadataPath, {
    backend: params.backend,
    approved: false,
    round: params.round,
    attemptLabel: params.attemptLabel,
    failure: {
      reason,
      metadataPath,
      agentHistoryMetadataPath: metadata.agentHistoryMetadataPath,
      artifactPaths,
    },
  });
  mirrorAutocheckRuntimeBestEffort({
    workingDir: params.workingDir,
    runId: params.runId,
    goalsDir: params.goalsDir,
    round: params.round,
  });
  return new PlanAutocheckError(`Plan autocheck failed: ${reason}`, metadata, params.err);
}

/**
 * Run the plan reviewer in up to `maxRounds` revision rounds.
 *
 * Reviewer session reuse semantics (verified by plan-autocheck.test.ts):
 * - SESSION REUSE: the reviewer session id returned by a round is carried into
 *   the next round and resumed (`--resume`/`exec resume`) so round 2+ continue
 *   the same conversation instead of starting fresh. `existingSessionId` lets a
 *   resumed run continue a session created before a restart.
 * - BACKEND-BOUND: a session id is only reused when its backend matches the
 *   current `mode`. A backend switch (stored `existingBackend` !== `mode`, or a
 *   cross-backend usage-limit fallback) clears the incompatible session id and
 *   starts fresh, recording a context note rather than resuming.
 * - HISTORY PRESERVED ACROSS REVISIONS: `feedbackHistory` accumulates each
 *   round's edit instructions and is forwarded to the planner revision as
 *   `priorFeedback` (earlier rounds only), so a revision never discards prior
 *   autocheck feedback.
 * - PER-ROUND INSTRUMENTATION: every reviewer attempt records launch + result
 *   agent-history events (with token usage) and a per-round `round` event.
 */
export async function runPlanAutocheck(params: PlanAutocheckParams): Promise<PlanAutocheckResult> {
  const maxRounds = clampMaxRounds(params.maxRounds);
  const timeoutMs = params.timeoutMs ?? DEFAULT_AUTOCHECK_TIMEOUT_MS;
  const backend = params.mode;
  const { runId, goalsDir } = resolveRunIdentity(params.runDir);
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

    // Up-front, programmatic executable-workingDir guard. A plan whose
    // workingDir escapes the current instance's own agent/workspaces tree is
    // rejected here (before spawning the reviewer) and fed into the revision
    // loop with actionable edit instructions, using the SAME shared helper as
    // the executor/build-gate hard stop. Active when a workspacePolicy identity
    // is supplied (the gateway threads the running-instance identity); callers
    // that have already validated the workingDir upstream may omit it.
    const workingDirDecision = params.workspacePolicy
      ? checkPlanWorkingDir(currentPlan.workingDir, params.workspacePolicy)
      : ({ approved: true } as AutocheckDecision);
    if (!workingDirDecision.approved) {
      writeTextArtifact(
        path.join(roundDir, "workingdir_rejection.txt"),
        `${workingDirDecision.editInstructions}\n`,
      );
      appendAutocheckHistoryBestEffort({
        workingDir: params.workingDir,
        runId,
        backend,
        event: "result",
        status: "rejected",
        round: roundNumber,
        attemptLabel: "workingdir-guard",
        outputSummary: workingDirDecision.editInstructions,
      });
      result = {
        stdout: workingDirDecision.editInstructions,
        stderr: "",
        durationMs: 0,
        responseText: workingDirDecision.editInstructions,
        sessionId,
        decision: workingDirDecision,
      };
    } else {
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
          userEditInstructions: params.userEditInstructions,
        });

        try {
          result = await runReviewerAttempt({
            backend,
            prompt,
            workingDir: params.workingDir,
            runId,
            round: roundNumber,
            attemptLabel,
            timeoutMs,
            claudeCodeAuth: params.claudeCodeAuth ?? "subscription",
            readOnlyRoots: params.readOnlyRoots,
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
            userEditInstructions: params.userEditInstructions,
          });
          try {
            result = await runFreshReviewerAttempt({
              backend,
              prompt,
              workingDir: params.workingDir,
              runId,
              round: roundNumber,
              timeoutMs,
              claudeCodeAuth: params.claudeCodeAuth ?? "subscription",
              readOnlyRoots: params.readOnlyRoots,
              model: params.model,
              roundDir,
              attemptLabel,
            });
          } catch (freshErr) {
            const freshFallbackFailure = describeError(freshErr);
            writeTextArtifact(
              path.join(roundDir, "fresh_fallback_failure.txt"),
              `${freshFallbackFailure}\n`,
            );
            const warning =
              `Round ${roundNumber}: fresh reviewer fallback also failed (${freshFallbackFailure}). ` +
              "Auto-approving plan to keep execution unblocked; verify results via the build/test/lint gate.";
            contextNotes.push(warning);
            result = {
              stdout: warning,
              stderr: freshFallbackFailure,
              durationMs: 0,
              responseText: warning,
              sessionId: undefined,
              decision: { approved: true },
            };
          }
        }
      } else {
        prompt = buildAutocheckPrompt({
          goalText: params.goalText,
          plan: currentPlan,
          workingDir: params.workingDir,
          resume: false,
          priorFeedback: feedbackHistory,
          contextNotes,
          userEditInstructions: params.userEditInstructions,
        });
        try {
          result = await runFreshReviewerAttempt({
            backend,
            prompt,
            workingDir: params.workingDir,
            runId,
            round: roundNumber,
            timeoutMs,
            claudeCodeAuth: params.claudeCodeAuth ?? "subscription",
            readOnlyRoots: params.readOnlyRoots,
            model: params.model,
            roundDir,
            attemptLabel,
          });
        } catch (err) {
          throw recordAutocheckFailure({
            runId,
            goalsDir,
            runDir: params.runDir,
            workingDir: params.workingDir,
            backend,
            round: roundNumber,
            attemptLabel,
            roundDir,
            err,
          });
        }
      }
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
    mirrorAutocheckRuntimeBestEffort({
      workingDir: params.workingDir,
      runId,
      goalsDir,
      round: roundNumber,
    });

    if (result.decision.approved) {
      appendAutocheckHistoryBestEffort({
        workingDir: params.workingDir,
        runId,
        backend,
        event: "round",
        status: "approved",
        round: roundNumber,
        attemptLabel,
        outputSummary: "Plan autocheck approved the plan.",
        extra: { sessionId, autocheckRounds },
      });
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
      appendAutocheckHistoryBestEffort({
        workingDir: params.workingDir,
        runId,
        backend,
        event: "round",
        status: "exhausted",
        round: roundNumber,
        attemptLabel,
        outputSummary: result.decision.editInstructions,
        extra: { sessionId, autocheckRounds, autocheckMaxRounds: maxRounds },
      });
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

    let revision: Awaited<ReturnType<typeof runCliPlanRevision>>;
    try {
      revision = await runCliPlanRevision({
        runId,
        goalsDir,
        goalText: params.goalText,
        currentPlan,
        editInstructions: result.decision.editInstructions,
        priorFeedback: feedbackHistory.slice(0, -1),
        cwd: params.workingDir,
        model: params.model,
        claudeCodeAuth: params.claudeCodeAuth,
        ...(params.enabledWorkers ? { enabledWorkers: params.enabledWorkers } : {}),
      });
    } catch (err) {
      const revisionError = `Autocheck revision failed: ${describeError(err)}`;
      writeTextArtifact(path.join(roundDir, "revision_error.txt"), `${revisionError}\n`);
      appendAutocheckHistoryBestEffort({
        workingDir: params.workingDir,
        runId,
        backend,
        event: "round",
        status: "revision_failed",
        round: roundNumber,
        attemptLabel,
        errorClass: err instanceof Error ? err.name : "error",
        outputSummary: revisionError,
        extra: { sessionId, autocheckRounds },
      });
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

    if ("blocked" in revision.plan) {
      writeTextArtifact(
        path.join(roundDir, "revision_blocked.txt"),
        `Autocheck revision blocked: ${revision.plan.question}\n`,
      );
      appendAutocheckHistoryBestEffort({
        workingDir: params.workingDir,
        runId,
        backend,
        event: "round",
        status: "revision_blocked",
        round: roundNumber,
        attemptLabel,
        outputSummary: revision.plan.question,
        extra: { sessionId, autocheckRounds },
      });
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
    appendAutocheckHistoryBestEffort({
      workingDir: params.workingDir,
      runId,
      backend,
      event: "round",
      status: "revision_committed",
      round: roundNumber,
      attemptLabel,
      outputSummary: result.decision.editInstructions,
      extra: { sessionId, autocheckRounds },
    });

    roundNumber += 1;
  }
}
