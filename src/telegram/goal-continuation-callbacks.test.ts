import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { acquireGoalOpLock } from "../goal/goal-lock.js";
import { loadRun, saveRun } from "../goal/run-store.js";
import type { ContinuationProposal, Plan, SerializedRun } from "../goal/types.js";
import {
  clearAllPendingContinuationEditInteractionsForTest,
  getPendingContinuationEditInteraction,
} from "./continuation-edit-interactions.js";

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

const mockRunCliPlanRevision = vi.fn();
const mockRunCliPlanForContinuation = vi.fn();
vi.mock("../goal/cli-planner.js", () => ({
  runCliPlanRevision: (...args: unknown[]) => mockRunCliPlanRevision(...args),
  runCliPlanForContinuation: (...args: unknown[]) => mockRunCliPlanForContinuation(...args),
}));

// The Approve (gca) path delivers the new plan in the background via the goal
// DAG renderer, which shells out to `mmdc` (Mermaid CLI → headless Chromium)
// through a *synchronous, event-loop-blocking* execFileSync. In a no-Chromium
// environment that call blocks until its multi-minute render timeout fires,
// freezing the event loop so even vitest's own test-timeout timer cannot run.
// Stub the rasterizer so it returns instantly with an error — this faithfully
// reproduces production's no-Chromium behavior (graceful text fallback) without
// spawning a real subprocess, keeping these callback-routing unit tests hermetic.
vi.mock("../goal/mermaid-png.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../goal/mermaid-png.js")>();
  return {
    ...actual,
    renderMermaidToPng: () => ({ error: "mermaid rendering disabled in unit tests" }),
  };
});

vi.mock("../goal/git-checkpoint.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../goal/git-checkpoint.js")>();
  return { ...actual, ensureWorkingDir: vi.fn() };
});

vi.mock("../goal/workspace-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../goal/workspace-policy.js")>();
  return { ...actual, assertGoalWorkerWorkspace: vi.fn() };
});

vi.mock("./continuation-client.js", () => ({
  resolveContinuationClient: () => undefined,
}));

const RUN_ID = "aaaaaaaa-1111-2222-3333-444444444444";
const PROPOSAL_ID = "bbbbbbbb-2222-3333-4444-555555555555";

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    goal: "Test continuation",
    workingDir: "/tmp/ws",
    summary: "Plan summary",
    shortSummary: "Plan summary",
    steps: [
      {
        id: "old-step",
        description: "Old step",
        shortSummary: "Old step",
        dependsOn: [],
        status: "done",
        taskSummary: "Completed old work",
      },
    ],
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
    goal: "Test continuation",
    state: "done",
    plan: plan(),
    stepResults: {
      "old-step": {
        stepId: "old-step",
        success: true,
        output: "old output",
        durationMs: 100,
      },
    },
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
    ...overrides,
  };
}

