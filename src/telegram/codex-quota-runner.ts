import * as childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CODEX_QUOTA_CACHE_REL = path.join("smithersbot", "codex-quota.json");
const CODEX_QUOTA_TIMEOUT_MS = 20_000;
const CODEX_QUOTA_MAX_BUFFER = 4 * 1024 * 1024;

export type UsageWindow = {
  usedPercentage?: number;
  resetsAt?: string;
  windowDurationMins?: number;
};

export type CodexQuota = {
  primary?: UsageWindow;
  secondary?: UsageWindow;
  credits?: { hasCredits?: boolean; balance?: number };
  planType?: string;
  rateLimitReachedType?: string;
};

export type CachedCodexQuota = {
  quota: CodexQuota;
  cachedAtMs: number;
};

export type CodexQuotaFailureReason =
  | "command not found"
  | "timed out"
  | "command failed"
  | "unavailable";

export type CodexQuotaProbeResult =
  | {
      ok: true;
      quota: CodexQuota;
      cachedAtMs: number;
      durationMs: number;
      cachePath: string;
    }
  | {
      ok: false;
      reason: CodexQuotaFailureReason;
      durationMs: number;
      cachePath: string;
      cachedQuota?: CachedCodexQuota;
    };

type SpawnSyncLike = typeof childProcess.spawnSync;

export type CodexQuotaRunnerOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  nowMs?: number;
  timeoutMs?: number;
  spawnSync?: SpawnSyncLike;
  cachePath?: string;
};

let inMemoryCache: CachedCodexQuota | undefined;

export function resetCodexQuotaRunnerForTest(): void {
  inMemoryCache = undefined;
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

function parseCredits(value: unknown): CodexQuota["credits"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  const hasCredits = typeof obj.hasCredits === "boolean" ? obj.hasCredits : undefined;
  const balance = pickNumber(obj, ["balance", "creditBalance"]);
  if (hasCredits == null && balance == null) return undefined;
  return { ...(hasCredits != null ? { hasCredits } : {}), ...(balance != null ? { balance } : {}) };
}

function sanitizeQuota(quota: CodexQuota): CodexQuota {
  return {
    ...(quota.primary ? { primary: { ...quota.primary } } : {}),
    ...(quota.secondary ? { secondary: { ...quota.secondary } } : {}),
    ...(quota.credits ? { credits: { ...quota.credits } } : {}),
    ...(quota.planType ? { planType: quota.planType } : {}),
    ...(quota.rateLimitReachedType ? { rateLimitReachedType: quota.rateLimitReachedType } : {}),
  };
}

function isValidQuota(quota: CodexQuota): boolean {
  return Boolean(
    quota.primary ||
    quota.secondary ||
    quota.credits ||
    quota.planType ||
    quota.rateLimitReachedType,
  );
}

export function parseCodexLimitJson(raw: string): CodexQuota | undefined {
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
  const quota = sanitizeQuota({
    ...(firstWindow(container, ["primary", "burst", "five_hour", "fiveHour"])
      ? { primary: firstWindow(container, ["primary", "burst", "five_hour", "fiveHour"]) }
      : {}),
    ...(firstWindow(container, ["secondary", "weekly", "seven_day", "sevenDay"])
      ? { secondary: firstWindow(container, ["secondary", "weekly", "seven_day", "sevenDay"]) }
      : {}),
    ...(parseCredits(root.credits) ? { credits: parseCredits(root.credits) } : {}),
    ...(pickString(root, ["planType", "plan_type"])
      ? { planType: pickString(root, ["planType", "plan_type"]) }
      : {}),
    ...(pickString(root, ["rateLimitReachedType", "rate_limit_reached_type"])
      ? {
          rateLimitReachedType: pickString(root, [
            "rateLimitReachedType",
            "rate_limit_reached_type",
          ]),
        }
      : {}),
  });
  return isValidQuota(quota) ? quota : undefined;
}

export function resolveCodexQuotaCachePath(
  homeDir: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = env.XDG_CACHE_HOME?.trim() || path.join(homeDir, ".cache");
  return path.join(base, CODEX_QUOTA_CACHE_REL);
}

function readFileCache(cachePath: string): CachedCodexQuota | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const root = parsed as Record<string, unknown>;
    const cachedAtMs = root.cachedAtMs;
    if (typeof cachedAtMs !== "number" || !Number.isFinite(cachedAtMs)) return undefined;
    const quotaRaw = root.quota;
    if (!quotaRaw || typeof quotaRaw !== "object") return undefined;
    const quota = sanitizeQuota(quotaRaw as CodexQuota);
    if (!isValidQuota(quota)) return undefined;
    return { quota, cachedAtMs };
  } catch {
    return undefined;
  }
}

