import { describe, expect, it } from "vitest";

import type { BlockedDetail, PlanStep } from "../goal/types.js";
import { markdownToTelegramHtml } from "./format.js";
import {
  buildBlockedCaption,
  buildBlockedSurfaceCopy,
  buildGoalBlockedInlineKeyboard,
  buildTaskBlockedInlineKeyboard,
  classifyBlockedNotification,
  formatPlanningDecisionMarkdown,
} from "./goal-blocked-ui.js";

function callbackDataSet(keyboard: ReturnType<typeof buildTaskBlockedInlineKeyboard>): string[] {
  return (keyboard?.inline_keyboard ?? [])
    .flat()
    .map((btn) => (btn as { callback_data: string }).callback_data);
}

function blockedStep(overrides: Partial<PlanStep> & { id: string }): PlanStep {
  return {
    description: `Step ${overrides.id}`,
    shortSummary: `Step ${overrides.id}`,
    dependsOn: [],
    status: "blocked",
    blockedReason: "user_input",
    ...overrides,
  };
}

describe("buildBlockedCaption bold labels", () => {
  it("renders the 'Step <id>:' label in bold markdown for a single step", () => {
    const caption = buildBlockedCaption([
      blockedStep({ id: "collider-parent-a", blockedQuestion: "Need the API base URL." }),
    ]);

    expect(caption).toContain("• **Step collider-parent-a:** Need the API base URL.");
    // Only the label is bold — the reason text is not wrapped in markers.
    expect(caption).not.toContain("**Need the API base URL.**");
  });

  it("renders a bold label for each of multiple blocked steps", () => {
    const caption = buildBlockedCaption([
      blockedStep({ id: "collider-parent-a", blockedQuestion: "Q A" }),
      blockedStep({ id: "collider-parent-b", blockedQuestion: "Q B" }),
    ]);

    expect(caption).toContain("**Step collider-parent-a:**");
    expect(caption).toContain("**Step collider-parent-b:**");
  });

  it("keeps a long blocked reason plain after the bold label", () => {
    const longReason =
      "Which Postgres connection string should the worker use, and should it run " +
      "migrations on startup or wait for an operator to apply them manually first?";
    const caption = buildBlockedCaption([
      blockedStep({ id: "setup-db", blockedQuestion: longReason }),
    ]);

    expect(caption).toBe(`• **Step setup-db:** ${longReason}`);
    // The label is the only bold span — no stray markers around the reason.
    expect(caption.match(/\*\*/g)?.length).toBe(2);
  });

  it("converts the bold label to <b>Step <id>:</b> via markdownToTelegramHtml", () => {
    const caption = buildBlockedCaption([
      blockedStep({ id: "collider-parent-a", blockedQuestion: "Need a value." }),
    ]);
    const html = markdownToTelegramHtml(caption);

    expect(html).toContain("<b>Step collider-parent-a:</b>");
    expect(html).toContain("Need a value.");
  });
});

