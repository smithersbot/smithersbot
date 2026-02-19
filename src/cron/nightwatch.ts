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

export function buildNightwatchPrompt(gitSummary: string): string {
  const normalizedSummary = gitSummary.trim() || "(no git changes summarized)";
  return [
    "Nightwatch daily review for the Moltbot repository.",
    "First map out how the goal process works.",
    "Identify any important bugs that need to be solved and create a plan to fix and test them.",
    "Send the plan to the user over Telegram in the normal /new_goal approval flow so they can approve or reject it when they wake up.",
    "",
    "Git changes since the last nightwatch run:",
    normalizedSummary,
  ].join("\n");
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

    const goalPlanResult = await handleGoal(buildNightwatchPrompt(gitChanges.summary), cfg);
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
