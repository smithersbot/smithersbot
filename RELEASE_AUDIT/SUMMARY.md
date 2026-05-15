# Public-Release Audit — SUMMARY

Scope: Stage-1 read-only audit for a Telegram-only public v0 fork. Source docs: `brand-references.md`, `attribution-debt.md`, `keep-vs-cut.md`, `secrets-and-pii.md`, `git-hygiene.md`, `broken-public-surface.md`. Consolidated dataset: `inventory.jsonl` (218 entries).

## 1. Headline

The repo is **not ready for a public push today.** It is a working fork of upstream `moltbot/moltbot`, but it still ships with upstream identity (`SECURITY.md` contact `steipete@gmail.com`; `.github/FUNDING.yml` → `sponsors/steipete`; `CONTRIBUTING.md` named maintainers; ~350 upstream contributor avatars in `README.md`), legacy product branding (`Clawdbot`/`clawdbot`/`clawd` referenced across CLI help, docs, env-var prefixes, Docker mount paths, systemd unit names, gitignore, and a packaged `clawdbot` bin alias at `package.json:13`), out-of-scope channels (every channel besides Telegram is present in code, docs, README quick-start, and the npm `files` allowlist at `package.json:17`), and pre-fork-quality git state (legacy remote `origin → smithersbot/smithersbot.git`, 131 `claw/run/*` scratch branches, 645 remote-tracking refs across 4 remotes, a `.git` directory 227 MB on disk, a placeholder committer `123456+yourhandle@users.noreply.github.com`). On top of that there is one **architectural blocker**: cutting WhatsApp Web cleanly requires extracting `loadWebMedia` / `resolveWhatsAppAccount` / `hasAnyWhatsAppAuth` out of `src/web/*` because the Telegram path hard-imports them today (`src/telegram/send.ts:20`, `src/infra/outbound/deliver.ts:19`, `src/auto-reply/reply/commands-allowlist.ts:17`, `src/channels/plugins/directory-config.ts:6`, `src/config/plugin-auto-enable.ts:12`, `src/plugins/runtime/index.ts:113-124`). Rough effort: **multi-day, multi-PR Stage-2 program** (identity/attribution sweep + scoping cuts + small refactor + git hygiene + public-surface rewrite). Inventory severity counts: **18 blockers, 124 risks, 53 nits, 23 info.**

## 2. Blockers (must-fix before any public push)

18 blocker entries in `inventory.jsonl`. Grouped:

### 2a. Attribution / governance (6)
- `.github/FUNDING.yml:1` — sponsor link routes to `github.com/sponsors/steipete` (upstream maintainer). *Rewrite or delete.* (`attribution-debt.md`)
- `CONTRIBUTING.md:6-19,23,52` — named maintainers, Discord invite (`discord.gg/qkhbAGHRBT`), and X/Twitter handles all credit upstream. *Replace with project-governance text.* (`attribution-debt.md`)
- `NOTICE.md` — missing. MIT attribution to upstream must be preserved when README/CONTRIBUTING/SECURITY get rewritten. Fork-point cite available: `4583f886` (2026-01-29 18:53:05 +0000). *Add NOTICE.md citing upstream MIT.* (`attribution-debt.md`)
- `SECURITY.md` — security contact is `steipete@gmail.com` (personal Gmail of upstream maintainer). *Rewrite to project-owned contact.* (`attribution-debt.md`, `secrets-and-pii.md`)
- `scripts/clawtributors-map.json` — hardcoded upstream contributor map with personal emails (`steipete@gmail.com`, `sbarrios93@gmail.com`, `rltorres26+github@gmail.com`, `hixvac@gmail.com`). *Cut.* (`attribution-debt.md`)
- `scripts/update-clawtributors.ts` — hardcodes `REPO="moltbot/moltbot"` and calls gh-api to regenerate the upstream avatar grid. *Cut (or rewrite to fork repo + scrub the map).* (`attribution-debt.md`)

### 2b. Brand / surface (2)
- `README.md` — public README mixes Moltbot identity with Clawdbot/Clawd legacy names and out-of-v0 channel positioning. *Rewrite.* (`brand-references.md`)
- `docs/customer-guide.md` — customer-specific SmithersBot guide; not generic public Moltbot documentation. *Cut.* (`brand-references.md`)

### 2c. Public surface / scope (3)
- `package.json:4` — npm `description` is `"WhatsApp gateway CLI (Baileys web) with Pi RPC agent"` — does not match Telegram-only v0. *Rewrite.* (`broken-public-surface.md`)
- `package.json:17-79` — npm `files` allowlist packages non-v0 channel dist trees (`dist/discord/**`, `dist/imessage/**`, `dist/signal/**`, `dist/slack/**`, `dist/line/**`, `dist/web/**`, `dist/whatsapp/**`) plus `extensions/**`, `skills/**`, `patches/**`, `git-hooks/**`. *Remove from pack or split into internal/dev package.* (`broken-public-surface.md`)
- `README.md:62-71` — quick-start materially overstates v0 capability (advertises WhatsApp/Slack/Discord/Google Chat/Signal/iMessage/BlueBubbles/MS Teams/Matrix/Zalo/WebChat as deliverable channels). *Rewrite to Telegram-only.* (`broken-public-surface.md`)

### 2d. Git remotes (3)
- `.git/refs/remotes/openclaw` → `https://github.com/openclaw/openclaw.git` — unrelated upstream. *Drop remote before public push.* (`git-hygiene.md`)
- `.git/refs/remotes/origin` → `https://github.com/smithersbot/smithersbot.git` — legacy-brand fork. *Drop/repoint.* (`git-hygiene.md`)
- `.git/refs/remotes/personal` → `https://github.com/moocember/moltbot-private.git` — private repo. *Drop.* (`git-hygiene.md`)

### 2e. Architectural (1)
- `src/web` — WhatsApp Web (Baileys) channel. Telegram path **hard-imports** from it (`src/telegram/send.ts:20`, `src/infra/outbound/deliver.ts:19`, `src/auto-reply/reply/commands-allowlist.ts:17`, `src/channels/plugins/directory-config.ts:6`, `src/config/plugin-auto-enable.ts:12`, `src/plugins/runtime/index.ts:113-124`). *Cannot be cleanly cut until a small media helper (`src/web/media.ts`) and WA auth-config helpers are extracted to channel-agnostic locations.* (`keep-vs-cut.md`)

### 2f. Secrets / PII (3)
- `.env` — untracked local `.env` file exists at repo root; contents not inspected in Stage 1 per hard-deny. *Confirm gitignored, rotate any tokens, audit before public push.* (`secrets-and-pii.md`)
- `scripts/clawtributors-map.json` — personal Gmail addresses mapped to GitHub handles. *Rewrite/cut.* (`secrets-and-pii.md`)
- `SECURITY.md` — personal Gmail used as security contact. *Rewrite to project contact.* (`secrets-and-pii.md`)

