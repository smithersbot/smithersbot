# Stage 2P CI, Backend Fallback, and Repo Chat Report

## Summary

Stage 2P restored the focused Stage 2O CI failure in `src/telegram/goal-commands.test.ts` and added bounded resilience fixes for worker backend fallback, Anthropic transient overload handling, and repo-chat response delivery under Stage 2O containment.

The focused Stage 2P test slices, typecheck, build, lint, and `pnpm test` pass. Two broad verification commands still fail from pre-existing baseline/sandbox issues listed below.

GitHub CI should now pass for the original Stage 2O blocking failure in `src/telegram/goal-commands.test.ts`.

## Root Causes

### CI Failure

The four failing `/goal_*` tests still expected `loadConfig` to be called once after config persistence. Stage 2O introduced outbound secret redaction in the Telegram reply path:

`sendGoalReply` -> `redactSecretValues` -> `loadConfigSecretValues` -> `loadConfig`

That second `loadConfig` call is expected because replies are redacted before being sent. The tests were stale, not the command handlers.

### Codex/Claude Fallback Gap

The executor retried a rate-limited backend until `maxAttempts` was exhausted. It did not select an alternate enabled backend between attempts, so a Codex usage/rate limit could block the task even when Claude Code was enabled and available.

### Anthropic 529 Misclassification

The planner treated provider `529 Overloaded`, 5xx, `server-side issue`, and service-unavailable text as Anthropic rate-limit/account-limit failures. Those are transient provider overloads, not user quota exhaustion, so the user-facing message and retry behavior were wrong.

### Repo-Chat Response-File Failure

Stage 2O containment made repo-chat read-only with respect to the repository and removed broad write/Bash assumptions. The legacy response protocol still depended on model-written response files or repair prompts using shell/file-write style delivery. Under containment, a worker could finish without writing the response file, and the repair pass could fail the same way.

Direct inspection of `~/.smithersbot`, `~/.moltbot`, and `~/.clawdbot-dev` artifacts was intentionally not performed because the worker hard-deny rules classify those trees as local secret/config paths. The failure was reproduced and fixed through repo-local tests matching the observed launch-kit prompt shape.

## Files Changed

- `src/telegram/goal-commands.test.ts`
- `src/goal/agent-executor-helpers.ts`
- `src/goal/agent-executor.ts`
- `src/goal/agent-executor.test.ts`
- `src/goal/cli-planner.ts`
- `src/goal/cli-planner.test.ts`
- `src/goal/error-patterns.ts`
- `src/goal/format-output.ts`
- `src/goal/types.ts`
- `src/goal/worker-context/CLAUDE.md`
- `src/repo-chat/repo-chat-worker.ts`
- `src/repo-chat/repo-chat-worker.test.ts`
- `src/telegram/goal-sending.ts`
- `internal/stage2p-verification/*`
- `internal/STAGE2P_CI_BACKEND_AND_REPOCHAT_REPORT.md`

## Fix Correctness

The `/goal_*` tests now assert the expected Stage 2O redaction side effect instead of treating the second `loadConfig` call as a regression. They still prove config persistence, in-memory config mutation, Telegram response text/target, default behavior, and redaction invocation.

`pickFallbackBackend` centralizes fallback eligibility. It only selects the alternate backend for `rate_limit` or `usage_limit`, only when no explicit backend override is set, only when more than one effective worker is enabled, and only when the alternate backend is available on `PATH`. This preserves user constraints and avoids falling back to disabled or unavailable backends.

The executor now uses the helper inside the existing attempt budget. It records the actual executed backend after fallback so task artifacts, captions, and summaries reflect the worker that really ran. When fallback is unavailable, the blocked message explains whether the reason was disabled workers, explicit single-backend constraint, unavailable `PATH`, prior fallback use, or exhausted attempts.

The planner now classifies Anthropic transient overload separately from usage/rate limits. True usage-limit text still takes precedence, 429/rate-limit text still classifies as rate limit, and transient overload receives bounded same-backend retries before fallback or failure. User-facing messages now say Claude Code is temporarily overloaded instead of saying the user hit a rate limit.

Repo-chat delivery now prefers CLI-native assistant output, then legacy response files, then a sandbox-compatible repair prompt that asks for a final assistant message instead of shell/file writes, then refusal text. Extracted responses are redacted before delivery. The repo remains read-only for chat workers and secret-path gating is not weakened.

## Verification Results

- `pnpm vitest run src/telegram/goal-commands.test.ts`: passed; 1 test file passed, 196 tests passed.
- `pnpm vitest run src/goal/agent-executor.test.ts src/goal/agent-executor-helpers.test.ts src/goal/cli-planner.test.ts src/goal/cli-worker.test.ts`: passed; 3 test files passed, 137 tests passed.
- `pnpm vitest run src/repo-chat/repo-chat-worker.test.ts src/repo-chat/repo-chat-store.test.ts src/telegram/repo-chat-commands.test.ts`: passed; 3 test files passed, 74 tests passed.
- `pnpm vitest run src/security/ src/goal/ src/repo-chat/ src/config/ src/agents/`: failed; 4 test files failed, 281 passed, 1 skipped; 14 tests failed, 2142 passed, 9 skipped; 1 unhandled worker error.
- `pnpm vitest run src/telegram/`: failed; 2 test files failed, 52 passed; 3 tests failed, 611 passed; 2 unhandled errors.
- `pnpm exec tsc -p tsconfig.json`: passed.
- `pnpm build`: passed.
- `pnpm lint`: passed; 0 warnings, 0 errors across 2302 files.
- `pnpm test`: passed; 1 test file passed, 15 tests passed.
- `git diff --stat`: captured during verification; no output at capture time because prior task commits had already landed in the goal branch.
- `git diff -- <targeted Stage 2P files>`: captured during verification; no output at capture time for the same reason.

Raw verification logs are in `internal/stage2p-verification/`.

## Remaining Baseline Failures

The broad core Vitest run still fails in:

- `src/agents/clawdbot-gateway-tool.test.ts`
- `src/goal/cli-process.test.ts`
- `src/security/audit.test.ts`
- `src/security/fix.test.ts`

These were not fixed because they are outside the Stage 2P scope and were not required for the original GitHub CI blocker.

The full Telegram suite still fails in:

- `src/telegram/bot.media.includes-location-text-ctx-fields-pins.test.ts`
- `src/telegram/webhook.test.ts`

The recorded failure includes timeouts and `listen EPERM` on `0.0.0.0`, which is consistent with sandbox/network restrictions rather than the Stage 2P goal-command fix.

## CI Assessment

GitHub CI should now pass the original blocking `src/telegram/goal-commands.test.ts` failures. The focused Stage 2P slices, typecheck, build, lint, and package test command passed.

If GitHub CI includes the broad core or full Telegram suites exactly as run here, those pre-existing failures may still need separate scoped follow-up work. They were intentionally not addressed in Stage 2P.

## Out of Scope and Stop Conditions

No broad cleanup, public launch work, orphan branch work, package-scope rename, or unrelated old-name sweep was performed.

Stage 2O secret-path and containment protections were preserved. Repo-chat response delivery was fixed without re-enabling broad Write access or unrestricted Bash.

No push, publish, release, deployment, branch creation, history rewrite, gateway restart, or commit was performed by this reporting task.
