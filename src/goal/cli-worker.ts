// CLI worker execution for /goal — runs steps via Codex CLI or Claude Code.

import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { GoalBackendId, GoalWorkerOutput, BackendTaskResult } from "./backend-types.js";
import { GOAL_WORKER_OUTPUT_SCHEMA as SCHEMA } from "./backend-types.js";
import type { CapabilityPolicy, EffectiveCapabilities, HardDeny } from "./capability-types.js";
import type { PlanStep, Plan } from "./types.js";
import { resolveRunDir } from "./run-store.js";
import { formatPlanAsContext } from "./planner.js";

// --- Constants ---

const HANG_TIMEOUT_MS = 120_000; // 120s no-output → kill
const SIGTERM_GRACE_MS = 5_000;
const MAX_TURNS_DEFAULT = 3;
const CLI_TIMEOUT_MS = 600_000; // 10 min per invocation

// --- Public API ---

export type CliWorkerParams = {
  backend: GoalBackendId;
  step: PlanStep;
  plan: Plan;
  goal: string;
  workingDir: string;
  runId: string;
  effective: EffectiveCapabilities;
  policy: CapabilityPolicy;
  maxTurnsPerTask?: number;
  model?: string;
  completedSummaries?: Array<{ id: string; summary: string }>;
  onProgress?: (text: string) => void;
  /** User's answer when resuming a previously-blocked step. */
  resumeAnswer?: string;
  /** The question the step asked before blocking. */
  resumeQuestion?: string;
};

/**
 * Execute a goal step using a CLI worker (Codex or Claude Code).
 *
 * Runs up to maxTurnsPerTask invocations. Each invocation = 1 turn.
 * Returns structured output or null if the worker didn't produce conforming JSON.
 */
export async function executeTaskWithCliWorker(
  params: CliWorkerParams,
): Promise<BackendTaskResult> {
  const {
    backend,
    step,
    plan,
    goal,
    workingDir,
    runId,
    effective,
    policy,
    maxTurnsPerTask = MAX_TURNS_DEFAULT,
    model,
    completedSummaries,
    onProgress,
    resumeAnswer,
    resumeQuestion,
  } = params;

  const workerDir = resolveWorkerDir(runId, step.id);
  fs.mkdirSync(workerDir, { recursive: true });

  let lastStdout = "";
  let lastStderr = "";

  for (let turn = 1; turn <= maxTurnsPerTask; turn++) {
    onProgress?.(`  [cli-worker:${backend}] turn ${turn}/${maxTurnsPerTask}`);

    const prompt =
      turn === 1
        ? buildCliWorkerPrompt({
            step,
            plan,
            goal,
            effective,
            completedSummaries,
            resumeAnswer,
            resumeQuestion,
          })
        : buildContinueWorkerPrompt(step, turn, maxTurnsPerTask, lastStdout);

    // Write artifacts
    const schemaPath = writeWorkerSchema(workerDir);
    const capsFilePath = writeCapsFile(effective, workerDir);

    const args = buildCliArgs({
      backend,
      prompt,
      workingDir,
      schemaPath,
      capsFilePath,
      effective,
      model,
    });

    const command = backend === "codex" ? "codex" : "claude";
    const { stdout, stderr, timedOut } = await runCliProcess(command, args, workingDir);

    lastStdout = stdout;
    lastStderr = stderr;

    // Write turn artifacts
    writeArtifact(workerDir, turn, "stdout", stdout);
    writeArtifact(workerDir, turn, "stderr", stderr);

    if (timedOut) {
      onProgress?.(`  [cli-worker] Hang detected (no output for ${HANG_TIMEOUT_MS / 1000}s)`);
      return {
        output: {
          status: "blocked",
          question: `CLI worker appeared to hang (no output for ${HANG_TIMEOUT_MS / 1000}s). Possible interactive prompt or deadlock.`,
        },
        turnsUsed: turn,
        rawStdout: stdout,
        rawStderr: stderr,
      };
    }

    // Post-check for hard deny evidence
    const denyEvidence = postCheckForHardDenyEvidence(stdout, stderr, policy);
    if (denyEvidence.length > 0) {
      const ids = denyEvidence.map((d) => d.id).join(", ");
      onProgress?.(`  [cli-worker] Hard deny evidence: ${ids}`);
      return {
        output: {
          status: "blocked",
          question: `Output indicates a hard-denied action was attempted: ${ids}`,
          missingCapabilities: denyEvidence.map((d) => d.id),
        },
        turnsUsed: turn,
        rawStdout: stdout,
        rawStderr: stderr,
      };
    }

    // Parse structured output
    const parsed = parseStructuredOutput(stdout, backend);
    if (parsed) {
      const validated = validateWorkerOutput(parsed);
      if (validated) {
        writeArtifact(workerDir, turn, "result", JSON.stringify(validated, null, 2));
        return {
          output: validated,
          turnsUsed: turn,
          rawStdout: stdout,
          rawStderr: stderr,
        };
      }
    }

    // No valid output — continue to next turn
    onProgress?.(`  [cli-worker] No structured output, continuing...`);
  }

  // Turn limit exhausted
  return {
    output: null,
    turnsUsed: maxTurnsPerTask,
    rawStdout: lastStdout,
    rawStderr: lastStderr,
  };
}

