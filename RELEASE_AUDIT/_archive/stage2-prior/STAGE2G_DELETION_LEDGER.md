# Stage 2G Deletion Ledger

Companion to [RELEASE_AUDIT/STAGE2G_REPORT.md](./STAGE2G_REPORT.md).
Every row cites the evidence section in
[RELEASE_AUDIT/STAGE2G_EVIDENCE.md](./STAGE2G_EVIDENCE.md) that
justified the action. "Tests run" is the verification command(s) that
were executed in the commit that performed the action; the full final
gate is recorded in the report.

Action key:
- **DELETE** — `git rm` (file/dir no longer on disk).
- **QUARANTINE** — `git mv` to a `_deferred/` location (file on disk,
  excluded from default workspace/package/test surface).
- **SKIP** — `it.skip` marker applied to a test assertion in place.

## Track C — Root Scratch Artifacts (commit `ceaef63bf`)

| Path | Action | Why | Evidence | Tests run | Future risk |
| --- | --- | --- | --- | --- | --- |
| `.tmp-goal-tests/` | DELETE | Goal-test scratch dir tracked by accident. | n/a (operator-listed candidates) | `pnpm exec tsc -p tsconfig.json` | None — regenerated locally as needed. |
| `.moltbot-goal-worker-results/cli-worker-result-*` | DELETE | Stale worker-result fixtures from prior runs. | n/a | tsc | None — recreated by goal runs. |
| `.pnpm-store/v22.22.0-x64-9de703df-1000/*` | DELETE | pnpm content-addressable cache tracked by accident. | n/a | tsc | None — recreated on `pnpm install`. |
| `README-header.png` | DELETE | Unused header image (no README reference). | n/a | tsc | None — README does not embed it. |
| `assets/dmg-background.png` | DELETE | Mac DMG installer artifact (Mac app removed in Stage 2E). | n/a | tsc | None — DMG pipeline gone. |
| `assets/dmg-background-small.png` | DELETE | Same. | n/a | tsc | None. |
| `blocking-test.txt` | DELETE | Scratch file. | n/a | tsc | None. |
| `fish.txt` | DELETE | Scratch file. | n/a | tsc | None. |
| `hello.txt` | DELETE | Scratch file. | n/a | tsc | None. |

`.gitignore` was updated in the same commit so the scratch patterns
cannot return.

## Track D — Unsupported Deploy Surfaces (commit `af0039776`)

