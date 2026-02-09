import { execFileSync } from "node:child_process";
import type { BackendAvailability, GoalBackendId } from "./backend-types.js";

let cachedAvailability: BackendAvailability[] | null = null;

export function resetBackendAvailabilityCache(): void {
  cachedAvailability = null;
}

function probeBackend(
  binary: string,
  requiredFlags: string[],
): { available: boolean; reason?: string } {
  let helpOutput: string;
  try {
    helpOutput = execFileSync(binary, ["--help"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string; code?: string };
    if (error.code === "ENOENT") {
      return { available: false, reason: `${binary} not found on PATH` };
    }
    helpOutput = (error.stdout ?? "") + (error.stderr ?? "");
    if (!helpOutput.trim()) {
      return { available: false, reason: `${binary} --help produced no output` };
    }
  }

  const missing = requiredFlags.filter((flag) => !helpOutput.includes(flag));
  if (missing.length > 0) {
    return {
      available: false,
      reason: `${binary} found but missing flags: ${missing.join(", ")}`,
    };
  }
  return { available: true };
}

export function detectBackendAvailability(): BackendAvailability[] {
  if (cachedAvailability) return cachedAvailability;

  const results: BackendAvailability[] = [{ id: "pi", available: true }];

  const codexProbe = probeBackend("codex", ["--sandbox", "--output-schema"]);
  results.push({ id: "codex", ...codexProbe });

  const claudeProbe = probeBackend("claude", ["--allowedTools", "--append-system-prompt-file"]);
  results.push({ id: "claude_code", ...claudeProbe });

  cachedAvailability = results;
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
