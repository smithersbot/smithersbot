# Stage 2D — Deleted-Path Reference Sweep

HEAD at start: `9d565eb82ce06c074eec265bf5fbe16b6a7d745b`

This fragment records the deleted-path reference sweep performed by the
`deleted-path-sweep` task in Stage 2D. It covers every directory that
Stage 2B (`STAGE2B_REPORT.md`) and Stage 2C (`STAGE2C_REPORT.md`) removed
from the source tree.

## Deleted-path catalog reviewed

Stage 2B (15 surfaces):
- `Swabble/`
- `smithersbot_marketing/`
- `openclaw-starter-kit`
- `packages/clawdbot/`
- `packages/moltbot/`
- `apps/ios/`
- `apps/android/`
- `apps/macos/`
- `apps/shared/MoltbotKit/`
- `extensions/diagnostics-otel/`
- `extensions/llm-task/`
- `extensions/lobster/`
- `extensions/memory-lancedb/`
- `extensions/open-prose/`
- `extensions/twitch/`

Stage 2C (15 surfaces):
- `src/web/`
- `src/whatsapp/`
- `src/discord/`
- `src/slack/`
- `src/signal/`
- `src/imessage/`
- `src/line/`
- `src/channel-web.ts`
- `src/channels/web/`
- `extensions/whatsapp/`
- `extensions/discord/`
- `extensions/slack/`
- `extensions/signal/`
- `extensions/imessage/`
- `extensions/line/`

Surfaces searched: `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`,
`SECURITY.md`, `NOTICE.md`, `AGENTS.md`, `CLAUDE.md`, `package.json`
(files/bin/exports/main), `.github/labeler.yml`, `.github/dependabot.yml`,
`.github/ISSUE_TEMPLATE/*`, `docs/**`, `scripts/**`,
`pnpm-workspace.yaml`, `Dockerfile*`, `docker-compose.yml`, `render.yaml`,
`fly.toml`, `fly.private.toml`, `appcast.xml`, `tsconfig*.json`,
`vitest*.config.ts`, and `src/**`.

## Findings and actions

### Fixed

| File | Lines | Reference | Action |
| --- | --- | --- | --- |
| `package.json` | files allowlist | `dist/discord/**`, `dist/imessage/**`, `dist/signal/**`, `dist/slack/**`, `dist/line/**`, `dist/web/**`, `dist/whatsapp/**` | Removed (source dirs deleted in 2C; `dist/macos/**` kept since `src/macos/` still exists per 2B/2C deferral). |
| `vitest.config.ts` | 66-67 | `src/agents/tools/discord-actions*.ts`, `src/agents/tools/slack-actions.ts` (coverage exclude) | Removed (files deleted in 2C). |
| `vitest.config.ts` | 88-93, 98 | `src/discord/**`, `src/imessage/**`, `src/signal/**`, `src/slack/**`, `src/channels/web/**`, `src/webchat/**` (coverage exclude) | Removed (dirs deleted in 2C; `src/webchat/**` also already absent). |
| `src/repo-chat/repo-chat-context.ts` | 11, 22, 28, 33 | Channel-list string mentioned deleted `src/discord/`, `src/slack/`, `src/signal/`, `src/imessage/`, `src/web/`, `src/provider-web.ts`, and top-level `apps/` (native apps). | Rewrote the channel-integration bullet to Telegram-only, removed `provider-web.ts`, removed `apps/` bullet, and updated the runtime-shown Project Overview to drop the unsupported-channel claim. |
| `src/repo-chat/repo-chat-context/CLAUDE.md` | 7, 18, 24, 29 | Same as above (source-of-truth file mirrored in `repo-chat-context.ts`). | Mirrored the same edits so the source file matches the embedded string. |
| `src/repo-chat/repo-chat-context/AGENTS.md` | 7, 18, 24, 29 | Same as above (source-of-truth file mirrored in `repo-chat-context.ts`). | Mirrored the same edits. |

`.github/labeler.yml` was audited and contains no rules referencing
deleted `docs/channels/*` files — every entry points at a still-extant
extension and doc pair (bluebubbles, googlechat, matrix, mattermost,
msteams, nextcloud-talk, nostr, telegram, tlon, voice-call, zalo,
zalouser). The platform-app entries (`app: android|ios|macos`) reference
`docs/platforms/{android,ios,macos}.md` and `docs/platforms/mac/**`,
all of which still exist on disk.

`.github/dependabot.yml` contains no per-extension or per-channel paths.

`.github/ISSUE_TEMPLATE/*`, `Dockerfile*`, `docker-compose.yml`,
`render.yaml`, `fly.toml`, `fly.private.toml`, `appcast.xml`,
`tsconfig.json`, `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`,
`SECURITY.md`, `NOTICE.md` were grepped and returned no hits against the
deleted-path catalog.

### Leave with reason

