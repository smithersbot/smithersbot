import { execFile } from "node:child_process";
import os from "node:os";
import { Bot } from "grammy";
import type { MoltbotConfig } from "../config/config.js";
import type { NightwatchConfig } from "../config/types.cron.js";
import { resolveTelegramAccount } from "../telegram/accounts.js";
import { createCaptureRuntime, handleGoal, sendGoalPlanResult } from "../telegram/goal-commands.js";
import { CronService } from "./service.js";

export const NIGHTWATCH_DEFAULTS = {
  cronExpr: "0 3 * * *",
  repoPath: "~/moltbot",
  timezone: "America/New_York",
} as const;

export const NIGHTWATCH_JOB_NAME = "nightwatch-daily";
const NIGHTWATCH_SENTINEL_MESSAGE = "__nightwatch__";

export type NightwatchRunResult =
  | { status: "ok"; summary: string }
  | { status: "skipped"; summary: string }
  | { status: "error"; error: string; summary?: string };

export function expandTilde(p: string): string {
  if (!p.startsWith("~")) return p;
  return `${os.homedir()}${p.slice(1)}`;
}

function runExecFileUtf8(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

export async function checkGitChanges(
  repoPath: string,
  sinceIso?: string,
): Promise<{ hasChanges: boolean; summary: string }> {
  const expandedPath = expandTilde(repoPath);
  const sinceValue = typeof sinceIso === "string" && sinceIso.trim() ? sinceIso.trim() : "24h";
  const stdout = await runExecFileUtf8("git", [
    "-C",
    expandedPath,
    "log",
    `--since=${sinceValue}`,
    "--oneline",
  ]);
  const summary = stdout.trim();
  return { hasChanges: summary.length > 0, summary };
}

export function buildNightwatchPrompt(): string {
  return `Nightwatch nightly review for the Moltbot repository.

Perform a thorough analysis of the current codebase focusing on these areas:

## 1. The /new_goal workflow (end-to-end)
Trace the full lifecycle: /new_goal command → planner → autocheck loop → approval → executor → workers → completion.
Key files: src/goal/planner.ts, src/goal/agent-executor.ts, src/goal/cli-worker.ts, src/goal/plan-autocheck.ts, src/commands/goal.ts, src/telegram/goal-commands.ts.
Look for:
- Bugs or logic errors in the happy path
- Edge cases in blocked/failed/cancelled states and transitions between them
- Problems with /goal_answer, /goal_feedback, /goal_edit after a plan has been approved or executed
- Race conditions or lock issues (goal op locks, concurrent runs)
- Error handling gaps where failures could leave runs in a broken state

## 2. Telegram UX integration
Review how goal commands are wired up in Telegram: command registration, message formatting, button callbacks, thread handling.
Key files: src/telegram/goal-commands.ts, src/telegram/bot-native-commands.ts, src/telegram/nightwatch-commands.ts.
Look for:
- Commands that are missing or not properly registered
- Inconsistent or confusing user-facing messages
- Missing error feedback (silent failures the user would never see)
- Obvious UX improvements (e.g. missing confirmation, unclear status messages, long messages that should be truncated or paginated)

## 3. Architecture simplification opportunities
Look across the goal system and Telegram integration for:
- Dead code or unused exports
- Overly complex abstractions that could be flattened
- Duplicated logic that could be consolidated
- Indirection that makes the code harder to follow without adding real value

## 4. Cross-workflow consistency
Look for inconsistencies across workflows where a bug fix, UX pattern, or quality-of-life improvement exists in one place but is missing from analogous workflows that would benefit equally.
Concrete example:
- For /new_goal, the "Right away, sir." acknowledgment replies to the user's message so the user sees which goal is being planned.
- When the user clicks "Approve", the confirmation message is not sent as a reply to the approval button message, making it unclear which plan was just approved.
Find and prioritize similar patterns where one workflow already has a good practice (like reply-to-message context) and other workflows lack it.

## Output
Produce a goal plan with concrete, actionable steps that fix real bugs and make high-value improvements.
Prioritize correctness bugs over style issues. Do not propose changes unless you have read the actual code and confirmed the problem exists.
Each step should include both the fix and its test.`;
}

export async function runNightwatch(params: {
  cfg: MoltbotConfig;
  nightwatchCfg: NightwatchConfig | undefined;
  lastRunAtMs?: number;
}): Promise<NightwatchRunResult> {
  const { cfg, nightwatchCfg, lastRunAtMs } = params;
  if (!nightwatchCfg || nightwatchCfg.enabled !== true) {
    return { status: "skipped", summary: "Nightwatch is not configured or disabled" };
  }

  const rawChatId = nightwatchCfg.telegramChatId;
  if (rawChatId == null || String(rawChatId).trim() === "") {
    return {
      status: "error",
      error: "No Telegram chat target configured. Use /nightwatch chat to set one.",
    };
  }
  const chatId = String(rawChatId);

  const account = resolveTelegramAccount({
    cfg,
    accountId: nightwatchCfg.telegramAccountId,
  });
  if (!account.token?.trim()) {
    return {
      status: "error",
      error: "Could not resolve Telegram account token. Check your Telegram configuration.",
    };
  }

  try {
    const sinceIso =
      typeof lastRunAtMs === "number" && lastRunAtMs > 0
        ? new Date(lastRunAtMs).toISOString()
        : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const repoPath = nightwatchCfg.repoPath ?? NIGHTWATCH_DEFAULTS.repoPath;
    const gitChanges = await checkGitChanges(repoPath, sinceIso);
    if (!gitChanges.hasChanges) {
      return { status: "skipped", summary: "No git changes since last run" };
    }

    const goalPlanResult = await handleGoal(buildNightwatchPrompt(), cfg);
    const bot = new Bot(account.token);
    await sendGoalPlanResult({
      bot,
      chatId: Number(chatId),
      runtime: createCaptureRuntime().runtime,
      result: goalPlanResult,
      threadId: nightwatchCfg.telegramThreadId,
    });
    return { status: "ok", summary: "Plan delivered to Telegram" };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function registerNightwatchJob(
  cronService: CronService,
  nightwatchCfg: NightwatchConfig | undefined,
): Promise<void> {
  const jobs = (await cronService.list({ includeDisabled: true })).filter(
    (job) => job.name === NIGHTWATCH_JOB_NAME,
  );

  if (!nightwatchCfg || nightwatchCfg.enabled !== true) {
    for (const job of jobs) {
      await cronService.remove(job.id);
    }
    return;
  }

  const cronExpr = nightwatchCfg.cronExpr ?? NIGHTWATCH_DEFAULTS.cronExpr;
  const tz = nightwatchCfg.timezone ?? NIGHTWATCH_DEFAULTS.timezone;
  const [existing, ...duplicates] = jobs;

  for (const duplicate of duplicates) {
    await cronService.remove(duplicate.id);
  }

  if (existing) {
    await cronService.update(existing.id, {
      enabled: true,
      schedule: {
        kind: "cron",
        expr: cronExpr,
        tz,
      },
    });
    return;
  }

  await cronService.add({
    name: NIGHTWATCH_JOB_NAME,
    description: "Daily nightwatch code review",
    enabled: true,
    schedule: {
      kind: "cron",
      expr: cronExpr,
      tz,
    },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: NIGHTWATCH_SENTINEL_MESSAGE,
    },
  });
}