function writeTextArtifact(filePath: string, content: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function withGoalBrief(baseRun: SerializedRun, content: string): SerializedRun {
  const goalBriefPath = writeTextArtifact(
    path.join(testGoalsDir, baseRun.runId, "wiki", "goal-brief.md"),
    content,
  );
  return { ...baseRun, goalBriefPath };
}

function makeHarness() {
  let callbackHandler: ((ctx: unknown, next?: () => Promise<void>) => Promise<void>) | undefined;
  const next = vi.fn();
  const sendMessage = vi.fn().mockResolvedValue({ message_id: 700 });
  const sendPhoto = vi.fn().mockResolvedValue({ message_id: 701 });
  const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
  const setMessageReaction = vi.fn().mockResolvedValue(true);
  const bot = {
    api: {
      sendMessage,
      sendPhoto,
      sendChatAction: vi.fn().mockResolvedValue(true),
      answerCallbackQuery,
      setMessageReaction,
    },
    command: vi.fn(),
    on: (event: string, handler: (ctx: unknown, next?: () => Promise<void>) => Promise<void>) => {
      if (event === "callback_query:data") callbackHandler = handler;
    },
  } as unknown as import("grammy").Bot;
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: ((_: number) => {
      throw new Error("exit called");
    }) as never,
  };
  return {
    sendMessage,
    sendPhoto,
    answerCallbackQuery,
    setMessageReaction,
    next,
    async register() {
      const { registerTelegramGoalCommands } = await import("./goal-commands.js");
      registerTelegramGoalCommands({
        bot,
        cfg: {} as never,
        runtime,
        accountId: "default",
        telegramCfg: {} as never,
        allowFrom: ["42"],
        groupAllowFrom: [],
        useAccessGroups: false,
        resolveGroupPolicy: () => ({ allowlistEnabled: false, allowed: true }) as never,
        resolveTelegramGroupConfig: () => ({
          groupConfig: undefined,
          topicConfig: undefined,
        }),
        shouldSkipUpdate: () => false,
        textLimit: 4000,
      });
    },
    async callback(data: string, messageId = 501) {
      if (!callbackHandler) throw new Error("callback handler not registered");
      await callbackHandler(
        {
          callbackQuery: {
            id: `cb-${data}`,
            data,
            from: { id: 42 },
            message: { chat: { id: 42, type: "private" }, message_id: messageId },
          },
        },
        next,
      );
    },
  };
}

