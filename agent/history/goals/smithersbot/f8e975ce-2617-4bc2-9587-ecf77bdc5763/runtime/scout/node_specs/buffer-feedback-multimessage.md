GOAL_ID: f8e975ce-2617-4bc2-9587-ecf77bdc5763
Type: Impl
Objective: Buffer multi-message "Incorporate Feedback" replies into one combined payload using the existing /new_goal CommandFragmentBuffer pattern, and acquire the feedback lock only once after the combined payload is dispatched.

Context:
- Bug: a long "Incorporate Feedback" reply that Telegram splits into multiple messages is treated as separate feedback submissions. The first chunk immediately acquires acquireGoalOpLock(runId, "feedback") and runs handleGoalFeedback; the second chunk re-routes to GOAL_FEEDBACK and gets "already being processed".
- Entry points: src/telegram/bot-handlers.ts feedback runHandler (~line 854, inside handleTelegramGoalRouting runHandlers passed from registerTelegramHandlers); routing in src/telegram/goal-router.ts (GOAL_FEEDBACK via telegramFeedbackPromptMessages / telegramDoneMessage); reusable buffer in src/telegram/command-fragments.ts; templates in goal-commands.ts:2075 (/new_goal) and repo-chat-commands.ts:460 (/repo_chat).

Requirements:
1. Reuse the existing CommandFragmentBuffer pattern (bufferCommand / tryAppend / getPendingCommandName / hasPending / cancelAndFlush / flushCallback) rather than inventing a separate buffering system. Extend command-fragments.ts minimally: add a "feedback" CommandFragmentCommandName and a feedback-scoped key helper (e.g. buildFeedbackFragmentKey) that includes accountId, chatId, resolved thread id, senderId, AND the goal/run id so different goals or different users/chats/threads never merge. Keep the same keying style as buildCommandFragmentKey.
2. In the bot-handlers.ts feedback dispatch path, do NOT acquire the feedback lock or call handleGoalFeedback on the first chunk. Instead buffer the chunk; on a continuation chunk that matches the same feedback key within the continuation window, append it (preserve message order; preserve line breaks between chunks — join with newlines, do not silently drop separators). When the continuation window closes, flush once: acquire acquireGoalOpLock(runId, "feedback") and call handleGoalFeedback with the combined text exactly once.
3. Do not reply "already being processed" to continuation chunks that belong to the same in-window feedback payload. A genuinely new feedback attempt that arrives after the buffer has flushed / after processing has started (or after the window closes) may still receive the existing lock response (formatGoalLockedMessage).
4. Scope buffering strictly to GOAL_FEEDBACK replies. Do NOT change generic chat routing, /new_goal, /repo_chat, /goal_answer, Add Details, edit, or normal command handling. Preserve existing replyToMessageId / sourceMessageId threading on the dispatched feedback.
5. Add focused tests in the same node:
   - Unit tests in src/telegram/command-fragments.test.ts: feedback key isolation (different runId / sender / chat / thread produce different keys) and feedback buffer append+flush combining (order + newline separators) preserved.
   - Integration tests (create src/telegram/bot-handlers.feedback-buffering.test.ts following the harness style in bot-handlers.repo-chat-routing.test.ts that drives the registered "message" handler): (a) two split feedback replies -> exactly one handleGoalFeedback call with both chunks combined in order and no "already being processed" reply for the second chunk; (b) single-message feedback still dispatches once after the same window; (c) chunks for two different goal/run ids do not merge; (d) chunks from different users/chats/threads do not merge; (e) a late message arriving after the window/after processing starts is treated as a new feedback attempt and may hit the existing lock.
   - Regression: confirm /new_goal buffering (goal-commands.test.ts) and repo-chat routing (bot-handlers.repo-chat-routing.test.ts) still pass and that /goal_answer and Add Details behavior is unchanged.

Constraints:
- Do not invent an unrelated parallel buffering system unless the CommandFragmentBuffer pattern truly cannot be reused; if extended, keep changes minimal and consistent with existing naming/typing.
- Do not change generic CHAT routing, repo-chat enablement, anchor follow-up UI semantics, or the textFragmentBuffer (long-paste) path beyond what feedback buffering requires.
- Do not change Stage 2U-F runtime mirror logic, sandbox deny policy, /usage_status, /usage_history, resume/display logic (except where feedback already routes to replan), post-exec review, pi, or backend fallback semantics.
- Do not split implementation and tests into separate nodes; do not verify logic with tsc only.
- Do not read or print private env/auth/session/secret files; do not restart or build the dev gateway here.

Verification: pnpm vitest run src/telegram/bot-handlers.feedback-buffering.test.ts src/telegram/command-fragments.test.ts
