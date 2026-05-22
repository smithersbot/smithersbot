/**
 * Host-side live proof for Claude Code's native sandbox deny/allow matrix.
 *
 * Requires SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES=1. Drives the real Claude Code
 * CLI through the SmithersBot-generated fail-closed settings (the same shape the
 * goal worker uses) and reports ONLY status / exit code / keyword booleans —
 * never any file, secret, env, or auth contents. The probe itself redirects every
 * read to /dev/null, so no contents can leak through stdout either.
 *
 * Usage (from the repo root):
 *   SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES=1 node --import tsx scripts/prove-claude-sandbox.ts
 *
 * Exit codes: 0 = sandbox proven (supported); 1 = probe failed; 2 = could not run
 * (flag missing or environment-blocked: Claude not installed/logged-in, missing
 * bwrap/socat, or a bubblewrap startup error).
 */
import process from "node:process";
import {
  claudeCodeNativeSandboxStatus,
  runClaudeSubscriptionAuthDifferentialProbes,
} from "../src/goal/backend-sandbox.js";

const LIVE_PROBE_FLAG = "SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES";

function emit(line: string): void {
  process.stdout.write(`${line}\n`);
}

function main(): number {
  if (process.env[LIVE_PROBE_FLAG] !== "1") {
    emit("claude-live-sandbox: required");
    emit(`reason: set ${LIVE_PROBE_FLAG}=1 to run the live deny/allow probe`);
    emit("exit: 2");
    return 2;
  }

  const authReport = runClaudeSubscriptionAuthDifferentialProbes({
    workingDir: process.cwd(),
    runId: `prove-claude-auth-${Date.now()}`,
    purpose: "goal-worker",
    env: process.env,
  });
  emit(`claude-auth-probes: ${authReport.ok ? "passed" : "failed"}`);
  emit(`claude-auth-blocker: ${authReport.blocker}`);
  for (const result of authReport.results) {
    emit(`claude-auth-probe ${result.id}: ok=${result.ok} blocker=${result.blocker}`);
  }
  if (!authReport.ok) {
    emit("claude-live-sandbox: environment-blocked");
    emit("exit: 2");
    return 2;
  }

  const status = claudeCodeNativeSandboxStatus({
    workingDir: process.cwd(),
    runId: `prove-claude-${Date.now()}`,
    purpose: "goal-worker",
    env: process.env,
  });

  if (status.supported) {
    emit("claude-live-sandbox: supported");
    emit(`claude-version: ${status.version}`);
    emit(`settings-path: ${status.settingsPath}`);
    emit(
      "private-env-blocked=true repo-env-local-blocked=true symlink-escape-blocked=true claude-auth-path-blocked=true",
    );
    emit("readme-allowed=true env-example-allowed=true");
    emit("exit: 0");
    return 0;
  }

  // "environment-blocked" = the probe could not actually exercise the sandbox
  // (Claude missing/not-logged-in, missing host prereq, or a bwrap startup error).
  // "failed" = Claude ran but the deny/allow matrix did not pass.
  const environmentBlocked =
    status.blocker === "claude-not-found" ||
    status.blocker === "missing-host-prerequisite" ||
    status.blocker === "operator-action-required" ||
    status.blocker === "live-probe-required" ||
    status.blocker === "settings-generation-failed";
  const exitCode = environmentBlocked ? 2 : 1;
  emit(`claude-live-sandbox: ${environmentBlocked ? "environment-blocked" : "failed"}`);
  emit(`blocker: ${status.blocker}`);
  emit(`reason: ${status.reason}`);
  if (status.operatorCommand) emit(`operator-command: ${status.operatorCommand}`);
  // Intentionally never prints status.details (may include raw probe stdout).
  emit(`exit: ${exitCode}`);
  return exitCode;
}

process.exit(main());
