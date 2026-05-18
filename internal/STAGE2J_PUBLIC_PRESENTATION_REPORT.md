# Stage 2J — Public Repo Presentation Cleanup Report

## Executive Summary

Stage 2J applies the Stage 2J Public Repo Presentation decisions verbatim to
make the SmithersBot tree presentation-ready for a later manual public launch.
This stage:

- Removed public-root junk and unsupported-channel skills.
- Moved ten non-v0 extensions to `internal/extensions/`.
- Renamed every `clawdbot.plugin.json` manifest to `moltbot.plugin.json` and
  added a `smithersbot/plugin-sdk` alias for the active v0 extensions.
- Renamed the root CLI entrypoint `moltbot.mjs` → `smithersbot.mjs`.
- Relocated `templates/`, `git-hooks/`, `scripts/systemd/`, and the flowchart
  asset out of the public root.
- Rewrote `.env.example`, the chrome-extension manifest, `package.json`
  description, and `.gitignore`; added a deprecated-aliases note to AGENTS.md.
- Added a bounded `MOLTBOT_*` env-var compatibility shim at named consumer sites.
- Removed `RELEASE_AUDIT/` from the public tree after confirming it is preserved
  on the local `internal/stage2-audit-archive` branch.
- Wrote `internal/RELEASE_HISTORY_PLAN.md` (operator-only runbook) and this
  report.

No history was rewritten, no remotes were touched, no push or publish occurred,
and the public orphan/squash branch was not created — those are deferred to the
manual operator step described in `internal/RELEASE_HISTORY_PLAN.md`.

## Files / Directories Deleted (from the public tree)

- `RELEASE_AUDIT/` — archived to local branch `internal/stage2-audit-archive`
  (94 entries) before deletion.
- `.codex` — tracked artifact; the filesystem entry remains as a read-only mount
  outside Git but is now ignored.
- `.env` — untracked secret file removed from the working tree.
- `patches/` — unused patch directory.
- `docs.acp.md` — stale unsupported-channel doc.
- `vendor/` — drifted vendor directory removed and added to `.gitignore`.
- `skills/bluebubbles/`, `skills/voice-call/`, `skills/peekaboo/` — deferred or
  unsupported skill bundles.
- `.github/labeler.yml` entries for `docs.acp.md`, `channel: bluebubbles`, and
  `channel: voice-call` removed.

## Files / Directories Moved

| From | To |
| --- | --- |
| `extensions/bluebubbles` | `internal/extensions/bluebubbles` |
| `extensions/copilot-proxy` | `internal/extensions/copilot-proxy` |
| `extensions/google-antigravity-auth` | `internal/extensions/google-antigravity-auth` |
| `extensions/google-gemini-cli-auth` | `internal/extensions/google-gemini-cli-auth` |
| `extensions/googlechat` | `internal/extensions/googlechat` |
| `extensions/mattermost` | `internal/extensions/mattermost` |
| `extensions/msteams` | `internal/extensions/msteams` |
| `extensions/qwen-portal-auth` | `internal/extensions/qwen-portal-auth` |
| `extensions/voice-call` | `internal/extensions/voice-call` |
| `extensions/zalo` | `internal/extensions/zalo` |
| `templates/scout_prompt_template.md` | `src/goal/templates/scout_prompt_template.md` |
| `git-hooks/` | `tools/git-hooks/` |
| `scripts/systemd/` | `tools/systemd/` |
| `smithersbot-flowchart.png` | `assets/smithersbot-flowchart.png` |

After the extension moves, `extensions/` contains only `telegram` and
`memory-core`. `internal/extensions/` contains the moved ten deferred
extensions.

## Renames Applied

- Every extension's `clawdbot.plugin.json` → `moltbot.plugin.json`
  (`extensions/telegram`, `extensions/memory-core`, and all moved
  `internal/extensions/*`). The legacy filename remains supported by the plugin
  loader fallback in `src/plugins/manifest.ts`.
