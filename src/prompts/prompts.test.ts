import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { resolveScoutTemplatePath, SCOUT_PROMPT_TEMPLATE_FILE } from "./scout/loader.js";
import { buildPlanSystemPrompt as buildPlanSystemPromptFromPrompts } from "./planner/system-prompt.js";
import { REVIEW_INSTRUCTION } from "./plan-autocheck/review-instruction.js";
import { MANUAL_TESTS_SYSTEM_PROMPT } from "./manual-tests/system-prompt.js";
import {
  WORKER_CONTEXT,
  WORKER_CLAUDE_CONTEXT,
  WORKER_AGENTS_CONTEXT,
  WORKER_CONTEXT_DIR,
  SHARED_WORKER_CONTRACT_FILE,
  WORKER_AGENTS_CONTEXT_FILE,
  WORKER_CLAUDE_CONTEXT_FILE,
  resolveSharedWorkerContractPath,
  resolveWorkerAgentsContextPath,
  resolveWorkerClaudeContextPath,
} from "./worker/worker-context.js";
import { REPO_CHAT_CONTEXT } from "./repo-chat/repo-chat-context.js";
import {
  CODEX_STYLE_DIRECTIVE,
  buildResponseFileInstruction,
} from "./repo-chat/response-file-instruction.js";
import { buildPostExecutionReviewPrompt } from "./post-execution-review/build-prompt.js";
import {
  buildClaudeExtractionPrompt,
  buildLessonExtractionPrompt,
} from "./lessons/extraction-prompt.js";
import { REPO_CHAT_SANDBOX_REPAIR_PROMPT } from "./repair/repo-chat-repair.js";
import { loadAgentWorkspaceTemplate } from "./agent-workspace/templates.js";

// Re-imports from the consumer modules: every active prompt must continue to
// resolve to the same identity as the canonical src/prompts/ definition, so
// no consumer can silently drift away from the centralized text.
import { buildPlanSystemPrompt as buildPlanSystemPromptFromGoal } from "../goal/planner.js";
import { resolveScoutTemplatePath as resolveScoutTemplatePathFromGoal } from "../goal/scout.js";
import { buildPostExecutionReviewPrompt as buildPostExecutionReviewPromptFromGoal } from "../goal/post-execution-review.js";
import { WORKER_CONTEXT as WORKER_CONTEXT_FROM_GOAL } from "../goal/worker-context.js";
import { REPO_CHAT_CONTEXT as REPO_CHAT_CONTEXT_FROM_CONSUMER } from "../repo-chat/repo-chat-context.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..", "..");
const promptsRoot = path.join(repoRoot, "src", "prompts");

describe("src/prompts/ — scout template", () => {
  it("resolves the runtime scout template from src/prompts/scout/", () => {
    const templatePath = resolveScoutTemplatePath();
    expect(templatePath).toContain(path.join("prompts", "scout", SCOUT_PROMPT_TEMPLATE_FILE));
    expect(fs.existsSync(templatePath)).toBe(true);
    expect(fs.readFileSync(templatePath, "utf8")).toContain("Scout Planning Brief");
  });

  it("ships the same loader from src/goal/scout.ts (no drift)", () => {
    expect(resolveScoutTemplatePathFromGoal()).toBe(resolveScoutTemplatePath());
  });

  it("does not leave the template behind in the deprecated src/goal/templates/ location", () => {
    const oldPath = path.join(repoRoot, "src", "goal", "templates", "scout_prompt_template.md");
    expect(fs.existsSync(oldPath)).toBe(false);
  });
});

describe("src/prompts/ — planner system prompt", () => {
  it("re-exports the canonical buildPlanSystemPrompt from src/goal/planner.ts", () => {
    expect(buildPlanSystemPromptFromGoal).toBe(buildPlanSystemPromptFromPrompts);
  });

  it("produces a deterministic, non-empty system prompt", () => {
    const prompt = buildPlanSystemPromptFromPrompts();
    expect(prompt.length).toBeGreaterThan(500);
    expect(prompt).toContain("technical planning agent");
    expect(prompt).toContain("BACKEND SELECTION RULES");
  });

  it("rejects an empty worker list", () => {
    expect(() => buildPlanSystemPromptFromPrompts([])).toThrow();
  });
});

