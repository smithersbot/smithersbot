import { getCodexAskForApprovalPlacement } from "../goal/backend-availability.js";
import { buildClaudeCodeEnv } from "../goal/claude-code-env.js";
import { runCliProcess } from "../goal/cli-process.js";
import { REPO_CHAT_CONTEXT } from "./repo-chat-context.js";
import type { RepoChatWorkerParams, RepoChatWorkerResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 3_600_000;
const CLAUDE_ALLOWED_TOOLS = "Read,Glob,Grep,Bash";
const CLAUDE_READ_ONLY_PROMPT = "This is READ-ONLY. Do NOT create, modify, or delete any files.";
const CLAUDE_APPENDED_PROMPT = `${CLAUDE_READ_ONLY_PROMPT}\n\n${REPO_CHAT_CONTEXT}`;
const MAX_ERROR_DETAIL_CHARS = 1_000;
const MAX_FALLBACK_TEXT_CHARS = 8_000;
const FALLBACK_TRUNCATION_NOTICE = "\n\n[Output truncated]";

type ParsedRepoChatOutput = {
  text: string;
  cliSessionId?: string;
};

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

function isCodexMessageItemEvent(parsed: Record<string, unknown>): boolean {
  const type = typeof parsed.type === "string" ? parsed.type.trim() : "";
  if (type) return false;
  return isRecord(parsed.item) && parsed.item.type === "message";
}

function isAssistantContentBlockDeltaEvent(parsed: Record<string, unknown>): boolean {
  if (parsed.type !== "content_block_delta") return false;
  if (!isRecord(parsed.delta)) return false;

  const deltaType = typeof parsed.delta.type === "string" ? parsed.delta.type : "";
  if (deltaType && deltaType !== "text_delta") {
    return false;
  }

  return collectText(parsed.delta).trim().length > 0;
}

function shouldIncludeFallbackEventText(parsed: Record<string, unknown>): boolean {
  const type = typeof parsed.type === "string" ? parsed.type : "";
  if (type === "assistant") return true;
  if (isAssistantContentBlockDeltaEvent(parsed)) return true;
  if (isCodexMessageItemEvent(parsed)) return true;
  return false;
}

function truncateFallbackText(text: string): string {
  if (text.length <= MAX_FALLBACK_TEXT_CHARS) return text;
  const maxBodyChars = Math.max(0, MAX_FALLBACK_TEXT_CHARS - FALLBACK_TRUNCATION_NOTICE.length);
  return `${text.slice(0, maxBodyChars)}${FALLBACK_TRUNCATION_NOTICE}`;
}

export function parseRepoChatStreamJson(raw: string): ParsedRepoChatOutput {
  const lines = parseJsonLines(raw);

  let cliSessionId: string | undefined;
  let finalResultText: string | undefined;
  const textParts: string[] = [];

  for (const parsed of lines) {
    cliSessionId = cliSessionId ?? pickSessionId(parsed);

    const type = typeof parsed.type === "string" ? parsed.type : "";
    const isError = parsed.is_error === true;

    if (type === "result" && !isError) {
      const resultText = collectText(parsed.result).trim();
      if (resultText) {
        finalResultText = resultText;
      }
      continue;
    }
    if (!shouldIncludeFallbackEventText(parsed)) {
      continue;
    }

    const eventText = collectText(parsed).trim();
    if (!eventText) continue;
    if (textParts.at(-1) !== eventText) {
      textParts.push(eventText);
    }
  }

  const fallbackText = truncateFallbackText(textParts.join("\n"));
  return {
    text: (finalResultText ?? fallbackText).trim(),
    cliSessionId,
  };
}

function parseRepoChatStreamJsonError(raw: string): ParsedRepoChatOutput {
  const lines = parseJsonLines(raw);

  let cliSessionId: string | undefined;
  let errorResultText: string | undefined;
  const textParts: string[] = [];

  for (const parsed of lines) {
    cliSessionId = cliSessionId ?? pickSessionId(parsed);

    const type = typeof parsed.type === "string" ? parsed.type : "";
    const isError = parsed.is_error === true;

    if (type === "result" && isError) {
      const resultText = collectText(parsed.result).trim();
      if (resultText) {
        errorResultText = resultText;
      }
      continue;
    }
    if (!shouldIncludeFallbackEventText(parsed)) {
      continue;
    }

    const eventText = collectText(parsed).trim();
    if (!eventText) continue;
    if (textParts.at(-1) !== eventText) {
      textParts.push(eventText);
    }
  }

  const fallbackText = truncateFallbackText(textParts.join("\n"));
  return {
    text: (errorResultText ?? fallbackText).trim(),
    cliSessionId,
  };
}

export function buildClaudeRepoChatArgs(params: {
  prompt: string;
  cliSessionId?: string;
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
    CLAUDE_APPENDED_PROMPT,
  ];

  if (params.model) {
    args.push("--model", params.model);
  }
  if (params.cliSessionId) {
    args.push("--resume", params.cliSessionId);
  }
  args.push(params.prompt);
  return args;
}

export function buildCodexRepoChatArgs(params: {
  prompt: string;
  workingDir: string;
  cliSessionId?: string;
  model?: string;
}): string[] {
  const askForApprovalPlacement = getCodexAskForApprovalPlacement();
  const args = [
    ...(askForApprovalPlacement === "before_exec" ? ["--ask-for-approval", "never"] : []),
    "exec",
    ...(askForApprovalPlacement === "after_exec" ? ["--ask-for-approval", "never"] : []),
  ];

  if (params.cliSessionId) {
    args.push("resume", params.cliSessionId);
  }

  if (!params.cliSessionId) {
    args.push("--json");
  }

  args.push("--color", "never", "--sandbox", "read-only", "--skip-git-repo-check");
  args.push("--cd", params.workingDir);

  if (params.model) {
    args.push("--model", params.model);
  }

  args.push(params.prompt);
  return args;
}

function parseRepoChatOutput(rawStdout: string): ParsedRepoChatOutput {
  const parsed = parseRepoChatStreamJson(rawStdout);
  if (parsed.text) return parsed;
  return { text: rawStdout.trim(), cliSessionId: parsed.cliSessionId };
}

function truncateErrorDetail(detail: string): string {
  if (detail.length <= MAX_ERROR_DETAIL_CHARS) return detail;
  return `${detail.slice(0, MAX_ERROR_DETAIL_CHARS)}...`;
}

function parseRepoChatErrorDetails(stdout: string, stderr: string): string {
  const parsedStdout = parseRepoChatStreamJsonError(stdout);
  if (parsedStdout.text) return truncateErrorDetail(parsedStdout.text);

  const parsedStderr = parseRepoChatStreamJsonError(stderr);
  if (parsedStderr.text) return truncateErrorDetail(parsedStderr.text);

  const plainDetail = stderr.trim() || stdout.trim();
  if (plainDetail) return truncateErrorDetail(plainDetail);

  return "";
}

export async function runRepoChatWorker(
  params: RepoChatWorkerParams,
): Promise<RepoChatWorkerResult> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const command = params.backend === "claude_code" ? "claude" : "codex";
  const args =
    params.backend === "claude_code"
      ? buildClaudeRepoChatArgs({
          prompt: params.prompt,
          cliSessionId: params.cliSessionId,
          model: params.model,
        })
      : buildCodexRepoChatArgs({
          prompt: params.prompt,
          workingDir: params.workingDir,
          cliSessionId: params.cliSessionId,
          model: params.model,
        });

  const { stdout, stderr, timedOut, exitCode, signal, durationMs } = await runCliProcess({
    command,
    args,
    cwd: params.workingDir,
    timeoutMs,
    abortSignal: params.abortSignal,
    env:
      params.backend === "claude_code"
        ? buildClaudeCodeEnv(params.claudeCodeAuth ?? "subscription")
        : { ...process.env },
  });

  if (timedOut) {
    throw new Error(`Repo chat worker timed out after ${timeoutMs}ms.`);
  }

  if (exitCode !== 0) {
    const details = parseRepoChatErrorDetails(stdout, stderr) || `signal=${signal ?? "none"}`;
    throw new Error(
      `Repo chat worker failed (${command} exit ${exitCode ?? "unknown"}): ${details}`,
    );
  }

  const parsed = parseRepoChatOutput(stdout);
  if (!parsed.text) {
    throw new Error("Repo chat worker completed without a response message.");
  }

  return {
    backend: params.backend,
    text: parsed.text,
    cliSessionId: parsed.cliSessionId ?? params.cliSessionId,
    durationMs,
    stdout,
    stderr,
  };
}

export const REPO_CHAT_READ_ONLY_PROMPT = CLAUDE_READ_ONLY_PROMPT;
export const REPO_CHAT_CLAUDE_ALLOWED_TOOLS = CLAUDE_ALLOWED_TOOLS;
