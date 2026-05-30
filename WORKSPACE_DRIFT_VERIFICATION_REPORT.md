# Workspace Drift Enforcement Verification

## Root Cause

Workspace-name resolution was already mapping stable/default `smithersbot-dev` goals to the correct stable checkout:

`/home/matt/smithersbot-home/agent/workspaces/smithersbot-dev`

The drift came from execution-time trust of unvalidated working directories. The old `assertGoalWorkerWorkspace` had a legacy out-of-root warn-and-allow path, and command/Telegram handlers called `mkdirSync` or `ensureWorkingDir` before validation on both the explicit/config/default pre-planning working directory and the post-plan `planResult.workingDir`. `git-checkpoint` also called `fs.mkdirSync` and `git init` before a strict executable-workspace decision. That let a stable-owned goal drift into the observed dev runtime surface:

`/home/matt/smithersbot-dev-home/agent/workspaces/smithersbot-dev`

## Enforced Invariant

Goal execution, editing, building, checkpointing, and worker launch now require the effective working directory to resolve under the current gateway instance's own `agent/workspaces` tree.

For the stable/default instance, executable goal workspaces must be under:

`/home/matt/smithersbot-home/agent/workspaces`

For the true dev instance, executable goal workspaces must be under:

`/home/matt/smithersbot-dev-home/agent/workspaces`

Observed instance agent surfaces remain readable for context only. They are never accepted as executable/editable goal working directories by another instance.

## Files Changed

- `src/goal/workspace-policy.ts`
- `src/goal/workspace-policy.test.ts`
- `src/config/observed-instance.test.ts`
- `src/config/managed-paths.test.ts`
- `src/commands/goal.ts`
- `src/commands/goal.test.ts`
- `src/commands/goal-resume.ts`
- `src/commands/goal-resume.test.ts`
- `src/telegram/goal-commands.ts`
- `src/telegram/goal-commands.test.ts`
- `src/goal/git-checkpoint.ts`
- `src/goal/git-checkpoint.test.ts`
- `src/goal/build-gate.ts`
- `src/goal/build-gate.test.ts`
- `src/goal/agent-executor.ts`
- `src/goal/agent-executor.test.ts`
- `src/goal/git-checkpoint.push.test.ts`
- `src/goal/cli-worker.test.ts`
- `src/goal/goal-workflow-integration.test.ts`
- `src/prompts/planner/system-prompt.ts`
- `src/goal/plan-autocheck.ts`
- `src/goal/planner.test.ts`
- `src/goal/plan-autocheck.test.ts`
- `WORKSPACE_DRIFT_VERIFICATION_REPORT.md`

Generated `dist/` output was produced by `pnpm build`; it was not edited by hand.

## Enforcement Points

- Planner guidance: `src/prompts/planner/system-prompt.ts`, consumed by the planner path in `src/goal/planner.ts`, now tells planners that executable/editable `workingDir` values must stay inside the current instance's own managed `agent/workspaces` root. It also states observed instance workspaces/history are context-only.
- Plan autocheck: `src/goal/plan-autocheck.ts` exports `checkPlanWorkingDir`, which delegates to the shared workspace-policy helper before reviewer execution when workspace policy identity is supplied. Rejections include edit instructions naming the correct current-instance workspaces root.
- Shared policy: `src/goal/workspace-policy.ts` exports `assertWorkingDirInsideCurrentInstanceWorkspaces` and `assertGoalWorkerWorkspace`. The helper uses explicit gateway instance identity and managed/observed-instance helpers, not checkout-path inference.
- CLI command pre-planning guard: `src/commands/goal.ts` validates the explicit/config/default `workingDir` unconditionally before `mkdirSync` or `ensureWorkingDir`.
- CLI command post-plan guard: `src/commands/goal.ts` validates `planResult.workingDir` before post-plan adoption and directory preparation.
- Resume guard: `src/commands/goal-resume.ts` validates persisted and planner-selected working directories before `ensureWorkingDir`, persistence, worker dispatch, or retry planning.
- Telegram guards: `src/telegram/goal-commands.ts` validates plan edit/autocheck/feedback/approval working directories before `ensureWorkingDir` and dispatch.
- Git checkpoint guard: `src/goal/git-checkpoint.ts` validates goal-execution working directories at the top of `ensureWorkingDir`, before `fs.mkdirSync`, `git init`, checkpoint, reset, or autosave mutation. The explicit create-repo escape hatch remains separate and is not used for normal goal execution.
- Executor guard: `src/goal/agent-executor.ts` validates the effective `planResult.workingDir` before worker launch and before build-gate execution.
- Build-gate guards: `src/goal/build-gate.ts` validates in `runBuildGateCommands`, `resolveChangedFilesSinceCheckpoint`, `resetToTaskBaseSha`, and `buildDefaultSastCommand` before spawn, git reset/checkpoint operations, or changed-file resolution.
- Worker entrypoint defense: `src/goal/cli-worker.ts` also keeps the shared assertion before worker execution.

## Push Policy

No push was performed automatically during this task.

