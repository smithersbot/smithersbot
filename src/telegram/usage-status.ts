import * as childProcess from "node:child_process";
import type { ChildProcess } from "node:child_process";
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
const CLAUDE_REFRESH_TIMEOUT_MS = 20_000;
const CLAUDE_REFRESH_POLL_MS = 250;
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
type SpawnLike = typeof childProcess.spawn;

export type StatuslineCacheEntry = { raw: string; mtimeMs: number };
export type StatuslineCacheReader = (cachePath: string) => StatuslineCacheEntry | undefined;
export type ClaudeStatuslineRefreshResult =
  | { status: "refreshed" }
  | { status: "timeout"; reason: string }
  | { status: "unavailable"; reason: string }
  | { status: "failed"; reason: string };

export type ClaudeStatuslineRefreshParams = {
  cachePath: string;
  beforeMtimeMs?: number;
  env: NodeJS.ProcessEnv;
  nowMs: number;
  readCache: StatuslineCacheReader;
};

export type ClaudeStatuslineRefresher = (
  params: ClaudeStatuslineRefreshParams,
) => ClaudeStatuslineRefreshResult;

export type BuildUsageStatusOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  nowMs?: number;
  spawnSync?: SpawnSyncLike;
  spawn?: SpawnLike;
  readCache?: StatuslineCacheReader;
  cachePath?: string;
  refreshClaudeStatusline?: ClaudeStatuslineRefresher | false;
  sleepMs?: (ms: number) => void;
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
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
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

function isCompleteClaudeQuota(quota: ClaudeQuota | undefined): quota is ClaudeQuota {
  return Boolean(
    quota?.fiveHour.usedPercentage != null &&
    quota.fiveHour.resetsAt &&
    quota.sevenDay.usedPercentage != null &&
    quota.sevenDay.resetsAt,
  );
}

function hasCompleteClaudeStatusline(entry: StatuslineCacheEntry | undefined): boolean {
  return isCompleteClaudeQuota(entry ? parseClaudeStatusline(entry.raw) : undefined);
}

export function buildClaudeStatuslineRefreshCommand(): { command: string; args: string[] } {
  return {
    command: "script",
    args: ["-q", "-e", "-c", 'claude "respond with only a period"', "/dev/null"],
  };
}

function buildClaudeRefreshEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.ANTHROPIC_API_KEY;
  delete next.ANTHROPIC_AUTH_TOKEN;
  delete next.ANTHROPIC_BASE_URL;
  delete next.ANTHROPIC_API_KEY_OLD;
  return next;
}

function defaultSleepMs(ms: number): void {
  const shared = new SharedArrayBuffer(4);
  const view = new Int32Array(shared);
  Atomics.wait(view, 0, 0, ms);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function terminateProcessGroup(proc: ChildProcess): void {
  if (!proc.pid) return;
  const target = -proc.pid;
  try {
    process.kill(target, "SIGTERM");
  } catch {
    try {
      proc.kill("SIGTERM");
    } catch {
      // Best effort cleanup.
    }
  }
  if (isProcessAlive(proc.pid)) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Best effort cleanup.
      }
    }
  }
}

