import { execFileSync, spawnSync } from "node:child_process";

export const BUILD_GATE_COMMAND_TIMEOUT_MS = 10 * 60_000;
export const BUILD_GATE_OUTPUT_MAX_CHARS = 16_000;
const BUILD_GATE_GIT_TIMEOUT_MS = 15_000;
// Temporary kill-switch: keep default semgrep SAST disabled until blocked goal flows are fixed.
const DEFAULT_SAST_SEMGREP_ENABLED = false;

export type BuildGateFailureKind = "command_failed" | "infra_failed";

export type BuildGateResult =
  | { passed: true }
  | { passed: false; failedCommand: string; output: string; failureKind: BuildGateFailureKind };

const SEMGREP_INFRA_FAILURE_PATTERNS: RegExp[] = [
  /Build gate command failed to execute:/i,
  /\bETIMEDOUT\b/i,
  /\bConnectionError\b/i,
  /Failed to resolve ['"]?semgrep\.dev['"]?/i,
  /\bNameResolutionError\b/i,
  /Max retries exceeded with url:\s*\/c\/auto/i,
];

export function truncateForPrompt(text: string): string {
  if (!text) return "";
  const trimmed = text.trim();
  if (trimmed.length <= BUILD_GATE_OUTPUT_MAX_CHARS) return trimmed;
  return trimmed.slice(-BUILD_GATE_OUTPUT_MAX_CHARS);
}

export function formatExecError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const maybeStdout = (error as { stdout?: Buffer | string }).stdout;
  const maybeStderr = (error as { stderr?: Buffer | string }).stderr;
  const stdout =
    typeof maybeStdout === "string"
      ? maybeStdout
      : maybeStdout instanceof Buffer
        ? maybeStdout.toString("utf8")
        : "";
  const stderr =
    typeof maybeStderr === "string"
      ? maybeStderr
      : maybeStderr instanceof Buffer
        ? maybeStderr.toString("utf8")
        : "";
  return [error.message, stdout, stderr]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n");
}

function isSemgrepScanCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  return normalized.startsWith("semgrep ") || normalized.includes(" semgrep ");
}

export function classifyBuildGateFailure(command: string, output: string): BuildGateFailureKind {
  if (!isSemgrepScanCommand(command)) return "command_failed";
  return SEMGREP_INFRA_FAILURE_PATTERNS.some((pattern) => pattern.test(output))
    ? "infra_failed"
    : "command_failed";
}

export function runBuildGateCommands(commands: string[], workingDir: string): BuildGateResult {
  for (const command of commands) {
    const trimmed = command.trim();
    if (!trimmed) continue;

    const result = spawnSync("bash", ["-lc", trimmed], {
      cwd: workingDir,
      encoding: "utf8",
      timeout: BUILD_GATE_COMMAND_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    const output = truncateForPrompt([stdout, stderr].filter(Boolean).join("\n"));

    if (result.error) {
      const message = truncateForPrompt(
        [output, `Build gate command failed to execute: ${formatExecError(result.error)}`]
          .filter(Boolean)
          .join("\n"),
      );
      return {
        passed: false,
        failedCommand: trimmed,
        output: message || "Build gate command failed with an unknown process error.",
        failureKind: classifyBuildGateFailure(trimmed, message),
      };
    }

    if (result.status !== 0) {
      const statusBits = [
        result.status != null ? `exit code ${result.status}` : null,
        result.signal ? `signal ${result.signal}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      const message = truncateForPrompt(
        [output, statusBits ? `Build gate command failed with ${statusBits}.` : ""]
          .filter(Boolean)
          .join("\n"),
      );
      return {
        passed: false,
        failedCommand: trimmed,
        output: message || "Build gate command exited non-zero with no output.",
        failureKind: classifyBuildGateFailure(trimmed, message),
      };
    }
  }

  return { passed: true };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function parsePathLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function resolveChangedFilesSinceCheckpoint(params: {
  workingDir: string;
  baseSha?: string;
}): string[] | null {
  const baseSha = params.baseSha?.trim();
  if (!baseSha) return null;
  try {
    const trackedRaw = execFileSync(
      "git",
      ["-C", params.workingDir, "diff", "--name-only", "--diff-filter=ACMRTUXB", baseSha],
      {
        encoding: "utf8",
        timeout: BUILD_GATE_GIT_TIMEOUT_MS,
      },
    );
    const untrackedRaw = execFileSync(
      "git",
      ["-C", params.workingDir, "ls-files", "--others", "--exclude-standard"],
      {
        encoding: "utf8",
        timeout: BUILD_GATE_GIT_TIMEOUT_MS,
      },
    );
    return Array.from(
      new Set([...parsePathLines(trackedRaw), ...parsePathLines(untrackedRaw)]),
    ).sort();
  } catch {
    return null;
  }
}

export function buildDefaultSastCommand(params: {
  workingDir: string;
  targetPaths?: string[];
}): string | null {
  if (!DEFAULT_SAST_SEMGREP_ENABLED) {
    return null;
  }

  const semgrepCheck = spawnSync("which", ["semgrep"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (semgrepCheck.error || semgrepCheck.status !== 0) {
    return null;
  }

  const resolvedPath = typeof semgrepCheck.stdout === "string" ? semgrepCheck.stdout.trim() : "";
  if (!resolvedPath) {
    return null;
  }

  const targetPaths = params.targetPaths;
  if (targetPaths && targetPaths.length === 0) return null;
  const targetArgs =
    targetPaths && targetPaths.length > 0
      ? targetPaths
          .map((target) => (target.startsWith("-") ? `./${target}` : target))
          .map(shellQuote)
          .join(" ")
      : shellQuote(params.workingDir);

  return `semgrep scan --config auto --error --quiet --severity ERROR --timeout 30 --exclude 'node_modules' --exclude 'dist' --exclude '.git' --exclude '.next' --exclude 'build' --exclude '*.test.ts' ${targetArgs}`;
}

export function resetToTaskBaseSha(
  workingDir: string,
  checkpointSha: string | undefined,
): { success: true } | { success: false; error: string } {
  if (!checkpointSha) {
    return { success: false, error: "No task checkpoint base SHA was recorded for this step." };
  }
  try {
    execFileSync("git", ["-C", workingDir, "reset", "--hard", checkpointSha], {
      encoding: "utf8",
      timeout: 15_000,
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: formatExecError(error) };
  }
}

export function makeBuildGateFailurePrompt(command: string, output: string): string {
  return [
    `The build gate (${command}) failed after you reported complete.`,
    "Fix the errors.",
    "Here is the output:",
    output,
  ].join("\n");
}
