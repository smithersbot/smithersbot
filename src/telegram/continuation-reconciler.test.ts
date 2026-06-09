import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hasCurrentDeliveredSurface } from "../goal/continuation-delivery.js";
import { acquireGoalOpLock } from "../goal/goal-lock.js";
import { loadRun, saveRun } from "../goal/run-store.js";
import type { ContinuationProposal, Plan, SerializedRun } from "../goal/types.js";
import { reconcileContinuationSurface } from "./continuation-reconciler.js";

let testGoalsDir: string;

vi.mock("../goal/run-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../goal/run-store.js")>();
  return {
    ...actual,
    resolveGoalsDir: () => testGoalsDir,
    listRuns: (dir?: string) => actual.listRuns(dir ?? testGoalsDir),
    loadRun: (id: string, dir?: string) => actual.loadRun(id, dir ?? testGoalsDir),
    saveRun: (run: SerializedRun, dir?: string) => actual.saveRun(run, dir ?? testGoalsDir),
    resolveRunId: (partial: string, dir?: string) =>
      actual.resolveRunId(partial, dir ?? testGoalsDir),
  };
});

const RUN_ID = "aaaaaaaa-1111-2222-3333-444444444444";
const PROPOSAL_ID = "bbbbbbbb-2222-3333-4444-555555555555";
const OLD_PROPOSAL_ID = "cccccccc-3333-4444-5555-666666666666";

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    goal: "Continue a goal",
    workingDir: "/tmp/ws",
    summary: "Plan summary",
    shortSummary: "Plan summary",
    steps: [],
    ...overrides,
  };
}

function proposal(overrides: Partial<ContinuationProposal> = {}): ContinuationProposal {
  return {
    proposalId: PROPOSAL_ID,
    fromPlanNumber: 1,
    fromRevision: 3,
    goalAchieved: false,
    briefSummary: "Continue verification.",
    proposedPrompt: "Draft the next verification plan.",
    runAt: "now",
    status: "pending",
    createdAt: "2026-05-31T12:00:00.000Z",
    ...overrides,
  };
}

function run(overrides: Partial<SerializedRun> = {}): SerializedRun {
  return {
    runId: RUN_ID,
    goal: "Continue a goal",
    state: "planning",
    plan: plan(),
    stepResults: {},
    blocked: null,
    answers: {},
    workingDir: "/tmp/ws",
    model: undefined,
    dryRun: false,
    createdAt: "2026-05-31T00:00:00.000Z",
    updatedAt: "2026-05-31T00:00:00.000Z",
    planRevision: 3,
    activePlanRevision: 3,
    planNumber: 1,
    pendingContinuation: proposal(),
    telegramDoneMessage: { chatId: 42, messageId: 500, threadId: 12 },
    ...overrides,
  };
}

function makeHarness(sendMessage = vi.fn().mockResolvedValue({ message_id: 700 })) {
  const bot = {
    api: {
      sendMessage,
    },
  } as unknown as import("grammy").Bot;
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: ((_: number) => {
      throw new Error("exit called");
    }) as never,
  };
  return { bot, runtime, sendMessage };
}

function sentReplyMarkup(sendMessage: ReturnType<typeof vi.fn>) {
  return sendMessage.mock.calls.at(-1)?.[2]?.reply_markup;
}

