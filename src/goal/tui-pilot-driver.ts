// Operational controls for the installed tui-pilot driver leg (S2 productionization).
//
// The direct `claude -p` path is intentionally untouched by everything here: this
// module only gates prompt runs that the ClaudeDriver seam (cli-process.ts) routes
// through `tui-pilot print`. tui-pilot drives a heavier tmux session per run, so the
// seam funnels those runs through this module for:
//   * fail-closed preflight (tui-pilot present + version pin, tmux, uv, claude, auth)
//   * a concurrency cap + bounded FIFO queue (session-cap handling, anti-starvation)
//   * queue/preflight failures surfaced as ordinary RunCliProcessResult failures
//   * latency + outcome observability sufficient for canary decisions
//
// Source of truth: docs/tui-pilot-parity/implementation-plan.md (S2) and
// implementation-detail.md ("Operational Controls").

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config/config.js";
import type { TuiPilotOpsConfig, TuiPilotPreflightMode } from "../config/types.goal.js";
import { getChildLogger } from "../logging/logger.js";
import type { RunCliProcessResult } from "./cli-process.js";

const log = getChildLogger({ mod: "tui-pilot-driver" });

export const TUI_PILOT_COMMAND = "tui-pilot";

/** Runtime defaults for any unset `goal.tuiPilot` field. */
export const TUI_PILOT_OPS_DEFAULTS = {
  preflight: "enforce" as TuiPilotPreflightMode,
  maxConcurrent: 3,
  maxQueued: 64,
  queueTimeoutMs: 600_000,
} as const;

const PREFLIGHT_TTL_MS = 60_000;
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const CLAUDE_SUBSCRIPTION_CREDENTIAL = path.join(".claude", ".credentials.json");

export type ResolvedTuiPilotOps = {
  version: string | null;
  preflight: TuiPilotPreflightMode;
  maxConcurrent: number;
  maxQueued: number;
  queueTimeoutMs: number;
};

/** Merge `goal.tuiPilot` config with the productionized defaults. */
export function resolveTuiPilotOps(override?: TuiPilotOpsConfig): ResolvedTuiPilotOps {
  const cfg = override ?? loadConfig().goal?.tuiPilot ?? {};
  const maxConcurrent =
    typeof cfg.maxConcurrent === "number" && cfg.maxConcurrent >= 1
      ? Math.floor(cfg.maxConcurrent)
      : TUI_PILOT_OPS_DEFAULTS.maxConcurrent;
  const maxQueued =
    typeof cfg.maxQueued === "number" && cfg.maxQueued >= 0
      ? Math.floor(cfg.maxQueued)
      : TUI_PILOT_OPS_DEFAULTS.maxQueued;
  const queueTimeoutMs =
    typeof cfg.queueTimeoutMs === "number" && cfg.queueTimeoutMs >= 0
      ? Math.floor(cfg.queueTimeoutMs)
      : TUI_PILOT_OPS_DEFAULTS.queueTimeoutMs;
  return {
    version: cfg.version?.trim() ? cfg.version.trim() : null,
    preflight: cfg.preflight ?? TUI_PILOT_OPS_DEFAULTS.preflight,
    maxConcurrent,
    maxQueued,
    queueTimeoutMs,
  };
}

// --- Binary resolution -------------------------------------------------------

