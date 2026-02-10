// Shared env-building logic for Claude Code subprocess auth (workers + scout).

import fs from "node:fs";
import path from "node:path";
import type { ClaudeCodeAuthMode } from "../config/types.goal.js";

export const AUTH_KEYS_TO_STRIP = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY_OLD",
];

/**
 * Build a process env for a Claude Code subprocess.
 * In "subscription" mode, API key env vars are stripped so claude uses its own subscription auth.
 */
export function buildClaudeCodeEnv(
  authMode: ClaudeCodeAuthMode,
): Record<string, string | undefined> {
  const env = { ...process.env };
  if (authMode === "subscription") {
    for (const key of AUTH_KEYS_TO_STRIP) {
      delete env[key];
    }
  }
  return env;
}

/** Write a one-liner to dir/auth_mode.txt for artifact self-documentation. */
export function writeAuthModeArtifact(dir: string, authMode: ClaudeCodeAuthMode): void {
  const detail =
    authMode === "subscription"
      ? `auth_mode=subscription (${AUTH_KEYS_TO_STRIP.join(", ")} stripped)`
      : "auth_mode=api_key (env passed through)";
  try {
    fs.writeFileSync(path.join(dir, "auth_mode.txt"), detail, "utf8");
  } catch {
    // best-effort
  }
}