The covered push policy is: push only after the run reaches the post-verification/post-build-gate completion path, target the private dev repo remote `origin`, and never target remote `public`.

Proof tests:

- `src/goal/agent-executor.test.ts` includes the origin-only regression proving completed runs push to `origin`, never include `public`, and record `remote: "origin"`.
- `src/goal/agent-executor.test.ts` includes the no-early-push regression proving a blocked run issues no `git push` before completion/gates.
- `src/goal/git-checkpoint.push.test.ts` proves `pushRunBranch` defaults to `origin` and never targets `public` in the default push path.

Any manual push after verification must be to `origin` only and must never target `public`.

## Proof Of Workspace Rejection

Stable/default acceptance:

- `src/config/managed-paths.test.ts` proves `resolveWorkspaceRepoDir("smithersbot-dev")` resolves to `/home/matt/smithersbot-home/agent/workspaces/smithersbot-dev`.
- `src/goal/workspace-policy.test.ts` proves stable/default accepts `/home/matt/smithersbot-home/agent/workspaces/smithersbot-dev`.

Stable/default rejection:

- `src/goal/workspace-policy.test.ts` proves stable/default rejects `/home/matt/smithersbot-dev-home/agent/workspaces/smithersbot-dev` as outside the current stable instance's own `agent/workspaces` tree, with an observed/foreign read-only-for-context explanation. The same denial holds even when the legacy compatibility flag is enabled.
- `src/goal/workspace-policy.test.ts` proves stable/default rejects arbitrary out-of-root executable paths such as `/tmp/whatever` and home config/auth/session-sensitive paths.
- `src/commands/goal.test.ts`, `src/commands/goal-resume.test.ts`, `src/telegram/goal-commands.test.ts`, `src/goal/git-checkpoint.test.ts`, `src/goal/build-gate.test.ts`, and `src/goal/agent-executor.test.ts` prove those invalid paths are rejected before directory preparation, git init, command spawn, worker launch, or build-gate execution.

Dev-instance behavior:

- `src/goal/workspace-policy.test.ts` proves a true dev instance accepts `/home/matt/smithersbot-dev-home/agent/workspaces/<workspace>`.
- `src/goal/workspace-policy.test.ts` proves a true dev instance rejects `/home/matt/smithersbot-home/agent/workspaces/<workspace>` as a foreign stable instance root.

## Context Readability And Private Denial

Observed dev agent surfaces remain readable for context:

- `src/config/observed-instance.test.ts` proves `resolveObservedInspectionTarget` classifies `/home/matt/smithersbot-dev-home/agent/workspaces`, child workspaces, and `/home/matt/smithersbot-dev-home/agent/history` as `kind: "agent"` when dev observation is opted in.
- `src/repo-chat/dev-private-deny-policy.test.ts` continues to prove the observed dev agent workspaces/history surfaces are inspectable for repo-chat/context policy.

Dev private roots remain denied:

- `src/config/observed-instance.test.ts` proves dev private/state surfaces classify as `kind: "sealed"`.
- `src/goal/workspace-policy.test.ts` proves private-root and private-symlink working directories are hard-denied for goal execution.
- Private examples are represented only as placeholders here, such as `<dev-managed-root>/private/**` and `~/.smithersbot-dev/**`.

## Legacy Escape Hatch

The old Stage 2S out-of-root warn-and-allow behavior has been removed for executable goal working directories. The retained legacy compatibility flag does not admit another instance's managed root, observed roots, private roots, or home/config/auth/session-sensitive roots; tests prove the observed dev-home path is still denied even when the flag is set.

## Verification Run

Required matrix run in order:

1. `pnpm vitest run src/telegram/ src/hooks/ src/goal/ src/repo-chat/ src/memory/`
   - Passed: 138 test files, 2077 tests passed, 18 skipped.
2. `pnpm exec tsc -p tsconfig.json`
   - Passed with no TypeScript errors.
3. `pnpm build`
   - Passed.
4. `pnpm lint`
   - Passed: 0 warnings, 0 errors.
5. `pnpm format`
   - Passed: all matched files use the correct format.

Focused verification already completed by dependency tasks:

- `pnpm vitest run src/goal/workspace-policy.test.ts src/config/observed-instance.test.ts src/config/managed-paths.test.ts`
- `pnpm vitest run src/commands/goal.test.ts src/commands/goal-resume.test.ts src/telegram/goal-commands.test.ts src/goal/git-checkpoint.test.ts src/goal/build-gate.test.ts src/goal/agent-executor.test.ts src/goal/git-checkpoint.push.test.ts`
- `pnpm vitest run src/goal/planner.test.ts src/goal/plan-autocheck.test.ts`

## Manual Checks

No additional manual checks were required for this verification/report task.

Live dev-gateway restart and runtime smoke verification are intentionally left to the dependent `dev-gateway-live-verify` task. This task did not restart, stop, enable, disable, reinstall, or otherwise modify the stable gateway or the dev gateway.

No push was performed automatically. Any later push must be post-verification, to `origin` only, and never to remote `public`.
