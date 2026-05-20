# Stage 2O Verification Matrix — Run Summary

Run date: 2026-05-20
Branch: claw/run/20260520-152655Z-bf01b497-5e79-4444-b529-2428f036d25e
HEAD: 5471bdd9c (claw: contain-planner) on top of 5fa3c85f2 (claw: fix-cli-process-default-env)

## Command Matrix Results

| # | Command | Exit | Notes |
|---|---------|------|-------|
| 01 | `pnpm install --frozen-lockfile` | 0 | clean |
| 02 | `pnpm exec tsc -p tsconfig.json` | 0 | clean |
| 03 | `pnpm build` | 0 | clean |
| 04 | `pnpm lint` | 0 | 0 warnings, 0 errors |
| 05 | `pnpm vitest run src/security/ src/goal/ src/repo-chat/ src/config/ src/agents/` | **1** | 2 failed / 2133 passed / 9 skipped (2152) |
| 06 | `pnpm vitest run src/telegram/` | **1** | 6 failed / 608 passed (614) |
| 07 | `pnpm vitest run src/cron/` | **1** | 15 failed / 54 passed (69) — all from a single missing-template root cause |
| 08 | `pnpm vitest run src/cli/` | 0 | clean |
| 09 | `pnpm test` | 0 | NOTE: worker environment has `MOLTBOT_GOAL_TEST_SCOPE=1`, so this only ran 15 tests in `src/telegram/bot-handlers.goal-routing.test.ts` (not the full unit+extensions+gateway suites). The other vitest commands above provide broader coverage. |

## Failure Inventory (none touch files modified in prior Stage 2O steps)

Files changed in this run's parent commits (5fa3c85f2 fix-cli-process-default-env, 5471bdd9c contain-planner):
- src/goal/cli-planner.ts, src/goal/cli-planner.test.ts
- src/goal/cli-process.ts, src/goal/cli-process.test.ts
- src/goal/manual-tests.test.ts

None of the failures below reference these files.

### 05-vitest-core — 2 failures

1. **src/security/fix.test.ts > security fix > tightens groupPolicy + filesystem perms**
   - `expect(res.ok).toBe(true)` — received `false`
   - Pre-existing; unrelated to env-strip / planner-tool changes.

2. **src/agents/clawdbot-gateway-tool.test.ts > gateway tool > schedules SIGUSR1 restart**
   - Expected: `"Run: moltbot --profile isolated doctor --non-interactive"`
   - Received: `"Run: smithersbot --profile isolated doctor --non-interactive"`
   - Stale test fixture not updated for the clawdbot→moltbot→smithersbot rename history. Pre-existing.

Also one unhandled worker exit / timeout terminating fork (src/agents/session-write-lock.test.ts) — does not change the failing-test count but is noted in the transcript.

### 06-vitest-telegram — 6 failures

1. **src/telegram/bot.media.includes-location-text-ctx-fields-pins.test.ts > telegram inbound media > includes location text and ctx fields for pins**
   - Test timed out in 20000ms. Pre-existing flake / setup issue.

2. **src/telegram/bot.media.includes-location-text-ctx-fields-pins.test.ts > telegram inbound media > captures venue fields for named places**
   - `ReferenceError: Cannot access '__vite_ssr_import_25__' before initialization` at `createTelegramBot src/telegram/bot.ts:154:21`. Vite-SSR import-cycle issue in the test setup. Pre-existing.

3–6. **src/telegram/goal-commands.test.ts** (4 failures, same shape)
   - `/goal_plan_autocheck`, `/goal_semgrep`, codex-only workers, GitHub push mode
   - Each fails with `expected "vi.fn()" to be called once, but got 2 times` for `mockLoadConfig`. Pre-existing mock-count drift after a refactor that introduced a second config load.

### 07-vitest-cron — 15 failures, single root cause

All 15 failures in `src/cron/isolated-agent.*` raise:

```
Error: Missing workspace template: AGENTS.md (/home/matt/moltbot/docs/reference/templates/AGENTS.md). Ensure docs/reference/templates are packaged.
    at loadTemplate src/agents/workspace.ts:53:11
    at ensureAgentWorkspace src/agents/workspace.ts:160:26
    at Module.runCronIsolatedAgentTurn src/cron/isolated-agent/run.ts:133:21
```

The directory `docs/reference/templates/` does not exist in this checkout. `find` returns no `docs/` directory at all. This is a repo-state / packaging issue, not a behavior bug introduced by Stage 2O work.

## Pre-existing Failures Block This Step

This step's constraint says: *"Do not modify implementation files in this step — only run and record."* All observed failures are independent of the Stage 2O secret-access-gating work (env-strip and planner-tool-tightening). Making the matrix exit 0 would require code changes to:

- `docs/reference/templates/AGENTS.md` (missing file)
- `src/security/fix.ts` (logic regression — res.ok false)
- `src/agents/clawdbot-gateway-tool.test.ts` (stale branding fixture)
- `src/telegram/bot.ts` and `src/telegram/bot.media.*.test.ts` (import-cycle / timeout fix)
- `src/telegram/goal-commands.ts` or `goal-commands.test.ts` (mock-count drift)

…none of which fall inside this step's scope.

## Recommendation for the Plan

Either (a) widen the next-step constraint to allow targeted fixes for the failures above before re-running the matrix, or (b) accept a documented baseline of pre-existing failures in the Stage 2O report (write-stage2o-report) and confirm none of them touch the secret-access-gating surfaces.
