import { randomUUID } from "node:crypto";

import type { CliWorkerId, ClaudeCodeAuthMode } from "../config/types.goal.js";
import type { BackendAvailability } from "./backend-types.js";
import {
  detectBackendAvailability,
  getCodexAskForApprovalPlacement,
  isBackendAvailable,
} from "./backend-availability.js";
import {
  appendClaudeCodeSandboxArgs,
  appendCodexNativeSandboxExecArgs,
  buildClaudeCodeSandboxLaunchConfig,
  mergeCodexNativeSandboxEnv,
  writeCodexNativeSandboxConfig,
  type ClaudeCodeLaunchSandboxConfig,
  type CodexNativeSandboxConfig,
} from "./backend-sandbox.js";
import {
  CLAUDE_ALLOWED_TOOLS_READ_ONLY,
  CLAUDE_READ_ONLY_PROMPT,
} from "./claude-code-constants.js";
import { buildClaudeCodeEnv, buildCredentialStrippedEnv } from "./claude-code-env.js";
import { extractCliTextAndSession, formatCliFailure } from "./cli-output-parsing.js";
import { runCliProcess, type RunCliProcessParams } from "./cli-process.js";
import { runWithBackendFallback } from "./phase-fallback.js";
import { resolveClaudeBinary } from "./scout.js";
import type { GoalLlmClient, GoalLlmResponse } from "./types.js";

export const DEFAULT_CONTINUATION_CLI_TIMEOUT_MS = 600_000;

type ContinuationCliRunner = (params: RunCliProcessParams) => ReturnType<typeof runCliProcess>;

export type ContinuationCliClientDeps = {
  runCliProcess?: ContinuationCliRunner;
  detectBackendAvailability?: () => BackendAvailability[];
  resolveClaudeBinary?: () => string | null;
  buildClaudeSandbox?: typeof buildClaudeCodeSandboxLaunchConfig;
  writeCodexSandbox?: typeof writeCodexNativeSandboxConfig;
  getCodexAskForApprovalPlacement?: typeof getCodexAskForApprovalPlacement;
};

export type ContinuationCliClientParams = {
  backends: CliWorkerId[];
  workingDir: string;
  claudeCodeAuth?: ClaudeCodeAuthMode;
  readOnlyRoots?: string[];
  timeoutMs?: number;
  deps?: ContinuationCliClientDeps;
};

function buildContinuationCliPrompt(params: { systemPrompt: string; userMessage: string }): string {
  return [
    "System instructions:",
    params.systemPrompt,
    "",
    "User message:",
    params.userMessage,
    "",
    "Return only the requested JSON object. Do not include markdown fences or prose outside JSON.",
  ].join("\n");
}

