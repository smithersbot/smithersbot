import { describe, expect, it } from "vitest";

import type { PlanStep } from "../goal/types.js";
import { markdownToTelegramHtml } from "./format.js";
import { buildBlockedCaption } from "./goal-blocked-ui.js";

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
