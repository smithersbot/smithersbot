# Stage 2E Report

## Decisions Applied

- Applied the operator decision to delete the stale public docs surface instead of rewriting it.
- Kept live hook and Chrome extension surfaces, rewritten with SmithersBot wording.
- Kept deferred extension directories, marked their READMEs as upstream-derived and unsupported for v0.
- Removed dead native Mac app packaging and Swift leftovers without touching Node runtime platform detection.
- Pruned or quarantined legacy test debt only where it was outside the v0-supported launch slice.
- Deferred CI creation because the required `pnpm install` gate did not exit 0 in this environment.

## Files And Directories Deleted

- Deleted the tracked top-level `docs/` tree.
- Deleted docs-only helper scripts: `scripts/sync-moonshot-docs.ts`, `scripts/docs-list.js`, `scripts/build-docs-list.mjs`.
- Deleted lowercase `claude.md` and `.agent/workflows/`.
- Deleted native Mac app leftovers: `src/macos/`, Mac packaging/signing scripts, `appcast.xml`, `.swiftformat`, and `.swiftlint.yml`.
- Deleted committed private/generated artifacts under `.clawdbot-dev/` and the stray tracked `~/` npm log path.
- Deleted obsolete known-broken tests: `test/auto-reply.retry.test.ts` and `src/auto-reply/reply/route-reply.test.ts`.

## Files Rewritten

- Rewrote `AGENTS.md` as short public-safe SmithersBot guidance.
- Rewrote `src/hooks/bundled/README.md`, `src/hooks/bundled/soul-evil/README.md`, and `assets/chrome-extension/README.md`.
- Updated `src/cli/browser-cli-extension.ts` to point users at the in-tree Chrome extension README instead of the old docs host.
- Updated cleanup references in `package.json`, `.github/labeler.yml`, `.gitignore`, `.pre-commit-config.yaml`, and `vitest.config.ts`.
- Added `extensions/telegram/README.md` describing Telegram as the supported v0 channel.
- During final gate rerun, aligned stale extension workspace dependencies from `moltbot` to `smithersbot` in extension package manifests so pnpm no longer looks for a missing local package.

## Private Artifacts Removed

- Removed committed `.clawdbot-dev` scout/run output.
- Removed the literal tracked `~/` npm log path.
- Added ignore rules for these generated paths so they are not recommitted.

## Placeholders Changed

- Replaced private Tailscale hostnames with `your-tailnet.ts.net`.
- Replaced the sample phone number in `.env.example` with `+15555550123`.
- Replaced personal `/Users/<name>/...` test paths with neutral `/Users/test/...` paths.

## Docs Deletion Summary

- `docs/` is no longer tracked.
- Docs scripts and package allowlist references were removed.
- Docs-only labeler globs were pruned.
- Top-level `docs.acp.md` was intentionally left untouched.

## Agent Guidance Outcome

- `AGENTS.md` now contains public-safe SmithersBot development guidance under 100 lines.
- `CLAUDE.md` remains a symlink to `AGENTS.md`.
- Lowercase `claude.md` was deleted.
- Private ops, old upstream instructions, old docs hosts, Mac release guidance, SSH targets, maintainer notes, old aliases, and private workflow details were removed.
- Goal-system self-verification guidance was preserved.

## Mac App Leftovers Removed

- Removed native Mac app/Swift subprocess surfaces and packaging files.
- Removed stale package, Vitest, gitignore, and pre-commit references tied to the deleted Mac app.
- Preserved runtime OS summary, system presence, and command-policy code.

## Hook, Chrome, And Deferred Extension Outcome

- Live bundled hook documentation now uses SmithersBot wording and in-tree pointers.
- Live Chrome extension documentation now uses SmithersBot wording and local install guidance.
- Deferred extension READMEs were banner-marked as upstream-derived, deferred from SmithersBot v0, and unsupported.
- Telegram extension README was added as the v0-supported channel pointer.

## Test Debt Fixed, Pruned, Or Quarantined

- Pruned obsolete Slack/Discord assertions from outbound session tests while keeping Telegram, BlueBubbles, and Zalo coverage.
- Fixed Telegram typing-loop behavior so synchronous or throwing `sendChatAction` mocks do not crash message handling.
- Updated a stale Telegram command assertion from `goal` to `new_goal`.
- Quarantined `src/telegram/bot.test.ts` in `vitest.config.ts` with a Stage 2E comment because it OOMs the default Vitest worker heap as a single legacy aggregate file, while the split Telegram slice passes.

## CI Status

- CI workflow was not added.
- README CI badge was not added.
- Reason: the required `pnpm install` gate failed in this environment due restricted network/DNS access for registry and GitHub dependency fetches:
  - `getaddrinfo EAI_AGAIN registry.npmjs.org`
  - `git ls-remote git+ssh://git@github.com/whiskeysockets/libsignal-node.git HEAD`
- Before the network failure, stale workspace package-name blockers were fixed by changing extension package references from the old root package name to `smithersbot`.

## Verification Commands And Results

- `pnpm install`: failed after retries because external dependency metadata and GitHub SSH dependency fetches could not resolve under restricted network.
- `pnpm exec tsc -p tsconfig.json`: passed.
- `pnpm build`: passed.
- `pnpm lint`: passed.
- `pnpm vitest run src/infra/outbound/ src/telegram/ src/goal/ src/repo-chat/ src/memory/`: passed, 114 files passed, 1 file skipped, 1336 tests passed, 8 skipped.

## Remaining Blockers Before Public Push

- Re-run `pnpm install` in an environment with network access or a fully warm pnpm store.
- If install passes, add the minimal GitHub Actions workflow and README badge, then rerun the full gate.
- Review the remaining public package/extension naming surface separately if the project wants to rename legacy `@moltbot/*` extension package names before public push.

## Recommendation

Blocked for adding CI in this environment, but the selected v0-supported local slice is green. After a successful networked install, this should be ready for minimal final git hygiene and public push preparation.
