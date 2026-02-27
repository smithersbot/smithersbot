import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
const REPAIR_TIMEOUT_MS = 60_000;

export function buildClaudeRepoChatArgs(params: {
  prompt: string;
  cliSessionId?: string;
  model?: string;
}): string[] {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--verbose",
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

function truncateErrorDetail(detail: string): string {
  if (detail.length <= MAX_ERROR_DETAIL_CHARS) return detail;
  return `${detail.slice(0, MAX_ERROR_DETAIL_CHARS)}...`;
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

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      for (const field of sessionIdFields) {
        const value = parsed[field];
        if (typeof value === "string" && value.trim()) {
          return value.trim();
        }
      }
    } catch {
      continue;
    }
  }

  const wholeStdout = stdout.trim();
  if (!wholeStdout) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(wholeStdout) as Record<string, unknown>;
    for (const field of sessionIdFields) {
      const value = parsed[field];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  } catch {}

  return undefined;
}

function cleanupResponseFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {}
}

function buildResumeArgs(params: {
  backend: RepoChatWorkerParams["backend"];
  args: string[];
  cliSessionId?: string;
}): string[] {
  const repairArgs = [...params.args];

  if (params.backend === "claude_code") {
    if (params.cliSessionId && !repairArgs.includes("--resume")) {
      repairArgs.splice(repairArgs.length - 1, 0, "--resume", params.cliSessionId);
    }
    return repairArgs;
  }

  const jsonIndex = repairArgs.indexOf("--json");
  if (jsonIndex >= 0) {
    repairArgs.splice(jsonIndex, 1);
  }

  if (!params.cliSessionId || repairArgs.includes("resume")) {
    return repairArgs;
  }

  const execIndex = repairArgs.indexOf("exec");
  if (execIndex >= 0) {
    repairArgs.splice(execIndex + 1, 0, "resume", params.cliSessionId);
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
  const responseFilePath = path.join(os.tmpdir(), `moltbot-rc-${crypto.randomUUID()}.md`);
  const responseFileInstruction = buildResponseFileInstruction(responseFilePath);
  const augmentedPrompt = `${responseFileInstruction}\n\n---\n\nUser question:\n${params.prompt}`;
  const command = params.backend === "claude_code" ? "claude" : "codex";
  const args =
    params.backend === "claude_code"
      ? buildClaudeRepoChatArgs({
          prompt: augmentedPrompt,
          cliSessionId: params.cliSessionId,
          model: params.model,
        })
      : buildCodexRepoChatArgs({
          prompt: augmentedPrompt,
          workingDir: params.workingDir,
          cliSessionId: params.cliSessionId,
          model: params.model,
        });
  const env =
    params.backend === "claude_code"
      ? buildClaudeCodeEnv(params.claudeCodeAuth ?? "subscription")
      : { ...process.env };

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
      const details =
        truncateErrorDetail(stderr.trim() || stdout.trim()) || `signal=${signal ?? "none"}`;
      throw new Error(
        `Repo chat worker failed (${command} exit ${exitCode ?? "unknown"}): ${details}`,
      );
    }

    const cliSessionId = extractSessionIdFromStdout(stdout) ?? params.cliSessionId;
    let responseText = "";

    try {
      responseText = fs.readFileSync(responseFilePath, "utf-8").trim();
    } catch {}

    if (!responseText) {
      const resumeArgs = buildResumeArgs({
        backend: params.backend,
        args,
        cliSessionId,
      });

      responseText = await repairResponseFile({
        responseFilePath,
        command,
        args: resumeArgs,
        cwd: params.workingDir,
        env,
        abortSignal: params.abortSignal,
      });
    }

    if (!responseText) {
      throw new Error(
        "Repo chat worker completed but did not write a response file, even after repair attempt.",
      );
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
    cleanupResponseFile(responseFilePath);
  }
}

export const REPO_CHAT_READ_ONLY_PROMPT = CLAUDE_READ_ONLY_PROMPT;
export const REPO_CHAT_CLAUDE_ALLOWED_TOOLS = CLAUDE_ALLOWED_TOOLS;