## 3. Risks (should-fix credibility / safety)

124 risk entries; distribution: `secret_pii` 28, `keep_or_cut` 34, `public_surface` 25, `git` 13, `brand` 11, `memory_state` 7, `attribution` 6. Highlights:

### 3a. Attribution debt that misresolves on public push (`attribution-debt.md`)
- `CHANGELOG.md` — 468 PR refs (`#NNN`) and 114 `Thanks @user` lines reference upstream PR numbers and contributors; after a public push, those PR numbers will misresolve in GitHub's auto-link UI. *Add a CHANGELOG legend or rewrite history references.*
- `README.md:462-463` — "by Peter Steinberger and the community" attribution line.
- `README.md:480-510` — ~350-entry contributor avatar grid generated by `scripts/update-clawtributors.ts` against upstream.
- `README.md:467` — personal-site link `steipete.me`.
- `README.md:475-476` — Mario Zechner / pi-mono credit.
- `scripts/update-clawtributors.types.ts` — companion types file for the upstream avatar-grid generator.
- `SECURITY.md` — references upstream docs at `docs.molt.bot/gateway/security`.

### 3b. Brand drift in user-visible surfaces (`brand-references.md`)
- `package.json:13` — public `bin` exposes legacy `clawdbot` alongside `moltbot`.
- `src/cli/program/help.ts`, `src/cli/program/register.setup.ts` — CLI help still centers WhatsApp and legacy `CLAWDBOT_*` state naming; `~/.clawdbot` and `~/clawd` are documented as defaults.
- `src/config/paths.ts` — legacy `.clawdbot` state/config paths and `CLAWDBOT_*` env names remain in core config resolution.
- `.github/ISSUE_TEMPLATE/config.yml`, `feature_request.md`, `bug_report.md` — issue templates name "Clawdbot" and link `discord.gg/clawd`.
- `apps/android/README.md`, `assets/chrome-extension/README.md`, `extensions/voice-call/README.md`, `extensions/zalo/README.md`, `openclaw-starter-kit/docs/MIGRATION.md`, `docs/start/lore.md` — old-brand readmes; most of these surfaces are out of v0 anyway.

### 3c. Out-of-scope code shipping by default (`keep-vs-cut.md`)
- All `extensions/*` channel plugins except telegram (whatsapp, discord, slack, signal, imessage, line, msteams, matrix, zalo, zalouser, voice-call, bluebubbles, googlechat, mattermost, nextcloud-talk, nostr, etc.) classified **out**.
- All `src/*` channel surfaces besides `src/telegram` and shared routing (`src/channels`, `src/routing`, parts of `src/infra`) classified **out**.
- `apps/ios`, `apps/android`, `apps/macos`, `apps/shared/MoltbotKit` — out of v0.
- `Swabble/`, `smithersbot_marketing/`, `openclaw-starter-kit/` — out of v0.
- `src/web/*` — internal (WhatsApp Web/Baileys). See blocker §2e for the extraction work that must precede cutting it.

### 3d. Insecure / misleading defaults in onboarding (`broken-public-surface.md`)
- `docker-compose.yml:25` — gateway bind defaults to `lan` (publishes on host LAN, not loopback).
- `docker-compose.yml:7-27` — every operator env var uses the old-product `CLAWDBOT_*` prefix.
- `docker-compose.yml:8-10,36-38` — compose ingests `CLAUDE_AI_SESSION_KEY` / `CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE` (legacy claude-web credentials).
- `docker-compose.yml:12-13` — container mounts `~/.clawdbot` and `~/clawd`.
- `docker-setup.sh:120` — writes a `.env` file with a freshly-generated gateway token.
- `docker-setup.sh:191-194` — banner advertises WhatsApp + Discord onboarding.
- `README.md:12` — CI badge claims `moltbot/moltbot` workflow `ci.yml` exists, but `.github/workflows/` is absent on the audited branch.
- `README.md:15,24` — Discord badge and link bar surface `discord.gg/clawd` (old-product).
- `docs/install/installer.md:11`, `docs/install/index.md:15-129`, `docs/start/getting-started.md:58-76` — install bootstrap assumes `molt.bot/install.sh`, `molt.bot/install-cli.sh`, `molt.bot/install.ps1` are live (those scripts live in the sibling `../molt.bot` repo, per `CLAUDE.md`).
- `docs/start/onboarding.md:6-7,40-45` — the primary onboarding doc is the macOS-app first-run flow, a non-v0 surface.
- `docs/start/setup.md:13-15` — onboarding implies `~/.clawdbot/moltbot.json` and `~/clawd` paths.
- `docs/tools/clawdhub.md:13`, `README.md:252` — links `clawdhub.com` (old-product).

### 3e. Secrets / PII risks (`secrets-and-pii.md`)
- `AGENTS.md`, `CLAUDE.md` — repo guidance documents private 1Password vault path for npm OTP and private operator targets (`exe.dev`, `flawd-bot`).
- `apps/ios/fastlane/.env.example`, `apps/ios/fastlane/Fastfile`, `apps/ios/fastlane/SETUP.md`, `apps/ios/project.yml` — Apple signing/upload credential surfaces. (Out of v0 anyway, but should not ship in public pack.)
- `apps/macos/Sources/Moltbot/AboutSettings.swift` — Mac app About surface exposes personal website, social handle, email.
- `apps/macos/Sources/Moltbot/LaunchAgentManager.swift`, `src/daemon/constants.ts`, `apps/shared/MoltbotKit/Sources/MoltbotKit/{InstanceIdentity.swift,GatewayTLSPinning.swift}`, `apps/ios/Sources/Gateway/GatewaySettingsStore.swift` — legacy `com.clawdbot` / `com.steipete.clawdbot` identifiers.
- `docs/automation/gmail-pubsub.md` — real-looking Gmail placeholder repeatedly used.
- `docs/index.md` — exposes personal maintainer handle and contributor Gmail.
- `docs/platforms/mac/logging.md` — links a personal `steipete.me` post.
- `extensions/bluebubbles` — fixtures contain real-looking NANP phone numbers outside reserved fictional ranges.
- `scripts/auth-monitor.sh`, `scripts/systemd/clawdbot-auth-monitor.service`, `scripts/termux-sync-widget.sh` — hardcode `/home/admin` and internal SSH targets.
- `apps/macos/Tests/.../WideAreaGatewayDiscoveryTests.swift`, `src/commands/gateway-status.test.ts`, `src/commands/health-format.test.ts`, `src/commands/doctor.warns-per-agent-sandbox-docker-browser-prune.test.ts`, `src/infra/ssh-config.test.ts`, `src/media/parse.test.ts` — test fixtures expose personal `/Users/...` paths, internal Tailscale hostnames, and personal SSH users.

