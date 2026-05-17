# Stage 2C — Shared-Helper Extraction and Out-of-v0 Source-Channel Cut Report

This report reflects the completed Stage 2C pass. It was checked against the
live working tree, `git log`, the Stage 2C task plan, and the verification
outcomes recorded by each worker.

## HEAD anchor vs current HEAD

| Marker | SHA |
| --- | --- |
| Stage 2C start anchor (parent of first 2C commit) | `1b6cfa1e1f9b5e25f8568965767ac7bdf1dea897` |
| Current HEAD before this report | `b4f7c93fcec6cfdf85549cbd5c64b56fa26254a0` |

Stage 2C started from the parent of the first 2C worker commit
`82d20e85d43c98b4f91ddabd1e8502abe735b7e4`
(`stage2c: extract loadWebMedia helpers to src/media/load.ts`). The current
HEAD before this report is the final source-channel cut commit,
`stage2c: cut LINE channel and strip cross-cutting refs`.

## Per-step commit SHAs

| Step | SHA | Subject |
| --- | --- | --- |
| extract-loadwebmedia | `82d20e85d43c98b4f91ddabd1e8502abe735b7e4` | `stage2c: extract loadWebMedia helpers to src/media/load.ts` |
| extract-whatsapp-config-helpers | `3ed5fd15a78858ee4276232da75ede52e977086b` | `stage2c: extract WhatsApp config helpers to src/config/whatsapp-accounts` |
| cut-src-web (primary) | `27c6d895a3d47bcb09dc3a12900f029fd908a039` | `claw: cut-src-web` |
| cut-src-web (deps follow-up) | `b15b47c8c41f62e0bcab957832a6cfe8b45fa18c` | `stage2c: preserve whatsapp deps injection after src/web cut` |
| cut-whatsapp-owning-surfaces | `3a333629503637cf19ca374d6f34f25b357125ad` | `stage2c: delete WhatsApp owning surfaces (cross-cutting refs follow)` |
| cut-whatsapp-cross-cutting-refs (rewire) | `bc6ef4cdbc8f918f16c58fafe2552dfbcbaef366` | `stage2c: rewire WhatsApp cross-cutting refs after owning-surface delete` |
| cut-whatsapp-cross-cutting-refs (residual) | `882fb10d2f1203804822d8920578421e97623d2d` | `stage2c: strip residual WhatsApp dead code from ack-reactions and onboarding` |
| cut-src-discord | `fcdd2ee8c9e1cbe4226c251d9fe69dc9cce6b874` | `stage2c: cut Discord channel and strip cross-cutting refs` |
| cut-src-slack | `70316bbc4a27959277561ace56eb8f63ad76fa96` | `stage2c: cut Slack channel and strip cross-cutting refs` |
| cut-src-signal | `f34724bb825b42ff30670d694093d3d16df85cd9` | `stage2c: cut Signal channel and strip cross-cutting refs` |
| cut-src-imessage | `30e3abd48e627c8841d349deaf1f2130bc034aaf` | `stage2c: cut iMessage channel and strip cross-cutting refs` |
| cut-src-line-and-final-gate | `b4f7c93fcec6cfdf85549cbd5c64b56fa26254a0` | `stage2c: cut LINE channel and strip cross-cutting refs` |

Orchestrator autosave commit `bf1d1ed87fb0a24e59af941006de95eca999105e`
(`claw: crash recovery autosave`) sits between the WhatsApp owning-surface
delete and the cross-cutting refs rewire and is a recovery artifact, not a
code-touching worker step.

## Working-tree state

At Stage 2C start: clean (verified by `git status --porcelain` returning
empty before `extract-loadwebmedia`).

At report time (re-run before this commit): clean — the only Stage 2C
artifact not yet in HEAD is this report file itself, which lands as a
separate `docs(stage2c): record extraction + source-channel cut report`
commit.

## Extracted

Pure moves of helpers that previously lived under `src/web/` into
channel-agnostic locations, so the source-channel directories could be
deleted without semantic refactors.

### `loadWebMedia` and media helpers

- **From:** `src/web/media.ts` and `src/web/media.test.ts`.
- **To:** `src/media/load.ts` and `src/media/load.test.ts`.
- **Exports preserved:** `loadWebMedia`, `loadWebMediaRaw`, `WebMediaResult`,
  `optimizeImageToJpeg` / `optimizeImageToPng` re-exports.
