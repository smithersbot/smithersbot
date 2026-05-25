# Stage 2U-F Backend-Limit Resume DAG State Repair Report

## Root Cause

Live goal `5380a030` resumed after backend usage became available, and the scheduler continued running the goal, but untouched sibling tasks still rendered red/blocked in the DAG.

The persisted plan state was the source of truth mismatch:

- Usage-limit-class sibling steps remained `status: "blocked"` with `blockedReason` values such as `usage_limit`, `rate_limit`, or `out_of_credits`.
- `recheckUsageLimitBackends()` could retarget `executedBackend` to an available compatible backend, but it did not flip the step status back to runnable.
- `resetRetryableBlockedSteps()` explicitly skipped usage-limit blocks, so those siblings stayed persisted as blocked.
- `computeDisplayStatuses()` read the persisted blocked status and mapped the usage-limit class to `usage_limited`, which Mermaid renders with the red blocked class.
- The scheduler still made progress because `agent-executor.ts` builds `retryableBlockedIds` from blocked steps with a non-`user_input` `blockedReason`, so it could pick those steps even while the renderer saw stale blocked state.

This was not a cached Telegram payload issue, not a Mermaid rendering issue, and not a runnable-task scheduler issue. The bug was stale persisted resume state.

## Why The Prior Test Missed It

The existing resume/recompute test asserted that a usage-limit step retargeted to an available backend should still display as `usage_limited`. That codified the stale display behavior: it verified the graph stayed red after `executedBackend` changed instead of verifying that the persisted step became runnable before display computation.

The updated expectation is that a usage-limit-class block with a currently compatible backend is normalized to `pending`, so `computeDisplayStatuses()` renders it as pending rather than `usage_limited`.

## Blocked Reason Classification

| blockedReason | Resume classification | Resume behavior |
| --- | --- | --- |
| `user_input` | `hard_user_input` unless an answer exists; then `answered_user_input` | Unanswered stays blocked. Answered resets to `pending`. |
| undefined / missing | `hard_user_input` unless an answer exists; then `answered_user_input` | Treat as a hard operator block unless answered. |
| `turn_limit` | `retryable_technical` | Reset to `pending` when dependencies are satisfied. |
| `timeout` | `retryable_technical` | Reset to `pending` when dependencies are satisfied. |
| `error` | `retryable_technical` | Reset to `pending` when dependencies are satisfied. |
| `task_failed` | `retryable_technical` | Reset to `pending` when dependencies are satisfied. |
| `rate_limit` | backend/config availability-gated usage-limit class | Reset only when a compatible backend is currently available; otherwise remain usage-limited. |
| `usage_limit` | backend/config availability-gated usage-limit class | Reset only when a compatible backend is currently available; otherwise remain usage-limited. |
| `process_lost` | `retryable_technical` | Reset to `pending` when dependencies are satisfied. |
| `out_of_credits` | backend/config availability-gated usage-limit class | Reset only when a compatible backend is currently available; otherwise remain usage-limited. |
| `auth` | backend/config availability-gated auth class | Reset only when the relevant backend/config is currently usable; otherwise remain blocked. |
| `network` | `retryable_technical` | Reset to `pending` when dependencies are satisfied. |
| `other` | `retryable_technical` | Reset to `pending` when dependencies are satisfied. |

Auth and usage-limit blockers are deliberately not treated as unconditional technical retries. Both are gated on current backend/config availability.

## Files And Functions Changed

- `src/goal/resume-state.ts`
  - Added `classifyBlockedStepForResume()`.
  - Added the closed `ResumeBlockedStepClassification` union.
  - Reused `hasAnswerForTask()`, `isUsageLimitClassReason()`, and `isRetryableBlocked()` so blocked-reason rules are centralized.
- `src/goal/resume-state.test.ts`
  - Added focused classifier coverage for hard/answered user input, missing reasons, retryable technical reasons, usage-limit availability, usage-limit unavailability, auth-resolvable, and auth-unresolved.
- `src/commands/goal-resume.ts`
  - Added `normalizeBlockedStepsForResume()`.
  - Runs normalization after `detectBackendAvailability()` and `recheckUsageLimitBackends()` and before executing/persisting resumed state.
  - Keeps legacy `resetRetryableBlockedSteps()` behavior compatible by excluding usage-limit and auth blocks from that older context-free helper.
