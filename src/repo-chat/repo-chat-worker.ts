import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCodexAskForApprovalPlacement } from "../goal/backend-availability.js";
import { buildClaudeCodeEnv, buildCredentialStrippedEnv } from "../goal/claude-code-env.js";
import { CLAUDE_READ_ONLY_PROMPT } from "../goal/claude-code-constants.js";
import { appendStrictMcpArgs, ensureEmptyMcpConfig } from "../goal/claude-code-mcp-isolation.js";
import { collectText, parseJsonLines } from "../goal/cli-output-parsing.js";
import { runCliProcess } from "../goal/cli-process.js";
import { getLogger } from "../logging/logger.js";
import { REPO_CHAT_SANDBOX_REPAIR_PROMPT } from "../prompts/repair/repo-chat-repair.js";
import {
  CODEX_STYLE_DIRECTIVE,
  buildResponseFileInstruction,
} from "../prompts/repo-chat/response-file-instruction.js";
import { redactSecretValues } from "../security/secret-paths.js";
import { REPO_CHAT_CONTEXT } from "./repo-chat-context.js";
import type { RepoChatWorkerParams, RepoChatWorkerResult } from "./types.js";
import {
  isPathInsideAgentRoot,
  isPathInsidePrivateRoot,
  resolveAgentRoot,
} from "../config/managed-paths.js";
import {
  buildClaudeCodeSandboxLaunchConfig,
  appendCodexNativeSandboxExecArgs,
  buildCodexNativeSandboxConfig,
  mergeCodexNativeSandboxEnv,
  writeCodexNativeSandboxConfig,
  type CodexNativeSandboxConfig,
} from "../goal/backend-sandbox.js";

const DEFAULT_TIMEOUT_MS = 3_600_000;
const CLAUDE_APPENDED_PROMPT = `${CLAUDE_READ_ONLY_PROMPT}\n\n${REPO_CHAT_CONTEXT}`;
const REPO_CHAT_CLAUDE_ALLOWED_TOOLS_READ_ONLY = [
  "Read",
  "Glob",
  "Grep",
  "Bash(git log:*)",
  "Bash(git diff:*)",
  "Bash(git show:*)",
  "Bash(rg:*)",
  "Bash(ls:*)",
  "Bash(wc:*)",
  "Bash(find:*)",
].join(",");
const MAX_ERROR_DETAIL_CHARS = 8_000;
const REPAIR_TIMEOUT_MS = 60_000;
const CODEX_NO_SESSION_ID_FOOTER =
  "⚠️ Note: this codex run did not return a session id; the next reply will start a fresh chat.";
const CODEX_RESUME_STATE_MISSING_MESSAGE =
  "Codex resume state missing; start a fresh repo-chat session.";
const CLAUDE_STARTUP_HINT =
  "Claude Code exited during startup, possibly MCP/plugin initialization. Repo chat runs with strict empty MCP config; if this still happens, run claude --debug to inspect startup.";

export function buildClaudeRepoChatArgs(params: {
  prompt: string;
  workingDir?: string;
  runId?: string;
  cliSessionId?: string;
  model?: string;
}): string[] {
  const sandboxConfig = buildClaudeCodeSandboxLaunchConfig({
    workingDir: params.workingDir ?? process.cwd(),
    runId: params.runId ?? "repo-chat",
    purpose: "repo-chat",
  });
  const baseArgs = [
    "-p",
    "--output-format",
    "json",
    "--verbose",
    ...sandboxConfig.args,
    "--allowedTools",
    REPO_CHAT_CLAUDE_ALLOWED_TOOLS_READ_ONLY,
    "--append-system-prompt",
    CLAUDE_APPENDED_PROMPT,
  ];

  const mcpConfigPath = ensureEmptyMcpConfig();
  const args = appendStrictMcpArgs(baseArgs, mcpConfigPath);

  if (params.model) {
    args.push("--model", params.model);
  }
  if (params.cliSessionId) {
    args.push("--resume", params.cliSessionId);
  }
  // `--` is the end-of-options separator. Without it, Claude Code's variadic
  // `--mcp-config <configs...>` flag greedily consumes the trailing positional
  // prompt as an additional MCP config file path, causing startup failures like
  // "MCP config file not found: <cwd>/<first words of the prompt>".
  args.push("--", params.prompt);
  return args;
}

