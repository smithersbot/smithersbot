import { spawn, type ChildProcess } from "node:child_process";
import type { ClaudeCodeAuthMode } from "../config/types.goal.js";
import { buildClaudeCodeEnv } from "../goal/claude-code-env.js";
import type { HardDeny } from "../goal/capability-types.js";
import { HARD_DENIES } from "../goal/hard-deny.js";
import { resolveClaudeBinary } from "../goal/scout.js";

const GSTACK_ALLOWED_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "Bash(*)",
  "Agent",
  "AskUserQuestion",
  "WebSearch",
  "Skill",
  "ToolSearch",
] as const;

export type BuildGstackArgsParams = {
  denyContent?: string;
  extraArgs?: string[];
  allowedTools?: string[];
};

export type RunGstackParams = {
  claudeCodeAuth: ClaudeCodeAuthMode;
  args?: string[];
  cwd?: string;
};

export type GstackRunResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

export function buildGstackAllowedTools(): string[] {
  return [...GSTACK_ALLOWED_TOOLS];
}

export function buildDenyContent(hardDenies: HardDeny[] = HARD_DENIES): string {
  const lines: string[] = ["HARD DENIES (enforced):"];
  for (const deny of hardDenies) {
    lines.push(`- DENIED: ${deny.pattern} — ${deny.reason}`);
  }
  return lines.join("\n");
}

export function buildGstackArgs(params: BuildGstackArgsParams = {}): string[] {
  const denyContent = params.denyContent ?? buildDenyContent();
  const allowedTools = params.allowedTools ?? buildGstackAllowedTools();
  return [
    "--allowedTools",
    allowedTools.join(","),
    "--append-system-prompt",
    denyContent,
    ...(params.extraArgs ?? []),
  ];
}

export async function runGstack(params: RunGstackParams): Promise<GstackRunResult> {
  const claudeBinary = resolveClaudeBinary();
  if (!claudeBinary) {
    throw new Error("claude binary not found on PATH");
  }

  const child: ChildProcess = spawn(claudeBinary, buildGstackArgs({ extraArgs: params.args }), {
    cwd: params.cwd ?? process.cwd(),
    env: buildClaudeCodeEnv(params.claudeCodeAuth),
    stdio: "inherit",
  });

  return await new Promise<GstackRunResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      resolve({ exitCode, signal });
    });
  });
}
