GOAL_ID: 942c5427-58b0-4f4b-9f37-4507e8c5d29c
Type: Impl
Objective: Make CLI goal status concise by default

Requirements:
1. Update `goal status` text output to use the compact formatter and show actionable next steps instead of a full plan dump by default.
2. Preserve access to expanded status detail through an explicit CLI option and wire that option through command registration.

Constraints:
- Preserve existing run lookup/error semantics and partial run ID handling.
- Maintain stable text structure for deterministic tests.

Verification: pnpm vitest run src/commands/goal-status.test.ts
