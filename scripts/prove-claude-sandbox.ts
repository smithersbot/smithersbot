/**
 * Granular, observable live proof of Claude Code's native sandbox for SmithersBot.
 *
 * Requires SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES=1. Each phase is its own Claude Code
 * process with a hard timeout enforced by killing the whole process group (so lingering
 * bwrap/socat children cannot wedge the proof). An INCONCLUSIVE or TIMEOUT phase is
 * retried once to absorb agentic/runtime variance.
 *
 * Phases (credential reads are deferred until the basics pass):
 *   1. auth            plain subscription auth (no sandbox)
 *   2. sandbox-basics  ONE sandbox call: harmless `echo` (startup) + README/.env.example
 *                      readable + repo .env.local / managed private env / symlink-escape
 *                      NOT readable. Bundled into one invocation because many sequential
 *                      sandbox spawns accumulate slowdown until later ones time out.
 *   3. deny-claude-auth  ~/.claude/.credentials.json NOT readable — gated on phase 2,
 *                        via `cat >/dev/null` (contents discarded; only the exit code is
 *                        read, which is non-zero when denied).
 *
 * Output is status-only: phase name, outcome, elapsed, and a classification. The
 * in-sandbox commands print only `<name>=<exit-code>` markers (computed at runtime via
 * $?, so a model that merely quotes the command cannot forge a marker) and never any
 * file, secret, env, or auth contents. If the model declines to run the credential
 * check, that phase is reported proof-harness-limited, not proven.
 *
 * Usage (from repo root):
 *   env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL \
 *     SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES=1 \
 *     node --import tsx scripts/prove-claude-sandbox.ts
 *
 * Exit codes: 0 = sandbox proven; 1 = a deny/allow phase FAILED (security); 2 = could
 * not prove (auth/startup blocked, a phase timed out/hung, or proof-harness-limited).
 */
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { resolvePrivateRoot } from "../src/config/managed-paths.js";
import { buildClaudeCodeSandboxLaunchConfig } from "../src/goal/backend-sandbox.js";
import { stripClaudeSubscriptionAuthEnv } from "../src/goal/claude-code-env.js";

const LIVE_PROBE_FLAG = "SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES";
const PHASE_TIMEOUT_MS = 55_000;
const AUTH_TIMEOUT_MS = 45_000;
const CLAUDE_AUTH_OK_REPLY = "claude-auth-ok";

type PhaseOutcome = "PASS" | "FAIL" | "TIMEOUT" | "INCONCLUSIVE" | "SKIPPED";

type PhaseResult = {
  name: string;
  outcome: PhaseOutcome;
  elapsedSeconds: number;
  classification: string;
};

function emit(line: string): void {
  process.stdout.write(`${line}\n`);
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Run `claude` for a single phase in its own process group with a hard timeout.
 * On timeout the entire group is SIGKILLed so lingering bwrap/socat children cannot
 * keep the proof hanging. Returns status only — callers never print captured output.
 */
function runClaudePhase(opts: {
  args: string[];
  input?: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  cwd: string;
}): Promise<{ timedOut: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("claude", opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: { timedOut: boolean; stdout: string; stderr: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // process group already gone
        }
      }
      finish({ timedOut: true, stdout, stderr });
    }, opts.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", () => finish({ timedOut: false, stdout, stderr }));
    child.on("close", () => finish({ timedOut: false, stdout, stderr }));
    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });
}

type PhaseEvaluation = { outcome: "PASS" | "FAIL" | "INCONCLUSIVE"; classification: string };

type PhaseSpec = {
  name: string;
  args: string[];
  input?: string;
  timeoutMs: number;
  /** True when the phase produced the expected success signal. */
  passed: (stdout: string) => boolean;
  /** True when the phase produced an explicit wrong/insecure signal. */
  failed: (stdout: string) => boolean;
  /** Optional richer evaluation (e.g. a multi-marker matrix) overriding passed/failed. */
  evaluate?: (stdout: string) => PhaseEvaluation;
  /** Credential phases are gated on prior passes and degrade to harness-limited. */
  credential?: boolean;
};

function buildBashPhaseInput(bashCommand: string): string {
  return [
    "You are running a sandbox self-test for security hardening of this repository.",
    "Use the Bash tool to run exactly this one command and reply with only its raw stdout.",
    "It reads no file contents — it prints only `<name>=<exit-code>` status markers:",
    "",
    bashCommand,
  ].join("\n");
}

