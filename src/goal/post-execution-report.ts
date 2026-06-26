import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CliWorkerId, ClaudeCodeAuthMode } from "../config/types.goal.js";
import { resolveAgentGoalHistoryDir } from "../config/managed-paths.js";
import { redactSecretValues } from "../security/secret-paths.js";
import {
  appendCodexNativeSandboxExecArgs,
  appendClaudeCodeSandboxArgs,
  buildClaudeCodeSandboxLaunchConfig,
  mergeCodexNativeSandboxEnv,
  writeCodexNativeSandboxConfig,
  type ClaudeCodeLaunchSandboxConfig,
  type CodexNativeSandboxConfig,
} from "./backend-sandbox.js";
import { getCodexAskForApprovalPlacement } from "./backend-availability.js";
import {
  CLAUDE_ALLOWED_TOOLS_READ_ONLY,
  CLAUDE_READ_ONLY_PROMPT,
} from "./claude-code-constants.js";
import { buildClaudeCodeEnv, buildCredentialStrippedEnv } from "./claude-code-env.js";
import { extractCliTextAndSession, isRecord } from "./cli-output-parsing.js";
import { runCliProcess, type RunCliProcessResult } from "./cli-process.js";
import { workspaceNameFromWorkingDir } from "./agent-history.js";
import { appendAgentHistoryEvent, writeAgentPromptArtifact } from "./agent-history-events.js";
import {
  extractGoalBriefSection,
  loadGoalBriefContent,
  resolveStoredGoalBriefPath,
} from "./goal-brief.js";
import { resolveHistoryWorkspaceSlug } from "./history-anchor.js";
import { extractJsonObjectCandidates, repairJsonText } from "./json-repair.js";
import { buildFallbackManualTestsForSteps } from "./manual-tests.js";
import { extractJson } from "./planner.js";
import { runWithBackendFallback, type PhaseFallbackResult } from "./phase-fallback.js";
import { resolveClaudeBinary, SCOUT_REPORT_FILE } from "./scout.js";
import type { Plan, SerializedRun, WorkerSummaryReference } from "./types.js";

export const POST_EXECUTION_REPORT_MARKDOWN_FILENAME = "post-execution-report.md";
export const POST_EXECUTION_REPORT_JSON_FILENAME = "post-execution-report.json";

const DEFAULT_POST_EXECUTION_TIMEOUT_MS = 300_000;
const POST_EXECUTION_CONTEXT_TEXT_CHARS = 260;
const POST_EXECUTION_BUILD_GATE_OUTPUT_CHARS = 1_200;
const SESSION_NOT_FOUND_RE =
  /(session|thread|conversation|resume)[^.\n\r]{0,80}(not found|unknown|expired|invalid)/i;
const JSON_RETRY_PROMPT =
  "Your previous message was not valid JSON. Resend ONLY the JSON object this phase requested, with no prose or code fences.";

export const PostExecutionManualTestSchema = z.object({
  description: z.string().min(1),
  criticality: z.number().int().min(1).max(10).default(5),
  reason: z.string().min(1).optional(),
  detail: z.string().min(1),
});

export const PostExecutionDecisionSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string().min(1)).default([]),
  recommendedOption: z.string().min(1).nullable().optional(),
  rationale: z.string().min(1).optional(),
  promptImpact: z.string().min(1).optional(),
});

export const PostExecutionReportSchema = z.object({
  planCompleted: z.boolean(),
  goalAchieved: z.boolean(),
  summary: z.string().min(1),
  filesChanged: z.array(z.string().min(1)).default([]),
  verificationCommands: z.array(z.string().min(1)).default([]),
  manualTests: z.array(PostExecutionManualTestSchema).default([]),
  nextPlanRecommended: z.boolean(),
  nextPlanSummary: z.string().min(1).nullable().default(null),
  nextPlanPrompt: z.string().min(1).nullable().default(null),
  decisionsNeeded: z.array(PostExecutionDecisionSchema).default([]),
  failureOrBlockedReason: z.string().min(1).nullable().default(null),
});

export const PostExecutionManualTestDisplaySchema = z.object({
  manualTests: z.array(PostExecutionManualTestSchema).default([]),
  displayMarkdown: z.string().default(""),
});

export const PostExecutionContinuationDecisionSchema = z.object({
  goalAchieved: z.boolean(),
  nextPlanRecommended: z.boolean(),
  nextPlanSummary: z.string().min(1).nullable().default(null),
  nextPlanPrompt: z.string().min(1).nullable().default(null),
  decisionsNeeded: z.array(PostExecutionDecisionSchema).default([]),
  failureOrBlockedReason: z.string().min(1).nullable().default(null),
});

export type PostExecutionManualTest = z.infer<typeof PostExecutionManualTestSchema>;
export type PostExecutionDecision = z.infer<typeof PostExecutionDecisionSchema>;
export type PostExecutionReport = z.infer<typeof PostExecutionReportSchema>;
export type PostExecutionManualTestDisplay = z.infer<typeof PostExecutionManualTestDisplaySchema>;
export type PostExecutionContinuationDecision = z.infer<
  typeof PostExecutionContinuationDecisionSchema
>;

export type PostExecutionReportArtifactPaths = {
  historyDir: string;
  markdownPath: string;
  jsonPath: string;
};

export type PostExecutionPhaseName =
  | "generateReport"
  | "prepareManualTestDisplay"
  | "decideContinuation";

type PhaseSessionParams = {
  backend: CliWorkerId;
  sessionId?: string;
};

type BasePhaseParams = PhaseSessionParams & {
  runId: string;
  goal: string;
  plan: Plan;
  workingDir: string;
  model?: string;
  timeoutMs?: number;
  claudeCodeAuth?: ClaudeCodeAuthMode;
  readOnlyRoots?: string[];
  enabledBackends?: CliWorkerId[];
  serializedRun?: SerializedRun;
  workerSummaries?: WorkerSummaryReference[];
  buildGateResults?: SerializedRun["buildGateResults"];
  onProgress?: (text: string) => void;
};

export type GenerateReportParams = BasePhaseParams & {
  completionSummary?: string;
};

export type ReportContinuationPhaseParams = BasePhaseParams & {
  report: PostExecutionReport;
  artifacts: PostExecutionReportArtifactPaths;
};