export function buildCodexRepoChatArgs(params: {
  prompt: string;
  workingDir: string;
  lastMessageFilePath?: string;
  cliSessionId?: string;
  model?: string;
  codexNativeSandbox?: CodexNativeSandboxConfig;
}): string[] {
  if (params.cliSessionId) {
    // Resume only accepts the flags `codex exec resume --help` documents: passing
    // --color, --sandbox, --cd, or --ask-for-approval here causes codex to exit 2 with
    // "unexpected argument". Sandbox, cwd, and approval policy are inherited from the
    // original session, so we deliberately omit them.
    const args = ["exec", "resume", params.cliSessionId, "--json", "--skip-git-repo-check"];
    if (params.model) {
      args.push("--model", params.model);
    }
    args.push(params.prompt);
    return args;
  }

  const askForApprovalPlacement = getCodexAskForApprovalPlacement();
  const sandboxConfig =
    params.codexNativeSandbox ??
    buildCodexNativeSandboxConfig({
      workingDir: params.workingDir,
      runId: "repo-chat",
      purpose: "repo-chat",
      codexPath: "codex",
    });
  const args = [
    ...(askForApprovalPlacement === "before_exec" ? ["--ask-for-approval", "never"] : []),
    "exec",
    ...(askForApprovalPlacement === "after_exec" ? ["--ask-for-approval", "never"] : []),
    "--json",
    "--color",
    "never",
    "--skip-git-repo-check",
  ];
  appendCodexNativeSandboxExecArgs(args, sandboxConfig);
  if (params.lastMessageFilePath) {
    args.push("--output-last-message", params.lastMessageFilePath);
  }

  if (params.model) {
    args.push("--model", params.model);
  }

  args.push(params.prompt);
  return args;
}

export function resolveRepoChatExecutionRoot(workingDir: string): string {
  if (isPathInsidePrivateRoot(workingDir)) {
    throw new Error("Repo chat cannot run from SmithersBot private paths.");
  }
  return isPathInsideAgentRoot(workingDir) ? resolveAgentRoot() : workingDir;
}

function truncateErrorDetail(detail: string): string {
  const redacted = redactSecretValues(detail);
  if (redacted.length <= MAX_ERROR_DETAIL_CHARS) return redacted;
  return `${redacted.slice(0, MAX_ERROR_DETAIL_CHARS)}...`;
}

function tailErrorDetail(detail: string): string {
  const redacted = redactSecretValues(detail);
  if (redacted.length <= MAX_ERROR_DETAIL_CHARS) return redacted;
  return `...${redacted.slice(redacted.length - MAX_ERROR_DETAIL_CHARS)}`;
}

function isCodexMissingRolloutState(params: {
  backend: RepoChatWorkerParams["backend"];
  cliSessionId?: string;
  stdout: string;
  stderr: string;
}): boolean {
  if (params.backend !== "codex" || !params.cliSessionId) return false;
  return `${params.stderr}\n${params.stdout}`.toLowerCase().includes("no rollout found");
}

function parseClaudeStdoutEvents(stdout: string): Array<Record<string, unknown>> {
  const lineEvents = parseJsonLines(stdout);
  if (lineEvents.length > 0) return lineEvents;

  const trimmed = stdout.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((entry): entry is Record<string, unknown> =>
        Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
      );
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return [parsed as Record<string, unknown>];
    }
  } catch {}
  return [];
}

function isInitOnlyClaudeStdout(stdout: string): boolean {
  const events = parseClaudeStdoutEvents(stdout);
  if (events.length === 0) return false;
  for (const event of events) {
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "assistant" || type === "result") return false;
    if (type !== "system") return false;
  }
  return true;
}

