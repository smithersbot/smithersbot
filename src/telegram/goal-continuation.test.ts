import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ContinuationProposal } from "../goal/types.js";
import { buildContinuationPlanGoalText } from "../goal/cli-planner.js";
import { loadRun, saveRun } from "../goal/run-store.js";
import {
  CONTINUATION_APPROVE_PREFIX,
  CONTINUATION_DETAILS_PREFIX,
  CONTINUATION_EDIT_PREFIX,
  CONTINUATION_MAKE_ANOTHER_PREFIX,
  CONTINUATION_STOP_PREFIX,
  buildContinuationCallbackData,
  renderContinuationDetailsSurface,
  renderGoalAchievedContinuationSurface,
  renderRecommendedContinuationSurface,
} from "./goal-continuation.js";

const { mockRunCliPlanForContinuation } = vi.hoisted(() => ({
  mockRunCliPlanForContinuation: vi.fn(),
}));

vi.mock("../goal/cli-planner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../goal/cli-planner.js")>();
  return {
    ...actual,
    runCliPlanForContinuation: (...args: unknown[]) => mockRunCliPlanForContinuation(...args),
    runCliPlanRevision: vi.fn(),
  };
});

const RUN_ID = "12345678-aaaa-bbbb-cccc-123456789abc";
const PROPOSAL_ID = "87654321-bbbb-cccc-dddd-abcdefabcdef";
let testStateDir: string;
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.SMITHERSBOT_STATE_DIR;
  testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-continuation-state-"));
  process.env.SMITHERSBOT_STATE_DIR = testStateDir;
  mockRunCliPlanForContinuation.mockReset();
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.SMITHERSBOT_STATE_DIR;
  else process.env.SMITHERSBOT_STATE_DIR = previousStateDir;
  fs.rmSync(testStateDir, { recursive: true, force: true });
});

function proposal(overrides: Partial<ContinuationProposal> = {}): ContinuationProposal {
  return {
    proposalId: PROPOSAL_ID,
    fromPlanNumber: 1,
    fromRevision: 4,
    goalAchieved: false,
    briefSummary: "Tighten the final verification path.",
    proposedPrompt: "Create the next plan to verify the released behavior.",
    decisions: [
      {
        question: "Which verification target should Plan 2 prioritize?",
        options: ["CLI only", "Telegram gateway", "Both"],
        recommendedOption: "Both",
        rationale: "It exercises the user-visible and local paths.",
        promptImpact: "Include both CLI and Telegram checks in the proposed prompt.",
      },
      {
        question: "Should the next plan modify files?",
        options: ["No", "Only tests"],
        recommendedOption: "No",
        rationale: "The previous plan already completed the implementation.",
      },
    ],
    runAt: "now",
    status: "pending",
    createdAt: "2026-05-31T12:00:00.000Z",
    ...overrides,
  };
}

function twoPartPromptLongerThanCap(): string {
  const padding = " Keep this continuation planning context intact.".repeat(45);
  return [
    "Part A: remove and suppress DEV GATEWAY VERIFICATION prompt injection.",
    padding,
    "Part B: update README without mentioning dev gateway.",
  ].join("\n");
}

function buttonTexts(surface: {
  replyMarkup: { inline_keyboard: Array<Array<{ text: string }>> };
}) {
  return surface.replyMarkup.inline_keyboard.flat().map((button) => button.text);
}

function callbackData(surface: {
  replyMarkup: { inline_keyboard: Array<Array<{ callback_data: string }>> };
}) {
  return surface.replyMarkup.inline_keyboard.flat().map((button) => button.callback_data);
}

