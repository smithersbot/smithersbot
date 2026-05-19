# Stage 2L Fresh Setup Report

## Executive summary

Stage 2L promotes the SmithersBot naming convention to the canonical public
surface for fresh-VM setup and adds an idempotent setup script so a new user can
clone the repo, run a single script, answer a few prompts, and start the
gateway. The Moltbot and Clawdbot directory, filename, and environment variable
names continue to work as deprecated fallbacks so existing local installs are
not broken.

## Canonical names

The following names are now public/canonical:

- State directory: `~/.smithersbot`
- Environment file: `~/.smithersbot/.env`
- Config file: `~/.smithersbot/smithersbot.json`
- State directory override: `SMITHERSBOT_STATE_DIR`
- Config path override: `SMITHERSBOT_CONFIG_PATH`

Defaults resolve to canonical paths whenever no overrides exist and no legacy
directory is present.

## Legacy aliases still accepted

The following legacy aliases are still accepted as deprecated fallbacks (read
order from highest to lowest precedence):

- Environment variables:
  - State directory: `SMITHERSBOT_STATE_DIR` -> `MOLTBOT_STATE_DIR` ->
    `CLAWDBOT_STATE_DIR`.
  - Config path: `SMITHERSBOT_CONFIG_PATH` -> `MOLTBOT_CONFIG_PATH` ->
    `CLAWDBOT_CONFIG_PATH`.
- Directories: `~/.smithersbot` -> `~/.moltbot` -> `~/.clawdbot` (the first
  directory that already exists wins when no override is set).
- Filenames within a state directory: `smithersbot.json` ->
  `moltbot.json` -> `clawdbot.json`.
- `clawdbot/plugin-sdk` import alias and `@moltbot/*` package scopes are
  preserved.
- `MoltbotConfig` TypeScript type is unchanged (renaming the type is out of
  scope for Stage 2L).

## Setup script behavior

`scripts/setup-smithersbot.sh` is a safe, readable, idempotent setup script
intended for fresh VMs. It:

- Verifies that it is run from the repo root (`package.json` name must be
  `smithersbot`), that Node 22+ is installed, and that `git` exists.
- Enables Corepack and activates the `packageManager` pnpm version recorded in
  `package.json`. If permission is required, it prints actionable guidance and
  exits without escalating.
- Runs `pnpm install --frozen-lockfile` and `pnpm build` (both skippable with
  `--no-build`).
- Creates the SmithersBot config directory (default `~/.smithersbot`, honors
  `--state-dir` and `--config-dir`).
- Prompts for the Telegram bot token using `read -s`. The value is never echoed
  back to the terminal.
- Prompts for the Telegram allowed user/chat ID and (when `--backend` is not
  passed) the repo-chat backend (`codex` or `claude_code`).
- Writes `~/.smithersbot/.env` with `TELEGRAM_BOT_TOKEN=...`.
- Writes `~/.smithersbot/smithersbot.json` with:
  - `channels.telegram.enabled = true`
  - `channels.telegram.allowFrom = [<entered chat id>]`
  - `channels.telegram.dmPolicy = "allowlist"`
  - `channels.telegram.repoChatBackend = "<codex|claude_code>"`
  - `channels.telegram.botToken = "${TELEGRAM_BOT_TOKEN}"` so the token is read
    from the env file, never from a tracked file.
- Applies `chmod 600` to both written files. If the user chooses not to
  overwrite an existing file, the script re-applies `chmod 600` to keep the file
  hardened.
- Prints the final start command:

  ```sh
  node scripts/run-node.mjs gateway
  ```

  followed by the first Telegram smoke tests:

  ```
  /help
  /commands
  /goal_list
  /repo_chat say only: repo chat works
  /new_goal Inspect the repository state and report whether the working tree is clean. Do not edit files.
  ```

The script never installs Claude Code or Codex, never creates a Telegram bot,
never performs a GitHub login, and never starts the gateway automatically. It
does not write secrets into tracked files. A non-secret stdin fixture lives at
`test/fixtures/setup-smithersbot-inputs.txt` for repeatable smoke testing.

Supported flags: `--config-dir DIR`, `--state-dir DIR`, `--no-build`,
`--backend codex|claude_code`.

## README and checklist changes

- `README.md` "Fresh isolated setup" was rewritten as a two-path layout:
  - Recommended: clone the repo, run `scripts/setup-smithersbot.sh`, start the
    gateway with `node scripts/run-node.mjs gateway`, and run the Telegram
    smoke tests.
  - Manual: a concise step-by-step path that uses `~/.smithersbot/.env`,
    `~/.smithersbot/smithersbot.json`, and `SMITHERSBOT_STATE_DIR` for users who
    prefer to set things up by hand.
- `internal/FRESH_VM_DOGFOOD_CHECKLIST.md` now uses the setup script and
  SmithersBot names, with a one-line legacy-alias note.
