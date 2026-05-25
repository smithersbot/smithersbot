# CI Temp Directory And CLI Test Fix Report

## Scope

This note documents the CI test-environment fixes for read-only temporary directories and missing local backend CLIs. The implementation kept production behavior unchanged and limited fixes to test setup, fixtures, and test-only temp paths.

## Failure Classes

### Read-only `/tmp` test paths

Root cause: several tests used literal `/tmp` paths for files they create. CI may redirect `TMPDIR`, `TMP`, and `TEMP` to a writable repo-local Vitest temp root while mounting `/tmp` and `/var/tmp` read-only, so tests that bypassed `os.tmpdir()` failed with filesystem write errors.

Affected files:

- `src/telegram/sticker-cache.test.ts`
- `src/browser/profiles-service.test.ts`
- `src/logger.test.ts`
- `src/telegram/bot.create-telegram-bot.accepts-group-messages-mentionpatterns-match-without-botusername.test.ts`
- `src/telegram/bot.create-telegram-bot.applies-topic-skill-filters-system-prompts.test.ts`
- `src/telegram/bot.create-telegram-bot.blocks-all-group-messages-grouppolicy-is.test.ts`
- `src/telegram/bot.create-telegram-bot.dedupes-duplicate-callback-query-updates-by-update.test.ts`
- `src/telegram/bot.create-telegram-bot.installs-grammy-throttler.test.ts`
- `src/telegram/bot.create-telegram-bot.matches-tg-prefixed-allowfrom-entries-case-insensitively.test.ts`
- `src/telegram/bot.create-telegram-bot.matches-usernames-case-insensitively-grouppolicy-is.test.ts`
- `src/telegram/bot.create-telegram-bot.routes-dms-by-telegram-accountid-binding.test.ts`
- `src/telegram/bot.create-telegram-bot.sends-replies-without-native-reply-threading.test.ts`

Fix type: test-only cleanup. Test write targets now live under `os.tmpdir()` or the existing test override path, so they honor Vitest's writable temp-root redirection.

Tests updated:

- Sticker cache test state/cache directories use a unique `os.tmpdir()` based directory.
- Browser profile service test temp profile paths use `os.tmpdir()`.
- Logger rolling-file test redirects the log directory through the logger's test-facing override while preserving the assertions for daily file names and pruning.
- Telegram bot handler session-store paths use `os.tmpdir()`, which also keeps their `.lock` files writable.

### Claude sandbox settings on read-only `/var/tmp`

Root cause: planner and worker tests configured a writable Codex sandbox root but did not configure the Claude sandbox settings root. Test execution then reached the production Claude default under `/var/tmp`, which may be read-only in CI.

Affected files:

- `src/goal/cli-planner.test.ts`
- `src/goal/cli-worker.test.ts`

Fix type: test-only setup. The tests now set `SMITHERSBOT_CLAUDE_SANDBOX_SETTINGS_ROOT` to a unique `os.tmpdir()` based directory during each test and restore the prior environment afterward.

Tests updated:

- Planner sandbox setup exercises Claude settings generation using a writable test root.
- Worker sandbox setup exercises Claude settings generation using a writable test root.

### Codex CLI not available on `PATH`

Root cause: planner and worker unit tests covered command construction and artifact handling but called Codex native sandbox config helpers that perform real CLI/native-binary discovery. CI does not guarantee a local `codex` binary, so those unit tests failed before reaching the behavior they were intended to assert.

Affected files:

- `src/goal/cli-planner.test.ts`
- `src/goal/cli-worker.test.ts`

Fix type: test-only partial mock. The tests preserve real `backend-sandbox` exports and override only `buildCodexNativeSandboxConfig` and `writeCodexNativeSandboxConfig` with deterministic fixtures that do not probe `PATH`. Live Codex/Claude probes remain gated by explicit live-probe environment flags.

Tests updated:

- Planner tests still assert command construction, scout artifact writes, and sandbox argument wiring without requiring a real Codex install.
- Worker tests still assert launch argument construction and result handling without requiring a real Codex install.

### `plan_draft.md` fixture symptom

Root cause: CI reported a planner validation failure for missing `plan_draft.md`. Inspection showed the planner scout fixture writes `plan_draft.md` before validation. The missing-artifact symptom was downstream of the earlier Codex sandbox helper throw: the mocked scout path never reached its normal artifact-writing branch.

Affected files:

- `src/goal/cli-planner.test.ts`

Fix type: no source helper change and no validation weakening. The existing fixture remained valid; resolving the Codex CLI discovery problem lets the fixture create the expected artifact before planner validation.

Tests updated:

- Existing planner scout artifact tests continue to validate that `plan_draft.md` is present where required.

## Production Defaults Left Unchanged

- `DEFAULT_LOG_DIR` remains the production logger default. Tests that need writable log output now redirect through test setup instead of changing the runtime default.
- `DEFAULT_CODEX_SANDBOX_ROOT` remains the intentional production sandbox root under `/var/tmp`. Unit tests use test setup and mocks instead of moving production sandbox material into a repo-controlled directory.
- `DEFAULT_CLAUDE_SANDBOX_SETTINGS_ROOT` remains tied to the production sandbox root. Planner and worker tests set the supported settings-root override for test execution only.

These defaults stay unchanged because they are part of runtime sandbox and logging behavior. The CI failures were caused by test environments and fixtures assuming host temp-dir and CLI availability, not by incorrect production defaults.

## Verification Results

Verification was rerun after writing this report:

- `pnpm vitest run src/telegram/sticker-cache.test.ts src/browser/profiles-service.test.ts src/logger.test.ts`: passed, 3 files and 26 tests.
- `pnpm vitest run src/telegram/bot.create-telegram-bot.accepts-group-messages-mentionpatterns-match-without-botusername.test.ts src/telegram/bot.create-telegram-bot.applies-topic-skill-filters-system-prompts.test.ts src/telegram/bot.create-telegram-bot.blocks-all-group-messages-grouppolicy-is.test.ts src/telegram/bot.create-telegram-bot.dedupes-duplicate-callback-query-updates-by-update.test.ts src/telegram/bot.create-telegram-bot.installs-grammy-throttler.test.ts src/telegram/bot.create-telegram-bot.matches-tg-prefixed-allowfrom-entries-case-insensitively.test.ts src/telegram/bot.create-telegram-bot.matches-usernames-case-insensitively-grouppolicy-is.test.ts src/telegram/bot.create-telegram-bot.routes-dms-by-telegram-accountid-binding.test.ts src/telegram/bot.create-telegram-bot.sends-replies-without-native-reply-threading.test.ts`: passed, 9 files and 58 tests.
- `pnpm vitest run src/goal/cli-planner.test.ts src/goal/cli-worker.test.ts src/goal/backend-sandbox.test.ts`: passed, 3 files and 157 tests.
- `pnpm exec tsc -p tsconfig.json`: passed.
- `pnpm build`: passed.
- `pnpm lint`: passed with 0 warnings and 0 errors.
- `pnpm format`: passed.

## Remaining Environment-Specific Risks

- Tests still rely on the test runner to provide a writable `os.tmpdir()` target. This matches the repository's Vitest setup, which redirects temp environment variables to a writable repo-local temp root.
- Live backend CLI probes continue to depend on locally installed CLIs, but those paths are intentionally opt-in and are not required by the unit suites covered here.
- String literals containing `/tmp` or `/var/tmp` remain in tests where they are mock-only data, command text, or assertions about production diagnostics rather than real test write targets.