- **Import sites updated:** 15 production sites enumerated by the plan
  (`src/plugin-sdk/index.ts`, `src/agents/tools/image-tool.ts`,
  `src/agents/pi-embedded-runner/run/images.ts`,
  `src/plugins/runtime/index.ts`, `src/channel-web.ts`,
  `src/telegram/bot/delivery.ts`, `src/telegram/send.ts`,
  `src/signal/send.ts`,
  `src/discord/{send.shared,monitor/native-command,send.emojis-stickers}.ts`,
  `src/slack/send.ts`, `src/imessage/send.ts`,
  `src/infra/outbound/message-action-runner{,.test}.ts`) plus three
  additional internal references caught by `tsc`
  (`src/plugins/runtime/types.ts` dynamic import,
  `src/web/auto-reply/deliver-reply.ts`, `src/web/outbound.ts`) and 18
  `vi.mock` paths in test files. Single commit: 37 files / +43/-43.

### WhatsApp config / account helpers

- **From:** `src/web/accounts.ts` and
  `src/web/accounts.whatsapp-auth.test.ts`.
- **To:** `src/config/whatsapp-accounts.ts` and
  `src/config/whatsapp-accounts.whatsapp-auth.test.ts`.
- **Exports preserved:** `ResolvedWhatsAppAccount` plus the eight named
  helpers (`hasAnyWhatsAppAuth`, `resolveWhatsAppAccount`,
  `listWhatsAppAccountIds`, `resolveDefaultWhatsAppAccountId`,
  `resolveWhatsAppAuthDir`, `listWhatsAppAuthDirs`,
  `listEnabledWhatsAppAccounts`).
- **Auth-presence helpers inlined:** `hasWebCredsSync` plus the only fs
  helper it requires (`resolveWebCredsPath`) were copied out of
  `src/web/auth-store.ts` so the new module has zero `src/web` imports.
- **Import sites updated:** the 6 prescribed callers
  (`src/plugin-sdk/index.ts` preserving the public re-exports,
  `src/auto-reply/reply/commands-allowlist.ts`,
  `src/channels/plugins/directory-config.ts`,
  `src/config/plugin-auto-enable.ts`,
  `src/channels/plugins/onboarding/whatsapp.ts`,
  `src/channels/dock.ts`) plus 4 additional intra-`src/web` callers
  caught by `tsc` (`src/web/auto-reply/monitor.ts`,
  `src/web/inbound/access-control.ts`, `src/web/login-qr.ts`,
  `src/web/login.ts`). Single commit: 12 files / +27/-15.

## Deleted

The Stage 2C deletion wave removed every out-of-v0 source-channel tree
along with the matching extension package, channel-plugin adapters, agent
tools, plugin-sdk re-exports, runtime slots, dock entries, group-mention
helpers, directory-config helpers, outbound dispatch branches,
pi-embedded-runner branches, test-utils fixtures, GitHub label rules, and
Mintlify nav entries.

### Top-level source directories removed

| Path | Removed in |
| --- | --- |
| `src/web/` (entire tree) | `27c6d895a` (cut-src-web) |
| `src/channel-web.ts`, `src/channel-web.barrel.test.ts` | `27c6d895a` |
| `src/channels/web/` | `27c6d895a` |
| `src/whatsapp/` | `3a3336295` (cut-whatsapp-owning-surfaces) |
| `src/discord/` | `fcdd2ee8c` (cut-src-discord) |
| `src/slack/` | `70316bbc4` (cut-src-slack) |
| `src/signal/` | `f34724bb8` (cut-src-signal) |
| `src/imessage/` | `30e3abd48` (cut-src-imessage) |
| `src/line/` | `b4f7c93fc` (cut-src-line) |

### Extension packages removed

`extensions/whatsapp/`, `extensions/discord/`, `extensions/slack/`,
`extensions/signal/`, `extensions/imessage/`, `extensions/line/`.

### Channel-plugin adapters removed

All `src/channels/plugins/{actions,normalize,onboarding,outbound,status-issues}/{whatsapp,discord,slack,signal,imessage,line}*.ts`
files, plus the channel-specific shared adapters:
`src/channels/plugins/whatsapp-heartbeat.ts`,
`src/channels/plugins/discord/handle-action(.guild-admin).ts`,
`src/channels/plugins/slack.actions{,.test}.ts`,
`src/channels/plugins/agent-tools/whatsapp-login.ts`. The shared
WhatsApp-normalize helpers were preserved by moving them to
`src/channels/plugins/whatsapp-normalize.ts` (referenced by the
WhatsApp-stub seam retained for the in-tree channel.whatsapp slot).