export function readLastCodexQuotaCache(cachePath: string): CachedCodexQuota | undefined {
  const cached = inMemoryCache ?? readFileCache(cachePath);
  if (cached) inMemoryCache = cached;
  return cached;
}

export function writeLastCodexQuotaCache(
  cachePath: string,
  quota: CodexQuota,
  cachedAtMs: number,
): CachedCodexQuota | undefined {
  const sanitized = sanitizeQuota(quota);
  if (!isValidQuota(sanitized)) return undefined;
  const entry: CachedCodexQuota = { quota: sanitized, cachedAtMs };
  const dir = path.dirname(cachePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(cachePath)}.${process.pid}.${cachedAtMs}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, cachePath);
  inMemoryCache = entry;
  return entry;
}

export function buildCodexQuotaCommand(): { command: string; args: string[] } {
  // codex-limit is not pinned in package.json/pnpm-lock.yaml today, so the
  // runner uses npm exec with explicit non-interactive args instead of the old
  // hot-path npx -y invocation.
  return { command: "npm", args: ["exec", "--yes", "codex-limit", "--", "--json"] };
}

export function buildCodexQuotaEnv(
  params: {
    env?: NodeJS.ProcessEnv;
    cachePath?: string;
    homeDir?: string;
  } = {},
): NodeJS.ProcessEnv {
  const env = { ...(params.env ?? process.env) };
  // The gateway may run under systemd without the interactive shell/NVM PATH or
  // npm cache setup that made manual codex-limit runs succeed. Build those
  // assumptions explicitly while preserving HOME/CODEX_HOME for Codex auth
  // discovery; never read or copy auth files here.
  const nodeBinDir = path.dirname(process.execPath);
  const priorPath = env.PATH?.trim();
  env.PATH = priorPath ? `${nodeBinDir}${path.delimiter}${priorPath}` : nodeBinDir;
  if (!env.HOME && params.homeDir) env.HOME = params.homeDir;
  const cachePath = params.cachePath ?? resolveCodexQuotaCachePath(params.homeDir, env);
  env.npm_config_cache = path.join(path.dirname(cachePath), "npm");
  return env;
}

function classifyError(
  error: NodeJS.ErrnoException | undefined,
): CodexQuotaFailureReason | undefined {
  if (!error) return undefined;
  if (error.code === "ENOENT") return "command not found";
  // spawnSync only proves the parent invocation exceeded our bound. From this
  // layer we cannot distinguish npm package resolution, codex-limit startup,
  // Codex auth discovery, nested app-server work, or cache writes.
  if (error.code === "ETIMEDOUT") return "timed out";
  return "unavailable";
}

export function refreshCodexQuota(options: CodexQuotaRunnerOptions = {}): CodexQuotaProbeResult {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const nowMs = options.nowMs ?? Date.now();
  const timeoutMs = options.timeoutMs ?? CODEX_QUOTA_TIMEOUT_MS;
  const spawnSyncImpl = options.spawnSync ?? childProcess.spawnSync;
  const cachePath = options.cachePath ?? resolveCodexQuotaCachePath(homeDir, env);
  const cachedQuota = readLastCodexQuotaCache(cachePath);
  const startedAt = Date.now();
  const { command, args } = buildCodexQuotaCommand();

  let result: ReturnType<SpawnSyncLike>;
  try {
    result = spawnSyncImpl(command, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: CODEX_QUOTA_MAX_BUFFER,
      env: buildCodexQuotaEnv({ env, homeDir, cachePath }),
    });
  } catch {
    return {
      ok: false,
      reason: "unavailable",
      durationMs: Date.now() - startedAt,
      cachePath,
      ...(cachedQuota ? { cachedQuota } : {}),
    };
  }

  const durationMs = Date.now() - startedAt;
  const errorReason = classifyError(result.error as NodeJS.ErrnoException | undefined);
  if (errorReason) {
    return {
      ok: false,
      reason: errorReason,
      durationMs,
      cachePath,
      ...(cachedQuota ? { cachedQuota } : {}),
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      reason: "command failed",
      durationMs,
      cachePath,
      ...(cachedQuota ? { cachedQuota } : {}),
    };
  }

  const quota = parseCodexLimitJson(typeof result.stdout === "string" ? result.stdout : "");
  if (!quota) {
    return {
      ok: false,
      reason: "unavailable",
      durationMs,
      cachePath,
      ...(cachedQuota ? { cachedQuota } : {}),
    };
  }

  const written = writeLastCodexQuotaCache(cachePath, quota, nowMs);
  return {
    ok: true,
    quota: written?.quota ?? quota,
    cachedAtMs: written?.cachedAtMs ?? nowMs,
    durationMs,
    cachePath,
  };
}
