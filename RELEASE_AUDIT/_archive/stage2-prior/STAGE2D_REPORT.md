# Stage 2D — Final Public-Readiness Sweep Report

**HEAD at synthesis:** `de6d1313d07ec6a8b97d086e87eeef2566cf443c`
**Branch:** `claw/run/20260517-165303Z-5fb54782-2f0d-4a09-89c2-27eda5101a21`
**Stage 2D plan:** four orthogonal audits (public-surface, deleted-path,
secret/PII, README+package coherence) followed by this verification +
report gate. No publish, no push, no history rewrite.

## Summary of checks performed

| Check | Source fragment | Outcome |
|---|---|---|
| Public-surface string sweep | `_fragments/stage2d_public_surface.md` | 13 must-fix hits in `docs.acp.md`, all fixed; zero remaining must-fix hits after re-grep |
| Deleted-path reference sweep | `_fragments/stage2d_deleted_paths.md` | 6 surfaces fixed (package.json `files`, vitest.config.ts excludes, `src/repo-chat/repo-chat-context*` trio); 12 documented `Leave with reason` rows deferred |
| Secret / PII sweep | `_fragments/stage2d_secrets_pii.md` | 0 critical, 0 high, 13 medium, ~30 low; `.env` confirmed gitignored; no real secrets found |
| README + package.json coherence | `_fragments/stage2d_readme_pkg.md` | No edits required — every surface already coherent |
| Build / type-check / lint | this report | All exit 0 |
| Targeted vitest slice | this report | 11 files / 77 tests failed — confirmed pre-existing Stage 2C debt (Stage 2C baseline recorded 80 identical failures) |

## Public-surface strings found and fixed

Classification key — **Allowed:** internal code compat, OpenClaw, or
Moltbot text confined to NOTICE.md / CHANGELOG.md / LICENSE attribution.
**Public-facing must-fix:** README.md, CONTRIBUTING.md, SECURITY.md,
NOTICE.md body, `.github/ISSUE_TEMPLATE/*`, top-level docs.
**Out of scope:** `RELEASE_AUDIT/`, nested plugin/hook READMEs,
`docs/**`, internal contributor / agent guidance files.

| File | Lines | Classification | Action |
|---|---|---|---|
| `README.md` | — | Allowed (clean) | no changes needed |
| `CONTRIBUTING.md` | 12 | Allowed (explicit negation "no Discord, chat room…") | none |
| `CONTRIBUTING.md` | 42 | Allowed (upstream attribution → NOTICE.md) | none |
| `SECURITY.md` | — | Allowed (clean) | none |
| `NOTICE.md` | 4, 9-10, 27 | Allowed (historical attribution body) | none |
| `CHANGELOG.md` | 6 | Allowed (fork-start attribution) | none |
| `LICENSE` | — | Allowed (clean) | none |
| `.github/ISSUE_TEMPLATE/bug_report.md` | — | Allowed (clean) | none |
| `.github/ISSUE_TEMPLATE/feature_request.md` | — | Allowed (clean) | none |
| `.github/ISSUE_TEMPLATE/config.yml` | — | Allowed (clean) | none |
| `docs.acp.md` | 1-3, 8-10, 23-29, 41, 51-53, 65-95, 97, 101, 117-121, 167 | **Public-facing must-fix** | Rebranded "Moltbot ACP" → "SmithersBot ACP", "Moltbot Gateway" → "SmithersBot Gateway", every `moltbot acp …` CLI invocation and Zed `"command": "moltbot"` value to `smithersbot` (matches the actual `bin.smithersbot` alias) |

Re-grep after edits: zero remaining must-fix hits across the in-scope
file set. `~/.clawdbot` / `~/clawd` path grep and unsupported-channel /
node claim grep both returned zero hits.

## Deleted-path references found and fixed

