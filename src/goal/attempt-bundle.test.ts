import { describe, expect, it } from "vitest";
import { formatAttemptBundleSummary, type AttemptBundle } from "./attempt-bundle.js";

describe("attempt-bundle", () => {
  describe("formatAttemptBundleSummary", () => {
    it("renders ralph and build-gate failure context", () => {
      const bundle: AttemptBundle = {
        attemptNumber: 2,
        backend: "codex",
        outcome: "ralph",
        durationMs: 2_500,
        ralphDetail: {
          approachTried: "Fixed 30 import paths by hand",
          specificErrors: "20 unresolved module errors still remained",
          keyInsight: "Build requires a generator step before import cleanup",
          suggestedApproach: "Run the generator, then fix import leftovers",
        },
        buildGateFailure: {
          failedCommand: "pnpm build",
          output: "Cannot find module ./generated/client",
        },
      };

      const summary = formatAttemptBundleSummary(bundle);

      expect(summary).toContain("Ralph details:");
      expect(summary).toContain("Approach tried: Fixed 30 import paths by hand");
      expect(summary).toContain(
        "Key insight: Build requires a generator step before import cleanup",
      );
      expect(summary).toContain("Suggested approach: Run the generator, then fix import leftovers");
      expect(summary).toContain("Build gate failure:");
      expect(summary).toContain("Failed command: pnpm build");
      expect(summary).toContain("Build gate output:");
      expect(summary).toContain("Cannot find module ./generated/client");
    });
  });
});