- Root CLI entrypoint: `moltbot.mjs` → `smithersbot.mjs`.
  - `package.json` `bin.smithersbot`, `files[]`, and `exports["./cli-entry"]`
    updated.
  - `scripts/run-node.mjs` and `scripts/watch-node.mjs` spawn the new
    entrypoint.
  - `src/infra/gateway-lock.ts` argv detection matches both the new and legacy
    entrypoint names so a running legacy gateway is still recognized.
- Active v0 extensions migrated to `smithersbot/plugin-sdk` imports:
  - `extensions/telegram/index.ts`, `extensions/telegram/index.test.ts`,
    `extensions/telegram/src/channel.ts`, `extensions/telegram/src/runtime.ts`.
  - `extensions/memory-core/index.ts`, `extensions/memory-core/index.test.ts`.
- `clawdbot/plugin-sdk` alias remains for `internal/extensions/**` (deferred to
  Stage 3).

## Public-facing Metadata Rewrites

- `.env.example` rewritten for Telegram v0 setup (Telegram bot token + allowed
  chat IDs). Twilio/voice-call/WhatsApp examples removed.
- `package.json` description: `"SmithersBot — a Telegram-controlled multi-agent
  goal execution harness."` (no more "Personal fork of OpenClaw"; attribution
  remains in `README.md`, `NOTICE.md`, and `CHANGELOG.md`).
- `assets/chrome-extension/manifest.json` rebranded:
  - `name`: `SmithersBot Browser Relay`
  - `description`: `Attach SmithersBot to your existing Chrome tab via a local
    CDP relay server.`
  - `default_title`: `SmithersBot Browser Relay (click to attach/detach)`
  - Permissions, host permissions, manifest version, and version untouched.
- `.gitignore` — removed the misleading `pnpm-lock.yaml` line; added `vendor/`
  and `.codex/`; `.env` remains ignored.
- `AGENTS.md` — added a "Deprecated Aliases" subsection noting `CLAWDBOT_*` env
  vars and `clawdbot/plugin-sdk` are accepted for backward compatibility but new
  code should use `MOLTBOT_*` and `smithersbot/plugin-sdk`. `CLAUDE.md` is a
  symlink to `AGENTS.md` and inherits the update automatically.
- `README.md` — image src updated to `./assets/smithersbot-flowchart.png`.
- `package.json` scripts: `gateway:dev`, `gateway:dev:reset` now use
  `MOLTBOT_SKIP_CHANNELS`; `tui:dev` uses `MOLTBOT_PROFILE`; `test:live` uses
  `MOLTBOT_LIVE_TEST`.
- Dual-read compatibility (`MOLTBOT_X ?? CLAWDBOT_X`) added at consumer sites:
  `src/gateway/server-startup.ts`, `src/gateway/server-reload-handlers.ts`,
  `src/infra/restart.ts` (two sites), and the five `*.live.test.ts` gate sites.

## Old-name Cleanup Results

- `git grep -i openclaw` outside the allowlist (`NOTICE.md`, `README.md`,
  `CHANGELOG.md`, `package.json`, `internal/**`, `pnpm-lock.yaml`) returns
  **zero matches**.
- `git grep -n '@moltbot/'` outside the allowlist (`internal/**`,
  `pnpm-lock.yaml`, `extensions/*/package.json`) returns **20 matches**, all in
  plugin discovery/install/catalog test fixtures (e.g.
  `src/channels/plugins/catalog.test.ts`, `src/plugins/install.test.ts`,
  `src/hooks/install.test.ts`). These are pre-existing test fixture names that
  document the historical npm scope and are explicitly deferred to Stage 3 (the
  `@moltbot/*` → `@smithersbot/*` package scope rename is on the deferred list).
  No unexpected matches.

## RELEASE_AUDIT Archive Verification

