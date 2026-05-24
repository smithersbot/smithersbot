# Stage 2U-C — Answered User-Input Resume Normalization & Blocked-Label Formatting Fix

## Summary

Fixed the live resume/display divergence where an answered user-input blocked step
could still render as a hard `blocked` node after resume, even though the scheduler
was already willing to run it. The fix adds a single centralized, answer-aware
resume normalization helper and wires it into the one function every resume path
converges on, so the persisted/rendered step state matches what the executor will
actually do. It also bolds the `Step <id>:` label in Telegram blocked notifications.

This was reproduced live by goal `cbeb572e` (the collider smoke test): two
independent user-input-blocked parents (`collider-parent-a`, `collider-parent-b`)
and one child depending on both. After the operator resumed with the answer,
`collider-parent-a` visibly moved to `in_progress` while `collider-parent-b`
remained visually `blocked` in the DAG/status — yet the run still completed all
three steps. The final persisted state was clean; only the *display during resume*
was wrong.

## Root cause

There was no centralized answer-aware resume/display normalization. The
scheduler and the renderers read step state through two different lenses that
disagreed once an answer arrived:

- **Scheduler lens (runnable):** `findRunnableTasks()` in
  `src/goal/agent-executor.ts` picks *any* `blocked` step for which
  `hasAnswerForTask(step.id, answers)` is true. So an answered user-input block is
  immediately runnable to the executor.
- **Renderer lens (still blocked):** `computeDisplayStatuses()` in
  `src/goal/execution-status.ts`, the blocked-caption builders, status summaries,
  and `aggregateBlockedDetails()` all read the raw persisted `PlanStep.status`.
  The answered step still persisted as `status: "blocked"` +
  `blockedReason: "user_input"`, so every renderer kept drawing it as a hard
  `blocked` node.

