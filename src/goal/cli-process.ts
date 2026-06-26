// Subprocess launcher contract:
// LLM callers (Claude Code, Codex, repo-chat workers, planners, reviewers, lessons,
// nightwatch, manual-tests, etc.) MUST pass an explicit `env` so they opt in to the
// credential set their subprocess needs — typically buildClaudeCodeEnv() or
// buildCredentialStrippedEnv(). If `env` is omitted, the default is a
// credential-stripped copy of process.env (see buildCredentialStrippedEnv in
// claude-code-env.ts). This default exists so that any new caller that forgets to
// pass env still fails closed for secret exposure rather than leaking the full
// gateway environment to the spawned process. Non-LLM callers (e.g. the mmdc
// Puppeteer renderer in mermaid-png.ts) use Node's `execFileSync` directly and are
// unaffected by this contract.

import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { loadConfig, type ClaudeDriver, type ClaudeDriverSite } from "../config/config.js";
import { buildCredentialStrippedEnv } from "./claude-code-env.js";
import { resolveTuiPilotBinary, runTuiPilotGated } from "./tui-pilot-driver.js";

const SIGTERM_GRACE_MS = 5_000;

/**
 * The driver used when neither a per-site override nor `goal.claudeDriver` is set.
 *
 * Direct `claude -p` is the permanent MAIN/default path: tui-pilot is OPTIONAL and
 * opt-in. A host that has not installed tui-pilot and has not set
 * `goal.claudeDriver: "tui-pilot"` (or `goal.tuiPilot.sites`) never invokes tui-pilot —
 * the binary lookup, preflight, and concurrency gate all live behind the tui-pilot
 * branch only (see runCliProcess). Leaving this `direct` keeps `-p` working with zero
 * tui-pilot dependency; flipping it would make tui-pilot mandatory, which we do NOT want.
 */
const DEFAULT_CLAUDE_DRIVER: ClaudeDriver = "direct";

export type RunCliProcessParams = {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  stdin?: string;
  stdoutPath?: string;
  stderrPath?: string;
  /**
   * Custom environment variables for the spawned process. LLM callers must pass
   * an explicit env. When omitted, the default is buildCredentialStrippedEnv()
   * — a copy of process.env with known credential keys removed.
   */
  env?: Record<string, string | undefined>;
  /**
   * Logical Claude prompt-run call site (e.g. "cli-worker"). Used only to select
   * the driver per-site via `goal.tuiPilot.sites`, and as an observability label.
   * Ignored for non-Claude or non-prompt-run spawns. When omitted, only the global
   * `goal.claudeDriver` applies.
   */
  claudeDriverSite?: ClaudeDriverSite;
};

export type RunCliProcessResult = {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
};

type SpawnCommand = {
  command: string;
  args: string[];
};

type ClaudePromptOptions = {
  settings?: string;
  settingSources?: string;
  sessionId?: string;
  appendSystemPrompt?: string;
  appendSystemPromptFile?: string;
  allowedTools?: string[];
  maxTurns?: string;
  model?: string;
  continue?: boolean;
  prompt: string;
};

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function terminateProcess(proc: ChildProcess): void {
  if (!proc.pid) return;
  proc.kill("SIGTERM");
  const killTimer = setTimeout(() => {
    if (!proc.pid) return;
    if (isProcessAlive(proc.pid)) {
      proc.kill("SIGKILL");
    }
  }, SIGTERM_GRACE_MS);
  proc.once("close", () => clearTimeout(killTimer));
}

function openOutputFd(outputPath: string | undefined): number | undefined {
  if (!outputPath) return undefined;
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    return fs.openSync(outputPath, "w");
  } catch {
    return undefined;
  }
}

function closeOutputFd(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    fs.closeSync(fd);
  } catch {
    // best-effort cleanup
  }
}

function readOutputFile(outputPath: string | undefined, fallback: string): string {
  if (!outputPath) return fallback;
  try {
    return fs.readFileSync(outputPath, "utf8");
  } catch {
    return fallback;
  }
}

/**
 * Resolve the driver for a prompt run. A per-site override in
 * `goal.tuiPilot.sites[site]` wins over the global `goal.claudeDriver`, which in
 * turn falls back to DEFAULT_CLAUDE_DRIVER. This is what lets S3 canary specific
 * sites onto tui-pilot while everything else stays on the global default.
 */
