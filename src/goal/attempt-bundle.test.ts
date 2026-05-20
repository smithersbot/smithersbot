import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatAttemptBundleSummary,
  writeAttemptBundle,
  type AttemptBundle,
} from "./attempt-bundle.js";

const FAKE_SECRET = "FAKE_TELEGRAM_SECRET_123";

describe("attempt-bundle", () => {
  let tmpDir: string | undefined;
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previousToken;
  });

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
    expect(summary).toContain("Key insight: Build requires a generator step before import cleanup");
    expect(summary).toContain("Suggested approach: Run the generator, then fix import leftovers");
    expect(summary).toContain("Build gate failure:");
    expect(summary).toContain("Failed command: pnpm build");
    expect(summary).toContain("Build gate output:");
    expect(summary).toContain("Cannot find module ./generated/client");
  });

  it("redacts known secret values in persisted log excerpts", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "attempt-bundle-redact-"));
    process.env.TELEGRAM_BOT_TOKEN = FAKE_SECRET;

    writeAttemptBundle(tmpDir, {
      attemptNumber: 1,
      backend: "codex",
      outcome: "failed",
      logExcerpt: `stdout leaked ${FAKE_SECRET}`,
      buildGateFailure: {
        failedCommand: "pnpm test",
        output: `stderr leaked ${FAKE_SECRET}`,
      },
      durationMs: 10,
    });

    const persisted = fs.readFileSync(path.join(tmpDir, "attempt-1.json"), "utf8");
    expect(persisted).toContain("[REDACTED]");
    expect(persisted).not.toContain(FAKE_SECRET);
  });
});