function extractSessionIdFromStdout(stdout: string): string | undefined {
  const sessionIdFields = [
    "session_id",
    "sessionId",
    "conversation_id",
    "conversationId",
    "thread_id",
    "threadId",
  ];
  const nestedSessionIdFields = ["id", "session_id", "thread_id", "conversation_id"];
  const nestedSessionEnvelopes = ["session_configured", "session", "thread"];

  function findInSessionObject(
    obj: Record<string, unknown>,
    fields: readonly string[],
  ): string | undefined {
    let latest: string | undefined;

    for (const field of fields) {
      const value = obj[field];
      if (typeof value === "string" && value.trim()) {
        latest = value.trim();
      }
    }

    return latest;
  }

  function findInObject(obj: Record<string, unknown>): string | undefined {
    let latest: string | undefined;

    for (const field of sessionIdFields) {
      const value = obj[field];
      if (typeof value === "string" && value.trim()) {
        latest = value.trim();
      }
    }

    for (const envelope of nestedSessionEnvelopes) {
      const value = obj[envelope];
      if (value && typeof value === "object" && !Array.isArray(value)) {
        latest =
          findInSessionObject(value as Record<string, unknown>, nestedSessionIdFields) ?? latest;
      }
    }

    return latest;
  }

  function findLatestInParsedJson(parsed: unknown): string | undefined {
    if (Array.isArray(parsed)) {
      let latest: string | undefined;

      for (const item of parsed) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          latest = findInObject(item as Record<string, unknown>) ?? latest;
        }
      }

      return latest;
    }

    if (parsed && typeof parsed === "object") {
      return findInObject(parsed as Record<string, unknown>);
    }

    return undefined;
  }

  let latest: string | undefined;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    try {
      latest = findLatestInParsedJson(JSON.parse(trimmed) as unknown) ?? latest;
    } catch {
      continue;
    }
  }

  if (latest) {
    return latest;
  }

  const wholeStdout = stdout.trim();
  if (!wholeStdout) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(wholeStdout) as unknown;
    // Handle JSON array (Claude Code --output-format json emits an array of event objects).
    return findLatestInParsedJson(parsed);
  } catch {}

  return undefined;
}

function extractResponseFromClaudeStdout(stdout: string): string {
  const events = parseClaudeStdoutEvents(stdout);
  let latestAssistantText = "";
  let latestResultText = "";

  for (const event of events) {
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "assistant") {
      const text = collectText(event).trim();
      if (text) latestAssistantText = text;
      continue;
    }
    if (type === "result") {
      const text = collectText(event).trim();
      if (text) latestResultText = text;
    }
  }

  return (latestAssistantText || latestResultText).trim();
}

export function extractResponseFromCodexStdout(stdout: string): string {
  const lines = parseJsonLines(stdout);
  const parts: string[] = [];
  let finalResultText: string | undefined;

  for (const parsed of lines) {
    const type = typeof parsed.type === "string" ? parsed.type : "";
    if (type === "result" && parsed.is_error !== true) {
      const text = collectText(parsed.result).trim();
      if (text) finalResultText = text;
      continue;
    }
    const text = collectText(parsed).trim();
    if (text && parts.at(-1) !== text) parts.push(text);
  }

  return (finalResultText ?? parts.join("\n")).trim();
}

function extractResponseFromCliStdout(
  backend: RepoChatWorkerParams["backend"],
  stdout: string,
): string {
  const text =
    backend === "claude_code"
      ? extractResponseFromClaudeStdout(stdout)
      : extractResponseFromCodexStdout(stdout);
  return redactSecretValues(text);
}

export function isPlaceholderRepoChatReply(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (trimmed.includes("\n")) return false;

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length > 6) return false;

  const normalized = trimmed.replace(/[.!]$/, "").trim().toLowerCase();
  return new Set(["done", "ok", "okay", "sure", "completed"]).has(normalized);
}

function cleanupResponseFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {}
}

function readResponseFile(filePath: string): string {
  try {
    return redactSecretValues(fs.readFileSync(filePath, "utf-8").trim());
  } catch {
    return "";
  }
}

function readSubstantiveResponseFile(filePath: string): string {
  const responseText = readResponseFile(filePath);
  return isPlaceholderRepoChatReply(responseText) ? "" : responseText;
}

