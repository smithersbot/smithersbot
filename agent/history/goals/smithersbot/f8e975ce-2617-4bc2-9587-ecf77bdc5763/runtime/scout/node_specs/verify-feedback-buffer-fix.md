GOAL_ID: f8e975ce-2617-4bc2-9587-ecf77bdc5763
Type: Integration
Objective: Cross-cutting verification sweep proving the feedback-buffering change is healthy and did not regress the Telegram routing/buffering surfaces.

Requirements:
1. Run the focused Telegram suite covering router, bot handlers, command fragments, goal commands, and repo-chat routing (at minimum src/telegram). Confirm the new feedback-buffering tests, /new_goal buffering tests, repo-chat routing tests, and goal-router tests all pass.
2. Run the project gate: pnpm exec tsc -p tsconfig.json, then pnpm build, then pnpm lint. All must succeed.
3. If any check fails, fix the implementation from the previous node's surfaces and rerun until green; capture the exact passing commands/output for the report node.

Constraints:
- Do not weaken or delete tests to make the suite pass.
- Do not introduce unrelated refactors or formatting churn.
- Do not restart or build the dev gateway; do not read or print secrets.

Verification: pnpm vitest run src/telegram && pnpm exec tsc -p tsconfig.json && pnpm build && pnpm lint
