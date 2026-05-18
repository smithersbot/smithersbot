# Stage 2H Cleanup Report

## Executive Summary

Stage 2H converted the quarantine cleanup decisions into repository changes without broad architecture rewrites. The public v0 surface is now narrowed around Telegram, `/goal`, repo chat, memory/lessons, external verification, Nightwatch, and local/debug CLI support. Deferred trees were deleted, non-v0 extension/package surfaces were removed from defaults, Docker-backed sandbox runtime code was pruned while path-policy safety pieces stayed in place, selected legacy auto-reply commands were removed, unsupported CLI subcommands were hidden, and stale public-context wording was refreshed.

Recommendation: ready for CI/demo from the local verification evidence below. One environmental caveat remains: the first default `goal list --json` command attempted to write to the active worker state path under `/home/matt/.clawdbot-dev`, which is read-only in this execution context. The same command passed with `MOLTBOT_STATE_DIR=/tmp/moltbot-stage2h-goal-state`.

## Known Install Failure Handling

The pre-cleanup frozen install failure was caused by stale workspace metadata around `extensions/googlechat/package.json` and `pnpm-lock.yaml`. Track B narrowed the workspace to the root package, `ui`, `extensions/telegram`, and `extensions/memory-core`, removed non-v0 extension and skill globs from `package.json` `files[]`, and updated the active lockfile importer metadata. `pnpm install --no-frozen-lockfile` was attempted earlier but DNS/GitHub resolution blocked it; after the targeted metadata update, `pnpm install --frozen-lockfile` passes.

## Final Fresh Install Result

`pnpm install --frozen-lockfile` exited `0`.

Observed environmental warning: pnpm tried to fetch registry metadata for the pnpm update notice and logged `ERR_PNPM_META_FETCH_FAIL ... getaddrinfo EAI_AGAIN registry.npmjs.org`. The install still completed with the lockfile up to date, no resolution step, and postinstall completed.

## `_deferred` Deletion Outcome

Deleted:

- `extensions/_deferred/`
- `skills/_deferred/`
- `src/hooks/_deferred/`

The bundled-skill walker was left unchanged because deleting `skills/_deferred/` removed those staged skills from the canonical skills root. `vitest.config.ts` no longer carries the dead deferred-extension exclusion, and `src/hooks/bundled/README.md` no longer points at the deleted hook quarantine.

Verification recorded by the track worker: `pnpm exec tsc -p tsconfig.json` and `pnpm vitest run src/hooks/` exited `0`.

## Extension, Package, And Workspace Changes

`pnpm-workspace.yaml` now exposes only:

- `.`
- `ui`
- `extensions/telegram`
- `extensions/memory-core`

`package.json` `files[]` no longer ships non-v0 extension trees or bundled skills. Remaining non-v0 extension directories stay on disk for later paired refactors, but they are no longer advertised through workspace/package defaults.

## Skills Changes

Bundled skills are no longer part of the public package surface. `skills/**` entries were removed from package `files[]`, and `skills/_deferred/` was deleted. Remaining top-level skill directories are retained on disk only as deferred/internal material.

## Sandbox Split Outcome

Deleted Docker-backed sandbox runtime and CLI surfaces:

- Docker sandbox files and setup scripts
- Docker/browser sandbox runtime modules
- sandbox CLI entrypoint and sandbox command modules/tests
- Docker sandbox labeler references

Kept load-bearing safety/path-policy modules:

- `src/agents/sandbox/tool-policy.ts`
- `src/agents/sandbox/context.ts`
- `src/agents/sandbox/shared.ts`
- `src/agents/sandbox/workspace.ts`
- `src/agents/sandbox/constants.ts`
- `src/agents/sandbox/types.ts`
- `src/agents/sandbox-paths.ts`

Runtime status call sites were rewired to non-Docker behavior while preserving worker hard-deny and path-policy behavior. Track verification passed typecheck, build, lint, and targeted sandbox-adjacent tests.

## Browser, UI, And Canvas Decisions

Deep browser/UI/canvas cuts were deferred. The cleanup only removed cheap non-v0 packaging/debug surface:

- `prepack` now runs `pnpm build` without `pnpm ui:build`.
- `debug:mermaid` was removed.
- `scripts/debug-mermaid-png.ts` was deleted after reference checks.

`src/browser/`, `assets/chrome-extension/`, `ui/`, `src/gateway/control-ui*`, `src/canvas-host/`, and the remaining A2UI runtime bundle were kept.

## Gateway Restart Documentation Outcome

Added `scripts/systemd/README.md` documenting the trigger-file pattern, the default `moltbot-gateway-dev.service` service-name assumption, operator adjustment requirements, and the helper's advanced/admin role behind `/gateway_restart`. Existing unit files and installer script were left untouched.