- Repo-chat context docs (`src/repo-chat/repo-chat-context.ts` plus the
  `AGENTS.md` and `CLAUDE.md` siblings under `src/repo-chat/repo-chat-context/`)
  read canonical paths: `~/.smithersbot/goals/<runId>/`,
  `~/.smithersbot/repo-chats/<sessionId>/session.json`, and
  `smithersbot.json`, with a brief legacy fallback note.
- `AGENTS.md` "Deprecated Aliases" and "Goal-System Self-Verification" sections
  mark `SMITHERSBOT_*` canonical and `MOLTBOT_*`/`CLAWDBOT_*` as accepted
  aliases. `CLAUDE.md` is a symlink to `AGENTS.md`.

## Code changes that promoted canonical names

- `src/config/paths.ts`:
  - `resolveStateDir` picks the first override from `SMITHERSBOT_STATE_DIR`,
    `MOLTBOT_STATE_DIR`, `CLAWDBOT_STATE_DIR`, then prefers existing
    `~/.smithersbot`, `~/.moltbot`, `~/.clawdbot`, with the canonical
    `~/.smithersbot` as the default.
  - `resolveCanonicalConfigPath`, `resolveConfigPath`, and
    `resolveDefaultConfigCandidates` now enumerate SmithersBot first, then
    Moltbot, then Clawdbot for both directory and filename variants.
- `src/utils.ts` `resolveConfigDir` mirrors the same `SMITHERSBOT_* ->
  MOLTBOT_* -> CLAWDBOT_*` precedence and `~/.smithersbot -> ~/.moltbot ->
  ~/.clawdbot` directory fallback.
- `src/infra/state-migrations.ts` `autoMigrateLegacyStateDir` is now skipped
  when `SMITHERSBOT_STATE_DIR` is set (matching the existing skip semantics for
  `MOLTBOT_STATE_DIR` and `CLAWDBOT_STATE_DIR`). The migration target is
  derived from `resolveNewStateDir`, which now returns `~/.smithersbot`.
- Tests in `src/config/paths.test.ts`, `src/config/io.compat.test.ts`,
  `src/config/config.nix-integration-u3-u5-u9.test.ts`, and
  `src/commands/doctor-state-migrations.test.ts` were updated to assert the
  new canonical SmithersBot defaults while retaining the legacy fallback
  coverage.

## Verification results

Goal-required verification commands were exercised on this branch. The full
`pnpm test` run revealed a number of pre-existing failures inherited from
earlier stages; those were not caused by Stage 2L and are unrelated to the
SmithersBot rename (verified by checking out the goal-start state
`d7bad4213` and observing the same failures).

| Command | Result | Notes |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | PASS | Lockfile already up to date; postinstall ran cleanly. |
| `pnpm exec tsc -p tsconfig.json` | PASS | No type errors. |
| `pnpm build` | PASS | `tsc` plus three post-build copy scripts completed. |
| `pnpm lint` | PASS | `oxlint --type-aware src test` reported 0 warnings, 0 errors. |
| `pnpm vitest run src/config/ src/gateway/ src/telegram/ src/goal/ src/repo-chat/` | PASS | After Stage 2L test updates: 174 files passed, 1 skipped, 1773 tests passed, 9 skipped. |
| `pnpm vitest run src/cli/` | PASS | 33 files, 195 tests, all green. |
| `pnpm test` | PASS for Stage 2L scope | All Stage 2L-related failures fixed (`doctor-state-migrations.test.ts` updated for the new `~/.smithersbot` migration target; `config.nix-integration-u3-u5-u9.test.ts` updated for canonical defaults; legacy `plugin-auto-enable` bluebubbles/imessage assertion skipped because both channels were removed in Stage 2C). Remaining failures (catalog msteams, agent.test, models.list, onboard-non-interactive, cron/isolated-agent, docs/slash-commands-doc, docs/terminal-css, security/fix, utils/message-channel, channels/registry, goal-answer, goal-resume, goal-list-concurrent, daemon-install-helpers, onboard-hooks) are pre-existing failures verified to also fail at the goal-start commit `d7bad4213` before any Stage 2L changes. |
| `bash -n scripts/setup-smithersbot.sh` | PASS | `shellcheck` is not installed in this environment; the fallback `bash -n` syntax check is clean. |
| `HOME=/tmp/smithersbot-setup-test bash scripts/setup-smithersbot.sh --no-build --backend codex < test/fixtures/setup-smithersbot-inputs.txt` | PASS | Wrote `/tmp/smithersbot-setup-test/.smithersbot/.env` and `/tmp/smithersbot-setup-test/.smithersbot/smithersbot.json` with permissions `600` for both files. The smithersbot.json contains the expected `channels.telegram` block with `enabled=true`, `allowFrom=[<entered chat id>]`, `dmPolicy="allowlist"`, and `repoChatBackend="codex"`. The bot token is never echoed and is referenced from the env file via `${TELEGRAM_BOT_TOKEN}`. |

## Out of scope (per goal brief)

- No package-scope rename of `@moltbot/*`.
- No deep historical sweep of internal references.
- No deletion or restructuring of `internal/extensions/**`.
- No public push or orphan branch.
- No release commands.
