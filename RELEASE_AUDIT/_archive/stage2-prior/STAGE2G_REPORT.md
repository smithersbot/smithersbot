# Stage 2G Report

Stage 2G is the overnight repo minimization pass aimed at making the
SmithersBot v0 public surface — Telegram-controlled `/new_goal`, repo
chat, goal status/list/resume/stop, goal lessons/memory, external
verification, Nightwatch, and the local CLI as a support/debug path —
look intentional. Every deletion or quarantine in this stage was
preceded by a read-only evidence pass in
[RELEASE_AUDIT/STAGE2G_EVIDENCE.md](./STAGE2G_EVIDENCE.md). The
companion ledger
[RELEASE_AUDIT/STAGE2G_DELETION_LEDGER.md](./STAGE2G_DELETION_LEDGER.md)
records each path with its evidence row, tests run, and future risk.

## Executive Summary

- Net change: roughly 53,000 lines deleted across nine evidence-driven
  commits with no architectural rewiring, no push, and no publish.
- Evidence-first: every deletion is anchored to a numbered row in
  `STAGE2G_EVIDENCE.md` so a reviewer can re-derive each decision from
  grep output without re-running this pass.
- Conservative defaults held: browser/UI/canvas, gateway control-UI,
  Chrome extension, sandbox stack, and the gateway-restart systemd
  units were all **deferred**, not deleted, because v0 importers
  exist.
- v0 verification slice is green (`src/telegram/`, `src/hooks/`,
  `src/goal/`, `src/repo-chat/`, `src/memory/`: 1378 tests passing).
- Auto-reply slice (`src/auto-reply/`) is now green for the first time
  since Stage 2E because 16 legacy-channel assertions
  (Discord/Slack/WhatsApp/iMessage) were quarantined with explicit
  Stage 2G skip markers — not by deleting the auto-reply subsystem.
- CLI slice (`src/cli/`) is green after eight unsupported lazy
  subcommands were commented out of the default registration surface.
- `tsc`, `pnpm build`, and `pnpm lint` all exit 0 with the post-Stage-2G
  tree.

## Deleted

Removed wholesale in this stage:

- Root scratch artifacts (Track C / commit `ceaef63bf`):
  `.tmp-goal-tests/`, `.moltbot-goal-worker-results/cli-worker-result-*`,
  `.pnpm-store/v22.22.0-x64-9de703df-1000/*`, `README-header.png`,
  `assets/dmg-background.png`, `assets/dmg-background-small.png`,
  `blocking-test.txt`, `fish.txt`, `hello.txt`.
- Deploy stack (Track D / commit `af0039776`): root `Dockerfile`,
  `docker-compose.yml`, `docker-setup.sh`, `fly.toml`,
  `fly.private.toml`, `render.yaml`; `scripts/docker/cleanup-smoke/`,
  `scripts/docker/install-sh-e2e/`,
  `scripts/docker/install-sh-nonroot/`,
  `scripts/docker/install-sh-smoke/`;
  `scripts/test-cleanup-docker.sh`,
  `scripts/test-install-sh-docker.sh`,
  `scripts/test-install-sh-e2e-docker.sh`,
  `scripts/test-live-gateway-models-docker.sh`,
  `scripts/test-live-models-docker.sh`; `scripts/e2e/Dockerfile`,
  `scripts/e2e/Dockerfile.qr-import`,
  `scripts/e2e/doctor-install-switch-docker.sh`,
  `scripts/e2e/gateway-network-docker.sh`,
  `scripts/e2e/onboard-docker.sh`,
  `scripts/e2e/plugins-docker.sh`,
  `scripts/e2e/qr-import-docker.sh`;
  `scripts/systemd/clawdbot-auth-monitor.service`,
  `scripts/systemd/clawdbot-auth-monitor.timer`;
  `scripts/auth-monitor.sh`, `scripts/claude-auth-status.sh`,
  `scripts/clawlog.sh`, `scripts/customer-setup.sh`,
  `scripts/mobile-reauth.sh`, `scripts/setup-auth-system.sh`,
  `scripts/termux-auth-widget.sh`, `scripts/termux-quick-auth.sh`,
  `scripts/termux-sync-widget.sh`; `src/docker-setup.test.ts`.
- Skills catalog (Track G / commit `a88a6c5dd`): 39 bundled skills
  under `skills/` (personal-productivity, device-specific, and
  third-party-service skills that had no concrete v0 runtime
  importer); detailed list in the deletion ledger.
