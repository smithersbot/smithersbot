# Stage 2K Final Launch Readiness Report

## Executive summary

Stage 2K final non-demo launch polish is blocked by verification. The
public-facing README now has a CI badge, honest demo status, the intended
flowchart image path, a fresh isolated setup guide, and a Telegram command list
aligned with the v0 command surface. Public metadata and root-tree checks did
not identify a remaining high-confidence public leak that should be fixed in
this stage.

The demo asset remains intentionally out of scope and is still a manual
pre-public task. A narrow Telegram media test harness issue was fixed during
verification, but no commit was made because the required verification sequence
still did not pass.

## README changes

- Added a GitHub Actions CI badge for
  `https://github.com/smithersbot/smithersbot/actions/workflows/ci.yml`.
- Kept the Demo section honest: the demo is coming soon and the asset is not
  included yet.
- Confirmed the flowchart image path is `assets/smithersbot-flowchart.png`.
- Updated the public Telegram command list to include the working command
  surface, including `/help`, `/commands`, goal commands, repo chat, backend
  selection, `/nightwatch`, diagnostics, and authorized private-chat
  `/gateway_restart`.
- Added a fresh isolated setup guide covering VM/VPS/Docker/dedicated-machine
  operation, Node 22, Corepack/pnpm, git, Claude Code/Codex CLI login,
  Telegram token and allowlist setup, clone/install/build, gateway start,
  first Telegram smoke tests, restart/persistence checks, and state/log
  locations.

## CI badge decision

Added. The public repository and workflow URL are clear from `package.json`
repository metadata and `.github/workflows/ci.yml`.

## Public old-name scan results

Scan terms:

- `moltbot`
- `Moltbot`
- `clawdbot`
- `Clawdbot`
- `clawd`
- `OpenClaw`
- `openclaw`
- `@moltbot/`
- `clawdbot/plugin-sdk`
- `CLAWDBOT_`

Classifications:

- Allowed attribution: `NOTICE.md`, `README.md` attribution text, and
  `CHANGELOG.md` fork-start attribution.
- Internal/deferred: `internal/**`, including deferred non-v0 extension code and
  Stage 2J reports.
- Test fixture: historical names and compatibility variables in tests and
  fixture-style assertions.
- Stage 3 defer: broad legacy CLI/config/type names in active internals, the
  `@moltbot/*` package scope, and the deep `CLAWDBOT_*` compatibility sweep.
- Public-facing fix now: no remaining high-confidence public-facing leak was
  identified after the Stage 2K metadata fixes.

## Root tree sanity result

Tracked public root check passed.

Confirmed absent from the tracked public root:

- `RELEASE_AUDIT/`
- tracked `.codex`
- tracked `.env`
- `docs.acp.md`
- `patches/`
- `skills/`
- `vendor/`
- `moltbot.mjs`

Confirmed present and intentional in the tracked public root:

- `README.md`
- `LICENSE`
- `NOTICE.md`
- `CHANGELOG.md`
- `CONTRIBUTING.md`
- `SECURITY.md`
- `AGENTS.md`
- `CLAUDE.md`
- `package.json`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`
- `smithersbot.mjs`
- `.github/`
- `src/`
- `extensions/`
- `internal/`
- `scripts/`
- `test/`
- `tools/`
- `ui/`
- `assets/`

Note: the local working checkout also contains untracked or ignored runtime
directories such as `.codex`, `.moltbot-goal-worker-results`, `dist`, and
`node_modules`; these are not part of the tracked public tree.

## Package and metadata sanity result

- `package.json` name, description, bin, exports, repository, bugs, homepage,
  license, and scripts are aligned with the SmithersBot public package surface.
- `package.json` `files[]` no longer references the removed `patches/**` path.
- `LICENSE` includes both required copyright lines:
  `Copyright (c) 2025 Peter Steinberger` and
  `Copyright (c) 2026 Matthew Overing`.
- `NOTICE.md` preserves upstream OpenClaw/Moltbot attribution and fork point.
- `.env.example` is Telegram-v0 focused and contains no real secrets.
- `pnpm-workspace.yaml` includes the root package, `ui`,
  `extensions/memory-core`, and `extensions/telegram`.
- `.github/workflows/ci.yml` matches the Stage 2K CI verification commands for
  install, typecheck, build, lint, and the targeted Vitest slices.

## Release-history runbook sanity result

`internal/RELEASE_HISTORY_PLAN.md` is operator-only and explicitly says not to
execute it inside a goal. It instructs the operator to manually create an orphan
`public-launch` branch, verify the branch has exactly one commit, verify the
orphan tree hash matches the pre-orphan tree, remove non-public remotes before
push, push only the intended public branch, and run a fresh-clone verification
after push.

The runbook was reviewed only; it was not executed.

## Fresh VM setup guide and dogfood checklist

- README fresh isolated setup guide: added.
- `internal/FRESH_VM_DOGFOOD_CHECKLIST.md`: added for the `SmithersBot2` manual
  dogfood run.

## Verification command results

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | PASS |
| `pnpm exec tsc -p tsconfig.json` | PASS |
| `pnpm build` | PASS |
| `pnpm lint` | PASS (`Found 0 warnings and 0 errors.`) |
| `pnpm vitest run src/telegram/ src/hooks/ src/goal/ src/repo-chat/ src/memory/` | PASS (`111 passed | 1 skipped` files, `1382 passed | 8 skipped` tests) |
| `pnpm vitest run src/auto-reply/` | PASS (`56 passed` files, `475 passed` tests) |
| `pnpm vitest run src/cli/` | FAIL |
| `pnpm vitest run src/infra/outbound/` | Not run; stopped after failure above |
| `pnpm test` | Not run; stopped after failure above |
| `node scripts/run-node.mjs --help` | Not run; stopped after failure above |
| `MOLTBOT_STATE_DIR=/tmp/moltbot-2k-verify node scripts/run-node.mjs goal list --json` | Not run; stopped after failure above |

Failure details:

- The previous Telegram media test failure was fixed by hoisting the test's
  mocked `apiThrottler` spy; the individual file and the full
  Telegram/hooks/goal/repo-chat/memory slice passed afterward.
- `pnpm vitest run src/cli/` failed in
  `src/cli/gateway-cli.coverage.test.ts`.
- Failed test:
  `gateway-cli coverage > registers call/health commands and routes to callGateway`.
- Error: test timed out after 30000ms at
  `src/cli/gateway-cli.coverage.test.ts:103`.
- Vitest summary for the failed command:
  `1 failed | 32 passed` test files, `1 failed | 194 passed` tests.

## Remaining pre-public manual tasks

- Add or link the real demo asset when ready.
- Run the `SmithersBot2` fresh-VM dogfood checklist manually.
- Execute the operator-only public launch history runbook manually, outside any
  goal.
- Fresh-clone the public branch after push and rerun install/build/lint/test
  smoke checks before announcement.

## Recommendation

Blocked. The repo is not ready for the manual public-launch history step until
the CLI gateway coverage timeout is fixed and the full Stage 2K verification
sequence passes. No demo work, orphan branch, remote changes, push, publish, or
release-history runbook execution was performed.