type PhaseSuccessBase = {
  backend: CliWorkerId;
  sessionId?: string;
  usageLimitEvents: PhaseFallbackResult<unknown>["usageLimitEvents"];
  recoveryMessage?: string;
};

export type GenerateReportResult =
  | ({
      status: "success";
      report: PostExecutionReport;
      markdown: string;
      artifacts: PostExecutionReportArtifactPaths;
    } & PhaseSuccessBase)
  | PostExecutionReportingFailure;

export type ManualTestDisplayResult =
  | ({
      status: "success";
      display: PostExecutionManualTestDisplay;
    } & PhaseSuccessBase)
  | PostExecutionReportingFailure;

export type ContinuationDecisionResult =
  | ({
      status: "success";
      continuation: PostExecutionContinuationDecision;
    } & PhaseSuccessBase)
  | PostExecutionReportingFailure;

export type PostExecutionReportingFailure = {
  status: "failed";
  phase: PostExecutionPhaseName;
  reason: string;
  usageLimitEvents: PhaseFallbackResult<unknown>["usageLimitEvents"];
  lastErrorText: string;
  artifacts?: PostExecutionReportArtifactPaths;
};

export type RunPostExecutionReportingParams = GenerateReportParams;

export type RunPostExecutionReportingResult =
  | {
      status: "success";
      report: PostExecutionReport;
      markdown: string;
      artifacts: PostExecutionReportArtifactPaths;
      manualTestDisplay: PostExecutionManualTestDisplay;
      continuation: PostExecutionContinuationDecision;
      backend: CliWorkerId;
      sessionId?: string;
    }
  | PostExecutionReportingFailure;

type ReportCliAttemptResult = {
  text: string;
  sessionId?: string;
};

type GenerateReportPayload = {
  report: PostExecutionReport;
  markdown: string;
};

function reportPromptHistoryKind(
  phase: PostExecutionPhaseName,
): "report" | "manual-test" | "continuation" {
  if (phase === "prepareManualTestDisplay") return "manual-test";
  if (phase === "decideContinuation") return "continuation";
  return "report";
}

function reportPromptReferencePhaseLabel(phase: PostExecutionPhaseName): string {
  if (phase === "prepareManualTestDisplay") return "prepare manual-test display data";
  if (phase === "decideContinuation") return "decide continuation";
  return "post-execution report generation";
}

function buildPromptArtifactInstruction(params: {
  phase: PostExecutionPhaseName;
  promptArtifactPath: string;
}): string {
  return [
    `Native lifecycle phase: ${reportPromptReferencePhaseLabel(params.phase)}.`,
    "Read the complete post-execution prompt from this agent-history artifact path:",
    params.promptArtifactPath,
    "Follow that prompt exactly and return only the response shape it requests.",
    "Do not modify files. Do not rerun completed plan steps.",
  ].join("\n");
}

export function resolvePostExecutionReportArtifactPaths(params: {
  workingDir: string;
  runId: string;
  historyWorkspaceSlug?: string;
  serializedRun?: Pick<SerializedRun, "runId" | "workingDir" | "historyWorkspaceSlug">;
}): PostExecutionReportArtifactPaths {
  const workspaceSlug =
    params.historyWorkspaceSlug ??
    (params.serializedRun
      ? resolveHistoryWorkspaceSlug(params.serializedRun)
      : workspaceNameFromWorkingDir(params.workingDir));
  const historyDir = resolveAgentGoalHistoryDir(workspaceSlug, params.runId);
  return {
    historyDir,
    markdownPath: path.join(historyDir, POST_EXECUTION_REPORT_MARKDOWN_FILENAME),
    jsonPath: path.join(historyDir, POST_EXECUTION_REPORT_JSON_FILENAME),
  };
}

export function renderPostExecutionReportMarkdown(report: PostExecutionReport): string {
  // The Outcome facts use a literal "• " bullet (not a markdown "- " list) so
  // they stay part of the same paragraph as the "**Outcome:**" label when the
  // markdown is rendered for Telegram. A markdown list would otherwise force a
  // paragraph break, inserting a blank line between the label and its first
  // bullet (see markdownToIR's paragraph separator).
  const lines: string[] = [
    "**Post-Execution Report:**",
    `**Summary:** ${report.summary}`,
    "**Outcome:**",
    `• Plan completed: ${report.planCompleted ? "Yes" : "No"}`,
    `• Goal appears achieved: ${report.goalAchieved ? "Yes" : "No"}`,
    `• Another plan recommended: ${report.nextPlanRecommended ? "Yes" : "No"}`,
  ];

  if (report.failureOrBlockedReason) {
    lines.push(`• Failure or blocked reason: ${report.failureOrBlockedReason}`);
  }

  appendListSection(lines, "Files Changed", report.filesChanged);
  appendListSection(lines, "Verification Commands", report.verificationCommands);
  appendListSection(lines, "Sources", [
    "Test Details: open the Test Detail surface from the completed plan message.",
    "Continuation message: open the continuation prompt message for next-plan details.",
    "View Prompt: open the continuation View Prompt surface for the proposed prompt.",
  ]);
  return `${lines.join("\n").trim()}\n`;
}

export async function generateReport(params: GenerateReportParams): Promise<GenerateReportResult> {
  const phase = "generateReport" satisfies PostExecutionPhaseName;
  const outcome = await runReportPhaseWithFallback<GenerateReportPayload>({
    phase,
    params,
    promptBuilder: () => buildGenerateReportPrompt(params),
    parseText: parseGenerateReportPayload,
  });

  if (outcome.status === "failed") return outcome;

  const artifacts = resolvePostExecutionReportArtifactPaths(params);
  writeReportArtifacts({
    artifacts,
    report: outcome.value.report,
    markdown: outcome.value.markdown,
  });

  return {
    status: "success",
    report: outcome.value.report,
    markdown: outcome.value.markdown,
    artifacts,
    backend: outcome.backend,
    sessionId: outcome.sessionId,
    usageLimitEvents: outcome.usageLimitEvents,
    ...(outcome.recoveryMessage ? { recoveryMessage: outcome.recoveryMessage } : {}),
  };
}

