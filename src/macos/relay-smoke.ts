export type RelaySmokeTest = never;

export function parseRelaySmokeTest(args: string[], env: NodeJS.ProcessEnv): RelaySmokeTest | null {
  const smokeIdx = args.indexOf("--smoke");
  if (smokeIdx !== -1) {
    const value = args[smokeIdx + 1];
    if (!value || value.startsWith("-")) {
      throw new Error("Missing value for --smoke");
    }
    throw new Error(`Unknown smoke test: ${value}`);
  }

  if (args.includes("--smoke-qr")) {
    throw new Error("QR smoke test is no longer supported in this build");
  }

  // Back-compat: only run env-based smoke mode when no CLI args are present,
  // to avoid surprising early-exit when users set env vars globally.
  if (args.length === 0 && (env.CLAWDBOT_SMOKE_QR === "1" || env.CLAWDBOT_SMOKE === "qr")) {
    throw new Error("QR smoke test is no longer supported in this build");
  }

  return null;
}

export async function runRelaySmokeTest(_test: RelaySmokeTest): Promise<void> {
  throw new Error("No smoke tests are supported in this build");
}
