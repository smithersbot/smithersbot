import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { resolveScoutTemplatePath, SCOUT_PROMPT_TEMPLATE_FILE } from "./scout/loader.js";
import { buildPlanSystemPrompt as buildPlanSystemPromptFromPrompts } from "./planner/system-prompt.js";
import { REVIEW_INSTRUCTION } from "./plan-autocheck/review-instruction.js";
import { PLAN_QUALITY_RUBRIC } from "./shared/plan-quality-rubric.js";
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
import { WORKER_CONTEXT as WORKER_CONTEXT_FROM_GOAL } from "../goal/worker-context.js";
import { REPO_CHAT_CONTEXT as REPO_CHAT_CONTEXT_FROM_CONSUMER } from "../repo-chat/repo-chat-context.js";

// Stage 2U-F cross-cutting audit: build every dynamic agent-facing prompt
// surface to prove none instructs agents to read/write/output to .clawdbot-dev.
import { buildCachedScoutSummary } from "../goal/cli-planner.js";
import { buildAutocheckPrompt } from "../goal/plan-autocheck.js";
import { buildCliWorkerPrompt, buildCliPromptPayload } from "../goal/cli-worker.js";
import { renderGroupedHardDenies } from "../goal/hard-deny.js";
import type { Plan, PlanStep } from "../goal/types.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..", "..");
const promptsRoot = path.join(repoRoot, "src", "prompts");
const promptsReadmePath = path.join(promptsRoot, "README.md");

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

  it("references agent-history mirrors and avoids private runtime output targets", () => {
    const template = fs.readFileSync(resolveScoutTemplatePath(), "utf8");
    expect(template).toContain("agent/history/goals/<workspace>/<goalId>/runtime/scout/");
    expect(template).toContain("Agent-visible planning artifact directory:");
    expect(template).not.toContain(".clawdbot-dev/goals");
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
    expect(prompt).toContain("MANAGED WORKSPACE AND SECRET RULES");
    expect(prompt).toContain("<managed-root>/agent/workspaces/<workspace-name>");
    expect(prompt).not.toContain("<managed-root>/agent/workspaces/<workspace-name>/repo");
    expect(prompt).toContain(".env.example");
    expect(prompt).toContain("Workers do not receive raw secrets by default");
    expect(prompt).toContain("only where implemented and verified");
    expect(prompt).toContain(PLAN_QUALITY_RUBRIC);
    expect(prompt).toContain("Produce a plan satisfying the shared plan-quality rubric");
    expect(prompt).not.toContain("full access to the filesystem");
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
    expect(REVIEW_INSTRUCTION).toContain(PLAN_QUALITY_RUBRIC);
  });
});

