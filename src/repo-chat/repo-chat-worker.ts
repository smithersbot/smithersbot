import { getCodexAskForApprovalPlacement } from "../goal/backend-availability.js";
import { runCliProcess } from "../goal/cli-process.js";
import type { RepoChatWorkerParams, RepoChatWorkerResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 180_000;
const CLAUDE_ALLOWED_TOOLS = "Read,Glob,Grep,Bash";
const CLAUDE_READ_ONLY_PROMPT = "This is READ-ONLY. Do NOT create, modify, or delete any files.";

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

export function parseRepoChatStreamJson(raw: string): ParsedRepoChatOutput {
  const lines = raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);

  let cliSessionId: string | undefined;
  let finalResultText: string | undefined;
  const textParts: string[] = [];

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;

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

    const eventText = collectText(parsed).trim();
    if (!eventText) continue;
    if (textParts.at(-1) !== eventText) {
      textParts.push(eventText);
    }
  }

  return {
    text: (finalResultText ?? textParts.join("\n")).trim(),
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
    "--output-format",
    "stream-json",
    "--allowedTools",
    CLAUDE_ALLOWED_TOOLS,
    "--append-system-prompt",
    CLAUDE_READ_ONLY_PROMPT,
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
  });

  if (timedOut) {
    throw new Error(`Repo chat worker timed out after ${timeoutMs}ms.`);
  }

  if (exitCode !== 0) {
    const details = stderr.trim() || stdout.trim() || `signal=${signal ?? "none"}`;
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