The result: the run proceeds past an answered parent (scheduler's view) while the
graph/status keeps showing it as needs-input blocked (renderer's view). Because
the divergence is purely a function of *answer presence vs. persisted status*,
parents whose answer the scheduler hadn't yet consumed at render time appeared
stuck.

## Why prior resume fixes missed it

The earlier resume hardening only normalized **retryable technical / usage-limit**
blocks. `resetRetryableBlockedSteps()` in `src/commands/goal-resume.ts`
deliberately *skips* `user_input` blocks (they genuinely need an operator answer
first), and the usage-limit recheck only revisits usage-limit blocks. Neither path
had any notion of "this user-input block now has an answer," so the one category
that needed answer-aware handling was exactly the one left untouched. There was
also no shared helper between the scheduler's answer logic and the resume path —
the scheduler cleared answered blocks inline when it ran them, but nothing did the
equivalent *before rendering* on resume.

## Resume entry points checked

All public resume entry points converge on `goalResumeCommand()` in
`src/commands/goal-resume.ts`, so wiring the normalization there once covers every
path. Verified:

| Entry point | Path to `goalResumeCommand()` |
| --- | --- |
| CLI `moltbot goal resume <id>` | `src/cli/program/register.goal.ts` → `goalResumeCommand()` |
| Telegram `/goal_resume` | `src/telegram/goal-commands.ts` → `startGoalResume()` → `handleGoalApprove()` → `goalResumeCommand()` |
| Telegram Resume button `gResume:<id>` | same `startGoalResume()` → `handleGoalApprove()` → `goalResumeCommand()` |
| Telegram approve / reaction | `handleGoalApprove()` → `goalResumeCommand()` |
| `/goal_answer` (execution-time blocks) | `src/commands/goal-answer.ts` → stores answer → resumes via `goalResumeCommand()` |
| Add Details `gAD` ForceReply | reply routes to `handleGoalAnswer()` → follows the `/goal_answer` path |
| `resume_execution` auto-retry | not a separate action — a key treated as auto-retryable inside `goalResumeCommand()` |

No entry point needed separate wiring: `/goal_resume`, `gResume`, and
approve/reaction all funnel through `startGoalResume` → `handleGoalApprove` →
`goalResumeCommand`, and Add Details/answer through `handleGoalAnswer` →
`goalAnswerCommand` → `goalResumeCommand`. The `resume_execution` technical
auto-retry is just a key handled within `goalResumeCommand`, so it inherits the
normalization without storing any fake user input.

## Helper added

`normalizeAnsweredUserInputBlocks(steps, answers): string[]` in the new file
`src/goal/resume-state.ts`.

Behavior — for every step that is:

- `status === "blocked"`, **and**
- a user-input block (`blockedReason === "user_input"` **or** `blockedReason == null`,
  i.e. a hard block with no actionable reason — what `isHardBlocked` treats as
  needing the operator), **and**
- has a matching answer via `hasAnswerForTask(step.id, answers)` (reused from
  `src/goal/agent-executor.ts`, so the single-task `task:<id>:input` and multi-task
  `tasks:a,b:input` answer-key shapes are recognized identically to the scheduler),

it performs the same reset the scheduler does when it picks an answered block:
clears `blockedReason`, `blockedQuestion`, and `failedDetail`, zeroes `turnsUsed`,
and sets `status = "pending"`. It applies to **every** matching step (not just the
first) and returns the reset ids.

Deliberately untouched:

- **Unanswered** user-input blocks stay hard `blocked` (still need an answer).
- **Retryable technical / usage-limit** blocks are skipped via the `blockedReason`
  filter — they remain owned by `resetRetryableBlockedSteps()` and the usage-limit
  recheck.
- **Done / in_progress / pending** steps are skipped via the status filter, so
  completed stays done and cancelled runs (which never reach the executing
  transition) keep their persisted blocked steps untouched.
- The **answer is not consumed** — the scheduler still calls
  `consumeAnswerForTask` when it actually runs the step; consuming it here would
  strip the very answer that makes the step runnable.

`COLLIDER_RESUME_OK` is not special-cased anywhere; it is only the test fixture's
answer token.

### Where wired

`goalResumeCommand()` in `src/commands/goal-resume.ts` calls
`normalizeAnsweredUserInputBlocks(session.plan.steps, session.answers)`
immediately **after** the existing `resetRetryableBlockedSteps(session.plan.steps)`
call and **before** `session.state = "executing"` is set and persisted. So the
mutation happens after step status is restored from `stepResults` and after
answers/add-details are applied, but before any rendering or persistence of the
executing transition. The dependency direction stays one-way:
`resume-state.ts` imports from `agent-executor.ts`, not the reverse.

## Files / functions changed

| File | Change |
| --- | --- |
| `src/goal/resume-state.ts` *(new)* | Adds `normalizeAnsweredUserInputBlocks()`. |
| `src/commands/goal-resume.ts` | `goalResumeCommand()` calls the new helper after `resetRetryableBlockedSteps` and before the executing transition; logs `Cleared N answered user-input block(s) to runnable.` |
| `src/telegram/goal-blocked-ui.ts` | `buildBlockedCaption()` per-step line changed to bold the label (see below). |
| `src/goal/resume-state.test.ts` *(new)* | Unit + collider regression tests for the helper. |
| `src/commands/goal-resume.test.ts` | Collider + unanswered-stays-blocked + `resume_execution`-unaffected integration tests; agent-executor mock fixed to preserve real exports via `importOriginal`. |
| `src/commands/goal-answer.test.ts` | Collider multi-task fan-out + auto-resume normalization test; reconciled 2 baseline lock-state assertions. |
| `src/telegram/goal-commands.test.ts` | 8-test block proving normalization through every Telegram resume entry point; updated one send-path assertion to expect the bolded HTML label. |
| `src/goal/execution-status.test.ts` | Collider display test (`computeDisplayStatuses` shows no hard `blocked` after normalization). |
| `src/goal/agent-executor.test.ts` | Run-to-completion collider scheduler test (both answered parents run, then child; answers consumed). |
| `src/telegram/goal-blocked-ui.test.ts` *(new)* | Bold-label rendering + HTML-conversion tests. |

## Collider regression test

The collider shape is exercised at every layer:

- **Helper (`src/goal/resume-state.test.ts`):** two independent
  user-input-blocked parents + one child depending on both, with answers for
  *both* parents. Asserts normalization resets **both** parents to `pending`
  (not just the first), the child is **not** reset (it has no answer / unmet
  deps), and after both parents complete the child becomes runnable and the
  final graph shows all done with no stale `blocked` node.
- **Display (`src/goal/execution-status.test.ts`):** after normalization,
  `computeDisplayStatuses()` shows no hard `blocked` for the answered parents;
  the child renders soft `waiting` (dependency-driven), not needs-input blocked.
- **Scheduler (`src/goal/agent-executor.test.ts`):** a run-to-completion pass —
  both answered parents execute, then the child runs only after both complete,
  and the answers are consumed by the scheduler.
- **Resume integration (`src/commands/goal-resume.test.ts`):** the same shape
  driven through `goalResumeCommand()` (CLI resume shape), plus a variant where
  one parent's answer is *missing* and that parent correctly stays hard blocked,
  plus a `resume_execution` auto-retry test confirming the technical path still
  resumes without fake user input.

## Blocked-message bold-label fix

In `src/telegram/goal-blocked-ui.ts`, `buildBlockedCaption()` previously rendered:

```
• Step ${step.id}: ${describeBlockedStep(step)}
```

Now renders, bolding only the label up to and including the colon:

```
• **Step ${step.id}:** ${describeBlockedStep(step)}
```

The Telegram send path uses `parse_mode` HTML via `markdownToTelegramHtml` in
`src/telegram/format.ts`, which converts `**bold**` to `<b>…</b>`, so the rendered
output is `• <b>Step <id>:</b> …`. Only the label is bold; the (potentially long)
reason text from `describeBlockedStep` stays plain. `describeBlockedStep` reason
text, attempt-history dedup, the `…and N more` truncation, and usage-limit phrasing
are unchanged. No raw backend JSON or secrets are exposed.

`src/telegram/goal-blocked-ui.test.ts` covers: a single blocked step renders the
`Step <id>:` label in bold markdown with the reason left plain; multiple blocked
steps each carry a bold label; a long blocked reason stays plain after the bold
label (exactly two `**` markers); and `markdownToTelegramHtml(caption)` yields
`<b>Step <id>:</b>` while keeping the reason text.

## Tests added

- `src/goal/resume-state.test.ts` (new, 11 tests): single answered block resets;
  unanswered stays blocked; done / in_progress / pending untouched; retryable
  technical and usage-limit untouched; answer not consumed; both
  `task:<id>:input` and `tasks:a,b:input` keys recognized; collider regression
  (both parents reset, child waits then runs to done, no stale blocked node).
- `src/goal/execution-status.test.ts`: collider display assertion.
- `src/goal/agent-executor.test.ts`: run-to-completion collider scheduler test.
- `src/commands/goal-resume.test.ts`: collider integration, unanswered-stays-blocked,
  and `resume_execution`-unaffected tests.
- `src/commands/goal-answer.test.ts`: collider multi-task fan-out + auto-resume
  normalization test.
- `src/telegram/goal-commands.test.ts` (8 tests): normalization through
  `handleGoalApprove` (shared `/goal_resume` + `gResume` + reaction convergence),
  unanswered-stays-blocked, `gResume:<id>` button, `/goal_resume` command,
  approve reaction, Add Details/answer reply routing, and `resume_execution`
  auto-retry with no fake user input.
- `src/telegram/goal-blocked-ui.test.ts` (new, 4 tests): bold label rendering and
  HTML conversion (see above).

## Verification results

All commands run from the repo root on branch
`claw/run/20260524-031437Z-2b69ce0d-6258-47ff-bba0-915d7001e5c7`.

| Command | Result |
| --- | --- |
| `pnpm vitest run` (focused: `goal-resume`, `goal-answer`, `goal-commands`, `execution-status`, `resume-state`, `agent-executor`, `goal-blocked-ui`, `goal-sending`) | **8 files, 410 tests passed** |
| `pnpm exec tsc -p tsconfig.json` | **clean (exit 0)** |
| `pnpm build` | **succeeds (exit 0)** |
| `pnpm lint` (`oxlint --type-aware src test`) | **0 warnings, 0 errors** (2343 files, 104 rules) |

Focused test command:

```
pnpm vitest run \
  src/commands/goal-resume.test.ts \
  src/commands/goal-answer.test.ts \
  src/telegram/goal-commands.test.ts \
  src/goal/execution-status.test.ts \
  src/goal/resume-state.test.ts \
  src/goal/agent-executor.test.ts \
  src/telegram/goal-blocked-ui.test.ts \
  src/telegram/goal-sending.test.ts
```

## Manual verification steps

These are operator steps; the worker does not execute them (the gateway must not
be restarted during goal execution).

1. Restart the gateway so the updated resume normalization and blocked-caption
   formatting are loaded.
2. Run a collider smoke goal: two independent parent steps that both block for
   operator input, and one child step depending on both parents.
3. Confirm both parents block for input (DAG/status show both as needs-input
   blocked).
4. Add details / resume with the test token (the collider fixture answer).
5. Confirm **both** parents leave the blocked visual state — neither remains a
   hard `blocked` node in the DAG/status after resume.
6. Confirm the child waits (soft/dependency `waiting`, not needs-input blocked)
   until both parents are actually done.
7. Confirm the final graph/status shows all steps done with no stale blocked node.
8. Confirm the blocked-step labels render in bold (`Step <id>:` in bold, reason
   plain) in the Telegram blocked notification.

## Scope guardrails honored

No changes to sandbox policy, backend/Codex/Claude fallback logic, token
architecture, post-exec review removal, `/usage_status`, or `pi`. The gateway was
not restarted (restart is documented as a manual step only). No secrets, tokens,
API keys, raw statusline payloads, or private env/config/auth/session contents
appear in this report.
