# Stage 2F Report

Stage 2F aligned the Telegram command surface, `/help`, `/commands`,
README/AGENTS, and bundled-hook documentation with the SmithersBot v0
operator workflow. No legacy command code was deleted. Public-menu visibility
is now decoupled from grammy handler registration.

The companion ledger is
[RELEASE_AUDIT/STAGE2F_LEGACY_COMMAND_LEDGER.md](./STAGE2F_LEGACY_COMMAND_LEDGER.md).

## Final Public Telegram Menu

The canonical list lives in
[`src/telegram/public-menu.ts`](../src/telegram/public-menu.ts) as
`PUBLIC_TELEGRAM_MENU`, in this grouped order:

- Core workflow
  - `/new_goal`
  - `/goal_status`
  - `/goal_list`
  - `/goal_resume`
  - `/goal_stop`
- Repo chat
  - `/repo_chat`
  - `/chat_backend`
- Goal diagnostics & tuning
  - `/goal_lessons`
  - `/goal_plan_autocheck`
  - `/goal_semgrep`
  - `/goal_workers`
  - `/goal_github_push` (dangerous/admin)
- Advanced & admin
  - `/nightwatch`
  - `/gateway_restart` (dangerous/admin)
- Help
  - `/help`
  - `/commands`

`buildPublicTelegramMenu` in `src/telegram/bot-native-commands.ts`
intersects this allow-list with every registered command spec (native,
plugin, goal, repo-chat, gateway-restart, create-repo, nightwatch,
custom) before calling `bot.api.setMyCommands`. Handler registration is
unchanged; only the menu payload is filtered.

## Commands Hidden From The Menu But Still Handled

Full enumeration lives in the ledger (Sections A, B, C). At a glance:

- Goal fallback handlers reachable from slashes but not on the menu:
  `/goal_approve`, `/goal_reject`, `/goal_edit`, `/goal_answer`,
  `/goal_feedback`, `/goal_detail`.
- Legacy auto-reply native commands kept reachable: `/new`, `/reset`,
  `/stop`, `/status`, `/skill`, `/approve`, `/context`, `/tts`,
  `/whoami`, `/id`, `/subagents`, `/config`, `/debug`, `/usage`,
  `/restart`, `/activation`, `/send`, `/compact`, `/think`,
  `/thinking`, `/t`, `/verbose`, `/v`, `/reasoning`, `/reason`,
  `/elevated`, `/elev`, `/exec`, `/model`, `/models`, `/queue`,
  `/allowlist`, `/bash`, `/create_repo`, plus dock/plugin/skill text
  commands.

## Aliases Removed Or Kept Hidden

Both aliases were kept registered as grammy multi-name handlers and are
absent from the public menu, `/help`, and `/commands`:

- `/goal` -> `/new_goal` (registered together in
  `src/telegram/goal-commands.ts`).
- `/rc` -> `/repo_chat` (registered together in
  `src/telegram/repo-chat-commands.ts`).

Tests assert the alias handlers remain reachable while the aliases are
absent from the public menu
(`src/telegram/bot-native-commands.plugin-auth.test.ts`). No alias was
deleted in Stage 2F.

## `/help` Behavior

`buildHelpMessage` in `src/auto-reply/status.ts` now renders directly
from `PUBLIC_TELEGRAM_MENU` and `PUBLIC_TELEGRAM_MENU_LABEL_ORDER`. The
message:

- Lists only the public SmithersBot surface, grouped by Core workflow,
  Repo chat, Goal diagnostics & tuning, Advanced & admin, and Help.
- Adds an inline danger note after Goal diagnostics & tuning that
  `/goal_github_push` is dangerous/admin and can push branches and open
  PRs.
- Adds an inline danger note after Advanced & admin that
  `/gateway_restart` is dangerous/admin and restarts the gateway.
- Ends with "More: /commands for full list".

The legacy session block (`/new`, `/reset`, `/compact`, `/stop`,
`/skill`, `/think`, `/model`, `/verbose`, `/status`, `/whoami`,
`/context`, `/config`, `/debug`) no longer appears in `/help`.

## `/commands` Behavior

`buildCommandsMessage` and `buildCommandsMessagePaginated` in
`src/auto-reply/status.ts` now build the public command list from
`PUBLIC_TELEGRAM_MENU` via `buildPublicCommandItems`, preserving the
same five-group order as `/help`. Plugin commands continue to render in
a separate "Plugins" group at the end when present, matching the prior
`buildCommandItems` behavior. Hidden goal fallbacks, hidden legacy
auto-reply commands, hidden aliases (`/goal`, `/rc`), and dock/skill
text commands are not advertised. Telegram pagination
(`COMMANDS_PER_PAGE = 8`, callback-driven prev/next) is unchanged.

