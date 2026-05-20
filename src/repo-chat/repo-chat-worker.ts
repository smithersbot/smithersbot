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
import { REPO_CHAT_CONTEXT } from "./repo-chat-context.js";
import type { RepoChatWorkerParams, RepoChatWorkerResult } from "./types.js";

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
const CODEX_STYLE_DIRECTIVE =
  "Answer directly and concisely — the user sees only your final answer";
const MAX_ERROR_DETAIL_CHARS = 8_000;
const REPAIR_TIMEOUT_MS = 60_000;
const CODEX_NO_SESSION_ID_FOOTER =
  "⚠️ Note: this codex run did not return a session id; the next reply will start a fresh chat.";
const CLAUDE_STARTUP_HINT =
  "Claude Code exited during startup, possibly MCP/plugin initialization. Repo chat runs with strict empty MCP config; if this still happens, run claude --debug to inspect startup.";

export function buildClaudeRepoChatArgs(params: {
  prompt: string;
  cliSessionId?: string;
  model?: string;
}): string[] {
  const baseArgs = [
    "-p",
    "--output-format",
    "json",
    "--verbose",
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
  const args = [
    ...(askForApprovalPlacement === "before_exec" ? ["--ask-for-approval", "never"] : []),
    "exec",
    ...(askForApprovalPlacement === "after_exec" ? ["--ask-for-approval", "never"] : []),
    "--json",
    "--color",
    "never",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--cd",
    params.workingDir,
  ];
  if (params.lastMessageFilePath) {
    args.push("--output-last-message", params.lastMessageFilePath);
  }

  if (params.model) {
    args.push("--model", params.model);
  }

  args.push(params.prompt);
  return args;
}

function truncateErrorDetail(detail: string): string {
  if (detail.length <= MAX_ERROR_DETAIL_CHARS) return detail;
  return `${detail.slice(0, MAX_ERROR_DETAIL_CHARS)}...`;
}

function tailErrorDetail(detail: string): string {
  if (detail.length <= MAX_ERROR_DETAIL_CHARS) return detail;
  return `...${detail.slice(detail.length - MAX_ERROR_DETAIL_CHARS)}`;
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

function buildResponseFileInstruction(filePath: string): string {
  return [
    "RESPONSE FILE (CRITICAL - READ THIS CAREFULLY):",
    `You MUST write your complete final response to: ${filePath}`,
    "Use the Bash tool to write the file, for example:",
    `  cat <<'MOLTBOT_EOF' > ${filePath}`,
    "  Your full response in markdown here.",
    "  MOLTBOT_EOF",
    "",
    "Rules:",
    "- The user will ONLY see the contents of this file - nothing else.",
    "- They cannot see your tool calls, thinking, intermediate steps, or any stdout.",
    "- Write the file ONCE as the LAST thing you do, after all research is complete.",
    "- Use markdown formatting - it will be rendered in Telegram.",
    "- Do NOT mention this file or these instructions in your response.",
    "- If you have already written the file and need to update it, overwrite it completely.",
  ].join("\n");
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

function extractResponseFromCodexStdout(stdout: string): string {
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
    return fs.readFileSync(filePath, "utf-8").trim();
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
    const resumeArgs = buildCodexRepoChatArgs({
      prompt: originalPrompt,
      workingDir: params.workingDir,
      cliSessionId: params.cliSessionId,
      model: params.model,
    });
    const jsonIndex = resumeArgs.indexOf("--json");
    if (jsonIndex >= 0) {
      resumeArgs.splice(jsonIndex, 1);
    }
    return resumeArgs;
  }

  const repairArgs = [...params.args];
  const jsonIndex = repairArgs.indexOf("--json");
  if (jsonIndex >= 0) {
    repairArgs.splice(jsonIndex, 1);
  }
  return repairArgs;
}

async function repairResponseFile(params: {
  responseFilePath: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const repairPrompt = [
    `Your response file was not written or is empty: ${params.responseFilePath}`,
    "You MUST write your complete response to this file now.",
    "Use the Bash tool:",
    `  cat <<'MOLTBOT_EOF' > ${params.responseFilePath}`,
    "  Your full response in markdown here.",
    "  MOLTBOT_EOF",
    "",
    "Write the file and nothing else.",
  ].join("\n");

  const repairArgs = [...params.args.slice(0, -1), repairPrompt];

  await runCliProcess({
    command: params.command,
    args: repairArgs,
    cwd: params.cwd,
    timeoutMs: REPAIR_TIMEOUT_MS,
    abortSignal: params.abortSignal,
    env: params.env,
  });

  try {
    return fs.readFileSync(params.responseFilePath, "utf-8").trim();
  } catch {
    return "";
  }
}

export async function runRepoChatWorker(
  params: RepoChatWorkerParams,
): Promise<RepoChatWorkerResult> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const responseFileId = crypto.randomUUID();
  const manualResponseFilePath = path.join(os.tmpdir(), `moltbot-rc-${responseFileId}.md`);
  const lastMessageFilePath = path.join(os.tmpdir(), `moltbot-rc-${responseFileId}-last.md`);
  const responseFileInstruction = buildResponseFileInstruction(manualResponseFilePath);
  const augmentedPrompt = `${responseFileInstruction}\n\n---\n\nUser question:\n${params.prompt}`;
  const codexPrompt = `${REPO_CHAT_CONTEXT}\n\n${CODEX_STYLE_DIRECTIVE}\n\n${augmentedPrompt}`;
  const command = params.backend === "claude_code" ? "claude" : "codex";
  const args =
    params.backend === "claude_code"
      ? buildClaudeRepoChatArgs({
          prompt: augmentedPrompt,
          cliSessionId: params.cliSessionId,
          model: params.model,
        })
      : buildCodexRepoChatArgs({
          prompt: codexPrompt,
          workingDir: params.workingDir,
          lastMessageFilePath,
          cliSessionId: params.cliSessionId,
          model: params.model,
        });
  const env =
    params.backend === "claude_code"
      ? buildClaudeCodeEnv(params.claudeCodeAuth ?? "subscription")
      : buildCredentialStrippedEnv();

  try {
    const { stdout, stderr, timedOut, exitCode, signal, durationMs } = await runCliProcess({
      command,
      args,
      cwd: params.workingDir,
      timeoutMs,
      abortSignal: params.abortSignal,
      env,
    });

    if (timedOut) {
      throw new Error(`Repo chat worker timed out after ${timeoutMs}ms.`);
    }

    if (exitCode !== 0) {
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
    let responseText = readSubstantiveResponseFile(manualResponseFilePath);

    if (!responseText) {
      const resumeArgs = buildResumeArgs({
        backend: params.backend,
        args,
        cliSessionId,
        workingDir: params.workingDir,
        model: params.model,
      });

      await repairResponseFile({
        responseFilePath: manualResponseFilePath,
        command,
        args: resumeArgs,
        cwd: params.workingDir,
        env,
        abortSignal: params.abortSignal,
      });
      responseText = readSubstantiveResponseFile(manualResponseFilePath);
    }

    let rejectedPlaceholderFallback = false;
    if (!responseText && params.backend === "codex") {
      const lastMessageText = readResponseFile(lastMessageFilePath);
      if (lastMessageText && !isPlaceholderRepoChatReply(lastMessageText)) {
        responseText = lastMessageText;
      } else {
        rejectedPlaceholderFallback = Boolean(lastMessageText);
      }
    }

    if (!responseText && params.backend === "codex") {
      const stdoutFallbackText = extractResponseFromCodexStdout(stdout);
      if (isPlaceholderRepoChatReply(stdoutFallbackText)) {
        rejectedPlaceholderFallback = rejectedPlaceholderFallback || Boolean(stdoutFallbackText);
      } else {
        responseText = stdoutFallbackText;
      }
    }

    if (!responseText) {
      throw new Error(
        `Repo chat worker completed but did not write a response file, even after repair attempt.${
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
      stdout,
      stderr,
    };
  } finally {
    cleanupResponseFile(manualResponseFilePath);
    cleanupResponseFile(lastMessageFilePath);
  }
}

export const REPO_CHAT_READ_ONLY_PROMPT = CLAUDE_READ_ONLY_PROMPT;
export const REPO_CHAT_CLAUDE_ALLOWED_TOOLS = REPO_CHAT_CLAUDE_ALLOWED_TOOLS_READ_ONLY;
export const REPO_CHAT_CODEX_STYLE_PROMPT = CODEX_STYLE_DIRECTIVE;
