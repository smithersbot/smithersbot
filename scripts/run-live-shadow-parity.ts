// Live shadow-parity gate (operator host only). Runs representative prompts through
// BOTH the direct `claude -p` leg and the `tui-pilot print` leg via the real driver
// seam, then asserts parity on the fields SmithersBot consumers actually read:
// worker_result.json, normalized final assistant text, provider-error class, and
// attempt outcome. Cost/duration are excluded by construction.
//
// Run this on an authenticated operator host BEFORE flipping any default
// (S3 canary enable, S4 default-on). It spends real subscription tokens.
//
//   unset ANTHROPIC_API_KEY   # force Max OAuth
//   node --import tsx scripts/run-live-shadow-parity.ts
//
// Exit 0 = parity PASS, 1 = parity FAIL, 2 = harness error.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatParityReport,
  makeLiveParityExecutor,
  runShadowParity,
  type ParityCase,
} from "../src/goal/tui-pilot-parity.js";

const home = os.homedir();
const credsPath = path.join(home, ".claude", ".credentials.json");
const claudeDir = path.join(home, ".claude");

// Production-shaped sandbox settings: subscription OAuth credentials are denied to
// the agent's tools (the carve-out is NOT needed — Claude authenticates outside the
// sandbox boundary), allow read/write scoped to the parity scratch root.
function prodSettings(rootDir: string): Record<string, unknown> {
  return {
    model: "claude-haiku-4-5-20251001",
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      filesystem: {
        allowRead: [rootDir],
        allowWrite: [rootDir],
        denyRead: [credsPath, claudeDir],
      },
    },
    permissions: { deny: [`Read(${claudeDir}/**)`] },
  };
}

async function main(): Promise<number> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-shadow-parity-"));
  const settings = prodSettings(rootDir);

  const cases: ParityCase[] = [
    {
      name: "worker-result side channel",
      prompt:
        'Use the Bash tool to write exactly this JSON to the file worker_result.json in the ' +
        'current directory: {"status":"complete","summary":"shadow parity ok"} . ' +
        "Then reply with exactly: done",
      allowedTools: ["Bash"],
      settings,
      expectsWorkerResult: true,
    },
    {
      name: "final text only",
      prompt: "Reply with exactly READY and nothing else.",
      allowedTools: ["Bash"],
      settings,
      expectsWorkerResult: false,
    },
    {
      // Replicates the planner's real shape: a large multi-line prompt fed via stdin.
      // This is the case that would have caught TUI-PILOT-053 (large prompts hanging
      // tui-pilot at stuck:waiting_for_input) — exercise both legs end to end.
      name: "large multi-line prompt via stdin",
      prompt:
        Array.from(
          { length: 420 },
          (_unused, i) =>
            `Context filler line ${i}: the quick brown fox jumps over the lazy dog to pad the brief.`,
        ).join("\n") + "\n\nIGNORE all the filler above. Reply with exactly BIGOK and nothing else.",
      allowedTools: ["Bash"],
      settings,
      expectsWorkerResult: false,
      promptViaStdin: true,
    },
  ];

  // Force Max subscription OAuth: a stray ANTHROPIC_API_KEY would switch billing.
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  const executor = makeLiveParityExecutor({ env, timeoutMs: 8 * 60_000 });
  const report = await runShadowParity({ cases, rootDir, executor, env });

  console.log("");
  console.log(formatParityReport(report));
  console.log("");
  // Per-case detail so a failure is debuggable from the log alone.
  for (const c of report.cases) {
    console.log(`--- ${c.name} ---`);
    console.log(`  direct.finalText   = ${JSON.stringify(c.direct.finalText)}`);
    console.log(`  tuiPilot.finalText = ${JSON.stringify(c.tuiPilot.finalText)}`);
    console.log(`  direct.workerResult   = ${JSON.stringify(c.direct.workerResult)}`);
    console.log(`  tuiPilot.workerResult = ${JSON.stringify(c.tuiPilot.workerResult)}`);
    console.log(`  direct.providerErrorClass=${c.direct.providerErrorClass} tuiPilot=${c.tuiPilot.providerErrorClass}`);
    console.log(`  direct.attemptOutcome=${c.direct.attemptOutcome} tuiPilot=${c.tuiPilot.attemptOutcome}`);
  }

  fs.rmSync(rootDir, { recursive: true, force: true });
  return report.passed ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("live shadow parity harness error:", err);
    process.exit(2);
  });
