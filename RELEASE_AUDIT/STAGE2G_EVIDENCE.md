# Stage 2G Evidence Ledger

This document collects evidence for Stage 2G repo minimization decisions.
Each subsystem section below will be populated in subsequent steps (B2–B7).
No deletions or quarantines should occur until the relevant section is filled
and the DECISION column is set.

## Column Legend

Every row in every section below uses this shared schema:

| Column | Meaning |
| --- | --- |
| **PATH** | The file or directory under consideration. |
| **IMPORTERS** | Code paths (under `src/`, `extensions/`, `scripts/`, etc.) that import or otherwise depend on PATH. Empty = no importers found. |
| **PACKAGE/WORKSPACE/VITEST REFS** | Mentions in `package.json` (files[], scripts, bin, exports), `pnpm-workspace.yaml` globs, and `vitest.config.ts` include/exclude entries. |
| **TESTS** | Test files that cover PATH or assert behavior provided by it. |
| **REQUIRED BY v0?** | yes / no / unclear. v0 surface = Telegram control, `/new_goal` planning + execution, repo chat, goal status/list/resume/stop, goal lessons/memory, external verification, Nightwatch, local CLI support. |
| **DECISION** | One of: `delete-now`, `quarantine-now`, `keep`, `defer`. |
| **VERIFICATION NEEDED** | The minimal command(s) that must pass after the decision is applied (e.g. `pnpm exec tsc`, `pnpm build`, `pnpm lint`, targeted `pnpm vitest run <slice>`). |

## 1. Browser / Chrome Extension

Grep scopes searched: `src/gateway/**`, `src/infra/**`, `src/cli/**`, `src/commands/**`,
`scripts/**`, `package.json`, `vitest.config.ts`.

| PATH | IMPORTERS | PACKAGE/WORKSPACE/VITEST REFS | TESTS | REQUIRED BY v0? | DECISION | VERIFICATION NEEDED |
| --- | --- | --- | --- | --- | --- | --- |
| `src/browser/` (large subsystem: `cdp.*`, `chrome.*`, `client*`, `pw-*`, `extension-relay*`, `profiles*`, `config*`, etc.) | `src/cli/browser-cli-extension.ts`, `src/cli/browser-cli-manage.ts`, `src/cli/browser-cli-inspect.ts`, `src/cli/browser-cli-actions-input/shared.ts`, `src/gateway/server-methods/browser.ts`, `src/security/audit.ts`, `src/security/audit-extra.ts`, `src/node-host/runner.ts`, `src/agents/sandbox/{context,prune,browser,browser-bridges,manage}.ts`, `src/agents/tools/browser-tool.ts` (+ browser-tool.test.ts) | `package.json` `files[]` ships `dist/browser/**` (L20); `vitest.config.ts` coverage excludes `src/browser/**` (L89) | `src/browser/*.test.ts` (cdp, chrome, client, config, extension-relay, profiles, profiles-service, pw-ai, pw-role-snapshot, pw-session, pw-tools-core variants) | unclear — not part of SmithersBot v0 Telegram/goal/repo-chat surface, but currently wired into gateway server methods, security audit allowlists, agent sandbox, and the browser-tool used by goal workers | defer (broad subsystem; gateway/agent/security importers exist — would require architectural rewiring) | `pnpm exec tsc`, `pnpm build`, `pnpm lint`, `pnpm vitest run src/browser/ src/agents/tools/ src/agents/sandbox/` if any deletion is attempted later |
| `assets/chrome-extension/` (background.js, manifest.json, options.html, icons/) | `src/cli/browser-cli-extension.ts` (L18,L39,L92,L109) and its test `src/cli/browser-cli-extension.test.ts` (L27,L30,L47); no `src/gateway/**`, `src/infra/**`, `src/commands/**`, or `scripts/**` importer | `package.json` `files[]` ships `assets/**` (L49); no direct `dist/` or `vitest` ref | `src/cli/browser-cli-extension.test.ts` | no — only consumed by the browser CLI subcommand, which itself is a non-v0 surface (Track F/H candidate) | defer (paired with `src/cli/browser-cli.ts` decision; removing alone would break the browser CLI test slice) | `pnpm vitest run src/cli/browser-cli-extension.test.ts` after any change |
| `src/cli/browser-cli.ts` | registered by `src/cli/program/command-registry.ts` (L9 `import { registerBrowserCli } from "../browser-cli.js"`); fans out to `browser-cli-actions-input`, `browser-cli-actions-observe`, `browser-cli-debug`, `browser-cli-examples`, `browser-cli-extension`, `browser-cli-inspect`, `browser-cli-manage`, `browser-cli-shared`, `browser-cli-state` | `package.json` `files[]` ships `dist/cli/**` (L22); no dedicated workspace/vitest entry | `src/cli/browser-cli-extension.test.ts`, `src/cli/browser-cli-inspect.test.ts` | no — browser CLI is not part of the SmithersBot v0 public surface (Telegram + `/new_goal` + repo chat + goal lessons + Nightwatch + local CLI debug) | quarantine-or-defer (hide via Track H by removing the `registerBrowserCli` registration; defer file deletion until Track I confirms no other v0 importer) | `pnpm vitest run src/cli/program/ src/cli/run-main.test.ts` after CLI hiding |

## 2. UI

Grep scopes searched: `src/gateway/**`, `src/infra/**`, `src/cli/**`, `src/commands/**`,
`scripts/**`, `package.json`, `vitest.config.ts`.

