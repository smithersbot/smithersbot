import { afterEach, describe, expect, it, vi } from "vitest";

import { routeTelegramText, TELEGRAM_GOAL_ROUTER_MESSAGES } from "./goal-router.js";
import {
  clearAllPendingContinuationEditInteractionsForTest,
  recordPendingContinuationEditInteraction,
} from "./continuation-edit-interactions.js";
import type { SerializedRun } from "../goal/types.js";

const now = new Date().toISOString();

function makeRun(partial: Partial<SerializedRun>): SerializedRun {
  return {
    runId: partial.runId ?? "run-1",
    goal: "Test goal",
    state: partial.state ?? "awaiting_approval",
    plan: null,
    stepResults: {},
    blocked: partial.blocked ?? null,
    answers: {},
    workingDir: "/tmp",
    model: undefined,
    dryRun: false,
    createdAt: now,
    updatedAt: now,
    telegramPlanMessage: partial.telegramPlanMessage,
    telegramQuestionMessages: partial.telegramQuestionMessages,
    telegramEditPromptMessages: partial.telegramEditPromptMessages,
    telegramDoneMessage: partial.telegramDoneMessage,
    telegramFeedbackPromptMessages: partial.telegramFeedbackPromptMessages,
    pendingContinuation: partial.pendingContinuation,
  };
}