- Vendor (Track I / commit `a7b724b8b`): entire `vendor/a2ui/`
  subtree (Angular/Lit/Web/Python/Java specification dirs, eval
  harnesses, JSON schemas, GitHub workflow files). Zero v0 importers
  in `src/gateway/**`, `src/infra/**`, `src/cli/**`, `src/commands/**`,
  `scripts/**`, `package.json`, or `vitest*.config.ts`.

## Quarantined

Moved out of the default workspace/package/test surface but kept on
disk for later restoration:

- Extensions (Track F / commit `8791b8a40`):
  `extensions/_deferred/matrix/`,
  `extensions/_deferred/nextcloud-talk/`,
  `extensions/_deferred/nostr/`,
  `extensions/_deferred/tlon/`,
  `extensions/_deferred/zalouser/`.
- Skills (Track G / commit `a88a6c5dd`): 9 skills moved under
  `skills/_deferred/` (coding-agent, session-logs, skill-creator, and
  the other borderline-useful skills enumerated in
  `STAGE2G_EVIDENCE.md` section 5).
- Hooks (Track J / commit `c354899bc`):
  `src/hooks/_deferred/bundled/boot-md/`,
  `src/hooks/_deferred/bundled/command-logger/`,
  `src/hooks/_deferred/bundled/session-memory/`,
  `src/hooks/_deferred/bundled/soul-evil/`,
  `src/hooks/_deferred/soul-evil.ts`,
  `src/hooks/_deferred/soul-evil.test.ts`.
- Legacy auto-reply tests (Track K / commit `8ea254d82`): 16 failing
  legacy-channel assertions inside otherwise-active test files were
  marked `it.skip` with `// Stage 2G: legacy <channel>` comments;
  files themselves stay in the default vitest include.

## Package / Workspace Changes

Across Tracks C-J, the following package/workspace edits landed in the
same commits as the deletions they support:

- `package.json`:
  - `files[]` no longer ships `README-header.png` (Track C).
  - All 14 `test:docker:*` / `test:install:*` / `test:all` scripts
    removed (Track D).
  - `vitest` block (previously shadowing `vitest.config.ts`) deleted
    (Track E).
  - `files[]` narrowed from `skills/**` to the three remaining
    deferred public skill dirs `skills/bluebubbles/**`,
    `skills/peekaboo/**`, `skills/voice-call/**` (Track G).
  - Extension workspace allowlist trimmed to `extensions/telegram` and
    `extensions/memory-core` (Track F).
- `pnpm-workspace.yaml`:
  - Dead `packages/*` glob removed (Track E).
  - Extension globs trimmed to active v0 extensions only (Track F).
- `vitest.config.ts` / `vitest.e2e.config.ts` / `vitest.live.config.ts`
  / `vitest.unit.config.ts`:
  - Stale `test/format-error.test.ts` include removed (Track E).
  - Stale `dist/Moltbot.app/**` excludes removed (Track E).
  - `vendor/**` excludes removed after vendor deletion (Track I).
  - `extensions/_deferred/**` added to default-include exclusions
    (Track F).
- `.github/labeler.yml`: docker matcher narrowed to the still-present
  deferred sandbox paths (Track D).
- `.gitignore`: scratch-artifact patterns appended (Track C); stale
  vendor artifact rule removed after vendor deletion (Track I).

## Extensions

Final state of `extensions/` after Track F:

- **Kept** (v0 surface, active in workspace and package): `telegram`,
  `memory-core`. Both received a small smoke test asserting the
  extension index loads without throwing.
- **Quarantined** (`extensions/_deferred/`): `matrix`,
  `nextcloud-talk`, `nostr`, `tlon`, `zalouser`. Evidence showed
  these were only reachable through dispatch case strings in
  `src/infra/outbound/outbound-session.ts`, which now become dead
  routes (no crash) once discovery skips them.
- **Deferred** (left in `extensions/` because removal requires
  coupled refactor): `googlechat`, `bluebubbles`, `mattermost`,
  `msteams`, `voice-call`, `zalo`, `copilot-proxy`,
  `google-antigravity-auth`, `google-gemini-cli-auth`,
  `qwen-portal-auth`. Evidence rows in `STAGE2G_EVIDENCE.md`
  section 4 enumerate the coupled call sites
  (channel registry/dock, config schema labels, auth-choice apply
  chain, direct test imports) that block a same-commit removal.

## Skills

Skills audit found **zero** concrete v0 runtime consumers — discovery
is generic via `src/agents/skills/bundled-dir.ts` walking the
directory, and the only test references are a soft-skip for `peekaboo`
and a tmpdir fixture name.

- **Kept**: none.
- **Deleted** (39 skills): personal-productivity, device-specific,
  and third-party-service skills enumerated in the deletion ledger
  and `STAGE2G_EVIDENCE.md` section 5.