describe("src/prompts/ — plan-autocheck review instruction", () => {
  it("contains the reviewer ROLE and OUTPUT FORMAT sections", () => {
    expect(REVIEW_INSTRUCTION).toContain("## 1. ROLE");
    expect(REVIEW_INSTRUCTION).toContain("## 5. OUTPUT FORMAT");
    expect(REVIEW_INSTRUCTION).toContain('{"approved": true}');
  });

  it("encodes the Stage 2Q self-verifying-plan rubric", () => {
    const needles = [
      "Every code-changing step is SELF-VERIFYING",
      "IMPLEMENTATION/TEST SPLITS",
      "TSC-ONLY LOGIC STEPS",
      "MISSING FOCUSED REGRESSIONS",
      "TINY REPEATED TOUCHES",
      "add-529-transient-classifier",
      "add-repo-chat-cli-output-extraction",
      "EXPLICITLY ALLOWED",
      "final verification-matrix step",
      "final report-writing / documentation step",
    ];
    for (const needle of needles) {
      expect(REVIEW_INSTRUCTION).toContain(needle);
    }
  });
});

describe("src/prompts/ — planner system prompt (Stage 2Q self-verifying)", () => {
  it("declares implementation + tests + verification belong in the same step", () => {
    const prompt = buildPlanSystemPromptFromPrompts(["claude_code", "codex"]);
    expect(prompt).toContain(
      'DO NOT split "implement X" and "add tests for X" into separate steps.',
    );
    expect(prompt).toContain(
      "Implementation + tests + focused verification belong in the same step",
    );
  });

  it("declares success criteria are additive minimums", () => {
    const prompt = buildPlanSystemPromptFromPrompts(["claude_code", "codex"]);
    expect(prompt).toContain("SUCCESS CRITERIA AS ADDITIVE MINIMUMS");
    expect(prompt).toContain("MINIMUM bar to consider a step done");
  });

  it("requires focused test commands in implementation step success criteria", () => {
    const prompt = buildPlanSystemPromptFromPrompts(["claude_code", "codex"]);
    expect(prompt).toContain(
      "Every implementation step MUST include the EXACT focused test command(s)",
    );
  });

  it("embeds the Stage 2P bad fixtures verbatim as examples", () => {
    const prompt = buildPlanSystemPromptFromPrompts(["claude_code", "codex"]);
    expect(prompt).toContain('BAD PLAN B (Stage 2P "under-tested split" anti-pattern)');
    expect(prompt).toContain('BAD PLAN C (Stage 2P "repo-chat split" anti-pattern)');
    expect(prompt).toContain("GOOD COMBINED VARIANT");
  });
});

describe("src/prompts/ — worker context", () => {
  it("merges the Claude and AGENTS bodies", () => {
    expect(WORKER_CONTEXT).toContain(WORKER_CLAUDE_CONTEXT);
    expect(WORKER_CONTEXT).toContain(WORKER_AGENTS_CONTEXT);
  });

  it("is the same object identity used by src/goal/worker-context.ts (no drift)", () => {
    expect(WORKER_CONTEXT_FROM_GOAL).toBe(WORKER_CONTEXT);
  });

  it("Claude and Codex contexts are byte-identical (no backend-specific appendix)", () => {
    expect(WORKER_CLAUDE_CONTEXT).toBe(WORKER_AGENTS_CONTEXT);
    expect(WORKER_CLAUDE_CONTEXT).toBe(WORKER_CONTEXT);
  });

  it("loads from the canonical shared-worker-contract.md on disk", () => {
    const sharedPath = resolveSharedWorkerContractPath();
    expect(sharedPath).toBe(path.join(WORKER_CONTEXT_DIR, SHARED_WORKER_CONTRACT_FILE));
    expect(fs.readFileSync(sharedPath, "utf8")).toBe(WORKER_CONTEXT);
  });

  it("worker AGENTS.md and CLAUDE.md mirror the shared contract byte-for-byte", () => {
    const shared = fs.readFileSync(resolveSharedWorkerContractPath(), "utf8");
    const agents = fs.readFileSync(resolveWorkerAgentsContextPath(), "utf8");
    const claude = fs.readFileSync(resolveWorkerClaudeContextPath(), "utf8");
    expect(agents).toBe(shared);
    expect(claude).toBe(shared);
    expect(path.basename(resolveWorkerAgentsContextPath())).toBe(WORKER_AGENTS_CONTEXT_FILE);
    expect(path.basename(resolveWorkerClaudeContextPath())).toBe(WORKER_CLAUDE_CONTEXT_FILE);
  });

  it("contains the strengthened verification rules required by Stage 2Q", () => {
    const needles = [
      "Task SUCCESS CRITERIA are the minimum bar, not the full verification contract.",
      "Every code-changing task must include implementation, focused tests, and verification inside the **same task**.",
      "Do not split implementation and tests into separate tasks unless the task is explicitly a final cross-cutting verification sweep.",
      "Run the smallest relevant test slice",
      "pnpm exec tsc -p tsconfig.json",
      "pnpm build",
      "pnpm lint",
      "Before reporting completion, list the exact verification commands you ran",
      "Do NOT restart the gateway service during goal execution.",
    ];
    for (const needle of needles) {
      expect(WORKER_CONTEXT).toContain(needle);
    }
  });

  it("contains the Stage 2S Workspace section (transitional managed-workspace contract)", () => {
    const needles = [
      "## Workspace (Stage 2S — transitional)",
      "<managed-root>/agent/workspaces/<workspace-name>/repo",
      "~/smithersbot-goals",
      "SMITHERSBOT_GOALS_ROOT",
      "process.env.GOOGLE_DRIVE_API_KEY",
      'os.environ["GOOGLE_DRIVE_API_KEY"]',
      "<managed-root>/private/env/<workspace-name>/.env",
      ".env.example",
      "<managed-root>/agent/history/",
      "sanitized summaries",
      "Workers do NOT receive raw secrets in env by default",
      "buildGoalWorkerEnv",
      "host-side commands (gateway-side flows)",
      "full OS-level isolation is NOT claimed",
      "Legacy `workingDir` values",
      "allowLegacyWorkingDir",
    ];
    for (const needle of needles) {
      expect(WORKER_CONTEXT).toContain(needle);
    }
  });
});