| Path | Action | Why | Evidence | Tests run | Future risk |
| --- | --- | --- | --- | --- | --- |
| `Dockerfile` | DELETE | Root Docker image not part of v0 deploy story. | EVIDENCE §7a | tsc, `pnpm build`, `pnpm lint` | Need a fresh deploy doc if Docker support returns. |
| `docker-compose.yml` | DELETE | Compose stack not supported for v0. | EVIDENCE §7a | tsc, build, lint | Same as above. |
| `docker-setup.sh` | DELETE | Compose helper for the removed compose file. | EVIDENCE §7a | tsc, build, lint | None. |
| `fly.toml` | DELETE | Fly.io manifest; v0 has no hosted/SaaS story. | EVIDENCE §7a | tsc, build, lint | Restart from scratch if Fly deploy returns. |
| `fly.private.toml` | DELETE | Private Fly manifest. | EVIDENCE §7a | tsc, build, lint | None. |
| `render.yaml` | DELETE | Render manifest. | EVIDENCE §7a | tsc, build, lint | None. |
| `scripts/docker/cleanup-smoke/` | DELETE | Docker smoke harness for removed deploy stack. | EVIDENCE §7b | tsc, build, lint | None. |
| `scripts/docker/install-sh-e2e/` | DELETE | Same. | EVIDENCE §7b | tsc, build, lint | None. |
| `scripts/docker/install-sh-nonroot/` | DELETE | Same. | EVIDENCE §7b | tsc, build, lint | None. |
| `scripts/docker/install-sh-smoke/` | DELETE | Same. | EVIDENCE §7b | tsc, build, lint | None. |
| `scripts/test-cleanup-docker.sh` | DELETE | Wrapper for a removed harness. | EVIDENCE §7b | tsc, build, lint | None. |
| `scripts/test-install-sh-docker.sh` | DELETE | Same. | EVIDENCE §7b | tsc, build, lint | None. |
| `scripts/test-install-sh-e2e-docker.sh` | DELETE | Same. | EVIDENCE §7b | tsc, build, lint | None. |
| `scripts/test-live-gateway-models-docker.sh` | DELETE | Same. | EVIDENCE §7b | tsc, build, lint | None. |
| `scripts/test-live-models-docker.sh` | DELETE | Same. | EVIDENCE §7b | tsc, build, lint | None. |
| `scripts/e2e/Dockerfile` | DELETE | Same. | EVIDENCE §7b | tsc, build, lint | None. |
| `scripts/e2e/Dockerfile.qr-import` | DELETE | Same. | EVIDENCE §7b | tsc, build, lint | None. |
| `scripts/e2e/doctor-install-switch-docker.sh` | DELETE | Same. | EVIDENCE §7b | tsc, build, lint | None. |
| `scripts/e2e/gateway-network-docker.sh` | DELETE | Same. | EVIDENCE §7b | tsc, build, lint | None. |
| `scripts/e2e/onboard-docker.sh` | DELETE | Same. | EVIDENCE §7b | tsc, build, lint | None. |
| `scripts/e2e/plugins-docker.sh` | DELETE | Same. | EVIDENCE §7b | tsc, build, lint | None. |
| `scripts/e2e/qr-import-docker.sh` | DELETE | Same. | EVIDENCE §7b | tsc, build, lint | None. |
| `scripts/systemd/clawdbot-auth-monitor.service` | DELETE | Old clawdbot naming, unrelated to v0. | EVIDENCE §7b | tsc, build, lint | None. |
| `scripts/systemd/clawdbot-auth-monitor.timer` | DELETE | Same. | EVIDENCE §7b | tsc, build, lint | None. |
| `scripts/auth-monitor.sh` | DELETE | Paired with the removed systemd unit. | EVIDENCE §7b | tsc, build, lint | None. |
| `scripts/claude-auth-status.sh` | DELETE | Closed auth-monitor cluster. | EVIDENCE §7b | tsc, build, lint | None. |
| `scripts/clawlog.sh` | DELETE | Clawdbot-era log helper. | EVIDENCE §7b | tsc, build, lint | None. |
| `scripts/customer-setup.sh` | DELETE | Hosted/SaaS-flavored helper not in v0. | EVIDENCE §7b | tsc, build, lint | None. |
| `scripts/mobile-reauth.sh` | DELETE | Termux/mobile auth cluster (closed). | EVIDENCE §7b | tsc, build, lint | None. |
| `scripts/setup-auth-system.sh` | DELETE | Same. | EVIDENCE §7b | tsc, build, lint | None. |
| `scripts/termux-auth-widget.sh` | DELETE | Same. | EVIDENCE §7b | tsc, build, lint | None. |
| `scripts/termux-quick-auth.sh` | DELETE | Same. | EVIDENCE §7b | tsc, build, lint | None. |
| `scripts/termux-sync-widget.sh` | DELETE | Same. | EVIDENCE §7b | tsc, build, lint | None. |
| `src/docker-setup.test.ts` | DELETE | Tested the deleted `docker-setup.sh`. | EVIDENCE §7c | tsc, build, lint | None. |
| `package.json` `test:docker:*` / `test:install:*` / `test:all` scripts (14) | EDIT | Pointed at deleted harnesses. | EVIDENCE §7c | tsc, build, lint | None. |
| `.github/labeler.yml` docker block | EDIT | Narrowed to still-present deferred sandbox paths. | EVIDENCE §7c | tsc, build, lint | None. |

Deferred in the same commit (kept because v0 sandbox / gateway-restart
flows still reference them): `Dockerfile.sandbox`,
`Dockerfile.sandbox-browser`, `.dockerignore`,
`scripts/sandbox-*.sh`, `scripts/sandbox-browser-entrypoint.sh`,
`scripts/systemd/moltbot-gateway-restart.{path,service,install}`.

