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
import { classifyUsageLimitEvent } from "../goal/usage-limit-classifier.js";
import {
  describeUsageLimitEvent,
  formatResetSummary,
  type UsageLimitEvent,
} from "../goal/usage-limit-message.js";
import { redactSecretValues } from "../security/secret-paths.js";
import { renderTelegramHtmlText } from "./format.js";
import { boldLabel, formatStatusMessage } from "./status-format.js";
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
const CODEX_LIMIT_TIMEOUT_MS = 15_000;
const EXTERNAL_CLI_MAX_BUFFER = 4 * 1024 * 1024;
const CLAUDE_REFRESH_OUTPUT_MAX_BYTES = 128 * 1024;

const USAGE_STATUS_TITLE = "SmithersBot usage status";

export const USAGE_STATUS_COMMAND_SPEC = {
  command: USAGE_STATUS_COMMAND,
  description: "Show Claude Code and Codex usage quota",
} as const;

type SpawnSyncLike = typeof childProcess.spawnSync;
type SpawnLike = typeof childProcess.spawn;

export type StatuslineCacheEntry = { raw: string; mtimeMs: number };
export type StatuslineCacheReader = (cachePath: string) => StatuslineCacheEntry | undefined;
export type ClaudeStatuslineRefreshResult =
  | { status: "refreshed" }
  | { status: "rate_limited_with_reset"; event: UsageLimitEvent; reason: string }
  | { status: "timeout"; reason: string }
  | { status: "unavailable"; reason: string }
  | { status: "auth_missing"; reason: string }
  | { status: "binary_missing"; reason: string }
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

type UsageWindow = { usedPercentage?: number; resetsAt?: string; windowDurationMins?: number };
type ClaudeQuota = { fiveHour: UsageWindow; sevenDay: UsageWindow };
type CodexQuota = {
  primary?: UsageWindow;
  secondary?: UsageWindow;
  credits?: { hasCredits?: boolean; balance?: number };
  planType?: string;
  rateLimitReachedType?: string;
};
type CliOutcome = { ok: true; stdout: string } | { ok: false; reason: string };
type CachedValue<T> = { value: T; cachedAtMs: number };

let codexQuotaCache: CachedValue<CodexQuota> | undefined;