### 3f. Git hygiene risks (`git-hygiene.md`)
- `.git` is **227 MB on disk** (`du -sh .git`).
- **10,385 commits** across all refs (`git log --all --oneline | wc -l`).
- **645 remote-tracking branches** — `upstream` 301, `openclaw` 292, `personal` 6, `origin` 46.
- **131 local branches** under `refs/heads/claw/run/*` (goal-run scratch).
- **7 local** `claw/<id>/*` branches outside `claw/run/*`.
- **12 'other' local refs** under `develop`, `experiment/*`, `fix/*`, `goal-*`, `integrate/*`, `preview/*`, `rescue/*`, `smithers/*` of unclear public value.
- `.git/config` — `user.email = "123456+yourhandle@users.noreply.github.com"` (placeholder) and `user.name = "M O"` (personal initials).
- Last 20 commit subjects are **20/20 auto-generated `claw: <slug>` worker artifacts** (`git log -n20 --format=%s`).
- `.gitignore` — `bin/clawdbot-mac` (line 25) and `apps/ios/Clawdbot.xcodeproj/` (lines 35-36) are stale legacy brand references.
- `.gitignore` — lockfiles `pnpm-lock.yaml` (line 7) and `bun.lock` (line 8) are ignored.

### 3g. Memory & state surfaces (`keep-vs-cut.md` Memory & state section)
- `src/memory/*`, `src/cli/memory-cli.ts`, `src/auto-reply/reply/memory-flush.ts` (and 7 sibling tests), `src/agents/{memory-search.ts,tools/memory-tool.ts}`, `src/hooks/bundled/session-memory/` — repo-tracked memory subsystem; classify against Telegram-only scope.
- `docs/concepts/memory.md` (410 lines), `docs/cli/memory.md`, `docs/experiments/research/memory.md` — extensive memory docs; some sections reference external state paths.
- `docs/reference/templates/AGENTS.md`, `AGENTS.dev.md`, `BOOTSTRAP.md`, `SOUL.md` — workspace-agent templates with memory references.

## 4. Nits (polish)

53 nit entries; distribution: `keep_or_cut` 16, `secret_pii` 10, `public_surface` 9, `git` 9, `memory_state` 6, `brand` 3. Highlights:

- `scripts/systemd/clawdbot-auth-monitor.service`/`.timer` — filenames remain clawdbot-branded while descriptions say Moltbot (`brand-references.md`).
- `src/telegram/goal-commands.test.ts` — test fixtures use SmithersBot marketing project names (`brand-references.md`).
- `.gitignore` duplicates: `.env` listed twice (lines 3, 63), `*.bun-build` thrice (lines 6, 20, 38), `apps/macos/.build/` twice (lines 21, 37), `apps/ios/fastlane/report.xml` twice (lines 49, 55) (`git-hygiene.md`).
- `.gitignore:70` — pattern `.tgz` matches only files literally named `.tgz`, not `*.tgz`.
- `.gitignore:26` — `bin/docs-list`, and `.gitignore:30` — top-level `Core/`: no obvious producer in current repo.
- `.git/stash` — `stash@{0} 'WIP on openclaw-telegram-plan-ux: 9bc87fd7b fixed CPM ordering'` — should be cleared before push.
- `assets/` — mixed assets: avatar-placeholder.svg, chrome-extension/, dmg-background*.png — should be pruned for v0.
- Many `extensions/*` plugins (copilot-proxy, diagnostics-otel, google-antigravity-auth, google-gemini-cli-auth, llm-task, lobster, memory-core, memory-lancedb, open-prose) — out of v0 by default; decide per-plugin.

## 5. Stage 2 work plan

Ordered, grouped concretely. Each item is traceable to a worker doc and the inventory.

### Group A — Identity (sets the floor for everything else)
1. Decide canonical fork identity (fork-owner name, public email, social, support channel). *Open question §6.*
2. Rewrite `SECURITY.md` contact to a project-owned email; drop or replace `docs.molt.bot/gateway/security` reference. (`SECURITY.md`)
3. Rewrite or delete `.github/FUNDING.yml` (currently `sponsors/steipete`).
4. Replace `CONTRIBUTING.md` named maintainers, Discord invite (`discord.gg/qkhbAGHRBT`), and X/Twitter handles with project-governance text. (`CONTRIBUTING.md:6-19,23,52`)
5. Fix `.git/config` committer identity (currently `123456+yourhandle@users.noreply.github.com` / `M O`).

### Group B — Attribution
1. Add a **NOTICE.md** at repo root preserving upstream MIT attribution. Cite fork-point SHA `4583f886` (2026-01-29). (`attribution-debt.md`)
2. Cut `scripts/clawtributors-map.json` and `scripts/update-clawtributors.{ts,types.ts}` (or rewrite to fork repo and scrub personal emails).
3. Replace `README.md` contributor avatar grid (`README.md:480-510`) and "by Peter Steinberger and the community" / `steipete.me` lines (`README.md:462-467`) with project-governance text.
4. Add a `CHANGELOG.md` legend or top note stating that pre-fork PR numbers and `Thanks @user` lines refer to upstream `moltbot/moltbot` history (114 lines, 468 PR refs). (`attribution-debt.md`)

### Group C — Scoping cuts (Telegram-only v0)
1. **Extract** `src/web/media.ts` (loadWebMedia) and the small WA auth-config helpers (`hasAnyWhatsAppAuth`, `resolveWhatsAppAccount`) into channel-agnostic locations under `src/media/` and `src/config/`. Update callers at `src/telegram/send.ts:20`, `src/infra/outbound/message-action-runner.ts:43`, `src/plugins/runtime/index.ts:113-124`, `src/infra/outbound/deliver.ts:19`, `src/auto-reply/reply/commands-allowlist.ts:17`, `src/channels/plugins/directory-config.ts:6`, `src/config/plugin-auto-enable.ts:12`. (`keep-vs-cut.md` §4)
2. Cut `src/web/`, `src/whatsapp/`, `src/discord/`, `src/slack/`, `src/signal/`, `src/imessage/`, `src/line/`, `src/channel-web.ts`, `src/channels/web` from the public pack and (if scope allows) from the repo.
3. Cut every `extensions/*` channel plugin except telegram from public surface (whatsapp, discord, slack, signal, imessage, line, msteams, matrix, zalo, zalouser, voice-call, bluebubbles, googlechat, mattermost, nextcloud-talk, nostr).
4. Decide per-plugin on non-channel `extensions/*` (copilot-proxy, diagnostics-otel, google-antigravity-auth, google-gemini-cli-auth, llm-task, lobster, memory-core, memory-lancedb, open-prose).
5. Cut/exclude `apps/ios`, `apps/android`, `apps/macos`, `apps/shared/MoltbotKit` from v0.
6. Cut/exclude `Swabble/`, `smithersbot_marketing/`, `openclaw-starter-kit/`, `docs/customer-guide.md` from v0.
7. Update `.github/dependabot.yml:53-97` so non-v0 surfaces (`/apps/macos`, `/apps/shared/MoltbotKit`, `/Swabble`, `/apps/android`) are no longer tracked.

