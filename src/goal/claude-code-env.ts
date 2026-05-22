// Shared env-building logic for Claude Code subprocess auth (workers + scout).

import fs from "node:fs";
import path from "node:path";
import type { ClaudeCodeAuthMode } from "../config/types.goal.js";

export const AUTH_KEYS_TO_STRIP = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY_OLD",
];

export const SUBSCRIPTION_AUTH_ENV_KEYS_TO_STRIP = [...AUTH_KEYS_TO_STRIP, "ANTHROPIC_BASE_URL"];

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
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_KEY",
  "HF_TOKEN",
  "HUGGING_FACE_HUB_TOKEN",
  "COHERE_API_KEY",
  "MISTRAL_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
  "REPLICATE_API_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_USER_TOKEN",
  "SMITHERSBOT_GATEWAY_TOKEN",
  "SMITHERSBOT_GATEWAY_PASSWORD",
  "MOLTBOT_GATEWAY_TOKEN",
  "MOLTBOT_GATEWAY_PASSWORD",
  "CLAWDBOT_GATEWAY_TOKEN",
  "CLAWDBOT_GATEWAY_PASSWORD",
];

export function shouldStripCredentialKey(key: string): boolean {
  if (AUTH_KEYS_TO_STRIP.includes(key)) return false;
  if (CREDENTIAL_KEYS_TO_STRIP.includes(key)) return true;
  if (key.startsWith("OP_SESSION_")) return true;
  if (key.includes("OAUTH")) return true;
  if (key.endsWith("_TOKEN")) return true;
  if (key.endsWith("_SECRET")) return true;
  if (key.endsWith("_PRIVATE_KEY")) return true;
  if (key.endsWith("_API_KEY")) return true;
  return false;
}

export function buildCredentialStrippedEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
  options: { stripAuthKeys?: boolean } = {},
): Record<string, string | undefined> {
  const env = { ...sourceEnv };
  for (const key of Object.keys(env)) {
    if (
      shouldStripCredentialKey(key) ||
      (options.stripAuthKeys === true && AUTH_KEYS_TO_STRIP.includes(key))
    ) {
      delete env[key];
    }
  }
  return env;
}

export function stripClaudeSubscriptionAuthEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const next = { ...env };
  for (const key of SUBSCRIPTION_AUTH_ENV_KEYS_TO_STRIP) {
    delete next[key];
  }
  return next;
}

/**
 * Build a process env for a Claude Code subprocess.
 * In "subscription" mode, API key env vars are stripped so claude uses its own subscription auth.
 */
export function buildClaudeCodeEnv(
  authMode: ClaudeCodeAuthMode,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const env = buildCredentialStrippedEnv(sourceEnv);
  if (authMode === "subscription") {
    return stripClaudeSubscriptionAuthEnv(env);
  }
  return env;
}

/** Write a one-liner to dir/auth_mode.txt for artifact self-documentation. */
export function writeAuthModeArtifact(dir: string, authMode: ClaudeCodeAuthMode): void {
  const detail =
    authMode === "subscription"
      ? `auth_mode=subscription (${SUBSCRIPTION_AUTH_ENV_KEYS_TO_STRIP.join(", ")} + credential env keys stripped)`
      : "auth_mode=api_key (credential env keys stripped)";
  try {
    fs.writeFileSync(path.join(dir, "auth_mode.txt"), detail, "utf8");
  } catch {
    // best-effort
  }
}