## Track E — Package / Workspace / Test Config Dead Refs (commit `ef2ba7ff2`)

| Path | Action | Why | Evidence | Tests run | Future risk |
| --- | --- | --- | --- | --- | --- |
| `package.json` `files[]` `README-header.png` | EDIT | Source already deleted in Track C. | EVIDENCE §8c | tsc, build, lint | None. |
| `package.json` `vitest` block (L240-267) | EDIT | Shadowed by `vitest.config.ts`, never loaded. | EVIDENCE §8m | tsc, build, lint | None. |
| `pnpm-workspace.yaml` `- packages/*` glob | EDIT | Matches zero directories on disk. | EVIDENCE §8f | tsc, build, lint | None. |
| `vitest.config.ts` `test/format-error.test.ts` include | EDIT | File does not exist. | EVIDENCE §8h | tsc, build, lint | None. |
| `vitest.e2e.config.ts` `dist/Moltbot.app/**` exclude | EDIT | Mac app removed in Stage 2E. | EVIDENCE §8h | tsc, build, lint | None. |
| `vitest.live.config.ts` `dist/Moltbot.app/**` exclude | EDIT | Same. | EVIDENCE §8h | tsc, build, lint | None. |
| `vitest.unit.config.ts` orphan include | EDIT | Same. | EVIDENCE §8h | tsc, build, lint | None. |

## Track F — Non-v0 Extensions (commit `8791b8a40`)

| Path | Action | Why | Evidence | Tests run | Future risk |
| --- | --- | --- | --- | --- | --- |
| `extensions/matrix/` | QUARANTINE → `extensions/_deferred/matrix/` | Non-v0 channel; only ref was a dispatch case string in `src/infra/outbound/outbound-session.ts` (now a dead route, no crash). | EVIDENCE §4 | tsc, build, lint, `pnpm vitest run extensions/telegram/ extensions/memory-core/` | Restoring requires re-enabling workspace/package globs. |
| `extensions/nextcloud-talk/` | QUARANTINE | Same. | EVIDENCE §4 | same | Same. |
| `extensions/nostr/` | QUARANTINE | Same. | EVIDENCE §4 | same | Same. |
| `extensions/tlon/` | QUARANTINE | Same. | EVIDENCE §4 | same | Same. |
| `extensions/zalouser/` | QUARANTINE | Same. | EVIDENCE §4 | same | Same. |
| `pnpm-workspace.yaml` extension globs | EDIT | Narrowed to telegram + memory-core. | EVIDENCE §8f | same | None. |
| `package.json` extension entries | EDIT | Narrowed to telegram + memory-core. | EVIDENCE §8c | same | None. |
| `vitest.config.ts` extensions exclude | EDIT | Added `extensions/_deferred/**`. | EVIDENCE §8h | same | None. |
| `extensions/telegram/index.test.ts` | ADD | Smoke test asserting v0 extension index loads. | EVIDENCE §4 (keep row) | same | None. |
| `extensions/memory-core/index.test.ts` | ADD | Same. | EVIDENCE §4 (keep row) | same | None. |

Deferred extensions (still in `extensions/` because removal needs a
coupled refactor): `googlechat`, `bluebubbles`, `mattermost`,
`msteams`, `voice-call`, `zalo`, `copilot-proxy`,
`google-antigravity-auth`, `google-gemini-cli-auth`,
`qwen-portal-auth`.

## Track G — Non-v0 Skills (commit `a88a6c5dd`)

Every skill in `skills/` was audited; no concrete v0 runtime importer
exists. Decisions split into delete (39) and quarantine (9). The
table below groups by action to keep the ledger readable. Each row
maps back to `STAGE2G_EVIDENCE.md` section 5.

