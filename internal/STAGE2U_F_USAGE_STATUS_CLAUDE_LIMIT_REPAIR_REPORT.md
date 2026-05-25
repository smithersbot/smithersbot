# Stage 2U-F Usage Status Claude Limit Repair Report

## Live Symptom

When Claude Code was out of usage, `/usage_status` rendered Claude as unavailable:

- `Claude Code: unavailable`
- `Note: Live quota cache is present but unreadable (refresh timed out).`

Codex continued to render its current quota, rate-limit, plan, and credit details correctly.

## Root Cause

`/usage_status` refreshed the Claude statusline cache by launching Claude Code through `script -q -e -c 'claude "respond with only a period"' /dev/null`, then polling for a newer complete statusline cache. The refresh subprocess used ignored stdio, so useful Claude Code usage-limit or rate-limit text emitted by the CLI was discarded. If no newer complete cache appeared before the refresh deadline, the command only knew that polling timed out and rendered an unknown/unavailable state.

## Call Chain

The product surface is self-contained in `src/telegram/usage-status.ts`:

1. `src/telegram/bot-native-commands.ts` registers `/usage_status`.
2. `registerUsageStatusCommand()` binds the command handler.
3. `buildUsageStatusMessage()` reads Claude/Codex quota state.
4. `resolveClaudeStatuslineCachePath()` locates the Claude statusline cache.
5. `defaultReadCache()` reads the cache.
6. `refreshClaudeStatuslineCache()` attempts to trigger a fresh Claude statusline update.
7. The cache is reread and parsed.
8. `buildClaudeSection()` and `buildCodexSection()` render the Telegram message.

## Discarded Signal

The old refresh path only treated the subprocess as a trigger for cache freshness. Because stdout/stderr were ignored and the process result was not classified, Claude's explicit usage-limit/rate-limit output was lost. That made classifiable provider limit states indistinguishable from unknown refresh timeouts.

## Shared Classifier

Added `src/goal/usage-limit-classifier.ts` with `classifyUsageLimitEvent({ backend, text })`. It reuses the existing goal-side usage-limit detection path:

- `detectUsageLimitKind()` for `rate_limit` versus `usage_limit`.
- `classifyUsageLimit()` and `extractUsageLimitResetHint()` through the existing classifier path for backend-specific metadata and reset hints.
- Existing auth and binary-missing patterns are filtered out so unrelated operational failures do not become usage-limit events.

The returned event is compatible with `UsageLimitEvent` from `src/goal/usage-limit-message.ts`.

## Message Reuse

`buildClaudeSection()` now calls `describeUsageLimitEvent()` for rate-limited Claude refresh results. This keeps `/usage_status` aligned with the friendly usage-limit wording used by goal interruption rendering, instead of introducing a separate Telegram-only phrasing path.

## Refresh Result States

`refreshClaudeStatuslineCache()` now captures bounded stdout/stderr, exit code, signal, spawn errors, and timeout status while preserving the existing bounded polling behavior and cleanup. It returns structured Claude refresh states:

- `refreshed`: a newer complete statusline cache appeared.
- `rate_limited_with_reset`: captured output classified as Claude usage-limited or rate-limited, carrying the shared `UsageLimitEvent`.
- `timeout`: refresh timed out without a classifiable limit signal.
- `failed`: subprocess exited without a classifiable limit signal.
- `unavailable`: refresh could not be launched or otherwise remained unknown.
- `auth_missing`: captured output indicated missing authentication.
- `binary_missing`: captured output indicated the Claude command was missing.

Raw Claude output is not stored in the result and is not rendered to Telegram.

## Last Valid Cache Rules

`buildUsageStatusMessage()` reads and parses the last valid Claude statusline cache before refresh. A valid parsed cache is retained across failed refreshes, timeouts, invalid JSON, or incomplete statusline payloads.

Rendering rules now distinguish these cases:

- Current complete cache renders `Claude Code: current`.
- Usage/rate-limit refresh with a valid cache renders `Claude Code: rate limited`, the friendly limit message, reset summary when available, and stale last-known 5-hour/7-day quota.
- Usage/rate-limit refresh without a valid cache still renders the rate-limited message and says last-known quota is unavailable.
- Unknown refresh timeout with a valid cache renders stale last-known quota with a refresh-failed/timed-out note.
- Unknown refresh timeout with no valid cache renders unavailable/unknown.
- Invalid or incomplete cache entries are not presented as quota.

Codex rendering remains unchanged.

## Statusline Cache Hardening

`scripts/claude-statusline.mjs` now validates stdin before replacing the cache. It only writes `~/.cache/claude-code/statusline.json` when the input parses as JSON and contains complete `rate_limits.five_hour` and `rate_limits.seven_day` windows, each with usable usage percentage and reset time fields. Empty input, invalid JSON, and incomplete statusline payloads leave any existing good cache intact. The helper still exits 0 and echoes the compact status line only for complete input.

## Tests Added

Focused coverage now includes:

- `src/goal/usage-limit-classifier.test.ts`: Claude usage limits with reset text, bare 429/rate-limit text, reset-at/reset-in/reset-on phrasing, unrelated timeout, binary-missing, and auth-missing cases.
- `src/scripts/claude-statusline.test.ts`: complete input writes/replaces the cache; incomplete, invalid, and empty input do not overwrite a pre-existing good cache.
- `src/telegram/usage-status.test.ts`: valid cache plus usage-limit signal, timeout with classifiable output, stale cache plus unknown timeout, no cache plus limit signal, no cache plus unknown timeout, invalid cache plus limit signal, preservation of valid cache across invalid refresh output, and unchanged Codex quota/rate-limit/plan/credits rendering.

## Verification Results

All required commands exited 0:

- `pnpm vitest run src/goal/usage-limit-classifier.test.ts`
- `pnpm vitest run src/scripts/claude-statusline.test.ts`
- `pnpm vitest run src/telegram/usage-status.test.ts`
- `pnpm exec tsc -p tsconfig.json`
- `pnpm build`
- `pnpm lint`

## Manual Verification Steps

1. Restart the gateway from an operator shell.
2. Run `/usage_status` while Claude Code is usage-limited or rate-limited.
3. Confirm the Claude section says `rate limited` and shows the friendly reset message.
4. Confirm last-known Claude quota appears when a valid cache exists.
5. Confirm the Codex section still renders normally with quota, rate-limit, plan, and credits.