### Group D — Secrets / PII
1. Confirm `.env` (untracked) is gitignored and rotate any tokens it contains; confirm `docker-setup.sh:120,156-166` `.env` write target is gitignored. (`secrets-and-pii.md`)
2. Scrub or move private operator targets out of `AGENTS.md`, `CLAUDE.md` (1Password vault path, `exe.dev`, `flawd-bot`).
3. Replace personal `/home/admin` and personal SSH targets in `scripts/auth-monitor.sh`, `scripts/systemd/clawdbot-auth-monitor.service`, `scripts/termux-sync-widget.sh`.
4. Replace personal `/Users/...` paths and internal Tailscale hostnames in test fixtures: `src/commands/gateway-status.test.ts`, `src/commands/health-format.test.ts`, `src/commands/doctor.warns-per-agent-sandbox-docker-browser-prune.test.ts`, `src/infra/ssh-config.test.ts`, `src/media/parse.test.ts`, `apps/macos/Tests/MoltbotIPCTests/WideAreaGatewayDiscoveryTests.swift`.
5. Replace real-looking Gmail placeholder in `docs/automation/gmail-pubsub.md`.
6. Replace NANP phone fixtures in `extensions/bluebubbles` with reserved fictional ranges (or cut with the channel).
7. Rewrite `apps/macos/Sources/Moltbot/AboutSettings.swift` About surface to remove personal handles (or cut with apps/macos).
8. Rename legacy launchd / IPC identifiers (`com.clawdbot`, `com.steipete.clawdbot`) in `src/daemon/constants.ts`, `apps/macos/.../LaunchAgentManager.swift`, `apps/shared/MoltbotKit/Sources/MoltbotKit/{InstanceIdentity.swift,GatewayTLSPinning.swift}`, `apps/ios/Sources/Gateway/GatewaySettingsStore.swift`.