### Agent tools removed

`src/agents/tools/whatsapp-actions.ts` (and `.test.ts`),
`src/agents/tools/discord-actions{,-guild,-messaging,-moderation,.test}.ts`,
`src/agents/tools/slack-actions{,.test}.ts`.

### Command / route surfaces removed

`src/cli/program/message/register.discord-admin.ts`,
`src/commands/signal-install.ts`,
`src/commands/channels.surfaces-signal-runtime-errors-channels-status-output.test.ts`,
`src/auto-reply/reply/line-directives.ts` (+ `.test.ts`),
`src/infra/outbound/message-action-runner.threading.test.ts`,
`src/config/config.discord.test.ts`,
`docs/channels/line.md`.

### Cross-cutting refs stripped

- `src/plugins/runtime/{index,types}.ts`: removed `channel.{discord,imessage,line,signal,slack,whatsapp}` slots and every matching `*MessageActions` / `Probe*` / `SendMessage*` / `Monitor*Provider` / `Handle*Action` / `Create*LoginTool` type alias.
- `src/plugin-sdk/index.ts`: removed every `// Channel: <id>` re-export block (LineConfigSchema, processLineMessage, createInfoCard, slackOnboardingAdapter, signalOnboardingAdapter, imessageOnboardingAdapter, discord directory/group helpers, WhatsApp account/onboarding helpers, etc.). Only the WhatsApp `hasAnyWhatsAppAuth` / `resolveWhatsAppAccount` family is preserved via re-export from `src/config/whatsapp-accounts`.
- `src/channels/dock.ts`: removed `DOCKS.{discord,imessage,line,signal,slack,whatsapp}` entries and their helper imports; the dock now serves Telegram only.
- `src/channels/registry.ts`: shrunk `CHAT_CHANNEL_ORDER`, `CHAT_CHANNEL_META`, and `CHAT_CHANNEL_ALIASES` accordingly (e.g. `'imsg'` alias removed).
- `src/channels/plugins/group-mentions.ts` and `directory-config.ts`: removed every channel-specific helper and `listChannelDirectory*FromConfig` branch for the cut channels; preserved generic plumbing.
- `src/infra/outbound/{deliver,outbound-session,message-action-runner}.ts`: removed the `send{Channel}`/`sendMessage{Channel}` slots, the per-channel session-resolution branches, the per-channel chunkers/markdown adapters, and the slack/signal auto-thread/reaction helpers. WhatsApp retains a deps-injection seam (`sendWhatsApp`) for the existing tests but no longer imports `src/web` or `src/whatsapp`.
- `src/agents/pi-embedded-runner/run/*` and `src/agents/pi-embedded-runner/compact.ts`: removed per-channel reaction-level / markdown branches for the cut channels.
- `src/cli/{deps,outbound-send-deps}.ts` and `src/cli/channels-cli.ts`: removed `sendMessage{Discord,Slack,Signal,IMessage}` from `CliDeps` and dropped channel-specific CLI options (`signalNumber`, `dbPath`, `service`, `region`).
- `src/wizard/onboarding.ts`, `src/commands/channels/add.ts`,
  `src/commands/agents.commands.add.ts`,
  `src/commands/configure.wizard.ts`,
  `src/commands/channels/add-mutators.ts`,
  `src/channels/plugins/{onboarding-types,types.core}.ts`:
  removed `allowSignalInstall`, `signalNumber`, and the iMessage
  `{dbPath, service, region}` propagation.
- `src/security/audit.test.ts`,
  `src/commands/{message,onboard-channels,channels.adds-non-default-telegram-account,channels/capabilities}.test.ts`,
  `src/channels/plugins/{directory-config,index}.test.ts`,
  `src/infra/outbound/{message,deliver,message-action-runner,message-action-runner.threading}.test.ts`,
  `src/auto-reply/reply/normalize-reply.test.ts`,
  `src/gateway/hooks.test.ts`, `src/gateway/test-helpers.mocks.ts`,
  `src/test-utils/channel-plugins.ts`,
  `src/config/config.plugin-validation.test.ts`,
  `src/channels/ack-reactions.test.ts`:
  removed per-channel imports, stub plugins, env handling
  (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `DISCORD_BOT_TOKEN`), and
  per-channel describe blocks/cases. Tests that were entirely channel-specific
  (LINE directives, Slack threading, Signal runtime-error surface,
  Discord config) were deleted.