// --- Prompt building ---

export function buildCliWorkerPrompt(params: {
  step: PlanStep;
  plan: Plan;
  goal: string;
  effective: EffectiveCapabilities;
  completedSummaries?: Array<{ id: string; summary: string }>;
  resumeAnswer?: string;
  resumeQuestion?: string;
}): string {
  const { step, plan, goal, effective, completedSummaries, resumeAnswer, resumeQuestion } = params;
  const lines: string[] = [];

  lines.push(`GOAL: ${goal}`);
  lines.push("");
  lines.push("PLAN CONTEXT:");
  lines.push(formatPlanAsContext(plan));
  lines.push("");

  if (completedSummaries && completedSummaries.length > 0) {
    lines.push("COMPLETED TASKS:");
    for (const { id, summary } of completedSummaries) {
      lines.push(`- ${id}: ${summary}`);
    }
    lines.push("");
  }

  // Resume context: include user's answer from previous block
  if (resumeAnswer) {
    lines.push("RESUME CONTEXT:");
    lines.push(`You previously asked: ${resumeQuestion ?? "a question"}`);
    lines.push(`The user answered: ${resumeAnswer}`);
    lines.push("Use this information to continue and complete the task.");
    lines.push("");
  }

  lines.push(`YOUR TASK: ${step.description}`);
  lines.push(`Task ID: ${step.id}`);
  if (step.dependsOn.length > 0) {
    lines.push(`Dependencies completed: ${step.dependsOn.join(", ")}`);
  }
  lines.push("");

  lines.push("CAPABILITY BOUNDS:");
  for (const grant of effective.grants) {
    const details: string[] = [];
    if (grant.pathGlobs) details.push(`paths: ${grant.pathGlobs.join(", ")}`);
    if (grant.commandPatterns)
      details.push(`commands: ${grant.commandPatterns.slice(0, 5).join(", ")}...`);
    if (grant.domainAllowlist) details.push(`domains: ${grant.domainAllowlist.join(", ")}`);
    lines.push(`- ${grant.id}${details.length ? ` (${details.join("; ")})` : ""}`);
  }
  lines.push("HARD DENIES (never do these):");
  for (const deny of effective.denies) {
    lines.push(`- ${deny.id}: ${deny.reason}`);
  }
  lines.push("");

  lines.push("OUTPUT FORMAT:");
  lines.push("When you are done, output a JSON object with one of these shapes:");
  lines.push('  Complete: { "status": "complete", "summary": "<brief summary>" }');
  lines.push('  Blocked:  { "status": "blocked", "question": "<what you need>" }');
  lines.push(
    '  Failed:   { "status": "failed", "reason": "...", "whatTried": "...", "errorType": "...", "suggestedNext": "...", "needsRevert": false }',
  );

  return lines.join("\n");
}

function buildContinueWorkerPrompt(
  step: PlanStep,
  turn: number,
  maxTurns: number,
  priorOutput: string,
): string {
  const lines: string[] = [];
  lines.push(`Continue working on task ${step.id}: ${step.description}`);
  lines.push(`Turn ${turn}/${maxTurns}. Focus on completing the task.`);
  lines.push("");
  if (priorOutput) {
    const truncated =
      priorOutput.length > 2000 ? priorOutput.slice(-2000) + "\n...(truncated)" : priorOutput;
    lines.push("PRIOR OUTPUT (last turn):");
    lines.push(truncated);
    lines.push("");
  }
  lines.push("Remember to output the JSON result object when done.");
  return lines.join("\n");
}

// --- Allowed tools list generation (for Claude Code --allowedTools) ---

