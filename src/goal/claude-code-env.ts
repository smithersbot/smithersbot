// Shared env-building logic for Claude Code subprocess auth (workers + scout).

import fs from "node:fs";
import path from "node:path";
import type { ClaudeCodeAuthMode } from "../config/types.goal.js";

export const AUTH_KEYS_TO_STRIP = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY_OLD",
];

export const CREDENTIAL_KEYS_TO_STRIP = [
  "DATABASE_URL",
  "DB_PASSWORD",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "NPM_TOKEN",
  "NPM_CONFIG_TOKEN",
  "DOCKER_PASSWORD",
  "REDIS_URL",
  "REDIS_PASSWORD",
];

export function shouldStripCredentialKey(key: string): boolean {
  if (CREDENTIAL_KEYS_TO_STRIP.includes(key)) return true;
  if (key.startsWith("OP_SESSION_")) return true;
  if (key.endsWith("_SECRET")) return true;
  if (key.endsWith("_PRIVATE_KEY")) return true;
  return false;
}

/**
 * Build a process env for a Claude Code subprocess.
 * In "subscription" mode, API key env vars are stripped so claude uses its own subscription auth.
 */
export function buildClaudeCodeEnv(
  authMode: ClaudeCodeAuthMode,
): Record<string, string | undefined> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (shouldStripCredentialKey(key)) delete env[key];
  }
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
      ? `auth_mode=subscription (${AUTH_KEYS_TO_STRIP.join(", ")} + credential env keys stripped)`
      : "auth_mode=api_key (credential env keys stripped)";
  try {
    fs.writeFileSync(path.join(dir, "auth_mode.txt"), detail, "utf8");
  } catch {
    // best-effort
  }
}