describe("src/prompts/ — planner system prompt (Stage 2Q self-verifying)", () => {
  it("declares implementation + tests + verification belong in the same step", () => {
    const prompt = buildPlanSystemPromptFromPrompts(["claude_code", "codex"]);
    expect(prompt).toContain(PLAN_QUALITY_RUBRIC);
    expect(prompt).toContain("IMPLEMENTATION/TEST SPLITS");
    expect(prompt).toContain("focused tests");
  });

  it("declares success criteria are additive minimums", () => {
    const prompt = buildPlanSystemPromptFromPrompts(["claude_code", "codex"]);
    expect(prompt).toContain("Every code-changing step is SELF-VERIFYING");
    expect(prompt).toContain("Success criteria are specific");
  });

  it("requires focused test commands in implementation step success criteria", () => {
    const prompt = buildPlanSystemPromptFromPrompts(["claude_code", "codex"]);
    expect(prompt).toContain("Every implementation step names exact focused test command(s)");
  });

  it("keeps only compact Stage 2P anti-pattern summaries in the planner prompt", () => {
    const prompt = buildPlanSystemPromptFromPrompts(["claude_code", "codex"]);
    expect(prompt).toContain("CONCISE ANTI-PATTERN REMINDERS");
    expect(prompt).toContain("Stage 2P under-tested split");
    expect(prompt).toContain("Stage 2P repo-chat split");
    expect(prompt).not.toContain("EXAMPLE — BAD PLAN B");
    expect(prompt).not.toContain("GOOD COMBINED VARIANT");
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

  it("contains the managed Workspace section", () => {
    const needles = [
      "## Workspace",
      "<managed-root>/agent/workspaces/<workspace-name>",
      "<managed-root>/agent/workspaces/<workspace-name>/repo",
      "Existing legacy workspaces",
      "remain supported when",
      "~/smithersbot-goals",
      "SMITHERSBOT_GOALS_ROOT",
      "process.env.GOOGLE_DRIVE_API_KEY",
      'os.environ["GOOGLE_DRIVE_API_KEY"]',
      "<managed-root>/private/env/<workspace-name>/.env",
      ".env.example",
      "<managed-root>/agent/history/",
      "Redacted runtime artifacts are mirrored into agent history with",
      "generous caps and an index",
      "Workers do NOT receive raw secrets in env by default",
      "buildGoalWorkerEnv",
      "host-side commands (gateway-side flows)",
      "Native backend sandboxing is used only where SmithersBot has implemented,",
      "live-probed, and verified it for the selected backend",
      "Managed workspaces",
      "not by themselves a kernel boundary",
      "Do not treat",
      "prompts, `CLAUDE.md`, or this contract as a security boundary",
      "Backend secret-read isolation is claimed only",
      "`workingDir` values outside",
      "allowLegacyWorkingDir",
    ];
    for (const needle of needles) {
      expect(WORKER_CONTEXT).toContain(needle);
    }
  });

  it("documents grouped hard-deny framing and redacted runtime history mirrors", () => {
    expect(WORKER_CONTEXT).toContain("grouped hard-deny section generated from");
    expect(WORKER_CONTEXT).toContain(
      "Redacted runtime artifacts are mirrored into agent history with",
    );
    expect(WORKER_CONTEXT).not.toContain("Raw stdout/stderr blobs and raw transcripts");
    expect(WORKER_CONTEXT).not.toContain("are not mirrored there by default");
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
    expect(REPO_CHAT_CONTEXT).toContain("agent/workspaces/");
    expect(REPO_CHAT_CONTEXT).toContain(".env.example");
    expect(REPO_CHAT_CONTEXT).toContain("process.env.KEY");
    expect(REPO_CHAT_CONTEXT).toContain('os.environ["KEY"]');
    expect(REPO_CHAT_CONTEXT).toContain("only where SmithersBot has implemented and verified");
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

  it("points dev runtime verification at the dev gateway, not stable by default", () => {
    const forbiddenDevUnit = ["smithersbot", "gateway", "dev.service"].join("-");
    const stableRestartInstruction = [
      "Restart the gateway: systemctl --user restart",
      "smithersbot-gateway.service",
    ].join(" ");

    expect(MANUAL_TESTS_SYSTEM_PROMPT).toContain("smithersbot-dev-gateway.service");
    expect(MANUAL_TESTS_SYSTEM_PROMPT).toContain("node ./smithersbot.mjs dev-gateway restart");
    expect(MANUAL_TESTS_SYSTEM_PROMPT).toContain("stable smithersbot-gateway.service");
    expect(MANUAL_TESTS_SYSTEM_PROMPT).not.toContain(stableRestartInstruction);
    expect(MANUAL_TESTS_SYSTEM_PROMPT).not.toContain(forbiddenDevUnit);
  });
});

describe("src/prompts/ — plan autocheck", () => {
  it("rejects sandbox overclaims and protects the managed env contract", () => {
    expect(REVIEW_INSTRUCTION).toContain(".env.example");
    expect(REVIEW_INSTRUCTION).toContain("raw secrets are not passed to workers by default");
    expect(REVIEW_INSTRUCTION).toContain("<managed-root>/private/");
    expect(REVIEW_INSTRUCTION).toContain("SANDBOX OVERCLAIMS");
    expect(REVIEW_INSTRUCTION).toContain("broad kernel-level isolation");
    expect(REVIEW_INSTRUCTION).toContain("prompts/CLAUDE.md as a security boundary");
  });
});

describe("src/prompts/ — sandbox claim guardrails", () => {
  it("does not contain broad isolation or visibility overclaims", () => {
    const files = [
      path.join(repoRoot, "README.md"),
      path.join(repoRoot, "SETUP.md"),
      path.join(promptsRoot, "repo-chat", "repo-chat-context.ts"),
      path.join(promptsRoot, "planner", "system-prompt.ts"),
      path.join(promptsRoot, "plan-autocheck", "review-instruction.ts"),
      promptsReadmePath,
      resolveSharedWorkerContractPath(),
      resolveWorkerAgentsContextPath(),
      resolveWorkerClaudeContextPath(),
    ];
    const banned = [
      new RegExp(["full", "OS-level", "isolation"].join(" "), "i"),
      new RegExp(["every", "file", "available"].join(" "), "i"),
    ];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      for (const pattern of banned) {
        expect(text, `${file} should not match ${pattern}`).not.toMatch(pattern);
      }
    }
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
    expect(fs.existsSync(promptsReadmePath)).toBe(true);
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
    expect(fs.existsSync(path.join(promptsRoot, "lessons", "extraction-prompt.ts"))).toBe(true);
    expect(fs.existsSync(path.join(promptsRoot, "repair", "repo-chat-repair.ts"))).toBe(true);
  });
});

describe("src/prompts/ — Stage 2U-F: no .clawdbot-dev as an agent-facing target", () => {
  // The ONLY place a generated agent-facing prompt may name .clawdbot-dev is the
  // grouped hard-deny bullet (a denied/private runtime-config path). Any other
  // line naming it would be telling the agent to read/write/output there, which
  // is exactly what Stage 2U-F removes.
  const DENY_BULLET = "- ~/.clawdbot-dev/**";

  function assertClawdbotDevDeniedOnly(text: string, surface: string): void {
    for (const rawLine of text.split("\n")) {
      if (!rawLine.includes(".clawdbot-dev")) continue;
      expect(
        rawLine.trim(),
        `${surface} must only name .clawdbot-dev in the denied hard-deny context`,
      ).toBe(DENY_BULLET);
    }
  }

  const step: PlanStep = {
    id: "impl-step",
    description: "Implement the widget and add focused tests.",
    shortSummary: "Implement widget",
    dependsOn: [],
    status: "pending",
    durationMinutes: 20,
    backend: "claude_code",
    successCriteria: "pnpm vitest run src/widget.test.ts passes.",
    constraints: ["Do not change the public API."],
  };
  const plan: Plan = {
    goal: "Ship the widget",
    workingDir: "/tmp/workspace",
    summary: "Ship the widget end to end",
    shortSummary: "Ship widget",
    steps: [step],
  };

  const workerPrompt = buildCliWorkerPrompt({
    step,
    plan,
    goal: "Ship the widget",
    resultPath: "/tmp/workspace/.results/worker_result.json",
  });

  // A deny-file path that does not exist forces the deterministic grouped
  // hard-deny fallback (renderGroupedHardDenies) — the only surface allowed to
  // name .clawdbot-dev, and only as a denied path.
  const missingDenyPath = path.join(repoRoot, "no-such-deny-file-stage2uf.txt");
  const codexPayload = buildCliPromptPayload({
    backend: "codex",
    prompt: workerPrompt,
    denyFilePath: missingDenyPath,
    projectConventions: "Use pnpm. Strict TypeScript.",
  });
  const claudePayload = buildCliPromptPayload({
    backend: "claude_code",
    prompt: workerPrompt,
    denyFilePath: missingDenyPath,
  });

  const cachedScout = buildCachedScoutSummary({
    runId: "run-audit",
    cwd: "/tmp/workspaces/smithersbot/repo",
    scoutDir: "/tmp/goals/run-audit/scout",
    scoutData: {
      status: "success",
      report: {
        goal_id: "run-audit",
        nodes: [
          {
            id: "impl-step",
            type: "Impl",
            objective: "Implement widget",
            verification: "pnpm vitest run src/widget.test.ts",
            effort: 1,
            risk: 1,
            uncertainty: 1,
          },
        ],
        edges: [],
      },
      planDraft: "BEGIN_PLAN_DRAFT\nGOAL_ID: run-audit\nEND_PLAN_DRAFT",
    },
  });

  const autocheckPrompt = buildAutocheckPrompt({
    goalText: "Ship the widget",
    plan,
    workingDir: "/tmp/workspace",
    resume: false,
    priorFeedback: [],
    contextNotes: [],
  });

  const surfaces: Array<{ name: string; text: string }> = [
    { name: "scout template", text: fs.readFileSync(resolveScoutTemplatePath(), "utf8") },
    {
      name: "planner system prompt",
      text: buildPlanSystemPromptFromPrompts(["claude_code", "codex"]),
    },
    { name: "cached scout summary (replan)", text: cachedScout },
    { name: "plan-autocheck reviewer instruction", text: REVIEW_INSTRUCTION },
    { name: "plan-autocheck dynamic prompt", text: autocheckPrompt },
    { name: "shared plan-quality rubric", text: PLAN_QUALITY_RUBRIC },
    { name: "worker context contract", text: WORKER_CONTEXT },
    { name: "worker dynamic prompt", text: workerPrompt },
    { name: "worker payload (codex)", text: codexPayload.persistedPrompt },
    { name: "worker payload (claude_code)", text: claudePayload.persistedPrompt },
    { name: "manual-tests system prompt", text: MANUAL_TESTS_SYSTEM_PROMPT },
    {
      name: "lessons extraction prompt",
      text: buildLessonExtractionPrompt({
        runId: "run-audit",
        workingDir: "/tmp/workspace",
        existingLessons: [],
        correctionSummary: "A worker failed; see agent-history runtime mirror.",
      }),
    },
    { name: "repo-chat context", text: REPO_CHAT_CONTEXT },
    {
      name: "repo-chat response-file instruction",
      text: buildResponseFileInstruction({ backend: "codex", filePath: "/tmp/answer.md" }),
    },
    { name: "repo-chat repair prompt", text: REPO_CHAT_SANDBOX_REPAIR_PROMPT },
    { name: "agent-workspace AGENTS template", text: loadAgentWorkspaceTemplate("AGENTS.md") },
  ];

  it.each(surfaces)(
    "$name never names .clawdbot-dev as a read/write/output target",
    ({ name, text }) => {
      assertClawdbotDevDeniedOnly(text, name);
    },
  );

  it("references agent/history where history/artifacts are needed", () => {
    expect(fs.readFileSync(resolveScoutTemplatePath(), "utf8")).toContain("agent/history");
    expect(cachedScout).toContain("agent/history");
    expect(WORKER_CONTEXT).toContain("agent/history");
    expect(REPO_CHAT_CONTEXT).toContain("agent/history");
  });

  it("allows .clawdbot-dev only inside the grouped hard-deny (denied) context", () => {
    const grouped = renderGroupedHardDenies();
    expect(grouped).toContain(DENY_BULLET);
    // Worker payloads embed the grouped denies; that bullet is the sole mention.
    expect(codexPayload.persistedPrompt).toContain(DENY_BULLET);
    expect(claudePayload.persistedPrompt).toContain(DENY_BULLET);
    assertClawdbotDevDeniedOnly(codexPayload.persistedPrompt, "worker payload (codex)");
    assertClawdbotDevDeniedOnly(claudePayload.persistedPrompt, "worker payload (claude_code)");
  });
});

describe("src/prompts/ — lifecycle persistence coverage", () => {
  it("documents persistence behavior for every active lifecycle row", () => {
    const readme = fs.readFileSync(promptsReadmePath, "utf8");
    const lifecycleRows = readme
      .split("\n")
      .filter((line) => line.startsWith("| "))
      .filter((line) => !line.includes("Lifecycle step") && !line.includes("---"))
      .filter((line) => !line.includes("Prompt source"));
    const expectedSteps = [
      "Scout",
      "Planner system prompt",
      "Plan autocheck reviewer",
      "Worker context (CLI)",
      "Agent workspace bootstrap",
      "Repo-chat context",
      "Repo-chat delivery",
      "Repo-chat repair",
      "Manual-test suggester",
      "Lesson extraction",
    ];

    expect(lifecycleRows).toHaveLength(expectedSteps.length);
    for (const step of expectedSteps) {
      const row = lifecycleRows.find((line) => line.includes(`| ${step}`));
      expect(row, `missing lifecycle row for ${step}`).toBeDefined();
      expect(row).toMatch(/summary|metadata|No LLM call|mirror|lessons/i);
    }

    expect(readme).toContain("<managed-root>/agent/history/");
    // Stage 2U-F: the redacted runtime mirror replaces the old "not mirrored by
    // default" history claim. The new canonical sentence must be present and the
    // outdated wording gone.
    expect(readme).toContain(
      "Redacted runtime artifacts are mirrored into agent history with generous caps and an index.",
    );
    expect(readme).not.toContain("Raw stdout/stderr, raw transcripts, private env");
    expect(readme).not.toContain("not mirrored to agent history");
    expect(readme).toContain("agent/history/index/all-goals.jsonl");
    expect(readme).toContain("agent/history/index/all-repo-chats.jsonl");
  });
});

describe("project docs — managed workspace and sandbox claims", () => {
  it.each(["README.md", "SETUP.md"])(
    "%s preserves no-raw-secrets guidance and avoids OS-isolation overclaims",
    (fileName) => {
      const doc = fs.readFileSync(path.join(repoRoot, fileName), "utf8");
      expect(doc).toContain(".env.example");
      expect(doc).toContain("raw secrets");
      expect(doc).toMatch(/workers do not receive raw secrets/i);
      if (fileName === "SETUP.md") {
        expect(doc).toContain("Native backend sandboxing");
        expect(doc).toMatch(/not by\s+themselves a\s+kernel boundary/);
        expect(doc).toContain("Backend-specific live probes");
        expect(doc).toMatch(/Codex `--sandbox\s+workspace-write` alone/);
        expect(doc).toContain("Claude sandboxing requires its native sandbox");
      } else {
        expect(doc).toContain("Private gateway config, env, auth, and session files");
      }
      expect(doc).not.toMatch(
        new RegExp(
          ["full", "OS-level", "isolation", "is"].join(" ") + " (provided|ensured|enforced)",
          "i",
        ),
      );
      expect(doc).not.toMatch(/legacy `workingDir`[^.\n]*(sandboxed|isolated)/i);
    },
  );

  it("documents gateway restart service names without inventing a SmithersBot dev-gateway unit", () => {
    const setup = fs.readFileSync(path.join(repoRoot, "SETUP.md"), "utf8");
    const forbiddenDevUnit = ["smithersbot", "gateway", "dev.service"].join("-");

    expect(setup).toContain("smithersbot-dev-gateway.service");
    expect(setup).toContain("smithersbot-gateway.service");
    expect(setup).not.toContain(forbiddenDevUnit);
  });
});