## CLI Subcommand Changes

The default CLI registry no longer advertises/registers unsupported v0 subcommands:

- `daemon`
- `nodes`
- `node`
- `devices`
- `dns`
- `pairing`
- `sandbox`

The non-sandbox internals remain explicitly loadable for deferred development paths. Kept public/support surfaces include gateway, logs, system, models, approvals, cron, gstack, security, skills, update, and message. Browser CLI remains deferred.

## Auto-Reply Legacy Command And Test Changes

Removed legacy auto-reply command registrations and handlers for:

- `/new`
- `/reset`
- `/stop`
- `/approve`
- `/restart`
- `/bash`

Dedicated bash/approve modules and tests were deleted where they had no v0 importer. Skipped legacy Discord/Slack/WhatsApp/iMessage test blocks were pruned instead of re-enabled. Telegram goal and repo-chat behavior remained covered by the v0 test slice.

## Outbound Deferred-Channel Cleanup

Removed dead resolver/case strings for:

- `matrix`
- `nextcloud-talk`
- `nostr`
- `tlon`
- `zalouser`

Before deletion, persisted local goal/session state was searched for structured records using those channel names; none were found that would crash after removal. Tests and fixtures were updated for the narrowed outbound surface, and stale provider/channel comments were refreshed.

## Repo-Chat Context And Stale Comments

`src/repo-chat/repo-chat-context.ts` and mirrored repo-chat context docs now describe the Telegram/repo-chat/goal runtime rather than unsupported MS Teams, Matrix, Zalo, voice-call, or similar surfaces. Stale goal architecture pointers were replaced with current files such as `agent-executor-helpers.ts`, `backend-availability.ts`, and `capability-enforcement.ts`.

## RELEASE_AUDIT Decision

`RELEASE_AUDIT/` was not deleted. Prior Stage 2 narrative reports and ledgers were archived under:

```text
RELEASE_AUDIT/_archive/stage2-prior/
```

Inventories, feature audit material, README verification artifacts, fragments, and public audit summaries remain at the top level. This keeps evidence available while making the active Stage 2H report the current closeout document.

## Verification Commands And Results

| Command | Exit | Notes |
| --- | ---: | --- |
| `pnpm exec tsc -p tsconfig.json` | 0 | Clean. |
| `pnpm build` | 0 | Clean; build metadata/scripts completed. |
| `pnpm lint` | 0 | `oxlint` found 0 warnings and 0 errors. |
| `pnpm vitest run src/telegram/ src/hooks/ src/goal/ src/repo-chat/ src/memory/` | 0 | 110 files passed, 1 skipped; 1354 passed, 8 skipped. |
| `pnpm vitest run src/auto-reply/` | 0 | 56 files passed; 475 tests passed. |
| `pnpm vitest run src/cli/` | 1 then 0 | First run timed out in `gateway-cli.coverage.test.ts`; the file passed alone, then the full CLI slice passed on rerun with 33 files and 195 tests. |
| `pnpm vitest run src/cli/gateway-cli.coverage.test.ts` | 0 | Targeted rerun after CLI timeout; 9 tests passed. |
| `pnpm vitest run src/infra/outbound/` | 0 | 11 files passed; 45 tests passed. |
| `pnpm install --frozen-lockfile` | 0 | Fresh install gate passed; environmental pnpm update metadata DNS warning did not fail install. |
| `node scripts/run-node.mjs goal --help` | 0 | Goal CLI help rendered and listed v0 goal commands. |
| `node scripts/run-node.mjs goal list --json` | 1 | Environmental state-path failure: `EROFS` writing active worker state under `/home/matt/.clawdbot-dev/...`. |
| `MOLTBOT_STATE_DIR=/tmp/moltbot-stage2h-goal-state node scripts/run-node.mjs goal list --json` | 0 | Targeted non-mutating goal command passed and returned `[]`. |

## Remaining Deferred Items

- Deeper extension refactor/deletion for non-v0 extension directories still on disk.
- Browser CLI, browser runtime, UI, canvas host, gateway control UI, and A2UI architectural cuts.
- Full RELEASE_AUDIT public pruning policy beyond the safe Stage 2 prior-report archive.
- Non-sandbox hidden CLI internals can be deleted later once paired tests and developer workflows are retired.
- Legacy provider names still present in compatibility tests/config comments should be reviewed as part of a future config-compat stage rather than mixed into Stage 2H.

## Recommendation

Ready for CI/demo based on local verification. The only non-zero final command result was the default-state `goal list --json` environmental write failure, and the same goal path passed with an explicit writable `MOLTBOT_STATE_DIR`.