export function resolveClaudeDriver(site?: string): ClaudeDriver {
  const goal = loadConfig().goal;
  const sites = goal?.tuiPilot?.sites;
  if (site && sites) {
    const perSite = sites[site as keyof typeof sites];
    if (perSite) return perSite;
  }
  return goal?.claudeDriver ?? DEFAULT_CLAUDE_DRIVER;
}

function isClaudeCommand(command: string): boolean {
  return path.basename(command) === "claude";
}

function isClaudePromptRun(args: readonly string[]): boolean {
  return args.some((arg) => arg === "-p" || arg === "--print");
}

function takeArg(args: readonly string[], index: number): string | undefined {
  return index + 1 < args.length ? args[index + 1] : undefined;
}

function parseClaudePromptOptions(args: readonly string[]): ClaudePromptOptions {
  const options: Omit<ClaudePromptOptions, "prompt"> = {};
  const allowedTools: string[] = [];
  let prompt: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-p" || arg === "--print" || arg === "--verbose") continue;
    if (arg === "--output-format") {
      i += 1;
      continue;
    }
    if (arg === "--settings") {
      options.settings = takeArg(args, i);
      i += 1;
      continue;
    }
    if (arg === "--setting-sources") {
      options.settingSources = takeArg(args, i);
      i += 1;
      continue;
    }
    if (arg === "--session-id" || arg === "--resume") {
      options.sessionId = takeArg(args, i);
      i += 1;
      continue;
    }
    if (arg === "--continue" || arg === "-c") {
      options.continue = true;
      continue;
    }
    if (arg === "--append-system-prompt") {
      options.appendSystemPrompt = takeArg(args, i);
      i += 1;
      continue;
    }
    if (arg === "--append-system-prompt-file") {
      options.appendSystemPromptFile = takeArg(args, i);
      i += 1;
      continue;
    }
    if (arg === "--allowedTools") {
      const value = takeArg(args, i);
      if (value !== undefined) allowedTools.push(value);
      i += 1;
      continue;
    }
    if (arg === "--max-turns") {
      options.maxTurns = takeArg(args, i);
      i += 1;
      continue;
    }
    if (arg === "--model") {
      options.model = takeArg(args, i);
      i += 1;
      continue;
    }
    if (arg === "--permission-mode") {
      i += 1;
      continue;
    }
    prompt = arg;
  }

  return {
    ...options,
    ...(allowedTools.length > 0 ? { allowedTools } : {}),
    prompt: prompt ?? "",
  };
}

function foldModelIntoSettings(settingsPath: string | undefined, model: string | undefined): void {
  if (!settingsPath || !model) return;
  try {
    const raw = fs.readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const settings =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? { ...(parsed as Record<string, unknown>) }
        : {};
    settings.model = model;
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  } catch {
    // Preserve process execution; Claude/tui-pilot will surface settings errors.
  }
}

function buildTuiPilotPromptRun(params: {
  args: readonly string[];
  cwd: string;
  env: Record<string, string | undefined>;
}): SpawnCommand {
  const options = parseClaudePromptOptions(params.args);
  foldModelIntoSettings(options.settings, options.model);

  const args = ["print", "--output-format", "stream-json", "--policy", "deny", "--cwd", params.cwd];
  if (options.settings !== undefined) args.push("--settings", options.settings);
  if (options.settingSources !== undefined) args.push("--setting-sources", options.settingSources);
  if (options.sessionId !== undefined) args.push("--session-id", options.sessionId);
  if (options.continue) args.push("--continue");
  if (options.appendSystemPrompt !== undefined) {
    args.push("--append-system-prompt", options.appendSystemPrompt);
  }
  if (options.appendSystemPromptFile !== undefined) {
    args.push("--append-system-prompt-file", options.appendSystemPromptFile);
  }
  for (const allowedTools of options.allowedTools ?? []) {
    args.push("--allowedTools", allowedTools);
  }
  if (options.maxTurns !== undefined) args.push("--max-turns", options.maxTurns);
  args.push(options.prompt);

  return {
    command: resolveTuiPilotBinary(params.env),
    args,
  };
}