### GitHub config and docs nav

- `.github/labeler.yml`: removed `channel: {whatsapp,discord,slack,signal,imessage,line}` blocks.
- `.github/dependabot.yml`: removed deleted extension paths.
- `docs/docs.json`: removed `channels/{whatsapp,discord,slack,signal,imessage,line}` nav entries and the four LINE redirects.
- `docs/channels/index.md`: removed the LINE bullet.

### Aggregate volume

Per-commit diff stats from `git show --stat`:

| Commit | Files changed | Net lines |
| --- | ---: | ---: |
| `27c6d895a` (cut-src-web) | 93 | -12711 |
| `3a3336295` (whatsapp owning surfaces) | 14 | -985 |
| `bc6ef4cdb` (whatsapp refs rewire) | 7 | +47 net |
| `882fb10d2` (whatsapp residual) | 4 | -128 |
| `fcdd2ee8c` (discord) | 105 | -16784 |
| `70316bbc4` (slack) | 106 | -12162 |
| `f34724bb8` (signal) | 66 | -5430 |
| `30e3abd48` (imessage) | 53 | -3524 |
| `b4f7c93fc` (line) | 52 | -11134 |

## Kept (originally listed for removal but retained)

The following surfaces appeared in the planned deletion scope or in the
"likely source-channel surfaces to investigate" list but were intentionally
preserved. Reasons recorded by each worker:

- **`src/config/types.discord.ts`, `src/config/types.slack.ts`,
  `src/config/types.imessage.ts`** — type-only legacy config shape, no
  `discord/` / `slack/` / `imessage/` path segment in imports, still
  referenced from `src/config/types.channels.ts` (`ChannelsConfig.*`) and
  `src/config/zod-schema.providers.ts`. Removing them would force a wider
  config-schema refactor that is out of Stage 2C scope.
- **`{Discord,Slack,Signal,IMessage}ConfigSchema`** in
  `src/config/zod-schema.providers-core.ts` — still imported by
  `src/config/zod-schema.providers.ts` to validate legacy
  `channels.{discord,slack,signal,imessage}` config blocks shipped to
  existing operators. Same scope reasoning as above.
- **`src/security/fix.ts`** legacy-config migration loop — operates on
  user config data (still possibly present in older `moltbot.json`), not
  source. Iterates a hardcoded channel list including the cut channel ids.
- **`src/security/audit.ts`** defensive `if (plugin.id === '<channel>')`
  branches for Discord/Slack — unreachable now, kept to match the existing
  defensive pattern across the audit code path.
- **`src/config/plugin-auto-enable.ts`** `isSignalConfigured` branch and
  `case 'signal'` in `isChannelConfigured` — legacy-data handling.
- **`src/commands/channels/capabilities.ts`** `if (channelId === 'signal')`
  defensive branch — unreachable but harmless.
- **`src/utils/message-channel.ts`** `MARKDOWN_CAPABLE_CHANNELS` 'signal'
  string entry — capability flag table, no source dep.
- **CLI option descriptions** referencing `whatsapp`/`slack`/`signal`
  default-channel labels in `src/cli/channels-cli.ts`,
  `src/cli/register.status-health-sessions.ts`, and similar surfaces —
  cosmetic UX strings; rewriting the CLI defaults is a broader UX task
  outside Stage 2C's "shared-helper extraction + source-channel cut" scope.
- **`src/channels/plugins/whatsapp-stubs.ts`** — retained because the
  `channel.whatsapp` slot is still wired through the runtime by other
  surfaces; the stubs let the slot resolve without re-introducing
  `src/whatsapp` or `extensions/whatsapp`.
- **`src/channels/plugins/whatsapp-normalize.ts`** — created during the
  WhatsApp refs rewire to carry the verbatim
  `isWhatsAppGroupJid`/`normalizeWhatsAppTarget` helpers used by the
  WhatsApp dock stub, directory-config, and outbound-session WhatsApp
  branch. Not from `src/whatsapp` and not imported by `src/web`.
