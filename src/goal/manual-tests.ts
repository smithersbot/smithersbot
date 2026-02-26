import { buildClaudeCodeEnv } from "./claude-code-env.js";
import { runCliProcess } from "./cli-process.js";
import { extractJson } from "./planner.js";
import { resolveClaudeBinary } from "./scout.js";
import type { GoalLlmClient, ManualTestSuggestion, PlanStep } from "./types.js";

const MANUAL_TESTS_SYSTEM_PROMPT = `You are a QA assistant that suggests only necessary MANUAL verification tests after an automated coding goal finishes.

You must only suggest tests for behavior the bot cannot verify automatically on its own, such as:
- Real Telegram or chat app interactions
- Real device behavior
- UI/visual formatting checks
- Multi-service integration that requires a live environment

Never suggest these:
- Re-running lint/build/test/CLI commands that were already executed
- Reading source files to verify code lines exist
- Verifying specific line numbers or code snippets manually
- Running commands that are listed as already completed in the prompt

If all relevant behavior was already verified automatically, return an empty tests array and a short message:
{
  "tests": [],
  "message": "All functionality was verified automatically"
}

Return ONLY JSON with this shape:
{
  "tests": [
    {
      "description": "Short human-friendly test name",
      "criticality": 1,
      "reason": "Why the bot could not verify this automatically",
      "detail": "**Step 1.** ...\\n**Step 2.** ...\\n**Step 3.** ..."
    }
  ]
}

Rules:
- description must be a concise phrase (for example: "Test Telegram message splitting"), not "Validate: ..." and not a pasted task summary.
- criticality must be an integer from 1 to 10 and should vary based on risk.
- reason should explain why manual verification is required.
- detail must be human-friendly numbered steps using "**Step 1.**", "**Step 2.**", etc.
- Do not include markdown fences or prose outside JSON.

Good example:
{
  "tests": [
    {
      "description": "Test Telegram message splitting",
      "criticality": 6,
      "reason": "Requires sending a real message through Telegram which the bot cannot do during automated testing",
      "detail": "**Step 1.** Restart the gateway: systemctl --user restart moltbot-gateway-dev.service\\n**Step 2.** Send a /new_goal command with a prompt longer than 4000 characters\\n**Step 3.** Verify the message is buffered and combined correctly\\n**Step 4.** Check that the goal is created with the full prompt text"
    }
  ]
}

Bad example (do NOT generate tests like these):
- "Run pnpm lint and verify 0 errors" - the bot already ran this
- "Open src/foo.ts and verify line 42 has the new threshold" - code inspection is pointless
- "Run pnpm vitest run src/foo.test.ts" - the bot already ran the tests`;

const DEFAULT_MIN_TESTS = 0;
const DEFAULT_MAX_TESTS = 5;
const MANUAL_TESTS_TIMEOUT_MS = 300_000;

export type GenerateManualTestsParams = {
  goal: string;
  steps: PlanStep[];
  client?: GoalLlmClient;
  minTests?: number;
  maxTests?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function collectText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((entry) => collectText(entry)).join("");
  if (!isRecord(value)) return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content))
    return value.content.map((entry) => collectText(entry)).join("");
  if (isRecord(value.message)) return collectText(value.message);
  if (isRecord(value.delta)) return collectText(value.delta);
  if (isRecord(value.item)) return collectText(value.item);
  return "";
}

function isTestEnv(): boolean {
  return (
    process.env.VITEST === "true" ||
    process.env.VITEST_POOL_ID != null ||
    process.env.VITEST_WORKER_ID != null ||
    process.env.NODE_ENV === "test"
  );
}

function buildCombinedManualTestsPrompt(userMessage: string): string {
  return ["## System Prompt", MANUAL_TESTS_SYSTEM_PROMPT, "", "## User Message", userMessage].join(
    "\n",
  );
}

function extractAssistantTextFromCliResult(rawStdout: string): string {
  const parsed = extractJson(rawStdout);
  const result = parsed.result;

  if (Array.isArray(result)) {
    for (let i = result.length - 1; i >= 0; i -= 1) {
      const entry = result[i];
      if (!isRecord(entry)) continue;
      const type = typeof entry.type === "string" ? entry.type.toLowerCase() : "";
      const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
      if (type.includes("assistant") || role === "assistant") {
        const assistantText =
          collectText(entry.message).trim() ||
          collectText(entry.content).trim() ||
          collectText(entry).trim();
        if (assistantText) return assistantText;
      }
    }

    for (let i = result.length - 1; i >= 0; i -= 1) {
      const text = collectText(result[i]).trim();
      if (text) return text;
    }
  }

  if (typeof result === "string" && result.trim()) return result.trim();
  if (result != null) {
    const text = collectText(result).trim();
    if (text) return text;
  }

  const fallbackText =
    collectText(parsed.message).trim() ||
    collectText(parsed.content).trim() ||
    collectText(parsed).trim();
  if (fallbackText) return fallbackText;

  throw new Error("Manual test CLI response did not include assistant text.");
}