| Action | Paths | Why | Tests run | Future risk |
| --- | --- | --- | --- | --- |
| DELETE (39) | personal-productivity, device-specific, and third-party-service skills enumerated in EVIDENCE §5 (apple-notes, things-mac, sonoscli, notion-style skills, etc.) | No v0 runtime consumer; bundled-dir discovery walks the directory generically, so removal eliminates dead listings rather than breaking imports. | tsc, build, lint, `pnpm vitest run src/agents/skills*.test.ts` | None — re-add from upstream if revisited. |
| QUARANTINE (9) → `skills/_deferred/` | coding-agent, session-logs, skill-creator, and the borderline-useful skills enumerated in EVIDENCE §5 | Plausibly useful in a later operator workflow; quarantining preserves the source while removing it from the public package allowlist. | same | Restoring requires re-adding to `package.json` `files[]`. |
| `package.json` `files[]` `skills/**` | EDIT → narrowed to `skills/bluebubbles/**`, `skills/peekaboo/**`, `skills/voice-call/**` | Three deferred public skill dirs remain (paired with matching extension or soft-skip test); rest now hidden. | same | None. |
| `src/agents/skills.build-workspace-skills-prompt.*` summarize fixture | DELETE | Test asserted against a deleted bundled skill. | same | None. |

## Track H — Unsupported CLI Subcommands (commit `59e00eb64`)

All eight rows: action **EDIT** in
`src/cli/program/register.subclis.ts` (commented out with the marker
`// Stage 2G: hidden from default CLI surface; not part of
SmithersBot v0`) and `src/cli/program/help.ts` (matching enumeration
removed). The underlying CLI source files are still on disk.

| CLI | Action | Why | Evidence | Tests run | Future risk |
| --- | --- | --- | --- | --- | --- |
| `acp` | HIDE | Not part of v0 operator surface. | EVIDENCE §9b | tsc, build, lint, `pnpm vitest run src/cli/program/ src/cli/run-main.test.ts` | None — uncomment to restore. |
| `tui` | HIDE | Same. | EVIDENCE §9b | same | None. |
| `docs` | HIDE | Same. | EVIDENCE §9b | same | None. |
| `hooks` | HIDE | Same. | EVIDENCE §9b | same | None. |
| `webhooks` | HIDE | Same. | EVIDENCE §9b | same | None. |
| `plugins` | HIDE | Same. | EVIDENCE §9b | same | None. |
| `channels` | HIDE | Same. | EVIDENCE §9b | same | None. |
| `directory` | HIDE | Same. | EVIDENCE §9b | same | None. |
| `src/cli/program.smoke.test.ts` | EDIT | Dropped asserts on hidden subcommands. | EVIDENCE §9d | same | None. |
| `src/cli/program/register.subclis.test.ts` | EDIT | Same. | EVIDENCE §9d | same | None. |
| `src/cli/program/help.ts` channels example | EDIT | Removed matching enumeration. | EVIDENCE §9c | same | None. |

Kept v0 keepers: `gateway`, `logs`, `system`, `models`, `approvals`,
`cron`, `skills`, `goal`, `setup`, `onboard`, `configure`, `memory`,
`agent`.

Deferred: `browser`, `daemon`, `nodes`, `node`, `sandbox`, `devices`,
`dns`, `pairing`, `security`, `message` (coupling to canvas-host /
sandbox / plugin registry / auto-reply). Plus `gstack` and `update`
as low-risk operator tooling.

## Track I — Browser / UI / Canvas / Vendor (commit `a7b724b8b`)

| Path | Action | Why | Evidence | Tests run | Future risk |
| --- | --- | --- | --- | --- | --- |
| `vendor/a2ui/` (entire subtree, ~45,000 LOC) | DELETE | Zero v0 importers across `src/gateway/**`, `src/infra/**`, `src/cli/**`, `src/commands/**`, `scripts/**`, `package.json`, `vitest*.config.ts`. Runtime bundle is the separate `src/canvas-host/a2ui/a2ui.bundle.js`, which is untouched. | EVIDENCE §3 | tsc, build, lint, `pnpm vitest run src/canvas-host/ src/scripts/canvas-a2ui-copy.test.ts` | If we need the upstream a2ui spec docs again, re-vendor from upstream. |
| `vitest.config.ts` / `.e2e.config.ts` / `.live.config.ts` `vendor/**` excludes | EDIT | Stale after `vendor/a2ui/` deletion. | EVIDENCE §3 | same | None. |
| `.gitignore` `vendor/a2ui/.../node_modules` rule | EDIT | Stale after deletion. | EVIDENCE §3 | same | None. |

