import { createGoalLlmClient } from "./llm-client.js";
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
      "detail": "Step 1. ...\\nStep 2. ...\\nStep 3. ..."
    }
  ]
}

Rules:
- description must be a concise phrase (for example: "Test Telegram message splitting"), not "Validate: ..." and not a pasted task summary.
- criticality must be an integer from 1 to 10 and should vary based on risk.
- reason should explain why manual verification is required.
- detail must be human-friendly numbered steps using "Step 1.", "Step 2.", etc.
- Do not include markdown fences or prose outside JSON.

Good example:
{
  "tests": [
    {
      "description": "Test Telegram message splitting",
      "criticality": 6,
      "reason": "Requires sending a real message through Telegram which the bot cannot do during automated testing",
      "detail": "Step 1. Restart the gateway: systemctl --user restart moltbot-gateway-dev.service\\nStep 2. Send a /new_goal command with a prompt longer than 4000 characters\\nStep 3. Verify the message is buffered and combined correctly\\nStep 4. Check that the goal is created with the full prompt text"
    }
  ]
}

Bad example (do NOT generate tests like these):
- "Run pnpm lint and verify 0 errors" - the bot already ran this
- "Open src/foo.ts and verify line 42 has the new threshold" - code inspection is pointless
- "Run pnpm vitest run src/foo.test.ts" - the bot already ran the tests`;

const DEFAULT_MIN_TESTS = 0;
const DEFAULT_MAX_TESTS = 5;

export type GenerateManualTestsParams = {
  goal: string;
  steps: PlanStep[];
  client?: GoalLlmClient;
  minTests?: number;
  maxTests?: number;
};

function extractJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to tolerant extraction.
  }

  const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(trimmed);
  if (fenceMatch?.[1]) {
    const parsed = JSON.parse(fenceMatch[1].trim());
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Manual test response is not a JSON object.");
    }
    return parsed as Record<string, unknown>;
  }

  const firstBrace = trimmed.indexOf("{");
  if (firstBrace >= 0) {
    const parsed = JSON.parse(trimmed.slice(firstBrace));
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Manual test response is not a JSON object.");
    }
    return parsed as Record<string, unknown>;
  }

  throw new Error("Failed to parse manual test JSON from model response.");
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
    ? `Step 2. Confirm this expected outcome: ${completionSummary}.`
    : "Step 2. Confirm the expected behavior and no regressions in related flows.";
  return `Step 1. Manually exercise the behavior described by "${step.description}".\n${stepTwo}`;
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

function resolveClient(client: GoalLlmClient | undefined): GoalLlmClient {
  if (client) return client;
  const isTestEnv =
    process.env.VITEST === "true" ||
    process.env.VITEST_POOL_ID != null ||
    process.env.VITEST_WORKER_ID != null ||
    process.env.NODE_ENV === "test";
  if (isTestEnv) {
    throw new Error("Manual test generation requires an injected client in tests.");
  }
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required to generate manual tests.");
  }
  return createGoalLlmClient({ apiKey });
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

  const client = resolveClient(params.client);
  const response = await client.complete({
    systemPrompt: MANUAL_TESTS_SYSTEM_PROMPT,
    userMessage: buildManualTestsUserPrompt(params.goal, doneSteps),
    maxTokens: 900,
  });

  const parsed = extractJsonObject(response.text);
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