function main(): Promise<number> {
  if (process.env[LIVE_PROBE_FLAG] !== "1") {
    emit("claude-live-sandbox: required");
    emit(`reason: set ${LIVE_PROBE_FLAG}=1 to run the granular live proof`);
    emit("exit: 2");
    return Promise.resolve(2);
  }

  const cwd = process.cwd();
  const env = stripClaudeSubscriptionAuthEnv(process.env);
  const launch = buildClaudeCodeSandboxLaunchConfig({
    workingDir: cwd,
    runId: `prove-claude-${Date.now()}`,
    purpose: "goal-worker",
  });
  const sandboxArgs = ["-p", ...launch.args, "--allowedTools", "Bash"];

  const repoEnvLocal = path.join(cwd, ".env.local");
  const privateEnv = path.join(resolvePrivateRoot(), "env", path.basename(path.dirname(cwd)), ".env");
  const claudeCreds = path.join(os.homedir(), ".claude", ".credentials.json");

  // Each check emits `<name>=<exit-code>` computed at runtime via $?. Because the digit
  // is produced only by ACTUAL execution, a model that merely quotes/echoes the command
  // (showing the literal "$?") cannot create a false marker — so a deny check can never
  // false-FAIL from command-quoting (a real harness bug in the prior PASS/FAIL form).
  // Both allow and deny use `cat >/dev/null` (contents discarded, never printed) and read
  // the EXIT code: a denied path makes cat exit non-zero. NB: `test -r` is the wrong check
  // here — Claude Code denies a file by mounting /dev/null over it, so `test -r` returns 0
  // (the empty mount is "readable") even though the secret content is gone; cat's exit code
  // correctly reports the deny (verified live with a non-secret canary file).
  const allowM = (name: string, target: string): string =>
    `cat ${shQuote(target)} >/dev/null 2>&1; echo ${name}=$?`;
  const denyM = (name: string, target: string): string =>
    `cat ${shQuote(target)} >/dev/null 2>&1; echo ${name}=$?`;
  const symlinkM = (name: string, target: string): string =>
    [
      "L=.smithersbot-proof-link",
      'rm -f "$L"',
      `ln -s ${shQuote(target)} "$L" 2>/dev/null`,
      'cat "$L" >/dev/null 2>&1',
      `echo ${name}=$?`,
      'rm -f "$L"',
    ].join("; ");

  const readMarker = (stdout: string, name: string): string | null => {
    const matched = stdout.match(new RegExp(`${name}=(\\d+)`));
    return matched ? (matched[1] ?? null) : null;
  };

  // ONE combined "basics" call (startup + allow + repo/private/symlink denies). Bundling
  // into a single sandbox invocation avoids the cumulative per-call slowdown that made 8
  // sequential sandbox spawns time out. Joined with "; " into a SINGLE-LINE command so the
  // Bash tool runs it atomically (a multi-line script was run/echoed only partially).
  // Credentials are intentionally NOT read here.
  const basicsCommand = [
    "true; echo M_startup=$?",
    allowM("M_readme", "README.md"),
    allowM("M_envexample", ".env.example"),
    denyM("M_envlocal", repoEnvLocal),
    denyM("M_private", privateEnv),
    symlinkM("M_symlink", privateEnv),
  ].join("; ");

  const evaluateBasics = (stdout: string): PhaseEvaluation => {
    const allow = ["M_startup", "M_readme", "M_envexample"] as const;
    const deny = ["M_envlocal", "M_private", "M_symlink"] as const;
    const vals = Object.fromEntries(
      [...allow, ...deny].map((n) => [n, readMarker(stdout, n)]),
    ) as Record<string, string | null>;
    const present = Object.values(vals).filter((v) => v !== null).length;
    if (present < allow.length + deny.length) {
      return {
        outcome: "INCONCLUSIVE",
        classification: `proof-harness-limited (model emitted ${present}/${allow.length + deny.length} markers)`,
      };
    }
    const allowOk = allow.every((n) => vals[n] === "0");
    const denyOk = deny.every((n) => vals[n] !== "0");
    if (allowOk && denyOk) {
      return { outcome: "PASS", classification: "startup+allows readable, repo/private/symlink denied" };
    }
    const bad = [
      ...allow.filter((n) => vals[n] !== "0").map((n) => `${n}(allow) not readable`),
      ...deny.filter((n) => vals[n] === "0").map((n) => `${n}(deny) READABLE`),
    ].join("; ");
    return { outcome: "FAIL", classification: `deny/allow mismatch: ${bad}` };
  };

  const denyPassed = (stdout: string): boolean => {
    const code = readMarker(stdout, "M_creds");
    return code !== null && code !== "0";
  };
  const denyFailed = (stdout: string): boolean => readMarker(stdout, "M_creds") === "0";

  const phases: PhaseSpec[] = [
    {
      name: "auth",
      args: ["-p", `Reply exactly: ${CLAUDE_AUTH_OK_REPLY}`],
      timeoutMs: AUTH_TIMEOUT_MS,
      passed: (stdout) => stdout.trim() === CLAUDE_AUTH_OK_REPLY,
      failed: (stdout) => stdout.length > 0 && stdout.trim() !== CLAUDE_AUTH_OK_REPLY,
    },
    {
      name: "sandbox-basics",
      args: sandboxArgs,
      input: buildBashPhaseInput(basicsCommand),
      timeoutMs: PHASE_TIMEOUT_MS,
      passed: (stdout) => evaluateBasics(stdout).outcome === "PASS",
      failed: (stdout) => evaluateBasics(stdout).outcome === "FAIL",
      evaluate: evaluateBasics,
    },
    {
      name: "deny-claude-auth",
      args: sandboxArgs,
      input: buildBashPhaseInput(denyM("M_creds", claudeCreds)),
      timeoutMs: PHASE_TIMEOUT_MS,
      passed: denyPassed,
      failed: denyFailed,
      credential: true,
    },
  ];

  return runPhases(phases, { env, cwd });
}