async function waitFor(assertion: () => void, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function sentText(harness: ReturnType<typeof makeHarness>): string {
  return harness.sendMessage.mock.calls.map((call) => String(call[1])).join("\n---\n");
}

describe("goal continuation callbacks", () => {
  beforeEach(() => {
    testGoalsDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-continuation-callbacks-"));
    mockRunCliPlanRevision.mockReset();
    mockRunCliPlanForContinuation.mockReset();
  });

  afterEach(() => {
    clearAllPendingContinuationEditInteractionsForTest();
    fs.rmSync(testGoalsDir, { recursive: true, force: true });
  });

  it("routes gca/gce/gcm/gcs without colliding with other callback prefixes", async () => {
    saveRun(run());
    mockRunCliPlanRevision.mockResolvedValue({
      plan: plan({
        steps: [
          {
            id: "next-step",
            description: "Next step",
            shortSummary: "Next step",
            dependsOn: [],
            status: "pending",
          },
        ],
      }),
    });
    const harness = makeHarness();
    await harness.register();

    await harness.callback("gcm:aaaaaaaa:bbbbbbbb");
    await harness.callback("gce:aaaaaaaa:bbbbbbbb");
    await harness.callback("gcs:aaaaaaaa:bbbbbbbb");
    saveRun(run());
    await harness.callback("gca:aaaaaaaa:bbbbbbbb");

    expect(harness.next).not.toHaveBeenCalled();
    expect(harness.answerCallbackQuery).toHaveBeenCalledTimes(4);
    expect(harness.setMessageReaction).toHaveBeenCalledTimes(4);
    expect(String(harness.sendMessage.mock.calls[0]?.[1] ?? "")).toBe(
      [
        "<b>Proposed next plan prompt for Goal aaaaaaaa:</b>",
        "Draft the next verification plan.",
      ].join("\n"),
    );
    expect(harness.sendMessage.mock.calls[0]?.[2]).not.toHaveProperty("reply_markup");
  });

  it("recovers stale View Prompt against the current pending proposal without refreshing", async () => {
    saveRun(
      run({
        telegramDoneMessage: { chatId: 42, messageId: 450 },
        pendingContinuation: proposal({ notify: undefined }),
      }),
    );
    const harness = makeHarness();
    await harness.register();

    await harness.callback("gcm:aaaaaaaa:deadbeef");

    expect(sentText(harness)).toContain("Draft the next verification plan.");
    expect(sentText(harness)).not.toContain("That continuation prompt is no longer current.");
    expect(sentText(harness)).not.toContain("recovered");
    expect(sentText(harness)).not.toContain("refreshed");
    expect(sentText(harness)).not.toContain("superseded");
    expect(harness.sendMessage).toHaveBeenCalledTimes(1);
    expect(loadRun(RUN_ID)?.pendingContinuation?.notify).toBeUndefined();
    expect(mockRunCliPlanRevision).not.toHaveBeenCalled();
  });

  it("recovers stale Request Edit and the edit reply updates the current proposal", async () => {
    const goalBriefContent = "# Goal Brief\n\n## Remaining Work\nCreate goal2.txt.";
    saveRun(
      withGoalBrief(
        run({
          telegramDoneMessage: { chatId: 42, messageId: 450 },
          pendingContinuation: proposal({ notify: undefined }),
        }),
        goalBriefContent,
      ),
    );
    const harness = makeHarness();
    await harness.register();

    await harness.callback("gce:aaaaaaaa:deadbeef", 551);

    expect(sentText(harness)).toContain("✏️ Reply with edits to the continuation prompt.");
    expect(sentText(harness)).not.toContain("recovered");
    expect(sentText(harness)).not.toContain("refreshed");
    expect(harness.sendMessage).toHaveBeenCalledTimes(1);
    expect(loadRun(RUN_ID)?.pendingContinuation?.notify).toEqual({
      chatId: 42,
      messageId: 700,
      threadId: undefined,
    });

    const { handleGoalContinuationEdit } = await import("./goal-commands.js");
    const revisionClient = {
      complete: vi.fn(async () => ({
        text: JSON.stringify({
          briefSummary: "Verify the stale edit recovery.",
          runAt: "now",
          proposedPrompt: "Draft the next verification plan after stale edit recovery.",
          decisions: [],
        }),
      })),
    };
    const result = await handleGoalContinuationEdit(
      "aaaaaaaa",
      "Use the recovered current proposal.",
      undefined,
      revisionClient,
    );

    expect(typeof result).toBe("object");
    expect(loadRun(RUN_ID)?.pendingContinuation).toMatchObject({
      briefSummary: "Verify the stale edit recovery.",
      status: "edited",
    });
    expect(revisionClient.complete).toHaveBeenCalledOnce();
  });

  it("Request Edit opens ForceReply and reply editing updates only the pending proposal", async () => {
    const goalBriefContent = "# Goal Brief\n\n## Remaining Work\nCreate goal2.txt.";
    saveRun(withGoalBrief(run(), goalBriefContent));
    const harness = makeHarness();
    await harness.register();

    await harness.callback("gce:aaaaaaaa:bbbbbbbb", 551);

    expect(sentText(harness)).toContain("✏️ Reply with edits to the continuation prompt.");
    expect(harness.sendMessage.mock.calls.at(-1)?.[2]).toEqual(
      expect.objectContaining({
        reply_parameters: { message_id: 551 },
        reply_markup: expect.objectContaining({ force_reply: true }),
      }),
    );
    const withPrompt = loadRun(RUN_ID)!;
    expect(withPrompt.pendingContinuation?.notify).toEqual({
      chatId: 42,
      messageId: 700,
      threadId: undefined,
    });

    const { handleGoalContinuationEdit } = await import("./goal-commands.js");
    const editText = "Make the next plan verify goal2-edited.txt instead of goal2.txt.";
    const revisionClient = {
      complete: vi.fn(async () => ({
        text: JSON.stringify({
          briefSummary: "Verify goal2-edited.txt instead of goal2.txt.",
          runAt: "now",
          proposedPrompt:
            "Draft the next verification plan for goal2-edited.txt instead of goal2.txt.",
          decisions: [],
        }),
      })),
    };
    const result = await handleGoalContinuationEdit(
      "aaaaaaaa",
      editText,
      undefined,
      revisionClient,
    );

    expect(typeof result).toBe("object");
    const edited = loadRun(RUN_ID)!;
    expect(edited.pendingContinuation).toMatchObject({
      briefSummary: "Verify goal2-edited.txt instead of goal2.txt.",
      status: "edited",
    });
    expect(edited.pendingContinuation?.proposedPrompt).toContain(
      "goal2-edited.txt instead of goal2.txt",
    );
    expect(edited.pendingContinuation?.briefSummary).not.toContain(
      "Revise the next plan to incorporate",
    );
    expect(edited.pendingContinuation?.proposedPrompt).not.toBe(
      "Make the next plan verify goal2-edited.txt instead of goal2.txt.",
    );
    expect(edited.pendingContinuation?.decisions).toBeUndefined();
    expect(edited.pendingContinuation?.lastContinuationEditMessage).toBe(editText);
    expect(fs.readFileSync(edited.goalBriefPath!, "utf8")).toBe(goalBriefContent);
    expect(revisionClient.complete).toHaveBeenCalledOnce();
    expect(sentText(harness)).not.toContain("Continuation prompt edited");
    expect(edited.planRevision).toBe(3);
    expect(mockRunCliPlanRevision).not.toHaveBeenCalled();
  });

  it("Request Edit retries stale reply targets and updates pendingContinuation.notify from retried message", async () => {
    saveRun(run());
    const harness = makeHarness();
    harness.sendMessage
      .mockRejectedValueOnce(new Error("Bad Request: replied message not found"))
      .mockResolvedValueOnce({ message_id: 702 });
    await harness.register();

    await harness.callback("gce:aaaaaaaa:bbbbbbbb", 551);

    expect(harness.sendMessage).toHaveBeenCalledTimes(2);
    expect(harness.sendMessage.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        reply_parameters: { message_id: 551 },
        reply_markup: expect.objectContaining({ force_reply: true }),
      }),
    );
    expect(harness.sendMessage.mock.calls[1]?.[2]).not.toHaveProperty("reply_parameters");
    expect(loadRun(RUN_ID)?.pendingContinuation?.notify).toEqual({
      chatId: 42,
      messageId: 702,
      threadId: undefined,
    });
    expect(
      getPendingContinuationEditInteraction({
        chatId: 42,
        senderId: "42",
        runId: RUN_ID,
      }),
    ).toMatchObject({
      originalMessageId: 551,
      promptMessageId: 702,
    });

    const { routeTelegramText } = await import("./goal-router.js");
    expect(
      routeTelegramText({
        chatId: 42,
        senderId: "42",
        messageText: "Use the edited continuation prompt.",
        replyToMessageId: 702,
        runs: [loadRun(RUN_ID)!],
      }),
    ).toMatchObject({
      kind: "GOAL_CONTINUATION_EDIT",
      runId: RUN_ID,
    });
  });

  it("Approve Prompt creates a fresh all-pending Plan 2 under the same run without executing", async () => {
    saveRun(run());
    mockRunCliPlanForContinuation.mockResolvedValue({
      status: "success",
      plan: plan({
        steps: [
          {
            id: "next-step",
            description: "Next step",
            shortSummary: "Next step",
            dependsOn: [],
            status: "done",
            taskSummary: "should be cleared",
            blockedReason: "error",
            executedBackend: "codex",
          },
        ],
      }),
      scoutStatus: "success",
      plannerBackendUsed: "codex",
    });
    const harness = makeHarness();
    await harness.register();

    await harness.callback("gca:aaaaaaaa:bbbbbbbb", 552);

    await waitFor(() => {
      const stored = loadRun(RUN_ID)!;
      expect(stored.state).toBe("awaiting_approval");
      expect(stored.planNumber).toBe(2);
      expect(stored.planRevision).toBe(4);
      expect(stored.pendingContinuation).toBeUndefined();
    });
    const stored = loadRun(RUN_ID)!;
    expect(stored.runId).toBe(RUN_ID);
    expect(stored.stepResults).toEqual({});
    expect(stored.plan?.steps).toHaveLength(1);
    expect(stored.plan?.steps[0]).toMatchObject({ id: "next-step", status: "pending" });
    expect(stored.plan?.steps[0]?.taskSummary).toBeUndefined();
    expect(stored.plan?.steps[0]?.blockedReason).toBeUndefined();
    expect(stored.plan?.steps[0]?.executedBackend).toBeUndefined();
    expect(stored.continuationHistory?.[0]).toMatchObject({
      proposalId: PROPOSAL_ID,
      status: "approved",
    });
    // Approve must build a FRESH plan from the approved proposedPrompt, not a
    // revision of the prior completed plan: runCliPlanForContinuation is used and
    // runCliPlanRevision is never invoked, so the completed plan is never fed in
    // as "Current plan".
    expect(mockRunCliPlanRevision).not.toHaveBeenCalled();
    expect(mockRunCliPlanForContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: RUN_ID,
        proposedPrompt: "Draft the next verification plan.",
        currentPlanNumber: 1,
      }),
    );
    expect(sentText(harness)).toContain("Right away, sir. Drafting Plan 2 now.");
    expect(sentText(harness)).not.toContain("Executing:");
  });

  it("No Further Plan supersedes the proposal and leaves the completed goal done", async () => {
    saveRun(run());
    const harness = makeHarness();
    await harness.register();

    await harness.callback("gcs:aaaaaaaa:bbbbbbbb");

    const stored = loadRun(RUN_ID)!;
    expect(stored.state).toBe("done");
    expect(stored.pendingContinuation).toBeUndefined();
    expect(stored.continuationHistory?.[0]).toMatchObject({
      proposalId: PROPOSAL_ID,
      status: "superseded",
    });
    expect(sentText(harness)).toContain("🛑 No further plan will be created for this goal.");
  });

  it("Make Another Plan creates an approvable prompt under the same run without executing", async () => {
    saveRun(
      run({
        pendingContinuation: proposal({
          goalAchieved: true,
          briefSummary: "No next plan needed.",
          proposedPrompt: "",
        }),
      }),
    );
    const harness = makeHarness();
    await harness.register();

    await harness.callback("gcn:aaaaaaaa:bbbbbbbb", 553);

    const stored = loadRun(RUN_ID)!;
    expect(stored.runId).toBe(RUN_ID);
    expect(stored.state).toBe("done");
    expect(stored.planNumber).toBe(1);
    expect(stored.planRevision).toBe(3);
    expect(stored.pendingContinuation).toMatchObject({
      goalAchieved: false,
      status: "pending",
    });
    expect(stored.pendingContinuation?.briefSummary).not.toContain(
      "Another plan can be drafted under this goal.",
    );
    expect(stored.pendingContinuation?.decisions?.length).toBeGreaterThan(0);
    expect(sentText(harness)).toContain("🧭");
    expect(sentText(harness)).toContain("Continue this goal with a new plan?");
    expect(sentText(harness)).toContain("Next Plan Summary:");
    expect(sentText(harness)).toContain("<b>Decision 1.</b> What should the next plan do?");
    expect(sentText(harness)).not.toContain("Another plan is recommended.");
    expect(sentText(harness)).not.toContain("Another plan can be drafted under this goal.");
    expect(sentText(harness)).not.toContain("🔁");
    expect(sentText(harness).toLowerCase()).not.toContain("cycle");
    expect(harness.sendMessage.mock.calls.at(-1)?.[2]).toEqual(
      expect.objectContaining({
        reply_markup: {
          inline_keyboard: [
            [
              { text: "❤️ Approve", callback_data: "gca:aaaaaaaa:bbbbbbbb" },
              { text: "🔍 View Prompt", callback_data: "gcm:aaaaaaaa:bbbbbbbb" },
            ],
            [{ text: "📝 Request Edit", callback_data: "gce:aaaaaaaa:bbbbbbbb" }],
          ],
        },
      }),
    );
    expect(mockRunCliPlanRevision).not.toHaveBeenCalled();
    expect(sentText(harness)).not.toContain("Executing:");
  });

  it("recovers stale Make Another Plan against the current proposal", async () => {
    saveRun(
      run({
        pendingContinuation: proposal({
          goalAchieved: true,
          briefSummary: "No next plan needed.",
          proposedPrompt: "",
        }),
      }),
    );
    const harness = makeHarness();
    await harness.register();

    await harness.callback("gcn:aaaaaaaa:deadbeef", 553);

    const stored = loadRun(RUN_ID)!;
    expect(stored.pendingContinuation).toMatchObject({
      goalAchieved: false,
      status: "pending",
    });
    expect(sentText(harness)).toContain("Continue this goal with a new plan?");
    expect(sentText(harness)).not.toContain("That continuation prompt is no longer current.");
    expect(sentText(harness)).not.toContain("recovered");
    expect(harness.sendMessage).toHaveBeenCalledTimes(1);
    expect(mockRunCliPlanRevision).not.toHaveBeenCalled();
  });

  it("keeps stale Approve blocked", async () => {
    saveRun(run());
    const harness = makeHarness();
    await harness.register();

    await harness.callback("gca:aaaaaaaa:deadbeef", 553);

    expect(sentText(harness)).toContain("That continuation prompt is no longer current.");
    expect(mockRunCliPlanRevision).not.toHaveBeenCalled();
    expect(loadRun(RUN_ID)?.pendingContinuation?.status).toBe("pending");
  });

  it("Continue Goal from achieved Plan Done opens the recommended continuation UI", async () => {
    saveRun(
      run({
        pendingContinuation: proposal({
          goalAchieved: true,
          briefSummary: "No next plan needed.",
          proposedPrompt: "",
          decisions: [
            {
              question: "What follow-up should Plan 2 prioritize?",
              options: ["Polish", "Verification"],
              recommendedOption: "Verification",
              rationale: "The report identified verification as the useful follow-up.",
            },
          ],
        }),
      }),
    );
    const harness = makeHarness();
    await harness.register();

    await harness.callback("gCG:aaaaaaaa", 554);

    const text = sentText(harness);
    expect(text).toContain("Continue this goal with a new plan?");
    expect(text).toContain("<b>Decision 1.</b> What should the next plan do?");
    expect(text).toContain("<b>(A): (Recommended)</b> Validate the completed result");
    expect(text).toContain("<b>Goal ID:</b> aaaaaaaa");
    expect(text).not.toContain("\n\n");
    expect(text).toContain("Something else. Use Request Edit.");
    expect(text).not.toContain("Decision(s) needed:</b>\nNone");
    expect(text).not.toContain("No next plan is recommended right now.");
    expect(text).not.toContain("Another plan is recommended.");
    expect(text).not.toContain("Another plan can be drafted under this goal.");
    expect(text).not.toContain("🔁");
    expect(loadRun(RUN_ID)?.pendingContinuation).toMatchObject({
      goalAchieved: false,
      status: "pending",
    });
    expect(harness.sendMessage.mock.calls.at(-1)?.[2]).toEqual(
      expect.objectContaining({
        reply_markup: {
          inline_keyboard: [
            [
              { text: "❤️ Approve", callback_data: "gca:aaaaaaaa:bbbbbbbb" },
              { text: "🔍 View Prompt", callback_data: "gcm:aaaaaaaa:bbbbbbbb" },
            ],
            [{ text: "📝 Request Edit", callback_data: "gce:aaaaaaaa:bbbbbbbb" }],
          ],
        },
      }),
    );
    expect(mockRunCliPlanRevision).not.toHaveBeenCalled();
  });

  it("per-run continue lock prevents concurrent continuation approval", async () => {
    saveRun(run());
    const held = acquireGoalOpLock(RUN_ID, "feedback");
    if (!held.acquired) throw new Error("failed to acquire test lock");
    const harness = makeHarness();
    await harness.register();

    try {
      await harness.callback("gca:aaaaaaaa:bbbbbbbb");
    } finally {
      held.release();
    }

    expect(sentText(harness)).toContain("already incorporating your feedback");
    expect(mockRunCliPlanRevision).not.toHaveBeenCalled();
    expect(loadRun(RUN_ID)?.pendingContinuation?.proposalId).toBe(PROPOSAL_ID);
  });
});