describe("category-driven blocked keyboards", () => {
  const PREFIX = "abc12345";

  it("task-level Paused includes a Resume button (matching goal-level)", () => {
    const cbs = callbackDataSet(buildTaskBlockedInlineKeyboard(PREFIX, "paused"));
    expect(cbs).toContain(`gResume:${PREFIX}`);
    expect(cbs).toContain(`gStop:${PREFIX}`);
    // Paused does not imply the user must add details.
    expect(cbs).not.toContain(`gAD:${PREFIX}`);
  });

  it("goal-level Paused still includes a Resume button", () => {
    const cbs = callbackDataSet(buildGoalBlockedInlineKeyboard(PREFIX, "paused"));
    expect(cbs).toContain(`gResume:${PREFIX}`);
    expect(cbs).toContain(`gStop:${PREFIX}`);
    expect(cbs).not.toContain(`gAD:${PREFIX}`);
  });

  it("Blocked surfaces present Add Details/answer actions", () => {
    const task = callbackDataSet(buildTaskBlockedInlineKeyboard(PREFIX, "blocked"));
    expect(task).toContain(`gAD:${PREFIX}`);
    const goal = callbackDataSet(buildGoalBlockedInlineKeyboard(PREFIX, "blocked"));
    expect(goal).toContain(`gAD:${PREFIX}`);
    // Goal-level keeps its historical Resume next to Stop on a true block.
    expect(goal).toContain(`gResume:${PREFIX}`);
  });

  it("Failed surfaces offer Resume and Add Details so the user can retry after fixing", () => {
    const cbs = callbackDataSet(buildTaskBlockedInlineKeyboard(PREFIX, "failed"));
    expect(cbs).toContain(`gStop:${PREFIX}`);
    expect(cbs).toContain(`gResume:${PREFIX}`);
    expect(cbs).toContain(`gAD:${PREFIX}`);
  });

  it("defaults to the blocked keyboard when no category is passed", () => {
    expect(callbackDataSet(buildTaskBlockedInlineKeyboard(PREFIX))).toContain(`gAD:${PREFIX}`);
    expect(callbackDataSet(buildGoalBlockedInlineKeyboard(PREFIX))).toContain(`gResume:${PREFIX}`);
  });

  it("adds a '☑️ Make Decision(s)' button on planning Needs Decision blocks routing to the gAD answer flow", () => {
    const keyboard = buildGoalBlockedInlineKeyboard(PREFIX, "blocked", { planningDecision: true });
    const buttons = (keyboard?.inline_keyboard ?? []).flat() as Array<{
      text: string;
      callback_data: string;
    }>;
    expect(buttons).toHaveLength(1);
    const makeDecisions = buttons.find((btn) => btn.text === "☑️ Make Decision(s)");
    expect(makeDecisions).toBeDefined();
    // Reuses the existing gAD reply/answer flow — no second answer mechanism.
    expect(makeDecisions?.callback_data).toBe(`gAD:${PREFIX}`);
    expect(makeDecisions?.callback_data).toMatch(/^gAD:/);
    expect(buttons.map((btn) => btn.text)).not.toContain("▶️ Resume Goal");
    expect(buttons.map((btn) => btn.text)).not.toContain("⏹️ Stop Goal");
    // A non-planning block keeps the standard Add Details button.
    const standard = (buildGoalBlockedInlineKeyboard(PREFIX, "blocked")?.inline_keyboard ?? [])
      .flat()
      .map((btn) => (btn as { text: string }).text);
    expect(standard).not.toContain("☑️ Make Decision(s)");
    expect(standard).toContain("✏️ Add Details");
    expect(standard).toContain("▶️ Resume Goal");
    expect(standard).toContain("⏹️ Stop Goal");
  });
});

