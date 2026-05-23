import * as childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Bot, Context } from "grammy";

import type { MoltbotConfig } from "../config/config.js";
import type {
  TelegramAccountConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "../config/types.js";
import type { ChannelGroupPolicy } from "../config/group-policy.js";
import { redactSecretValues } from "../security/secret-paths.js";
import { resolveTelegramCommandAuth } from "./telegram-auth.js";

const USAGE_STATUS_COMMAND = "usage_status";

// Claude Code's statusLine command (scripts/claude-statusline.mjs) writes the
// live rate-limit JSON Claude pipes to it here. The cache only refreshes while
// Claude Code is running, so a missing or old file is expected and not an error.
const CLAUDE_STATUSLINE_CACHE_REL = path.join("claude-code", "statusline.json");
// After this long without a refresh we treat the cache as stale, since the
// numbers no longer reflect current quota.
const STALE_THRESHOLD_MS = 15 * 60 * 1000;
// External usage CLIs are invoked synchronously; cap each to keep the command
// responsive even when offline or when npx must resolve a package.
const EXTERNAL_CLI_TIMEOUT_MS = 8000;
const EXTERNAL_CLI_MAX_BUFFER = 4 * 1024 * 1024;

const USAGE_STATUS_TITLE = "SmithersBot usage status";

export const USAGE_STATUS_COMMAND_SPEC = {
  command: USAGE_STATUS_COMMAND,
  description: "Show Claude Code and Codex usage quota and historical usage",
} as const;

type SpawnSyncLike = typeof childProcess.spawnSync;

export type StatuslineCacheEntry = { raw: string; mtimeMs: number };
export type StatuslineCacheReader = (cachePath: string) => StatuslineCacheEntry | undefined;

export type BuildUsageStatusOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  nowMs?: number;
  spawnSync?: SpawnSyncLike;
  readCache?: StatuslineCacheReader;
  cachePath?: string;
};

type UsageWindow = { usedPercentage?: number; resetsAt?: string };
type ClaudeQuota = { fiveHour: UsageWindow; sevenDay: UsageWindow };
type CodexQuota = { burst?: UsageWindow; weekly?: UsageWindow };
type HistoricalSummary = { days: number; totalCost?: number; totalTokens?: number };

type CliOutcome = { ok: true; stdout: string } | { ok: false; reason: string };

export function resolveClaudeStatuslineCachePath(
  homeDir: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = env.XDG_CACHE_HOME?.trim() || path.join(homeDir, ".cache");
  return path.join(base, CLAUDE_STATUSLINE_CACHE_REL);
}

function defaultReadCache(cachePath: string): StatuslineCacheEntry | undefined {
  try {
    const stat = fs.statSync(cachePath);
    const raw = fs.readFileSync(cachePath, "utf8");
    return { raw, mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  }
}

function pickNumber(obj: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
}

function pickString(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function pickWindow(value: unknown): UsageWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  const usedPercentage = pickNumber(obj, ["used_percentage", "used_percent", "usedPercentage"]);
  const resetsAt = pickString(obj, ["resets_at", "reset_at", "resetsAt", "reset"]);
  if (usedPercentage == null && resetsAt == null) return undefined;
  return {
    ...(usedPercentage != null ? { usedPercentage } : {}),
    ...(resetsAt != null ? { resetsAt } : {}),
  };
}

function firstWindow(
  container: Record<string, unknown>,
  keys: readonly string[],
): UsageWindow | undefined {
  for (const key of keys) {
    if (key in container) {
      const found = pickWindow(container[key]);
      if (found) return found;
    }
  }
  return undefined;
}

function parseClaudeStatusline(raw: string): ClaudeQuota | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const limits = (parsed as Record<string, unknown>).rate_limits;
  if (!limits || typeof limits !== "object") return undefined;
  const container = limits as Record<string, unknown>;
  const fiveHour = firstWindow(container, ["five_hour", "fiveHour"]);
  const sevenDay = firstWindow(container, ["seven_day", "sevenDay"]);
  if (!fiveHour && !sevenDay) return undefined;
  return { fiveHour: fiveHour ?? {}, sevenDay: sevenDay ?? {} };
}

