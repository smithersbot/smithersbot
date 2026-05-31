import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  WORKER_AGENTS_CONTEXT,
  WORKER_AGENTS_CONTEXT_FILE,
  WORKER_CLAUDE_CONTEXT,
  WORKER_CLAUDE_CONTEXT_FILE,
  WORKER_CONTEXT,
  WORKER_CONTEXT_DIR,
  SHARED_WORKER_CONTRACT_FILE,
  resolveSharedWorkerContractPath,
  resolveWorkerAgentsContextPath,
  resolveWorkerClaudeContextPath,
} from "./worker-context.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..", "..");
const workerContextDir = path.join(repoRoot, "src", "goal", "worker-context");

describe("src/goal/worker-context — backend unification", () => {
  it("WORKER_CONTEXT_DIR resolves to src/goal/worker-context in source", () => {
    // src/prompts/worker/worker-context.ts uses `../../goal/worker-context` so
    // both source and dist resolve to the same logical location.
    expect(WORKER_CONTEXT_DIR.endsWith(path.join("goal", "worker-context"))).toBe(true);
    expect(fs.existsSync(WORKER_CONTEXT_DIR)).toBe(true);
  });

  it("loads the canonical shared contract from disk", () => {
    const sharedPath = resolveSharedWorkerContractPath();
    expect(path.basename(sharedPath)).toBe(SHARED_WORKER_CONTRACT_FILE);
    expect(fs.existsSync(sharedPath)).toBe(true);
    expect(fs.readFileSync(sharedPath, "utf8")).toBe(WORKER_CONTEXT);
  });

  it("AGENTS.md and CLAUDE.md mirror the shared contract byte-for-byte", () => {
    const shared = fs.readFileSync(resolveSharedWorkerContractPath(), "utf8");
    const agents = fs.readFileSync(resolveWorkerAgentsContextPath(), "utf8");
    const claude = fs.readFileSync(resolveWorkerClaudeContextPath(), "utf8");
    expect(agents).toBe(shared);
    expect(claude).toBe(shared);
  });

  it("source-tree AGENTS.md, CLAUDE.md, and shared contract are byte-identical", () => {
    const shared = fs.readFileSync(
      path.join(workerContextDir, SHARED_WORKER_CONTRACT_FILE),
      "utf8",
    );
    const agents = fs.readFileSync(path.join(workerContextDir, WORKER_AGENTS_CONTEXT_FILE), "utf8");
    const claude = fs.readFileSync(path.join(workerContextDir, WORKER_CLAUDE_CONTEXT_FILE), "utf8");
    expect(agents).toBe(shared);
    expect(claude).toBe(shared);
  });

  it("Claude and Codex contexts are byte-identical (no backend-specific appendix)", () => {
    expect(WORKER_CLAUDE_CONTEXT).toBe(WORKER_AGENTS_CONTEXT);
    expect(WORKER_CLAUDE_CONTEXT).toBe(WORKER_CONTEXT);
  });

  it("merges the rules previously split across CLAUDE.md and AGENTS.md", () => {
    // Rules that historically lived only on the AGENTS.md side.
    expect(WORKER_CONTEXT).toContain("You execute ONE task from a larger plan");
    expect(WORKER_CONTEXT).toContain("### When to Ralph");
    expect(WORKER_CONTEXT).toContain("Write production-quality code");

    // Rules that historically lived only on the CLAUDE.md side.
    expect(WORKER_CONTEXT).toContain("Use strict typing where possible");
    expect(WORKER_CONTEXT).toContain(
      "Do not add, remove, or upgrade dependencies unless the task explicitly requires it",
    );
    expect(WORKER_CONTEXT).toContain("Do not edit `node_modules/`");
    expect(WORKER_CONTEXT).toContain(
      "Make small, scoped commits with clear, action-oriented messages",
    );
    expect(WORKER_CONTEXT).toContain("Never commit secrets, credentials, tokens");
  });

  it("includes strengthened Stage 2Q verification rules and gateway-restart guard", () => {
    const needles = [
      "Task SUCCESS CRITERIA are the minimum bar, not the full verification contract.",
      "Every code-changing task must include implementation, focused tests, and verification inside the **same task**.",
      "Do not split implementation and tests into separate tasks unless the task is explicitly a final cross-cutting verification sweep.",
      "Run the smallest relevant test slice",
      "pnpm exec tsc -p tsconfig.json",
      "pnpm build",
      "pnpm lint",
      "Before reporting completion, list the exact verification commands you ran",
      "never restart, reinstall, stop, enable, disable, or otherwise modify the stable/default `smithersbot-gateway.service`",
      "Only for SmithersBot runtime changes in the SmithersBot dev checkout may workers restart or inspect `smithersbot-dev-gateway.service`",
      "`node ./smithersbot.mjs dev-gateway restart|status|logs`",
    ];
    for (const needle of needles) {
      expect(WORKER_CONTEXT).toContain(needle);
    }
  });

  it("preserves result-protocol and security rules required by Stage 2O/2P", () => {
    expect(WORKER_CONTEXT).toContain(
      "report completion through the result protocol you were given",
    );
    expect(WORKER_CONTEXT).toContain("Use fake placeholders in tests and examples");
    expect(WORKER_CONTEXT).toContain("`.env*`, `*.pem`, `*.key`, `credentials*`");
  });
});