export async function prepareManualTestDisplay(
  params: ReportContinuationPhaseParams,
): Promise<ManualTestDisplayResult> {
  const phase = "prepareManualTestDisplay" satisfies PostExecutionPhaseName;
  const outcome = await runReportPhaseWithFallback<PostExecutionManualTestDisplay>({
    phase,
    params,
    artifacts: params.artifacts,
    promptBuilder: () => buildManualTestDisplayPrompt(params),
    parseText: parseManualTestDisplayPayload,
  });

  if (outcome.status === "failed") return outcome;
  return {
    status: "success",
    display: outcome.value,
    backend: outcome.backend,
    sessionId: outcome.sessionId,
    usageLimitEvents: outcome.usageLimitEvents,
    ...(outcome.recoveryMessage ? { recoveryMessage: outcome.recoveryMessage } : {}),
  };
}

export async function decideContinuation(
  params: ReportContinuationPhaseParams,
): Promise<ContinuationDecisionResult> {
  const phase = "decideContinuation" satisfies PostExecutionPhaseName;
  const outcome = await runReportPhaseWithFallback<PostExecutionContinuationDecision>({
    phase,
    params,
    artifacts: params.artifacts,
    promptBuilder: () => buildContinuationDecisionPrompt(params),
    parseText: parseContinuationDecisionPayload,
  });

  if (outcome.status === "failed") return outcome;
  return {
    status: "success",
    continuation: outcome.value,
    backend: outcome.backend,
    sessionId: outcome.sessionId,
    usageLimitEvents: outcome.usageLimitEvents,
    ...(outcome.recoveryMessage ? { recoveryMessage: outcome.recoveryMessage } : {}),
  };
}

export async function runPostExecutionReporting(
  params: RunPostExecutionReportingParams,
): Promise<RunPostExecutionReportingResult> {
  const reportResult = await generateReport(params);
  if (reportResult.status === "failed") return reportResult;

  let session: PhaseSessionParams = {
    backend: reportResult.backend,
    ...(reportResult.sessionId ? { sessionId: reportResult.sessionId } : {}),
  };

  const manualResult = await prepareManualTestDisplay({
    ...params,
    ...session,
    report: reportResult.report,
    artifacts: reportResult.artifacts,
  });
  const manualTestDisplay =
    manualResult.status === "success"
      ? manualResult.display
      : buildFallbackManualTestDisplay(params.plan.steps);

  if (manualResult.status === "success") {
    session = {
      backend: manualResult.backend,
      ...(manualResult.sessionId ? { sessionId: manualResult.sessionId } : {}),
    };
  }

  const continuationResult = await decideContinuation({
    ...params,
    ...session,
    report: reportResult.report,
    artifacts: reportResult.artifacts,
  });
  const continuation =
    continuationResult.status === "success"
      ? continuationResult.continuation
      : buildFallbackContinuationDecision({
          runId: params.runId,
          goal: params.goal,
          plan: params.plan,
          workingDir: params.workingDir,
          serializedRun: params.serializedRun,
          historyWorkspaceSlug: params.serializedRun?.historyWorkspaceSlug,
          failureReason: continuationResult.reason,
        });

  return {
    status: "success",
    report: reportResult.report,
    markdown: reportResult.markdown,
    artifacts: reportResult.artifacts,
    manualTestDisplay,
    continuation,
    backend: continuationResult.status === "success" ? continuationResult.backend : session.backend,
    ...(continuationResult.status === "success" && continuationResult.sessionId
      ? { sessionId: continuationResult.sessionId }
      : session.sessionId
        ? { sessionId: session.sessionId }
        : {}),
  };
}

async function runReportPhaseWithFallback<T>(params: {
  phase: PostExecutionPhaseName;
  params: BasePhaseParams;
  artifacts?: PostExecutionReportArtifactPaths;
  promptBuilder: () => string;
  parseText: (text: string) => T;
}): Promise<
  | {
      status: "success";
      value: T;
      backend: CliWorkerId;
      sessionId?: string;
      usageLimitEvents: PhaseFallbackResult<T>["usageLimitEvents"];
      recoveryMessage?: string;
    }
  | PostExecutionReportingFailure
> {
  const backends = resolvePhaseBackends({
    backend: params.params.backend,
    enabledBackends: params.params.enabledBackends,
  });
  const outcome = await runWithBackendFallback<{
    value: T;
    sessionId?: string;
  }>({
    backends,
    fallbackOnAnyError: true,
    onProgress: params.params.onProgress,
    attempt: async (backend) => {
      const isOriginalBackend = backend === params.params.backend;
      const sessionId = isOriginalBackend ? params.params.sessionId : undefined;
      try {
        const prompt = params.promptBuilder();
        const attemptParams = {
          ...params.params,
          backend,
          phase: params.phase,
          prompt,
        };
        if (sessionId) attemptParams.sessionId = sessionId;
        else delete attemptParams.sessionId;
        const attemptResult = await runReportCliAttempt(attemptParams);
        let parsedValue: T;
        try {
          parsedValue = params.parseText(attemptResult.text);
        } catch (parseError) {
          const retrySessionId =
            attemptResult.sessionId ??
            (backend === params.params.backend ? params.params.sessionId : undefined);
          if (!retrySessionId) throw parseError;
          const retryResult = await runReportCliAttempt({
            ...attemptParams,
            sessionId: retrySessionId,
            prompt: JSON_RETRY_PROMPT,
          });
          parsedValue = params.parseText(retryResult.text);
          return {
            ok: true,
            value: {
              value: parsedValue,
              sessionId: retryResult.sessionId ?? retrySessionId,
            },
          };
        }
        return {
          ok: true,
          value: {
            value: parsedValue,
            sessionId:
              attemptResult.sessionId ??
              (backend === params.params.backend ? params.params.sessionId : undefined),
          },
        };
      } catch (error) {
        return { ok: false, errorText: describeReportError(error) };
      }
    },
  });

  if (outcome.status === "success") {
    return {
      status: "success",
      value: outcome.value.value,
      backend: outcome.backend,
      sessionId: outcome.value.sessionId,
      usageLimitEvents: outcome.usageLimitEvents,
      ...(outcome.recoveryMessage ? { recoveryMessage: outcome.recoveryMessage } : {}),
    };
  }

  return {
    status: "failed",
    phase: params.phase,
    reason: outcome.message,
    usageLimitEvents: outcome.usageLimitEvents,
    lastErrorText: outcome.lastErrorText,
    ...(params.artifacts ? { artifacts: params.artifacts } : {}),
  };
}

