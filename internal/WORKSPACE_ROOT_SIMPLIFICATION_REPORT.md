# Workspace Root Simplification Report

## What changed

- The managed workspace default project root is now `<managed-root>/agent/workspaces/<workspace-name>`.
- The workspace resolver keeps deterministic compatibility for legacy `<managed-root>/agent/workspaces/<workspace-name>/repo` checkouts.
- Setup/import/clone/copy behavior now materializes new workspaces directly at `agent/workspaces/<workspace-name>`.
- Worker contract, planner prompt wording, README, and SETUP docs now describe the simplified workspace model.
- Agent-history workspace-name extraction understands both the new workspace-root layout and legacy `repo` child layout.

## What stayed unchanged

- Private env paths remain `<managed-root>/private/env/<workspace-name>/.env`.
- Gateway-private config paths were intentionally not changed.
- Git checkpoint behavior and branch naming were intentionally not changed.
- `/goal_github_push` behavior was intentionally not changed.
- Sandbox/security behavior was intentionally not changed.
- No existing files were moved or deleted.

## Compatibility behavior

Existing legacy workspaces continue to work. Resolution prefers `<managed-root>/agent/workspaces/<workspace-name>` for new workspaces. If the workspace root has no project content and `<managed-root>/agent/workspaces/<workspace-name>/repo` exists as a non-empty directory or Git repository, the resolver returns the legacy `repo` directory. If the workspace root already contains project content, it remains the project root.

Path checks keep resolved workspace paths under the managed agent root and prevent fallback from escaping into private or unrelated trees.

## Files changed

- `src/config/managed-paths.ts`
- `src/config/managed-paths.test.ts`
- `src/commands/goal.ts`
- `src/commands/goal.test.ts`
- `src/goal/agent-history.ts`
- `src/goal/agent-history.test.ts`
- `scripts/setup-smithersbot.sh`
- `test/setup-smithersbot.test.ts`
- `src/goal/worker-context/shared-worker-contract.md`
- `src/goal/worker-context/AGENTS.md`
- `src/goal/worker-context/CLAUDE.md`
- `src/prompts/shared/plan-quality-rubric.ts`
- `src/prompts/prompts.test.ts`
- `src/goal/worker-context.test.ts`
- `README.md`
- `SETUP.md`
- `internal/WORKSPACE_ROOT_SIMPLIFICATION_REPORT.md`

## Tests added or updated

- Managed-path resolver tests now cover new default roots, legacy fallback, empty legacy directories, project-content precedence, private env separation, and symlink escape rejection.
- Goal command tests now expect the new default managed workspace root.
- Agent-history tests now cover both new workspace-root and legacy `repo` layouts.
- Setup script tests now cover local Git clone, clone-URL fixture, non-Git copy fallback, generated config workspace path, private env location, and no new `repo` child for new workspaces.
- Prompt and worker-context tests now pin the new workspace wording while preserving byte-identical worker contract mirrors.
- README/SETUP doc assertions now cover the new workspace path and secret model while retaining sandbox caveats.

## Verification commands and results

- `pnpm vitest run src/config/managed-paths.test.ts src/commands/goal.test.ts src/goal/agent-history.test.ts` - passed, 3 files and 30 tests.
- `pnpm vitest run test/setup-smithersbot.test.ts` - passed, 1 file and 12 tests.
- `pnpm vitest run src/prompts/prompts.test.ts src/goal/worker-context.test.ts` - initially failed because README/SETUP no longer contained pinned sandbox caveat wording; after restoring that wording, passed, 2 files and 69 tests.
- `pnpm exec tsc -p tsconfig.json` - passed.
- `pnpm build` - passed.
- `pnpm lint` - passed with 0 warnings and 0 errors.
- `pnpm format` - passed; all matched files use the correct format.

## Remaining risks

- Operators with unusual existing workspace roots should confirm whether their workspace root has project content; when both the root and `repo` child contain content, the root now wins by design.
- The compatibility behavior does not move or clean up legacy `repo` directories, so mixed-layout workspaces may need manual operator review if their contents diverge.