Deferred (deletion blocked by current v0 importers — see EVIDENCE
§§1-3): `src/browser/`, `assets/chrome-extension/`,
`src/cli/browser-cli.ts`, `ui/`, `src/gateway/control-ui.ts`,
`src/canvas-host/`, `scripts/canvas-a2ui-copy.ts`,
`scripts/debug-mermaid-png.ts`, `scripts/ui.js`.

## Track J — Bundled Hooks (commit `c354899bc`)

All rows: action **QUARANTINE** — `git mv` to `src/hooks/_deferred/`.
Plan default for hooks is quarantine; no row had unambiguous evidence
for an outright delete.

| Path | Action | Why | Evidence | Tests run | Future risk |
| --- | --- | --- | --- | --- | --- |
| `src/hooks/bundled/boot-md/` | QUARANTINE → `src/hooks/_deferred/bundled/boot-md/` | No named importer in `src/hooks/loader.ts`, `src/config/`, `src/goal/`, or `src/telegram/`; only dynamic directory discovery would find it. | EVIDENCE §6 | tsc, build, lint, `pnpm vitest run src/hooks/` | Restoring requires moving back into `src/hooks/bundled/`. |
| `src/hooks/bundled/command-logger/` | QUARANTINE | Same. | EVIDENCE §6 | same | Same. |
| `src/hooks/bundled/session-memory/` | QUARANTINE | Same — and distinct from goal lessons. | EVIDENCE §6 | same | Same. |
| `src/hooks/bundled/soul-evil/` | QUARANTINE | Same. | EVIDENCE §6 | same | Same. |
| `src/hooks/soul-evil.ts` | QUARANTINE → `src/hooks/_deferred/soul-evil.ts` | Paired helper; only importer was the bundled handler and its own test. | EVIDENCE §6 | same | Same. |
| `src/hooks/soul-evil.test.ts` | QUARANTINE → `src/hooks/_deferred/soul-evil.test.ts` | Same. | EVIDENCE §6 | same | Same. |
| `src/hooks/bundled/README.md` | EDIT | Replaced with a short v0 note (was 234 lines). | EVIDENCE §6 | same | None. |

## Track K — Legacy Auto-reply Channel Tests (commit `8ea254d82`)

All rows: action **SKIP** — `it.skip(...)` with a
`// Stage 2G: legacy <channel>` comment added in place. Files
themselves stay in the default vitest include.

| Test file | Skipped assertions | Why | Tests run | Future risk |
| --- | --- | --- | --- | --- |
| `src/auto-reply/command-control.test.ts` | Discord text-command gating | Discord channel not in v0; assertion exercised removed code path. | `pnpm vitest run src/auto-reply/`, then v0 slice | None — skip markers are explicit and ungrepable as accidental holes. |
| `src/auto-reply/commands-registry.test.ts` | Text command gating for non-Telegram sources | Same. | same | None. |
| `src/auto-reply/inbound.test.ts` | Discord mention gating | Same. | same | None. |
| `src/auto-reply/reply/agent-runner-utils.test.ts` | Slack / WhatsApp tool threading metadata | Slack and WhatsApp not in v0. | same | None. |
| `src/auto-reply/reply/reply-routing.test.ts` | Slack mention / reply, iMessage direct tool threading | iMessage / Slack not in v0. | same | None. |
| `src/auto-reply/reply/session-resets.test.ts` | Slack / WhatsApp reset authorization | Same. | same | None. |

Note: this was a triage, not a code-path deletion. The corresponding
legacy implementation branches are still on disk and remain Stage 2H
or Stage 3 work.

## Track L — Final Report (this commit)

Documentation-only. No source deletions.
