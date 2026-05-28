import { describe, expect, it } from "vitest";
import { isGoalTestScopeEnabled, resolveRuns } from "../../scripts/test-parallel.mjs";

describe("scripts/test-parallel goal scope", () => {
  it("keeps full-suite run groups by default when scope is unset", () => {
    const runs = resolveRuns({} as NodeJS.ProcessEnv);
    expect(runs.map((run) => run.name)).toEqual(["unit", "extensions", "gateway"]);
  });

  it("switches to goal-focused subset when scoped mode is enabled", () => {
    const runs = resolveRuns({ MOLTBOT_GOAL_TEST_SCOPE: "1" } as NodeJS.ProcessEnv);
    expect(isGoalTestScopeEnabled({ MOLTBOT_GOAL_TEST_SCOPE: "1" } as NodeJS.ProcessEnv)).toBe(
      true,
    );
    expect(runs.map((run) => run.name)).toEqual(["goal"]);
    expect(runs[0]?.args).toContain("src/goal/**/*.test.ts");
    expect(runs[0]?.args).toContain("src/commands/goal*.test.ts");
  });
});
