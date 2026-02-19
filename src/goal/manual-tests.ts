import { createGoalLlmClient } from "./llm-client.js";
import type { GoalLlmClient, ManualTestSuggestion, PlanStep } from "./types.js";

const MANUAL_TESTS_SYSTEM_PROMPT = `You are a QA assistant. Suggest high-value MANUAL tests a user should run after an automated coding goal finishes.

Return ONLY JSON with this shape:
{
  "tests": [
    {
      "description": "Short one-line test name",
      "criticality": 1,
      "detail": "What to do, expected result, and what failure means"
    }
  ]
}

Rules:
- Return 3-5 tests.
- criticality must be an integer from 1 to 10.
- Prioritize user-facing behavior, regressions, and edge cases.
- Keep description concise and actionable.
- Detail must be specific enough for a human to run manually.
- Do not include markdown fences or prose outside JSON.`;

const DEFAULT_MIN_TESTS = 3;
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

  return {
    description,
    criticality: clampCriticality(obj.criticality),
    detail: detail || description,
  };
}

function buildFallbackTests(
  doneSteps: PlanStep[],
  needed: number,
  usedDescriptions: Set<string>,
): ManualTestSuggestion[] {
  const fallback: ManualTestSuggestion[] = [];
  for (const step of doneSteps) {
    if (fallback.length >= needed) break;
    const description = `Validate: ${step.description}`;
    const key = description.toLowerCase();
    if (usedDescriptions.has(key)) continue;
    usedDescriptions.add(key);
    fallback.push({
      description,
      criticality: 7,
      detail:
        `Manually exercise the behavior changed by "${step.description}". ` +
        `Confirm expected output and no regressions in related flows.`,
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
  lines.push("");
  lines.push(
    "Generate manual verification tests based on the completed work. Focus on high-risk paths first.",
  );
  return lines.join("\n");
}

export async function generateManualTests(
  params: GenerateManualTestsParams,
): Promise<ManualTestSuggestion[]> {
  const minTests = Math.max(1, params.minTests ?? DEFAULT_MIN_TESTS);
  const maxTests = Math.max(minTests, params.maxTests ?? DEFAULT_MAX_TESTS);
  const doneSteps = params.steps.filter((step) => (step.status ?? "done") === "done");
  if (doneSteps.length === 0) return [];

  try {
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

    if (suggestions.length === 0) {
      throw new Error("Manual test generation returned no usable suggestions.");
    }

    return suggestions.slice(0, maxTests);
  } catch {
    const fallback = buildFallbackTests(doneSteps, minTests, new Set<string>());
    return fallback.slice(0, maxTests);
  }
}
