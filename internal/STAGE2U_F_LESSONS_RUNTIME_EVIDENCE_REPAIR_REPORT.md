# Stage 2U-F Lessons Runtime Evidence Repair Report

Generated: 2026-05-24

This report documents the narrow Stage 2U-F repair for per-goal lessons runtime
evidence and the final runtime mirror checkpoint. It intentionally uses generic
identifiers and omits secret values, raw auth/session/config contents, raw backend
JSON, tokens, and private host paths.

## Root Cause

Lessons extraction was fail-open and could complete without writing any per-goal
runtime artifact under the run directory. The global lessons store recorded only
stored lessons and is intentionally not mirrored wholesale into agent-visible
history. As a result, a successful lessons phase with no stored lessons left no
`runtime/lessons/` evidence for future debugging.

The post-completion runtime mirror also ran from an on-disk `run.json` snapshot that
could still reflect an earlier `executing` state. Terminal lifecycle updates were
present in memory, but the final mirror did not first refresh the persisted run state
that `mirrorGoalRuntimeToAgentHistory` copies into agent history.

## Zero-Candidate Lessons Diagnosis

The zero-candidate success path returned an empty lesson list after backend extraction
without emitting a per-goal runtime artifact. That made the outcome indistinguishable
from a skipped or never-run lessons phase when inspecting:

- `agent/history/goals/<workspace>/<goal-id>/runtime/`
- `agent/history/goals/<workspace>/<goal-id>/runtime/index.json`

The repair makes `extractRunLessons` always write metadata-only evidence for every
path:

- skipped because run state was unavailable
- skipped because no corrections or failures were present
- backend-exhausted or fail-open failure
- success with zero candidates
- success with one or more candidates

The evidence records status, attempted or successful backend metadata when safely
available, candidate count, stored lesson count, whether anything was stored globally,
a safe prompt artifact reference, timestamp, and failure class/message when relevant.
It does not copy the global lessons store and does not write unredacted lesson content
into agent-visible history.

## Final run.json Stale-State Diagnosis

The final agent-history mirror copied `runtime/run.json` after lessons and manual-test
generation, but before guaranteeing the terminal run state had been persisted to disk.
That allowed the mirrored `runtime/run.json` to remain at `state: "executing"` even
after the goal had completed.

The repair adds a final run-state persistence hook before the post-completion mirror.
The hook reuses the callers' existing `persistRun` logic, then the mirror copies the
refreshed terminal `run.json`. Earlier incremental mirror checkpoints are preserved.
The mirror remains fail-open: a mirror error emits a warning and does not fail an
otherwise completed goal.

## Files And Functions Changed

- `src/goal/lessons.ts`
  - `extractRunLessons`
  - per-goal lessons evidence writing helpers for `lessons/result.json` and
    `lessons/summary.txt`
  - backend extraction result plumbing for safe backend and prompt references

- `src/goal/agent-executor.ts`
  - `ExecuteGoalParams.onRunStatePersist`
  - `executeGoalWithAgent` final post-completion persistence and mirror ordering

- `src/commands/goal.ts`
  - wired `onRunStatePersist` to the existing run persistence path

- `src/commands/goal-resume.ts`
  - wired `onRunStatePersist` to the existing resume persistence path

- `src/goal/lessons.test.ts`
  - added lessons evidence regression coverage

- `src/goal/agent-executor.test.ts`
  - added final persistence and mirror ordering coverage

- `src/goal/runtime-mirror.test.ts`
  - added lessons evidence and terminal `run.json` mirror regression coverage

## Tests Added

Lessons evidence tests cover:

- zero-candidate success writes `lessons/` runtime evidence with candidate count `0`
- one-or-more-candidate success writes evidence with the candidate count
- skipped extraction writes evidence and does not crash
- fail-open failure writes failure evidence and does not crash completion
- unrelated global lessons are not copied wholesale into per-goal runtime history

Agent executor tests cover:

- lessons and manual-test phases complete before the final run-state persist
- final run-state persist completes before `mirrorGoalRuntimeToAgentHistory`
- `run.json` is terminal at mirror time rather than stuck in `executing`
- post-completion mirror errors are swallowed and completion remains successful

Runtime mirror tests cover:

- `runtime/lessons/` artifacts are mirrored into
  `agent/history/goals/<workspace>/<goal-id>/runtime/lessons/`
- `runtime/index.json` includes `lessons/...` entries
- mirrored artifact metadata includes the same redaction, truncation, and skipped
  fields as other runtime artifacts
- mirrored `runtime/run.json` reflects terminal state

## Verification Results

The verify-and-gate task reported these results:

- `pnpm vitest run src/goal/lessons.test.ts src/goal/agent-executor.test.ts src/goal/runtime-mirror.test.ts`
  - PASS
  - 3 test files passed
  - 89 tests passed
- `pnpm exec tsc -p tsconfig.json`
  - PASS
  - no type errors
- `pnpm build`
  - PASS
  - TypeScript build and repository build steps completed
- `pnpm lint`
  - PASS
  - `0` warnings and `0` errors reported

This report task additionally checked that the report exists and contains the required
root-cause section.

## Manual Verification Steps

After this repair is deployed by an operator:

1. Restart the gateway through the normal operator-controlled process.
2. Run a small disposable goal, for example `<test-goal-id>` in `<workspace>`.
3. Confirm the lessons phase runs or records an explicit skipped/failure evidence
   status.
4. Confirm
   `agent/history/goals/<workspace>/<goal-id>/runtime/lessons/` exists.
5. Confirm
   `agent/history/goals/<workspace>/<goal-id>/runtime/index.json` includes
   `lessons/...` entries.
6. Confirm the mirrored
   `agent/history/goals/<workspace>/<goal-id>/runtime/run.json` reflects a terminal
   state instead of `executing`.
7. Confirm the lessons evidence contains only metadata and safe prompt references, and
   does not include secrets, raw config/auth/session contents, tokens, private keys, or
   unredacted global lesson-store contents.