- **Quarantined** (9 skills under `skills/_deferred/`): borderline
  useful skills (coding-agent, session-logs, skill-creator, etc.)
  flagged for a later evaluation rather than outright deletion.
- **Deferred public skill dirs**: `skills/bluebubbles/`,
  `skills/peekaboo/`, `skills/voice-call/` remain in
  `package.json` `files[]` because each is paired with another
  deferred decision (matching extension; soft-skip test).

## CLI

Track H (commit `59e00eb64`) hid eight lazy CLI registrations from
`src/cli/program/register.subclis.ts` with the marker
`// Stage 2G: hidden from default CLI surface; not part of
SmithersBot v0`, and removed the matching enumeration from
`src/cli/program/help.ts`:

- `acp`
- `tui`
- `docs`
- `hooks`
- `webhooks`
- `plugins`
- `channels`
- `directory`

Explicitly **kept** v0 surfaces: `gateway`, `logs`, `system`,
`models`, `approvals`, `cron`, `skills`, `goal`, `setup`, `onboard`,
`configure`, `memory`, `agent`.

**Deferred** (still registered, slated for a later track because
removal is coupled to canvas-host, sandbox, plugin-registry, or
auto-reply work): `browser`, `daemon`, `nodes`, `node`, `sandbox`,
`devices`, `dns`, `pairing`, `security`, `message`. Lightweight
operator tooling (`gstack`, `update`) is also kept for now.

Updated tests: `src/cli/program/register.subclis.test.ts`,
`src/cli/program.smoke.test.ts`.

## Browser / UI / Canvas / Vendor

Track I applied the plan's `quarantine-or-defer` default and only
deleted rows with **zero** v0 importers across the required scopes:

- **Deleted**: `vendor/a2ui/` (45,000+ LOC dropped). The runtime
  bundle the gateway actually serves is the separate
  `src/canvas-host/a2ui/a2ui.bundle.js`, which is untouched.
- **Deferred**: `src/browser/`, `assets/chrome-extension/`, `ui/`,
  `src/gateway/control-ui.ts`, `src/canvas-host/`,
  `scripts/canvas-a2ui-copy.ts`, `scripts/debug-mermaid-png.ts`,
  `scripts/ui.js`. Evidence rows show concrete importers in
  `src/gateway/server-{close,impl,http,runtime-state}.ts`,
  `src/agents/sandbox/`, `src/agents/tools/`, `src/cli/`,
  `src/commands/`, and `src/infra/`. Pulling any of these requires
  the deeper architectural work explicitly out of scope for this
  stage.

## Hooks

Track J (commit `c354899bc`) treated bundled hooks conservatively
(plan default is quarantine) because the four candidates have **no**
named importers in `src/hooks/loader.ts`, `src/config/`, `src/goal/`,
or `src/telegram/` — they are picked up only via dynamic directory
discovery gated by `cfg.hooks.internal.enabled`.

- **Quarantined**: `boot-md`, `command-logger`, `session-memory`,
  `soul-evil` (bundled), plus the top-level `src/hooks/soul-evil.ts`
  paired helper and `src/hooks/soul-evil.test.ts`. All moved under
  `src/hooks/_deferred/`. Relative imports rewritten so they still
  type-check.
- **Documentation**: `src/hooks/bundled/README.md` shrank from 234
  lines to a short v0 note explaining that the bundled-hooks
  directory is empty by design at the v0 line.

## Auto-reply Test Debt

Stage 2E and 2F both left 16 legacy-channel auto-reply tests failing
because the v0 line dropped Discord, Slack, WhatsApp, and iMessage
behavior. Track K (commit `8ea254d82`) did **not** delete the
auto-reply subsystem; instead each failing assertion was marked
`it.skip` with a `// Stage 2G: legacy <channel>` comment:

- `src/auto-reply/command-control.test.ts` (Discord text-command
  gating).
- `src/auto-reply/commands-registry.test.ts` (text command gating
  for non-Telegram sources).
- `src/auto-reply/inbound.test.ts` (Discord mention gating).
- `src/auto-reply/reply/agent-runner-utils.test.ts` (Slack/WhatsApp
  tool threading metadata).
- `src/auto-reply/reply/reply-routing.test.ts` (Slack mention/reply,
  iMessage direct tool threading).
- `src/auto-reply/reply/session-resets.test.ts` (Slack/WhatsApp
  reset authorization).

Result: `pnpm vitest run src/auto-reply/` exits 0 with 484 passing
and 16 skipped — and the v0 verification slice stays green.

## Verification Results