| PATH | IMPORTERS | PACKAGE/WORKSPACE/VITEST REFS | TESTS | REQUIRED BY v0? | DECISION | VERIFICATION NEEDED |
| --- | --- | --- | --- | --- | --- | --- |
| `ui/` (Vite SPA: `ui/src/main.ts`, `ui/src/ui/*`, `ui/src/styles/*`, `ui/vite.config.ts`, `ui/vitest.config.ts`, `ui/package.json`) | `scripts/ui.js` (L10 `path.join(repoRoot, "ui")` — invoked from npm scripts `ui:install/dev/build`); `src/commands/doctor-ui.ts` (L22,L35,L38,L49,L104,L107,L112,L114 — builds `ui/` into `dist/control-ui/`); `src/infra/control-ui-assets.ts` (L16,L23 — resolves repo root by checking `ui/vite.config.ts`); `src/infra/control-ui-assets.test.ts` (L13,L14,L28,L29) | `package.json` scripts: `ui:install`, `ui:dev`, `ui:build`, `prepack` calls `pnpm ui:build` (L74), `test:ui` (L95); no `pnpm-workspace.yaml` ref (not in workspace); no vitest include — `ui/` runs its own vitest | `ui/` has its own test runner (separate from root vitest include); `src/infra/control-ui-assets.test.ts` exercises the path-resolution helper | unclear — not Telegram/goal-system v0, but wired into the control-ui served by the gateway (Track I scope) | defer (the gateway's `/ui` route serves the built artifact; deletion requires removing `dist/control-ui/` packaging and `doctor-ui`/`control-ui-assets`/`update-runner` references in the same pass) | `pnpm exec tsc`, `pnpm build`, `pnpm vitest run src/infra/control-ui-assets.test.ts src/gateway/control-ui.test.ts` after any change |
| `src/gateway/control-ui.ts` | `src/gateway/server-http.ts` (L15 `handleControlUiAvatarRequest`, `handleControlUiHttpRequest`; L272–L283 mount on `/ui`); `src/gateway/control-ui.test.ts`; sibling `src/gateway/control-ui-shared.ts` is also imported by `src/gateway/server-runtime-config.ts` (L12), `src/gateway/server-methods/agent.ts` (L41) | `package.json` `files[]` ships `dist/control-ui/**` (L26); `vitest.config.ts` coverage exclude `src/gateway/control-ui.ts` (L71) | `src/gateway/control-ui.test.ts` (basePath normalization, avatar URL) | unclear — currently load-bearing for gateway HTTP server; not a Telegram/goal-system v0 surface | defer (live gateway importer — Track I must keep until the gateway is repointed off `/ui`) | `pnpm exec tsc`, `pnpm build`, `pnpm vitest run src/gateway/control-ui.test.ts src/gateway/server-http*` after any change |

## 3. Canvas / Vendor

Grep scopes searched: `src/gateway/**`, `src/infra/**`, `src/cli/**`, `src/commands/**`,
`scripts/**`, `package.json`, `vitest.config.ts`.

| PATH | IMPORTERS | PACKAGE/WORKSPACE/VITEST REFS | TESTS | REQUIRED BY v0? | DECISION | VERIFICATION NEEDED |
| --- | --- | --- | --- | --- | --- | --- |
| `src/canvas-host/` (`a2ui.ts`, `server.ts`, plus checked-in `a2ui/` bundle assets) | `src/gateway/server-close.ts` (L3 `CanvasHostHandler`, `CanvasHostServer`); `src/gateway/server.impl.ts` (L4 `CanvasHostServer`); `src/gateway/server-http.ts` (L10 `handleA2uiHttpRequest`, L11 `CanvasHostHandler`); `src/gateway/server-runtime-state.ts` (L3 `CANVAS_HOST_PATH`, L4 `createCanvasHostHandler`); `src/cli/nodes-cli/register.canvas.ts` (L8 `buildA2UITextJsonl`/`validateA2UIJsonl` — sibling helper, not canvas-host); `src/gateway/node-command-policy.ts` (L10–L12 `canvas.a2ui.*` allow list); `src/agents/tools/canvas-tool.ts` (L19–L172 invokes `canvas.a2ui.push/reset`); `src/repo-chat/repo-chat-context.ts` (L26 documentation) | `package.json` `files[]` ships `dist/canvas-host/**` (L21); `package.json` build script runs `scripts/canvas-a2ui-copy.ts` (L75) to copy `src/canvas-host/a2ui/` → `dist/canvas-host/a2ui/`; `.oxlintrc.json` ignores `src/canvas-host/a2ui/a2ui.bundle.js` (L11); not in vitest exclude | `src/canvas-host/server.test.ts`, `src/scripts/canvas-a2ui-copy.test.ts` | unclear — gateway HTTP server, node command policy, and agent canvas-tool all import; not a Telegram/goal-system v0 user surface but currently live-wired into the gateway and node-command policy | defer (gateway and agent tool both import — v0 importers present, constraint forbids `delete-now`) | `pnpm exec tsc`, `pnpm build`, `pnpm vitest run src/canvas-host/ src/gateway/ src/agents/tools/canvas-tool*` after any change |
| `vendor/a2ui/` (third-party A2UI spec + renderers: `specification/`, `renderers/`, `mkdocs.yaml`, `LICENSE`, etc.) | none — `Grep "vendor/a2ui"` across `src/gateway/**`, `src/infra/**`, `src/cli/**`, `src/commands/**`, `scripts/**`, `package.json`, `vitest.config.ts`, `tsconfig.json` returns zero hits. `src/canvas-host/a2ui.ts` resolves bundle assets from `src/canvas-host/a2ui/` (the checked-in bundle), NOT from `vendor/a2ui/`. Build script `scripts/canvas-a2ui-copy.ts` copies `src/canvas-host/a2ui/` → `dist/canvas-host/a2ui/` and does not touch `vendor/a2ui/`. | `vitest.config.ts` exclude `**/vendor/**` (L32); `.gitignore` ignores `vendor/a2ui/renderers/lit/dist/` (L29); no `package.json` `files[]`, scripts, or workspace entry | none (vendor is excluded from vitest) | no — vendored upstream reference only; the runtime bundle lives at `src/canvas-host/a2ui/a2ui.bundle.js` independently. Prior audit (`RELEASE_AUDIT/keep-vs-cut.md` L195) flagged for license/provenance investigation. | quarantine-or-defer (zero runtime importers detected; constraint does not block delete-now, but plan default for browser/UI/canvas/vendor is quarantine-or-defer — Track I should `git rm -r` only after confirming no out-of-scope test or doc fixture re-imports it) | `pnpm exec tsc`, `pnpm build`, `pnpm lint`, `pnpm vitest run src/canvas-host/` after any removal |
| `scripts/canvas-a2ui-copy.ts` | invoked by `package.json` build script (L75 `node --import tsx scripts/canvas-a2ui-copy.ts`); `src/scripts/canvas-a2ui-copy.test.ts` imports `copyA2uiAssets` | `package.json` `scripts.build` calls it | `src/scripts/canvas-a2ui-copy.test.ts` | yes — current build step packs `src/canvas-host/a2ui/` into `dist/canvas-host/a2ui/`; required as long as `src/canvas-host/` is kept | keep (paired with canvas-host) | `pnpm build` |
| `scripts/debug-mermaid-png.ts` | imports `src/goal/execution-status.ts`, `src/goal/mermaid-render.ts`, `src/goal/mermaid-png.ts`; invoked only by `package.json` `debug:mermaid` (L116) | `package.json` `scripts.debug:mermaid` | none | yes — debug utility for the goal-system mermaid status renderer (v0 retains goal-system mermaid output) | keep | `pnpm exec tsc`; manual `pnpm debug:mermaid` if mermaid output regresses |
| `scripts/ui.js` | invoked by `package.json` `ui:install/dev/build` (L78–L80) and `prepack` chain via `pnpm ui:build` (L74); `src/commands/doctor-ui.ts` (L49,L114) shells into it to rebuild `ui/` for `dist/control-ui/` | `package.json` `scripts.ui:*`; no vitest ref | none | unclear — required for the same control-ui packaging story as `ui/` and `dist/control-ui/` | defer (paired with `ui/` decision) | `pnpm exec tsc`, `pnpm build` after any change |

## 4. Extensions

Grep scopes searched: `src/**`, `extensions/**`, `scripts/**`, `package.json`,
`pnpm-workspace.yaml`. Plugin discovery is auto-walked at runtime by
`src/plugins/discovery.ts` against the bundled `extensions/` dir
(`src/plugins/bundled-dir.ts`), so an extension is "wired in" purely by its
package.json + `clawdbot.plugin.json` + `index.ts`. Workspace glob
`extensions/*` in `pnpm-workspace.yaml` covers every direct child.
`package.json` `files[]` ships `extensions/**` (L48) so every kept
extension also ships in the published tarball.

v0 reminder: only `telegram` and `memory-core` are part of the SmithersBot
public v0 surface (Telegram control, /new_goal, repo chat, goal
status/list/resume/stop, goal lessons/memory, external verification,
Nightwatch). Everything else is a non-v0 surface.

| PATH | IMPORTERS | PACKAGE/WORKSPACE/VITEST REFS | TESTS | REQUIRED BY v0? | DECISION | VERIFICATION NEEDED |
| --- | --- | --- | --- | --- | --- | --- |
| `extensions/telegram/` | First-class throughout `src/`: `src/channels/registry.ts` (L7,L13,L21 — `CHAT_CHANNEL_ORDER`, `DEFAULT_CHAT_CHANNEL`); `src/channels/dock.ts` (L69 dock entry); `src/channels/plugins/{group-mentions,status-issues/telegram,actions/telegram,outbound/telegram}.ts`; `src/telegram/**`; many handlers across `src/auto-reply/`, `src/agents/`, `src/repo-chat/`; auto-enabled via `src/config/plugin-auto-enable.ts` `isTelegramConfigured` (L70–L77). Bundled discovery loads `extensions/telegram/index.ts`. | `pnpm-workspace.yaml` matches via `extensions/*`; `package.json` `files[]` `extensions/**` (L48); no dedicated vitest entry | `src/plugins/loader.test.ts` (L104–L144) constructs an in-memory "telegram" plugin; `src/telegram/**.test.ts` (large slice) | yes — v0 primary channel | keep | `pnpm exec tsc`, `pnpm build`, `pnpm lint`, `pnpm vitest run src/telegram/ extensions/telegram/` |
| `extensions/memory-core/` | Default memory slot: `src/plugins/slots.ts` (L17 `memory: "memory-core"`); `src/plugins/config-state.ts` (L71 fallback when plugins.entries.memory-core present). Bundled discovery loads `extensions/memory-core/index.ts`, which wires `memory_search` / `memory_get` tools and registers the `memory` CLI via `api.runtime.tools.registerMemoryCli`. | `pnpm-workspace.yaml` `extensions/*`; `package.json` `files[]` `extensions/**` (L48); referenced by `scripts/e2e/Dockerfile` (L17 `COPY extensions/memory-core`) | `src/plugins/loader.test.ts` (L150–L207), `src/plugins/slots.test.ts` (L10–L34), `src/plugins/config-state.test.ts` (L8,L43,L50) | yes — backs the v0 goal lessons / memory slot via the `memory` CLI and `memory_search`/`memory_get` tools | keep | `pnpm exec tsc`, `pnpm build`, `pnpm lint`, `pnpm vitest run src/plugins/ src/memory/` |
| `extensions/googlechat/` | First-class chat channel: `src/channels/registry.ts` L7 `CHAT_CHANNEL_ORDER = ["telegram", "googlechat"]`, L33–L42 `CHAT_CHANNEL_META.googlechat`, L45–L48 aliases (`google-chat`, `gchat`); `src/channels/dock.ts` L104–L160 `DOCKS.googlechat`; `src/channels/plugins/group-mentions.ts` L86,L97 hardcoded googlechat resolvers; `src/config/types.googlechat.ts`; auto-enabled in `src/config/plugin-auto-enable.ts` via the generic channel-config branch. Bundled discovery loads `extensions/googlechat/index.ts`. | `pnpm-workspace.yaml` `extensions/*`; `package.json` `files[]` `extensions/**` (L48); `extensions/googlechat/package.json` declares dep `google-auth-library@^10.5.0` | `src/channels/registry.test.ts` (L12,L13,L19), `src/channels/plugins/index.test.ts` (L36,L44) | no — not part of SmithersBot v0 (Telegram-only); but coupled into the dock and registry as a first-class channel | defer (constraint: removal needs `CHAT_CHANNEL_ORDER`/`DOCKS`/`group-mentions`/`registry` refactor) | `pnpm exec tsc`, `pnpm build`, `pnpm vitest run src/channels/ src/config/plugin-auto-enable.test.ts` after any later quarantine |
| `extensions/bluebubbles/` | Deep hooks in core: `src/channels/plugins/status-issues/bluebubbles.ts` (L1–L100 `collectBlueBubblesStatusIssues`); `src/channels/plugins/group-mentions.ts` L107–L114,L132–L145 `resolveBlueBubblesGroupRequireMention`/`ToolPolicy`; `src/auto-reply/chunk.test.ts` L368 `resolveChunkMode(undefined, "bluebubbles")`; `src/config/schema.ts` L302,L324,L675–L676 labels & DM policy strings. Bundled discovery loads `extensions/bluebubbles/index.ts`. | `pnpm-workspace.yaml` `extensions/*`; `package.json` `files[]` `extensions/**`; `extensions/bluebubbles/package.json` declares `moltbot.channel` (preferOver `imessage`); appears in `.github/labeler.yml` L4 | `extensions/bluebubbles/src/*.test.ts` (actions, attachments, chat, monitor, reactions, send, targets) | no — not v0 | defer (constraint: removal needs status-issues + group-mentions + schema refactor) | `pnpm exec tsc`, `pnpm build`, `pnpm vitest run src/channels/plugins/status-issues/ src/auto-reply/chunk.test.ts` after any later quarantine |
| `extensions/matrix/` | Only soft refs: `src/infra/outbound/outbound-session.ts` (L139,L148,L479 `case "matrix"`); `src/gateway/test-helpers.mocks.ts` L99–L101 stub plugin; `src/config/schema.test.ts` L56 fixture id; `src/infra/outbound/deliver.test.ts` L90–L126 fixtures. No `src/channels/registry.ts`, `dock.ts`, or `plugin-auto-enable` PROVIDER_PLUGIN_IDS hardcoded entry. Bundled discovery loads `extensions/matrix/index.ts`. | `pnpm-workspace.yaml` `extensions/*`; `package.json` `files[]` `extensions/**`; `extensions/matrix/package.json` declares deps `@matrix-org/matrix-sdk-crypto-nodejs`, `@vector-im/matrix-bot-sdk`, `music-metadata`; `.github/labeler.yml` L12 | `extensions/matrix/src/*.test.ts` slice (lives inside the extension) | no — not v0 | quarantine-now (no `src/` hardcoded extension import; outbound-session `case "matrix"` becomes dead-code on quarantine but does not crash; Track F moves to `extensions/_deferred/matrix/`) | `pnpm exec tsc`, `pnpm build`, `pnpm vitest run src/infra/outbound/ src/gateway/` after quarantine |
| `extensions/mattermost/` | Hardcoded config schema labels & descriptions: `src/config/schema.ts` L299 `"channels.mattermost"`, L342–L346 `botToken`/`baseUrl`/`chatmode`/`oncharPrefixes`/`requireMention`, L474–L481 descriptions, L606 configWrites note, L698 example. `src/infra/outbound/outbound-session.ts` does not list it. Bundled discovery loads `extensions/mattermost/index.ts`. | `pnpm-workspace.yaml` `extensions/*`; `package.json` `files[]` `extensions/**`; `.github/labeler.yml` L16 | `extensions/mattermost/src/*.test.ts` (lives inside the extension) | no — not v0 | defer (constraint: removal needs `src/config/schema.ts` label/description refactor) | `pnpm exec tsc`, `pnpm build`, `pnpm vitest run src/config/` after any later cleanup |
| `extensions/msteams/` | Hardcoded references: `src/config/schema.ts` L303 `"channels.msteams"`, L616 configWrites note; `src/channels/plugins/load.test.ts` L24–L72 entire fixture suite uses `id: "msteams"`; `src/channels/plugins/catalog.test.ts` L10,L17; `src/config/config.msteams.test.ts` (dedicated test); `src/agents/pi-embedded-runner.get-dm-history-limit-from-session-key.falls-back-provider-default-per-dm-not.test.ts`. Bundled discovery loads `extensions/msteams/index.ts`. | `pnpm-workspace.yaml` `extensions/*`; `package.json` `files[]` `extensions/**`; `extensions/msteams/package.json` declares deps `@microsoft/agents-hosting*` + transitive `express`/`proper-lockfile`; `.github/labeler.yml` L20 | `extensions/msteams/src/*.test.ts` slice; root tests above | no — not v0 | defer (constraint: removal needs `src/config/schema.ts` + `src/channels/plugins/{load,catalog}.test.ts` rework + `src/config/config.msteams.test.ts` deletion) | `pnpm exec tsc`, `pnpm build`, `pnpm vitest run src/config/ src/channels/plugins/` after any later cleanup |
| `extensions/nextcloud-talk/` | Only soft refs: `src/infra/outbound/outbound-session.ts` (L288,L487 `case "nextcloud-talk"`); `src/agents/pi-embedded-runner.get-dm-history-limit-from-session-key.returns-undefined-sessionkey-is-undefined.test.ts` (L173,L192) fixture id. No registry/dock/schema hardcoded entry. Bundled discovery loads `extensions/nextcloud-talk/index.ts`. | `pnpm-workspace.yaml` `extensions/*`; `package.json` `files[]` `extensions/**`; `.github/labeler.yml` L24 | `extensions/nextcloud-talk/src/*.test.ts` (inside the extension) | no — not v0 | quarantine-now (outbound-session `case "nextcloud-talk"` becomes dead on quarantine but does not crash; Track F moves to `extensions/_deferred/nextcloud-talk/`) | `pnpm exec tsc`, `pnpm build`, `pnpm vitest run src/infra/outbound/` after quarantine |
| `extensions/nostr/` | Only soft refs: `src/infra/outbound/outbound-session.ts` (L360,L366,L493 `case "nostr"`). No `src/channels/registry.ts`, `dock.ts`, or `plugin-auto-enable` hardcoded entry. Bundled discovery loads `extensions/nostr/index.ts`. | `pnpm-workspace.yaml` `extensions/*`; `package.json` `files[]` `extensions/**`; `extensions/nostr/package.json` declares `nostr-tools@^2.20.0`; `.github/labeler.yml` L28 | `extensions/nostr/test/*.test.ts` (inside the extension) | no — not v0 | quarantine-now (outbound-session `case "nostr"` becomes dead on quarantine; Track F moves to `extensions/_deferred/nostr/`) | `pnpm exec tsc`, `pnpm build`, `pnpm vitest run src/infra/outbound/` after quarantine |
| `extensions/tlon/` | Only soft refs: `src/infra/outbound/outbound-session.ts` (L389,L425,L495 `case "tlon"`). No registry/dock/schema hardcoded entry. Bundled discovery loads `extensions/tlon/index.ts`. | `pnpm-workspace.yaml` `extensions/*`; `package.json` `files[]` `extensions/**`; `extensions/tlon/package.json` declares deps `@urbit/aura`, `@urbit/http-api`; `.github/labeler.yml` L37 | `extensions/tlon/src/*.test.ts` (inside the extension) | no — not v0 | quarantine-now (outbound-session `case "tlon"` becomes dead on quarantine; Track F moves to `extensions/_deferred/tlon/`) | `pnpm exec tsc`, `pnpm build`, `pnpm vitest run src/infra/outbound/` after quarantine |
| `extensions/voice-call/` | Direct test import: `src/plugins/voice-call.plugin.test.ts` L17 `vi.mock("../../extensions/voice-call/src/runtime.js", …)` + L21 `import plugin from "../../extensions/voice-call/index.js"`. `src/plugins/install.test.ts` L118–L119 expects targetDir `extensions/voice-call`; `src/plugins/discovery.test.ts` L131 asserts id list contains `voice-call`. Bundled discovery loads `extensions/voice-call/index.ts`. | `pnpm-workspace.yaml` `extensions/*`; `package.json` `files[]` `extensions/**`; `extensions/voice-call/package.json` declares `@sinclair/typebox`, `ws`, `zod` deps; `.github/labeler.yml` L41 | `src/plugins/voice-call.plugin.test.ts` (root-side); `extensions/voice-call/src/*.test.ts` slice | no — not v0 | defer (constraint: removal needs root-side test deletion + `src/plugins/{install,discovery}.test.ts` updates — coupled refactor) | `pnpm exec tsc`, `pnpm build`, `pnpm vitest run src/plugins/ extensions/voice-call/` after later cleanup |
| `extensions/zalo/` | Multiple soft refs: `src/infra/outbound/outbound-session.ts` (L305,L315,L489 `case "zalo"`); `src/cli/pairing-cli.test.ts` L111–L114 exercises `pairing list zalo`; `src/gateway/test-helpers.mocks.ts` L104–L106 stub plugin; `src/commands/onboarding/plugin-install.test.ts` L27–L40 uses `id: "zalo"`, `localPath: "extensions/zalo"`, plus L99,L179 `expectedPath = path.resolve(process.cwd(), "extensions/zalo")` (mocked `fs.existsSync`, not a real read). Bundled discovery loads `extensions/zalo/index.ts`. | `pnpm-workspace.yaml` `extensions/*`; `package.json` `files[]` `extensions/**`; `extensions/zalo/package.json` declares `undici@7.19.0`; `.github/labeler.yml` L45 | `extensions/zalo/src/*.test.ts` slice; `src/cli/pairing-cli.test.ts`; `src/commands/onboarding/plugin-install.test.ts` | no — not v0 | defer (multi-file test coupling: `src/cli/pairing-cli.test.ts`, `src/commands/onboarding/plugin-install.test.ts`, `src/gateway/test-helpers.mocks.ts` all reference it by id) | `pnpm exec tsc`, `pnpm build`, `pnpm vitest run src/cli/pairing-cli.test.ts src/commands/onboarding/ src/infra/outbound/` after later cleanup |
| `extensions/zalouser/` | Only soft refs: `src/infra/outbound/outbound-session.ts` (L332,L343,L491 `case "zalouser"`); `src/infra/outbound/outbound-session.test.ts` L72 fixture; `src/gateway/test-helpers.mocks.ts` L109–L111 stub plugin. No registry/dock/schema hardcoded entry. Bundled discovery loads `extensions/zalouser/index.ts`. | `pnpm-workspace.yaml` `extensions/*`; `package.json` `files[]` `extensions/**`; `extensions/zalouser/package.json` declares `@sinclair/typebox` dep; `.github/labeler.yml` L49 | `extensions/zalouser/src/*.test.ts` slice; root-side `src/infra/outbound/outbound-session.test.ts` | no — not v0 | quarantine-now (outbound-session `case "zalouser"` becomes dead on quarantine; root-side test fixture only references the string id, not the extension module; Track F moves to `extensions/_deferred/zalouser/` and adjusts `src/gateway/test-helpers.mocks.ts` if needed) | `pnpm exec tsc`, `pnpm build`, `pnpm vitest run src/infra/outbound/ src/gateway/` after quarantine |
| `extensions/copilot-proxy/` | Provider-auth coupling: `src/config/plugin-auto-enable.ts` L35 `PROVIDER_PLUGIN_IDS` maps pluginId `copilot-proxy` → providerId `copilot-proxy`; `src/commands/auth-choice.apply.copilot-proxy.ts` L8–L13 binds `authChoice: "copilot-proxy"`, `pluginId: "copilot-proxy"`; wired into `src/commands/auth-choice.apply.ts` L6; option exposed by `src/commands/auth-choice-options.ts` L85,L180–L183. Bundled discovery loads `extensions/copilot-proxy/index.ts`. | `pnpm-workspace.yaml` `extensions/*`; `package.json` `files[]` `extensions/**`; `.github/labeler.yml` L111 | None inside the extension (just `index.ts`); covered indirectly by `src/config/plugin-auto-enable.test.ts` | no — not v0 (v0 auth surface is the Telegram-controlled goal worker, not a provider catalog) | defer (constraint: removal needs `src/commands/auth-choice.apply.copilot-proxy.ts`, `auth-choice.apply.ts`, `auth-choice-options.ts`, and `plugin-auto-enable.ts` PROVIDER_PLUGIN_IDS cleanup) | `pnpm exec tsc`, `pnpm build`, `pnpm vitest run src/commands/auth-choice* src/config/plugin-auto-enable.test.ts` after later cleanup |
| `extensions/google-antigravity-auth/` | Provider-auth coupling: `src/config/plugin-auto-enable.ts` L32 maps pluginId `google-antigravity-auth` → providerId `google-antigravity` (test: `plugin-auto-enable.test.ts` L37–L47 asserts auto-enable); `src/commands/auth-choice.apply.google-antigravity.ts` L8–L10 binds pluginId; wired into `src/commands/auth-choice.apply.ts` L8; option exposed by `src/commands/auth-choice-options.ts` L79,L163–L167. Bundled discovery loads `extensions/google-antigravity-auth/index.ts`. | `pnpm-workspace.yaml` `extensions/*`; `package.json` `files[]` `extensions/**`; `.github/labeler.yml` L115 | None inside the extension; covered indirectly by `src/config/plugin-auto-enable.test.ts` L37–L47 | no — not v0 | defer (same coupled auth-choice refactor as copilot-proxy) | `pnpm exec tsc`, `pnpm build`, `pnpm vitest run src/commands/auth-choice* src/config/plugin-auto-enable.test.ts` after later cleanup |
| `extensions/google-gemini-cli-auth/` | Provider-auth coupling: `src/config/plugin-auto-enable.ts` L33 maps pluginId → providerId `google-gemini-cli`; `src/commands/auth-choice.apply.google-gemini-cli.ts` binds pluginId; wired into `src/commands/auth-choice.apply.ts` L9; option exposed by `src/commands/auth-choice-options.ts` L79,L168–L172. Extension ships an `oauth.test.ts`. Bundled discovery loads `extensions/google-gemini-cli-auth/index.ts`. | `pnpm-workspace.yaml` `extensions/*`; `package.json` `files[]` `extensions/**`; `.github/labeler.yml` L119 | `extensions/google-gemini-cli-auth/oauth.test.ts` | no — not v0 | defer (same coupled auth-choice refactor) | `pnpm exec tsc`, `pnpm build`, `pnpm vitest run src/commands/auth-choice* extensions/google-gemini-cli-auth/` after later cleanup |
| `extensions/qwen-portal-auth/` | Provider-auth coupling: `src/config/plugin-auto-enable.ts` L34 maps pluginId → providerId `qwen-portal`; `src/commands/auth-choice.apply.qwen-portal.ts` binds pluginId; wired into `src/commands/auth-choice.apply.ts` L13; option exposed by `src/commands/auth-choice-options.ts` L61,L178; `src/commands/onboard-non-interactive/local/auth-choice.ts` L383 references the `qwen-portal` flow. Has no `package.json` (only `clawdbot.plugin.json` + `index.ts` + `oauth.ts` + `README.md`). Bundled discovery loads `extensions/qwen-portal-auth/index.ts`. | `pnpm-workspace.yaml` `extensions/*` (note: no package.json → pnpm will warn that the directory is not a workspace package, but discovery still loads `index.ts`); `package.json` `files[]` `extensions/**`; `.github/labeler.yml` L127 | None inside the extension (no test file) | no — not v0 | defer (same coupled auth-choice refactor; also missing `package.json` — a future cleanup pass should either add one or quarantine) | `pnpm exec tsc`, `pnpm build`, `pnpm vitest run src/commands/auth-choice*` after later cleanup |

### Section 4 summary

- `keep` (2): `extensions/telegram/`, `extensions/memory-core/` — both are explicit v0 dependencies (Telegram channel + default memory slot for goal lessons).
- `quarantine-now` (5): `extensions/matrix/`, `extensions/nextcloud-talk/`, `extensions/nostr/`, `extensions/tlon/`, `extensions/zalouser/` — no `src/`-side hardcoded import; only `src/infra/outbound/outbound-session.ts` dispatch `case` strings that simply route nothing once the extension is gone. Track F should `git mv` to `extensions/_deferred/<name>/` and update `pnpm-workspace.yaml` / `package.json` `files[]` / `.github/labeler.yml` in the same commit.
- `defer` (10): `extensions/googlechat/`, `extensions/bluebubbles/`, `extensions/mattermost/`, `extensions/msteams/`, `extensions/voice-call/`, `extensions/zalo/`, `extensions/copilot-proxy/`, `extensions/google-antigravity-auth/`, `extensions/google-gemini-cli-auth/`, `extensions/qwen-portal-auth/` — each requires coupled cleanup (channel registry/dock, config schema labels, auth-choice apply chain, or root-side direct imports). Per the task constraint "Defer (not delete-now) any extension whose removal needs plugin-framework refactor", these stay in place this round.

## 5. Skills

Grep scopes searched: `src/agents/skills-install.ts`, `src/agents/skills/**`,
`src/cli/skills-cli*.ts`, `src/**/*.test.ts`, `src/commands/**`, `scripts/**`,
`package.json`, `pnpm-workspace.yaml`, `vitest.config.ts`.

Runtime discovery summary: `skills/` is **not** name-enumerated anywhere in
`src/`. `src/agents/skills/bundled-dir.ts` (`resolveBundledSkillsDir`) walks
`<packageRoot>/skills/` and `src/agents/skills/workspace.ts` merges the
directory listing into `SkillEntry[]` (precedence: extra < bundled < managed <
workspace). There is no per-skill `package.json`, no entry in
`pnpm-workspace.yaml`, no entry in `vitest.config.ts`, no hardcoded import.

`package.json` `files[]` ships **all** of `skills/**` (L51) — every kept skill
will be in the published tarball.

Practical implication: removing any directory under `skills/` only removes its
appearance from the merged skill prompt. No `src/` import will break; the only
test-side coupling is named-skill references in two test files (called out
per-row below).

v0 reminder: SmithersBot v0 = Telegram control, `/new_goal` planning +
execution, repo chat, goal status/list/resume/stop, goal lessons/memory,
external verification, Nightwatch, local CLI debug. None of the 52 skills
have a concrete v0 runtime consumer.

| PATH | IMPORTERS | PACKAGE/WORKSPACE/VITEST REFS | TESTS | REQUIRED BY v0? | DECISION | VERIFICATION NEEDED |
| --- | --- | --- | --- | --- | --- | --- |
| `skills/peekaboo/` | none in `src/` (`src/cli/nodes-cli/rpc.ts:42-44` mentions "peekaboo bridge" — that is a separate signed-socket UI bridge, not the skill). `src/cli/skills-cli.test.ts:252-270` has a `"formats info for a real bundled skill (peekaboo)"` test that calls `resolveBundledSkillsDir()`, looks up `report.skills.find((s) => s.name === "peekaboo")`, and **soft-skips** if not present (`if (!peekaboo) return;`). | `package.json` `files[]` `skills/**` (L51); no per-skill workspace/vitest entry | `src/cli/skills-cli.test.ts` (soft-skip — passes even if removed) | no — discovery-only; soft-skip test does not require it | defer (only "real bundled skill" name-referenced in tests; track-g-skills should update that test in the same commit if the skill is removed) | `pnpm vitest run src/cli/skills-cli.test.ts` after any change |
| `skills/nano-banana-pro/` | none in `src/` runtime. `src/agents/skills.build-workspace-skills-prompt.syncs-merged-skills-into-target-workspace.test.ts:79-105` writes a fixture skill literally named `nano-banana-pro` to a tmpdir; the test does not load `skills/nano-banana-pro/` from the repo. | `package.json` `files[]` `skills/**` (L51); no other refs | only the in-memory fixture above | no | quarantine-now (the test fixture name does not depend on the repo skill; safe to delete-now, but plan default for skills with any name ref is quarantine) | `pnpm vitest run src/agents/skills.build-workspace-skills-prompt.*` |
| `skills/mcporter/` | none in `src/` for the skill content itself. `src/commands/docs.ts:164` invokes the external `mcporter` binary via `runTool("mcporter", [...])` — that resolves a binary on PATH, not the bundled skill markdown. | `package.json` `files[]` `skills/**` (L51); no other refs | none | no — skill is documentation; the docs command uses the `mcporter` binary directly | quarantine-now (skill is a documentation companion to the external CLI, but no code path requires the markdown) | `pnpm exec tsc`, `pnpm vitest run src/commands/docs*` |
| `skills/canvas/` | none in `src/` (matches in `src/canvas-host/**` and `src/gateway/**` are for the canvas-host subsystem, not the skill markdown). | `package.json` `files[]` `skills/**` (L51); no other refs | none | no — skill is documentation that mentions canvas-host; runtime canvas-host uses `src/canvas-host/` + `src/agents/tools/canvas-tool.ts`, not this markdown | quarantine-now (paired with `src/canvas-host/` decision in section 3; skill can be quarantined independently because no code imports it) | `pnpm exec tsc`, `pnpm vitest run src/canvas-host/ src/agents/tools/canvas-tool*` |
| `skills/voice-call/` | none in `src/`. Paired with `extensions/voice-call/` which is `defer` per section 4. | `package.json` `files[]` `skills/**` (L51) | none | no | defer (paired with `extensions/voice-call/` which is deferred per section 4) | `pnpm exec tsc`, `pnpm vitest run src/plugins/voice-call*` |
| `skills/coding-agent/` | none in `src/`. Skill describes how to invoke Codex/Claude Code/Pi via bash with PTY — overlaps with the goal-worker CLI surface (`src/goal/cli-worker.ts`) but no code path imports the markdown. | `package.json` `files[]` `skills/**` (L51) | none | no — overlaps conceptually with the goal-worker CLI surface but is not load-bearing | quarantine-now (borderline-useful for goal workers; quarantine rather than delete so a future track can revisit) | `pnpm exec tsc` |
| `skills/skill-creator/` | none in `src/`. Skill is a meta-guide for authoring AgentSkills. | `package.json` `files[]` `skills/**` (L51) | none | no — meta-documentation; not part of v0 product surface | quarantine-now (low risk; quarantine because a future "build your own skill" docs story might want it back) | `pnpm exec tsc` |
| `skills/session-logs/` | none in `src/`. Skill instructs the agent how to grep `~/.clawdbot/agents/<agentId>/sessions/` with jq/rg. | `package.json` `files[]` `skills/**` (L51) | none | no — overlaps with goal sessions concept but is not load-bearing | quarantine-now (borderline-useful inside repo chat / goal workers; quarantine rather than delete) | `pnpm exec tsc` |
| `skills/summarize/` | none in `src/` (the matches under `src/auto-reply/reply/queue/**` are for the `summarize` field on the reply queue type, not the skill markdown). | `package.json` `files[]` `skills/**` (L51) | none | no | quarantine-now | `pnpm exec tsc` |
| `skills/model-usage/` | none in `src/`. Skill documents how the agent should report model usage. | `package.json` `files[]` `skills/**` (L51) | none | no | quarantine-now | `pnpm exec tsc` |
| `skills/1password/` | none in `src/`. Personal-vault skill. | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now (clear out-of-scope personal productivity surface) | `pnpm exec tsc` |
| `skills/apple-notes/` | none in `src/`. macOS Notes integration. | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/apple-reminders/` | none in `src/`. macOS Reminders integration. | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/bear-notes/` | none in `src/`. Bear (macOS notes app) integration. | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/bird/` | none in `src/`. (Bird AI assistant CLI helper.) | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/blogwatcher/` | none in `src/`. RSS / blog watcher utility. | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/blucli/` | none in `src/`. Bluetooth CLI helper. | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/bluebubbles/` | none in `src/` for the skill markdown (matches in `src/channels/plugins/**` are for the BlueBubbles channel plugin, not the skill). Paired with `extensions/bluebubbles/` which is `defer` per section 4. | `package.json` `files[]` `skills/**` (L51) | none | no | defer (paired with `extensions/bluebubbles/` deferred decision; remove together once channel coupling is unwound) | `pnpm exec tsc` |
| `skills/camsnap/` | none in `src/`. macOS camera snapshot helper. | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/clawdhub/` | none in `src/`. Pre-rename "Clawd Hub" tooling. | `package.json` `files[]` `skills/**` (L51) | none | no — legacy clawd branding | delete-now | `pnpm exec tsc` |
| `skills/discord/` | none in `src/` for the skill markdown (matches in `src/channels/**`, `src/infra/outbound/**` are for the Discord channel adapter, not the skill). | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now (Discord is not in v0; channel adapter is a separate concern owned by section 4 / future tracks) | `pnpm exec tsc` |
| `skills/eightctl/` | none in `src/`. Eight Sleep CLI helper. | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/food-order/` | none in `src/`. Food delivery helper. | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/gemini/` | none in `src/` for the skill markdown (matches in `src/media-understanding/**`, `src/memory/embeddings*` are for the Gemini AI provider identifier, not the skill). | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/gifgrep/` | none in `src/`. GIF search utility. | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/github/` | none in `src/` for the skill markdown. (Repo-level `.github/` is unrelated.) | `package.json` `files[]` `skills/**` (L51) | none | no — v0 repo chat does not depend on a "github" agent skill; SmithersBot v0 is GitHub-first as a hosting story, not a per-conversation tool | quarantine-now (borderline: a future track might revive this skill if /new_goal grows GitHub-aware behavior — quarantine instead of delete) | `pnpm exec tsc` |
| `skills/gog/` | none in `src/` for the skill markdown (matches in `src/hooks/gmail-*` are for the gmail hook, not this skill). | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/goplaces/` | none in `src/`. Google Places lookup helper. | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/himalaya/` | none in `src/`. Himalaya CLI email helper. | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/imsg/` | none in `src/` for the skill markdown (matches in `src/channels/registry.test.ts`, `src/gateway/server.agent.gateway-server-agent-b.e2e.test.ts`, `src/cli/pairing-cli.test.ts` are for the iMessage channel/source identifier, not the skill). | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/local-places/` | none in `src/`. macOS Maps / local-search helper. | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/notion/` | none in `src/`. Notion integration. | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/obsidian/` | none in `src/`. Obsidian integration. | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/openai-image-gen/` | none in `src/`. (Distinct from any image-gen tool wired into the agent.) | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/openai-whisper/` | none in `src/`. | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/openai-whisper-api/` | none in `src/`. | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/openhue/` | none in `src/`. Philips Hue CLI. | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/oracle/` | none in `src/`. | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/ordercli/` | none in `src/`. | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/sag/` | none in `src/`. | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/sherpa-onnx-tts/` | none in `src/` for the skill markdown (TTS infrastructure lives under `src/tts/` and does not require this skill's documentation). | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/slack/` | none in `src/` for the skill markdown (matches in `src/channels/**`, `src/infra/outbound/**`, `src/auto-reply/**` are for the Slack channel adapter, not the skill). | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now (Slack is not in v0) | `pnpm exec tsc` |
| `skills/songsee/` | none in `src/`. | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/sonoscli/` | none in `src/`. Sonos CLI helper. | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/spotify-player/` | none in `src/`. | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/things-mac/` | none in `src/`. Things 3 (macOS) integration. | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/tmux/` | none in `src/`. | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/trello/` | none in `src/`. | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/video-frames/` | none in `src/`. (Distinct from any media tool wired into the agent.) | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/wacli/` | none in `src/`. WhatsApp CLI helper. | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/weather/` | none in `src/` for the skill markdown (matches in `src/gateway/**` are unrelated test fixtures named "weather"). | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |
| `skills/nano-pdf/` | none in `src/`. PDF helper. | `package.json` `files[]` `skills/**` (L51) | none | no | delete-now | `pnpm exec tsc` |

### Section 5 summary

- `keep` (0): no skill has a concrete v0 runtime consumer (no `src/` import,
  no test that fails when the skill is removed).
- `defer` (3): `skills/peekaboo/` (named in a soft-skip test that should be
  cleaned in the same commit), `skills/voice-call/` (paired with the
  deferred `extensions/voice-call/`), `skills/bluebubbles/` (paired with the
  deferred `extensions/bluebubbles/`).
- `quarantine-now` (10): `skills/nano-banana-pro/`, `skills/mcporter/`,
  `skills/canvas/`, `skills/coding-agent/`, `skills/skill-creator/`,
  `skills/session-logs/`, `skills/summarize/`, `skills/model-usage/`,
  `skills/github/`, plus follow-up borderline cases — all borderline-useful
  or paired with a borderline subsystem; quarantine into
  `skills/_deferred/<name>/` so Track G can revisit without a hard delete.
- `delete-now` (39): all remaining personal-productivity / device /
  third-party-service skills (`1password`, `apple-notes`, `apple-reminders`,
  `bear-notes`, `bird`, `blogwatcher`, `blucli`, `camsnap`, `clawdhub`,
  `discord`, `eightctl`, `food-order`, `gemini`, `gifgrep`, `gog`,
  `goplaces`, `himalaya`, `imsg`, `local-places`, `nano-pdf`, `notion`,
  `obsidian`, `openai-image-gen`, `openai-whisper`, `openai-whisper-api`,
  `openhue`, `oracle`, `ordercli`, `sag`, `sherpa-onnx-tts`, `slack`,
  `songsee`, `sonoscli`, `spotify-player`, `things-mac`, `tmux`, `trello`,
  `video-frames`, `wacli`, `weather`). No `src/` importer, no test
  reference, not aligned with the v0 surface. Track G should `git rm -r` and
  drop the matching `skills/<name>/` reference (there are no such hardcoded
  refs anywhere in `package.json`/`pnpm-workspace.yaml`/`vitest.config.ts`
  beyond the blanket `skills/**` files glob, so the surface naturally
  shrinks).

## 6. Hooks

Grep scopes searched: `src/hooks/loader.ts`, `src/hooks/bundled-dir.ts`,
`src/hooks/workspace.ts`, `src/config/**`, `src/goal/**`, `src/telegram/**`,
`src/agents/**`, `src/gateway/**`, `src/commands/**`, `scripts/**`,
`package.json`, `pnpm-workspace.yaml`. **All hook decisions below cite the
present-day grep results, not the Stage 2F ledger.**

Runtime discovery summary: `src/hooks/bundled-dir.ts` (`resolveBundledHooksDir`)
walks `<packageRoot>/dist/hooks/bundled/` (npm install) or
`<packageRoot>/src/hooks/bundled/` (dev). `src/hooks/loader.ts:36-80` loads
every directory it finds, gated by `cfg.hooks?.internal?.enabled === true`
(`src/hooks/loader.ts:38`). Each hook is then individually gated by
`cfg.hooks.internal.entries.<name>.enabled` (`src/hooks/config.ts:82`).
There is no name-by-name import in `src/` outside the bundled directories
themselves. `scripts/copy-hook-metadata.ts` enumerates by directory listing
(not by name) so removing any hook directory shrinks both the source and the
build artifact uniformly.

`gateway:startup` event is emitted at `src/gateway/server-startup.ts:145`.
`agent:bootstrap`, `command`, and `command:new` events are emitted via
`registerInternalHook(...)` / `dispatchInternalHook(...)` from
`src/hooks/internal-hooks.ts` (test coverage at `src/hooks/internal-hooks.test.ts`).

| PATH | IMPORTERS | PACKAGE/WORKSPACE/VITEST REFS | TESTS | REQUIRED BY v0? | DECISION | VERIFICATION NEEDED |
| --- | --- | --- | --- | --- | --- | --- |
| `src/hooks/bundled/boot-md/` | Loaded only via dynamic discovery (`src/hooks/loader.ts:61-68` → `pathToFileURL(entry.hook.handlerPath)`). The handler imports `runBootOnce` from `src/gateway/boot.ts` (`src/hooks/bundled/boot-md/handler.ts:4`). No other code in `src/config/**`, `src/goal/**`, `src/telegram/**`, or tests references `"boot-md"` by name. `src/gateway/boot.ts` and its test exist but are only consumed by this hook. | No package.json/vitest entry; `scripts/copy-hook-metadata.ts` enumerates by directory walk; `src/hooks/bundled/README.md` lists it as "deferred/internal-only". | `src/gateway/boot.test.ts` covers `runBootOnce`; no test of the handler itself. | no — v0 surface (Telegram control, `/new_goal`, repo chat, goal lessons, Nightwatch) does not need a workspace BOOT.md checklist | quarantine-now (move `src/hooks/bundled/boot-md/` to `src/hooks/_deferred/bundled/boot-md/`; leave `src/gateway/boot.ts` for follow-up since its only consumer becomes the quarantined hook) | `pnpm exec tsc`, `pnpm build`, `pnpm lint`, `pnpm vitest run src/hooks/ src/gateway/boot*` after move |
| `src/hooks/bundled/command-logger/` | Loaded only via dynamic discovery. The handler imports stdlib only (`node:fs/promises`, `node:path`, `node:os`) and the local `HookHandler` type. No code in `src/config/**`, `src/goal/**`, `src/telegram/**`, or tests references `"command-logger"` by name outside `src/hooks/frontmatter.test.ts:67-82` (frontmatter-parsing fixture that just reuses the string label and does not depend on the hook directory existing) and `src/commands/onboard-hooks.test.ts:81-143` (fixture for an in-memory hook list). | No package.json/vitest entry; `scripts/copy-hook-metadata.ts` enumerates by directory walk; `src/hooks/bundled/README.md` lists it as "deferred/internal-only". | `src/hooks/frontmatter.test.ts` (fixture string only); `src/commands/onboard-hooks.test.ts` (in-memory fixture). Neither asserts the hook directory exists. | no — appends every command to `~/.clawdbot/logs/commands.log`; not part of the stated v0 product surface | quarantine-now (move to `src/hooks/_deferred/bundled/command-logger/`; update the frontmatter-test fixture inline if its string-label reference is unbalanced — current evidence shows it is not load-bearing) | `pnpm exec tsc`, `pnpm build`, `pnpm vitest run src/hooks/ src/commands/onboard-hooks.test.ts` after move |
| `src/hooks/bundled/session-memory/` | Loaded only via dynamic discovery. The handler imports `resolveAgentWorkspaceDir`, `resolveAgentIdFromSessionKey`, `resolveHookConfig` (`src/hooks/bundled/session-memory/handler.ts:11-15`). No code in `src/config/**`, `src/goal/**`, `src/telegram/**`, or tests references `"session-memory"` by name outside the bundled directory itself (`handler.test.ts`, `HOOK.md`) plus the same frontmatter/CLI/onboard test fixtures noted above (`src/hooks/frontmatter.test.ts:40`, `src/cli/hooks-cli.test.ts:10-20`, `src/markdown/frontmatter.test.ts:22`). | No package.json/vitest entry; `scripts/copy-hook-metadata.ts` enumerates by directory walk; `src/hooks/bundled/README.md` lists it as "deferred/internal-only". | `src/hooks/bundled/session-memory/handler.test.ts` (9 cases covering slug generation and file writes); fixture-only references in `src/cli/hooks-cli.test.ts` and `src/hooks/frontmatter.test.ts`. | no — writes `<workspace>/memory/YYYY-MM-DD-slug.md` on `/new`; this is the **old** session-memory pipeline, distinct from the v0 goal lessons / `extensions/memory-core/` store. The lesson "Do not confuse old session-memory with goal lessons" applies. | quarantine-now (move to `src/hooks/_deferred/bundled/session-memory/`; the handler test moves with it; update fixture string labels in the same commit only if a test fails — current evidence is they use string ids, not directory lookups) | `pnpm exec tsc`, `pnpm build`, `pnpm vitest run src/hooks/ src/cli/hooks-cli.test.ts src/commands/onboard-hooks.test.ts` after move |
| `src/hooks/bundled/soul-evil/` | Loaded only via dynamic discovery. The handler imports `applySoulEvilOverride`, `resolveSoulEvilConfigFromHook` from `../../soul-evil.js` (`src/hooks/bundled/soul-evil/handler.ts:5`). No `src/config/**`, `src/goal/**`, `src/telegram/**` reference. | No package.json/vitest entry; `scripts/copy-hook-metadata.ts` enumerates by directory walk; `src/hooks/bundled/README.md` lists it as "deferred/internal-only". | `src/hooks/bundled/soul-evil/handler.test.ts`; the top-level `src/hooks/soul-evil.test.ts` covers `applySoulEvilOverride` itself. | no — joke/persona hook that swaps `SOUL.md` with `SOUL_EVIL.md` on a daily window or by chance; not part of v0 | quarantine-now (move `src/hooks/bundled/soul-evil/` to `src/hooks/_deferred/bundled/soul-evil/`; pair with `src/hooks/soul-evil.ts` below) | `pnpm exec tsc`, `pnpm build`, `pnpm vitest run src/hooks/` after move |
| `src/hooks/soul-evil.ts` (top-level) | Imported only by `src/hooks/bundled/soul-evil/handler.ts:5` and its own test `src/hooks/soul-evil.test.ts:10`. Confirmed by grep `from ["'].*/?soul-evil(\.js\|\.ts)?["']` across `src/` — exactly two hits, both inside the soul-evil hook surface. | none beyond inclusion via `dist/hooks/**` files glob | `src/hooks/soul-evil.test.ts` | no — paired with the bundled hook above | quarantine-now (move `src/hooks/soul-evil.ts` + `src/hooks/soul-evil.test.ts` to `src/hooks/_deferred/soul-evil.ts` / `.test.ts` in the same commit as the bundled directory move) | `pnpm exec tsc`, `pnpm build`, `pnpm vitest run src/hooks/` after move |

### Section 6 summary

- `keep` (0): none of the four bundled hooks (or the top-level `soul-evil.ts`)
  has a v0 importer per current grep.
- `quarantine-now` (5): `src/hooks/bundled/boot-md/`,
  `src/hooks/bundled/command-logger/`, `src/hooks/bundled/session-memory/`,
  `src/hooks/bundled/soul-evil/`, and top-level `src/hooks/soul-evil.ts`.
  Per plan constraint "DEFAULT IS QUARANTINE — `git mv` to
  `src/hooks/_deferred/<name>/` rather than delete unless evidence is
  unambiguous", and since fixture/onboard test strings still reference the
  hook names, Track J should move (not delete) and adjust those tests
  inline in the same commit if anything fails.
- `delete-now` (0): no hook is clearly safe to outright delete — all four
  have at least string-label refs in fixture tests, and the constraint
  blocks delete-now when evidence is mixed.
- `defer` (0): no hook needs deeper investigation; the discovery model is
  uniform and the import graph is shallow.

Notes for Track J:

1. After moving the four bundled hooks, prune `src/hooks/bundled/README.md`
   entries (it currently advertises all four as "deferred/internal-only" —
   the README itself should be updated or quarantined to keep the public
   surface honest).
2. `src/gateway/boot.ts` / `src/gateway/boot.test.ts` become unreferenced
   in `src/` once `boot-md` is quarantined; leave for a follow-up commit so
   the boot-md move stays scoped.
3. The frontmatter and onboard-hooks tests reference hook **strings**
   (`"session-memory"`, `"command-logger"`) but do not load real
   directories, so they should pass unchanged. Re-run
   `src/cli/hooks-cli.test.ts`, `src/commands/onboard-hooks.test.ts`,
   `src/hooks/frontmatter.test.ts`, `src/markdown/frontmatter.test.ts` to
   confirm.

## 7. Deploy

_To be populated in track-b5-evidence-deploy._

## 8. Package / Workspace / Test Config

_To be populated in track-b6-evidence-package-workspace._

## 9. CLI Subcommands

_To be populated in track-b7-evidence-cli._
