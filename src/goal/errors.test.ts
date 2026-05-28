import { describe, expect, it } from "vitest";
import { classifyGoalError, formatGoalError, GoalLlmError } from "./errors.js";
import { PlanParseError } from "./planner.js";

describe("classifyGoalError", () => {
  it("classifies the codex-helper-missing message", () => {
    const err = new Error(
      "Unable to locate the Codex native binary for codex-linux-sandbox helper.",
    );
    expect(classifyGoalError(err)).toBe("codex-helper-missing");
  });

  it("classifies the claude-sandbox-missing message", () => {
    const err = new Error(
      "sandbox required but unavailable: sandbox is enabled but dependencies are missing: " +
        "socat not installed",
    );
    expect(classifyGoalError(err)).toBe("claude-sandbox-missing");
  });

  it("classifies a codex-backed network failure as codex-network with backend hint", () => {
    const err = new Error("fetch failed");
    expect(classifyGoalError(err, { backend: "codex" })).toBe("codex-network");
  });

  it("classifies a codex-backed auth failure as codex-network when codex is hinted", () => {
    const err = new Error("Please log in to Codex (401 Unauthorized)");
    expect(classifyGoalError(err, { backend: "codex" })).toBe("codex-network");
  });

  it("falls back to generic network when no codex hint is given", () => {
    const err = new Error("fetch failed");
    expect(classifyGoalError(err)).toBe("network");
  });

  it("does not classify a clearly non-Codex network error as codex-network when claude is hinted", () => {
    const err = new Error("fetch failed: ECONNRESET");
    expect(classifyGoalError(err, { backend: "claude_code" })).toBe("network");
  });

  it("propagates a GoalLlmError kind directly", () => {
    const err = new GoalLlmError("boom", "auth");
    expect(classifyGoalError(err)).toBe("auth");
  });

  it("classifies PlanParseError as parse", () => {
    const err = new PlanParseError("bad json", "{ raw }");
    expect(classifyGoalError(err)).toBe("parse");
  });
});

describe("formatGoalError", () => {
  it("(a) emits codex-helper-missing recovery commands for the Codex helper-missing error", () => {
    const err = new Error(
      "Unable to locate the Codex native binary for codex-linux-sandbox helper.",
    );
    const out = formatGoalError(err);
    expect(out).toContain(
      "Planning failed: Unable to locate the Codex native binary for codex-linux-sandbox helper.",
    );
    expect(out).toContain("Try:");
    expect(out).toContain("sudo npm install -g @openai/codex@latest");
    expect(out).toContain("codex login");
    expect(out).toContain('codex "say only: codex works"');
    expect(out).toContain("Then try again.");
  });

  it("(b) emits the codex-network message with recovery commands when codex is hinted", () => {
    const err = new Error("fetch failed");
    const out = formatGoalError(err, undefined, { backend: "codex" });
    expect(out).toContain("Planning failed: Couldn't connect to Codex.");
    expect(out).toContain("Please check your network and try:");
    expect(out).toContain("sudo npm install -g @openai/codex@latest");
    expect(out).toContain("codex login");
    expect(out).toContain('codex "say only: codex works"');
  });

  it("(b) matches a codex-backed auth-shaped failure as codex-network when codex is hinted", () => {
    const err = new Error("401 Unauthorized: please log in");
    const out = formatGoalError(err, undefined, { backend: "codex" });
    expect(out).toContain("Planning failed: Couldn't connect to Codex.");
    expect(out).toContain("sudo npm install -g @openai/codex@latest");
  });

  it("(c) emits the claude-sandbox-missing recovery block for the Claude sandbox failure", () => {
    const err = new Error(
      "sandbox required but unavailable: sandbox is enabled but dependencies are missing: " +
        "socat not installed · install missing tools (e.g. apt install bubblewrap socat)",
    );
    const out = formatGoalError(err);
    expect(out).toContain("Planning failed: Claude Code sandbox is required but unavailable.");
    expect(out).toContain("sudo apt install -y bubblewrap socat");
    expect(out).toContain('claude -p "say only: claude works"');
    expect(out).toContain("Then try again.");
  });

  it("(d) emits the generic network message for non-Codex, non-Claude planner failures", () => {
    const err = new Error("fetch failed: ETIMEDOUT");
    const out = formatGoalError(err);
    expect(out).toBe(
      "Planning failed: Network error reaching the planner API. Check your connection and try again.",
    );
    expect(out).not.toContain("@openai/codex");
    expect(out).not.toContain("codex login");
    expect(out).not.toContain("bubblewrap");
  });

  it("(d) does not append codex recovery commands to a claude-backed network error", () => {
    const err = new Error("ETIMEDOUT reaching api.anthropic.com");
    const out = formatGoalError(err, undefined, { backend: "claude_code" });
    expect(out).toContain(
      "Planning failed: Network error reaching the planner API. Check your connection and try again.",
    );
    expect(out).not.toContain("@openai/codex");
    expect(out).not.toContain("codex login");
  });

  it("formats unclassified errors with the Planning failed prefix", () => {
    const err = new Error("Still rate limited");
    expect(formatGoalError(err)).toBe("Planning failed: Still rate limited");
  });
});
