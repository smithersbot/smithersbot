import { spawnSync } from "node:child_process";
import type { BackendAvailability, GoalBackendId } from "./backend-types.js";
import { appendCodexSandboxArgs, buildCodexSandboxConfig } from "./backend-sandbox.js";

type CodexAskForApprovalPlacement = "before_exec" | "after_exec" | "unsupported";

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_RETRY_DELAY_MS = 500;
const MAX_REASON_CHARS = 160;

type ProbeResult = {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
};

type ProbeSpec = {
  binary: string;
  helpArgs: string[];
  flagProbeArgs?: (params: { workingDir: string }) => string[];
};

function runProbe(binary: string, args: string[]): ProbeResult {
  const spawnProbe = () =>
    spawnSync(binary, args, {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });

  let result = spawnProbe();
  const retryError = result.error as NodeJS.ErrnoException | undefined;
  if (result.signal && retryError?.code !== "ENOENT") {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, PROBE_RETRY_DELAY_MS);
    result = spawnProbe();
  }

  return {
    ok: result.status === 0,
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error as NodeJS.ErrnoException | undefined,
  };
}

function normalizeReason(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.length > MAX_REASON_CHARS ? `${cleaned.slice(0, MAX_REASON_CHARS)}...` : cleaned;
}

function formatProbeFailure(binary: string, args: string[], result: ProbeResult): string {
  if (result.error?.code === "ENOENT") {
    return `${binary} not found on PATH`;
  }

  const commandLabel = `${binary} ${args.join(" ")}`.trim();
  if (result.signal) {
    return `${commandLabel} terminated with signal ${result.signal}`;
  }

  const exitCode = result.exitCode ?? "unknown";
  const detail = normalizeReason(result.stderr) || normalizeReason(result.stdout);
  if (detail) {
    return `${commandLabel} exited with code ${exitCode}: ${detail}`;
  }
  return `${commandLabel} exited with code ${exitCode}`;
}

function probeBackend(spec: ProbeSpec): { available: boolean; reason?: string } {
  const helpResult = runProbe(spec.binary, spec.helpArgs);
  if (!helpResult.ok) {
    return {
      available: false,
      reason: formatProbeFailure(spec.binary, spec.helpArgs, helpResult),
    };
  }

  if (spec.flagProbeArgs) {
    const workingDir = process.cwd();
    try {
      const probeArgs = spec.flagProbeArgs({ workingDir });
      const flagResult = runProbe(spec.binary, probeArgs);
      if (!flagResult.ok) {
        return {
          available: false,
          reason: formatProbeFailure(spec.binary, probeArgs, flagResult),
        };
      }
    } catch {
      // If we cannot run the flag probe, fall back to the help check result.
    }
  }

  return { available: true };
}

export function getCodexAskForApprovalPlacement(): CodexAskForApprovalPlacement {
  const beforeExec = runProbe("codex", ["--ask-for-approval", "never", "exec", "--help"]);
  if (beforeExec.ok) {
    return "before_exec";
  }
  const afterExec = runProbe("codex", ["exec", "--ask-for-approval", "never", "--help"]);
  if (afterExec.ok) {
    return "after_exec";
  }
  return "unsupported";
}

export function detectBackendAvailability(): BackendAvailability[] {
  const results: BackendAvailability[] = [{ id: "pi", available: true }];

  const codexAskForApproval = getCodexAskForApprovalPlacement();
  const codexProbe = probeBackend({
    binary: "codex",
    helpArgs: ["exec", "--help"],
    // Safe no-op probe: include the actual flags plus --help to avoid invoking the model.
    flagProbeArgs: ({ workingDir }) => {
      const sandboxConfig = buildCodexSandboxConfig({
        workingDir,
        purpose: "goal-worker",
        requiresNetwork: true,
      });
      const args = [
        ...(codexAskForApproval === "before_exec" ? ["--ask-for-approval", "never"] : []),
        "exec",
        "--json",
        ...(codexAskForApproval === "after_exec" ? ["--ask-for-approval", "never"] : []),
        "--skip-git-repo-check",
      ];
      appendCodexSandboxArgs(args, sandboxConfig);
      args.push("--help");
      return args;
    },
  });
  results.push({ id: "codex", ...codexProbe });

  const claudeProbe = probeBackend({
    binary: "claude",
    helpArgs: ["--help"],
  });
  results.push({ id: "claude_code", ...claudeProbe });

  return results;
}

export function isBackendAvailable(
  backend: GoalBackendId,
  availability: BackendAvailability[],
): { available: true } | { available: false; reason?: string } {
  const entry = availability.find((item) => item.id === backend);
  if (!entry) return { available: false, reason: "Unknown backend" };
  return entry.available ? { available: true } : { available: false, reason: entry.reason };
}