/** Convert EffectiveCapabilities into Claude Code --allowedTools patterns. */
export function buildAllowedToolsList(effective: EffectiveCapabilities): string[] {
  // Baseline tools always available
  const tools: string[] = ["Read", "Edit", "Write", "Glob", "Grep"];

  const grantIds = new Set(effective.grants.map((g) => g.id));

  // exec.safe → standard build/test/lint commands
  if (grantIds.has("exec.safe")) {
    tools.push(
      "Bash(pnpm test*)",
      "Bash(pnpm lint*)",
      "Bash(pnpm build*)",
      "Bash(pnpm format*)",
      "Bash(npm test*)",
      "Bash(npm run *)",
      "Bash(bun test*)",
      "Bash(bun run *)",
      "Bash(node *)",
      "Bash(tsc *)",
      "Bash(vitest *)",
      "Bash(git status*)",
      "Bash(git diff*)",
      "Bash(git log*)",
      "Bash(git add*)",
      "Bash(git commit*)",
      "Bash(git branch*)",
      "Bash(git show*)",
      "Bash(ls *)",
      "Bash(find *)",
      "Bash(grep *)",
      "Bash(mkdir *)",
    );
  }

  // exec.install_deps → package install commands
  if (grantIds.has("exec.install_deps")) {
    tools.push(
      "Bash(npm install*)",
      "Bash(pnpm install*)",
      "Bash(bun install*)",
      "Bash(pip install*)",
      "Bash(yarn add*)",
    );
  }

  // git.push_private → git push
  if (grantIds.has("git.push_private")) {
    tools.push("Bash(git push*)");
  }

  // network.read_only or network.registry_only → curl/wget
  if (grantIds.has("network.read_only") || grantIds.has("network.registry_only")) {
    tools.push("Bash(curl *)", "Bash(wget *)");
  }

  return tools;
}

// --- Schema / caps file writing ---

/** Write the GoalWorkerOutput JSON Schema to disk. Returns the file path. */
export function writeWorkerSchema(dir: string): string {
  const filePath = path.join(dir, "output-schema.json");
  fs.writeFileSync(filePath, JSON.stringify(SCHEMA, null, 2), "utf8");
  return filePath;
}

/** Write capability bounds text to a file for --append-system-prompt-file. Returns the path. */
export function writeCapsFile(effective: EffectiveCapabilities, dir: string): string {
  const filePath = path.join(dir, "capability-bounds.txt");
  const lines: string[] = ["CAPABILITY BOUNDS (enforced):"];
  for (const grant of effective.grants) {
    lines.push(`- ALLOWED: ${grant.id}`);
  }
  for (const deny of effective.denies) {
    lines.push(`- DENIED: ${deny.id} — ${deny.reason}`);
  }
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
  return filePath;
}

// --- Output parsing + validation ---

/**
 * Parse structured JSON output from CLI stdout.
 *
 * Codex: output is the last JSON object in stdout.
 * Claude Code: --output-format json wraps in a response object; extract result from content.
 */
export function parseStructuredOutput(
  stdout: string,
  backend: GoalBackendId,
): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  if (backend === "claude_code") {
    return parseClaudeCodeOutput(trimmed);
  }
  // Codex: try to parse the last JSON object from output
  return parseLastJsonObject(trimmed);
}

function parseClaudeCodeOutput(text: string): Record<string, unknown> | null {
  // Claude Code --output-format json returns a JSON object with a "result" field
  // containing the assistant's text response. We need to find our GoalWorkerOutput
  // JSON within that text.
  try {
    const outer = JSON.parse(text);
    if (typeof outer === "object" && outer !== null) {
      // Try to extract from result text (Claude Code wraps the response)
      const resultText =
        typeof outer.result === "string"
          ? outer.result
          : typeof outer.content === "string"
            ? outer.content
            : null;
      if (resultText) {
        const inner = parseLastJsonObject(resultText);
        if (inner) return inner;
      }
      // Maybe the outer object itself is our output
      if ("status" in outer) return outer as Record<string, unknown>;
    }
  } catch {
    // Not valid JSON at top level; try to find embedded JSON
  }
  return parseLastJsonObject(text);
}

function parseLastJsonObject(text: string): Record<string, unknown> | null {
  // Find the last JSON object in the text (scan backwards for })
  let depth = 0;
  let end = -1;
  let start = -1;

  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "}" && end === -1) {
      end = i;
      depth = 1;
    } else if (end !== -1) {
      if (ch === "}") depth++;
      if (ch === "{") depth--;
      if (depth === 0) {
        start = i;
        break;
      }
    }
  }

  if (start === -1 || end === -1) return null;

  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not valid JSON
  }
  return null;
}

/**
 * Validate parsed JSON against GoalWorkerOutput type.
 * Returns the validated output or null if validation fails.
 */
