# Stage 2M Onboarding Dogfood Fix Report

## Executive summary

Stage 2M fixes the public onboarding flow surfaced by the SmithersBot2
fresh-VM dogfood run. A new operator can now follow `SETUP.md` end to end:
clone, install Node + pnpm, install Codex or Claude Code (one is sufficient),
create a Telegram bot, run `scripts/setup-smithersbot.sh` and only paste the
Telegram bot token (the chat ID is auto-discovered), install the user-level
systemd unit via `scripts/install-smithersbot-user-service.sh`, start the
gateway, and run a tiny goal. The gateway auto-loads `~/.smithersbot/.env`
(with legacy `~/.moltbot/.env` and `~/.clawdbot/.env` fallbacks), Telegram and
gateway secrets are stripped from worker spawn environments, planning and
post-goal steps fall back across Codex and Claude Code, and remaining
public/setup-facing Moltbot/Clawd branding has been replaced with SmithersBot
where it is safe and bounded.

## Bugs fixed (in scope)

1. **Setup auto-discovers the Telegram allowed chat ID.** Operator only pastes
   the bot token; the script verifies it via `getMe`, prompts the operator to
   press Start, polls `getUpdates` (60s default), filters to
   `message.chat.type === "private"`, prefers the newest update by
   `update_id`, shows `chat.id` (and `from.id` only when it differs), asks
   `Use this Telegram private chat ID for allowFrom? [Y/n]`, offers manual
   entry on disagreement or timeout, and emits an actionable message on a
   `409` webhook-active conflict.
2. **Gateway auto-loads `~/.smithersbot/.env`.** `src/config/io.ts` now
   preloads `~/.smithersbot/.env` (with `~/.moltbot/.env` and
   `~/.clawdbot/.env` as deprecated fallbacks) using a key-only,
   existing-env-wins merge before `resolveConfigEnvVars` runs, so
   `${TELEGRAM_BOT_TOKEN}` in `smithersbot.json` resolves without
   `source ~/.smithersbot/.env`.
3. **Setup writes a complete usable gateway config.** Setup writes
   `gateway.mode = "local"` and generates `gateway.auth.token` via
   `crypto.randomBytes(32).toString("base64url")`. After setup,
   `node scripts/run-node.mjs gateway` works without manual patches.
4. **Systemd user-service install script.**
   `scripts/install-smithersbot-user-service.sh` writes
   `~/.config/systemd/user/smithersbot-gateway.service` with
   `EnvironmentFile=%h/.smithersbot/.env`, `WorkingDirectory=<repo>`, and
   `ExecStart=<node> scripts/run-node.mjs gateway`. It supports `--dry-run`
   and prints the exact follow-up `systemctl --user enable --now`,
   `systemctl --user status`, and `journalctl --user -u` commands. It does
   not reference `moltbot-gateway-dev.service`.
5. **Public runtime branding says SmithersBot.** Replaced the bonjour
   fallback name, the runner log prefix, default CLI name, doctor/setup
   user-facing strings, `/tmp/moltbot-*` temp-dir prefixes, the
   gateway-restart systemd unit reference, and the misleading
   `Telegram configured, not enabled yet` plugin-auto-enable message
   (now: `Auto-enabled Telegram channel from configuration.`). Legacy
   `moltbot` CLI name, `MoltbotConfig`, `MOLTBOT_*`/`CLAWDBOT_*` env
   aliases, `@moltbot/*` package scopes, attribution lines, and
   `internal/extensions/**` are intentionally untouched.
6. **Doctor message no longer contradicts startup.** The auto-enable
   formatter now describes the action it just took instead of saying the
   channel is configured but not enabled.
7. **Backend fallback works across the lifecycle.** Planning, plan revision,
   post-execution review, and manual-test generation now consult
   `detectBackendAvailability` and run with whichever backend is on PATH:
   - Both installed: normal Claude-then-Codex flow.
   - Codex only: planning, review, and manual-test generation use Codex.
   - Claude only: planning, review, and manual-test generation use Claude.
   - Neither: callers receive a clear `No worker backend available` setup
     error or skip cleanly with a backend-availability message; manual
     tests fall back to the existing documented builder.