| File / Path | Reference | Reason to leave |
| --- | --- | --- |
| `RELEASE_AUDIT/**` | All historical inventory, audit, and 2A/2B/2C report references. | Out of scope per the Stage 2D plan (`RELEASE_AUDIT/*` is explicitly excluded from the public-surface sweep). |
| `docs/platforms/mac/{dev-setup,icon,menu-bar,release}.md` | Reference `apps/macos/...` paths. | Stage 2B explicitly deferred broader "macOS docs/scripts references that require a broader Stage 2C decision". These docs need a separate decision (keep or delete) about whether the Mac app is part of the public v0; out of scope for the deleted-path-only sweep. |
| `docs/platforms/macos.md` | `cd apps/macos && swift build` etc. | Same as above — Mac-app docs decision deferred to a follow-up stage. |
| `docs/refactor/plugin-sdk.md:157` | "Move iMessage into `extensions/imessage`". | Historical refactor planning doc describing prior phases. Not load-bearing for any current code path; rewriting historical-context docs is out of scope. |
| `scripts/build-and-run-mac.sh`, `scripts/build_icon.sh`, `scripts/create-dmg.sh`, `scripts/make_appcast.sh`, `scripts/package-mac-app.sh`, `scripts/restart-mac.sh` | Reference `apps/macos/...`. | Mac packaging scripts; removing or rewriting them belongs to the deferred Mac-app decision (same as the docs above). They are dead until either the Mac app comes back or the scripts are deleted as part of that decision. |
| `.gitignore` | Several `apps/macos/`, `apps/ios/`, `apps/shared/MoltbotKit/` ignore globs. | Harmless leftover; ignore globs that match nothing are no-ops. Cleanup is cosmetic and ties to the Mac-app decision. |
| `.dockerignore` | `apps/macos/.build`, `apps/ios/build`, `Swabble/`. | Same as `.gitignore` — harmless no-ops. |
| `.swiftformat`, `.swiftlint.yml`, `.pre-commit-config.yaml` (swiftformat hook) | Reference `apps/macos/Sources`, `apps/android`, `apps/ios`, `apps/shared`, `Swabble`. | Swift tooling configs; rewriting them is part of the deferred Mac-app decision. They do not run if the referenced dirs are absent (pre-commit `exclude` regexes and `swiftformat --exclude` lists tolerate missing paths). |
| `.secrets.baseline` | Entries for `apps/macos/Tests/ClawdbotIPCTests/*.swift`, `extensions/memory-lancedb/*.ts`, `extensions/open-prose/skills/prose/...`. | Baseline file for `detect-secrets`; stale entries are harmless (the matching files are gone so they cannot regress). Regenerating the baseline is a separate maintenance task. |
| `.agent/workflows/update_clawdbot.md` | `apps/macos/` references. | Internal agent workflow doc; not user-facing. Lives outside Stage 2D's public-surface scope. |
| `CLAUDE.md` (project root, line 16) | `When adding channels/extensions/apps/docs, review .github/labeler.yml ...` | The literal `apps/` token here is a generic noun in a sentence, not a path reference. No-op. |
| `AGENTS.md` (project root, line 16) | Same generic-noun usage as `CLAUDE.md`. | No-op (not a path). |
| `pnpm-workspace.yaml` | `packages/*` glob (the `packages/` dir was deleted in 2B). | pnpm tolerates an empty glob match — no install/lockfile impact. Removing the glob would change workspace semantics and is a broader cleanup decision; deferred. |
| `docs/docs.json` redirects to `/channels/whatsapp`, `/channels/discord`, `/channels/slack`, `/channels/signal`, `/channels/imessage` | Per `STAGE2C_REPORT.md` ("Kept" section) the `docs/channels/{whatsapp,discord,slack,signal,imessage}.md` pages were intentionally retained so these redirects still resolve for legacy URL traffic. | Working as intended — destinations exist. Out of scope. |
| `test/auto-reply.retry.test.ts` | Imports deleted `../src/web/media.js`, `../src/web/auto-reply.js`, `../src/web/inbound.js`. | Dangling test file that is NOT in the vitest `include` list (`vitest.config.ts:23-27` includes `src/**/*.test.ts`, `extensions/**/*.test.ts`, `test/format-error.test.ts` only). It is not executed by `pnpm test`, not type-checked by `tsc` (tsconfig excludes `test/`), and removing it is a separate test-cleanup decision. Flagged for the Stage 2D report so a follow-up can delete it alongside the known-broken `src/auto-reply/reply/route-reply.test.ts` documented in the Stage 2C report. |

## Re-run grep evidence

After fixes:

- `package.json` for `dist/{discord,imessage,signal,slack,line,web,whatsapp}/**`: 0 matches.
- `src/**` for `src/{discord,imessage,signal,slack,line,web,whatsapp}/`, `channel-web`, `channels/web/`, `provider-web`: 0 matches.
- `src/**` for `apps/{ios,android,macos,shared}`: 0 matches.

All remaining hits live in documented `Leave with reason` rows above.