export function refreshClaudeStatuslineCache(
  params: ClaudeStatuslineRefreshParams & {
    spawn?: SpawnLike;
    sleepMs?: (ms: number) => void;
    timeoutMs?: number;
    pollMs?: number;
  },
): ClaudeStatuslineRefreshResult {
  const spawnImpl = params.spawn ?? childProcess.spawn;
  const sleep = params.sleepMs ?? defaultSleepMs;
  const timeoutMs = params.timeoutMs ?? CLAUDE_REFRESH_TIMEOUT_MS;
  const pollMs = params.pollMs ?? CLAUDE_REFRESH_POLL_MS;
  const { command, args } = buildClaudeStatuslineRefreshCommand();
  let proc: ChildProcess;
  try {
    proc = spawnImpl(command, args, {
      detached: true,
      stdio: "ignore",
      env: buildClaudeRefreshEnv(params.env),
    });
    proc.unref?.();
  } catch {
    return { status: "unavailable", reason: "pseudo-TTY refresh unavailable" };
  }

  const beforeMtimeMs = params.beforeMtimeMs ?? 0;
  const deadline = params.nowMs + timeoutMs;
  let nowMs = params.nowMs;
  let spawnFailed: string | undefined;
  proc.once?.("error", (err: Error) => {
    spawnFailed = err.message || "spawn failed";
  });

  try {
    while (nowMs <= deadline) {
      const current = params.readCache(params.cachePath);
      if (current && current.mtimeMs > beforeMtimeMs && hasCompleteClaudeStatusline(current)) {
        return { status: "refreshed" };
      }
      if (spawnFailed) return { status: "unavailable", reason: "pseudo-TTY refresh unavailable" };
      sleep(pollMs);
      nowMs += pollMs;
    }
    return { status: "timeout", reason: "refresh timed out" };
  } finally {
    terminateProcessGroup(proc);
  }
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

function formatResetAt(resetsAt: string | undefined): string | undefined {
  if (!resetsAt) return undefined;
  if (/^\d+(\.\d+)?$/.test(resetsAt)) {
    const epochSeconds = Number(resetsAt);
    if (Number.isFinite(epochSeconds)) return new Date(epochSeconds * 1000).toISOString();
  }
  return resetsAt;
}

function formatWindowLine(label: string, window: UsageWindow | undefined): string {
  if (!window || (window.usedPercentage == null && window.resetsAt == null)) {
    return `  ${label}: not reported`;
  }
  const resetAt = formatResetAt(window.resetsAt);
  const reset = resetAt ? `, resets ${resetAt}` : "";
  return `  ${label}: ${formatPercent(window.usedPercentage)} used${reset}`;
}

function formatAge(ageMs: number): string {
  if (ageMs < 0) return "0s";
  const seconds = Math.round(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function formatUpdatedAt(mtimeMs: number): string {
  return new Date(mtimeMs).toISOString();
}

function buildClaudeSection(
  entry: StatuslineCacheEntry | undefined,
  nowMs: number,
  refreshResult?: ClaudeStatuslineRefreshResult,
): string {
  const header = "Claude Code — live subscription quota";
  const refreshFailureReason =
    refreshResult && refreshResult.status !== "refreshed" ? refreshResult.reason : undefined;
  if (!entry) {
    const reason = refreshFailureReason ? ` (${refreshFailureReason})` : "";
    return [
      header,
      `  Status: unavailable${reason}.`,
      "  No live quota cache found. It only updates while Claude Code is running.",
    ].join("\n");
  }
  const quota = parseClaudeStatusline(entry.raw);
  if (!quota) {
    const reason = refreshFailureReason ? ` (${refreshFailureReason})` : "";
    return [
      header,
      `  Status: unavailable${reason}.`,
      "  Live quota cache is present but unreadable. It only updates while Claude Code is running.",
    ].join("\n");
  }
  const ageMs = nowMs - entry.mtimeMs;
  const freshness =
    refreshResult?.status === "refreshed"
      ? "refreshed/current"
      : ageMs > STALE_THRESHOLD_MS
        ? "stale"
        : "current";
  const lines = [
    header,
    `  Status: ${freshness}. Updated ${formatUpdatedAt(entry.mtimeMs)} (${formatAge(ageMs)} ago).`,
    formatWindowLine("5-hour", quota.fiveHour),
    formatWindowLine("7-day", quota.sevenDay),
  ];
  if (freshness === "stale") {
    const reason = refreshFailureReason ? ` Refresh failed: ${refreshFailureReason}.` : "";
    lines.push(`  Note: stale values shown; Claude Code may not be running.${reason}`);
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

  let claudeEntry = readCache(cachePath);
  const cacheIsStale = !claudeEntry || nowMs - claudeEntry.mtimeMs > STALE_THRESHOLD_MS;
  let claudeRefreshResult: ClaudeStatuslineRefreshResult | undefined;
  if (cacheIsStale && options.refreshClaudeStatusline !== false) {
    const refresher =
      options.refreshClaudeStatusline ??
      ((params: ClaudeStatuslineRefreshParams) =>
        refreshClaudeStatuslineCache({
          ...params,
          spawn: options.spawn ?? childProcess.spawn,
          sleepMs: options.sleepMs,
        }));
    claudeRefreshResult = refresher({
      cachePath,
      beforeMtimeMs: claudeEntry?.mtimeMs,
      env,
      nowMs,
      readCache,
    });
    claudeEntry = readCache(cachePath);
  }
  const claudeSection = buildClaudeSection(claudeEntry, nowMs, claudeRefreshResult);
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
