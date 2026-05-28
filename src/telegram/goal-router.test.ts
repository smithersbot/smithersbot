import { describe, expect, it } from "vitest";

import { routeTelegramText, TELEGRAM_GOAL_ROUTER_MESSAGES } from "./goal-router.js";
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
  };
}

describe("routeTelegramText", () => {
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
  });

  it("does not route reply to question message if run is no longer blocked", () => {
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
