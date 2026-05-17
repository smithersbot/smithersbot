# Stage 2B — Public v0 Repo Baggage Prune Report

This report reflects the completed Stage 2B pruning pass. It was checked against
the live working tree, `git log`, the Stage 2B investigation table, and the
verification results recorded by each worker.

## HEAD anchor vs current HEAD

| Marker | SHA |
| --- | --- |
| Stage 2B start anchor | `3fd04ff4c2916d6c0ecdc2c8c3f101634cc9b4d2` |
| Current HEAD before this report | `1a57aa56afccc3a41b7eecf07a63aae1d40ba0d6` |

Stage 2B started from the parent of the first Stage 2B worker commit
`b73cbcbfd40fe0dfd9db833a4456efc6baea5bc6`. The current HEAD before this
report is the final cleanup commit, `claw: fix stage2b broken refs`.

## Per-step commit SHAs

| Step | SHA | Subject |
| --- | --- | --- |
| investigate-provider-auth-extensions | `b73cbcbfd40fe0dfd9db833a4456efc6baea5bc6` | `Stage 2B: investigate provider/auth extensions (DEFER copilot-proxy, google-antigravity-auth, google-gemini-cli-auth, qwen-portal-auth)` |
| investigate-non-channel-extensions | `6b6d132c949d1a7ecddff55b0537ec9f877b71b9` | `Stage 2B: investigate non-channel extensions (KEEP memory-core; CUT diagnostics-otel, llm-task, lobster, memory-lancedb, open-prose)` |
| investigate-channel-extensions | `47907eea1cf7ee8ba6c0c01df36868107261d9e0` | `Stage 2B: investigate channel extensions (CUT twitch; DEFER eleven channels with src/* coupling)` |
| prune-non-channel-extensions | `6ebdf799f5a4479a425827f7dd86c4c998a01657` | `claw: prune-non-channel-extensions` |
| prune-peripheral-dirs | `a7e680c30ba354eb565cced67f26f948cd87efb0` | `claw: prune-peripheral-dirs` |
| prune-native-app-dirs | `d2ef91441eae9653e553d5e17d1613d5ceba3aaa` | `Stage 2B: prune native app dirs (ios, android, macos, shared) and macOS path constants` |
| prune-channel-extensions | `c6c9e3ff45eb0f4e35289d1fb835ca4fa864872c` | `claw: prune-channel-extensions` |
| trim-native-app-package-json | `c8e682b742215857893d434b84b293def0729cd7` | `claw: trim-native-app-package-json` |
| trim-github-configs | `6f2ff0d670152be8668db0c629505ff959aac287` | `claw: trim-github-configs` |
| fix-tiny-broken-refs | `1a57aa56afccc3a41b7eecf07a63aae1d40ba0d6` | `claw: fix stage2b broken refs` |

## Removed surface summary

| Category | Count | Removed surfaces |
| --- | ---: | --- |
| Peripheral top-level/package baggage | 5 | `Swabble/`, `smithersbot_marketing/`, `openclaw-starter-kit`, `packages/clawdbot/`, `packages/moltbot/` |
| Native app directories | 4 | `apps/ios/`, `apps/android/`, `apps/macos/`, `apps/shared/MoltbotKit/` |
| Non-channel extensions | 5 | `extensions/diagnostics-otel/`, `extensions/llm-task/`, `extensions/lobster/`, `extensions/memory-lancedb/`, `extensions/open-prose/` |
| Channel extensions | 1 | `extensions/twitch/` |
| Native app package scripts/checks | 20 package.json lines | Removed native app build/package/lint/check entries that referenced deleted app paths |
| GitHub config rules | 2 files | Trimmed deleted-path entries from `.github/dependabot.yml` and `.github/labeler.yml` |
| Tiny broken refs | 24 files touched | Removed deleted plugin/channel docs and nav entries, deleted obsolete A2UI/native app config references, renamed the synthetic open-prose test fixture |

Total deleted Stage 2B directory surfaces: **15**.

## Investigation decisions

The full evidence table lives in
`RELEASE_AUDIT/stage2b-ambiguous-investigation.md`. Condensed decisions:

| Surface | Decision | Evidence summary |
| --- | --- | --- |
| `copilot-proxy` | **DEFER to 2C** | Runtime references in `src/config/plugin-auto-enable.ts`, `src/commands/auth-choice.apply.ts`, `src/commands/auth-choice.apply.copilot-proxy.ts`, auth-choice options, preferred-provider map, and onboarding types. |
| `google-antigravity-auth` | **DEFER to 2C** | Runtime coupling through `PROVIDER_PLUGIN_IDS`, auth-choice dispatch, onboarding types, model filtering, OAuth helpers, provider usage modules, and tests. |
| `google-gemini-cli-auth` | **DEFER to 2C** | Runtime coupling through `PROVIDER_PLUGIN_IDS`, auth-choice dispatch, onboarding types, OAuth helpers, embedded runner/model branches, provider usage modules, and tests. |
| `qwen-portal-auth` | **DEFER to 2C** | Runtime coupling through `PROVIDER_PLUGIN_IDS`, auth-choice dispatch, qwen OAuth provider, auth profiles, CLI credential sync, model selection, and tests. |
| `diagnostics-otel` | **CUT** | No `src/` references; only deleted labeler entries. |
| `llm-task` | **CUT** | No `src/` references; only deleted labeler/docs entries. |
| `lobster` | **CUT** | Only synthetic test-fixture string references; real extension directory was not load-bearing. |
| `memory-core` | **KEEP** | Default memory slot and runtime references in `src/plugins/slots.ts`, `src/plugins/config-state.ts`, `src/commands/status.scan.ts`, `src/gateway/tools-invoke-http.ts`, plus E2E Docker copy. |
| `memory-lancedb` | **CUT** | No `src/` references; optional native dependency backend. |
| `open-prose` | **CUT** | Only synthetic tmpdir plugin fixture references; docs/install refs removed later. |
| `twitch` | **CUT** | No `src/`, package, script, or GitHub config coupling; stale docs removed later. |
| `bluebubbles` | **DEFER to 2C** | Runtime coupling in message tool, status issues, group mentions, outbound session, and target resolver. |
| `googlechat` | **DEFER to 2C** | Runtime coupling in channel registry/dock, group mentions, hook types, and message-channel normalization. |
| `line` | **DEFER to 2C** | Full `src/line/` source-channel directory remains out of Stage 2B scope. |
| `matrix` | **DEFER to 2C** | Runtime outbound-session dispatch coupling. |
| `mattermost` | **DEFER to 2C** | Runtime outbound-session dispatch coupling. |
| `msteams` | **DEFER to 2C** | Runtime coupling in message-channel aliases, security fix rules, hook schemas/types, legacy migration rules, capabilities, and outbound session. |
| `nextcloud-talk` | **DEFER to 2C** | Runtime outbound-session dispatch coupling and DM-history fixture coverage. |
| `nostr` | **DEFER to 2C** | Runtime outbound-session dispatch coupling. |
| `tlon` | **DEFER to 2C** | Runtime outbound-session dispatch coupling. |
| `zalo` | **DEFER to 2C** | Runtime outbound-session dispatch coupling plus load-bearing onboarding install-flow test fixture. |
| `zalouser` | **DEFER to 2C** | Runtime outbound-session dispatch coupling plus outbound-session test coverage. |
| `discord`, `imessage`, `signal`, `slack`, `voice-call`, `whatsapp` | **DEFER to 2C** | Pre-identified coupled channel extensions in the Stage 2B plan; source-channel cleanup was explicitly out of scope. |

## Verification

Per-step verification recorded by workers:

| Step | Verification result |
| --- | --- |
| prune-peripheral-dirs | `pnpm exec tsc -p tsconfig.json` passed; `pnpm vitest run --changed` passed with no changed test files. |
| prune-native-app-dirs | `pnpm exec tsc -p tsconfig.json` passed; `pnpm vitest run --changed` surfaced unrelated broad changed-suite failures recorded by that worker. |
| trim-native-app-package-json | package.json JSON parse passed; `pnpm exec tsc -p tsconfig.json` passed; `pnpm build` passed; `pnpm test` passed. |
| prune-non-channel-extensions | `pnpm exec tsc -p tsconfig.json` passed; `pnpm vitest run --changed` passed with no changed test files. |
| prune-channel-extensions | Spot-grep found no `twitch` coupling; `pnpm exec tsc -p tsconfig.json` passed; `pnpm test` passed; `pnpm build` passed. |
| trim-github-configs | YAML parse and deleted-path grep passed; `pnpm exec tsc -p tsconfig.json` passed; `pnpm build` passed; `pnpm lint` passed; `pnpm test` passed. |
| fix-tiny-broken-refs | package/docs JSON parse passed; `pnpm exec tsc -p tsconfig.json` passed; `pnpm build` passed; targeted vitest for touched fixtures passed. |
| write-stage2b-report | `pnpm exec tsc -p tsconfig.json` passed; `pnpm build` passed; `pnpm test` passed. |

Final cumulative verification for this report step:

- `pnpm exec tsc -p tsconfig.json`: passed with exit code 0.
- `pnpm build`: passed with exit code 0.
- `pnpm test`: passed with exit code 0 (`src/telegram/bot-handlers.goal-routing.test.ts`, 15 tests).

## Deferred to Stage 2C

- Coupled provider/auth extensions: `copilot-proxy`, `google-antigravity-auth`,
  `google-gemini-cli-auth`, `qwen-portal-auth`.
- Provider/auth source cleanup:
  `src/commands/auth-choice.apply.*`,
  `src/commands/auth-choice.apply.ts`,
  `src/config/plugin-auto-enable.ts` / `PROVIDER_PLUGIN_IDS`,
  auth-choice option/preferred-provider maps, provider usage, auth-profile,
  OAuth, and model-selection branches.
- Coupled channel extensions: `bluebubbles`, `discord`, `googlechat`,
  `imessage`, `line`, `matrix`, `mattermost`, `msteams`, `nextcloud-talk`,
  `nostr`, `signal`, `slack`, `tlon`, `voice-call`, `whatsapp`, `zalo`,
  `zalouser`.
- Source-channel cleanup: `src/web`, `src/whatsapp`, `src/discord`,
  `src/slack`, `src/signal`, `src/imessage`, `src/line`,
  `src/channel-web.ts`, `src/channels/web`, plus matching shared routing,
  outbound, registry, allowlist, onboarding, and docs surfaces.
- `src/web` extraction and any web provider/source-channel architecture work.
- `src/macos` remains in place for Stage 2C evaluation.
- `package.json:files` trim once the remaining public package surface is
  decided.
- npm publish/pack work and any release channel/version changes.
- Git history, remote, tag, branch, and remote-prune operations.
- Non-trivial docs/scripts decisions left from tiny-ref cleanup, including
  remaining historical release-note text and macOS docs/scripts references that
  require a broader Stage 2C decision.

## Recommendation

**Ready for Stage 2C.**

Stage 2B removed the obvious non-v0 peripheral, native app, and uncoupled
extension baggage without touching the source-channel directories that were
explicitly out of scope. The remaining cuts are coupled to runtime `src/*`
surfaces and should be handled as an architectural Stage 2C cleanup rather than
more directory pruning.