export function buildClaudeDriverSpawnCommand(
  params: {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string | undefined>;
  },
  /**
   * Explicit driver override. When omitted, the driver is read from config
   * (`goal.claudeDriver`, default `direct`). The shadow-parity harness passes an
   * explicit mode so it can build both legs independently of global config.
   */
  driverOverride?: ClaudeDriver,
): SpawnCommand {
  if (!isClaudeCommand(params.command) || !isClaudePromptRun(params.args)) {
    return { command: params.command, args: params.args };
  }
  const driver = driverOverride ?? resolveClaudeDriver();
  if (driver === "direct") {
    return { command: params.command, args: params.args };
  }
  return buildTuiPilotPromptRun(params);
}

export async function runCliProcess(params: RunCliProcessParams): Promise<RunCliProcessResult> {
  const { command, args, cwd, timeoutMs, abortSignal, stdin, stdoutPath, stderrPath } = params;
  const start = Date.now();

  if (abortSignal?.aborted) {
    return {
      stdout: "",
      stderr: "",
      timedOut: true,
      exitCode: null,
      signal: null,
      durationMs: 0,
    };
  }

  const env = params.env ?? buildCredentialStrippedEnv();
  const driver = resolveClaudeDriver(params.claudeDriverSite);
  const spawnCommand = buildClaudeDriverSpawnCommand({ command, args, cwd, env }, driver);

  const executeSpawn = (): Promise<RunCliProcessResult> =>
    new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      fs.mkdirSync(cwd, { recursive: true });
      const stdoutFd = openOutputFd(stdoutPath);
      const stderrFd = openOutputFd(stderrPath);
      const stdio: ["pipe" | "ignore", number | "pipe", number | "pipe"] = [
        stdin ? "pipe" : "ignore",
        stdoutFd ?? "pipe",
        stderrFd ?? "pipe",
      ];

      const proc: ChildProcess = spawn(spawnCommand.command, spawnCommand.args, {
        cwd,
        stdio,
        env,
      });

      if (stdin && proc.stdin) {
        proc.stdin.write(stdin);
        proc.stdin.end();
      }

      proc.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
      });

      const hardTimeout = setTimeout(() => {
        if (timedOut) return;
        timedOut = true;
        terminateProcess(proc);
      }, timeoutMs);

      const abortHandler = () => {
        if (timedOut) return;
        timedOut = true;
        terminateProcess(proc);
      };
      if (abortSignal) {
        abortSignal.addEventListener("abort", abortHandler, { once: true });
      }

      const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimeout);
        if (abortSignal) {
          abortSignal.removeEventListener("abort", abortHandler);
        }
        closeOutputFd(stdoutFd);
        closeOutputFd(stderrFd);
        stdout = readOutputFile(stdoutPath, stdout);
        stderr = readOutputFile(stderrPath, stderr);
        if (timedOut && proc.pid && isProcessAlive(proc.pid)) {
          proc.kill("SIGKILL");
        }
        resolve({
          stdout,
          stderr,
          timedOut,
          exitCode,
          signal,
          durationMs: Date.now() - start,
        });
      };

      proc.on("close", (code, signal) => {
        finish(code, signal);
      });

      proc.on("error", (err) => {
        stderr += `\nProcess error: ${err.message}`;
        if (stderrFd !== undefined) {
          try {
            fs.writeSync(stderrFd, `\nProcess error: ${err.message}`);
          } catch {
            // best-effort artifact write
          }
        }
        finish(1, null);
      });
    });

  // Only the tui-pilot leg of a Claude prompt run is gated (heavier tmux sessions).
  // Direct claude runs and all non-Claude/non-prompt spawns run ungated and unchanged.
  const isTuiPilotRun =
    driver === "tui-pilot" && isClaudeCommand(command) && isClaudePromptRun(args);
  if (isTuiPilotRun) {
    return runTuiPilotGated(
      {
        ...(params.claudeDriverSite ? { site: params.claudeDriverSite } : {}),
        ...(abortSignal ? { abortSignal } : {}),
        env,
        startMs: start,
      },
      executeSpawn,
    );
  }
  return executeSpawn();
}