async function runReportCliAttempt(
  params: BasePhaseParams & {
    phase: PostExecutionPhaseName;
    prompt: string;
  },
): Promise<ReportCliAttemptResult> {
  const useCodex = params.backend === "codex";
  const claudeSandbox =
    !useCodex && !params.sessionId
      ? buildClaudeCodeSandboxLaunchConfig({
          workingDir: params.workingDir,
          runId: `${params.runId}-post-execution-${params.phase}`,
          purpose: "repo-chat",
          readOnlyRoots: params.readOnlyRoots,
        })
      : undefined;
  const codexSandbox =
    useCodex && !params.sessionId
      ? writeCodexNativeSandboxConfig({
          workingDir: params.workingDir,
          runId: `${params.runId}-post-execution-${params.phase}`,
          purpose: "repo-chat",
          readOnlyRoots: params.readOnlyRoots,
          sandboxRoot: process.env.SMITHERSBOT_CODEX_SANDBOX_ROOT,
        })
      : undefined;

  const command = useCodex ? "codex" : (resolveClaudeBinary() ?? "claude");
  const scope = {
    kind: "goal" as const,
    workspaceName:
      params.serializedRun?.historyWorkspaceSlug ?? workspaceNameFromWorkingDir(params.workingDir),
    goalId: params.runId,
  };
  const historyPhase = reportPromptHistoryKind(params.phase);
  const promptArtifactPath = writeAgentPromptArtifact({
    scope,
    phase: historyPhase,
    backend: params.backend,
    prompt: params.prompt,
  });
  const promptInstruction = buildPromptArtifactInstruction({
    phase: params.phase,
    promptArtifactPath,
  });
  const args = useCodex
    ? buildCodexReportArgs({
        promptInstruction,
        workingDir: params.workingDir,
        sandboxConfig: codexSandbox,
        sessionId: params.sessionId,
        model: params.model,
      })
    : buildClaudeReportArgs({
        promptInstruction,
        sandboxConfig: claudeSandbox,
        sessionId: params.sessionId,
        model: params.model,
      });

  try {
    appendAgentHistoryEvent(scope, {
      event: "launch",
      phase: historyPhase,
      backend: params.backend,
      command,
      argv: args,
      promptArtifactPath,
      runId: params.runId,
      goalId: params.runId,
      status: "launching",
      postExecutionPhase: params.phase,
      ...(params.model ? { model: params.model } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    params.onProgress?.(
      `  [warn] Post-execution ${params.phase} launch history write failed; continuing reporter launch: ${redactSecretValues(message)}`,
    );
  }

  const procResult = await runCliProcess({
    command,
    args,
    cwd: params.workingDir,
    timeoutMs: params.timeoutMs ?? DEFAULT_POST_EXECUTION_TIMEOUT_MS,
    claudeDriverSite: "post-execution-report",
    env: useCodex
      ? codexSandbox
        ? mergeCodexNativeSandboxEnv(
            buildCredentialStrippedEnv(process.env, { stripAuthKeys: true }),
            codexSandbox,
          )
        : buildCredentialStrippedEnv(process.env, { stripAuthKeys: true })
      : buildClaudeCodeEnv(params.claudeCodeAuth ?? "subscription"),
  });

  const redactedResult = redactProcessResult(procResult);
  if (redactedResult.timedOut) {
    throw new ReportCliError(
      `Post-execution ${params.phase} timed out after ${((params.timeoutMs ?? DEFAULT_POST_EXECUTION_TIMEOUT_MS) / 1000).toFixed(0)} seconds.`,
      redactedResult,
    );
  }
  if ((redactedResult.exitCode && redactedResult.exitCode !== 0) || redactedResult.signal) {
    throw new ReportCliError(
      `Post-execution ${params.phase} failed: ${formatProcessFailure(redactedResult)}`,
      redactedResult,
    );
  }
  if (
    params.sessionId &&
    SESSION_NOT_FOUND_RE.test(`${redactedResult.stderr}\n${redactedResult.stdout}`)
  ) {
    throw new ReportCliError(
      `Post-execution ${params.phase} resume failed: session "${params.sessionId}" was not found.`,
      redactedResult,
    );
  }

  const parsed = parseCliTextAndSession(redactedResult.stdout);
  if (!parsed.text) {
    throw new ReportCliError(
      `Post-execution ${params.phase} did not return assistant text.`,
      redactedResult,
    );
  }
  return parsed;
}

function buildClaudeReportArgs(params: {
  promptInstruction: string;
  sandboxConfig?: ClaudeCodeLaunchSandboxConfig;
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
  if (params.sandboxConfig) appendClaudeCodeSandboxArgs(args, params.sandboxConfig);
  if (params.model) args.push("--model", params.model);
  if (params.sessionId) args.push("--resume", params.sessionId);
  args.push(params.promptInstruction);
  return args;
}

function buildCodexReportArgs(params: {
  promptInstruction: string;
  workingDir: string;
  sandboxConfig?: CodexNativeSandboxConfig;
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
  } else {
    args.push("--json", "--color", "never");
    if (params.sandboxConfig) appendCodexNativeSandboxExecArgs(args, params.sandboxConfig);
  }
  if (params.model) args.push("--model", params.model);
  args.push(params.promptInstruction);
  return args;
}

function buildGenerateReportPrompt(params: GenerateReportParams): string {
  const sourcePaths = resolveReporterSourcePaths(params);
  return [
    "Native lifecycle phase: post-execution report generation.",
    "The plan has already completed or stopped. Do not modify files. Do not rerun completed plan steps.",
    "Use the existing session context plus the structured context below to produce the report.",
    "",
    "Return exactly one JSON object:",
    "{",
    '  "report": {',
    '    "planCompleted": true,',
    '    "goalAchieved": true,',
    '    "summary": "concise outcome summary",',
    '    "filesChanged": ["..."],',
    '    "verificationCommands": ["..."],',
    '    "manualTests": [{"description":"...","criticality":5,"reason":"...","detail":"..."}],',
    '    "nextPlanRecommended": false,',
    '    "nextPlanSummary": null,',
    '    "nextPlanPrompt": null,',
    '    "decisionsNeeded": [],',
    '    "failureOrBlockedReason": null',
    "  }",
    "}",
    "",
    "Keep field values concise. The system will render markdown deterministically from the report object.",
    "Evidence source links:",
    `- Goal Brief: ${sourcePaths.goalBriefPath}`,
    `- ScoutReport mirror: ${sourcePaths.scoutReportPath}`,
    `- Prior Plan Report: ${sourcePaths.priorPlanReportPath}`,
    "- If a linked source is missing, still reason from the available structured context.",
    "",
    "The report must answer:",
    "- What did the user originally ask for?",
    "- What did this plan attempt?",
    "- What changed?",
    "- What verification ran?",
    "- What manual tests are needed?",
    '- Prefer Manual Tests that check observable behavior ("user can X and sees Y"), not internal structure; a good Manual Test survives an internal rewrite.',
    "- Did this plan complete?",
    "- Did the user's original goal appear achieved?",
    "- Is another plan needed for this same goal?",
    "- If another plan is needed, what should the next plan accomplish?",
    "- What decisions, if any, does the user need to make?",
    "- Treat Worker Summaries as linked evidence, not ground truth: verify each flagged claim against the actual diff and build-gate output before reporting it as fact.",
    "",
    "Important continuation guidance:",
    "- Evaluate goalAchieved against the user's original goal, not just this plan's completion.",
    "- Explicitly compare the original goal requirements, this completed plan's scope, and any remaining work.",
    "- If the original goal describes multiple stages, sequenced phases, or asks to continue after this plan, treat any unfinished stage/phase as remaining original-goal work.",
    "- When remaining original-goal work exists, set goalAchieved=false, nextPlanRecommended=true, and produce a concrete nextPlanSummary and nextPlanPrompt for the remaining work.",
    "- The next plan must directly perform the remaining work, not draft a meta-plan to decide what should happen.",
    "- Do not infer completion from all current plan steps being done when the original goal still asks for later work.",
    "",
    "Context:",
    buildPlanCompletionContext(params),
  ].join("\n");
}

function buildManualTestDisplayPrompt(params: ReportContinuationPhaseParams): string {
  return [
    "Native lifecycle phase: prepare manual-test display data.",
    "The plan has already completed or stopped. Do not modify files. Do not rerun completed plan steps.",
    "Use the saved post-execution report artifacts below as the source of truth.",
    "",
    "Return exactly one JSON object:",
    '{ "manualTests": [{"description":"...","criticality":5,"reason":"...","detail":"..."}], "displayMarkdown": "..." }',
    "",
    buildSavedReportContext(params.artifacts),
  ].join("\n");
}

function buildContinuationDecisionPrompt(params: ReportContinuationPhaseParams): string {
  return [
    "Native lifecycle phase: decide continuation.",
    "The plan has already completed or stopped. Do not modify files. Do not rerun completed plan steps.",
    "Use the saved post-execution report artifacts below as the source of truth.",
    "",
    "Return exactly one JSON object:",
    "{",
    '  "goalAchieved": true,',
    '  "nextPlanRecommended": false,',
    '  "nextPlanSummary": null,',
    '  "nextPlanPrompt": null,',
    '  "decisionsNeeded": [{"question":"...","options":["A","B"],"recommendedOption":"B","rationale":"...","promptImpact":"..."}],',
    '  "failureOrBlockedReason": null',
    "}",
    "",
    "Continuation decision rules:",
    "- Evaluate goalAchieved against the user's original goal, not just this completed plan or the saved report summary.",
    "- Explicitly compare the original goal requirements, completed plan scope, completed work, and remaining original-goal requirements recorded in the saved artifacts.",
    "- If the original goal describes multiple stages, sequenced phases, or asks to continue after this plan, treat any unfinished stage/phase as remaining work.",
    "- When remaining work exists, set goalAchieved=false, nextPlanRecommended=true, and produce a concrete nextPlanSummary and nextPlanPrompt for the next remaining stage.",
    "- The next plan must directly perform the remaining work, not draft a meta-plan to decide what should happen.",
    "- Set nextPlanSummary and nextPlanPrompt to null only when the original goal is genuinely achieved or no actionable continuation can be inferred.",
    "",
    "Structured completion context:",
    buildPlanCompletionContext({ ...params, completionSummary: params.report.summary }),
    "",
    buildSavedReportContext(params.artifacts),
  ].join("\n");
}

function buildPlanCompletionContext(params: GenerateReportParams): string {
  const briefRun = {
    runId: params.runId,
    workingDir: params.workingDir,
    ...(params.serializedRun?.historyWorkspaceSlug
      ? { historyWorkspaceSlug: params.serializedRun.historyWorkspaceSlug }
      : {}),
    goalBriefPath: params.serializedRun?.goalBriefPath,
  };
  const briefPath = resolveStoredGoalBriefPath(briefRun);
  const brief = loadGoalBriefContent(briefRun);
  const longGoalSummary = brief.ok
    ? (extractGoalBriefSection(brief.content, ["Long Goal Summary"]) ??
      extractGoalBriefSection(brief.content, ["Goal Summary"]) ??
      params.plan.summary)
    : params.plan.summary;
  const lines: string[] = [
    `Run id: ${params.runId}`,
    `Working directory: ${params.workingDir}`,
    `Original user goal: ${params.goal}`,
    `Plan title: ${params.plan.shortSummary || params.plan.summary}`,
    `Plan summary: ${params.plan.summary}`,
    `Long Goal Summary: ${longGoalSummary}`,
    `Goal brief: ${briefPath}`,
    "Open the Goal Brief path above if you need the full brief; this prompt only includes compact derived fields.",
  ];
  if (brief.ok) {
    lines.push(
      "Use the Goal Brief's Remaining Work and Observation Point to evaluate whether the original goal is achieved; open the linked brief if those details are needed.",
    );
  } else {
    lines.push("");
    lines.push(
      "Goal Brief is missing — do not infer goal achievement from its absence. Evaluate goalAchieved only from the original goal, completed plan scope, and recorded work; when evidence is insufficient, prefer goalAchieved=false rather than assuming the goal is complete.",
    );
  }
  if (params.completionSummary) {
    lines.push(`Existing completion summary: ${params.completionSummary}`);
  }
  lines.push("");
  lines.push("Plan steps:");
  const workerSummaryPathsByStep = new Map(
    (params.workerSummaries ?? params.serializedRun?.workerSummaries ?? []).map((summary) => [
      summary.id,
      summary.path,
    ]),
  );
  for (const step of params.plan.steps) {
    const sourceLink = workerSummaryPathsByStep.get(step.id);
    lines.push(
      [
        `- ${step.id}: ${step.shortSummary || step.description}`,
        `  status: ${step.status}`,
        step.taskSummary
          ? `  completion snippet: ${compactPostExecutionContextText(step.taskSummary)}`
          : undefined,
        sourceLink ? `  Source Link: ${sourceLink}` : undefined,
        step.blockedQuestion ? `  blocker: ${step.blockedQuestion}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  if (params.plan.buildGate?.commands?.length) {
    lines.push("");
    lines.push("Planned verification/build-gate commands:");
    for (const command of params.plan.buildGate.commands) lines.push(`- ${command}`);
  }
  const workerSummaries = params.workerSummaries ?? params.serializedRun?.workerSummaries ?? [];
  if (workerSummaries.length > 0) {
    lines.push("");
    lines.push("Worker Summaries (linked evidence, not ground truth):");
    lines.push(
      "Reporter must verify each flagged claim against the actual diff and build-gate output before reporting it as fact.",
    );
    for (const summary of workerSummaries) {
      lines.push(`- ${summary.id}: ${summary.summary}`);
      lines.push(`  Source Link: ${summary.path}`);
      if (summary.claimsToVerify.length > 0) {
        lines.push("  Claims to verify before relying on this summary:");
        for (const claim of summary.claimsToVerify) lines.push(`  - ${claim}`);
      }
    }
  }
  const buildGateResults = params.buildGateResults ?? params.serializedRun?.buildGateResults;
  if (buildGateResults && Object.keys(buildGateResults).length > 0) {
    lines.push("");
    lines.push("Recorded build-gate results:");
    for (const [stepId, result] of Object.entries(buildGateResults)) {
      lines.push(`- ${stepId}: ${result.passed ? "passed" : "failed"} at ${result.timestamp}`);
      if (!result.passed && result.failedCommand) {
        lines.push(`  failedCommand: ${result.failedCommand}`);
      }
      if (!result.passed && result.output) {
        lines.push(
          `  output: ${compactPostExecutionContextText(
            result.output,
            POST_EXECUTION_BUILD_GATE_OUTPUT_CHARS,
          )}`,
        );
      }
    }
  }
  return redactSecretValues(lines.join("\n"));
}

function compactPostExecutionContextText(
  value: string,
  maxChars = POST_EXECUTION_CONTEXT_TEXT_CHARS,
): string {
  const redacted = redactSecretValues(value).replace(/\s+/g, " ").trim();
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, maxChars).trimEnd()}...`;
}

function buildFallbackManualTestDisplay(
  steps: readonly Plan["steps"][number][],
): PostExecutionManualTestDisplay {
  const manualTests = buildFallbackManualTestsForSteps(steps, {
    reason: "Post-execution manual-test display generation failed; using deterministic fallback.",
  });
  return {
    manualTests,
    displayMarkdown: renderManualTestsMarkdown(manualTests),
  };
}

type FallbackRemainingWorkEvidence = {
  summary: string;
  nextPlanPrompt: string;
};

function buildFallbackContinuationDecision(params: {
  runId: string;
  goal: string;
  plan: Plan;
  workingDir: string;
  historyWorkspaceSlug?: string;
  serializedRun?: SerializedRun;
  failureReason: string;
}): PostExecutionContinuationDecision {
  const remainingWork = collectFallbackRemainingWork(params);
  return {
    goalAchieved: !remainingWork,
    nextPlanRecommended: Boolean(remainingWork),
    nextPlanSummary: remainingWork?.summary ?? null,
    nextPlanPrompt: remainingWork?.nextPlanPrompt ?? null,
    decisionsNeeded: [],
    failureOrBlockedReason: `Post-execution continuation decision failed: ${params.failureReason}`,
  };
}

function collectFallbackRemainingWork(params: {
  runId: string;
  goal: string;
  plan: Plan;
  workingDir: string;
  historyWorkspaceSlug?: string;
  serializedRun?: SerializedRun;
}): FallbackRemainingWorkEvidence | undefined {
  return collectGoalBriefFallbackRemainingWork(params) ?? collectPlanFallbackRemainingWork(params);
}

function collectGoalBriefFallbackRemainingWork(params: {
  runId: string;
  workingDir: string;
  historyWorkspaceSlug?: string;
  serializedRun?: SerializedRun;
}): FallbackRemainingWorkEvidence | undefined {
  const brief = loadGoalBriefContent({
    runId: params.runId,
    workingDir: params.workingDir,
    ...(params.serializedRun?.goalBriefPath
      ? { goalBriefPath: params.serializedRun.goalBriefPath }
      : {}),
    ...(params.historyWorkspaceSlug ? { historyWorkspaceSlug: params.historyWorkspaceSlug } : {}),
  });
  if (!brief.ok) return undefined;

  const remainingWork = extractGoalBriefSection(brief.content, ["Remaining Work"]);
  if (!isActionableFallbackRemainingText(remainingWork)) return undefined;

  const observationPoint =
    extractGoalBriefSection(brief.content, ["Next Observation Point", "Observation Point"]) ?? "";
  const summary = normalizeFallbackRemainingText(remainingWork);
  const observation = normalizeFallbackRemainingText(observationPoint, 400);
  return {
    summary,
    nextPlanPrompt: [
      `Create the next plan under the same Goal ID (${params.runId}) to complete the remaining work recorded in the Goal Brief.`,
      `Remaining work: ${summary}`,
      observation ? `Observation point: ${observation}` : "",
      "Do not redo completed plan steps. Do not claim the remaining work is already complete without concrete evidence.",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function collectPlanFallbackRemainingWork(params: {
  runId: string;
  goal: string;
  plan: Plan;
}): FallbackRemainingWorkEvidence | undefined {
  const candidates = [
    params.goal,
    params.plan.goal,
    params.plan.summary,
    params.plan.shortSummary,
    ...params.plan.steps.flatMap((step) => [
      step.description,
      step.shortSummary,
      step.taskSummary,
      step.blockedQuestion,
    ]),
  ];
  const matching = candidates
    .map((line) => normalizeFallbackRemainingText(line, 500))
    .filter((line) => lineIdentifiesFallbackRemainingWork(line));
  if (matching.length === 0) return undefined;

  const summary = normalizeFallbackRemainingText(matching.slice(0, 3).join(" "), 700);
  return {
    summary,
    nextPlanPrompt: [
      `Create the next plan under the same Goal ID (${params.runId}) to complete the remaining original-goal work.`,
      `Remaining work: ${summary}`,
      "Do not redo completed plan steps. Use the Goal Brief, current plan context, and saved artifacts as the source of truth.",
    ].join("\n"),
  };
}

function normalizeFallbackRemainingText(value: string | undefined, maxLength = 700): string {
  const text = value?.replace(/\s+/g, " ").trim() ?? "";
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength - 3).trimEnd()}...` : text;
}

function isActionableFallbackRemainingText(value: string | undefined): value is string {
  const text = normalizeFallbackRemainingText(value, 1_000);
  if (!text) return false;
  if (
    /^(?:none|n\/a|not applicable|complete|completed)\.?$/i.test(text) ||
    /\b(?:no|nothing)\b.{0,40}\b(?:remaining|left|unfinished|incomplete|to do|todo|work)\b/i.test(
      text,
    ) ||
    /\b(?:goal|work|task)\b.{0,40}\b(?:is|was|appears|looks)\b.{0,20}\b(?:complete|completed|done)\b/i.test(
      text,
    )
  ) {
    return false;
  }
  return true;
}

function lineIdentifiesFallbackRemainingWork(line: string): boolean {
  const text = normalizeFallbackRemainingText(line, 1_000);
  if (!isActionableFallbackRemainingText(text)) return false;
  return (
    /\bremaining (?:original[- ]goal )?work\b/i.test(text) ||
    /\bstill needs?\b/i.test(text) ||
    /\bunfinished\b/i.test(text) ||
    /\bincomplete\b/i.test(text) ||
    /\bnext plan\b/i.test(text) ||
    /\bstage\s*(?:2|two|3|three|next|later)\b/i.test(text) ||
    /\bleav(?:e|es|ing|ed)\b.{0,100}\b(?:continuation|later|next|stage)\b/i.test(text) ||
    /\bcontinue(?:s|d)?\b.{0,100}\b(?:same goal|after|stage|remaining|with another plan)\b/i.test(
      text,
    )
  );
}

function buildSavedReportContext(artifacts: PostExecutionReportArtifactPaths): string {
  const markdown = readTextIfExists(artifacts.markdownPath);
  return [
    `Saved post-execution report markdown path: ${artifacts.markdownPath}`,
    "Saved post-execution report markdown:",
    "```markdown",
    markdown,
    "```",
    "",
    `Saved post-execution report JSON Source Link: ${artifacts.jsonPath}`,
  ].join("\n");
}

function resolveReporterSourcePaths(params: GenerateReportParams): {
  goalBriefPath: string;
  scoutReportPath: string;
  priorPlanReportPath: string;
} {
  const historyDir = resolveAgentGoalHistoryDir(
    params.serializedRun
      ? resolveHistoryWorkspaceSlug(params.serializedRun)
      : workspaceNameFromWorkingDir(params.workingDir),
    params.runId,
  );
  const goalBriefPath = resolveStoredGoalBriefPath({
    runId: params.runId,
    workingDir: params.workingDir,
    ...(params.serializedRun?.historyWorkspaceSlug
      ? { historyWorkspaceSlug: params.serializedRun.historyWorkspaceSlug }
      : {}),
    goalBriefPath: params.serializedRun?.goalBriefPath,
  });
  return {
    goalBriefPath,
    scoutReportPath: path.join(historyDir, "runtime", "scout", SCOUT_REPORT_FILE),
    priorPlanReportPath:
      params.serializedRun?.postExecutionReportArtifacts?.markdownPath ??
      path.join(historyDir, POST_EXECUTION_REPORT_MARKDOWN_FILENAME),
  };
}

function parseGenerateReportPayload(text: string): GenerateReportPayload {
  const parsed = parseJsonObjectFromText(text);
  const rawReport = isRecord(parsed.report) ? parsed.report : parsed;
  const report = parsePostExecutionReport(rawReport);
  return { report, markdown: renderPostExecutionReportMarkdown(report) };
}

function parseManualTestDisplayPayload(text: string): PostExecutionManualTestDisplay {
  const parsed = parseJsonObjectFromText(text);
  const tests = Array.isArray(parsed.manualTests)
    ? parsed.manualTests
    : Array.isArray(parsed.tests)
      ? parsed.tests
      : [];
  return PostExecutionManualTestDisplaySchema.parse({
    manualTests: normalizeManualTests(tests),
    displayMarkdown:
      typeof parsed.displayMarkdown === "string"
        ? parsed.displayMarkdown
        : renderManualTestsMarkdown(normalizeManualTests(tests)),
  });
}

function parseContinuationDecisionPayload(text: string): PostExecutionContinuationDecision {
  const parsed = parseJsonObjectFromText(text);
  return PostExecutionContinuationDecisionSchema.parse({
    goalAchieved: parsed.goalAchieved,
    nextPlanRecommended: parsed.nextPlanRecommended,
    nextPlanSummary: stringOrNull(parsed.nextPlanSummary),
    nextPlanPrompt: stringOrNull(parsed.nextPlanPrompt),
    decisionsNeeded: normalizeDecisions(parsed.decisionsNeeded),
    failureOrBlockedReason: stringOrNull(parsed.failureOrBlockedReason),
  });
}

function parsePostExecutionReport(raw: Record<string, unknown>): PostExecutionReport {
  return PostExecutionReportSchema.parse({
    planCompleted: raw.planCompleted,
    goalAchieved: raw.goalAchieved,
    summary: raw.summary,
    filesChanged: normalizeStringArray(raw.filesChanged),
    verificationCommands: normalizeStringArray(raw.verificationCommands),
    manualTests: normalizeManualTests(raw.manualTests),
    nextPlanRecommended: raw.nextPlanRecommended,
    nextPlanSummary: stringOrNull(raw.nextPlanSummary),
    nextPlanPrompt: stringOrNull(raw.nextPlanPrompt),
    decisionsNeeded: normalizeDecisions(raw.decisionsNeeded),
    failureOrBlockedReason: stringOrNull(raw.failureOrBlockedReason),
  });
}

function parseJsonObjectFromText(text: string): Record<string, unknown> {
  try {
    return extractJson(text);
  } catch {
    for (const candidate of extractJsonObjectCandidates(text)) {
      try {
        const parsed = JSON.parse(candidate) as unknown;
        if (isRecord(parsed)) return parsed;
      } catch {
        try {
          const parsed = JSON.parse(repairJsonText(candidate)) as unknown;
          if (isRecord(parsed)) return parsed;
        } catch {
          continue;
        }
      }
    }
  }
  throw new Error("Post-execution phase response did not include valid JSON.");
}

function parseCliTextAndSession(stdout: string): ReportCliAttemptResult {
  const parsed = extractCliTextAndSession(stdout);
  return {
    text: (parsed.text || stdout.trim()).trim(),
    ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
  };
}

function resolvePhaseBackends(params: {
  backend: CliWorkerId;
  enabledBackends?: CliWorkerId[];
}): CliWorkerId[] {
  const other: CliWorkerId = params.backend === "claude_code" ? "codex" : "claude_code";
  const enabled: CliWorkerId[] = params.enabledBackends ?? ["claude_code", "codex"];
  return [params.backend, other].filter((backend): backend is CliWorkerId =>
    enabled.includes(backend),
  );
}

function writeReportArtifacts(params: {
  artifacts: PostExecutionReportArtifactPaths;
  report: PostExecutionReport;
  markdown: string;
}): void {
  fs.mkdirSync(params.artifacts.historyDir, { recursive: true, mode: 0o755 });
  fs.writeFileSync(params.artifacts.markdownPath, redactSecretValues(params.markdown), "utf8");
  fs.chmodSync(params.artifacts.markdownPath, 0o644);
  fs.writeFileSync(
    params.artifacts.jsonPath,
    redactSecretValues(`${JSON.stringify(params.report, null, 2)}\n`),
    "utf8",
  );
  fs.chmodSync(params.artifacts.jsonPath, 0o644);
}

function normalizeManualTests(raw: unknown): PostExecutionManualTest[] {
  if (!Array.isArray(raw)) return [];
  const tests: PostExecutionManualTest[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (trimmed) {
        tests.push({ description: trimmed, detail: trimmed, criticality: 5 });
      }
      continue;
    }
    if (!isRecord(entry)) continue;
    const description = stringFrom(entry.description) || stringFrom(entry.name);
    if (!description) continue;
    const detail = stringFrom(entry.detail) || stringFrom(entry.instructions) || description;
    const criticality = clampCriticality(entry.criticality);
    const reason = stringFrom(entry.reason) || stringFrom(entry.why);
    tests.push({
      description,
      detail,
      criticality,
      ...(reason ? { reason } : {}),
    });
  }
  return tests;
}

function normalizeDecisions(raw: unknown): PostExecutionDecision[] {
  if (!Array.isArray(raw)) return [];
  const decisions: PostExecutionDecision[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const question = stringFrom(entry.question);
    if (!question) continue;
    const options = normalizeStringArray(entry.options);
    const recommendedOption = stringFrom(entry.recommendedOption) || null;
    decisions.push({
      question,
      options,
      recommendedOption,
      ...(stringFrom(entry.rationale) ? { rationale: stringFrom(entry.rationale) } : {}),
      ...(stringFrom(entry.promptImpact) ? { promptImpact: stringFrom(entry.promptImpact) } : {}),
    });
  }
  return decisions;
}

function normalizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => stringFrom(entry)).filter((entry): entry is string => Boolean(entry));
}

function stringFrom(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

function stringOrNull(raw: unknown): string | null {
  return stringFrom(raw) ?? null;
}

function clampCriticality(raw: unknown): number {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return 5;
  return Math.min(10, Math.max(1, Math.round(value)));
}

function appendListSection(lines: string[], title: string, values: readonly string[]): void {
  lines.push(`**${title}:**`);
  if (values.length === 0) {
    lines.push("None recorded.");
    return;
  }
  for (const value of values) lines.push(`- ${value}`);
}

function renderManualTestsMarkdown(manualTests: readonly PostExecutionManualTest[]): string {
  if (manualTests.length === 0) return "No manual tests are needed.";
  return manualTests
    .map((test, index) => {
      const lines = [`${index + 1}. ${test.description}`, test.detail];
      if (test.reason) lines.push(`Reason: ${test.reason}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

function readTextIfExists(filePath: string): string {
  try {
    return redactSecretValues(fs.readFileSync(filePath, "utf8"));
  } catch {
    return "";
  }
}

function redactProcessResult(result: RunCliProcessResult): RunCliProcessResult {
  return {
    ...result,
    stdout: redactSecretValues(result.stdout),
    stderr: redactSecretValues(result.stderr),
  };
}

class ReportCliError extends Error {
  readonly result: RunCliProcessResult;
  constructor(message: string, result: RunCliProcessResult) {
    super(message);
    this.name = "ReportCliError";
    this.result = result;
  }
}

function describeReportError(error: unknown): string {
  if (error instanceof ReportCliError) {
    return `${error.message} (exit=${error.result.exitCode ?? "unknown"}, signal=${
      error.result.signal ?? "none"
    })`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function formatProcessFailure(result: RunCliProcessResult): string {
  const detail = (result.stderr || result.stdout).replace(/\s+/g, " ").trim();
  if (detail) return detail.slice(0, 1_200);
  if (result.signal) return `terminated by ${result.signal}`;
  return `exit=${result.exitCode ?? "unknown"}`;
}