describe("src/prompts/ — agent workspace templates", () => {
  it("serves isolated-agent workspace AGENTS.md from src/prompts", () => {
    expect(loadAgentWorkspaceTemplate("AGENTS.md")).toContain(
      "SmithersBot-managed agent workspace",
    );
    expect(loadAgentWorkspaceTemplate("AGENTS.md")).not.toContain("docs/reference/templates");
  });
});

describe("src/prompts/ — repo-chat context and delivery", () => {
  it("is the same object identity used by src/repo-chat/repo-chat-context.ts", () => {
    expect(REPO_CHAT_CONTEXT_FROM_CONSUMER).toBe(REPO_CHAT_CONTEXT);
  });

  it("references the Stage 2S agent-history mirror and excludes the private tree", () => {
    expect(REPO_CHAT_CONTEXT).toContain("agent/history/goals/");
    expect(REPO_CHAT_CONTEXT).toContain("agent/history/repo-chats/");
    expect(REPO_CHAT_CONTEXT).toContain("agent/history/index/");
    expect(REPO_CHAT_CONTEXT).toContain("smithersbot-goals");
    expect(REPO_CHAT_CONTEXT).toContain("SMITHERSBOT_GOALS_ROOT");
    expect(REPO_CHAT_CONTEXT).toMatch(/NEVER read\s+`<managed-root>\/private\//);
    // Legacy ~/.smithersbot remains a deprecated fallback but is no longer the
    // sole "canonical default" line — keep the runtime store reference.
    expect(REPO_CHAT_CONTEXT).toContain("~/.smithersbot/goals/");
  });

  it("emits a Codex-style response-file instruction with the temp path", () => {
    const claudeInstruction = buildResponseFileInstruction({
      backend: "claude_code",
      filePath: "/tmp/ignored.md",
    });
    expect(claudeInstruction).toContain("FINAL RESPONSE");
    expect(claudeInstruction).not.toContain("/tmp/ignored.md");

    const codexInstruction = buildResponseFileInstruction({
      backend: "codex",
      filePath: "/tmp/answer.md",
    });
    expect(codexInstruction).toContain("RESPONSE FILE");
    expect(codexInstruction).toContain("/tmp/answer.md");
    expect(CODEX_STYLE_DIRECTIVE).toContain("final answer");
  });
});

describe("src/prompts/ — post-execution review", () => {
  it("re-exports the canonical builder from src/goal/post-execution-review.ts", () => {
    expect(buildPostExecutionReviewPromptFromGoal).toBe(buildPostExecutionReviewPrompt);
  });

  it("renders step ids, success criteria, and the diff", () => {
    const prompt = buildPostExecutionReviewPrompt({
      goal: "Test goal",
      steps: [
        {
          id: "alpha",
          description: "Do alpha",
          shortSummary: "Alpha",
          dependsOn: [],
          successCriteria: "alpha is done",
          constraints: [],
          status: "done",
          backend: "claude_code",
          taskSummary: "Alpha completed",
        },
      ],
      diff: "diff --git a/foo b/foo\n+added",
    });
    expect(prompt).toContain("alpha — Alpha");
    expect(prompt).toContain("alpha is done");
    expect(prompt).toContain("Test goal");
    expect(prompt).toContain("```diff");
  });
});

describe("src/prompts/ — lessons", () => {
  it("buildLessonExtractionPrompt embeds run metadata", () => {
    const prompt = buildLessonExtractionPrompt({
      runId: "run-123",
      workingDir: "/work",
      existingLessons: [],
      correctionSummary: "summary",
    });
    expect(prompt).toContain("Run: run-123");
    expect(prompt).toContain("Working directory: /work");
    expect(prompt).toContain("Existing lessons");
    expect(prompt).toContain("None.");
  });

  it("buildClaudeExtractionPrompt wraps a user message under section headers", () => {
    const wrapped = buildClaudeExtractionPrompt("ask");
    expect(wrapped).toContain("## System Prompt");
    expect(wrapped).toContain("## User Message");
    expect(wrapped).toContain("ask");
  });
});

describe("src/prompts/ — repair", () => {
  it("repo-chat repair prompt forbids file writes and shell redirects", () => {
    expect(REPO_CHAT_SANDBOX_REPAIR_PROMPT).toContain("Do not write files.");
    expect(REPO_CHAT_SANDBOX_REPAIR_PROMPT).toContain("Do not use shell redirects.");
  });
});

describe("src/prompts/ — manual-tests system prompt", () => {
  it("contains the JSON shape contract", () => {
    expect(MANUAL_TESTS_SYSTEM_PROMPT).toContain("Return ONLY JSON");
    expect(MANUAL_TESTS_SYSTEM_PROMPT).toContain("MANUAL verification tests");
  });
});

describe("src/prompts/ — no drift in consumer source files", () => {
  // Stage 2Q: implementation tasks should not paste prompt bodies inline; they
  // must import from src/prompts/. These tests act as a regression fence
  // against future drift.

  const cases: Array<{ consumer: string; needle: string; description: string }> = [
    {
      consumer: path.join("src", "goal", "planner.ts"),
      needle: "You are a technical planning agent.",
      description: "planner system prompt body should not live in src/goal/planner.ts",
    },
    {
      consumer: path.join("src", "goal", "manual-tests.ts"),
      needle: "You are a QA assistant that suggests only necessary MANUAL",
      description: "manual-tests system prompt body should not live in src/goal/manual-tests.ts",
    },
    {
      consumer: path.join("src", "goal", "plan-autocheck.ts"),
      needle: "## 1. ROLE",
      description:
        "plan-autocheck reviewer instruction should not live in src/goal/plan-autocheck.ts",
    },
    {
      consumer: path.join("src", "goal", "lessons.ts"),
      needle: "Extract reusable project lessons from this completed goal run.",
      description: "lesson extraction prompt should not live in src/goal/lessons.ts",
    },
    {
      consumer: path.join("src", "goal", "post-execution-review.ts"),
      needle: "Review this diff for: verify that per-step success criteria were met",
      description:
        "post-execution review prompt should not live in src/goal/post-execution-review.ts",
    },
    {
      consumer: path.join("src", "repo-chat", "repo-chat-worker.ts"),
      needle: "FINAL RESPONSE (CRITICAL - READ THIS CAREFULLY)",
      description:
        "repo-chat response-file instruction should not live in src/repo-chat/repo-chat-worker.ts",
    },
    {
      consumer: path.join("src", "repo-chat", "repo-chat-worker.ts"),
      needle: "Your previous repo-chat turn did not produce a deliverable final answer.",
      description:
        "repo-chat sandbox-safe repair prompt should not live in src/repo-chat/repo-chat-worker.ts",
    },
  ];

  for (const { consumer, needle, description } of cases) {
    it(description, () => {
      const consumerPath = path.join(repoRoot, consumer);
      const consumerSource = fs.readFileSync(consumerPath, "utf8");
      expect(consumerSource).not.toContain(needle);
    });
  }

  it("every active prompt module lives under src/prompts/", () => {
    expect(fs.existsSync(path.join(promptsRoot, "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(promptsRoot, "scout", "scout_prompt_template.md"))).toBe(true);
    expect(fs.existsSync(path.join(promptsRoot, "planner", "system-prompt.ts"))).toBe(true);
    expect(fs.existsSync(path.join(promptsRoot, "plan-autocheck", "review-instruction.ts"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(promptsRoot, "manual-tests", "system-prompt.ts"))).toBe(true);
    expect(fs.existsSync(path.join(promptsRoot, "worker", "worker-context.ts"))).toBe(true);
    expect(fs.existsSync(path.join(promptsRoot, "agent-workspace", "templates.ts"))).toBe(true);
    const workerContextDir = path.join(repoRoot, "src", "goal", "worker-context");
    expect(fs.existsSync(path.join(workerContextDir, "shared-worker-contract.md"))).toBe(true);
    expect(fs.existsSync(path.join(workerContextDir, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(workerContextDir, "CLAUDE.md"))).toBe(true);
    expect(fs.existsSync(path.join(promptsRoot, "repo-chat", "repo-chat-context.ts"))).toBe(true);
    expect(fs.existsSync(path.join(promptsRoot, "repo-chat", "response-file-instruction.ts"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(promptsRoot, "post-execution-review", "build-prompt.ts"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(promptsRoot, "lessons", "extraction-prompt.ts"))).toBe(true);
    expect(fs.existsSync(path.join(promptsRoot, "repair", "repo-chat-repair.ts"))).toBe(true);
  });
});