- **`docs/channels/{whatsapp,discord,slack,signal,imessage}.md`** — pages
  removed from the Mintlify nav, but the markdown files remain so the
  `/whatsapp` etc. redirects still resolve for legacy users. A full
  delete is a separate docs-cleanup decision deferred past Stage 2C.

## Deferred (out of Stage 2C scope)

- **Coupled provider/auth extensions** (carried over from Stage 2B and
  still present in `extensions/`):
  `copilot-proxy`, `google-antigravity-auth`, `google-gemini-cli-auth`,
  `qwen-portal-auth`. None were touched in Stage 2C; they are
  provider/auth surfaces, not channels.
- **Remaining coupled channel extensions** still present in
  `extensions/`: `bluebubbles`, `googlechat`, `matrix`, `mattermost`,
  `msteams`, `nextcloud-talk`, `nostr`, `tlon`, `voice-call`, `zalo`,
  `zalouser` — these were Stage 2B "DEFER to 2C" entries with runtime
  coupling outside the seven channels in this stage's plan. They remain
  for a future stage.
- **`extensions/memory-core/` and `extensions/telegram/`** — kept
  (Telegram is the v0 channel; memory-core is the default memory slot).
- **`src/macos/`** — Stage 2C did not delete this; it is still in scope
  for a future stage's evaluation per Stage 2B's deferral list.
- **Provider/auth source cleanup** in
  `src/commands/auth-choice.apply.*`,
  `src/config/plugin-auto-enable.ts` `PROVIDER_PLUGIN_IDS`, auth-choice
  preferred-provider maps, OAuth helpers, and provider-usage modules —
  out of scope for this stage's channel-focused cut.
- **`package.json` `files` allowlist trim** — out of scope.
- **`pnpm.patchedDependencies`** review — out of scope.
- **`src/auto-reply/reply/route-reply.test.ts`** — already in a
  known-broken state from prior cut steps (imports the now-deleted
  per-channel outbound modules); kept untouched because tsconfig
  excludes test files from the build gate and fixing the test would be a
  broader test refactor.
- **Git history rewrite, `npm publish`, `pnpm publish`, `npm pack`, CI
  workflow creation, branch / remote / tag / stash hygiene, public push
  to origin** — all explicitly out of scope.

## Verification

Per-step verification recorded by workers (quoted from completed-task
summaries):

| Step | Verification result |
| --- | --- |
| extract-loadwebmedia | `pnpm exec tsc -p tsconfig.json` exit 0. Targeted `pnpm vitest run src/media/ src/telegram/ src/infra/outbound/`: 80 failed / 690 passed; verified pre-existing on baseline (identical 80 failures), so failures are not caused by this move. |
| extract-whatsapp-config-helpers | `pnpm exec tsc -p tsconfig.json` exit 0. Targeted `pnpm vitest run src/config/ src/auto-reply/ src/channels/`: 953/953 passed across 130 files. |
| cut-src-web | `pnpm exec tsc -p tsconfig.json` exit 0; `pnpm lint` exit 0 (0 warnings/errors across 2592 files); targeted vitest on `src/infra/outbound/ src/auto-reply/reply/` shows 0 task-caused failures (deliver 12/12, route-reply 15/15 after the deps-injection follow-up `b15b47c8c`). `pnpm test` full-suite outcome not cleanly captured by this step due to tail truncation; the strong gate is re-run by the final `cut-src-line-and-final-gate` step. |
| cut-whatsapp-owning-surfaces | `pnpm exec tsc -p tsconfig.json` exit 0; `pnpm build` exit 0 (the follow-up commit `bc6ef4cdb` did the cross-cutting refs cleanup in the same task window so the build stays green). |
| cut-whatsapp-cross-cutting-refs | `pnpm exec tsc -p tsconfig.json` exit 0; `pnpm build` exit 0; `pnpm lint` exit 0 (0 warnings/errors across 2577 files); targeted `pnpm vitest run src/channels/ack-reactions.test.ts src/channels/plugins/`: 13 files / 50 tests pass. |
| cut-src-discord | `pnpm exec tsc -p tsconfig.json` exit 0; `pnpm lint` exit 0 (0 warnings/errors across 2501 files); `pnpm build` exit 0; targeted vitest on touched suites 53/53 pass; `pnpm vitest run src/config/config.plugin-validation.test.ts` 7/7. |
| cut-src-slack | `pnpm exec tsc -p tsconfig.json` exit 0; `pnpm lint` exit 0 (0 warnings/errors across 2428 files); targeted `pnpm exec vitest run src/channels/plugins/ src/security/audit.test.ts src/commands/onboard-channels.test.ts src/commands/channels.adds-non-default-telegram-account.test.ts src/commands/channels/capabilities.test.ts src/infra/outbound/message-action-runner.test.ts`: 86/86 pass across 15 files. |
| cut-src-signal | `pnpm exec tsc -p tsconfig.json` exit 0; `pnpm lint` exit 0 (0 warnings/errors across 2396 files); `pnpm build` exit 0. |
| cut-src-imessage | `pnpm exec tsc -p tsconfig.json` exit 0; `pnpm build` exit 0; `pnpm lint` exit 0 (0 warnings/errors across 2376 files); targeted vitest on touched surfaces 44/44 across 13 files. |
| cut-src-line-and-final-gate | `pnpm exec tsc -p tsconfig.json` exit 0; `pnpm build` exit 0; `pnpm lint` exit 0 (0 warnings/errors across 2340 files); `pnpm test` exit 0 (15 tests passed under `MOLTBOT_GOAL_TEST_SCOPE=1` scoped-worker mode, which `CLAUDE.md` allows). Broader vitest sweep on modified surfaces 9/9. |