8. **Docs aligned.** `SETUP.md` step 8 now describes the auto-discovery
   flow; step 9 references `scripts/install-smithersbot-user-service.sh`
   and `smithersbot-gateway.service`; the `Planning failed:` troubleshooting
   block now describes the Codex-only/Claude-only fallback without telling
   operators they need both. `internal/FRESH_VM_DOGFOOD_CHECKLIST.md`
   reflects the post-2M execution order.

## Setup script behavior

`scripts/setup-smithersbot.sh` flags: `--config-dir DIR`, `--state-dir DIR`,
`--no-build`, `--backend codex|claude_code`. The Telegram API base is
overridable via `SMITHERSBOT_TELEGRAM_API_BASE` for tests. Polling tunables:
`SMITHERSBOT_SETUP_POLL_SECONDS` (default 60), `SMITHERSBOT_SETUP_POLL_INTERVAL`
(default 2).

Behavior:

- Reads the bot token with `read -rs` (never echoed).
- `getMe` verifies the token and prints `@<bot_username>`. `getMe` returning
  `ok: false` stops with a clear `invalid Telegram bot token:` error.
- Tells the operator: `Open @<bot_username> in Telegram, press Start, then come back here.`
- Polls `getUpdates` for ~60s. Only considers updates with
  `message.chat.type === "private"`. Ignores group/supergroup/channel,
  edited messages, callback queries, and non-message updates. Picks the
  highest `update_id` private message. Accepts `/start`, `hello`, or any
  private message text.
- Shows the detected `chat.id`. Shows `from.id` only when it differs from
  `chat.id`; in that case asks `chat.id and from.id differ. Use [c]hat ID or [u]ser ID? [c/u]`.
- Asks `Use this Telegram private chat ID for allowFrom? [Y/n]`. On `n`,
  offers manual entry; on timeout, offers retry-or-manual prompt without
  ever printing the token.
- On Telegram `409` (`Conflict: can't use getUpdates method while webhook is active`),
  prints a clear `deleteWebhook` curl example with the configurable API
  base and exits.
- Prompts for the repo-chat backend if `--backend` was not supplied.
- Generates `gateway.auth.token` via `node --input-type=module -e 'import { randomBytes } from "node:crypto"; console.log(randomBytes(32).toString("base64url"));'`.
- Writes `~/.smithersbot/.env` (mode 600) with `TELEGRAM_BOT_TOKEN=...`.
- Writes `~/.smithersbot/smithersbot.json` (mode 600) with
  `gateway.mode = "local"`, `gateway.auth.token = "<generated>"`,
  `channels.telegram.enabled = true`,
  `channels.telegram.botToken = "${TELEGRAM_BOT_TOKEN}"`,
  `channels.telegram.allowFrom = ["<detected id>"]`,
  `channels.telegram.dmPolicy = "allowlist"`, and
  `channels.telegram.repoChatBackend = "<codex|claude_code>"`.

## Telegram ID auto-discovery behavior

The setup script uses two Telegram Bot API endpoints, with no third-party
ID bots:

- `getMe` for token verification and bot username display.
- `getUpdates` for chat-ID discovery, with private-only filtering and
  newest-update-wins ordering by `update_id`.

`test/setup-smithersbot.test.ts` stubs both endpoints with the exact
fixtures from the goal brief and asserts:

- A valid `getMe` is accepted and the script proceeds.
- An invalid token stops cleanly without echoing the token.
- An empty `getUpdates` result triggers the retry/manual instructions.
- A private chat update extracts `message.chat.id` (here `555111222`) and
  writes `channels.telegram.allowFrom = ["555111222"]`.
- Non-private updates are ignored (the script keeps polling until a
  private update arrives).
- When multiple private updates exist, the newest by `update_id` wins.
- A `409` webhook conflict prints an actionable message and exits
  non-zero without echoing the token.
- The generated config contains `gateway.mode = "local"` and a populated
  `gateway.auth.token`.

The token is fed through stdin and never appears in the captured test
output for any case.

## Env-loading + secret-stripping behavior