async function generateManualTestsViaCli(userMessage: string): Promise<string> {
  const claudeBin = resolveClaudeBinary();
  if (!claudeBin) {
    throw new Error("claude binary not found on PATH");
  }

  const combinedPrompt = buildCombinedManualTestsPrompt(userMessage);
  const procResult = await runCliProcess({
    command: claudeBin,
    args: ["-p", "--output-format", "json", "--max-turns", "1"],
    cwd: process.cwd(),
    timeoutMs: MANUAL_TESTS_TIMEOUT_MS,
    stdin: combinedPrompt,
    env: buildClaudeCodeEnv("subscription"),
  });

  if (procResult.timedOut) {
    throw new Error(
      `Manual test generation timed out after ${(MANUAL_TESTS_TIMEOUT_MS / 1000).toFixed(0)} seconds.`,
    );
  }

  if ((procResult.exitCode && procResult.exitCode !== 0) || procResult.signal) {
    const detail =
      procResult.stderr.trim() ||
      procResult.stdout.trim() ||
      (procResult.signal
        ? `Manual test generation process terminated by ${procResult.signal}.`
        : "Manual test generation process failed.");
    throw new Error(`Manual test generation failed: ${detail}`);
  }

  return extractAssistantTextFromCliResult(procResult.stdout);
}

function clampCriticality(raw: unknown): number {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return 5;
  return Math.min(10, Math.max(1, Math.round(value)));
}

function normalizeManualTest(raw: unknown): ManualTestSuggestion | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;

  const description =
    typeof obj.description === "string"
      ? obj.description.trim()
      : typeof obj.name === "string"
        ? obj.name.trim()
        : "";
  if (!description) return undefined;

  const detail =
    typeof obj.detail === "string"
      ? obj.detail.trim()
      : typeof obj.instructions === "string"
        ? obj.instructions.trim()
        : description;
  const reason =
    typeof obj.reason === "string"
      ? obj.reason.trim()
      : typeof obj.why === "string"
        ? obj.why.trim()
        : "";

  return {
    description,
    criticality: clampCriticality(obj.criticality),
    ...(reason ? { reason } : {}),
    detail: detail || description,
  };
}

function buildFallbackDescription(stepDescription: string): string {
  const cleaned = stepDescription
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "");
  if (!cleaned) return "Test updated behavior";
  const withoutVerb = cleaned
    .replace(
      /^(implement|add|update|fix|refactor|improve|create|build|write|cover|document|set up|setup|configure|harden|optimize|adjust|change)\s+/i,
      "",
    )
    .trim();
  const phrase = withoutVerb || cleaned;
  if (/^test\b/i.test(phrase)) return phrase;
  return `Test ${phrase.charAt(0).toLowerCase()}${phrase.slice(1)}`;
}

function fallbackCriticality(index: number): number {
  return Math.max(3, 6 - index);
}

function buildFallbackDetail(step: PlanStep): string {
  const completionSummary = step.taskSummary?.trim().replace(/\s+/g, " ");
  const stepTwo = completionSummary
    ? `**Step 2.** Confirm this expected outcome: ${completionSummary}.`
    : "**Step 2.** Confirm the expected behavior and no regressions in related flows.";
  return `**Step 1.** Manually exercise the behavior described by "${step.description}".\n${stepTwo}`;
}

function buildFallbackTests(
  doneSteps: PlanStep[],
  needed: number,
  usedDescriptions: Set<string>,
): ManualTestSuggestion[] {
  const fallback: ManualTestSuggestion[] = [];
  for (const step of doneSteps) {
    if (fallback.length >= needed) break;
    const description = buildFallbackDescription(step.description);
    const key = description.toLowerCase();
    if (usedDescriptions.has(key)) continue;
    usedDescriptions.add(key);
    fallback.push({
      description,
      criticality: fallbackCriticality(fallback.length),
      reason: "Automated test generation returned fewer suggestions than expected.",
      detail: buildFallbackDetail(step),
    });
  }
  return fallback;
}

