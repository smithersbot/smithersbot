import { describe, expect, it } from "vitest";

import type { BlockedDetail, PlanStep } from "../goal/types.js";
import { markdownToTelegramHtml } from "./format.js";
import {
  buildBlockedCaption,
  buildBlockedSurfaceCopy,
  buildGoalBlockedInlineKeyboard,
  buildTaskBlockedInlineKeyboard,
  classifyBlockedNotification,
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
