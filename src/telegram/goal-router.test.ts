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

  it("routes single blocked run to GOAL_ANSWER", () => {
    const runs = [
      makeRun({
        runId: "r1",
        state: "blocked",
        blocked: { prompt: "Need input", requiredInputKey: "input_key" },
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
    expect(route.kind).toBe("GOAL_ANSWER");
    expect(route.runId).toBe("r1");
  });

  it("routes single needs_clarification run to GOAL_ANSWER", () => {
    const runs = [
      makeRun({
        runId: "r1",
        state: "needs_clarification",
        blocked: { prompt: "What file?", requiredInputKey: "step:planning:input" },
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
    expect(route.kind).toBe("GOAL_ANSWER");
    expect(route.runId).toBe("r1");
  });

  it("routes multiple blocked runs to DISAMBIGUATE", () => {
    const runs = [
      makeRun({
        runId: "r1",
        state: "blocked",
        blocked: { prompt: "Need input", requiredInputKey: "input_key" },
        telegramPlanMessage: { chatId: 1, messageId: 10 },
      }),
      makeRun({
        runId: "r2",
        state: "blocked",
        blocked: { prompt: "Need input", requiredInputKey: "input_key" },
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
    expect(route.kind).toBe("DISAMBIGUATE");
    expect(route.replyText).toBe(TELEGRAM_GOAL_ROUTER_MESSAGES.MULTIPLE_BLOCKED_MESSAGE);
  });

  it("routes approval intent to GOAL_APPROVE", () => {
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
    expect(route.kind).toBe("GOAL_APPROVE");
    expect(route.runId).toBe("r1");
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
});