## Hook Decisions

Hook infrastructure (`src/hooks/loader.ts`, `src/hooks/config.ts`,
`src/hooks/workspace.ts`, the bundled hook handlers, and
`src/goal/lessons.ts`) was left intact. Only documentation moved:

- `src/hooks/bundled/README.md` now opens with a deferred/internal-only
  note for the SmithersBot v0 public story and explicitly states that
  bundled internal hooks are not the goal lessons system used by
  `/new_goal`. Each of `session-memory`, `command-logger`, `soul-evil`,
  and `boot-md` is individually marked deferred/internal-only while its
  technical description is preserved.
- `session-memory` carries an explicit "this is not goal lessons" note
  in its section body.
- `soul-evil` was not deleted; per the no-broad-deletion rule it is
  recorded in the ledger for a later quarantine pass.

See ledger Section D for the per-hook table.

## Memory / Goal-Lessons Wording Outcome

- `README.md` Telegram-commands list (lines around 222-236) lists
  `/goal_stop` next to `/new_goal`, `/goal_status`, `/goal_list`,
  `/repo_chat`, `/chat_backend`, and `/nightwatch`.
- `README.md` Memory section (lines around 296-304) keeps the goal
  lessons description and adds a clarification line:
  "Goal lessons are separate from the older chat-session memory hooks
  under `src/hooks/bundled/`."
- `AGENTS.md` (which `CLAUDE.md` symlinks to) was reviewed for the
  public surface and not modified in this stage — it already matched
  the v0 surface at 68 lines after Stage 2E and does not advertise the
  legacy commands or aliases.
- `src/hooks/bundled/README.md` describes bundled hooks as internal and
  separate from the goal lessons system.

## Tests Changed

Files touched in Stage 2F that contain test assertions:

- `src/auto-reply/status.test.ts` — rewritten to assert the new public
  `/help` grouping, the dangerous/admin markers for `/goal_github_push`
  and `/gateway_restart`, and that the new public `/commands` output no
  longer includes `/new`, `/reset`, `/stop`, or the legacy session
  block.
- `src/telegram/bot-native-commands.plugin-auth.test.ts` — extended to
  assert that `bot.api.setMyCommands` is called with only the public
  menu, that hidden goal fallback handlers (`/goal_approve`) remain
  registered, that legacy auto-reply handlers (`/whoami`) remain
  registered, and that the `/goal` and `/rc` alias handlers are still
  reachable while absent from the menu.
- `src/telegram/bot.test.ts` — updated for the menu-payload shape change.

The Stage 2F-affected slice
(`src/telegram/`, `src/hooks/`, `src/goal/`,
`src/auto-reply/status.test.ts`,
`src/auto-reply/reply/commands-info.test.ts`) is fully green:
103 test files passed, 1318 tests passed, 8 skipped.

## Verification Commands And Results