export function validateWorkerOutput(parsed: Record<string, unknown>): GoalWorkerOutput | null {
  const status = parsed.status;
  if (typeof status !== "string") return null;

  if (status === "complete") {
    if (typeof parsed.summary !== "string") return null;
    return { status: "complete", summary: parsed.summary };
  }

  if (status === "blocked") {
    if (typeof parsed.question !== "string") return null;
    const result: GoalWorkerOutput = { status: "blocked", question: parsed.question };
    if (Array.isArray(parsed.missingCapabilities)) {
      const caps = parsed.missingCapabilities.filter((c): c is string => typeof c === "string");
      if (caps.length > 0) {
        (
          result as { status: "blocked"; question: string; missingCapabilities: string[] }
        ).missingCapabilities = caps;
      }
    }
    return result;
  }

  if (status === "failed") {
    if (typeof parsed.reason !== "string") return null;
    if (typeof parsed.whatTried !== "string") return null;
    if (typeof parsed.errorType !== "string") return null;
    if (typeof parsed.suggestedNext !== "string") return null;
    if (typeof parsed.needsRevert !== "boolean") return null;
    return {
      status: "failed",
      reason: parsed.reason,
      whatTried: parsed.whatTried,
      errorType: parsed.errorType,
      suggestedNext: parsed.suggestedNext,
      needsRevert: parsed.needsRevert,
    };
  }

  return null;
}

// --- Post-check for hard deny evidence ---

/**
 * Scan stdout/stderr for evidence that a hard-denied action was attempted.
 * Returns matching hard deny entries.
 *
 * Only matches "DENIED: <reason>" markers emitted by the enforcement layer,
 * not arbitrary mentions of deny patterns in the agent's analytical text.
 * This prevents false positives when the agent writes about security features
 * (e.g. documenting that "sudo is not allowed" shouldn't trigger the sudo deny).
 */
export function postCheckForHardDenyEvidence(
  stdout: string,
  stderr: string,
  policy: CapabilityPolicy,
): HardDeny[] {
  const combined = `${stdout}\n${stderr}`;
  const matches: HardDeny[] = [];

  for (const deny of policy.hardDenies) {
    // Look for enforcement-layer DENIED markers that reference this deny's reason
    const reasonEscaped = deny.reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`DENIED:\\s*${reasonEscaped}`, "i");
    if (re.test(combined)) {
      matches.push(deny);
    }
  }

  return matches;
}

// --- CLI process execution ---

function buildCliArgs(params: {
  backend: GoalBackendId;
  prompt: string;
  workingDir: string;
  schemaPath: string;
  capsFilePath: string;
  effective: EffectiveCapabilities;
  model?: string;
}): string[] {
  const { backend, prompt, workingDir, schemaPath, capsFilePath, effective, model } = params;
  const grantIds = new Set(effective.grants.map((g) => g.id));

  if (backend === "codex") {
    const args = [
      "exec",
      "--json",
      "--ask-for-approval",
      "never",
      "--sandbox",
      "workspace-write",
      "--output-schema",
      schemaPath,
      "--cd",
      workingDir,
    ];

    // Network gating: only enable when capability is granted
    if (
      grantIds.has("exec.install_deps") ||
      grantIds.has("network.registry_only") ||
      grantIds.has("network.read_only")
    ) {
      args.push("-c", "net.allowed=true");
    }

    if (model) args.push("--model", model);
    args.push(prompt);
    return args;
  }

  // Claude Code
  const allowedTools = buildAllowedToolsList(effective);
  const args = [
    "-p",
    "--output-format",
    "json",
    "--allowedTools",
    allowedTools.join(","),
    "--append-system-prompt-file",
    capsFilePath,
  ];
  if (model) args.push("--model", model);
  args.push(prompt);
  return args;
}

/**
 * Spawn a CLI process with hang detection.
 * stdin is set to "ignore" (no TTY, no interactive input).
 */
async function runCliProcess(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let lastActivity = Date.now();
    let killed = false;

    const proc: ChildProcess = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      lastActivity = Date.now();
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      lastActivity = Date.now();
    });

    // Hang detection: check for inactivity
    const hangCheck = setInterval(() => {
      if (Date.now() - lastActivity > HANG_TIMEOUT_MS && !killed) {
        killed = true;
        timedOut = true;
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, SIGTERM_GRACE_MS);
      }
    }, 10_000);

    // Hard timeout
    const hardTimeout = setTimeout(() => {
      if (!killed) {
        killed = true;
        timedOut = true;
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, SIGTERM_GRACE_MS);
      }
    }, CLI_TIMEOUT_MS);

    proc.on("close", () => {
      clearInterval(hangCheck);
      clearTimeout(hardTimeout);
      resolve({ stdout, stderr, timedOut });
    });

    proc.on("error", (err) => {
      clearInterval(hangCheck);
      clearTimeout(hardTimeout);
      stderr += `\nProcess error: ${err.message}`;
      resolve({ stdout, stderr, timedOut });
    });
  });
}

// --- Artifact helpers ---

function resolveWorkerDir(runId: string, stepId: string): string {
  return path.join(resolveRunDir(runId), "workers", stepId);
}

function writeArtifact(workerDir: string, turn: number, suffix: string, content: string): void {
  try {
    const filePath = path.join(workerDir, `turn-${turn}.${suffix}.txt`);
    fs.writeFileSync(filePath, content, "utf8");
  } catch {
    // Best-effort
  }
}
