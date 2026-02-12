GOAL_ID: 942c5427-58b0-4f4b-9f37-4507e8c5d29c
Type: Impl
Objective: Reduce completion summary verbosity

Requirements:
1. Refactor goal completion summary generation so done output is compact (counts first, then a capped/truncated highlight list).
2. Update affected completion paths and tests to assert readable summary text without removing critical status information.

Constraints:
- Keep persisted run artifacts and step-level detail files intact.
- Do not change blocked/cancelled outcome semantics.

Verification: pnpm vitest run src/goal/agent-executor.test.ts src/goal/goal-workflow-integration.test.ts