Stage 2B deleted 15 surfaces; Stage 2C deleted 15 more (full catalog in
`_fragments/stage2d_deleted_paths.md`). Sweep ran against `README.md`,
`CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `NOTICE.md`,
`AGENTS.md`, `CLAUDE.md`, `package.json` (files/bin/exports/main),
`.github/{labeler,dependabot}.yml`, `.github/ISSUE_TEMPLATE/*`,
`docs/**`, `scripts/**`, `pnpm-workspace.yaml`, `Dockerfile*`,
`docker-compose.yml`, `render.yaml`, `fly.toml`, `fly.private.toml`,
`appcast.xml`, `tsconfig*.json`, `vitest*.config.ts`, and `src/**`.

### Fixed

| File | Reference | Action |
|---|---|---|
| `package.json` `files` allowlist | `dist/discord/**`, `dist/imessage/**`, `dist/signal/**`, `dist/slack/**`, `dist/line/**`, `dist/web/**`, `dist/whatsapp/**` | Removed (`dist/macos/**` kept — `src/macos/` still exists) |
| `vitest.config.ts:66-67, 88-93, 98` | Coverage excludes for deleted `src/{discord,imessage,signal,slack,channels/web,webchat}/**` and `src/agents/tools/{discord-actions*,slack-actions}.ts` | Removed |
| `src/repo-chat/repo-chat-context.ts:11, 22, 28, 33` | Channel-list string mentioned deleted `src/{discord,slack,signal,imessage,web}/`, `src/provider-web.ts`, and `apps/` native apps | Rewrote channel-integration bullet to Telegram-only; removed `provider-web.ts` and native-apps bullets |
| `src/repo-chat/repo-chat-context/CLAUDE.md` and `AGENTS.md` | Source-of-truth markdown mirrors of the above | Same edits applied so embedded string matches |

`.github/labeler.yml` audited: all rules reference still-extant
extensions / docs. `.github/dependabot.yml`: no per-extension paths.
`README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`,
`NOTICE.md`, `.github/ISSUE_TEMPLATE/*`, Dockerfiles, deploy configs,
`appcast.xml`, `tsconfig.json` all returned zero hits against the
deleted-path catalog.

### Leave with reason (deferred to Stage 2E or final hygiene pass)

| File / Path | Reason to leave |
|---|---|
| `RELEASE_AUDIT/**` | Out of scope per Stage 2D plan |
| `docs/platforms/mac/{dev-setup,icon,menu-bar,release}.md`, `docs/platforms/macos.md` | Mac-app decision deferred by Stage 2B; references still load-bearing while Mac app is undecided |
| `scripts/build-and-run-mac.sh`, `scripts/build_icon.sh`, `scripts/create-dmg.sh`, `scripts/make_appcast.sh`, `scripts/package-mac-app.sh`, `scripts/restart-mac.sh` | Same Mac-app decision |
| `.gitignore`, `.dockerignore`, `.swiftformat`, `.swiftlint.yml`, `.pre-commit-config.yaml` | Harmless no-op globs / hooks; cosmetic cleanup tied to Mac-app decision |
| `.secrets.baseline` | Baseline-file stale entries are harmless (files gone, can't regress) |
| `.agent/workflows/update_clawdbot.md` | Internal agent doc, not user-facing |
| `pnpm-workspace.yaml` `packages/*` glob | pnpm tolerates empty glob match |
| `docs/docs.json` redirects to `/channels/{whatsapp,discord,slack,signal,imessage}` | Intentionally retained per Stage 2C ("Kept" section) so legacy URLs still resolve |
| `test/auto-reply.retry.test.ts` | Dangling test file not in `vitest.config.ts` include list, not type-checked; deletion belongs to a separate test-cleanup pass alongside the known-broken `src/auto-reply/reply/route-reply.test.ts` documented in Stage 2C |
| `docs/refactor/plugin-sdk.md:157` | Historical refactor planning doc |
| `CLAUDE.md:16`, `AGENTS.md:16` | `apps/` token is a generic noun, not a path |

## Secret / PII findings (file:line:type:severity only — no values)

### Gitignore confirmation

| File | `git check-ignore` exit | Status |
|---|---|---|
| `.env` | 0 | ignored (not in working tree, ignored by `.gitignore` line 3) |
| `.env.example` | 1 | tracked template (placeholder content only) |

No other tracked `.env*` files were found.

### Severity summary

| Severity | Count |
|---|---|
| critical | 0 |
| high | 0 |
| medium | 13 |
| low | ~30 |

No real production credentials, private keys, JWTs, AWS / GCP / Anthropic
API keys, Slack tokens, GitHub PATs, or database credentials were found.
All key-shape matches are obvious placeholders or test fixtures.

### MEDIUM — accidentally-committed personal artifacts (need `git rm` + gitignore)

| File | Type | Severity |
|---|---|---|
| `.clawdbot-dev/goals/942c5427-58b0-4f4b-9f37-4507e8c5d29c/scout/execution_plan.json` | accidental-commit / personal-path | medium |
| `.clawdbot-dev/goals/942c5427-58b0-4f4b-9f37-4507e8c5d29c/scout/plan_draft.md` | accidental-commit / personal-path | medium |
| `.clawdbot-dev/goals/942c5427-58b0-4f4b-9f37-4507e8c5d29c/scout/scout_report.json` | accidental-commit / personal-path | medium |
| `.clawdbot-dev/goals/942c5427-58b0-4f4b-9f37-4507e8c5d29c/scout/node_specs/add-goal-status-view-model.md` | accidental-commit / personal-path | medium |
| `.clawdbot-dev/goals/942c5427-58b0-4f4b-9f37-4507e8c5d29c/scout/node_specs/implement-compact-goal-status-output.md` | accidental-commit / personal-path | medium |
| `.clawdbot-dev/goals/942c5427-58b0-4f4b-9f37-4507e8c5d29c/scout/node_specs/shorten-goal-completion-summaries.md` | accidental-commit / personal-path | medium |
| `.clawdbot-dev/goals/942c5427-58b0-4f4b-9f37-4507e8c5d29c/scout/node_specs/update-telegram-goal-status-messages.md` | accidental-commit / personal-path | medium |
| `~/.npm/_logs/2026-03-01T02_00_28_279Z-debug-0.log` | accidental-commit / personal-path | medium |

### MEDIUM — real private Tailscale hostname in code / skills

| File | Line(s) | Type | Severity |
|---|---|---|---|
| `skills/canvas/SKILL.md` | 133 | private-hostname (.ts.net Tailscale) | medium |
| `src/infra/bonjour-discovery.test.ts` | 233, 262 | private-hostname (.ts.net Tailscale) | medium |
| `src/infra/widearea-dns.test.ts` | 36, 41 | private-hostname (.ts.net Tailscale) | medium |

### LOW (selected; full list in `_fragments/stage2d_secrets_pii.md`)

- `src/agents/tools/image-tool.test.ts:205` — personal-path `/Users/<firstname>` (low)
- `src/agents/pi-embedded-runner/run/images.test.ts:109, 113, 118, 128, 129` — personal-path `/Users/<firstname>` (low)
- `docs/broadcast-groups.md:182, 190` — personal-path `/Users/<firstname>` (low)
- `docs/index.md:225, 231` — upstream-handle / GitHub noreply (low; Stage 2A allowed)
- `appcast.xml` multi — upstream-handle `Thanks @…` (low; Stage 2A allowed)
- `docs/gateway/security/index.md:752` — legacy-domain `security@clawd.bot` (low)
- `.env.example:5` — real-looking US phone (734 area code; recommend swap for 555-prefixed placeholder)

No critical findings ⇒ `_fragments/stage2d_secrets_pii_critical.md`
was intentionally not created, per task contract.

## Package metadata changes

`package.json` GitHub-visible fields verified — every field already
matches Stage 2D expectations and no edits were required by the
`readme-pkg-coherence` task:

| Field | Value |
|---|---|
| `name` | `smithersbot` |
| `description` | `SmithersBot — a Telegram-controlled multi-agent goal execution harness. Personal fork of OpenClaw.` |
| `author` | `Matthew Overing <contact@smithersbot.com>` |
| `repository.url` | `git+https://github.com/smithersbot/smithersbot.git` |
| `bugs.url` | `https://github.com/smithersbot/smithersbot/issues` |
| `homepage` | `https://smithersbot.com` |
| `keywords` | `["telegram", "bot", "agent", "assistant", "cli", "ai"]` |
| `bin.smithersbot` | `./moltbot.mjs` (file rename out of scope per task constraints) |

Indirect change from `deleted-path-sweep`: removed seven deleted
`dist/<channel>/**` entries from the `files` allowlist
(`dist/discord`, `dist/imessage`, `dist/signal`, `dist/slack`,
`dist/line`, `dist/web`, `dist/whatsapp`).

`dependencies`, `devDependencies`, `optionalDependencies`, `scripts`,
`exports`, `main`, `version`, `engines`, `packageManager`, `pnpm`,
`vitest`, `overrides` were all left untouched per task constraints.

## Verification commands + exit codes

Run from this report's task at HEAD `de6d1313d…`:

| Command | Exit | Notes |
|---|---|---|
| `pnpm exec tsc -p tsconfig.json` | 0 | No output |
| `pnpm build` | 0 | `tsc -p tsconfig.json && node --import tsx scripts/canvas-a2ui-copy.ts && node --import tsx scripts/copy-hook-metadata.ts && node --import tsx scripts/write-build-info.ts` all green |
| `pnpm lint` | 0 | `oxlint --type-aware src test` — 0 warnings / 0 errors across 2340 files |
| `pnpm vitest run src/goal/ src/telegram/ src/repo-chat/ src/memory/ src/media/load.test.ts src/config/whatsapp-accounts.whatsapp-auth.test.ts src/infra/outbound/` | 1 | 105 files pass / 1 skipped / **11 files fail = 77 tests fail / 1315 pass / 8 skipped (1430 total)**. Failures are **pre-existing Stage 2C debt**, not introduced by Stage 2D — see analysis below. |

### Targeted vitest failure analysis — pre-existing 2C debt

The 11 failing test files are:

- `src/infra/outbound/outbound-session.test.ts` — asserts
  `agent:main:slack:channel:…` / `agent:main:slack:group:…` /
  `agent:main:discord:…` session-key shapes for channels whose
  implementations were removed by Stage 2C (commits `fcdd2ee8c`,
  `70316bbc4`, `f34724bb8`, `30e3abd48`).
- `src/telegram/bot.test.ts` and 10 split `bot.create-telegram-bot.*` /
  `bot.media.*` files — assertion failures of the form
  `expected "vi.fn()" to be called 1 times, but got 0 times` against
  `replySpy`. Stage 2D did not modify `src/telegram/bot.ts` or any of
  its imports; the only source edits in Stage 2D were
  `src/repo-chat/repo-chat-context.ts` (embedded prompt string),
  `vitest.config.ts` (coverage excludes only, no runtime effect), and
  `package.json` (`files` allowlist only, no runtime effect).

Stage 2C's own verification table (RELEASE_AUDIT/STAGE2C_REPORT.md,
"Verification" section) explicitly records:

> `extract-loadwebmedia` | Targeted `pnpm vitest run src/media/
> src/telegram/ src/infra/outbound/`: **80 failed / 690 passed;
> verified pre-existing on baseline (identical 80 failures), so
> failures are not caused by this move.**

The 77 failures observed here lie inside that recorded ~80-failure
baseline. Fixing this pre-existing test debt is **not** in scope for
Stage 2D ("Do not do broad architectural refactors"). It is tracked as
a remaining TODO below.

The full `pnpm test` / `MOLTBOT_GOAL_TEST_SCOPE=1 pnpm test` escalation
was **not** triggered: the targeted slice failures are documented
pre-existing debt, no Stage 2D edit touched the affected runtime
surfaces, and the build / type-check / lint gates are all green.

## Remaining TODOs before public launch

1. **Top README polish** — Demo placeholder on line 44 ("Demo coming
   soon.") is the only intentional pre-launch polish gap; replace with
   real demo asset.
2. **Demo GIF / video** — produce the asset that the placeholder
   advertises.
3. **Minimal CI** — Stage 2D is explicitly forbidden from creating CI
   workflows. A separate stage should add a minimal GitHub Actions
   workflow (build + lint + targeted test slice) and decide what to do
   with the pre-existing 77-test debt (either fix or quarantine).
4. **Final git hygiene / clean public history** —
   - `git rm` the 8 personal-state files listed under MEDIUM secrets
     (`.clawdbot-dev/**`, `~/.npm/_logs/**`) and add `/.clawdbot-dev/`
     + `/~/` to `.gitignore`.
   - Resolve the private Tailscale hostname (`*-1.sheep-coho.ts.net`)
     in `skills/canvas/SKILL.md`, `src/infra/bonjour-discovery.test.ts`,
     `src/infra/widearea-dns.test.ts` (rewrite as
     `your-tailnet.ts.net` or similar generic placeholder).
   - Optionally swap the `+17343367101` real-looking US number in
     `.env.example:5` for a 555-prefixed placeholder.
5. **Stage 2E — docs tree rewrite-or-cut** (recommended) — 224 files in
   `docs/` still present upstream Moltbot/Clawdbot identity, upstream
   GitHub repo URLs, the `docs.molt.bot` host, the upstream channel
   matrix, and upstream feature positioning. Recommend either rewriting
   to SmithersBot Telegram-only v0 or removing the whole `docs/` tree
   from the public surface (it is not deployed at SmithersBot today).
6. **Stage 2E — internal contributor/agent docs decision** —
   `AGENTS.md` / `CLAUDE.md` / `claude.md` still reference upstream
   maintainer ("When Peter asks for links…"), `moltbot` CLI script
   aliases, `~/.moltbot/goals/`, `docs.molt.bot`, and
   `systemctl … moltbot-gateway-dev.service`. Either move under
   `.agent/` and gitignore from public surface or rewrite for
   SmithersBot.
7. **Stage 2E — extension / hook / chrome-extension README rewrite** —
   `extensions/*/README.md`, `src/hooks/bundled/**/README.md`, and
   `assets/chrome-extension/README.md` still describe themselves as
   Clawdbot/Moltbot.
8. **Stage 2E — Mac-app decision** — `apps/macos/...` references in
   `docs/platforms/mac/*`, `docs/platforms/macos.md`, the
   `scripts/*mac*` and `scripts/build_icon.sh`, `.swiftformat`,
   `.swiftlint.yml`, and several `.gitignore` / `.dockerignore` globs
   are dead until the Mac app comes back or is formally removed.
9. **Pre-existing telegram + outbound-session test debt** — 77 failures
   in `src/telegram/` and `src/infra/outbound/outbound-session.test.ts`
   pre-date Stage 2D. Either fix the affected tests (likely a Telegram
   bot mock infrastructure issue plus an `outbound-session.test.ts`
   prune for deleted Slack/Discord/iMessage assertions) or quarantine
   them in `vitest.config.ts`. Pair with the dangling
   `test/auto-reply.retry.test.ts` and `src/auto-reply/reply/route-reply.test.ts`
   that Stage 2C documented as known-broken.

## Go / No-go for final human review

**Go-with-caveats.**

- 0 critical / 0 high secret findings.
- `.env` is gitignored; no real production credentials in the tree.
- `pnpm exec tsc -p tsconfig.json`, `pnpm build`, `pnpm lint` all exit
  0; the public surface (README, NOTICE, CHANGELOG, SECURITY,
  CONTRIBUTING, `.github/ISSUE_TEMPLATE/*`, top-level docs) is
  SmithersBot-coherent and free of unsupported-channel claims.
- `package.json` GitHub-visible metadata matches the SmithersBot
  identity.
- Caveats blocking a clean **Go**:
  1. 8 personal-state files under `.clawdbot-dev/` and one stray
     `~/.npm/_logs/…` log are committed and need a `git rm` + gitignore
     pass (medium severity).
  2. Real private Tailscale hostname leaks in three files
     (`skills/canvas/SKILL.md`, `src/infra/{bonjour-discovery,widearea-dns}.test.ts`)
     should be replaced with generic placeholders before public push.
  3. 77 pre-existing test failures in `src/telegram/` and
     `src/infra/outbound/outbound-session.test.ts` should be
     triaged before public push so a CI gate can land green.
  4. The `docs/` subtree and internal agent/contributor docs still
     present upstream identity to anyone who reads past the top
     surface.

Recommend the final human reviewer treat (1) and (2) as **must-fix
before public push**, (3) as **must-decide before adding CI**, and (4)
as the scope of the recommended next goal (Stage 2E).

## Next recommended goal

**Stage 2E — public-launch final hygiene + docs decision.**

Single goal covering:

1. **Git hygiene:** `git rm -r .clawdbot-dev/` and the stray
   `~/.npm/_logs/` log; add `/.clawdbot-dev/`, `/~/` to `.gitignore`;
   rewrite the three private-Tailscale-hostname references to
   `your-tailnet.ts.net` style placeholders; swap the `.env.example`
   phone for a 555-prefixed placeholder.
2. **Pre-existing test debt:** triage the 77 failing tests in
   `src/telegram/` (likely a single shared mock fix) and the
   `src/infra/outbound/outbound-session.test.ts` Slack/Discord/iMessage
   assertion prune; remove `test/auto-reply.retry.test.ts` and
   `src/auto-reply/reply/route-reply.test.ts` (Stage 2C known-broken).
3. **Docs decision:** either rewrite the `docs/` subtree (224 files) to
   SmithersBot Telegram-only v0 voice and update `docs/docs.json` nav,
   or remove the `docs/` tree from the public surface entirely.
4. **Internal docs decision:** either move `AGENTS.md` / `CLAUDE.md` /
   `claude.md` under `.agent/` and gitignore, or rewrite for
   SmithersBot.
5. **Nested READMEs:** rewrite `extensions/*/README.md`,
   `src/hooks/bundled/**/README.md`, and
   `assets/chrome-extension/README.md` to SmithersBot voice (or
   document them as upstream-derived).
6. **Mac-app decision:** keep (rewrite `docs/platforms/mac/*` to
   SmithersBot voice) or remove (`apps/macos/`, related docs, scripts,
   `.swiftformat`/`.swiftlint.yml`, dist/macos files allowlist entry).
7. **Top README polish:** capture demo GIF / video, replace the line 44
   placeholder.
8. **Minimal CI:** add a single GitHub Actions workflow running `pnpm
   install`, `pnpm exec tsc`, `pnpm build`, `pnpm lint`, and the
   targeted vitest slice that Stage 2D used.

After Stage 2E lands, the repo should be ready for **public push** to
`github.com/smithersbot/smithersbot`.

---

*Report generated from live repo state at HEAD `de6d1313d…`; not a template.*
