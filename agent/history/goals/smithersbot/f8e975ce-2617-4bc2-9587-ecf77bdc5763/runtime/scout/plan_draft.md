BEGIN_PLAN_DRAFT
GOAL_ID: f8e975ce-2617-4bc2-9587-ecf77bdc5763

## Project Conventions

- `CLAUDE.md` exists at project root (and a matching `AGENTS.md`). Key conventions:
  - ESM TypeScript, strict typing, avoid `any`. Telegram runtime in `src/telegram/`, goal system in `src/goal/`.
  - Tests colocated as `*.test.ts`. Run targeted tests with `pnpm vitest run <path>`.
  - Verify behavior changes with the smallest relevant Vitest slice plus `pnpm exec tsc -p tsconfig.json`, `pnpm build`, and `pnpm lint`.
  - Do not read/print private env/auth/session/secret files. Do not run live gateway restarts from workers.

## Root Cause (read from code)

- `src/telegram/bot-handlers.ts` `feedback` runHandler (~line 854) acquires `acquireGoalOpLock(runId, "feedback")` and calls `handleGoalFeedback` immediately on the first chunk.
- The command-fragment continuation append (`commandFragmentBuffer.tryAppend`, ~line 1399) is gated on `replyToMessageId == null`, so feedback *replies* never buffer.
- A second split chunk re-routes via `routeTelegramText` to `GOAL_FEEDBACK` (`goal-router.ts` matches `telegramFeedbackPromptMessages` / `telegramDoneMessage`), hits the already-held lock, and returns "already being processed".

## Reusable Pattern

- `CommandFragmentBuffer` (`src/telegram/command-fragments.ts`): `bufferCommand` / `tryAppend` / `getPendingCommandName` / `hasPending` / `cancelAndFlush` / `flushCallback` / anchors.
- Used by `/new_goal` (`goal-commands.ts:2075`) and `/repo_chat` (`repo-chat-commands.ts:460`). Key built via `buildCommandFragmentKey({accountId, chatId, resolvedThreadId, senderId})`.
- For feedback, the key must additionally scope to the goal/run id so two goals or two users/threads never merge.

## Mermaid Dependency Graph

graph TD
  buffer-feedback-multimessage["Buffer split feedback replies"] --> verify-feedback-buffer-fix["Run gate + telegram tests"]
  verify-feedback-buffer-fix --> write-feedback-buffer-report["Write fix report"]

## Node Summary

| Node ID | Type | Objective | Verification | Effort | Risk | Uncertainty |
|--------|------|-----------|--------------|--------|------|-------------|
| buffer-feedback-multimessage | Impl | Buffer + combine split feedback replies, lock after flush | pnpm vitest run src/telegram/bot-handlers.feedback-buffering.test.ts src/telegram/command-fragments.test.ts | 4 | 4 | 3 |
| verify-feedback-buffer-fix | Integration | Run telegram suite + tsc/build/lint sweep | pnpm vitest run src/telegram | 2 | 2 | 1 |
| write-feedback-buffer-report | Other | Write Stage 2U-F fix report | test -f internal/STAGE2U_F_FEEDBACK_MULTIMESSAGE_BUFFER_FIX_REPORT.md | 2 | 1 | 1 |

### Calibration Anchors

- **Effort:** 1 trivial, 2 small (~10m), 3 moderate (~20m), 4 substantial multi-file (~30m), 5 complex cross-cutting (30m+)
- **Risk:** 1 isolated, 3 shared code, 5 critical path/public API
- **Uncertainty:** 1 clear, 3 some unknowns, 5 significant unknowns

## Edge Justifications

- buffer-feedback-multimessage -> verify-feedback-buffer-fix: the full gate/sweep validates the implemented change across the telegram suite.
- verify-feedback-buffer-fix -> write-feedback-buffer-report: the report must record real verification results (tests, tsc, build, lint).

END_PLAN_DRAFT