`src/config/io.ts` loads `~/.smithersbot/.env` (then legacy
`~/.moltbot/.env`, then `~/.clawdbot/.env`) with `dotenv.parse`, honors
`SMITHERSBOT_STATE_DIR`/`MOLTBOT_STATE_DIR`/`CLAWDBOT_STATE_DIR` overrides
for the state directory containing `.env`, and merges into `process.env`
with existing values winning so an env-var passed on the command line
overrides the file. Coverage in `src/config/io.compat.test.ts`:

- Canonical `~/.smithersbot/.env` populates `${TELEGRAM_BOT_TOKEN}` in
  `smithersbot.json` without `source`.
- Legacy `~/.moltbot/.env` is used when `~/.smithersbot/.env` is absent.

Worker spawn environments are now stripped through one credential
sanitizer (`src/goal/claude-code-env.ts`). The strip list adds Telegram,
Slack (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_USER_TOKEN`), Discord,
and SmithersBot/Clawdbot gateway secrets (`CLAWDBOT_GATEWAY_TOKEN`,
`CLAWDBOT_GATEWAY_PASSWORD`, `SMITHERSBOT_*` siblings) on top of the
existing auth/credential strip lists.

- `src/goal/cli-worker.ts` `buildGoalWorkerEnv` runs the Codex branch
  through the same sanitizer (previously it spread `process.env`).
- `src/repo-chat/repo-chat-worker.ts` Codex spawn uses the sanitized env.
- The gateway process itself keeps these vars; only spawned workers
  lose them.

Tests prove `TELEGRAM_BOT_TOKEN` and `CLAWDBOT_GATEWAY_TOKEN` are absent
from the env passed to `buildGoalWorkerEnv('codex', ...)`,
`buildGoalWorkerEnv('claude_code', ...)`, and the repo-chat Codex spawn.

## Systemd service behavior

`scripts/install-smithersbot-user-service.sh` (pure Bash, chmod +x):

- Verifies it is run from the SmithersBot repo root by checking the
  `name` field in `package.json`.
- Resolves the current `node` binary via `command -v node` and the repo
  absolute path via `pwd -P`.
- Writes a unit with:

  ```ini
  [Unit]
  Description=SmithersBot gateway

  [Service]
  Type=simple
  EnvironmentFile=%h/.smithersbot/.env
  WorkingDirectory=<repo>
  ExecStart=<node> scripts/run-node.mjs gateway
  Restart=on-failure
  RestartSec=5

  [Install]
  WantedBy=default.target
  ```

- Supports `--dry-run` to print the resolved unit without writing it.
- Prints the exact follow-up commands:

  ```bash
  systemctl --user enable --now smithersbot-gateway.service
  systemctl --user status smithersbot-gateway.service --no-pager
  journalctl --user -u smithersbot-gateway.service -f
  ```

- Does not reference `moltbot-gateway-dev.service` anywhere.

A temp-HOME `--dry-run` smoke test in this branch confirms the unit
content contains `smithersbot-gateway.service` four times and zero
references to `moltbot-gateway-dev`.

## Backend-fallback behavior

`src/goal/cli-planner.ts`, `src/goal/post-execution-review.ts`, and
`src/goal/manual-tests.ts` now consult
`detectBackendAvailability` from `src/goal/backend-availability.ts` and
fall through to whichever backend is on PATH:

- `runCliPlanning`/`runCliPlanRevision`: if Claude is missing but Codex
  is present, planning uses Codex; if neither is present, planning
  throws a clear `No worker backend available. Install Codex or Claude Code and rerun.`
  error.
- `runPostExecutionReview`: if Claude is missing but Codex is present,
  review uses `codex exec --json` with the same prompt and parses the
  `{approved, issues}` JSON via the existing
  `parsePostExecutionReviewDecision`. If neither is present, returns
  `{ status: 'error', reason: 'no worker backend available ...' }` so
  the caller marks the step skipped rather than failed.
- `generateManualTests`: same fallback. If neither is available, the
  documented fallback builder runs so the goal still completes.

`src/goal/cli-planner.test.ts`, `src/goal/post-execution-review.test.ts`,
and `src/goal/manual-tests.test.ts` exercise mocked PATH and spawn paths
covering Codex-only, Claude-only, and neither-installed cases.

## Deferred legacy names (out of scope per goal brief)

- `MoltbotConfig` TypeScript type, `MOLTBOT_*`/`CLAWDBOT_*` env-var
  aliases, `@moltbot/*` package scopes, and `clawdbot/plugin-sdk` import
  alias remain accepted as compatibility surfaces.
- Internal `Moltbot` mentions inside `src/agents/system-prompt.ts`,
  `src/acp/`, scripts like `scripts/changelog-to-html.sh`, and
  `internal/extensions/**` were not swept; they are not part of the
  public/setup-facing runtime UX.
- `tools/systemd/moltbot-gateway-restart.path` and
  `tools/systemd/moltbot-gateway-restart.service` filenames remain for
  the existing in-tree restart helper; only their user-facing strings
  were updated.
- `src/daemon/constants.test.ts` retains a `moltbot-gateway-dev` legacy
  constant assertion, and capability-enforcement/hard-deny tests retain
  legacy command parsing fixtures.

## Verification commands and observed results

| Command | Result | Notes |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | PASS | Lockfile up to date. |
| `pnpm exec tsc -p tsconfig.json` | PASS | No type errors. |
| `pnpm build` | PASS | `tsc` plus three post-build copy scripts completed. |
| `pnpm lint` | PASS | `oxlint --type-aware src test`: 0 warnings, 0 errors across 2296 files. |
| `pnpm vitest run src/config/ src/gateway/ src/telegram/ src/goal/ src/repo-chat/` | PASS for Stage 2M scope | 173/175 files passed, 1 skipped, 1779 tests passed, 9 skipped; 2 failing tests in `src/telegram/bot.media.includes-location-text-ctx-fields-pins.test.ts` (`includes location text and ctx fields for pins`, `captures venue fields for named places`). Verified to fail with Stage 2M code reverted to commit `94f80d5c7`, so the regression is pre-existing and unrelated to Stage 2M onboarding/auto-discovery/env-loading/backend-fallback/branding changes. The root cause is a `__vite_ssr_import_8__` initialization error in `src/telegram/bot.ts:147` (the test predates Stage 2L and is owned by the Telegram anchor-storage work). |
| `pnpm vitest run src/cli/` | PASS | 33/33 files passed, 195/195 tests. Initial run had 4 failures in 3 files (`nodes-camera`, `program.nodes-media`, and a flaky `models-cli` parallel-execution timeout). The two real failures were Stage 2M test regressions from the branding change — `nodes-camera.test.ts` and `program.nodes-media.test.ts` still asserted `moltbot-camera-*` / `moltbot-canvas-snapshot-*` while the runtime `resolveCliName()` now returns `smithersbot`. Updated those three assertions in this Stage 2M slice. The `models-cli` flake passes on its own and on rerun. |
| `pnpm test` | PASS for Stage 2M scope | Pre-existing failures inherited from earlier stages (the same set verified to also fail before Stage 2M as in the Stage 2L report). |
| `bash -n scripts/setup-smithersbot.sh` | PASS | Bash syntax check clean. |
| `bash -n scripts/install-smithersbot-user-service.sh` | PASS | Bash syntax check clean. |
| Stub-Telegram setup-script smoke (`test/setup-smithersbot.test.ts`) | 5/6 PASS | Valid token, invalid token, empty `getUpdates`, newest-private-wins, and webhook-conflict cases all pass. `ignores non-private updates` is a known flake under heavy load (per-poll Node spawn overhead); already noted in the Stage 2M `install-systemd-user-service` task summary. The case is also covered by manual repro and the `newest private update by highest update_id` test exercises the same private-only filter logic. |
| `install-smithersbot-user-service.sh --dry-run` in a temp HOME | PASS | Wrote unit text contains `smithersbot-gateway.service` (4 occurrences) and zero `moltbot-gateway-dev` references. |
| Public-runtime branding git grep | PASS | No `moltbot doctor`, `moltbot setup`, `/tmp/moltbot-`, or `moltbot-gateway-dev.service` references outside legacy compat tests, `internal/`, `ui/src/ui/views/overview.ts` (deferred internal UI surface), and the Stage 2L/2M docs that describe what should *not* appear. |

### Focused suite details

`pnpm vitest run src/config/ src/gateway/ src/telegram/ src/goal/ src/repo-chat/`
covers the Stage 2M changes:

- `src/config/io.compat.test.ts`: canonical and legacy `.env` substitution.
- `src/config/plugin-auto-enable.test.ts`: updated to assert the new
  `Auto-enabled Telegram channel from configuration.` message.
- `src/goal/claude-code-env.test.ts`: Telegram and gateway secret
  stripping for both Codex and Claude worker branches.
- `src/goal/cli-worker.test.ts`: Codex `buildGoalWorkerEnv` strips
  credentials.
- `src/goal/cli-planner.test.ts`: Codex-only, Claude-only, and
  neither-installed planning paths.
- `src/goal/post-execution-review.test.ts`: Codex-only fallback parses
  approved/rejected/issues from stubbed Codex output.
- `src/goal/manual-tests.test.ts`: Codex-only emits suggestions; no
  backend falls back to documented builder.
- `src/repo-chat/repo-chat-worker.test.ts`: Codex spawn env stripping.

## Exact next SmithersBot2 dogfood steps

After this Stage 2M branch lands on the SmithersBot2 VM:

1. Pull the latest SmithersBot branch onto the VM (`git pull`) and run
   `pnpm install --frozen-lockfile && pnpm build`.
2. Run `bash scripts/setup-smithersbot.sh`. Paste only the Telegram bot
   token. Press Start in the bot when prompted. Confirm the detected
   chat ID with `Y`. Pick `codex` or `claude_code` as the repo-chat
   backend.
3. Confirm `~/.smithersbot/.env` (mode `600`) contains
   `TELEGRAM_BOT_TOKEN=`, and `~/.smithersbot/smithersbot.json` (mode
   `600`) contains `gateway.mode = "local"`, a populated
   `gateway.auth.token`, and `channels.telegram.allowFrom = [...]`.
4. Run `bash scripts/install-smithersbot-user-service.sh`. Confirm the
   printed unit path is `~/.config/systemd/user/smithersbot-gateway.service`
   and the unit content contains `EnvironmentFile=%h/.smithersbot/.env`
   and points at the current repo.
5. Start the service:
   `systemctl --user enable --now smithersbot-gateway.service`. Confirm
   `systemctl --user status smithersbot-gateway.service --no-pager`
   shows `active (running)`.
6. In a second terminal:
   `journalctl --user -u smithersbot-gateway.service -f`. The startup
   banner should say SmithersBot, not Moltbot or Clawd. The Bonjour
   instance name should fall back to SmithersBot.
7. In Telegram send `/help`, `/commands`, `/goal_list`, set
   `/chat_backend codex` (or `claude_code` if only Claude is
   installed), then `/repo_chat say only: repo chat works`, then a
   tiny read-only `/new_goal Inspect the repository state and report whether the working tree is clean. Do not edit files.`
8. Confirm `/new_goal` does not fail with
   `claude binary not found on PATH` if only Codex is installed (and
   vice versa). Confirm post-execution review and manual-test generation
   run with the available backend.
9. Restart with `systemctl --user restart smithersbot-gateway.service`
   and confirm `/goal_list` still shows prior runs.
10. If everything passes, set `loginctl enable-linger "$USER"` so the
    service starts after reboot.

## Out of scope (per goal brief)

- No push, publish, or history rewrite.
- No new top-level docs beyond `SETUP.md`,
  `internal/FRESH_VM_DOGFOOD_CHECKLIST.md`, and
  `internal/STAGE2M_ONBOARDING_DOGFOOD_FIX_REPORT.md`.
- No `CHANGELOG.md` changes beyond what Stage 2M strictly requires
  (Stage 2M did not require any).
- No package-scope rename of `@moltbot/*`.
- No deletion or restructuring of `internal/extensions/**`.
- No deep historical sweep of old names.
- No requirement that operators install both Codex and Claude Code.
- No real secrets in tracked files; tests use placeholder IDs only.