function buildClaudeContinuationArgs(params: {
  sandboxConfig: ClaudeCodeLaunchSandboxConfig;
  prompt: string;
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
  args.push(params.prompt);
  return args;
}

function buildCodexContinuationArgs(params: {
  sandboxConfig: CodexNativeSandboxConfig;
  prompt: string;
  askForApprovalPlacement: ReturnType<typeof getCodexAskForApprovalPlacement>;
}): string[] {
  const args = [
    ...(params.askForApprovalPlacement === "before_exec" ? ["--ask-for-approval", "never"] : []),
    "exec",
    ...(params.askForApprovalPlacement === "after_exec" ? ["--ask-for-approval", "never"] : []),
    "--json",
    "--color",
    "never",
  ];
  appendCodexNativeSandboxExecArgs(args, params.sandboxConfig);
  args.push(params.prompt);
  return args;
}

function parseCliAssistantText(stdout: string): string {
  const parsed = extractCliTextAndSession(stdout);
  return (parsed.text || stdout.trim()).trim();
}

function availableStatus(
  backend: CliWorkerId,
  availability: BackendAvailability[],
): { available: true } | { available: false; reason?: string } {
  return isBackendAvailable(backend, availability);
}

export function createContinuationCliClient(
  params: ContinuationCliClientParams,
): GoalLlmClient | undefined {
  const backends = [...new Set(params.backends)];
  if (backends.length === 0) return undefined;

  const deps = params.deps ?? {};
  const runProcess = deps.runCliProcess ?? runCliProcess;
  const detectAvailability = deps.detectBackendAvailability ?? detectBackendAvailability;
  const resolveClaude = deps.resolveClaudeBinary ?? resolveClaudeBinary;
  const buildClaudeSandbox = deps.buildClaudeSandbox ?? buildClaudeCodeSandboxLaunchConfig;
  const writeCodexSandbox = deps.writeCodexSandbox ?? writeCodexNativeSandboxConfig;
  const resolveAskForApproval =
    deps.getCodexAskForApprovalPlacement ?? getCodexAskForApprovalPlacement;

  return {
    async complete({ systemPrompt, userMessage }): Promise<GoalLlmResponse> {
      const prompt = buildContinuationCliPrompt({ systemPrompt, userMessage });
      const availability = detectAvailability();
      const outcome = await runWithBackendFallback<string>({
        backends,
        fallbackOnAnyError: true,
        attempt: async (backend) => {
          const status = availableStatus(backend, availability);
          if (!status.available) {
            return {
              ok: false,
              errorText: `${backend} continuation backend unavailable${
                status.reason ? `: ${status.reason}` : "."
              }`,
            };
          }

          const useCodex = backend === "codex";
          const runSegment = `continuation-${randomUUID()}`;
          const command = useCodex ? "codex" : (resolveClaude() ?? "claude");
          if (!useCodex && command === "claude" && !resolveClaude()) {
            return { ok: false, errorText: "claude_code continuation backend unavailable." };
          }

          const claudeSandbox = !useCodex
            ? buildClaudeSandbox({
                workingDir: params.workingDir,
                runId: runSegment,
                purpose: "repo-chat",
                readOnlyRoots: params.readOnlyRoots,
              })
            : undefined;
          const codexSandbox = useCodex
            ? writeCodexSandbox({
                workingDir: params.workingDir,
                runId: runSegment,
                purpose: "repo-chat",
                readOnlyRoots: params.readOnlyRoots,
                sandboxRoot: process.env.SMITHERSBOT_CODEX_SANDBOX_ROOT,
              })
            : undefined;

          const args = useCodex
            ? buildCodexContinuationArgs({
                prompt,
                sandboxConfig: codexSandbox!,
                askForApprovalPlacement: resolveAskForApproval(),
              })
            : buildClaudeContinuationArgs({ prompt, sandboxConfig: claudeSandbox! });

          const procResult = await runProcess({
            command,
            args,
            cwd: params.workingDir,
            timeoutMs: params.timeoutMs ?? DEFAULT_CONTINUATION_CLI_TIMEOUT_MS,
            env: useCodex
              ? mergeCodexNativeSandboxEnv(
                  buildCredentialStrippedEnv(process.env, { stripAuthKeys: true }),
                  codexSandbox!,
                )
              : buildClaudeCodeEnv(params.claudeCodeAuth ?? "subscription"),
          });

          if (procResult.timedOut) {
            return { ok: false, errorText: `${backend} continuation backend timed out.` };
          }
          if ((procResult.exitCode && procResult.exitCode !== 0) || procResult.signal) {
            return {
              ok: false,
              errorText: `${backend} continuation backend failed: ${formatCliFailure(
                procResult.stdout,
                procResult.stderr,
                procResult.signal,
              )}`,
            };
          }

          const text = parseCliAssistantText(procResult.stdout);
          if (!text) {
            return { ok: false, errorText: `${backend} continuation backend returned no text.` };
          }
          return { ok: true, value: text };
        },
      });

      if (outcome.status === "success") return { text: outcome.value };
      throw new Error(
        `Continuation proposal failed because no continuation backend was available. Retry later or resume post-execution. ${outcome.message}`,
      );
    },
  };
}
