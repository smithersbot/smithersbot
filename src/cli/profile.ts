import os from "node:os";
import path from "node:path";

import { resolveGatewayInstanceIdentity } from "../config/gateway-instance.js";
import { isValidProfileName } from "./profile-utils.js";

export type CliProfileParseResult =
  | { ok: true; profile: string | null; argv: string[] }
  | { ok: false; error: string };

function takeValue(
  raw: string,
  next: string | undefined,
): {
  value: string | null;
  consumedNext: boolean;
} {
  if (raw.includes("=")) {
    const [, value] = raw.split("=", 2);
    const trimmed = (value ?? "").trim();
    return { value: trimmed || null, consumedNext: false };
  }
  const trimmed = (next ?? "").trim();
  return { value: trimmed || null, consumedNext: Boolean(next) };
}

export function parseCliProfileArgs(argv: string[]): CliProfileParseResult {
  if (argv.length < 2) return { ok: true, profile: null, argv };

  const out: string[] = argv.slice(0, 2);
  let profile: string | null = null;
  let sawDev = false;
  let sawCommand = false;

  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;

    if (sawCommand) {
      out.push(arg);
      continue;
    }

    if (arg === "--dev") {
      if (profile && profile !== "dev") {
        return { ok: false, error: "Cannot combine --dev with --profile" };
      }
      sawDev = true;
      profile = "dev";
      continue;
    }

    if (arg === "--profile" || arg.startsWith("--profile=")) {
      if (sawDev) {
        return { ok: false, error: "Cannot combine --dev with --profile" };
      }
      const next = args[i + 1];
      const { value, consumedNext } = takeValue(arg, next);
      if (consumedNext) i += 1;
      if (!value) return { ok: false, error: "--profile requires a value" };
      if (!isValidProfileName(value)) {
        return {
          ok: false,
          error: 'Invalid --profile (use letters, numbers, "_", "-" only)',
        };
      }
      profile = value;
      continue;
    }

    if (!arg.startsWith("-")) {
      sawCommand = true;
      out.push(arg);
      continue;
    }

    out.push(arg);
  }

  return { ok: true, profile, argv: out };
}

function resolveProfileStateDir(profile: string, homedir: () => string): string {
  const suffix = profile.toLowerCase() === "default" ? "" : `-${profile}`;
  return path.join(homedir(), `.clawdbot${suffix}`);
}

function hasAnyEnvValue(env: Record<string, string | undefined>, keys: string[]): boolean {
  return keys.some((key) => Boolean(env[key]?.trim()));
}

export function applyCliProfileEnv(params: {
  profile: string;
  env?: Record<string, string | undefined>;
  homedir?: () => string;
}) {
  const env = params.env ?? (process.env as Record<string, string | undefined>);
  const homedir = params.homedir ?? os.homedir;
  const profile = params.profile.trim();
  if (!profile) return;

  // Convenience only: fill defaults, never override explicit env values.
  env.CLAWDBOT_PROFILE = profile;

  if (profile === "dev") {
    const instance = resolveGatewayInstanceIdentity("dev", homedir);
    env.SMITHERSBOT_INSTANCE = instance.name;
    if (!env.SMITHERSBOT_GOALS_ROOT?.trim()) {
      env.SMITHERSBOT_GOALS_ROOT = instance.managedRoot;
    }
    if (
      !hasAnyEnvValue(env, ["SMITHERSBOT_STATE_DIR", "MOLTBOT_STATE_DIR", "CLAWDBOT_STATE_DIR"])
    ) {
      env.SMITHERSBOT_STATE_DIR = instance.stateDir;
    }
    if (
      !hasAnyEnvValue(env, [
        "SMITHERSBOT_CONFIG_PATH",
        "MOLTBOT_CONFIG_PATH",
        "CLAWDBOT_CONFIG_PATH",
      ])
    ) {
      env.SMITHERSBOT_CONFIG_PATH = path.join(instance.stateDir, "smithersbot.json");
    }
    // Target the dev gateway instance's canonical port (18790). A generic
    // CLAWDBOT_GATEWAY_PORT may have been inherited from the launching (stable)
    // instance's service env, which points at the wrong instance; the explicitly
    // selected dev instance must win. Set the instance-aligned
    // SMITHERSBOT_GATEWAY_PORT (highest precedence in resolveGatewayPort) unless the
    // caller explicitly targeted a dev port via an instance-aware port var. We do
    // NOT defer to a bare CLAWDBOT_GATEWAY_PORT: that legacy var is what leaks in
    // from the launching instance and must not silently retarget `--dev`.
    if (!hasAnyEnvValue(env, ["SMITHERSBOT_GATEWAY_PORT", "MOLTBOT_GATEWAY_PORT"])) {
      env.SMITHERSBOT_GATEWAY_PORT = String(instance.defaultPort);
    }
  }

  const stateDir = env.CLAWDBOT_STATE_DIR?.trim() || resolveProfileStateDir(profile, homedir);
  if (!env.CLAWDBOT_STATE_DIR?.trim()) env.CLAWDBOT_STATE_DIR = stateDir;

  if (!env.CLAWDBOT_CONFIG_PATH?.trim()) {
    env.CLAWDBOT_CONFIG_PATH = path.join(stateDir, "moltbot.json");
  }
}