function buildManualTestsUserPrompt(goal: string, doneSteps: PlanStep[]): string {
  const lines: string[] = [`Goal: ${goal}`, "", "Completed steps:"];
  for (const step of doneSteps.slice(0, 10)) {
    lines.push(`- [${step.id}] ${step.description}`);
    if (step.taskSummary?.trim()) {
      lines.push(`  Completion summary: ${step.taskSummary.trim()}`);
    }
  }
  const automatedChecks = collectAutomatedChecks(doneSteps);
  lines.push("");
  lines.push("Automated checks already performed:");
  if (automatedChecks.length === 0) {
    lines.push("- None explicitly recorded in task summaries.");
  } else {
    for (const check of automatedChecks) {
      lines.push(`- ${check}`);
    }
  }
  lines.push("");
  lines.push("Generate only the minimum manual tests needed for behavior not covered above.");
  return lines.join("\n");
}

const COMMAND_HINT =
  /\b(?:pnpm|npm|bun|bunx|node|npx|vitest|jest|playwright|cypress|pytest|go test|cargo test|swift test|xcodebuild|gradle|mvn|tsc|eslint|oxlint|oxfmt|prettier)\b/i;
const CHECK_HINT =
  /\b(?:lint|build|typecheck|type-check|compile|test|tests|coverage|verified|verification|validate)\b/i;

function collectAutomatedChecks(doneSteps: PlanStep[]): string[] {
  const checks: string[] = [];
  const seen = new Set<string>();

  const pushUnique = (value: string) => {
    const normalized = value.trim().replace(/\s+/g, " ");
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    checks.push(normalized);
  };

  for (const step of doneSteps) {
    const summary = step.taskSummary?.trim();
    if (!summary) continue;
    const lines = summary.split("\n");
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const inlineCommandMatches = Array.from(line.matchAll(/`([^`]+)`/g), (match) =>
        match[1]?.trim(),
      ).filter((value): value is string => Boolean(value));
      for (const cmd of inlineCommandMatches) {
        if (COMMAND_HINT.test(cmd) || CHECK_HINT.test(cmd)) pushUnique(cmd);
      }

      const normalizedLine = line
        .replace(/^[-*]\s+/, "")
        .replace(/^\d+\.\s+/, "")
        .trim();
      if (!normalizedLine) continue;
      if (COMMAND_HINT.test(normalizedLine) || CHECK_HINT.test(normalizedLine)) {
        pushUnique(normalizedLine);
      }
    }
  }

  return checks.slice(0, 10);
}

export async function generateManualTests(
  params: GenerateManualTestsParams,
): Promise<ManualTestSuggestion[]> {
  const minTests = Math.max(0, params.minTests ?? DEFAULT_MIN_TESTS);
  const maxTests = Math.max(minTests, params.maxTests ?? DEFAULT_MAX_TESTS);
  const doneSteps = params.steps.filter((step) => (step.status ?? "done") === "done");
  if (doneSteps.length === 0) return [];

  const userMessage = buildManualTestsUserPrompt(params.goal, doneSteps);
  let modelResponseText: string;

  if (params.client) {
    const response = await params.client.complete({
      systemPrompt: MANUAL_TESTS_SYSTEM_PROMPT,
      userMessage,
      maxTokens: 900,
    });
    modelResponseText = response.text;
  } else {
    if (isTestEnv()) {
      throw new Error("Manual test generation requires an injected client in tests.");
    }
    modelResponseText = await generateManualTestsViaCli(userMessage);
  }

  const parsed = extractJson(modelResponseText);
  const rawTests = Array.isArray(parsed.tests)
    ? parsed.tests
    : Array.isArray(parsed.manualTests)
      ? parsed.manualTests
      : undefined;
  if (!rawTests) {
    throw new Error("Manual test response must contain a tests array.");
  }

  const suggestions: ManualTestSuggestion[] = [];
  const seen = new Set<string>();
  for (const entry of rawTests) {
    const normalized = normalizeManualTest(entry);
    if (!normalized) continue;
    const key = normalized.description.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push(normalized);
    if (suggestions.length >= maxTests) break;
  }

  if (suggestions.length < minTests) {
    const fallback = buildFallbackTests(doneSteps, minTests - suggestions.length, seen);
    suggestions.push(...fallback);
  }

  return suggestions.slice(0, maxTests);
}
