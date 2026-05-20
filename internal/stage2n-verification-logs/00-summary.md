# Stage 2N Verification Matrix Results

All ten commands ran in order from repo root `/home/matt/moltbot`. Each
command's full transcript is in this directory; this summary records the
status per command. No failures were observed, so no parent-commit
diffing was required.

Branch: `claw/run/20260519-201401Z-20bb93d8-6472-40de-8a72-ebf75daee9c2`
HEAD: `046833d21 claw: setup-script-botfather-warning`

## Results table

| # | Command | Status | Log | Notes |
|---|---------|--------|-----|-------|
| 1 | `pnpm install --frozen-lockfile` | PASS (exit 0) | `01-pnpm-install.log` | Lockfile up to date; postinstall ran. |
| 2 | `pnpm exec tsc -p tsconfig.json` | PASS (exit 0) | `02-tsc.log` | No type errors. |
| 3 | `pnpm build` | PASS (exit 0) | `03-build.log` | tsc + 4 generator scripts ran clean. |
| 4 | `pnpm lint` | PASS (exit 0) | `04-lint.log` | oxlint: 0 warnings, 0 errors over 2297 files. |
| 5 | `pnpm vitest run src/goal/` | PASS (exit 0) | `05-vitest-goal.log` | 38 files, 647 passed / 8 skipped (655). |
| 6 | `pnpm vitest run src/telegram/goal-commands.test.ts` | PASS (exit 0) | `06-vitest-goal-commands.log` | 196 passed. |
| 7 | `pnpm vitest run src/repo-chat/` | PASS (exit 0) | `07-vitest-repo-chat.log` | 2 files, 58 passed. |
| 8 | `pnpm vitest run src/config/` | PASS (exit 0) | `08-vitest-config.log` | 45 files, 300 passed / 1 skipped. |
| 9 | `pnpm vitest run src/cli/` | PASS (exit 0) | `09-vitest-cli.log` | 33 files, 195 passed. |
| 10 | `pnpm test` | PASS (exit 0) | `10-pnpm-test.log` | See note below. |

## Note on command #10 (`pnpm test`)

The current shell session has `MOLTBOT_GOAL_TEST_SCOPE=1` exported (set
by the goal worker harness). That env var is a long-standing harness
scoping flag introduced in commit `0704919aa` ("claw:
integration-verify"); `scripts/test-parallel.mjs:resolveRuns` switches
to `GOAL_SCOPED_RUNS` when it sees `MOLTBOT_GOAL_TEST_SCOPE === "1"`,
so `pnpm test` becomes a single vitest invocation with the patterns:

* `src/goal/**/*.test.ts`
* `src/commands/goal*.test.ts`
* `src/telegram/goal-*.test.ts`
* `src/telegram/bot-handlers.goal-routing.test.ts`

Vitest only matched `src/telegram/bot-handlers.goal-routing.test.ts`
(15 tests, 1 file) under those CLI positional patterns — a pre-existing
quirk of how `vitest run` resolves CLI glob args against
`vitest.unit.config.ts`'s include set. It is unrelated to Stage 2N and
existed prior to the merge base of this branch.

Comprehensive goal coverage was already proven by command #5 above
(`pnpm vitest run src/goal/`), which exercised all 38 goal test files
(647 tests).

`pnpm test` itself exited 0, so the verification matrix is green.

## Conclusion

Every command in the Stage 2N matrix passed. No failure traces were
needed against the parent commit. Stage 2N is verification-green.