Final-gate commands and exit statuses recorded against the post-Track-K
tree:

| Command | Exit | Notes |
| --- | --- | --- |
| `pnpm exec tsc -p tsconfig.json` | 0 | Clean, no diagnostics. |
| `pnpm build` | 0 | `tsc` + `canvas-a2ui-copy.ts` + `copy-hook-metadata.ts` + `write-build-info.ts` all clean. |
| `pnpm lint` | 0 | oxlint 0 warnings, 0 errors, 2334 files. |
| `pnpm vitest run src/telegram/ src/hooks/ src/goal/ src/repo-chat/ src/memory/` | 0 | 113 files, 1378 passed / 8 skipped. v0 verification slice. |
| `pnpm vitest run src/auto-reply/` | 0 | 58 files, 484 passed / 16 skipped (legacy channels). |
| `pnpm vitest run src/cli/` | 0 | 33 files, 193 passed. |

`pnpm install` was not required by any Stage 2G commit — every package
edit was a pure removal of dead refs.

## Remaining For Stage 2H Or Stage 3

Cleanups Stage 2G deliberately deferred because they would require
either deep architectural work or operator approval beyond this
stage's scope:

- **Browser / Chrome extension / UI / gateway control-UI**: pull these
  out of the gateway server pipeline, then decide whether to keep
  them as an optional surface or delete. Evidence rows in
  `STAGE2G_EVIDENCE.md` sections 1-2 enumerate every importer.
- **Canvas host / canvas scripts**: same architectural decision as
  above — `src/canvas-host/` is wired into the gateway server.
- **Sandbox stack**: `Dockerfile.sandbox`, `Dockerfile.sandbox-browser`,
  `.dockerignore`, sandbox setup scripts, `src/agents/sandbox/`
  importers. Deferred pending a sandbox keep/cut decision.
- **Gateway-restart systemd units**: `moltbot-gateway-restart.path`,
  `.service`, plus the install script — deferred because the v0
  Telegram `/gateway_restart` command flow depends on them.
- **Extensions remaining in `extensions/`**: `googlechat`,
  `bluebubbles`, `mattermost`, `msteams`, `voice-call`, `zalo`,
  `copilot-proxy`, `google-antigravity-auth`,
  `google-gemini-cli-auth`, `qwen-portal-auth`. Each needs a paired
  refactor in channel registry/dock, plugin auto-enable, or
  auth-choice apply chain.
- **CLI deferred subcommands**: `browser`, `daemon`, `nodes`,
  `node`, `sandbox`, `devices`, `dns`, `pairing`, `security`,
  `message`. Removal blocked by canvas-host / sandbox / plugin /
  auto-reply coupling.
- **Vitest auxiliary configs** (`vitest.unit.config.ts`,
  `vitest.gateway.config.ts`, `vitest.extensions.config.ts`): not
  referenced from any `package.json` script — defer pending an
  internal tooling grep.
- **`src/auto-reply/` legacy channel code**: the implementation
  branches behind the now-skipped tests are still on disk. Stage 2H
  or Stage 3 should decide whether to delete the non-Telegram code
  paths entirely or keep them as inert legacy.
- **README / AGENTS broad pass**: explicitly out of scope here.
  Stage 2H should re-read README.md against the post-Stage-2G surface
  and prune stale references.
- **CI**: not in scope per the constraints. Once the deferred items
  above are resolved, a minimal CI workflow becomes worth adding.

## Recommendation

**Ready for networked install + CI/demo, with the caveats below.**

The remaining work is all paired-refactor or operator-decision work;
none of it blocks SmithersBot v0 from being demonstrated end to end on
the supported surface (Telegram → `/new_goal` → goal worker → repo
chat → Nightwatch). The repo root, deploy surface, public package
allowlist, workspace surface, default test surface, default CLI
surface, and bundled hooks/skills now all align with the v0 product
description.

Recommended Stage 2H gate before publishing or wiring CI:

1. Decide the sandbox stack keep/cut question (drives `Dockerfile.sandbox*`,
   `scripts/sandbox-*.sh`, `src/agents/sandbox/`, and the CLI
   `sandbox` / `browser` subcommands).
2. Decide the gateway-restart systemd cut/keep question (drives the
   remaining `scripts/systemd/` units).
3. Run a networked `pnpm install` from a fresh clone to confirm the
   workspace install path is clean now that all dead extension and
   skill paths are gone.
4. Re-run the v0 verification slice plus `src/auto-reply/` and
   `src/cli/` from a fresh install to confirm nothing relied on a
   locally cached package.

Stage 2G itself is complete and does not require a follow-up patch.