export function clearUsageStatusCachesForTest(): void {
  codexQuotaCache = undefined;
}

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
  const usedPercentage = pickNumber(obj, [
    "used_percentage",
    "used_percent",
    "usedPercentage",
    "usedPercent",
  ]);
  const resetsAt = pickString(obj, ["resets_at", "reset_at", "resetsAt", "reset"]);
  const windowDurationMins = pickNumber(obj, [
    "windowDurationMins",
    "window_duration_mins",
    "windowMinutes",
  ]);
  if (usedPercentage == null && resetsAt == null && windowDurationMins == null) return undefined;
  return {
    ...(usedPercentage != null ? { usedPercentage } : {}),
    ...(resetsAt != null ? { resetsAt } : {}),
    ...(windowDurationMins != null ? { windowDurationMins } : {}),
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

function readCompleteClaudeStatusline(
  entry: StatuslineCacheEntry | undefined,
): { entry: StatuslineCacheEntry; quota: ClaudeQuota } | undefined {
  const quota = entry ? parseClaudeStatusline(entry.raw) : undefined;
  if (!entry || !isCompleteClaudeQuota(quota)) return undefined;
  return { entry, quota };
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

function appendBoundedOutput(current: string, chunk: unknown): string {
  const next = current + String(chunk);
  if (next.length <= CLAUDE_REFRESH_OUTPUT_MAX_BYTES) return next;
  return next.slice(next.length - CLAUDE_REFRESH_OUTPUT_MAX_BYTES);
}

const BINARY_MISSING_TEXT_RE =
  /\b(?:enoent|command not found|not recognized as (?:an internal|a) command|executable file not found|no such file or directory)\b/i;
const AUTH_MISSING_TEXT_RE =
  /\b(?:not logged in|login required|please log in|authentication required|auth(?:entication)? missing|missing (?:api )?key|invalid (?:api )?key|unauthorized|forbidden)\b/i;

function classifyClaudeRefreshFailure(params: {
  outputText: string;
  fallbackStatus: "timeout" | "failed" | "unavailable";
  fallbackReason: string;
}): ClaudeStatuslineRefreshResult {
  const event = classifyUsageLimitEvent({ backend: "claude_code", text: params.outputText });
  if (event) {
    return {
      status: "rate_limited_with_reset",
      event,
      reason: event.kind === "rate_limit" ? "rate limited" : "usage limited",
    };
  }
  if (BINARY_MISSING_TEXT_RE.test(params.outputText)) {
    return { status: "binary_missing", reason: "Claude Code command not found" };
  }
  if (AUTH_MISSING_TEXT_RE.test(params.outputText)) {
    return { status: "auth_missing", reason: "Claude Code authentication is missing" };
  }
  return { status: params.fallbackStatus, reason: params.fallbackReason };
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
  let stdout = "";
  let stderr = "";
  let exitCode: number | null | undefined;
  let exitSignal: NodeJS.Signals | null | undefined;
  try {
    proc = spawnImpl(command, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
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
  proc.once?.("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    exitCode = code;
    exitSignal = signal;
  });
  proc.once?.("close", (code: number | null, signal: NodeJS.Signals | null) => {
    exitCode = code;
    exitSignal = signal;
  });
  proc.stdout?.on?.("data", (chunk: unknown) => {
    stdout = appendBoundedOutput(stdout, chunk);
  });
  proc.stderr?.on?.("data", (chunk: unknown) => {
    stderr = appendBoundedOutput(stderr, chunk);
  });

  try {
    while (nowMs <= deadline) {
      const current = params.readCache(params.cachePath);
      if (current && current.mtimeMs > beforeMtimeMs && hasCompleteClaudeStatusline(current)) {
        return { status: "refreshed" };
      }
      if (spawnFailed) {
        return classifyClaudeRefreshFailure({
          outputText: [stdout, stderr, spawnFailed].filter(Boolean).join("\n"),
          fallbackStatus: "unavailable",
          fallbackReason: "pseudo-TTY refresh unavailable",
        });
      }
      if (exitCode != null || exitSignal != null) {
        return classifyClaudeRefreshFailure({
          outputText: [stdout, stderr].filter(Boolean).join("\n"),
          fallbackStatus: "failed",
          fallbackReason: "refresh failed",
        });
      }
      sleep(pollMs);
      nowMs += pollMs;
    }
    return classifyClaudeRefreshFailure({
      outputText: [stdout, stderr].filter(Boolean).join("\n"),
      fallbackStatus: "timeout",
      fallbackReason: "refresh timed out",
    });
  } finally {
    terminateProcessGroup(proc);
  }
}

function parseCredits(value: unknown): CodexQuota["credits"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  const hasCredits = typeof obj.hasCredits === "boolean" ? obj.hasCredits : undefined;
  const balance = pickNumber(obj, ["balance", "creditBalance"]);
  if (hasCredits == null && balance == null) return undefined;
  return { ...(hasCredits != null ? { hasCredits } : {}), ...(balance != null ? { balance } : {}) };
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
  const primary = firstWindow(container, ["primary", "burst", "five_hour", "fiveHour"]);
  const secondary = firstWindow(container, ["secondary", "weekly", "seven_day", "sevenDay"]);
  const credits = parseCredits(root.credits);
  const planType = pickString(root, ["planType", "plan_type"]);
  const rateLimitReachedType = pickString(root, [
    "rateLimitReachedType",
    "rate_limit_reached_type",
  ]);
  if (!primary && !secondary && !credits && !planType && !rateLimitReachedType) return undefined;
  return {
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(credits ? { credits } : {}),
    ...(planType ? { planType } : {}),
    ...(rateLimitReachedType ? { rateLimitReachedType } : {}),
  };
}

function runCli(
  spawnSyncImpl: SpawnSyncLike,
  command: string,
  args: string[],
  timeoutMs: number,
): CliOutcome {
  let result: ReturnType<SpawnSyncLike>;
  try {
    result = spawnSyncImpl(command, args, {
      encoding: "utf8",
      timeout: timeoutMs,
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
    return boldLabel(label, "not reported");
  }
  const resetAt = formatResetAt(window.resetsAt);
  const reset = resetAt ? `, resets ${resetAt}` : "";
  const duration =
    window.windowDurationMins != null
      ? ` (${formatWindowDuration(window.windowDurationMins)})`
      : "";
  return boldLabel(`${label}${duration}`, `${formatPercent(window.usedPercentage)} used${reset}`);
}

function formatWindowDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return `${minutes}m`;
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
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
): string[] {
  const refreshFailureReason =
    refreshResult && refreshResult.status !== "refreshed" ? refreshResult.reason : undefined;
  const complete = readCompleteClaudeStatusline(entry);
  const quotaLines =
    complete != null
      ? [
          formatWindowLine("5-hour", complete.quota.fiveHour),
          formatWindowLine("7-day", complete.quota.sevenDay),
          boldLabel(
            "Updated",
            `${formatUpdatedAt(complete.entry.mtimeMs)} (${formatAge(nowMs - complete.entry.mtimeMs)} ago)`,
          ),
        ]
      : [];

  if (refreshResult?.status === "rate_limited_with_reset") {
    const lines = [
      boldLabel("Claude Code", "rate limited"),
      boldLabel("Note", `${describeUsageLimitEvent(refreshResult.event)}.`),
    ];
    const resetSummary = formatResetSummary([refreshResult.event]);
    if (resetSummary) lines.push(boldLabel("Reset", resetSummary.replace(/\.$/, "")));
    if (complete) {
      lines.push(boldLabel("Last known quota", "stale values shown; refresh is usage-limited."));
      lines.push(...quotaLines);
    } else {
      lines.push(boldLabel("Last known quota", "not available."));
    }
    return lines;
  }

  if (refreshResult?.status === "auth_missing") {
    return [
      boldLabel("Claude Code", "auth missing"),
      boldLabel("Note", `${refreshResult.reason}.`),
      ...quotaLines,
    ];
  }

  if (refreshResult?.status === "binary_missing") {
    return [
      boldLabel("Claude Code", "binary missing"),
      boldLabel("Note", `${refreshResult.reason}.`),
      ...quotaLines,
    ];
  }

  if (!complete) {
    const reason = refreshFailureReason ? ` (${refreshFailureReason})` : "";
    const cacheNote = entry
      ? `Live quota cache is present but unreadable${reason}.`
      : `No live quota cache found${reason}.`;
    return [boldLabel("Claude Code", "unavailable"), boldLabel("Note", cacheNote)];
  }
  const ageMs = nowMs - complete.entry.mtimeMs;
  const freshness =
    refreshResult?.status === "refreshed" || ageMs <= STALE_THRESHOLD_MS
      ? "current"
      : ageMs > STALE_THRESHOLD_MS
        ? "stale"
        : "current";
  const lines = [boldLabel("Claude Code", freshness), ...quotaLines];
  if (freshness === "stale") {
    const reason = refreshFailureReason
      ? ` Refresh failed: ${refreshFailureReason}.`
      : " Refresh failed: unknown.";
    lines.push(boldLabel("Note", `stale values shown; Claude Code may not be running.${reason}`));
  }
  return lines;
}

function formatCacheAge(cachedAtMs: number, nowMs: number): string {
  return `cached ${formatUpdatedAt(cachedAtMs)} (${formatAge(nowMs - cachedAtMs)} ago)`;
}

function buildCodexLines(quota: CodexQuota): string[] {
  const lines = [
    formatWindowLine("Primary", quota.primary),
    formatWindowLine("Secondary", quota.secondary),
  ];
  if (quota.rateLimitReachedType) {
    lines.push(boldLabel("Rate limit", quota.rateLimitReachedType));
  }
  if (quota.planType) lines.push(boldLabel("Plan", quota.planType));
  if (quota.credits) {
    const creditBits: string[] = [];
    if (quota.credits.hasCredits != null) {
      creditBits.push(quota.credits.hasCredits ? "available" : "none available");
    }
    if (quota.credits.balance != null) creditBits.push(`balance ${quota.credits.balance}`);
    if (creditBits.length > 0) lines.push(boldLabel("Credits", creditBits.join(", ")));
  } else {
    lines.push(boldLabel("Credits", "none available"));
  }
  return lines;
}

function buildCodexSection(outcome: CliOutcome, nowMs: number): string[] {
  if (!outcome.ok) {
    if (codexQuotaCache) {
      return [
        boldLabel(
          "Codex",
          `stale (${formatCacheAge(codexQuotaCache.cachedAtMs, nowMs)}; codex-limit ${
            outcome.reason
          })`,
        ),
        ...buildCodexLines(codexQuotaCache.value),
      ];
    }
    return [
      boldLabel("Codex", "unavailable"),
      boldLabel("Note", `Live quota unavailable (codex-limit ${outcome.reason}).`),
    ];
  }
  const quota = parseCodexLimit(outcome.stdout);
  if (!quota) {
    if (codexQuotaCache) {
      return [
        boldLabel(
          "Codex",
          `stale (${formatCacheAge(codexQuotaCache.cachedAtMs, nowMs)}; unrecognized codex-limit output)`,
        ),
        ...buildCodexLines(codexQuotaCache.value),
      ];
    }
    return [
      boldLabel("Codex", "unavailable"),
      boldLabel("Note", "Live quota unavailable (unrecognized codex-limit output)."),
    ];
  }
  codexQuotaCache = { value: quota, cachedAtMs: nowMs };
  return [boldLabel("Codex", "current"), ...buildCodexLines(quota)];
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
  let lastValidClaudeEntry = readCompleteClaudeStatusline(claudeEntry)?.entry;
  const cacheIsStale =
    !lastValidClaudeEntry || nowMs - lastValidClaudeEntry.mtimeMs > STALE_THRESHOLD_MS;
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
    const rereadEntry = readCache(cachePath);
    if (claudeRefreshResult.status === "refreshed") {
      lastValidClaudeEntry =
        readCompleteClaudeStatusline(rereadEntry)?.entry ?? lastValidClaudeEntry;
    }
    claudeEntry = lastValidClaudeEntry ?? rereadEntry;
  }
  const claudeLines = buildClaudeSection(
    lastValidClaudeEntry ?? claudeEntry,
    nowMs,
    claudeRefreshResult,
  );
  // -y keeps npx non-interactive so it never blocks waiting on an install prompt.
  const codexLines = buildCodexSection(
    runCli(spawnSyncImpl, "npx", ["-y", "codex-limit", "--json"], CODEX_LIMIT_TIMEOUT_MS),
    nowMs,
  );
  const text = formatStatusMessage({
    title: USAGE_STATUS_TITLE,
    lines: [...claudeLines, "", ...codexLines],
  });

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
  const htmlMessage = renderTelegramHtmlText(message);
  const options =
    messageThreadId != null
      ? ({ message_thread_id: messageThreadId, parse_mode: "HTML" } as const)
      : ({ parse_mode: "HTML" } as const);
  await bot.api.sendMessage(chatId, htmlMessage, options);
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