- `src/commands/goal-resume.test.ts`
  - Updated the prior recompute test to expect retargeted usage-limit steps to render pending.
  - Added regression coverage for backend-limit sibling normalization, no-compatible-backend preservation, retryable technical reset, and auth availability gating.

## Classifier Behavior

`classifyBlockedStepForResume(step, context)` is pure and read-only. The context supplies answer state plus backend/config availability predicates.

- User-input block: `blockedReason === "user_input"` or missing reason.
  - If `hasAnswerForTask(step.id, answers)` is true, classify as `answered_user_input`.
  - Otherwise classify as `hard_user_input`.
- Technical retry block: non-usage-limit, non-auth retryable reason such as `turn_limit`, `timeout`, `error`, `task_failed`, `process_lost`, `network`, or `other`.
  - Classify as `retryable_technical`.
- Usage-limit available block: `rate_limit`, `usage_limit`, or `out_of_credits` and the resolved compatible backend is currently available.
  - Classify as `retryable_usage_limit_available`.
- Usage-limit unavailable block: same usage-limit class, but no compatible backend is currently available.
  - Classify as `usage_limit_no_compatible_backend`.
- Auth-resolvable block: `blockedReason === "auth"` and the relevant backend/config is currently usable.
  - Classify as `retryable_auth_resolvable`.
- Auth-unresolved block: `blockedReason === "auth"` and backend/config is still unavailable or unusable.
  - Classify as `auth_unresolved`.

## Resume Normalization Behavior

During `/goal_resume`, after current backend availability is detected and usage-limit blocks have been rechecked/retargeted:

- Iterate all plan steps.
- Only consider steps with `status === "blocked"`.
- Only reset steps whose dependencies are already satisfied.
- Reset steps classified as `retryable_technical`, `retryable_usage_limit_available`, `retryable_auth_resolvable`, or `answered_user_input`.
- Reset means:
  - `status = "pending"`
  - clear `blockedReason`
  - clear `blockedQuestion`
  - clear `failedDetail`
  - `turnsUsed = 0`
- Do not clear unanswered user-input blocks.
- Do not clear missing-reason hard blockers unless an answer exists.
- Do not clear usage-limit-class blocks when no compatible backend is currently available.
- Do not clear auth/config blocks unless the relevant backend/config is now usable.
- Do not clear backend-override locked usage-limit blocks through fallback; they remain blocked unless the locked backend is available.

Because the persisted source of truth is normalized before execution and status rendering, `computeDisplayStatuses()` now renders eligible backend-limit siblings as pending instead of `usage_limited`/red. Active tasks still render active/in-progress through the existing execution path, and final child/report tasks remain pending until dependencies complete.

## Tests Added Or Updated

- `src/goal/resume-state.test.ts`
  - Classifier tests for all closed classifications and blocked-reason categories.
- `src/commands/goal-resume.test.ts`
  - Updated resume recompute expectation for a usage-limit step retargeted to an available backend.
  - Six independent usage-limit-class sibling tasks plus a final report child: eligible siblings normalize to pending, the final child remains pending, no stale top-level blocker remains, and display statuses do not include `usage_limited`.
  - Usage-limit block with no compatible backend remains blocked and displays `usage_limited`.
  - Unanswered user-input blocks stay blocked; existing answered user-input normalization remains covered.
  - Retryable technical blocks reset to pending.
  - Auth blocks reset only when the relevant backend/config is currently usable.

## Verification Results

All required verification passed in this workspace:

- `pnpm vitest run src/goal/resume-state.test.ts src/commands/goal-resume.test.ts`
  - Passed: 2 test files, 91 tests.
- `pnpm exec tsc -p tsconfig.json`
  - Passed.
- `pnpm build`
  - Passed.
- `pnpm lint`
  - Passed: 0 warnings, 0 errors.

## Manual Verification Steps

These are operator instructions only. This worker did not restart the gateway.

1. Restart the gateway from the operator environment.
2. Run or resume a goal with several sibling tasks blocked by backend-limit reasons such as `usage_limit`, `rate_limit`, or `out_of_credits`.
3. After usage/backend availability returns, resume the goal.
4. Confirm one selected task renders active/in-progress while executing.
5. Confirm other eligible sibling tasks render pending, not red/blocked or usage-limited.
6. Confirm the final child/report task remains pending until all sibling dependencies complete.
7. Confirm no stale top-level usage-limit blocker appears after resume.
8. Confirm user-input blocked tasks remain blocked unless a matching answer has been provided.