### Group E — Git hygiene (Stage 2 candidates; **do not run in Stage 1**)
1. Drop unwanted remotes: `origin` (smithersbot/smithersbot.git), `openclaw` (openclaw/openclaw.git), `personal` (moocember/moltbot-private.git).
2. Re-point or add a new `origin` to the public fork once Group A is settled.
3. Garbage-collect `claw/run/*` (131 branches), `claw/<id>/*` (7), and the 'other' 12 local refs (develop, experiment/*, fix/*, goal-*, integrate/*, preview/*, rescue/*, smithers/*).
4. Prune `645` remote-tracking refs left over from upstream/openclaw/personal/origin.
5. Drop `stash@{0}` after confirming no needed WIP. (`git-hygiene.md`)
6. Decide if `.git` (227 MB, 10,385 commits across refs) should be repacked or replaced with a squashed public history for the v0 push.
7. Fix `.git/config` user identity for fork ownership.
8. Clean up `.gitignore`: dedupe `.env`, `*.bun-build`, `apps/macos/.build/`, `apps/ios/fastlane/report.xml`; fix `.tgz`→`*.tgz`; resolve stale `bin/clawdbot-mac`, `apps/ios/Clawdbot.xcodeproj/`, `bin/docs-list`, `Core/` patterns; revisit lockfile ignores.

Concrete shell commands for the above live under `git-hygiene.md`'s "Candidate Stage 2 commands — DO NOT RUN IN STAGE 1" heading.

### Group F — Public surface
1. Rewrite `README.md` (quick-start `:62-71`, highlights `:120,142`, link bar `:24`) to Telegram-only and drop `discord.gg/clawd`, `github.com/moltbot/nix-clawdbot`, `clawdhub.com`, ClawdHub reference.
2. Remove or replace the CI badge at `README.md:12` (no `.github/workflows/` exists on the audited branch).
3. Remove the Discord shield/community badge at `README.md:15` (Discord is non-v0 community surface).
4. Rewrite `.github/ISSUE_TEMPLATE/{bug_report.md,feature_request.md,config.yml}` — replace "Clawdbot" with "Moltbot", drop `discord.gg/clawd` and "Krill in #help".
5. Add (or document the absence of) `.github/PULL_REQUEST_TEMPLATE.md`.
6. Rewrite `docker-compose.yml` env-var prefix `CLAWDBOT_*` → `MOLTBOT_*` (or document alias); rename container mount targets `/home/node/.clawdbot` → `/home/node/.moltbot`, `/home/node/clawd` → `/home/node/moltbot`.
7. Investigate `docker-compose.yml:25` — flip default bind from `lan` to `loopback`, or document the trust model explicitly.
8. Audit `CLAUDE_AI_SESSION_KEY` / `CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE` env-var ingestion in compose (`docker-compose.yml:8-10,36-38`); confirm v0 need.
9. Rewrite `docker-setup.sh:191-194` banner to Telegram-only.
10. Rewrite `docs/start/onboarding.md` (currently macOS-app-first) to a Telegram-only CLI onboarding narrative; same for `docs/start/setup.md:13-15`.
11. Update `docs/install/installer.md`, `docs/install/index.md`, `docs/start/getting-started.md` to either confirm `molt.bot/install.sh`/`install-cli.sh`/`install.ps1` are live in `../molt.bot` for v0, or document a fallback path.
12. Replace install hero image at `README.md:4` (`docs/whatsapp-clawd.jpg` with `alt="Clawdbot"`).
13. Rewrite CLI help (`src/cli/program/help.ts`, `src/cli/program/register.setup.ts`) to drop legacy `CLAWDBOT_*`/`~/.clawdbot` references; rename core config resolution in `src/config/paths.ts`.

### Group G — Packaging
1. Rewrite `package.json:4` description for Telegram-only v0.
2. Drop legacy `clawdbot` bin alias at `package.json:13-16` (or document compat window).
3. Add `repository`, `homepage`, `bugs` keys to `package.json`.
4. Populate `package.json:150` `keywords` and `package.json:151` `author`.
5. Trim `package.json:17-79` `files` allowlist: remove `dist/discord/**`, `dist/imessage/**`, `dist/signal/**`, `dist/slack/**`, `dist/line/**`, `dist/web/**`, `dist/whatsapp/**`; reconsider `extensions/**`, `skills/**`, `patches/**`, `git-hooks/**` for public pack.
6. Confirm `Dockerfile.sandbox-browser` exposed ports (9222/5900/6080) and the sandbox image's exclusion from the v0 npm pack.

## 6. Open questions for operator

1. **Fork identity.** What is the public fork owner name, contact email, social handle, and support channel? Required to write `SECURITY.md`, `.github/FUNDING.yml`, `CONTRIBUTING.md`, `NOTICE.md`, `README.md` attribution, and `.git/config` user. (`attribution-debt.md`)
2. **CHANGELOG history.** Keep upstream changelog verbatim with a legend, or truncate to a fork-start entry? 468 PR refs and 114 `Thanks @user` lines will misresolve on a public push to a new repo. (`attribution-debt.md`)
3. **Precise merge-base.** Stage 1 captured `4583f88626f20efedc454d893afaaf898c23523b` (2026-01-29) as the most-recent shared upstream commit (read-only `git log` restricted to refs). If a precise merge-base is required for legal/notice review, run `git merge-base upstream/main HEAD` in Stage 2 — out of Stage 1 allowlist. (`attribution-debt.md`)
4. **WebChat scope.** WebChat is currently classified internal/investigate. Should the gateway control-protocol `webchat` channel constant (`src/utils/message-channel.ts:17`) ship in v0, or be hidden from public CLI surface? (`keep-vs-cut.md` §5)
5. **`src/web` extraction.** Approve the Stage-2 refactor to extract `src/web/media.ts` and the WA auth-config helpers (`hasAnyWhatsAppAuth`, `resolveWhatsAppAccount`) before cutting `src/web/*`. Without this, `src/web/` cannot be cleanly cut. (`keep-vs-cut.md` §4)
6. **Non-channel plugins.** Decide per-plugin keep/cut for: `extensions/copilot-proxy`, `extensions/diagnostics-otel`, `extensions/google-antigravity-auth`, `extensions/google-gemini-cli-auth`, `extensions/llm-task`, `extensions/lobster`, `extensions/memory-core`, `extensions/memory-lancedb`, `extensions/open-prose`. (`keep-vs-cut.md` §1)
7. **External memory/state paths.** Repo configs/docs reference external paths not crawled in Stage 1: `~/clawd/MEMORY.md`, `~/clawd/memory/YYYY-MM-DD.md`, `~/.clawdbot/memory/<agentId>.sqlite`, `~/.clawdbot/agents/<agentId>/sessions/*.jsonl`, `~/.moltbot/goals/<runId>/`. Confirm whether v0 install creates/expects these paths and whether they need rename to `~/.moltbot/...`. (`keep-vs-cut.md` Memory & state)
8. **Git history strategy.** Squash to a clean Stage-2 base, or carry the 227 MB / 10,385-commit history forward on public push? (`git-hygiene.md`)
9. **Bin alias.** Should the public `clawdbot` bin alias (`package.json:13`) be kept for a transition window, or cut immediately? (`broken-public-surface.md`)
10. **External install host (`molt.bot`).** Confirm `https://molt.bot/install.sh`, `install-cli.sh`, `install.ps1` are live in sibling `../molt.bot` repo for v0, or document a fallback. (`broken-public-surface.md`)
11. **CI badge.** README advertises `moltbot/moltbot` CI on `ci.yml@main` but `.github/workflows/` is absent on the audited branch. Restore CI in Stage 2, or remove the badge? (`broken-public-surface.md`)
12. **Untracked `.env`.** A local `.env` exists at repo root; contents were not inspected in Stage 1 per hard-deny. Confirm it is gitignored and rotate any tokens it contains. (`secrets-and-pii.md`)

Answers:
Here are my answers to the Stage 1 open questions.

1. Fork identity

Owner/name: Matthew Overing
Project name: SmithersBot
Public email: contact@smithersbot.com
X: @moovering
LinkedIn: https://linkedin.com/in/matthewovering
Website: https://smithersbot.com
Support channel: GitHub Issues only for now, no SLA
Security contact: contact@smithersbot.com

Do not add Discord or any community/support surface yet.

2. CHANGELOG history

Truncate CHANGELOG.md to a fork-start entry. Do not preserve the upstream changelog inline. Upstream provenance should live in NOTICE.md, not the main public changelog.

3. Precise merge-base

Use 4583f88626f20efedc454d893afaaf898c23523b, dated 2026-01-29, as the fork attribution point unless Stage 2 can safely verify a more precise merge-base. If verification is easy and safe, run the precise merge-base check in Stage 2 and update NOTICE.md if needed.

4. WebChat scope

WebChat is internal/dev only. Do not expose it in README, CLI docs, examples, badges, package metadata, or public v0 positioning. Keep only what is required for compile/local dev, and mark it internal.

5. src/web extraction

Approved. Extract loadWebMedia to src/media/ and move hasAnyWhatsAppAuth / resolveWhatsAppAccount to channel-agnostic config helpers before cutting src/web. After extraction, src/web should be cut from public v0 unless something still requires it.

6. Non-channel plugins

Default rule: public v0 keeps only Telegram + the goal/agent system + required memory/learning path. Everything else is out of v0 or excluded from the public pack.

Specific decisions:
- extensions/copilot-proxy: cut from v0
- extensions/diagnostics-otel: cut from v0
- extensions/google-antigravity-auth: cut from v0
- extensions/google-gemini-cli-auth: cut from v0
- extensions/llm-task: investigate; keep only if required by the goal/agent system
- extensions/lobster: cut from v0
- extensions/memory-core: investigate; keep only if required by auto-learning/memory for the demo
- extensions/memory-lancedb: cut from v0 unless memory-core requires it
- extensions/open-prose: cut from v0

7. External memory/state paths

v0 should not publicly require ~/clawd or ~/.clawdbot paths. Rename public docs/config to ~/.smithersbot where possible. If legacy compatibility is needed internally, support it silently or document it as migration-only. Do not publish docs that instruct new users to create ~/clawd or ~/.clawdbot.

8. Git history strategy

Create a clean public repo history for v0. Keep the messy private repo as source history. Public repo should start from a cleaned tree with honest NOTICE.md attribution to upstream. Do not carry the 227 MB .git directory, thousands of commits, scratch branches, or old remotes into the public proof repo.

9. Bin alias

Cut the public clawdbot bin alias immediately. Public binaries should be smithersbot only. No transition window.

10. External install host

Do not use molt.bot install URLs for v0. Use GitHub README install instructions only, with a local/source install path. Add smithersbot.com install hosting later if needed.

11. CI badge

Remove the old upstream CI badge now. Add a new SmithersBot CI badge only after a real .github/workflows/ci.yml exists and passes.

12. Untracked .env

Confirm .env is gitignored. Inspect it locally. Rotate anything sensitive if there is any chance it was ever committed or copied. Do not ship .env. Keep only a sanitized .env.example with fake reserved placeholders.

Now please produce the Stage 2 cleanup goal prompt. It should be execution-oriented, but should still avoid dangerous irreversible operations unless explicitly gated. Group work by the audit’s themes: Identity, Attribution, Scoping cuts, Secrets/PII, Git hygiene, Public surface, and Packaging.

### Verbatim parse-failure lines from `_fragments/_parse-failures.txt`

Per spec these are included verbatim. **All 84 lines are markdown table rows and prose from `broken-public-surface.md`** (no information loss — the source doc is the canonical record, and the corresponding inventory entries exist in `inventory-W6.jsonl`). Included here only because the W7 consolidator's jsonl-block scanner picked them up while reading the doc. **No action required** beyond confirming the synthesis used `broken-public-surface.md` directly (it did).

```text
# Broken Public Surface Audit
## Section 1: package.json metadata audit
Evidence source: `package.json`.
| Field | Evidence | Finding | Recommended action |
| --- | --- | --- | --- |
| `name` | `package.json:2` = `moltbot` | Current package name matches the v0 public project identity. | Keep |
| `description` | `package.json:4` = `WhatsApp gateway CLI (Baileys web) with Pi RPC agent` | Stale and out of v0: public v0 is Telegram-only, while the npm description leads with WhatsApp/Baileys and Pi RPC. | Rewrite |
| `version` | `package.json:3` = `2026.1.29` | Present. No read-only evidence here that it is stale. | Keep |
| `keywords` | `package.json:150` = `[]` | Empty keywords reduce package discoverability and do not communicate Telegram-only v0 positioning. | Rewrite |
| `author` | `package.json:151` = `""` | Empty author/governance metadata is incomplete for a public package. | Rewrite |
| `repository` | No `repository` key found by `rg -n 'repository' package.json`. | Missing repository metadata for npm/GitHub users. | Add |
| `homepage` | No `homepage` key found by `rg -n 'homepage' package.json`. | Missing homepage metadata. | Add or intentionally omit after public surface decision |
| `bugs` | No `bugs` key found by `rg -n 'bugs' package.json`. | Missing issue tracker metadata. | Add |
| `license` | `package.json:152` = `MIT` | Present. | Keep |
| `engines` | `package.json:153-154` requires Node `>=22.12.0`. | Present and consistent with repo guidance that Node 22+ is baseline. | Keep |
| `bin` | `package.json:13-16` exposes `moltbot` and legacy `clawdbot`. | Public install still exposes old-product `clawdbot` binary. | Rewrite or cut legacy alias before public v0 |
| `files` | `package.json:17-79` includes `dist/discord/**`, `dist/imessage/**`, `dist/signal/**`, `dist/slack/**`, `dist/line/**`, `dist/web/**`, `dist/whatsapp/**`, `extensions/**`, `skills/**`, `patches/**`, and `git-hooks/**`. | Package allowlist includes many non-v0 channels and development/plugin surfaces; public v0 ships Telegram only. | Cut from public pack or split into internal/dev package |
| `files` | `package.json:63` includes `README-header.png`. | Present as packaged asset. No issue found in this slice. | Keep |
## Section 2: README.md badges and shields
Evidence sources: `README.md`; workflow check command output: `find .github/workflows -maxdepth 2 -type f` returned `find: '.github/workflows': No such file or directory`.
| README line | Badge/shield URL | Claims | Underlying file/workflow exists? | Recommended action |
| --- | --- | --- | --- | --- |
| `README.md:12` | `https://img.shields.io/github/actions/workflow/status/moltbot/moltbot/ci.yml?branch=main&style=for-the-badge` | CI status for `moltbot/moltbot` workflow `ci.yml` on `main`. | No. `.github/workflows` directory is absent, so `.github/workflows/ci.yml` is not present. | Remove badge or add the workflow in Stage 2 |
| `README.md:13` | `https://img.shields.io/github/v/release/moltbot/moltbot?include_prereleases&style=for-the-badge` | Latest GitHub release for `moltbot/moltbot`. | Not a workflow-backed badge; no local file needed. | Keep if releases are public; otherwise investigate before launch |
| `README.md:14` | `https://img.shields.io/badge/DeepWiki-moltbot-111111?style=for-the-badge` | DeepWiki page for `moltbot`. | Not a workflow-backed badge; no local file needed. | Investigate whether DeepWiki should be part of public v0 surface |
| `README.md:15` | `https://img.shields.io/discord/1456350064065904867?label=Discord&logo=discord&logoColor=white&color=5865F2&style=for-the-badge` | Discord community/server. | Not a workflow-backed badge; no local file needed. | Investigate for Telegram-only v0; likely remove or replace with v0 support channel |
| `README.md:16` | `https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge` | MIT license. | `LICENSE` is referenced by the surrounding link at `README.md:16`; license file existence is handled in attribution audit. | Keep |
## Section 3: Issue/PR templates
Evidence sources: `find .github -maxdepth 3 -type f` listed `.github/dependabot.yml`, `.github/ISSUE_TEMPLATE/config.yml`, `.github/ISSUE_TEMPLATE/feature_request.md`, `.github/ISSUE_TEMPLATE/bug_report.md`, `.github/actionlint.yaml`, `.github/FUNDING.yml`, `.github/labeler.yml`. A second pass for `pull_request_template*` / `*pull*` / `*PR*` under `.github/` returned no matches.
| Path | Finding | Recommended action |
| --- | --- | --- |
| `.github/ISSUE_TEMPLATE/config.yml:3-8` | Both contact links point to `https://discord.gg/clawd` and reference "Clawdbot" and "Krill in #help" — old-product brand + non-v0 (Discord) support surface for a Telegram-only public v0. | Rewrite to project-governance contact (Telegram support channel or GitHub Discussions); drop old-product/Krill references |
| `.github/ISSUE_TEMPLATE/feature_request.md:3` (`about: Suggest an idea or improvement for Clawdbot.`) | Template still names the old product. | Rewrite to "Moltbot" |
| `.github/ISSUE_TEMPLATE/feature_request.md:12` (`What would you like Clawdbot to do?`) | Old-product brand in template body. | Rewrite to "Moltbot" |
| `.github/ISSUE_TEMPLATE/bug_report.md:3` (`about: Report a problem or unexpected behavior in Clawdbot.`) | Template still names the old product. | Rewrite to "Moltbot" |
| `.github/ISSUE_TEMPLATE/bug_report.md:23` (`- Clawdbot version:`) | Bug environment field hardcodes the old-product name. | Rewrite to "Moltbot version:" |
| `.github/PULL_REQUEST_TEMPLATE.md` | Missing — no PR template found under `.github/` (no `pull_request_template*` matches). | Investigate: add a project-governance PR template (test plan + changelog reminder) or document the intentional absence |
| `.github/dependabot.yml:53-97` | Dependabot updates configured for non-v0 surfaces: `/apps/macos`, `/apps/shared/MoltbotKit`, `/Swabble`, `/apps/android`. | Cut from v0 dependabot config or move to internal-only branch (per W3 keep-vs-cut, apps/* and Swabble are out of v0) |
## Section 4: Docker defaults
Evidence sources: `docker-compose.yml`, `Dockerfile`, `Dockerfile.sandbox`, `Dockerfile.sandbox-browser`, `docker-setup.sh`, `scripts/e2e/Dockerfile`.
| Surface | Evidence | Finding | Recommended action |
| --- | --- | --- | --- |
| docker-compose.yml service names | `docker-compose.yml:2` (`moltbot-gateway`), `:30` (`moltbot-cli`) | Service names use current brand `moltbot-*`. | Keep |
| docker-compose.yml image default | `docker-compose.yml:3` and `:31` use `${CLAWDBOT_IMAGE:-moltbot:local}` | Image tag default is current-brand but the env-var prefix is `CLAWDBOT_*` (old-product). | Rewrite env-var prefix to `MOLTBOT_*` (or document alias) |
| docker-compose.yml env-var prefix | `docker-compose.yml:7,12,13,15,16,25,27` (`CLAWDBOT_GATEWAY_TOKEN`, `CLAWDBOT_CONFIG_DIR`, `CLAWDBOT_WORKSPACE_DIR`, `CLAWDBOT_GATEWAY_PORT`, `CLAWDBOT_BRIDGE_PORT`, `CLAWDBOT_GATEWAY_BIND`) | All operator-facing env vars carry the old-product `CLAWDBOT_*` prefix; same prefix is repeated across `docker-setup.sh:7-46,155-166` and Dockerfile build arg `CLAWDBOT_DOCKER_APT_PACKAGES` (`Dockerfile:11-17,170`). | Rewrite to `MOLTBOT_*` prefix; provide compatibility alias only if needed |
| docker-compose.yml bind addresses | `docker-compose.yml:25` sets gateway bind default to `lan` via `${CLAWDBOT_GATEWAY_BIND:-lan}` | `lan` bind exposes the gateway on the host's LAN interface by default (not loopback). For a public v0 default, this is an insecure default that contradicts README "Default behavior" / pairing guidance. | Investigate: switch compose default to `loopback` and require explicit opt-in for `lan`; or keep `lan` and document the trust model |
| docker-compose.yml exposed ports | `docker-compose.yml:14-16` publishes `${CLAWDBOT_GATEWAY_PORT:-18789}` and `${CLAWDBOT_BRIDGE_PORT:-18790}` to the host | Two host ports are published by default; the bridge port (18790) is published unconditionally even when not in use. | Investigate: scope port publishing to required v0 ports only; document the bridge port purpose |
| docker-compose.yml mount targets | `docker-compose.yml:12-13` mounts `${CLAWDBOT_CONFIG_DIR}:/home/node/.clawdbot` and `${CLAWDBOT_WORKSPACE_DIR}:/home/node/clawd` | Container paths are `/home/node/.clawdbot` and `/home/node/clawd` (old-product). | Rewrite to `/home/node/.moltbot` and `/home/node/moltbot` (or document keep) |
| docker-compose.yml claude env vars | `docker-compose.yml:8-10,36-38` (`CLAUDE_AI_SESSION_KEY`, `CLAUDE_WEB_SESSION_KEY`, `CLAUDE_WEB_COOKIE`) | Compose service ingests claude.ai session cookies/keys directly into the container via env. This is an upstream-relevant credential surface; flag for review before public v0. | Investigate: confirm whether these legacy claude-web env vars are still required for v0 and document; otherwise drop |
| Dockerfile root user during build | `Dockerfile:1-31` runs as root for `apt-get`/`pnpm install`/`pnpm build`; `:38` switches to `USER node` only for runtime CMD. | Build-time root is standard; runtime non-root `USER node` is good. No insecure default. | Keep |
| Dockerfile.sandbox-browser exposed ports | `Dockerfile.sandbox-browser:26` `EXPOSE 9222 5900 6080` | Sandbox-browser image exposes Chromium CDP (9222), VNC (5900), and noVNC (6080). Per `docs/install/docker.md:251-253`, the default sandbox `network` is `none`, so ports are not published by default; still worth flagging as a sandbox-only image, not a v0 surface. | Investigate: confirm sandbox image is excluded from v0 pack (per W6 §1, `dist/` is in `files`; Dockerfile.sandbox-browser is not packed via npm) |
| docker-setup.sh CLI banner | `docker-setup.sh:191-194` prints onboarding hints for "WhatsApp (QR)", "Telegram (bot token)", "Discord (bot token)", and links to `https://docs.molt.bot/providers` | Banner advertises non-v0 channels (WhatsApp, Discord) and references an external docs URL. v0 is Telegram-only. | Rewrite to Telegram-only banner; verify `docs.molt.bot/providers` URL classification (see §6) |
| docker-setup.sh gateway bind default | `docker-setup.sh:31` defaults `CLAWDBOT_GATEWAY_BIND` to `lan` | Same `lan` default as docker-compose; reinforces the insecure-default concern. | Same as compose-file row above |
| docker-setup.sh .env write | `docker-setup.sh:120,156-166` writes operator config (incl. `CLAWDBOT_GATEWAY_TOKEN`) to `$ROOT_DIR/.env` | Setup writes a `.env` file containing a freshly generated gateway token. Repo `.env*` is hard-denied (W4); make sure `.env` is gitignored before public release. | Fix: confirm `.env` is in `.gitignore` and add explicit setup banner warning |
| scripts/e2e/Dockerfile branding | `scripts/e2e/Dockerfile:14` copies `extensions/memory-core` | E2E image hard-codes a single extension path; fine if memory-core is in v0, otherwise update when scope changes. | Investigate against W3 keep-vs-cut classification of extensions/memory-core |
## Section 5: Install/onboarding surfaces
Evidence sources: `README.md` quick-start blocks, `docs/install/index.md`, `docs/install/installer.md`, `docs/install/docker.md`, `docs/start/getting-started.md`, `docs/start/setup.md`, `docs/start/onboarding.md`.
External services / URLs assumed by install + onboarding (string-only inventory; URL classification details land in §6):
| Source | External service or URL referenced | Notes |
| --- | --- | --- |
| `README.md:24` | `https://molt.bot`, `https://docs.molt.bot`, `https://docs.molt.bot/start/getting-started`, `https://docs.molt.bot/install/updating`, `https://docs.molt.bot/start/showcase`, `https://docs.molt.bot/start/faq`, `https://docs.molt.bot/start/wizard`, `https://github.com/moltbot/nix-clawdbot`, `https://docs.molt.bot/install/docker`, `https://discord.gg/clawd` | Top-of-README link bar mixes current-project (`molt.bot`, `github.com/moltbot/*`) with old-product (`discord.gg/clawd`, `nix-clawdbot`). |
| `README.md:31-32` | `https://www.anthropic.com/`, `https://openai.com/` | Onboarding assumes external OAuth subscriptions (Anthropic Pro/Max, OpenAI/Codex). |
| `README.md:46-49` | `npm install -g moltbot@latest`, `pnpm add -g moltbot@latest`, `moltbot onboard --install-daemon` | Quick start assumes the npm registry hosts `moltbot@latest`; this is the public release target. |
| `README.md:89` | `https://github.com/moltbot/moltbot.git` | From-source clone target. Current-project. |
| `README.md:130` | `https://api.star-history.com/svg?repos=moltbot/moltbot&...` | External Star History badge service. |
| `README.md:4` | `https://raw.githubusercontent.com/moltbot/moltbot/main/docs/whatsapp-clawd.jpg` | Hero image hosted from `moltbot/moltbot`; filename and `alt="Clawdbot"` still carry old-product brand. |
| `docs/install/index.md:15,20,43,49,57,126,129` | `https://molt.bot/install.sh`, `https://molt.bot/install.ps1` | Curl/iwr install bootstrap assumes `molt.bot` hosts `install.sh`/`install.ps1`. CLAUDE.md notes these scripts live in sibling repo `../molt.bot`; downtime/404 blocks new installs. |
| `docs/install/installer.md:11-15` | `https://molt.bot/install.sh`, `https://molt.bot/install-cli.sh`, `https://molt.bot/install.ps1` | Three installer endpoints assumed live on `molt.bot`. |
| `docs/install/installer.md:31-44` | `https://bun.sh/install`, npm registry, NodeSource, Homebrew | Installer assumes external package-manager registries. |
| `docs/install/docker.md:35-67,193` | Docker Hub / Docker registry implied via `docker build`/`docker compose`; `docs.molt.bot/providers` | Docker quick-start assumes Docker daemon; provider docs URL. |
| `docs/install/docker.md:189` | `https://docs.molt.bot/providers` | Linked provider docs. |
| `docs/install/index.md:91,135` | `https://github.com/moltbot/moltbot.git` | From-source path. |
| `docs/start/getting-started.md:48` | `https://api.search.brave.com/` (implied) — Brave Search API key, configured via `moltbot configure --section web` | Recommends external Brave Search API key for web tools. |
| `docs/start/getting-started.md:50` | `https://semgrep.dev` | Recommends external Semgrep install for SAST. |
| `docs/start/getting-started.md:58,66,72,76` | `https://molt.bot/install.sh`, `https://molt.bot/install.ps1`, `npm install -g moltbot@latest`, `pnpm add -g moltbot@latest` | Same install bootstrap dependencies as README. |
| `docs/start/getting-started.md:88-92` | OAuth flows for OpenAI Codex and Anthropic API keys; mention of `claude setup-token` | Assumes external OAuth + Anthropic Console access. |
| `docs/start/getting-started.md:170` | `https://github.com/moltbot/moltbot.git` | From-source clone. |
| `docs/start/setup.md:13-15` | Implies `~/.clawdbot/moltbot.json` config path and `~/clawd` workspace path | Onboarding config paths still rooted at `.clawdbot` / `clawd` (old-product). Not an external service but a public-surface inconsistency. |
| `docs/start/onboarding.md:45,87-89,100-101` | `~/.clawdbot/credentials/oauth.json`, `moltbot webhooks gmail setup`, Gmail Pub/Sub setup | macOS app onboarding assumes Anthropic OAuth and (optionally) Gmail Pub/Sub — both non-v0 for a Telegram-only public v0. |
| `docs/start/onboarding.md:6-7,40-45` | "macOS app" — non-v0 surface | macOS-app first-run onboarding doc is the primary onboarding narrative; v0 is CLI/Telegram-only per scope assumption. |
Cross-cutting findings:
- README quick-start (`README.md:62-71`) advertises sending to `+1234567890` and mentions WhatsApp/Telegram/Slack/Discord/Google Chat/Signal/iMessage/BlueBubbles/Microsoft Teams/Matrix/Zalo/Zalo Personal/WebChat as deliverable channels. v0 is Telegram-only; the README quick-start materially overstates v0 capability.
- README highlights (`README.md:120,142`) enumerate every channel as a current feature; same issue.
- The whole install bootstrap chain (`molt.bot/install.sh` → `npm install -g moltbot@latest` → `moltbot onboard --install-daemon`) depends on three external services being live: `molt.bot` host, npmjs registry, and (for OAuth) Anthropic/OpenAI. Document the dependency chain or pin a fallback path.
```

## 7. Counts

Computed from `RELEASE_AUDIT/inventory.jsonl` (218 entries).

### By severity

| Severity | Count |
| --- | --- |
| blocker | 18 |
| risk | 124 |
| nit | 53 |
| info | 23 |
| **Total** | **218** |

### By category

| Category | Count |
| --- | --- |
| attribution | 14 |
| brand | 18 |
| git | 28 |
| keep_or_cut | 62 |
| memory_state | 17 |
| public_surface | 38 |
| secret_pii | 41 |
| **Total** | **218** |

### Category × Severity

| Category | blocker | risk | nit | info |
| --- | --- | --- | --- | --- |
| attribution | 6 | 6 | 0 | 2 |
| brand | 2 | 11 | 3 | 2 |
| git | 3 | 13 | 9 | 3 |
| keep_or_cut | 1 | 34 | 16 | 11 |
| memory_state | 0 | 7 | 6 | 4 |
| public_surface | 3 | 25 | 9 | 1 |
| secret_pii | 3 | 28 | 10 | 0 |

### By action

| Action | Count |
| --- | --- |
| cut | 57 |
| fix | 9 |
| investigate | 63 |
| keep | 16 |
| remove_from_pack | 11 |
| rewrite | 62 |

### By v0_scope

| v0_scope | Count |
| --- | --- |
| in | 57 |
| internal | 14 |
| investigate | 41 |
| out | 106 |
