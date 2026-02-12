GOAL_ID: 942c5427-58b0-4f4b-9f37-4507e8c5d29c
Type: Impl
Objective: Improve Telegram status and done readability

Requirements:
1. Route Telegram `/goal_status` and done notifications through the compact status/summary formatting so captions stay human-readable.
2. Update Telegram goal command tests to cover concise output, caption splitting behavior, and unchanged message-routing behavior.

Constraints:
- Respect Telegram caption limits and existing PNG fallback behavior.
- Preserve inline keyboard actions and question-message tracking.

Verification: pnpm vitest run src/telegram/goal-commands.test.ts