describe("buildBlockedSurfaceCopy", () => {
  const PREFIX = "abc12345";

  it("Blocked copy points to Add Details / answer", () => {
    const copy = buildBlockedSurfaceCopy({
      level: "task",
      category: "blocked",
      runIdPrefix: PREFIX,
      stepId: "build-thing",
    });
    expect(copy.title).toContain("TASK BLOCKED");
    expect(copy.title).toContain("Step build-thing");
    expect(copy.actionHint).toContain("Add Details");
    expect(copy.actionHint).toContain("/goal_answer");
  });

  it("Paused copy points to Resume and does not ask for details", () => {
    const copy = buildBlockedSurfaceCopy({
      level: "task",
      category: "paused",
      runIdPrefix: PREFIX,
      stepId: "build-thing",
    });
    expect(copy.title).toContain("TASK PAUSED");
    expect(copy.actionHint).toContain("Resume");
    expect(copy.actionHint).toContain(`/goal_resume ${PREFIX}`);
    expect(copy.actionHint).not.toContain("Add Details");
  });

  it("Failed copy explains the fix needed", () => {
    const copy = buildBlockedSurfaceCopy({
      level: "goal",
      category: "failed",
      runIdPrefix: PREFIX,
    });
    expect(copy.title).toContain("GOAL FAILED");
    expect(copy.actionHint).toMatch(/fix/i);
    expect(copy.actionHint).toContain("Resume");
    expect(copy.actionHint).toContain("Add Details");
  });

  it("Retrying copy says no action is needed", () => {
    const copy = buildBlockedSurfaceCopy({
      level: "task",
      category: "retrying",
      runIdPrefix: PREFIX,
      stepId: "build-thing",
    });
    expect(copy.title).toContain("TASK RETRYING");
    expect(copy.actionHint).toMatch(/no action needed/i);
  });

  it("renders single and multiple planning decisions in the required multiple-choice format", () => {
    const decisions = [
      {
        id: "target-scope",
        question: "Which scope should this first plan use?",
        options: [
          { key: "A", label: "Only Telegram UI" },
          { key: "B", label: "Telegram UI plus worker context", recommended: true },
        ],
      },
      {
        id: "observation-point",
        question: "Where should the plan stop?",
        options: [
          { key: "A", label: "After unit tests" },
          { key: "B", label: "After live gateway smoke" },
          { key: "C", label: "After manual operator review", recommended: true },
        ],
      },
    ];

    expect(formatPlanningDecisionMarkdown(decisions.slice(0, 1))).toBe(
      [
        "**Decision(s) Needed:**",
        "**Decision 1.** Which scope should this first plan use?",
        "**(A)** Only Telegram UI",
        "**(B)** Telegram UI plus worker context **(Recommended)**",
      ].join("\n"),
    );

    const copy = buildBlockedSurfaceCopy({
      level: "goal",
      category: "blocked",
      runIdPrefix: PREFIX,
      blockedAt: "planning",
      decisions,
    });

    // No separate title heading — the bold "Decision(s) Needed:" in body is the
    // only heading.
    expect(copy.title).toBeUndefined();
    expect(copy.body).toContain("**Decision(s) Needed:**");
    expect(copy.body).toContain("**Decision 1.** Which scope should this first plan use?");
    expect(copy.body).toContain("**(B)** Telegram UI plus worker context **(Recommended)**");
    expect(copy.body).toContain("**Decision 2.** Where should the plan stop?");
    expect(copy.body).toContain("**(C)** After manual operator review **(Recommended)**");
    expect(copy.actionHint).toBe(`**Goal ID:** ${PREFIX}`);
    expect(`${copy.title ?? ""}\n${copy.body}`).not.toMatch(/CLARIFICATION\s+NEEDED/);
  });

  it("renders exactly one 'Decision(s) Needed:' heading and no duplicate 'Decision needed' title", () => {
    const decisions = [
      {
        id: "scope",
        question: "Which scope?",
        options: [
          { key: "A", label: "Narrow" },
          { key: "B", label: "Wide", recommended: true },
        ],
      },
    ];
    const copy = buildBlockedSurfaceCopy({
      level: "goal",
      category: "blocked",
      runIdPrefix: PREFIX,
      blockedAt: "planning",
      decisions,
    });
    const combined = `${copy.title ?? ""}\n${copy.body ?? ""}\n${copy.actionHint}`;
    // Exactly one heading, capital "Needed".
    expect(combined.match(/Decision\(s\) Needed:/g)).toHaveLength(1);
    expect(combined).not.toMatch(/Decision needed/);
    // No all-caps heading.
    expect(combined).not.toMatch(/DECISION\(S\)\s+NEEDED/);
  });

  it("bolds only the fixed markers and keeps question/option text plain", () => {
    const md = formatPlanningDecisionMarkdown([
      {
        id: "scope",
        question: "Which scope?",
        options: [
          { key: "A", label: "Narrow path" },
          { key: "B", label: "Wide path", recommended: true },
        ],
      },
    ]);
    expect(md).toContain("**Decision(s) Needed:**");
    expect(md).toContain("**Decision 1.**");
    expect(md).toContain("**(A)** Narrow path");
    expect(md).toContain("**(B)** Wide path **(Recommended)**");
    // The model-provided question/label text is not wrapped in bold markers.
    expect(md).not.toContain("**Which scope?**");
    expect(md).not.toContain("**Narrow path**");
    expect(md).not.toContain("**Wide path**");
  });

  it("renders '(Recommended)' on the same line as its option", () => {
    const md = formatPlanningDecisionMarkdown([
      {
        id: "scope",
        question: "Which scope?",
        options: [
          { key: "A", label: "Narrow" },
          { key: "B", label: "Wide", recommended: true },
        ],
      },
    ]);
    const recommendedLine = md.split("\n").find((line) => line.includes("(Recommended)"));
    expect(recommendedLine).toBe("**(B)** Wide **(Recommended)**");
  });

  it("emits compact output with no blank-line-heavy formatting", () => {
    const md = formatPlanningDecisionMarkdown([
      {
        id: "one",
        question: "Q1?",
        options: [
          { key: "A", label: "a" },
          { key: "B", label: "b" },
        ],
      },
      {
        id: "two",
        question: "Q2?",
        options: [
          { key: "A", label: "c" },
          { key: "B", label: "d" },
        ],
      },
    ]);
    // No blank-line separators between decisions.
    expect(md).not.toContain("\n\n");
  });

  it("converts the bold planning markers to <b> via markdownToTelegramHtml", () => {
    const copy = buildBlockedSurfaceCopy({
      level: "goal",
      category: "blocked",
      runIdPrefix: PREFIX,
      blockedAt: "planning",
      decisions: [
        {
          id: "scope",
          question: "Which scope?",
          options: [
            { key: "A", label: "Narrow" },
            { key: "B", label: "Wide", recommended: true },
          ],
        },
      ],
    });
    const html = markdownToTelegramHtml(copy.body ?? "");
    expect(html).toContain("<b>Decision(s) Needed:</b>");
    expect(html).toContain("<b>Decision 1.</b>");
    expect(html).toContain("<b>(A)</b>");
    expect(html).toContain("<b>(B)</b>");
    expect(html).toContain("<b>(Recommended)</b>");
  });

  it("lets Telegram HTML rendering escape model-provided decision text", () => {
    const copy = buildBlockedSurfaceCopy({
      level: "goal",
      category: "blocked",
      runIdPrefix: PREFIX,
      blockedAt: "planning",
      decisions: [
        {
          id: "unsafe-text",
          question: "Use <script>?",
          options: [{ key: "A", label: "Keep <b>literal</b>", recommended: true }],
        },
      ],
    });

    const html = markdownToTelegramHtml(`${copy.title ?? ""}\n\n${copy.body ?? ""}`);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;literal&lt;/b&gt;");
    expect(html).not.toContain("<script>");
  });
});

