import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SerializedRun } from "../goal/types.js";

let testGoalsDir: string;

vi.mock("../goal/run-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../goal/run-store.js")>();
  return {
    ...actual,
    resolveGoalsDir: () => testGoalsDir,
    listRuns: (dir?: string) => actual.listRuns(dir ?? testGoalsDir),
    loadRun: (id: string, dir?: string) => actual.loadRun(id, dir ?? testGoalsDir),
    saveRun: (run: SerializedRun, dir?: string) => actual.saveRun(run, dir ?? testGoalsDir),
  };
});

function createTestRun(
  runId: string,
  planMessage?: { chatId: number; messageId: number; messageHistory?: number[] },
): void {
  const runDir = path.join(testGoalsDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const run: Partial<SerializedRun> = {
    runId,
    goal: "test goal",
    state: "awaiting_approval",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    plan: { summary: "test", steps: [] },
    stepResults: {},
    answers: {},
  };
  if (planMessage) {
    (run as SerializedRun).telegramPlanMessage = {
      chatId: planMessage.chatId,
      messageId: planMessage.messageId,
      messageHistory: planMessage.messageHistory ?? [],
    };
  }
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify(run));
}

beforeEach(() => {
  testGoalsDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-msg-idx-test-"));
});

afterEach(async () => {
  // Reset the module-level singleton between tests
  const { resetMessageIndex } = await import("./goal-message-index.js");
  resetMessageIndex();
  fs.rmSync(testGoalsDir, { recursive: true, force: true });
});

describe("findRunByPlanMessageIdIndexed", () => {
  it("lazily populates from disk and finds a run", async () => {
    createTestRun("run-aaa", { chatId: 100, messageId: 42 });

    const { findRunByPlanMessageIdIndexed } = await import("./goal-message-index.js");
    const run = findRunByPlanMessageIdIndexed(100, 42);
    expect(run).toBeDefined();
    expect(run!.runId).toBe("run-aaa");
  });

  it("finds runs by history messageId", async () => {
    createTestRun("run-bbb", { chatId: 200, messageId: 50, messageHistory: [48, 49] });

    const { findRunByPlanMessageIdIndexed } = await import("./goal-message-index.js");
    const run = findRunByPlanMessageIdIndexed(200, 48);
    expect(run).toBeDefined();
    expect(run!.runId).toBe("run-bbb");
  });

  it("returns undefined for non-matching messageId", async () => {
    createTestRun("run-ccc", { chatId: 300, messageId: 60 });

    const { findRunByPlanMessageIdIndexed } = await import("./goal-message-index.js");
    const run = findRunByPlanMessageIdIndexed(300, 999);
    expect(run).toBeUndefined();
  });

  it("returns undefined for non-matching chatId", async () => {
    createTestRun("run-ddd", { chatId: 400, messageId: 70 });

    const { findRunByPlanMessageIdIndexed } = await import("./goal-message-index.js");
    const run = findRunByPlanMessageIdIndexed(999, 70);
    expect(run).toBeUndefined();
  });
});

describe("indexPlanMessage (write-through)", () => {
  it("indexes a new message for immediate lookup", async () => {
    const { findRunByPlanMessageIdIndexed, indexPlanMessage } =
      await import("./goal-message-index.js");

    // Create a run on disk (without plan message)
    createTestRun("run-eee");

    // Manually update the run to have a plan message and write-through
    const runDir = path.join(testGoalsDir, "run-eee");
    const runData = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8"));
    runData.telegramPlanMessage = { chatId: 500, messageId: 80, messageHistory: [] };
    fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify(runData));

    // Write-through to index
    indexPlanMessage(500, 80, "run-eee");

    const run = findRunByPlanMessageIdIndexed(500, 80);
    expect(run).toBeDefined();
    expect(run!.runId).toBe("run-eee");
  });

  it("indexes old messageId when provided", async () => {
    const { findRunByPlanMessageIdIndexed, indexPlanMessage } =
      await import("./goal-message-index.js");

    createTestRun("run-fff");
    const runDir = path.join(testGoalsDir, "run-fff");
    const runData = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8"));
    runData.telegramPlanMessage = { chatId: 600, messageId: 90, messageHistory: [85] };
    fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify(runData));

    indexPlanMessage(600, 90, "run-fff", 85);

    // Both new and old messageIds should be indexed
    expect(findRunByPlanMessageIdIndexed(600, 90)?.runId).toBe("run-fff");
    expect(findRunByPlanMessageIdIndexed(600, 85)?.runId).toBe("run-fff");
  });
});

describe("cache miss fallback", () => {
  it("falls back to full scan when index misses", async () => {
    const { findRunByPlanMessageIdIndexed } = await import("./goal-message-index.js");

    // Populate index first (empty)
    findRunByPlanMessageIdIndexed(999, 999);

    // Now create a run after initial population
    createTestRun("run-late", { chatId: 700, messageId: 100 });

    // Should fall through to full scan and find it
    const run = findRunByPlanMessageIdIndexed(700, 100);
    expect(run).toBeDefined();
    expect(run!.runId).toBe("run-late");
  });
});
