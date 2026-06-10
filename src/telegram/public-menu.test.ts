import { describe, expect, it } from "vitest";

import { buildPublicTelegramMenu, PUBLIC_TELEGRAM_MENU } from "./public-menu.js";

describe("PUBLIC_TELEGRAM_MENU goal_secrets", () => {
  it("contains a goal_secrets entry under the 'Goal diagnostics & tuning' label", () => {
    const entry = PUBLIC_TELEGRAM_MENU.find((command) => command.command === "goal_secrets");
    expect(entry).toBeDefined();
    expect(entry?.label).toBe("Goal diagnostics & tuning");
  });

  it("includes goal_secrets in buildPublicTelegramMenu's output", () => {
    const menu = buildPublicTelegramMenu([
      { command: "goal_secrets", description: "x" },
      { command: "not_public", description: "y" },
    ]);
    expect(menu.map((command) => command.command)).toContain("goal_secrets");
  });
});