function parseCodexLimit(raw: string): CodexQuota | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const root = parsed as Record<string, unknown>;
  const nested = root.rate_limits;
  const container =
    nested && typeof nested === "object" ? (nested as Record<string, unknown>) : root;
  const burst = firstWindow(container, ["burst", "five_hour", "fiveHour", "primary"]);
  const weekly = firstWindow(container, ["weekly", "seven_day", "sevenDay", "secondary"]);
  if (!burst && !weekly) return undefined;
  return { ...(burst ? { burst } : {}), ...(weekly ? { weekly } : {}) };
}

function parseCcusageDaily(raw: string): HistoricalSummary | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const root = parsed as Record<string, unknown>;
  const daily = Array.isArray(root.daily) ? root.daily : [];
  const totals =
    root.totals && typeof root.totals === "object" ? (root.totals as Record<string, unknown>) : {};
  const totalCost = pickNumber(totals, ["totalCost", "total_cost", "cost"]);
  const totalTokens = pickNumber(totals, ["totalTokens", "total_tokens", "tokens"]);
  return {
    days: daily.length,
    ...(totalCost != null ? { totalCost } : {}),
    ...(totalTokens != null ? { totalTokens } : {}),
  };
}

function runCli(spawnSyncImpl: SpawnSyncLike, command: string, args: string[]): CliOutcome {
  let result: ReturnType<SpawnSyncLike>;
  try {
    result = spawnSyncImpl(command, args, {
      encoding: "utf8",
      timeout: EXTERNAL_CLI_TIMEOUT_MS,
      maxBuffer: EXTERNAL_CLI_MAX_BUFFER,
    });
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  const error = result.error as NodeJS.ErrnoException | undefined;
  if (error) {
    if (error.code === "ENOENT") return { ok: false, reason: "command not found" };
    if (error.code === "ETIMEDOUT") return { ok: false, reason: "timed out" };
    return { ok: false, reason: "unavailable" };
  }
  if (result.status !== 0) return { ok: false, reason: "command failed" };
  return { ok: true, stdout: typeof result.stdout === "string" ? result.stdout : "" };
}

function formatPercent(value: number | undefined): string {
  return value == null ? "?" : `${Math.round(value)}%`;
}

function formatWindowLine(label: string, window: UsageWindow | undefined): string {
  if (!window || (window.usedPercentage == null && window.resetsAt == null)) {
    return `  ${label}: not reported`;
  }
  const reset = window.resetsAt ? `, resets ${window.resetsAt}` : "";
  return `  ${label}: ${formatPercent(window.usedPercentage)} used${reset}`;
}

function buildClaudeSection(entry: StatuslineCacheEntry | undefined, nowMs: number): string {
  const header = "Claude Code — live subscription quota";
  if (!entry) {
    return [
      header,
      "  No live quota cache found. It only updates while Claude Code is running.",
    ].join("\n");
  }
  const quota = parseClaudeStatusline(entry.raw);
  if (!quota) {
    return [
      header,
      "  Live quota cache is present but unreadable. It only updates while Claude Code is running.",
    ].join("\n");
  }
  const lines = [
    header,
    formatWindowLine("5-hour", quota.fiveHour),
    formatWindowLine("7-day", quota.sevenDay),
  ];
  const ageMs = nowMs - entry.mtimeMs;
  if (ageMs > STALE_THRESHOLD_MS) {
    lines.push(
      "  Note: this cache is stale (Claude Code may not be running); values may be outdated.",
    );
  } else {
    lines.push("  Note: this cache only updates while Claude Code is running.");
  }
  return lines.join("\n");
}

function buildCodexSection(outcome: CliOutcome): string {
  const header = "Codex — live subscription quota";
  if (!outcome.ok) {
    return [header, `  Live quota unavailable (codex-limit ${outcome.reason}).`].join("\n");
  }
  const quota = parseCodexLimit(outcome.stdout);
  if (!quota) {
    return [header, "  Live quota unavailable (unrecognized codex-limit output)."].join("\n");
  }
  return [
    header,
    formatWindowLine("Burst", quota.burst),
    formatWindowLine("Weekly", quota.weekly),
  ].join("\n");
}

function formatHistoricalLine(label: string, outcome: CliOutcome): string {
  if (!outcome.ok) {
    return `  ${label}: unavailable (${outcome.reason}).`;
  }
  const summary = parseCcusageDaily(outcome.stdout);
  if (!summary) {
    return `  ${label}: unavailable (unrecognized ccusage output).`;
  }
  const parts = [`${summary.days} day(s)`];
  if (summary.totalTokens != null)
    parts.push(`${summary.totalTokens.toLocaleString("en-US")} tokens`);
  if (summary.totalCost != null) parts.push(`$${summary.totalCost.toFixed(2)}`);
  return `  ${label}: ${parts.join(", ")}`;
}

function collectTokenLikeEnvValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([key, value]) => /TOKEN|SECRET|KEY|PASSWORD/i.test(key) && typeof value === "string")
    .map(([, value]) => value)
    .filter((value): value is string => Boolean(value && value.trim().length >= 8));
}