function findExecutableOnPath(
  commandName: string,
  env: Record<string, string | undefined>,
): string | null {
  const pathValue = env.PATH ?? process.env.PATH ?? "";
  const pathEntries = pathValue.split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, commandName);
    try {
      if (!fs.existsSync(candidate)) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Resolve the tui-pilot executable, mirroring resolveClaudeBinary's local-vs-installed
 * intent: explicit config/env override, then the local dev checkout's venv, then PATH.
 * Returns the bare command name as a last resort so a missing binary surfaces at spawn
 * time (and is caught by preflight) rather than throwing here.
 */
export function resolveTuiPilotBinary(env: Record<string, string | undefined>): string {
  const configured = loadConfig().goal?.tuiPilotBinary?.trim();
  if (configured) return configured;
  const envConfigured = env.TUI_PILOT_BIN?.trim();
  if (envConfigured) return envConfigured;

  const localDevBinary = path.resolve(
    process.cwd(),
    "..",
    "tui-pilot",
    ".venv",
    "bin",
    TUI_PILOT_COMMAND,
  );
  try {
    fs.accessSync(localDevBinary, fs.constants.X_OK);
    return localDevBinary;
  } catch {
    // Fall through to PATH lookup.
  }

  return findExecutableOnPath(TUI_PILOT_COMMAND, env) ?? TUI_PILOT_COMMAND;
}

// --- Preflight ---------------------------------------------------------------

export type PreflightCheck = { name: string; ok: boolean; detail: string };
export type PreflightResult = {
  ok: boolean;
  reason: string;
  checks: PreflightCheck[];
  checkedAtMs: number;
};

let cachedPreflight: PreflightResult | null = null;

/** Clear the cached preflight result (tests + after an install/upgrade). */
export function resetTuiPilotPreflightCache(): void {
  cachedPreflight = null;
}

function probeVersion(bin: string): { ok: boolean; version: string | null; detail: string } {
  try {
    const out = execFileSync(bin, ["--version"], {
      timeout: VERSION_PROBE_TIMEOUT_MS,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const version = (out.match(/\d+\.\d+\.\d+(?:[-.\w]*)?/)?.[0] ?? out.trim()) || null;
    return { ok: true, version, detail: out.trim() || "<no version output>" };
  } catch (err) {
    return {
      ok: false,
      version: null,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Fail-closed preflight for the tui-pilot driver. Cached for PREFLIGHT_TTL_MS so the
 * per-run cost is negligible. Hard checks (all must pass): tui-pilot resolvable + the
 * version pin (when configured), tmux, uv, claude, and the subscription OAuth
 * credential store. Auth is checked file-based (credentials.json present + non-empty)
 * — a live auth probe is the shadow-parity gate's job, not every run's.
 */
export function ensureTuiPilotPreflight(opts?: {
  env?: Record<string, string | undefined>;
  ops?: ResolvedTuiPilotOps;
  force?: boolean;
  now?: number;
}): PreflightResult {
  const now = opts?.now ?? Date.now();
  if (!opts?.force && cachedPreflight && now - cachedPreflight.checkedAtMs < PREFLIGHT_TTL_MS) {
    return cachedPreflight;
  }
  const env = opts?.env ?? process.env;
  const ops = opts?.ops ?? resolveTuiPilotOps();
  const checks: PreflightCheck[] = [];

  const tuiPilotBin = resolveTuiPilotBinary(env);
  const versionProbe = probeVersion(tuiPilotBin);
  checks.push({
    name: "tui-pilot",
    ok: versionProbe.ok,
    detail: versionProbe.ok
      ? `${tuiPilotBin} (${versionProbe.version ?? "unknown version"})`
      : `cannot run ${tuiPilotBin} --version: ${versionProbe.detail}`,
  });
  if (versionProbe.ok && ops.version) {
    const matches = (versionProbe.version ?? "").includes(ops.version);
    checks.push({
      name: "tui-pilot-version-pin",
      ok: matches,
      detail: matches
        ? `matches pin ${ops.version}`
        : `installed ${versionProbe.version ?? "unknown"} != pinned ${ops.version}`,
    });
  }

  for (const tool of ["tmux", "uv", "claude"]) {
    const resolved = findExecutableOnPath(tool, env);
    checks.push({
      name: tool,
      ok: resolved !== null,
      detail: resolved ?? `not found on PATH`,
    });
  }

  const credsPath = path.join(os.homedir(), CLAUDE_SUBSCRIPTION_CREDENTIAL);
  let authOk = false;
  let authDetail = `${credsPath} missing`;
  try {
    const stat = fs.statSync(credsPath);
    authOk = stat.isFile() && stat.size > 0;
    authDetail = authOk ? `${credsPath} present` : `${credsPath} empty`;
  } catch {
    authOk = false;
  }
  checks.push({ name: "subscription-credentials", ok: authOk, detail: authDetail });

  const failed = checks.filter((c) => !c.ok);
  const ok = failed.length === 0;
  const reason = ok
    ? "tui-pilot preflight passed"
    : `tui-pilot preflight failed: ${failed.map((c) => `${c.name} (${c.detail})`).join("; ")}`;
  cachedPreflight = { ok, reason, checks, checkedAtMs: now };
  return cachedPreflight;
}

// --- Session gate (concurrency + bounded FIFO queue) -------------------------

type AcquireOutcome =
  | { kind: "acquired"; release: () => void; waitedMs: number }
  | { kind: "queue_full"; queued: number; maxQueued: number }
  | { kind: "timeout"; waitedMs: number }
  | { kind: "aborted"; waitedMs: number };

type Waiter = {
  grant: () => void;
  reject: (outcome: AcquireOutcome) => void;
  enqueuedAtMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  onAbort: (() => void) | null;
  signal?: AbortSignal;
  settled: boolean;
};

/**
 * A concurrency limiter with a bounded FIFO queue. FIFO ordering keeps short
 * single-turn callers from starving long goal workers (no priority inversion):
 * whoever waited longest runs next. Limits are read live per-acquire so a config
 * reload takes effect on the next run.
 */
export class TuiPilotSessionGate {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(private readonly limits: () => ResolvedTuiPilotOps) {}

  stats(): { active: number; queued: number } {
    return { active: this.active, queued: this.waiters.length };
  }

  async acquire(signal?: AbortSignal, now: () => number = Date.now): Promise<AcquireOutcome> {
    const { maxConcurrent, maxQueued, queueTimeoutMs } = this.limits();
    if (signal?.aborted) return { kind: "aborted", waitedMs: 0 };
    if (this.active < maxConcurrent) {
      this.active += 1;
      return { kind: "acquired", release: () => this.release(), waitedMs: 0 };
    }
    if (this.waiters.length >= maxQueued) {
      return { kind: "queue_full", queued: this.waiters.length, maxQueued };
    }
    const enqueuedAtMs = now();
    return await new Promise<AcquireOutcome>((resolve) => {
      const waiter: Waiter = {
        enqueuedAtMs,
        timer: null,
        onAbort: null,
        settled: false,
        ...(signal ? { signal } : {}),
        grant: () => {
          if (waiter.settled) return;
          this.settle(waiter);
          this.active += 1;
          resolve({
            kind: "acquired",
            release: () => this.release(),
            waitedMs: now() - enqueuedAtMs,
          });
        },
        reject: (outcome: AcquireOutcome) => {
          if (waiter.settled) return;
          this.settle(waiter);
          resolve(outcome);
        },
      };
      if (queueTimeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          waiter.reject({ kind: "timeout", waitedMs: now() - enqueuedAtMs });
        }, queueTimeoutMs);
      }
      if (signal) {
        waiter.onAbort = () => waiter.reject({ kind: "aborted", waitedMs: now() - enqueuedAtMs });
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private settle(waiter: Waiter): void {
    waiter.settled = true;
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.onAbort && waiter.signal) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    const idx = this.waiters.indexOf(waiter);
    if (idx !== -1) this.waiters.splice(idx, 1);
  }

  private release(): void {
    // The releasing holder frees its slot; if a waiter is queued, grant() hands it
    // the freed slot (grant() settles the waiter and re-increments `active`), so the
    // net change is zero and the slot transfers FIFO. Otherwise `active` just drops.
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters[0];
    if (next) next.grant();
  }
}

// The single process-wide gate. Limits are resolved live on each acquire.
const sessionGate = new TuiPilotSessionGate(() => resolveTuiPilotOps());

/** Visible for tests + observability. */
export function tuiPilotGateStats(): { active: number; queued: number } {
  return sessionGate.stats();
}

// --- Fail-closed result builders ---------------------------------------------

function failClosedResult(stderr: string, startMs: number): RunCliProcessResult {
  return {
    stdout: "",
    stderr,
    timedOut: false,
    exitCode: 1,
    signal: null,
    durationMs: Date.now() - startMs,
  };
}

function timedOutResult(stderr: string, startMs: number): RunCliProcessResult {
  return {
    stdout: "",
    stderr,
    timedOut: true,
    exitCode: null,
    signal: null,
    durationMs: Date.now() - startMs,
  };
}

// --- The gate entry point ----------------------------------------------------

/**
 * Run a tui-pilot prompt-run spawn through preflight + the session gate, with
 * observability. `spawn` performs the actual subprocess run and returns the raw
 * RunCliProcessResult. Preflight/queue failures are surfaced as ordinary failed
 * RunCliProcessResult values so the existing attempt classifier treats them as
 * retryable failures (never a provider-error misclassification).
 */
export async function runTuiPilotGated(
  opts: {
    site?: string;
    abortSignal?: AbortSignal;
    env?: Record<string, string | undefined>;
    startMs?: number;
  },
  spawn: () => Promise<RunCliProcessResult>,
): Promise<RunCliProcessResult> {
  const startMs = opts.startMs ?? Date.now();
  const ops = resolveTuiPilotOps();
  const site = opts.site ?? "unknown";

  if (ops.preflight !== "off") {
    const pf = ensureTuiPilotPreflight({ ...(opts.env ? { env: opts.env } : {}), ops });
    if (!pf.ok) {
      if (ops.preflight === "enforce") {
        log.error("tui-pilot preflight failed (fail-closed)", { site, reason: pf.reason });
        return failClosedResult(pf.reason, startMs);
      }
      log.warn("tui-pilot preflight failed (warn mode; proceeding)", { site, reason: pf.reason });
    }
  }

  const acquired = await sessionGate.acquire(opts.abortSignal);
  if (acquired.kind === "queue_full") {
    const reason = `tui-pilot capacity saturated: ${acquired.queued}/${acquired.maxQueued} runs queued (site=${site})`;
    log.warn("tui-pilot queue full (fail-closed)", { site, ...acquired });
    return failClosedResult(reason, startMs);
  }
  if (acquired.kind === "timeout") {
    const reason = `tui-pilot queue wait timed out after ${acquired.waitedMs}ms (site=${site})`;
    log.warn("tui-pilot queue wait timed out", { site, waitedMs: acquired.waitedMs });
    return timedOutResult(reason, startMs);
  }
  if (acquired.kind === "aborted") {
    return timedOutResult(`tui-pilot run aborted while queued (site=${site})`, startMs);
  }

  const { active, queued } = sessionGate.stats();
  if (acquired.waitedMs > 0) {
    log.info("tui-pilot run dequeued", { site, queueWaitMs: acquired.waitedMs, active, queued });
  }
  try {
    const result = await spawn();
    log.info("tui-pilot run complete", {
      site,
      queueWaitMs: acquired.waitedMs,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      active,
      queued,
    });
    return result;
  } finally {
    acquired.release();
  }
}