describe("classifyBlockedNotification", () => {
  function step(overrides: Partial<PlanStep> & { id: string }): PlanStep {
    return {
      description: `Step ${overrides.id}`,
      shortSummary: `Step ${overrides.id}`,
      dependsOn: [],
      status: "blocked",
      ...overrides,
    };
  }
  const detail = (
    over: Partial<BlockedDetail> = {},
  ): Pick<BlockedDetail, "stepId" | "requiredInputKey"> => ({
    requiredInputKey: "task:s1:input",
    ...over,
  });

  it("treats any user-input key as blocked, even when the step is already done", () => {
    // A final build-gate escalation blocks a completed step but still needs input.
    const steps = [step({ id: "s1", status: "done" })];
    expect(classifyBlockedNotification(steps, detail({ stepId: "s1" }))).toBe("blocked");
  });

  it("splits the resume_execution bucket into paused vs failed by reason", () => {
    const paused = [step({ id: "s1", blockedReason: "rate_limit" })];
    expect(
      classifyBlockedNotification(
        paused,
        detail({ stepId: "s1", requiredInputKey: "resume_execution" }),
      ),
    ).toBe("paused");

    const failed = [step({ id: "s1", blockedReason: "auth" })];
    expect(
      classifyBlockedNotification(
        failed,
        detail({ stepId: "s1", requiredInputKey: "resume_execution" }),
      ),
    ).toBe("failed");
  });

  it("classifies a genuine user-input block as blocked", () => {
    const steps = [step({ id: "s1", blockedReason: "user_input" })];
    expect(classifyBlockedNotification(steps, detail({ stepId: "s1" }))).toBe("blocked");
  });

  it("treats a resume_execution goal-level block as paused when no step is classifiable", () => {
    expect(classifyBlockedNotification([], detail({ requiredInputKey: "resume_execution" }))).toBe(
      "paused",
    );
  });
});