describe("routeTelegramText", () => {
  afterEach(() => {
    clearAllPendingContinuationEditInteractionsForTest();
    vi.useRealTimers();
  });

  // Default routing: free text becomes CHAT (only explicit /commands create goals)
  it("routes plain text to CHAT (no implicit goal creation)", () => {
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "build a thing",
      replyToMessageId: undefined,
      runs: [],
    });
    expect(route.kind).toBe("CHAT");
  });

  it("routes greetings to CHAT", () => {
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "hello",
      replyToMessageId: undefined,
      runs: [],
    });
    expect(route.kind).toBe("CHAT");
  });

  it("routes thanks to CHAT", () => {
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "thanks",
      replyToMessageId: undefined,
      runs: [],
    });
    expect(route.kind).toBe("CHAT");
  });

  it("routes task-like text to CHAT (no implicit goal creation)", () => {
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "write a file foo.txt containing hello",
      replyToMessageId: undefined,
      runs: [],
    });
    expect(route.kind).toBe("CHAT");
  });

  it("routes reply to latest plan message to GOAL_EDIT", () => {
    const runs = [
      makeRun({
        runId: "r1",
        telegramPlanMessage: { chatId: 1, messageId: 42, messageHistory: [41] },
      }),
    ];
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "change step 2",
      replyToMessageId: 42,
      runs,
    });
    expect(route.kind).toBe("GOAL_EDIT");
    expect(route.runId).toBe("r1");
  });

  it("routes reply to edit-prompt message to GOAL_EDIT", () => {
    const runs = [
      makeRun({
        runId: "r1",
        telegramPlanMessage: { chatId: 1, messageId: 42 },
        telegramEditPromptMessages: [{ chatId: 1, messageId: 50 }],
      }),
    ];
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "add a README step",
      replyToMessageId: 50,
      runs,
    });
    expect(route.kind).toBe("GOAL_EDIT");
    expect(route.runId).toBe("r1");
  });

  it("routes non-reply text to GOAL_CONTINUATION_EDIT while Request Edit is active", () => {
    recordPendingContinuationEditInteraction({
      chatId: 1,
      senderId: "99",
      runId: "r1",
      originalMessageId: 70,
      promptMessageId: 71,
    });
    const runs = [
      makeRun({
        runId: "r1",
        state: "done",
        pendingContinuation: {
          proposalId: "proposal-1",
          fromPlanNumber: 1,
          goalAchieved: false,
          briefSummary: "Continue.",
          proposedPrompt: "Next prompt.",
          runAt: "now",
          status: "pending",
          createdAt: now,
          notify: { chatId: 1, messageId: 71 },
        },
      }),
    ];

    const route = routeTelegramText({
      chatId: 1,
      senderId: "99",
      messageText: "Please include README cleanup.",
      runs,
    });

    expect(route).toMatchObject({ kind: "GOAL_CONTINUATION_EDIT", runId: "r1" });
  });

  it("keeps explicit slash commands out of active continuation-edit ownership", () => {
    recordPendingContinuationEditInteraction({
      chatId: 1,
      senderId: "99",
      runId: "r1",
      promptMessageId: 71,
    });
    const runs = [
      makeRun({
        runId: "r1",
        state: "done",
        pendingContinuation: {
          proposalId: "proposal-1",
          fromPlanNumber: 1,
          goalAchieved: false,
          briefSummary: "Continue.",
          proposedPrompt: "Next prompt.",
          runAt: "now",
          status: "pending",
          createdAt: now,
          notify: { chatId: 1, messageId: 71 },
        },
      }),
    ];

    const route = routeTelegramText({
      chatId: 1,
      senderId: "99",
      messageText: "/goal_status r1",
      runs,
    });

    expect(route.kind).not.toBe("GOAL_CONTINUATION_EDIT");
  });

  it("routes ForceReply prompt replies to GOAL_CONTINUATION_EDIT", () => {
    const runs = [
      makeRun({
        runId: "r1",
        state: "done",
        pendingContinuation: {
          proposalId: "proposal-1",
          fromPlanNumber: 1,
          goalAchieved: false,
          briefSummary: "Continue.",
          proposedPrompt: "Next prompt.",
          runAt: "now",
          status: "pending",
          createdAt: now,
          notify: { chatId: 1, messageId: 71 },
        },
      }),
    ];

    const route = routeTelegramText({
      chatId: 1,
      senderId: "99",
      messageText: "Revise the continuation prompt.",
      replyToMessageId: 71,
      runs,
    });

    expect(route).toMatchObject({ kind: "GOAL_CONTINUATION_EDIT", runId: "r1" });
  });

  it("routes original continuation-card replies to GOAL_CONTINUATION_EDIT while Request Edit is active", () => {
    recordPendingContinuationEditInteraction({
      chatId: 1,
      senderId: "99",
      runId: "r1",
      originalMessageId: 70,
      promptMessageId: 71,
    });
    const runs = [
      makeRun({
        runId: "r1",
        state: "done",
        pendingContinuation: {
          proposalId: "proposal-1",
          fromPlanNumber: 1,
          goalAchieved: false,
          briefSummary: "Continue.",
          proposedPrompt: "Next prompt.",
          runAt: "now",
          status: "pending",
          createdAt: now,
          notify: { chatId: 1, messageId: 71 },
        },
      }),
    ];

    const route = routeTelegramText({
      chatId: 1,
      senderId: "99",
      messageText: "Revise from the original card.",
      replyToMessageId: 70,
      runs,
    });

    expect(route).toMatchObject({ kind: "GOAL_CONTINUATION_EDIT", runId: "r1" });
  });

  it("returns a goal notice instead of CHAT for stale continuation-edit state", () => {
    recordPendingContinuationEditInteraction({
      chatId: 1,
      senderId: "99",
      runId: "r1",
      originalMessageId: 70,
      promptMessageId: 71,
    });
    const runs = [
      makeRun({
        runId: "r1",
        state: "done",
        pendingContinuation: {
          proposalId: "proposal-1",
          fromPlanNumber: 1,
          goalAchieved: false,
          briefSummary: "Continue.",
          proposedPrompt: "Next prompt.",
          runAt: "now",
          status: "approved",
          createdAt: now,
          notify: { chatId: 1, messageId: 71 },
        },
      }),
    ];

    const route = routeTelegramText({
      chatId: 1,
      senderId: "99",
      messageText: "Late edit after approval.",
      runs,
    });

    expect(route.kind).toBe("GOAL_NOTICE");
    expect(route.runId).toBe("r1");
  });

  it("refreshes repeated continuation Request Edit taps without corrupting state", () => {
    recordPendingContinuationEditInteraction({
      chatId: 1,
      senderId: "99",
      runId: "r1",
      originalMessageId: 70,
      promptMessageId: 71,
    });
    recordPendingContinuationEditInteraction({
      chatId: 1,
      senderId: "99",
      runId: "r1",
      originalMessageId: 72,
      promptMessageId: 73,
    });
    const runs = [
      makeRun({
        runId: "r1",
        state: "done",
        pendingContinuation: {
          proposalId: "proposal-1",
          fromPlanNumber: 1,
          goalAchieved: false,
          briefSummary: "Continue.",
          proposedPrompt: "Next prompt.",
          runAt: "now",
          status: "pending",
          createdAt: now,
          notify: { chatId: 1, messageId: 73 },
        },
      }),
    ];

    const staleOriginalRoute = routeTelegramText({
      chatId: 1,
      senderId: "99",
      messageText: "Old card reply.",
      replyToMessageId: 70,
      runs,
    });
    const latestOriginalRoute = routeTelegramText({
      chatId: 1,
      senderId: "99",
      messageText: "New card reply.",
      replyToMessageId: 72,
      runs,
    });

    expect(staleOriginalRoute.kind).not.toBe("GOAL_CONTINUATION_EDIT");
    expect(latestOriginalRoute).toMatchObject({ kind: "GOAL_CONTINUATION_EDIT", runId: "r1" });
  });

  it("routes reply to feedback-prompt message to GOAL_FEEDBACK", () => {
    const runs = [
      makeRun({
        runId: "r1",
        state: "done",
        telegramDoneMessage: { chatId: 1, messageId: 60 },
        telegramFeedbackPromptMessages: [{ chatId: 1, messageId: 61 }],
      }),
    ];
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "Test 2 failed with a crash",
      replyToMessageId: 61,
      runs,
    });
    expect(route.kind).toBe("GOAL_FEEDBACK");
    expect(route.runId).toBe("r1");
  });

  it("routes reply to done message to GOAL_FEEDBACK", () => {
    const runs = [
      makeRun({
        runId: "r1",
        state: "done",
        telegramDoneMessage: { chatId: 1, messageId: 60 },
      }),
    ];
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "Test 2 failed with a crash",
      replyToMessageId: 60,
      runs,
    });
    expect(route.kind).toBe("GOAL_FEEDBACK");
    expect(route.runId).toBe("r1");
  });

  it("does not match edit-prompt message from wrong chatId", () => {
    const runs = [
      makeRun({
        runId: "r1",
        telegramPlanMessage: { chatId: 1, messageId: 42 },
        telegramEditPromptMessages: [{ chatId: 999, messageId: 50 }],
      }),
    ];
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "change it",
      replyToMessageId: 50,
      runs,
    });
    expect(route.kind).toBe("CHAT");
  });

  it("does not match feedback-prompt message from wrong chatId", () => {
    const runs = [
      makeRun({
        runId: "r1",
        state: "done",
        telegramDoneMessage: { chatId: 1, messageId: 60 },
        telegramFeedbackPromptMessages: [{ chatId: 999, messageId: 61 }],
      }),
    ];
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "failed",
      replyToMessageId: 61,
      runs,
    });
    expect(route.kind).toBe("CHAT");
  });

  it("routes reply to older plan revision to DISAMBIGUATE", () => {
    const runs = [
      makeRun({
        runId: "r1",
        telegramPlanMessage: { chatId: 1, messageId: 42, messageHistory: [41] },
      }),
    ];
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "change step 2",
      replyToMessageId: 41,
      runs,
    });
    expect(route.kind).toBe("DISAMBIGUATE");
    expect(route.replyText).toBe(TELEGRAM_GOAL_ROUTER_MESSAGES.OLDER_REVISION_MESSAGE);
  });

  // Blocked runs: plain text now routes to CHAT with hint (no implicit GOAL_ANSWER)
  it("routes plain text with single blocked run to CHAT with hint", () => {
    const runs = [
      makeRun({
        runId: "r1",
        state: "blocked",
        blocked: {
          blockedAt: "execution",
          prompt: "Need input",
          requiredInputKey: "input_key",
        },
        telegramPlanMessage: { chatId: 1, messageId: 10 },
      }),
    ];
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "the answer",
      replyToMessageId: undefined,
      runs,
    });
    expect(route.kind).toBe("CHAT");
    expect(route.replyText).toContain("/goal_answer");
    expect(route.replyText).toContain("r1".slice(0, 8));
  });

  it("routes plain text with single planning-blocked run to CHAT with hint", () => {
    const runs = [
      makeRun({
        runId: "r1",
        state: "blocked",
        blocked: {
          blockedAt: "planning",
          prompt: "What file?",
          requiredInputKey: "step:planning:input",
        },
        telegramPlanMessage: { chatId: 1, messageId: 10 },
      }),
    ];
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "foo.txt",
      replyToMessageId: undefined,
      runs,
    });
    expect(route.kind).toBe("CHAT");
    expect(route.replyText).toContain("/goal_answer");
  });

  it("routes plain text with multiple blocked runs to CHAT with hint", () => {
    const runs = [
      makeRun({
        runId: "r1",
        state: "blocked",
        blocked: {
          blockedAt: "execution",
          prompt: "Need input",
          requiredInputKey: "input_key",
        },
        telegramPlanMessage: { chatId: 1, messageId: 10 },
      }),
      makeRun({
        runId: "r2",
        state: "blocked",
        blocked: {
          blockedAt: "execution",
          prompt: "Need input",
          requiredInputKey: "input_key",
        },
        telegramPlanMessage: { chatId: 1, messageId: 11 },
      }),
    ];
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "the answer",
      replyToMessageId: undefined,
      runs,
    });
    expect(route.kind).toBe("CHAT");
    expect(route.replyText).toContain("/goal_list");
  });

  // Approval/rejection: text-based intents no longer route to GOAL_APPROVE/REJECT
  it("routes approval intent to CHAT (approval only via buttons/reactions/commands)", () => {
    const runs = [
      makeRun({
        runId: "r1",
        state: "awaiting_approval",
        telegramPlanMessage: { chatId: 1, messageId: 10 },
      }),
    ];
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "approve",
      replyToMessageId: undefined,
      runs,
    });
    expect(route.kind).toBe("CHAT");
  });

  it("routes help intent to CHAT_HELP", () => {
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "who are you?",
      replyToMessageId: undefined,
      runs: [],
    });
    expect(route.kind).toBe("CHAT_HELP");
  });

  // Regression: exact matching prevents substring false positives
  it("does not treat 'build a thing' as greeting (substring 'hi' in 'thing')", () => {
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "build a thing",
      replyToMessageId: undefined,
      runs: [],
    });
    // Free text → CHAT (not greeting, not GOAL_CREATE)
    expect(route.kind).toBe("CHAT");
  });

  it("does not treat 'create a file containing hello' as greeting", () => {
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "create a file foo.txt containing hello",
      replyToMessageId: undefined,
      runs: [],
    });
    expect(route.kind).toBe("CHAT");
  });

  it("does not treat 'who are you?' as greeting (substring 'yo' in 'you')", () => {
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "who are you?",
      replyToMessageId: undefined,
      runs: [],
    });
    // Should reach CHAT_HELP, not CHAT (greeting check must not fire)
    expect(route.kind).toBe("CHAT_HELP");
  });

  it("does not treat 'set up the help system' as help intent", () => {
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "set up the help system",
      replyToMessageId: undefined,
      runs: [],
    });
    expect(route.kind).toBe("CHAT");
  });

  it("does not treat 'deploy the ok service' as greeting", () => {
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "deploy the ok service",
      replyToMessageId: undefined,
      runs: [],
    });
    expect(route.kind).toBe("CHAT");
  });

  it("does not treat 'update the morning cron job' as greeting", () => {
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "update the morning cron job",
      replyToMessageId: undefined,
      runs: [],
    });
    expect(route.kind).toBe("CHAT");
  });

  it("routes greeting with punctuation to CHAT", () => {
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "hello!",
      replyToMessageId: undefined,
      runs: [],
    });
    expect(route.kind).toBe("CHAT");
  });

  it("routes multi-word greeting to CHAT", () => {
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "hello there",
      replyToMessageId: undefined,
      runs: [],
    });
    expect(route.kind).toBe("CHAT");
  });

  // ---------------------------------------------------------------------------
  // Reply-to-question routing (new in 6.75)
  // ---------------------------------------------------------------------------

  it("routes reply to question message to GOAL_ANSWER", () => {
    const runs = [
      makeRun({
        runId: "r1",
        state: "blocked",
        blocked: {
          blockedAt: "execution",
          prompt: "What file?",
          requiredInputKey: "input_key",
        },
        telegramPlanMessage: { chatId: 1, messageId: 10 },
        telegramQuestionMessages: [{ chatId: 1, messageId: 15, requiredInputKey: "input_key" }],
      }),
    ];
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "foo.txt",
      replyToMessageId: 15,
      runs,
    });
    expect(route.kind).toBe("GOAL_ANSWER");
    expect(route.runId).toBe("r1");
    expect(route.resumeSource).toBe("direct_reply");
  });

  it("matches older question message in the array", () => {
    const runs = [
      makeRun({
        runId: "r1",
        state: "blocked",
        blocked: {
          blockedAt: "planning",
          prompt: "Which DB?",
          requiredInputKey: "step:planning:input",
        },
        telegramPlanMessage: { chatId: 1, messageId: 10 },
        telegramQuestionMessages: [
          { chatId: 1, messageId: 20, requiredInputKey: "step:planning:input" },
          { chatId: 1, messageId: 15, requiredInputKey: "step:planning:input" },
        ],
      }),
    ];
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "postgres",
      replyToMessageId: 15,
      runs,
    });
    expect(route.kind).toBe("GOAL_ANSWER");
    expect(route.runId).toBe("r1");
    expect(route.resumeSource).toBe("direct_reply");
  });

  it("does not store an answer when the run is no longer blocked but still notices the reply", () => {
    const runs = [
      makeRun({
        runId: "r1",
        state: "done",
        telegramPlanMessage: { chatId: 1, messageId: 10 },
        telegramQuestionMessages: [{ chatId: 1, messageId: 15 }],
      }),
    ];
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "foo.txt",
      replyToMessageId: 15,
      runs,
    });
    // A reply to a tracked goal/task message must never fall through to CHAT
    // (which would reach repo-chat / the embedded agent). It is handled by the
    // goal path with a clear notice instead.
    expect(route.kind).toBe("GOAL_NOTICE");
    expect(route.runId).toBe("r1");
    expect(route.replyText).toContain("currently done");
  });

  // ---------------------------------------------------------------------------
  // Paused / interrupted reply routing (resume_execution)
  // ---------------------------------------------------------------------------

  it("routes a reply to a Paused (resume_execution) message to the unified resume-note path", () => {
    const runs = [
      makeRun({
        runId: "paused1",
        state: "blocked",
        blocked: {
          blockedAt: "execution",
          prompt: "worker hit a provider limit; resume needed",
          requiredInputKey: "resume_execution",
        },
        telegramQuestionMessages: [
          { chatId: 1, messageId: 70, requiredInputKey: "resume_execution" },
        ],
      }),
    ];
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "please continue",
      replyToMessageId: 70,
      runs,
    });
    expect(route.kind).toBe("GOAL_ANSWER");
    expect(route.runId).toBe("paused1");
    expect(route.resumeSource).toBe("direct_reply");
  });

  it("routes a reply to a true user-input block (task:<id>:input) to GOAL_ANSWER", () => {
    const runs = [
      makeRun({
        runId: "blocked1",
        state: "blocked",
        blocked: {
          blockedAt: "execution",
          prompt: "Which database?",
          requiredInputKey: "task:1:input",
        },
        telegramQuestionMessages: [{ chatId: 1, messageId: 71, requiredInputKey: "task:1:input" }],
      }),
    ];
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "postgres",
      replyToMessageId: 71,
      runs,
    });
    expect(route.kind).toBe("GOAL_ANSWER");
    expect(route.runId).toBe("blocked1");
    expect(route.resumeSource).toBe("direct_reply");
  });

  it("routes an Add Details force-reply prompt to the add_details source", () => {
    const runs = [
      makeRun({
        runId: "blocked1",
        state: "blocked",
        blocked: {
          blockedAt: "execution",
          prompt: "Which database?",
          requiredInputKey: "task:1:input",
        },
        telegramQuestionMessages: [{ chatId: 1, messageId: 72, requiredInputKey: "add_details" }],
      }),
    ];
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "use postgres",
      replyToMessageId: 72,
      runs,
    });
    expect(route.kind).toBe("GOAL_ANSWER");
    expect(route.runId).toBe("blocked1");
    expect(route.resumeSource).toBe("add_details");
  });

  it("routes replies to any tracked message on a blocked run to the unified resume-note path", () => {
    const runs = [
      makeRun({
        runId: "blocked1",
        state: "blocked",
        blocked: {
          blockedAt: "execution",
          prompt: "Need input",
          requiredInputKey: "tasks:task-a,task-b:input",
        },
        telegramPlanMessage: { chatId: 1, messageId: 73 },
      }),
    ];
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "retry both",
      replyToMessageId: 73,
      runs,
    });
    expect(route.kind).toBe("GOAL_ANSWER");
    expect(route.runId).toBe("blocked1");
    expect(route.resumeSource).toBe("direct_reply");
  });

  it("notices a reply to a tracked question message of a cancelled run (never CHAT)", () => {
    const runs = [
      makeRun({
        runId: "cancelled1",
        state: "cancelled",
        telegramQuestionMessages: [
          { chatId: 1, messageId: 81, requiredInputKey: "resume_execution" },
        ],
      }),
    ];
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "keep going",
      replyToMessageId: 81,
      runs,
    });
    expect(route.kind).toBe("GOAL_NOTICE");
    expect(route.runId).toBe("cancelled1");
  });

  it("still routes a plain non-reply message to CHAT (never auto-resumes)", () => {
    const runs = [
      makeRun({
        runId: "paused1",
        state: "blocked",
        blocked: {
          blockedAt: "execution",
          prompt: "resume needed",
          requiredInputKey: "resume_execution",
        },
        telegramQuestionMessages: [
          { chatId: 1, messageId: 90, requiredInputKey: "resume_execution" },
        ],
      }),
    ];
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "what is the weather",
      replyToMessageId: undefined,
      runs,
    });
    expect(route.kind).toBe("CHAT");
  });

  it("does not match question message from wrong chatId", () => {
    const runs = [
      makeRun({
        runId: "r1",
        state: "blocked",
        blocked: {
          blockedAt: "execution",
          prompt: "What file?",
          requiredInputKey: "input_key",
        },
        telegramQuestionMessages: [{ chatId: 999, messageId: 15, requiredInputKey: "input_key" }],
      }),
    ];
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "foo.txt",
      replyToMessageId: 15,
      runs,
    });
    expect(route.kind).toBe("CHAT");
  });

  it("non-reply non-command text without blocked runs has no hint", () => {
    const route = routeTelegramText({
      chatId: 1,
      threadId: undefined,
      messageText: "what is the weather",
      replyToMessageId: undefined,
      runs: [],
    });
    expect(route.kind).toBe("CHAT");
    expect(route.replyText).toBeUndefined();
  });
});