export function buildUsageStatusMessage(options: BuildUsageStatusOptions = {}): string {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const nowMs = options.nowMs ?? Date.now();
  const spawnSyncImpl = options.spawnSync ?? childProcess.spawnSync;
  const readCache = options.readCache ?? defaultReadCache;
  const cachePath = options.cachePath ?? resolveClaudeStatuslineCachePath(homeDir, env);

  const claudeSection = buildClaudeSection(readCache(cachePath), nowMs);
  // -y keeps npx non-interactive so it never blocks waiting on an install prompt.
  const codexSection = buildCodexSection(
    runCli(spawnSyncImpl, "npx", ["-y", "codex-limit", "--json"]),
  );
  const historicalSection = [
    "Historical usage — local logs, not remaining quota",
    formatHistoricalLine(
      "Claude Code",
      runCli(spawnSyncImpl, "npx", ["-y", "ccusage@latest", "claude", "daily", "--json"]),
    ),
    formatHistoricalLine(
      "Codex",
      runCli(spawnSyncImpl, "npx", ["-y", "ccusage@latest", "codex", "daily", "--json"]),
    ),
  ].join("\n");

  const text = [
    USAGE_STATUS_TITLE,
    "",
    claudeSection,
    "",
    codexSection,
    "",
    historicalSection,
  ].join("\n");

  // Defense in depth: the message is built from parsed numeric/time fields only,
  // never raw payloads, but redact any token-like values just in case.
  return redactSecretValues(text, {
    includeConfigSecrets: false,
    secretValues: collectTokenLikeEnvValues(env),
  });
}

type TelegramUsageStatusContext = Context & {
  message?: {
    chat: { id: number; type: string };
    from?: { id?: number };
    message_thread_id?: number;
  };
};

type RegisterUsageStatusCommandParams = {
  bot: Bot;
  cfg: MoltbotConfig;
  telegramCfg: TelegramAccountConfig;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  useAccessGroups: boolean;
  resolveGroupPolicy: (chatId: string | number) => ChannelGroupPolicy;
  resolveTelegramGroupConfig: (
    chatId: string | number,
    messageThreadId?: number,
  ) => { groupConfig?: TelegramGroupConfig; topicConfig?: TelegramTopicConfig };
  shouldSkipUpdate: (ctx: unknown) => boolean;
  buildMessage?: () => string;
};

async function sendUsageStatusMessage(
  bot: Bot,
  chatId: number,
  message: string,
  messageThreadId?: number,
): Promise<void> {
  const options = messageThreadId != null ? { message_thread_id: messageThreadId } : undefined;
  if (options) await bot.api.sendMessage(chatId, message, options);
  else await bot.api.sendMessage(chatId, message);
}

export function registerUsageStatusCommand({
  bot,
  cfg,
  telegramCfg,
  allowFrom,
  groupAllowFrom,
  useAccessGroups,
  resolveGroupPolicy,
  resolveTelegramGroupConfig,
  shouldSkipUpdate,
  buildMessage,
}: RegisterUsageStatusCommandParams): void {
  const build = buildMessage ?? (() => buildUsageStatusMessage());
  bot.command(USAGE_STATUS_COMMAND, async (ctx: TelegramUsageStatusContext) => {
    const msg = ctx.message;
    if (!msg) return;
    if (shouldSkipUpdate(ctx)) return;

    const auth = await resolveTelegramCommandAuth({
      msg,
      bot,
      cfg,
      telegramCfg,
      allowFrom,
      groupAllowFrom,
      useAccessGroups,
      resolveGroupPolicy,
      resolveTelegramGroupConfig,
      requireAuth: true,
    });
    if (!auth) return;

    await sendUsageStatusMessage(
      bot,
      msg.chat.id,
      build(),
      auth.isGroup ? auth.resolvedThreadId : msg.message_thread_id,
    );
  });
}