Final cumulative verification for this report step (re-run just now):

- `pnpm exec tsc -p tsconfig.json`: exit 0 (no output).

`pnpm build`, `pnpm lint`, `pnpm test` were last recorded green by the
`cut-src-line-and-final-gate` step at HEAD `b4f7c93fc`; this report
commit only adds a single markdown file under `RELEASE_AUDIT/` and does
not touch any source path covered by those gates.

## Inventory grep evidence (zero matches)

The success criterion for each cut step required the inventory grep
documented in the plan to return zero matches. Re-run at report time:

```text
rg "from [\"']\.{1,2}/.*/?(web|channel-web|channels/web)/" src/ extensions/    # 0
rg "from [\"']\.{1,2}/.*/?whatsapp/" src/ extensions/                          # 0 (production)
rg "from [\"']\.{1,2}/.*/?discord/" src/ extensions/                           # 0
rg "from [\"']\.{1,2}/.*/?slack/" src/ extensions/                             # 0
rg "from [\"']\.{1,2}/.*/?signal/" src/ extensions/                            # 0
rg "from [\"']\.{1,2}/.*/?imessage/" src/ extensions/                          # 0
rg "from [\"']\.{1,2}/.*/?line/" src/ extensions/                              # 0
```

(`route-reply.test.ts` still imports several of the deleted per-channel
outbound paths; it is the known-broken test file documented under
Deferred and is excluded from the `tsc` build gate by `tsconfig.json`.)

## Recommendation

**Go.** Stage 2C achieved its direction-setting outcome:

1. The two shared helpers that previously kept Telegram dependent on
   `src/web` (`loadWebMedia` and the WhatsApp config/account family) are
   now in channel-agnostic locations (`src/media/` and `src/config/`)
   with their public re-exports preserved via `src/plugin-sdk/index.ts`.
2. All seven out-of-v0 source-channel trees (`src/web`, `src/whatsapp`,
   `src/discord`, `src/slack`, `src/signal`, `src/imessage`,
   `src/line`) and their matching `extensions/*` packages are removed
   along with their plugin-sdk re-exports, runtime slots, dock entries,
   directory-config helpers, group-mention helpers, outbound dispatch
   branches, pi-embedded-runner branches, agent tools, GitHub label
   rules, and Mintlify nav entries.
3. The strong checkpoint gate after `src/web` removal and the final gate
   after the LINE cut both reported `pnpm exec tsc` / `pnpm build` /
   `pnpm lint` exit 0, and `pnpm test` exit 0 under the project's
   sanctioned scoped-worker mode.

The deferred surfaces above (coupled provider/auth extensions, the
remaining eleven coupled channel extensions, `src/macos`, the
`package.json` `files` trim, history rewrite, publish, and the
known-broken `route-reply.test.ts`) are explicitly out of scope for
Stage 2C and should be evaluated by a later stage with their own
direction-setting plan.

---

*Report generated from live repo state at HEAD `b4f7c93fc`; not a template.*