async function runPhases(
  phases: PhaseSpec[],
  ctx: { env: NodeJS.ProcessEnv; cwd: string },
): Promise<number> {
  const total = phases.length;
  const results: PhaseResult[] = [];
  let priorAllPassed = true;
  let hung = false;

  for (let index = 0; index < phases.length; index++) {
    const phase = phases[index];
    if (phase === undefined) continue;
    const label = `[phase ${index + 1}/${total}] ${phase.name}`;

    if (phase.credential && !priorAllPassed) {
      emit(`${label}: SKIPPED (a prior phase did not pass; not attempting credential read)`);
      results.push({
        name: phase.name,
        outcome: "SKIPPED",
        elapsedSeconds: 0,
        classification: "skipped-prior-not-passed",
      });
      continue;
    }

    // Up to 3 attempts: an INCONCLUSIVE (model emitted no marker) or TIMEOUT
    // (intermittent sandbox-startup slowdown) run is retried to absorb agentic/runtime
    // variance; PASS/FAIL are conclusive and stop early.
    const maxAttempts = 3;
    let outcome: PhaseOutcome = "INCONCLUSIVE";
    let classification = "no-result-signal";
    let elapsedSeconds = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const suffix = attempt > 1 ? ` (retry ${attempt - 1})` : "";
      emit(`${label}: running${suffix} (timeout=${Math.round(phase.timeoutMs / 1000)}s)`);
      const startedAt = Date.now();
      const run = await runClaudePhase({
        args: phase.args,
        input: phase.input,
        timeoutMs: phase.timeoutMs,
        env: ctx.env,
        cwd: ctx.cwd,
      });
      elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
      if (run.timedOut) {
        outcome = "TIMEOUT";
        classification = "timeout/environment-blocked";
      } else if (phase.evaluate) {
        const evaluated = phase.evaluate(run.stdout);
        outcome = evaluated.outcome;
        classification = evaluated.classification;
      } else if (phase.passed(run.stdout)) {
        outcome = "PASS";
        classification = "ok";
      } else if (phase.failed(run.stdout)) {
        outcome = "FAIL";
        classification = phase.credential ? "credential-path-readable" : "deny-allow-mismatch";
      } else {
        outcome = "INCONCLUSIVE";
        classification = phase.credential
          ? "proof-harness-limited (model declined the credential check)"
          : "proof-harness-limited (model emitted no result marker)";
      }
      if (outcome === "PASS" || outcome === "FAIL") break;
    }

    emit(`${label}: ${outcome} (${elapsedSeconds}s) — ${classification}`);
    results.push({ name: phase.name, outcome, elapsedSeconds, classification });

    if (outcome !== "PASS") priorAllPassed = false;
    if (outcome === "TIMEOUT") {
      hung = true;
      emit(`ABORT: phase "${phase.name}" hung; stopping (remaining phases not run).`);
      break;
    }
  }

  emit("");
  emit("=== phase summary ===");
  for (const result of results) {
    emit(`${result.name}: ${result.outcome} (${result.elapsedSeconds}s) [${result.classification}]`);
  }

  const ran = results.filter((r) => r.outcome !== "SKIPPED");
  const proven = ran.length === total && ran.every((r) => r.outcome === "PASS");
  const securityFail = results.some((r) => r.outcome === "FAIL");
  const anyHung = hung || results.some((r) => r.outcome === "TIMEOUT");

  emit("");
  if (proven) {
    emit("claude-live-sandbox: supported");
    emit("Claude Code sandboxing proven: yes");
    emit("exit: 0");
    return 0;
  }
  emit("claude-live-sandbox: not-proven");
  emit("Claude Code sandboxing proven: no");
  const firstBlocker = results.find((r) => r.outcome !== "PASS");
  if (firstBlocker) {
    emit(`blocking-phase: ${firstBlocker.name}`);
    emit(`classification: ${firstBlocker.classification}`);
  }
  // Security failure (a deny read succeeded) is exit 1; environment/hang/harness-limited is exit 2.
  const exitCode = securityFail && !anyHung ? 1 : 2;
  emit(`exit: ${exitCode}`);
  return exitCode;
}

main().then((code) => process.exit(code));