function buildResumeArgs(params: {
  backend: RepoChatWorkerParams["backend"];
  args: string[];
  cliSessionId?: string;
  workingDir: string;
  model?: string;
}): string[] {
  if (params.backend === "claude_code") {
    const repairArgs = [...params.args];
    if (params.cliSessionId && !repairArgs.includes("--resume")) {
      // Splice `--resume <sess>` BEFORE the `--` end-of-options separator so the
      // resume flag stays in the options region. If `--` is not present (legacy
      // args), fall back to inserting before the trailing prompt positional.
      const sepIndex = repairArgs.lastIndexOf("--");
      const insertAt = sepIndex >= 0 ? sepIndex : repairArgs.length - 1;
      repairArgs.splice(insertAt, 0, "--resume", params.cliSessionId);
    }
    return repairArgs;
  }

  // Codex repair: when we have a session id, rebuild a clean codex resume arg list rather
  // than mutating the fresh args. Without this, fresh-only flags (--color, --sandbox, --cd,
  // --ask-for-approval) would be passed to `codex exec resume`, which rejects them.
  if (params.cliSessionId) {
    const originalPrompt = params.args.at(-1) ?? "";
    return buildCodexRepoChatArgs({
      prompt: originalPrompt,
      workingDir: params.workingDir,
      cliSessionId: params.cliSessionId,
      model: params.model,
    });
  }

  return [...params.args];
}

async function runSandboxSafeRepair(params: {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  abortSignal?: AbortSignal;
}): Promise<{ stdout: string; stderr: string }> {
  const repairArgs = [...params.args.slice(0, -1), REPO_CHAT_SANDBOX_REPAIR_PROMPT];

  return runCliProcess({
    command: params.command,
    args: repairArgs,
    cwd: params.cwd,
    timeoutMs: REPAIR_TIMEOUT_MS,
    abortSignal: params.abortSignal,
    env: params.env,
  });
}