describe("continuation reconciler", () => {
  beforeEach(() => {
    testGoalsDir = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-reconciler-"));
  });

  afterEach(() => {
    fs.rmSync(testGoalsDir, { recursive: true, force: true });
  });

  it("detects when the current pendingContinuation has no delivered surface", () => {
    const stored = run();
    expect(hasCurrentDeliveredSurface(stored)).toBe(false);
  });

  it("counts delivered surfaces as current only when proposalId matches the live proposal", () => {
    expect(
      hasCurrentDeliveredSurface(
        run({
          continuationDelivery: {
            proposalId: PROPOSAL_ID,
            chatId: 42,
            messageId: 700,
            deliveredAt: "2026-05-31T12:01:00.000Z",
          },
        }),
      ),
    ).toBe(true);

    expect(
      hasCurrentDeliveredSurface(
        run({
          continuationDelivery: {
            proposalId: OLD_PROPOSAL_ID,
            chatId: 42,
            messageId: 699,
            deliveredAt: "2026-05-31T12:01:00.000Z",
          },
        }),
      ),
    ).toBe(false);
  });

  it("sends a fresh surface and persists delivered message and notify metadata", async () => {
    saveRun(run());
    const harness = makeHarness();

    const result = await reconcileContinuationSurface({
      runId: RUN_ID,
      bot: harness.bot,
      runtime: harness.runtime,
    });

    expect(result).toEqual({ status: "sent", messageId: 700, proposalId: PROPOSAL_ID });
    expect(harness.sendMessage).toHaveBeenCalledTimes(1);
    const stored = loadRun(RUN_ID)!;
    expect(stored.continuationDelivery).toMatchObject({
      proposalId: PROPOSAL_ID,
      chatId: 42,
      messageId: 700,
      threadId: 12,
    });
    expect(stored.continuationDelivery?.failed).toBeUndefined();
    expect(stored.continuationDelivery?.deliveredAt).toEqual(expect.any(String));
    expect(stored.pendingContinuation?.notify).toEqual({
      chatId: 42,
      messageId: 700,
      threadId: 12,
    });
    expect(JSON.stringify(sentReplyMarkup(harness.sendMessage))).toContain("bbbbbbbb");
  });

  it("uses the injected callback chat before stored Telegram context", async () => {
    saveRun(run());
    const harness = makeHarness();

    await reconcileContinuationSurface({
      runId: RUN_ID,
      bot: harness.bot,
      runtime: harness.runtime,
      chat: { chatId: 99, threadId: 3 },
    });

    expect(harness.sendMessage.mock.calls[0]?.[0]).toBe(99);
    expect(harness.sendMessage.mock.calls[0]?.[2]).toMatchObject({
      message_thread_id: 3,
    });
    expect(loadRun(RUN_ID)?.continuationDelivery).toMatchObject({
      chatId: 99,
      threadId: 3,
    });
  });

  it("resends when the delivered marker belongs to an old proposalId", async () => {
    saveRun(
      run({
        continuationDelivery: {
          proposalId: OLD_PROPOSAL_ID,
          chatId: 42,
          messageId: 699,
          deliveredAt: "2026-05-31T12:01:00.000Z",
        },
      }),
    );
    const harness = makeHarness();

    await reconcileContinuationSurface({
      runId: RUN_ID,
      bot: harness.bot,
      runtime: harness.runtime,
    });

    expect(harness.sendMessage).toHaveBeenCalledTimes(1);
    expect(loadRun(RUN_ID)?.continuationDelivery).toMatchObject({
      proposalId: PROPOSAL_ID,
      messageId: 700,
    });
    expect(JSON.stringify(sentReplyMarkup(harness.sendMessage))).toContain("bbbbbbbb");
  });

  it("is idempotent when the current surface is already delivered", async () => {
    saveRun(
      run({
        continuationDelivery: {
          proposalId: PROPOSAL_ID,
          chatId: 42,
          messageId: 700,
          deliveredAt: "2026-05-31T12:01:00.000Z",
        },
      }),
    );
    const harness = makeHarness();

    const first = await reconcileContinuationSurface({
      runId: RUN_ID,
      bot: harness.bot,
      runtime: harness.runtime,
    });
    const second = await reconcileContinuationSurface({
      runId: RUN_ID,
      bot: harness.bot,
      runtime: harness.runtime,
    });

    expect(first).toEqual({ status: "noop", reason: "already_delivered" });
    expect(second).toEqual({ status: "noop", reason: "already_delivered" });
    expect(harness.sendMessage).not.toHaveBeenCalled();
  });

  it("does not double-post on repeated reconcile calls unless forced", async () => {
    saveRun(run());
    const harness = makeHarness();

    await reconcileContinuationSurface({
      runId: RUN_ID,
      bot: harness.bot,
      runtime: harness.runtime,
    });
    await reconcileContinuationSurface({
      runId: RUN_ID,
      bot: harness.bot,
      runtime: harness.runtime,
    });
    await reconcileContinuationSurface({
      runId: RUN_ID,
      bot: harness.bot,
      runtime: harness.runtime,
      force: true,
    });

    expect(harness.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("persists a delivery failure marker when send fails", async () => {
    saveRun(run());
    const harness = makeHarness(vi.fn().mockRejectedValue(new Error("message unavailable")));

    const result = await reconcileContinuationSurface({
      runId: RUN_ID,
      bot: harness.bot,
      runtime: harness.runtime,
    });

    expect(result).toEqual({
      status: "failed",
      proposalId: PROPOSAL_ID,
      error: "message unavailable",
    });
    expect(loadRun(RUN_ID)?.continuationDelivery).toMatchObject({
      proposalId: PROPOSAL_ID,
      chatId: 42,
      threadId: 12,
      failed: true,
      error: "message unavailable",
    });
  });

  it("clears a prior failure marker after a successful retry", async () => {
    saveRun(
      run({
        continuationDelivery: {
          proposalId: PROPOSAL_ID,
          chatId: 42,
          threadId: 12,
          failed: true,
          error: "message unavailable",
          failedAt: "2026-05-31T12:01:00.000Z",
        },
      }),
    );
    const harness = makeHarness();

    await reconcileContinuationSurface({
      runId: RUN_ID,
      bot: harness.bot,
      runtime: harness.runtime,
    });

    const stored = loadRun(RUN_ID)!;
    expect(stored.continuationDelivery).toMatchObject({
      proposalId: PROPOSAL_ID,
      messageId: 700,
    });
    expect(stored.continuationDelivery?.failed).toBeUndefined();
    expect(stored.continuationDelivery?.error).toBeUndefined();
    expect(stored.continuationDelivery?.failedAt).toBeUndefined();
  });

  it("delivers while the caller already holds the run lock in held-lock mode", async () => {
    saveRun(run());
    const harness = makeHarness();
    const held = acquireGoalOpLock(RUN_ID, "resume");
    expect(held.acquired).toBe(true);
    if (!held.acquired) return;

    try {
      const result = await reconcileContinuationSurface({
        runId: RUN_ID,
        bot: harness.bot,
        runtime: harness.runtime,
        assumeRunLockHeld: true,
      });

      expect(result).toEqual({ status: "sent", messageId: 700, proposalId: PROPOSAL_ID });
      expect(result).not.toEqual({ status: "noop", reason: "locked" });
      expect(harness.sendMessage).toHaveBeenCalledTimes(1);
      const stored = loadRun(RUN_ID)!;
      expect(stored.continuationDelivery).toMatchObject({
        proposalId: PROPOSAL_ID,
        chatId: 42,
        messageId: 700,
        threadId: 12,
      });
      expect(stored.pendingContinuation?.notify).toEqual({
        chatId: 42,
        messageId: 700,
        threadId: 12,
      });
    } finally {
      held.release();
    }
  });

  it("persists a failure marker in held-lock mode when sending fails", async () => {
    saveRun(run());
    const harness = makeHarness(vi.fn().mockRejectedValue(new Error("send failed")));
    const held = acquireGoalOpLock(RUN_ID, "resume");
    expect(held.acquired).toBe(true);
    if (!held.acquired) return;

    try {
      const result = await reconcileContinuationSurface({
        runId: RUN_ID,
        bot: harness.bot,
        runtime: harness.runtime,
        assumeRunLockHeld: true,
      });

      expect(result).toEqual({
        status: "failed",
        proposalId: PROPOSAL_ID,
        error: "send failed",
      });
      expect(loadRun(RUN_ID)?.continuationDelivery).toMatchObject({
        proposalId: PROPOSAL_ID,
        failed: true,
        error: "send failed",
      });
    } finally {
      held.release();
    }
  });

  it("does not hold the run lock while sending to Telegram", async () => {
    saveRun(run());
    const sendMessage = vi.fn().mockImplementation(async () => {
      const probe = acquireGoalOpLock(RUN_ID, "probe");
      expect(probe.acquired).toBe(true);
      if (probe.acquired) probe.release();
      return { message_id: 700 };
    });
    const harness = makeHarness(sendMessage);

    await reconcileContinuationSurface({
      runId: RUN_ID,
      bot: harness.bot,
      runtime: harness.runtime,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