describe("continuation surfaces", () => {
  it("renders the recommended-plan surface with exact labels, Plan terminology, and emoji buttons", () => {
    const surface = renderRecommendedContinuationSurface({ runId: RUN_ID, proposal: proposal() });

    expect(surface.text).toBe(
      [
        "🧭 **Continue this goal with a new plan?**",
        "**Next Plan Summary:**",
        "Tighten the final verification path.",
        "**When:** Now",
        "**Decision(s) needed:**",
        "**Decision 1.** Which verification target should Plan 2 prioritize?\n" +
          "**(A)** CLI only\n" +
          "**(B)** Telegram gateway\n" +
          "**(C): (Recommended)** Both\n" +
          "**Decision 2.** Should the next plan modify files?\n" +
          "**(A): (Recommended)** No\n" +
          "**(B)** Only tests",
        "**Goal ID:** 12345678",
      ].join("\n"),
    );
    expect(buttonTexts(surface)).toEqual(["❤️ Approve", "🔍 View Prompt", "📝 Request Edit"]);
    expect(surface.replyMarkup.inline_keyboard).toEqual([
      [
        { text: "❤️ Approve", callback_data: "gca:12345678:87654321" },
        { text: "🔍 View Prompt", callback_data: "gcm:12345678:87654321" },
      ],
      [{ text: "📝 Request Edit", callback_data: "gce:12345678:87654321" }],
    ]);
    expect(callbackData(surface)).toEqual([
      "gca:12345678:87654321",
      "gcm:12345678:87654321",
      "gce:12345678:87654321",
    ]);
    expect(surface.text).not.toContain("🔁");
    expect(surface.text).not.toContain("Another plan is recommended.");
    expect(surface.text).not.toContain("**Next:**");
    expect(surface.text).not.toContain("**Recommendation:**");
    expect(surface.text).not.toContain("\n\n");
  });

  it("renders the achieved surface with only the Make Another Plan button", () => {
    const surface = renderGoalAchievedContinuationSurface({
      runId: RUN_ID,
      proposal: proposal({ goalAchieved: true, briefSummary: "No next plan needed." }),
    });

    expect(surface.text).toBe(
      [
        "✅ Goal appears achieved",
        "No next plan is recommended right now.",
        "**Goal ID:** 12345678",
      ].join("\n"),
    );
    expect(surface.replyMarkup.inline_keyboard).toEqual([
      [{ text: "➕ Make Another Plan", callback_data: "gcn:12345678:87654321" }],
    ]);
  });

  it("renders View Prompt as prompt-only details with no buttons", () => {
    const surface = renderContinuationDetailsSurface({ runId: RUN_ID, proposal: proposal() });

    expect(surface.text).toBe(
      [
        "**Proposed next plan prompt for Goal 12345678:**",
        "Create the next plan to verify the released behavior.",
      ].join("\n"),
    );
    expect(surface.replyMarkup).toBeUndefined();
    expect(surface.text.match(/\*\*Proposed next plan prompt for Goal/g)).toHaveLength(1);
    expect(surface.text).not.toContain("**Next Plan Summary:**");
    expect(surface.text).not.toContain("**Decision(s) needed:**");
    expect(surface.text).not.toContain("Prompt if recommendation(s) are accepted");
  });

  it("renders None when no decisions are needed", () => {
    const recommended = renderRecommendedContinuationSurface({
      runId: RUN_ID,
      proposal: proposal({ decisions: undefined }),
    });
    const details = renderContinuationDetailsSurface({
      runId: RUN_ID,
      proposal: proposal({ decisions: undefined }),
    });

    expect(recommended.text).toContain("**Decision(s) needed:**\nNone");
    expect(details.text).toBe(
      [
        "**Proposed next plan prompt for Goal 12345678:**",
        "Create the next plan to verify the released behavior.",
      ].join("\n"),
    );
  });

  it("renders an edited structured proposal for approval without exposing the raw edit text", () => {
    const surface = renderRecommendedContinuationSurface({
      runId: RUN_ID,
      proposal: proposal({
        status: "edited",
        briefSummary: "Create the edited Stage 2 artifact.",
        proposedPrompt: "Plan 2 should create only the edited Stage 2 artifact.",
        decisions: undefined,
        lastContinuationEditMessage: "just make it edited",
      }),
    });

    expect(surface.text).toContain("Create the edited Stage 2 artifact.");
    expect(surface.text).toContain("**Decision(s) needed:**\nNone");
    expect(surface.text).not.toContain("just make it edited");
    expect(surface.replyMarkup.inline_keyboard).toEqual([
      [
        { text: "❤️ Approve", callback_data: "gca:12345678:87654321" },
        { text: "🔍 View Prompt", callback_data: "gcm:12345678:87654321" },
      ],
      [{ text: "📝 Request Edit", callback_data: "gce:12345678:87654321" }],
    ]);
  });

  it("does not render empty decision bullets", () => {
    const surface = renderRecommendedContinuationSurface({
      runId: RUN_ID,
      proposal: proposal({
        decisions: [
          {
            question: "Which target?",
            options: ["", "Focused check", "   "],
            recommendedOption: "Focused check",
            rationale: "Only one concrete target was provided.",
          },
        ],
      }),
    });

    expect(surface.text).toContain("**Decision 1.** Which target?");
    expect(surface.text).toContain("**(A): (Recommended)** Focused check");
    expect(surface.text).not.toContain("**(B)**");
    expect(surface.text).not.toContain("**(C)**");
  });

  it("keeps callback_data short and uses continuation-specific prefixes", () => {
    const prefixes = [
      CONTINUATION_APPROVE_PREFIX,
      CONTINUATION_EDIT_PREFIX,
      CONTINUATION_DETAILS_PREFIX,
      CONTINUATION_STOP_PREFIX,
      CONTINUATION_MAKE_ANOTHER_PREFIX,
    ];

    for (const prefix of prefixes) {
      const data = buildContinuationCallbackData(prefix, RUN_ID, PROPOSAL_ID);
      expect(data.length).toBeLessThanOrEqual(64);
      expect(data).toMatch(new RegExp(`^${prefix}:12345678:87654321$`));
      expect(["ga", "gD", "gr", "ge", "gIF", "gTD", "gAD"]).not.toContain(prefix);
    }
  });

  it("does not use forbidden terminology in user-facing continuation text", () => {
    const surfaces = [
      renderRecommendedContinuationSurface({ runId: RUN_ID, proposal: proposal() }),
      renderGoalAchievedContinuationSurface({ runId: RUN_ID, proposal: proposal() }),
      renderContinuationDetailsSurface({ runId: RUN_ID, proposal: proposal() }),
    ];

    for (const surface of surfaces) {
      expect(surface.text.toLowerCase()).not.toContain("cycle");
      expect(surface.text).not.toContain("Another plan can be drafted under this goal.");
      expect(surface.text).not.toContain("Continuation prompt edited.");
      expect(surface.text).not.toContain("Another plan is recommended.");
      expect(surface.text).not.toContain("🔁");
    }
  });

  it("approves a continuation through fresh planning from the full proposed prompt", async () => {
    const longPrompt = twoPartPromptLongerThanCap();
    const runId = "approve-fresh-plan-run";
    const briefPath = path.join(testStateDir, "wiki", "goal-brief.md");
    fs.mkdirSync(path.dirname(briefPath), { recursive: true });
    fs.writeFileSync(
      briefPath,
      [
        "# Goal Brief",
        "",
        "## Goal Summary",
        "",
        "Stable whole-goal summary.",
        "",
        "## Remaining Work",
        "",
        "Prior remaining-work text should not become the next plan body.",
      ].join("\n"),
      "utf8",
    );
    saveRun({
      runId,
      goal: "Prepare the continuation PR.",
      state: "done",
      plan: {
        goal: "Prepare the continuation PR.",
        workingDir: "/tmp/workspace",
        summary: "Completed Plan 2 implementation work that must not be recreated.",
        shortSummary: "Plan 2",
        steps: [
          {
            id: "completed-plan-2-step",
            description: "Completed Plan 2 implementation step that should not be inline input.",
            shortSummary: "Completed prior work",
            dependsOn: [],
            status: "done",
          },
        ],
      },
      stepResults: {
        "completed-plan-2-step": {
          stepId: "completed-plan-2-step",
          success: true,
          output: "done",
          durationMs: 1,
        },
      },
      blocked: null,
      answers: {},
      workingDir: "/tmp/workspace",
      dryRun: false,
      createdAt: "2026-06-07T00:00:00.000Z",
      updatedAt: "2026-06-07T00:00:00.000Z",
      planRevision: 2,
      activePlanRevision: 2,
      planNumber: 2,
      goalBriefPath: briefPath,
      pendingContinuation: proposal({
        proposalId: "approve-proposal-1234",
        fromPlanNumber: 2,
        fromRevision: 2,
        briefSummary: "Clean up prompt injection and README wording.",
        proposedPrompt: longPrompt,
      }),
    });
    mockRunCliPlanForContinuation.mockResolvedValue({
      status: "success",
      plan: {
        goal: "Prepare the continuation PR.",
        workingDir: "/tmp/workspace",
        summary: "Clean up prompt injection and README wording.",
        shortSummary: "Cleanup README",
        steps: [
          {
            id: "readme-cleanup",
            description: "Update README without mentioning dev gateway.",
            shortSummary: "Update README",
            dependsOn: [],
            status: "done",
          },
        ],
      },
      scoutStatus: "success",
    });

    const { handleGoalContinuationApprove } = await import("./goal-commands.js");
    const result = await handleGoalContinuationApprove(runId, "approve", {
      goal: { planAutocheck: "off" },
    });

    expect(typeof result).not.toBe("string");
    expect(mockRunCliPlanForContinuation).toHaveBeenCalledOnce();
    const planningParams = mockRunCliPlanForContinuation.mock.calls[0]?.[0] as {
      originalGoalText: string;
      proposedPrompt: string;
      currentPlanNumber: number;
      goalBriefPath?: string;
    };
    expect(planningParams).toMatchObject({
      originalGoalText: "Prepare the continuation PR.",
      currentPlanNumber: 2,
      goalBriefPath: briefPath,
    });
    expect(planningParams.proposedPrompt).toContain(
      "Part A: remove and suppress DEV GATEWAY VERIFICATION prompt injection.",
    );
    expect(planningParams.proposedPrompt).toContain(
      "Part B: update README without mentioning dev gateway.",
    );

    const planningPrompt = buildContinuationPlanGoalText(planningParams);
    expect(planningPrompt).toContain(
      "Part A: remove and suppress DEV GATEWAY VERIFICATION prompt injection.",
    );
    expect(planningPrompt).toContain("Part B: update README without mentioning dev gateway.");
    expect(planningPrompt).not.toContain("Current plan:");
    expect(planningPrompt).not.toContain("Completed Plan 2 implementation step");
    expect(planningPrompt).not.toMatch(/keep unchanged steps/i);

    const stored = loadRun(runId);
    expect(stored?.planNumber).toBe(3);
    expect(stored?.plan?.summary).toBe("Clean up prompt injection and README wording.");
    expect(stored?.plan?.steps).toEqual([
      expect.objectContaining({
        id: "readme-cleanup",
        description: "Update README without mentioning dev gateway.",
        status: "pending",
      }),
    ]);
    expect(stored?.stepResults).toEqual({});
    expect(stored?.pendingContinuation).toBeUndefined();
    expect(fs.readFileSync(briefPath, "utf8")).toContain("Stable whole-goal summary.");
  });
});