export async function runRepoChatWorker(
  params: RepoChatWorkerParams,
): Promise<RepoChatWorkerResult> {
  const executionRoot = resolveRepoChatExecutionRoot(params.workingDir);
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const responseFileId = crypto.randomUUID();
  const manualResponseFilePath = path.join(os.tmpdir(), `moltbot-rc-${responseFileId}.md`);
  const lastMessageFilePath = path.join(os.tmpdir(), `moltbot-rc-${responseFileId}-last.md`);
  const responseFileInstruction = buildResponseFileInstruction({
    backend: params.backend,
    filePath: manualResponseFilePath,
  });
  const augmentedPrompt = `${responseFileInstruction}\n\n---\n\nUser question:\n${params.prompt}`;
  const codexPrompt = `${REPO_CHAT_CONTEXT}\n\n${CODEX_STYLE_DIRECTIVE}\n\n${augmentedPrompt}`;
  const command = params.backend === "claude_code" ? "claude" : "codex";
  const codexNativeSandbox =
    params.backend === "codex"
      ? writeCodexNativeSandboxConfig({
          workingDir: params.workingDir,
          runId: params.codexSandboxRunId ?? `repo-chat-${responseFileId}`,
          purpose: "repo-chat",
          sandboxRoot: process.env.SMITHERSBOT_CODEX_SANDBOX_ROOT,
        })
      : undefined;
  const args =
    params.backend === "claude_code"
      ? buildClaudeRepoChatArgs({
          prompt: augmentedPrompt,
          workingDir: params.workingDir,
          runId: `repo-chat-${responseFileId}`,
          cliSessionId: params.cliSessionId,
          model: params.model,
        })
      : buildCodexRepoChatArgs({
          prompt: codexPrompt,
          workingDir: params.workingDir,
          lastMessageFilePath,
          cliSessionId: params.cliSessionId,
          model: params.model,
          codexNativeSandbox,
        });
  const env =
    params.backend === "claude_code"
      ? buildClaudeCodeEnv(params.claudeCodeAuth ?? "subscription")
      : mergeCodexNativeSandboxEnv(buildCredentialStrippedEnv(), codexNativeSandbox!);

  try {
    const { stdout, stderr, timedOut, exitCode, signal, durationMs } = await runCliProcess({
      command,
      args,
      cwd: executionRoot,
      timeoutMs,
      abortSignal: params.abortSignal,
      env,
    });

    if (timedOut) {
      throw new Error(`Repo chat worker timed out after ${timeoutMs}ms.`);
    }

    if (exitCode !== 0) {
      if (
        isCodexMissingRolloutState({
          backend: params.backend,
          cliSessionId: params.cliSessionId,
          stdout,
          stderr,
        })
      ) {
        throw new Error(CODEX_RESUME_STATE_MISSING_MESSAGE);
      }
      const stderrTrimmed = stderr.trim();
      const stdoutTrimmed = stdout.trim();
      let detailBody = "";
      if (stderrTrimmed) {
        detailBody = truncateErrorDetail(stderrTrimmed);
      } else if (stdoutTrimmed) {
        detailBody = tailErrorDetail(stdoutTrimmed);
      }
      const meta = `exit=${exitCode ?? "unknown"} signal=${signal ?? "none"} durationMs=${durationMs}`;
      const detailSegment = detailBody ? `: ${detailBody}` : "";
      const hintSegment =
        !stderrTrimmed && params.backend === "claude_code" && isInitOnlyClaudeStdout(stdout)
          ? ` ${CLAUDE_STARTUP_HINT}`
          : "";
      throw new Error(
        `Repo chat worker failed (${command} exit ${exitCode ?? "unknown"})${detailSegment} (${meta})${hintSegment}`,
      );
    }

    const cliSessionId =
      extractSessionIdFromStdout(stdout) ??
      extractSessionIdFromStdout(stderr) ??
      (params.cliSessionId?.trim() || undefined);
    let rejectedPlaceholderFallback = false;
    let responseText = extractResponseFromCliStdout(params.backend, stdout);
    if (isPlaceholderRepoChatReply(responseText)) {
      rejectedPlaceholderFallback = Boolean(responseText);
      responseText = "";
    }

    if (!responseText && params.backend === "codex") {
      const lastMessageText = readResponseFile(lastMessageFilePath);
      if (lastMessageText && !isPlaceholderRepoChatReply(lastMessageText)) {
        responseText = lastMessageText;
      } else {
        rejectedPlaceholderFallback = rejectedPlaceholderFallback || Boolean(lastMessageText);
      }
    }

    if (!responseText) {
      responseText = readSubstantiveResponseFile(manualResponseFilePath);
    }

    if (!responseText) {
      const resumeArgs = buildResumeArgs({
        backend: params.backend,
        args,
        cliSessionId,
        workingDir: params.workingDir,
        model: params.model,
      });

      const repairResult = await runSandboxSafeRepair({
        command,
        args: resumeArgs,
        cwd: executionRoot,
        env,
        abortSignal: params.abortSignal,
      });

      const repairStdoutText = extractResponseFromCliStdout(params.backend, repairResult.stdout);
      if (isPlaceholderRepoChatReply(repairStdoutText)) {
        rejectedPlaceholderFallback = rejectedPlaceholderFallback || Boolean(repairStdoutText);
      } else {
        responseText = repairStdoutText;
      }

      if (!responseText && params.backend === "codex") {
        const lastMessageText = readResponseFile(lastMessageFilePath);
        if (lastMessageText && !isPlaceholderRepoChatReply(lastMessageText)) {
          responseText = lastMessageText;
        } else {
          rejectedPlaceholderFallback = rejectedPlaceholderFallback || Boolean(lastMessageText);
        }
      }

      if (!responseText) {
        responseText = readSubstantiveResponseFile(manualResponseFilePath);
      }
    }

    if (!responseText) {
      throw new Error(
        `Repo chat worker completed without a deliverable response after CLI extraction, legacy response-file check, and sandbox-safe repair.${
          rejectedPlaceholderFallback ? " (placeholder stdout reply rejected)" : ""
        }`,
      );
    }

    if (params.backend === "codex" && !params.cliSessionId && !cliSessionId) {
      getLogger().warn(
        "codex emitted no session id; next /repo_chat turn will start a new conversation",
        { runId: undefined, workerPath: params.workingDir },
      );
      responseText = `${responseText}\n\n${CODEX_NO_SESSION_ID_FOOTER}`;
    }

    return {
      backend: params.backend,
      text: responseText,
      cliSessionId,
      durationMs,
      stdout: redactSecretValues(stdout),
      stderr: redactSecretValues(stderr),
    };
  } finally {
    cleanupResponseFile(manualResponseFilePath);
    cleanupResponseFile(lastMessageFilePath);
  }
}

export const REPO_CHAT_READ_ONLY_PROMPT = CLAUDE_READ_ONLY_PROMPT;
export const REPO_CHAT_CLAUDE_ALLOWED_TOOLS = REPO_CHAT_CLAUDE_ALLOWED_TOOLS_READ_ONLY;
export const REPO_CHAT_CODEX_STYLE_PROMPT = CODEX_STYLE_DIRECTIVE;
