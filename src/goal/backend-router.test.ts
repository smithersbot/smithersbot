import { describe, expect, it, vi, beforeEach } from "vitest";
import type { BackendAvailability } from "./backend-types.js";
import type { PlanStep } from "./types.js";
import {
  classifyTask,
  detectBackendAvailability,
  resetAvailabilityCache,
  resolveBackendForStep,
} from "./backend-router.js";

// Mock execFileSync for probing
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn((binary: string) => {
    if (binary === "codex") {
      return "--sandbox --output-schema --ask-for-approval";
    }
    if (binary === "claude") {
      return "--allowedTools --append-system-prompt --output-format";
    }
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }),
}));

function makeStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id: "test-step",
    description: "Implement the auth module",
    dependsOn: [],
    status: "pending",
    ...overrides,
  };
}

const ALL_AVAILABLE: BackendAvailability[] = [
  { id: "pi", available: true },
  { id: "codex", available: true },
  { id: "claude_code", available: true },
];

const CODEX_UNAVAILABLE: BackendAvailability[] = [
  { id: "pi", available: true },
  { id: "codex", available: false, reason: "codex not found" },
  { id: "claude_code", available: true },
];

const ONLY_PI: BackendAvailability[] = [
  { id: "pi", available: true },
  { id: "codex", available: false, reason: "codex not found" },
  { id: "claude_code", available: false, reason: "claude not found" },
];

describe("backend-router", () => {
  beforeEach(() => {
    resetAvailabilityCache();
  });

  describe("classifyTask", () => {
    it("classifies code tasks", () => {
      expect(classifyTask(makeStep({ description: "Implement the auth module" }))).toBe("code");
      expect(classifyTask(makeStep({ description: "Refactor the payment flow" }))).toBe("code");
    });

    it("classifies test tasks", () => {
      expect(classifyTask(makeStep({ description: "Write tests for the auth module" }))).toBe(
        "test",
      );
      expect(classifyTask(makeStep({ description: "Add vitest coverage" }))).toBe("test");
    });

    it("classifies docs tasks", () => {
      expect(classifyTask(makeStep({ description: "Update the README" }))).toBe("docs");
      expect(classifyTask(makeStep({ description: "Write documentation for the API" }))).toBe(
        "docs",
      );
    });

    it("classifies analysis tasks", () => {
      expect(classifyTask(makeStep({ description: "Analyze the performance" }))).toBe("analysis");
      expect(classifyTask(makeStep({ description: "Investigate the build failure" }))).toBe(
        "analysis",
      );
    });

    it("classifies general tasks", () => {
      expect(classifyTask(makeStep({ description: "Set up the project" }))).toBe("general");
    });
  });

  describe("detectBackendAvailability", () => {
    it("detects all backends when binaries + flags present", () => {
      const results = detectBackendAvailability();
      expect(results).toHaveLength(3);
      expect(results.find((r) => r.id === "pi")?.available).toBe(true);
      expect(results.find((r) => r.id === "codex")?.available).toBe(true);
      expect(results.find((r) => r.id === "claude_code")?.available).toBe(true);
    });

    it("caches results across calls", () => {
      const first = detectBackendAvailability();
      const second = detectBackendAvailability();
      expect(first).toBe(second);
    });

    it("marks binary not found as unavailable", async () => {
      const { execFileSync } = vi.mocked(await import("node:child_process"));
      execFileSync.mockImplementation((_binary: string) => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
      resetAvailabilityCache();
      const results = detectBackendAvailability();
      expect(results.find((r) => r.id === "codex")?.available).toBe(false);
      expect(results.find((r) => r.id === "codex")?.reason).toContain("not found");
    });

    it("marks missing flags as unavailable with reason", async () => {
      const { execFileSync } = vi.mocked(await import("node:child_process"));
      execFileSync.mockImplementation((binary: string) => {
        if (binary === "codex") return "--sandbox"; // missing --output-schema
        if (binary === "claude") return "--allowedTools --append-system-prompt";
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
      resetAvailabilityCache();
      const results = detectBackendAvailability();
      expect(results.find((r) => r.id === "codex")?.available).toBe(false);
      expect(results.find((r) => r.id === "codex")?.reason).toContain("--output-schema");
    });
  });

  describe("resolveBackendForStep", () => {
    it("override wins over everything", () => {
      const step = makeStep({ executedBackend: "pi", preferredBackend: "codex" });
      expect(resolveBackendForStep(step, ALL_AVAILABLE, "claude_code")).toBe("claude_code");
    });

    it("executedBackend stickiness on retry/resume", () => {
      const step = makeStep({ executedBackend: "codex", preferredBackend: "claude_code" });
      expect(resolveBackendForStep(step, ALL_AVAILABLE)).toBe("codex");
    });

    it("executedBackend sticks even when that backend becomes unavailable", () => {
      const step = makeStep({ executedBackend: "codex" });
      expect(resolveBackendForStep(step, CODEX_UNAVAILABLE)).toBe("codex");
    });

    it("preferredBackend honored when available", () => {
      const step = makeStep({ preferredBackend: "codex" });
      expect(resolveBackendForStep(step, ALL_AVAILABLE)).toBe("codex");
    });

    it("preferredBackend skipped when unavailable, falls to classification", () => {
      const step = makeStep({
        description: "Write documentation for the API",
        preferredBackend: "codex",
      });
      // codex unavailable, docs classification → claude_code
      expect(resolveBackendForStep(step, CODEX_UNAVAILABLE)).toBe("claude_code");
    });

    it("classification default: code → codex", () => {
      const step = makeStep({ description: "Implement the auth module" });
      expect(resolveBackendForStep(step, ALL_AVAILABLE)).toBe("codex");
    });

    it("classification default: test → codex", () => {
      const step = makeStep({ description: "Write tests for the API" });
      expect(resolveBackendForStep(step, ALL_AVAILABLE)).toBe("codex");
    });

    it("classification default: docs → claude_code", () => {
      const step = makeStep({ description: "Update documentation" });
      expect(resolveBackendForStep(step, ALL_AVAILABLE)).toBe("claude_code");
    });

    it("classification default: analysis → claude_code", () => {
      const step = makeStep({ description: "Analyze the codebase" });
      expect(resolveBackendForStep(step, ALL_AVAILABLE)).toBe("claude_code");
    });

    it("fallback chain: codex unavailable → claude_code", () => {
      const step = makeStep({ description: "Implement something" });
      expect(resolveBackendForStep(step, CODEX_UNAVAILABLE)).toBe("claude_code");
    });

    it("fallback chain: all CLIs unavailable → pi", () => {
      const step = makeStep({ description: "Implement something" });
      expect(resolveBackendForStep(step, ONLY_PI)).toBe("pi");
    });
  });
});
