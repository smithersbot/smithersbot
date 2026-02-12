GOAL_ID: 942c5427-58b0-4f4b-9f37-4507e8c5d29c
Type: Impl
Objective: Define reusable compact goal status formatting

Requirements:
1. Add a shared formatter in the goal subsystem that builds compact, human-readable status sections (overview, progress, key steps) from a serialized run.
2. Add unit tests for truncation, multiline summary normalization, and state-specific rendering (done, blocked, executing).

Constraints:
- Keep JSON output behavior unchanged.
- Keep formatter logic reusable across CLI and Telegram surfaces.

Verification: pnpm vitest run src/goal/goal-status-format.test.ts