| Command                                                                | Result                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm exec tsc -p tsconfig.json`                                       | passed                                                                                                                                                                                                                  |
| `pnpm build`                                                           | passed (`copy-hook-metadata` and `write-build-info` ran cleanly)                                                                                                                                                        |
| `pnpm lint`                                                            | passed (`Found 0 warnings and 0 errors`, 2336 files)                                                                                                                                                                    |
| `pnpm vitest run src/telegram/ src/auto-reply/ src/hooks/ src/goal/`   | **failed**: 6 test files failed, 153 passed, 1 skipped; 16 tests failed, 1773 passed, 8 skipped. All 16 failures live under `src/auto-reply/` in non-Telegram channel code (Discord, Slack, WhatsApp, iMessage).        |
| `pnpm vitest run src/telegram/ src/hooks/ src/goal/ src/auto-reply/status.test.ts src/auto-reply/reply/commands-info.test.ts` (Stage 2F-affected slice) | passed: 103 files passed, 1 skipped; 1310 tests passed, 8 skipped.                                                                                                                                                       |

### Failing tests in the broad `src/auto-reply/` slice

These tests are about non-Telegram channel surfaces that Stage 2E
already excluded from the v0 verification slice (which was
`src/infra/outbound/ src/telegram/ src/goal/ src/repo-chat/ src/memory/`).
None of them exercise `PUBLIC_TELEGRAM_MENU`, `buildHelpMessage`,
`buildCommandsMessage*`, `bot-native-commands.ts`, or the bundled hook
docs that Stage 2F changed:

- `src/auto-reply/command-control.test.ts`
  - resolveCommandAuthorization > falls back to From when SenderId and SenderE164 are whitespace
  - resolveCommandAuthorization > falls back from un-normalizable SenderId to SenderE164
  - resolveCommandAuthorization > prefers SenderE164 when SenderId does not match allowFrom
- `src/auto-reply/commands-registry.test.ts`
  - commands registry > respects text command gating (Discord text-command gating; was already failing pre-Stage-2F per the `separate-menu-from-handlers` worker result)
- `src/auto-reply/inbound.test.ts`
  - resolveGroupRequireMention > respects Discord guild/channel requireMention settings
  - resolveGroupRequireMention > respects Slack channel requireMention settings
- `src/auto-reply/reply/agent-runner-utils.test.ts`
  - buildThreadingToolContext > uses conversation id for WhatsApp
  - buildThreadingToolContext > uses the sender handle for iMessage direct chats
  - buildThreadingToolContext > prefers MessageThreadId for Slack tool threading
- `src/auto-reply/reply/reply-routing.test.ts`
  - resolveReplyToMode > defaults to off for Discord and Slack
  - resolveReplyToMode > uses configured value when present
  - resolveReplyToMode > uses chat-type replyToMode overrides for Slack when configured
  - resolveReplyToMode > falls back to top-level replyToMode when no chat-type override is set
  - resolveReplyToMode > uses legacy dm.replyToMode for direct messages when no chat-type override exists
- `src/auto-reply/reply/session-resets.test.ts`
  - initSessionState reset triggers in WhatsApp groups > Reset trigger /new blocked for unauthorized sender in existing session
  - initSessionState reset triggers in WhatsApp groups > Reset trigger /new blocked when SenderId is LID but SenderE164 is unauthorized

This is the same auto-reply legacy-channel test debt that Stage 2E left
outside its v0-supported slice. Stage 2F made no changes to Discord,
Slack, WhatsApp, or iMessage routing/threading code.

## Link

See [STAGE2F_LEGACY_COMMAND_LEDGER.md](./STAGE2F_LEGACY_COMMAND_LEDGER.md)
for the full hidden-commands, hidden-fallbacks, hidden-aliases,
hook-decisions, and dangerous-commands tables.

## Remaining Cleanup Candidates For A Later Code-Deletion Stage

Carry these forward into a follow-up cleanup stage:

- Delete `/new`, `/reset`, `/stop`, `/approve`, `/restart`, and `/bash`
  handlers after a sweep that confirms no v0 surface relies on them.
- Drop the `/goal` and `/rc` alias slots once goal-command and
  repo-chat tests can be updated to expect a single name.
- Quarantine or remove the `soul-evil` bundled hook; remove
  `command-logger` once the legacy command surface above is deleted;
  re-evaluate `session-memory` and `boot-md` against actual operator
  needs.
- Fix or quarantine the 16 auto-reply legacy-channel tests listed
  above (or rescope `src/auto-reply/` out of the public verification
  slice if those channels stay out of v0).
- Continue Stage 2E's outstanding items: add the minimal CI workflow
  once `pnpm install` is reproducible in a networked environment, and
  rename remaining legacy `@moltbot/*` extension packages if the
  project wants a fully homogeneous public namespace.

## Recommendation

**Blocked for the broad `src/auto-reply/` slice**, ready for everything
Stage 2F actually changed.

Exact blocker: 16 failing tests under `src/auto-reply/` exercise
Discord, Slack, WhatsApp, and iMessage code paths that pre-date Stage
2F (the `separate-menu-from-handlers` worker result already recorded
the `commands-registry > respects text command gating` failure before
Stage 2F began). Stage 2F's public-Telegram-menu, `/help`,
`/commands`, README, AGENTS, and bundled-hook documentation changes
are independently green under typecheck, build, lint, and the
Stage 2F-affected vitest slice
(`src/telegram/`, `src/hooks/`, `src/goal/`,
`src/auto-reply/status.test.ts`,
`src/auto-reply/reply/commands-info.test.ts`).

A networked install and CI step are still gated on Stage 2E's
`pnpm install` blocker and on resolving the auto-reply legacy-channel
test debt above.
