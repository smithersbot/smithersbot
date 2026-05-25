# Git Push Visibility And Docs Report

Date: 2026-05-25

## Scope

This launch-focused change makes SmithersBot's completed-goal GitHub push result visible after the run, clarifies the global `/goal_github_push` behavior, and documents the current Git model across workspaces.

## Already Working And Intentionally Unchanged

- SmithersBot already creates a branch per executed goal after approval, at execution start.
- Checkpoints are normal local Git commits on the goal branch.
- Local-only workspaces remain valid.
- `/goal_github_push` remains a global setting and stays off by default.
- Push behavior was not made per-workspace.
- Setup behavior, remote validation, and auth validation were not changed.
- `isRepoPrivate` was not refactored.
- No automatic remote repair, automatic push enablement, force-push, main-branch push, or release flow was added.

## What Changed

- Completed goal finalization now records a structured `githubPushOutcome` for every completion path:
  - push disabled
  - push enabled but skipped
  - push attempted and failed
  - push attempted and succeeded
- The outcome is persisted in the canonical serialized run artifact and restored back into `GoalSession`.
- The agent-visible history mirror now includes a redacted copy of the push outcome.
- Telegram `/goal_github_push` wording now describes the setting as global and explains that eligibility is based on each completed goal's working directory.
- README now includes a concise "Git across workspaces" section.

## Files Changed

- `src/goal/types.ts`
- `src/goal/agent-executor.ts`
- `src/goal/run-store.ts`
- `src/goal/agent-history.ts`
- `src/goal/agent-executor.test.ts`
- `src/goal/run-store.test.ts`
- `src/goal/agent-history.test.ts`
- `src/telegram/goal-commands.ts`
- `src/telegram/goal-commands.test.ts`
- `README.md`
- `test/readme-git-section.test.ts`
- `internal/GIT_PUSH_VISIBILITY_AND_DOCS_REPORT.md`

## Tests Added Or Updated

- `src/goal/agent-executor.test.ts` covers successful, skipped, failed, and disabled push outcomes at goal completion.
- `src/goal/run-store.test.ts` covers `githubPushOutcome` serialization and restoration.
- `src/goal/agent-history.test.ts` covers agent-visible history mirroring and redaction of sensitive push outcome fields.
- `src/telegram/goal-commands.test.ts` covers no-argument, `on`, and `off` `/goal_github_push` wording.
- `test/readme-git-section.test.ts` covers the README Git section and required launch terms.

## Push Outcome Persistence

`GoalSession` and `SerializedRun` now carry an optional `githubPushOutcome` field. The executor sets it before run-state persistence in the completed-goal path.

The recorded fields include whether GitHub push was enabled, the goal branch, remote when applicable, whether a push was attempted, whether it succeeded, pushed SHA when available, PR URL when created, a skip or failure message when applicable, and an ISO timestamp.

`sessionToSerialized` writes the outcome into `run.json`, and `serializedToSession` restores it. `mirrorGoalRunToAgentHistory` also writes the outcome into the curated agent-visible summary under `agent/history`, using the existing redaction and truncation helpers for remote, PR URL, and message fields.

## Telegram Wording

`/goal_github_push` remains global. The no-argument status response now reports whether the global mode is `on` or `off` and explains that enabled mode only attempts to push completed goal branches when that goal's working directory is eligible for GitHub push.

The `on` and `off` confirmations use the same behavior text. They do not scan remotes, validate auth, or claim any current workspace can push.

## README Git Section

The README now explains that SmithersBot can run goals in any workspace repo and that Git behavior follows the goal working directory. It documents branch creation after approval, the `claw/run/<timestamp>-<goal-id>` branch shape, dirty-tree autosave, per-task checkpoint commits, reset-based retry/recovery, and that there is no separate final "goal complete" commit.

It also documents local-only workspace support, possible local initialization for non-git folders, global off-by-default `/goal_github_push`, recorded push skips/failures, GitHub CI only running after an actual GitHub push in repos with CI configured, local verification gates being separate from GitHub CI, and the need to review branches or PRs before merging.

## Verification Results

Final cross-cutting verification passed in this worker:

- `pnpm vitest run src/goal/agent-executor.test.ts src/goal/run-store.test.ts src/goal/agent-history.test.ts src/telegram/goal-commands.test.ts test/readme-git-section.test.ts` passed: 5 files, 323 tests.
- `pnpm exec tsc -p tsconfig.json` passed.
- `pnpm build` passed.
- `pnpm lint` passed with 0 warnings and 0 errors.
- `pnpm format` passed.

## Remaining Risks And Deferred Improvements

- Push eligibility and auth are still evaluated only by the existing completion-time behavior; setup and `/goal_github_push` intentionally do not validate remotes or credentials.
- Push outcome messages intentionally reuse existing human-readable strings instead of introducing a reason-code taxonomy.
- GitHub CI visibility remains dependent on whether a branch is actually pushed to GitHub and whether that repository has CI configured.
- Operators should continue reviewing local branches or PRs before merging completed goal work.
