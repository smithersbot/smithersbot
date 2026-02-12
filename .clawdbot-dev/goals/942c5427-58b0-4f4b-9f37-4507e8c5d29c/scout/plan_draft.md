BEGIN_PLAN_DRAFT
GOAL_ID: 942c5427-58b0-4f4b-9f37-4507e8c5d29c

## Mermaid Dependency Graph

graph TD
  add-goal-status-view-model["Add compact status view model"] --> implement-compact-goal-status-output["Implement compact /goal_status output"]
  add-goal-status-view-model --> shorten-goal-completion-summaries["Shorten completion summaries"]
  implement-compact-goal-status-output --> update-telegram-goal-status-messages["Update Telegram status messaging"]
  shorten-goal-completion-summaries --> update-telegram-goal-status-messages

## Node Summary

| Node ID | Type | Objective | Verification | Effort | Risk | Uncertainty |
|--------|------|-----------|--------------|--------|------|-------------|
| add-goal-status-view-model | Impl | Define compact status formatter | pnpm vitest run src/goal/goal-status-format.test.ts | 3 | 2 | 3 |
| implement-compact-goal-status-output | Impl | Make status output concise | pnpm vitest run src/commands/goal-status.test.ts | 4 | 3 | 2 |
| shorten-goal-completion-summaries | Impl | Trim done summary text | pnpm vitest run src/goal/agent-executor.test.ts src/goal/goal-workflow-integration.test.ts | 3 | 3 | 3 |
| update-telegram-goal-status-messages | Impl | Improve Telegram status readability | pnpm vitest run src/telegram/goal-commands.test.ts | 3 | 3 | 2 |

## Edge Justifications

- add-goal-status-view-model -> implement-compact-goal-status-output: CLI status should consume the shared compact formatter instead of duplicating display logic.
- add-goal-status-view-model -> shorten-goal-completion-summaries: completion digest rules should reuse the same truncation and text-normalization strategy.
- implement-compact-goal-status-output -> update-telegram-goal-status-messages: Telegram /goal_status should mirror the new concise status presentation.
- shorten-goal-completion-summaries -> update-telegram-goal-status-messages: DONE captions in Telegram depend on the shorter completion summary payload.

END_PLAN_DRAFT