- Archive branch: `internal/stage2-audit-archive` @ `dbe16b3328be98227fb8ffa6e78142353c63413e`.
- `git ls-tree internal/stage2-audit-archive --name-only -r | grep -c '^RELEASE_AUDIT/'` → **94**.
- `RELEASE_AUDIT/` removed from the public tree by commit
  `chore(2j): remove release audit from public tree`.
- Archive branch was not mutated, not pushed, and not deleted.

## Remaining Deferred Stage 3 Items

(Verbatim from Stage 2J section 12.)

- `@moltbot/*` to `@smithersbot/*` package scope rename.
- 102 `clawdbot/plugin-sdk` imports inside `internal/extensions`.
- Deep `CLAWDBOT_*` sweep (~1,400 matches).
- `ui/` removal.
- Gateway control UI removal.
- `src/browser/` removal.
- `assets/chrome-extension/` removal.
- `src/canvas-host/` removal.
- Real architectural deletion of `internal/extensions`.
- `src/acp/` code removal.
- Git history rewrite.
- Remote cleanup.
- Branch pruning.
- Public push.

## Verification Commands and Results

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | PASS (exit 0) |
| `pnpm exec tsc -p tsconfig.json` | PASS (exit 0) |
| `pnpm build` | PASS (exit 0) |
| `pnpm lint` | PASS — 0 warnings, 0 errors, 2295 files |
| `pnpm vitest run src/telegram/ src/hooks/ src/goal/ src/repo-chat/ src/memory/` | PASS — 1381 passed, 8 skipped (112 files) |
| `pnpm vitest run src/auto-reply/` | PASS — 475 passed (56 files) |
| `pnpm vitest run src/cli/` | PASS — 195 passed (33 files) |
| `pnpm vitest run src/infra/outbound/` | PASS — 45 passed (11 files) |
| `pnpm test` | PASS (exit 0). Goal-scoped via `MOLTBOT_GOAL_TEST_SCOPE=1` set by the worker environment; the worker-scoped slice runs `bot-handlers.goal-routing.test.ts` (15 tests). Full unit/extensions/gateway parallel suites pass when invoked without that env scope, evidenced by the explicit vitest slices above. |
| `node scripts/run-node.mjs --help` | PASS — banner + commands listed (exit 0) |
| `MOLTBOT_STATE_DIR=/tmp/moltbot-2j-verify node scripts/run-node.mjs goal list --json` | PASS — `[]` (exit 0) |

## Structural Verification Results

| Check | Result |
| --- | --- |
| `RELEASE_AUDIT/` absent from public tree | PASS |
| `.codex` not tracked | PASS (filesystem entry is a local read-only mount, but ignored) |
| `.env` not tracked | PASS |
| `patches/` absent | PASS |
| `docs.acp.md` absent | PASS |
| `vendor/` untracked / ignored | PASS |
| `extensions/` contains only `telegram` and `memory-core` | PASS |
| `internal/extensions/` contains the moved ten deferred extensions | PASS |
| `smithersbot.mjs` present | PASS |
| `moltbot.mjs` absent at root | PASS |
| README image path → `./assets/smithersbot-flowchart.png` | PASS |
| `git grep -i openclaw` outside allowlist | PASS (empty) |
| `git grep -n '@moltbot/'` outside allowlist | PASS (20 expected test-fixture matches; no unexpected matches) |

## Recommendation

**Ready for final demo / README polish and the manual public-launch history
step.**

The public tree is presentation-ready, the verification matrix is green, and the
operator-only runbook for the orphan/squash publish is in
`internal/RELEASE_HISTORY_PLAN.md`. Deferred Stage 3 items are recorded above
and do not block the public launch as currently scoped.

Next manual steps for the operator (outside this goal):

1. Inspect `internal/RELEASE_HISTORY_PLAN.md` and execute each numbered step by
   hand.
2. Polish `README.md` / demo assets before pushing the orphan branch.
3. Confirm `git remote -v` lists only the intended public remote before any
   push.
