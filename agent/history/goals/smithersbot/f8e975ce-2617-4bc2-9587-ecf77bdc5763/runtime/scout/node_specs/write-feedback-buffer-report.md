GOAL_ID: f8e975ce-2617-4bc2-9587-ecf77bdc5763
Type: Other
Objective: Write internal/STAGE2U_F_FEEDBACK_MULTIMESSAGE_BUFFER_FIX_REPORT.md documenting the fix.

Requirements:
1. Create internal/STAGE2U_F_FEEDBACK_MULTIMESSAGE_BUFFER_FIX_REPORT.md including: root cause; the exact existing /new_goal (CommandFragmentBuffer) pattern reused; files/functions changed; the feedback buffer key (chat/thread/sender/goal-run scoping); continuation-window behavior; lock behavior (lock acquired only after the combined payload is dispatched; late/new attempts still hit the existing lock); tests added; verification results (focused tests, tsc, build, lint outcomes from the verify node).
2. Include manual verification steps: restart gateway; open Incorporate Feedback for a completed goal; send feedback in two quick Telegram messages; confirm SmithersBot does not reply "already being processed" to the second chunk; confirm the plan-revision prompt contains both chunks; confirm a truly separate feedback attempt still respects the lock.

Constraints:
- Document only; do not modify source or tests in this node.
- Do not include secrets, private env/auth/session contents, or raw statusline JSON.

Verification: test -f internal/STAGE2U_F_FEEDBACK_MULTIMESSAGE_BUFFER_FIX_REPORT.md
