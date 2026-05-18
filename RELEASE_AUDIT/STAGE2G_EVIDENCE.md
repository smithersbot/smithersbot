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

Grep scopes searched: root, `src/**`, `scripts/**`, `package.json`, `README.md`,
`AGENTS.md`, `.github/**`. All paths below are tracked (verified via
`git ls-files`). Where a deletion needs paired in-tree edits (`package.json`
scripts, `.github/labeler.yml`, or a sibling test), the VERIFICATION NEEDED
column flags it so the downstream track (Track D — deploy cleanup) bundles
them into the same commit.

### 7a. Root-level deploy files

| PATH | IMPORTERS | PACKAGE/WORKSPACE/VITEST REFS | TESTS | REQUIRED BY v0? | DECISION | VERIFICATION NEEDED |
| --- | --- | --- | --- | --- | --- | --- |
| `Dockerfile` | `docker-compose.yml` (L31 `image: ${CLAWDBOT_IMAGE:-moltbot:local}` built from this); `fly.toml` (L8 `dockerfile = "Dockerfile"`); `fly.private.toml` (L16 `dockerfile = "Dockerfile"`); `scripts/test-live-models-docker.sh` (L16) and `scripts/test-live-gateway-models-docker.sh` (L16). No `src/` importer. | `.github/labeler.yml` L89 `"docker"` matcher includes `Dockerfile` and `Dockerfile.*` | — | no — public v0 product surface is Telegram + `/new_goal` + repo chat + Nightwatch + local CLI debug; the published Dockerfile is an unsupported hosted-deployment path | delete-now (Track D must also drop the `.github/labeler.yml` docker matcher block in the same commit) | `pnpm exec tsc`, `pnpm build`, `pnpm lint` after removal |
| `Dockerfile.sandbox` | `scripts/sandbox-setup.sh` (L6 `docker build -t "${IMAGE_NAME}" -f Dockerfile.sandbox .`); `scripts/sandbox-setup.sh` is referenced as `buildScript` by `src/commands/doctor-sandbox.ts` (L199) when `dockerImage === DEFAULT_SANDBOX_IMAGE` | `.github/labeler.yml` L90 covers `Dockerfile.*` | none directly; `src/commands/doctor-sandbox*.ts` tests exist | unclear — wired into the agent sandbox flow, which is consumed by goal workers via `src/agents/sandbox/*` (not strictly Telegram v0 but live in the codebase) | defer (paired with the agent-sandbox decision; deleting alone would break `scripts/sandbox-setup.sh` and the doctor-sandbox hint chain) | `pnpm vitest run src/commands/doctor-sandbox* src/agents/sandbox/` if removed later |
| `Dockerfile.sandbox-browser` | `scripts/sandbox-browser-setup.sh` (L6 `docker build -t "${IMAGE_NAME}" -f Dockerfile.sandbox-browser .`); the Dockerfile itself COPIES `scripts/sandbox-browser-entrypoint.sh` (L23); the build script is referenced as `buildScript` by `src/commands/doctor-sandbox.ts` (L215) and by error text in `src/agents/sandbox/browser.ts` (L75) | `.github/labeler.yml` L90 covers `Dockerfile.*` | none directly | unclear — sandbox-browser is the headless Chromium sandbox image used by the agent browser tooling; not Telegram v0 but live-wired into the agent path | defer (paired with the sandbox + browser-subsystem decisions; deleting before those would break `doctor-sandbox`) | `pnpm vitest run src/commands/doctor-sandbox* src/agents/sandbox/browser*` if removed later |
| `docker-compose.yml` | only referenced by `docker-setup.sh` (L5 `COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"`) and by the docker-stub used in `src/docker-setup.test.ts` (L21 `compose`) | `.github/labeler.yml` L91 | `src/docker-setup.test.ts` (exercises `docker-setup.sh` via a stubbed docker binary) | no — hosted-deployment composition; unsupported in v0 | delete-now (paired with `docker-setup.sh` and the test below in the same Track D commit) | `pnpm exec tsc`, `pnpm build`, `pnpm vitest run src/` after removing test |
| `docker-setup.sh` | self-contained CLI wrapper around `docker compose`; no `src/` importer beyond `src/docker-setup.test.ts` | `.github/labeler.yml` L92 | `src/docker-setup.test.ts` is the dedicated test for this script | no — hosted-deployment helper for `docker-compose.yml`; unsupported in v0 | delete-now (Track D must `git rm` this AND `src/docker-setup.test.ts` AND the `.github/labeler.yml` docker matcher + the `src/docker-setup.test.ts` matcher line in the same commit) | `pnpm exec tsc`, `pnpm build`, `pnpm vitest run` (full vitest must still pass once the test is removed) |
| `fly.toml` | no `src/` or `scripts/` importer beyond the Fly CLI itself; references `Dockerfile` (L8) | none in `package.json`/labeler beyond the `docker` umbrella (no specific glob); no vitest ref | — | no — Fly.io hosted deployment template; unsupported in v0 | delete-now | `pnpm exec tsc`, `pnpm build`, `pnpm lint` |
| `fly.private.toml` | same as `fly.toml` — references `Dockerfile` (L16) | none | — | no — Fly.io hardened-deployment template; unsupported in v0 | delete-now | `pnpm exec tsc`, `pnpm build`, `pnpm lint` |
| `render.yaml` | no in-tree importer; consumed only by the external Render.com service | none | — | no — Render.com hosted-deployment manifest; unsupported in v0 | delete-now | `pnpm exec tsc`, `pnpm build`, `pnpm lint` |
| `.dockerignore` | consumed by every `docker build` invocation in `scripts/test-*-docker.sh`, `scripts/sandbox-*.sh`, and `scripts/e2e/*-docker.sh` | `.github/labeler.yml` L93 | — | no once the Dockerfiles are gone; defer while sandbox Dockerfiles remain | defer (delete only in the same Track D commit that removes the last Dockerfile, otherwise sandbox builds would silently pick up scratch files) | `pnpm exec tsc`, `pnpm build`, `pnpm vitest run src/commands/doctor-sandbox*` after sandbox decision |

### 7b. Deploy-only scripts under `scripts/`

| PATH | IMPORTERS | PACKAGE/WORKSPACE/VITEST REFS | TESTS | REQUIRED BY v0? | DECISION | VERIFICATION NEEDED |
| --- | --- | --- | --- | --- | --- | --- |
| `scripts/docker/cleanup-smoke/` (`Dockerfile`, `run.sh`) | `scripts/test-cleanup-docker.sh` (L10 `-f "$ROOT_DIR/scripts/docker/cleanup-smoke/Dockerfile"`) | `.github/labeler.yml` L94 `scripts/**/*docker*`, L95 `scripts/**/Dockerfile*` | — | no — used only by docker smoke test that is itself a deploy-mode test | delete-now (paired with `scripts/test-cleanup-docker.sh` and `package.json` `test:docker:cleanup` + `test:docker:all`) | `pnpm exec tsc`, `pnpm build`, `pnpm lint` |
| `scripts/docker/install-sh-e2e/` (`Dockerfile`, `run.sh`) | `scripts/test-install-sh-e2e-docker.sh` (L16 `-f "$ROOT_DIR/scripts/docker/install-sh-e2e/Dockerfile"`) | `.github/labeler.yml` L94–95 | — | no — install.sh e2e harness; no v0 importer | delete-now (paired with the `test-install-sh-e2e-docker.sh` runner and `package.json` `test:install:e2e*` scripts) | `pnpm exec tsc`, `pnpm build`, `pnpm lint` |
| `scripts/docker/install-sh-nonroot/` (`Dockerfile`, `run.sh`) | `scripts/test-install-sh-docker.sh` (L41 `-f "$ROOT_DIR/scripts/docker/install-sh-nonroot/Dockerfile"`) | `.github/labeler.yml` L94–95 | — | no — install.sh non-root smoke harness | delete-now (paired with `test-install-sh-docker.sh` and `package.json` `test:install:smoke`) | `pnpm exec tsc`, `pnpm build`, `pnpm lint` |
| `scripts/docker/install-sh-smoke/` (`Dockerfile`, `run.sh`) | `scripts/test-install-sh-docker.sh` (L16 `-f "$ROOT_DIR/scripts/docker/install-sh-smoke/Dockerfile"`) | `.github/labeler.yml` L94–95 | — | no — install.sh root smoke harness | delete-now (paired with `test-install-sh-docker.sh` and `package.json` `test:install:smoke`) | `pnpm exec tsc`, `pnpm build`, `pnpm lint` |
| `scripts/sandbox-setup.sh` | `src/commands/doctor-sandbox.ts` L199 (build-script hint when missing image) | `.github/labeler.yml` L96 `scripts/sandbox-*.sh` | — | unclear — agent sandbox flow, not Telegram v0 but live importer | defer (paired with agent-sandbox decision) | `pnpm vitest run src/commands/doctor-sandbox* src/agents/sandbox/` |
| `scripts/sandbox-common-setup.sh` | `src/commands/doctor-sandbox.ts` L197 | `.github/labeler.yml` L96 | — | unclear — sandbox-common image build script | defer (paired with agent-sandbox decision) | `pnpm vitest run src/commands/doctor-sandbox*` |
| `scripts/sandbox-browser-setup.sh` | `src/commands/doctor-sandbox.ts` L215; error message text in `src/agents/sandbox/browser.ts` L75 | `.github/labeler.yml` L96 | — | unclear — sandbox-browser image build | defer (paired with browser-subsystem + agent-sandbox decisions) | `pnpm vitest run src/commands/doctor-sandbox* src/agents/sandbox/browser*` |
| `scripts/sandbox-browser-entrypoint.sh` | only `Dockerfile.sandbox-browser` (L23 `COPY scripts/sandbox-browser-entrypoint.sh /usr/local/bin/moltbot-sandbox-browser`); no `src/` importer | `.github/labeler.yml` L96 | — | unclear — required by `Dockerfile.sandbox-browser`; deletion would break the sandbox-browser image build | defer (paired with `Dockerfile.sandbox-browser`) | n/a until paired decision |
| `scripts/test-cleanup-docker.sh` | `package.json` L107 (`test:docker:cleanup`), L108 (`test:docker:all` chain) | `.github/labeler.yml` L94 `scripts/**/*docker*` | — | no — docker smoke runner, not part of v0 verification slice | delete-now (paired with the matching `package.json` script keys) | `pnpm exec tsc`, `pnpm build`, `pnpm lint` |
| `scripts/test-install-sh-docker.sh` | `package.json` L111 (`test:install:smoke`); uses `scripts/docker/install-sh-{smoke,nonroot}` | `.github/labeler.yml` L94 | — | no — install.sh docker smoke harness | delete-now (paired with `package.json` script keys + the two `scripts/docker/install-sh-*` dirs) | `pnpm exec tsc`, `pnpm build`, `pnpm lint` |
| `scripts/test-install-sh-e2e-docker.sh` | `package.json` L110 (`test:install:e2e`), L112 (`test:install:e2e:openai`), L113 (`test:install:e2e:anthropic`); uses `scripts/docker/install-sh-e2e` | `.github/labeler.yml` L94 | — | no — install.sh docker e2e harness | delete-now (paired with `package.json` script keys + `scripts/docker/install-sh-e2e/`) | `pnpm exec tsc`, `pnpm build`, `pnpm lint` |
| `scripts/test-live-gateway-models-docker.sh` | `package.json` L103 (`test:docker:live-gateway`), L108 (`test:docker:all`); builds the root `Dockerfile` | `.github/labeler.yml` L94 | — | no — live-models docker harness | delete-now (paired with `package.json` script keys; relies on root `Dockerfile` which is also delete-now) | `pnpm exec tsc`, `pnpm build`, `pnpm lint` |
| `scripts/test-live-models-docker.sh` | `package.json` L102 (`test:docker:live-models`), L108; builds the root `Dockerfile` | `.github/labeler.yml` L94 | — | no — live-models docker harness | delete-now (paired with `package.json` script keys; relies on root `Dockerfile`) | `pnpm exec tsc`, `pnpm build`, `pnpm lint` |
| `scripts/e2e/Dockerfile` | `scripts/e2e/onboard-docker.sh` L8, `plugins-docker.sh` L8, `doctor-install-switch-docker.sh` L8, `gateway-network-docker.sh` L19 | `.github/labeler.yml` L95 `scripts/**/Dockerfile*` | — | no — docker e2e harness Dockerfile | delete-now (paired with the four sibling `*-docker.sh` runners + their `package.json` script keys) | `pnpm exec tsc`, `pnpm build`, `pnpm lint` |
| `scripts/e2e/Dockerfile.qr-import` | `scripts/e2e/qr-import-docker.sh` L8 | `.github/labeler.yml` L95 | — | no — qr-import docker e2e harness | delete-now (paired with `qr-import-docker.sh` + `package.json` `test:docker:qr`) | `pnpm exec tsc`, `pnpm build`, `pnpm lint` |
| `scripts/e2e/onboard-docker.sh` | `package.json` L100 (`test:docker:onboard`), L108 (`test:docker:all`) | `.github/labeler.yml` L94 | — | no — onboard docker e2e | delete-now | `pnpm exec tsc`, `pnpm build`, `pnpm lint` |
| `scripts/e2e/plugins-docker.sh` | `package.json` L106 (`test:docker:plugins`), L108 | `.github/labeler.yml` L94 | — | no — plugins docker e2e | delete-now | `pnpm exec tsc`, `pnpm build`, `pnpm lint` |
| `scripts/e2e/qr-import-docker.sh` | `package.json` L104 (`test:docker:qr`), L108 | `.github/labeler.yml` L94 | — | no — qr-import docker e2e | delete-now | `pnpm exec tsc`, `pnpm build`, `pnpm lint` |
| `scripts/e2e/doctor-install-switch-docker.sh` | `package.json` L105 (`test:docker:doctor-switch`), L108 | `.github/labeler.yml` L94 | — | no — doctor install-switch docker e2e | delete-now | `pnpm exec tsc`, `pnpm build`, `pnpm lint` |
| `scripts/e2e/gateway-network-docker.sh` | `package.json` L101 (`test:docker:gateway-network`), L108 | `.github/labeler.yml` L94 | — | no — gateway-network docker e2e | delete-now | `pnpm exec tsc`, `pnpm build`, `pnpm lint` |
| `scripts/systemd/clawdbot-auth-monitor.service` | only `scripts/auth-monitor.sh` (its own ExecStart target); no `src/` importer | — | — | no — deploy/ops systemd unit for the auth-monitor cron; hardcodes `/home/admin` (`RELEASE_AUDIT/secrets-and-pii.md` L89); brand-mismatched filename (`RELEASE_AUDIT/brand-references.md` L57) | delete-now (paired with `scripts/auth-monitor.sh` cluster below) | `pnpm exec tsc`, `pnpm build`, `pnpm lint` |
| `scripts/systemd/clawdbot-auth-monitor.timer` | sibling of the `.service` above | — | — | no — same reason as the service unit | delete-now (paired with the `.service` unit and the auth cluster) | `pnpm exec tsc`, `pnpm build`, `pnpm lint` |
| `scripts/systemd/install-gateway-restart.sh` | self-installer for `moltbot-gateway-restart.{path,service}` | — | — | unclear — v0 Telegram gateway-restart command writes a trigger file (`gateway-restart-triggers/<id>`) that the systemd `.path` unit watches; only meaningful under systemd-managed deployments | defer (paired with the two unit files; removing without replacement would break the `/gateway_restart` Telegram command on Linux systemd hosts) | `pnpm vitest run src/telegram/gateway-restart.test.ts src/cli/gateway-cli/` |
| `scripts/systemd/moltbot-gateway-restart.path` | unit consumed by systemd when installed via `install-gateway-restart.sh` | — | — | unclear — load-bearing for v0 Telegram gateway-restart under systemd; not used by tests directly | defer (paired with the install script) | `pnpm vitest run src/telegram/gateway-restart.test.ts` |
| `scripts/systemd/moltbot-gateway-restart.service` | unit consumed by systemd when installed via `install-gateway-restart.sh` | — | — | unclear — same as `.path` | defer (paired with the install script) | `pnpm vitest run src/telegram/gateway-restart.test.ts` |
| `scripts/customer-setup.sh` | no in-tree importer; standalone onboarding wrapper around `claude login && moltbot onboard ...` (L9) | — | — | no — customer-onboarding helper for hosted deployments; duplicates `moltbot onboard --non-interactive` | delete-now | `pnpm exec tsc`, `pnpm build`, `pnpm lint` |
| `scripts/mobile-reauth.sh` | only referenced by `scripts/auth-monitor.sh` L81, `scripts/setup-auth-system.sh` L112+L117, `scripts/termux-auth-widget.sh` L46+L69, `scripts/termux-quick-auth.sh` L25 — i.e. the same closed Termux/auth cluster | — | — | no — mobile re-auth helper for Termux-driven workflows; not part of v0 Telegram/goal surface | delete-now (paired with the rest of the auth cluster in the same commit so cross-references vanish together) | `pnpm exec tsc`, `pnpm build`, `pnpm lint` |
| `scripts/setup-auth-system.sh` | self-contained orchestrator that calls `claude-auth-status.sh` (L17, L111, L116), `auth-monitor.sh` (L118), and `mobile-reauth.sh` (L112, L117) | — | — | no — installer for the Termux/auth-monitor cluster | delete-now (paired) | `pnpm exec tsc`, `pnpm build`, `pnpm lint` |
| `scripts/auth-monitor.sh` | only referenced by `scripts/systemd/clawdbot-auth-monitor.service` L7 and `scripts/setup-auth-system.sh` L118; `RELEASE_AUDIT/secrets-and-pii.md` L89 flags hardcoded `/home/admin` cron guidance | — | — | no — auth-monitor cron; not Telegram v0 | delete-now (paired) | `pnpm exec tsc`, `pnpm build`, `pnpm lint` |
| `scripts/claude-auth-status.sh` | referenced by `scripts/auth-monitor.sh` L47, `scripts/setup-auth-system.sh` L17/L111/L116, `scripts/mobile-reauth.sh` L27/L32/L70, `scripts/termux-auth-widget.sh` L14/L20, `scripts/termux-quick-auth.sh` L10; reads `~/.clawdbot/agents/main/agent/auth-profiles.json` (a private state path, not src code) | — | — | no — sibling of the auth cluster; reads private state file directly | delete-now (paired) | `pnpm exec tsc`, `pnpm build`, `pnpm lint` |
| `scripts/clawlog.sh` | no in-tree importer; standalone VibeTunnel macOS `log show --subsystem bot.molt ...` helper (L9) | — | — | no — macOS log-streaming utility, not Telegram v0 | delete-now | `pnpm exec tsc`, `pnpm build`, `pnpm lint` |
| `scripts/termux-auth-widget.sh` | sibling of the Termux cluster; calls `claude-auth-status.sh` over SSH (L14, L20), suggests running `mobile-reauth.sh` (L46, L69) | — | — | no — Android Termux widget for the auth cluster | delete-now (paired) | `pnpm exec tsc`, `pnpm build`, `pnpm lint` |
| `scripts/termux-quick-auth.sh` | sibling of the Termux cluster; calls `claude-auth-status.sh` (L10), suggests `mobile-reauth.sh` (L25) | — | — | no — Android Termux quick-auth widget | delete-now (paired) | `pnpm exec tsc`, `pnpm build`, `pnpm lint` |
| `scripts/termux-sync-widget.sh` | sibling of the Termux cluster; `RELEASE_AUDIT/SUMMARY.md` L93 flags it as hardcoding `/home/admin` and internal SSH targets | — | — | no — Android Termux sync widget; out of v0 scope | delete-now (paired) | `pnpm exec tsc`, `pnpm build`, `pnpm lint` |

### 7c. Paired in-tree references that Track D must edit in the same commits as the deletions above

These rows enumerate the package.json/labeler/test edits that must land alongside the deploy deletions so the repo never lands a knowingly broken intermediate state. They do not represent additional file deletions — they capture the "same commit as" obligations cited in the rows above.

| PAIRED REFERENCE | EVIDENCE | PAIRED WITH | DECISION |
| --- | --- | --- | --- |
| `package.json` `test:docker:onboard` (L100), `test:docker:gateway-network` (L101), `test:docker:live-models` (L102), `test:docker:live-gateway` (L103), `test:docker:qr` (L104), `test:docker:doctor-switch` (L105), `test:docker:plugins` (L106), `test:docker:cleanup` (L107), `test:docker:all` (L108), `test:install:e2e` (L110), `test:install:smoke` (L111), `test:install:e2e:openai` (L112), `test:install:e2e:anthropic` (L113); also `test:all` (L109) chain which references `test:docker:all` | grep of `package.json` against deploy script names | All `scripts/test-*-docker.sh` + `scripts/e2e/*-docker.sh` + `scripts/docker/*/` rows above | delete-now (drop each key in the same commit that removes its target script) |
| `.github/labeler.yml` `"docker"` block (L86–L101) including `Dockerfile`, `Dockerfile.*`, `docker-compose.yml`, `docker-setup.sh`, `.dockerignore`, `scripts/**/*docker*`, `scripts/**/Dockerfile*`, `scripts/sandbox-*.sh`, `src/agents/sandbox*.ts`, `src/commands/sandbox*.ts`, `src/cli/sandbox-cli.ts`, `src/docker-setup.test.ts`, `src/config/**/*sandbox*` | direct read of `.github/labeler.yml` | All root-level deploy files + scripts above; sandbox `src/` matchers stay until the sandbox decision is taken in a later track | Track D should narrow the block to drop matchers whose targets are deleted in the same commit; the sandbox `src/` lines stay until a later track decides sandbox |
| `src/docker-setup.test.ts` | sole purpose is to stub `docker`/`docker compose` and exercise `docker-setup.sh` | `docker-setup.sh` row above | delete-now in the same commit as `docker-setup.sh` so the vitest slice stays green |
| Existing test `src/docker-setup.test.ts` is listed in `.github/labeler.yml` L100 — when the test is removed, the label entry must go too | direct read | sibling of the test deletion | delete-now (same commit) |
| `README.md` L50 and L274 mention "Docker container" as one example of an isolation option, but do not reference `Dockerfile`/`docker-compose.yml` by filename | grep of `README.md` against deploy keywords | n/a — these are generic prose, not file references | keep (no edit needed for Track D) |
| `AGENTS.md` | grep returned no matches for any deploy filename | n/a | keep (no edit needed) |

## 8. Package / Workspace / Test Config

Source files audited:
- `/home/matt/moltbot/package.json` (root, the only top-level npm package)
- `/home/matt/moltbot/ui/package.json` (workspace member; private:true)
- `/home/matt/moltbot/pnpm-workspace.yaml`
- `/home/matt/moltbot/vitest.config.ts` (default + coverage block)
- `/home/matt/moltbot/vitest.unit.config.ts`
- `/home/matt/moltbot/vitest.gateway.config.ts`
- `/home/matt/moltbot/vitest.extensions.config.ts`
- `/home/matt/moltbot/vitest.e2e.config.ts`
- `/home/matt/moltbot/vitest.live.config.ts`

Disk verification used `ls /home/matt/moltbot/src/`, `ls /home/matt/moltbot/scripts/`, `ls /home/matt/moltbot/extensions/`, and a recursive `find` for sub-package.json files. The `dist/` directory exists locally as a build artifact; `dist/<subdir>/**` entries are only effective if the underlying `src/<subdir>/` (or, for `dist/control-ui/**`, the `ui/` build target) survives. All package.json/workspace/vitest decisions in this section are advisory for Track E and downstream tracks; this evidence step must not edit these files (per the explicit task constraint).

### 8a. Root `package.json` — `exports`

| PATH | IMPORTERS | PACKAGE/WORKSPACE/VITEST REFS | TESTS | REQUIRED BY v0? | DECISION | VERIFICATION NEEDED |
|---|---|---|---|---|---|---|
| `exports["."] = "./dist/index.js"` | npm consumers importing `smithersbot` | `package.json:8`; backs `src/index.ts` → `dist/index.js` | none direct | n/a (public package entry) | keep | Build still produces `dist/index.js` |
| `exports["./plugin-sdk"] = "./dist/plugin-sdk/index.js"` | npm consumers importing `smithersbot/plugin-sdk`; also internal `src/plugin-sdk/index.ts` and the `clawdbot/plugin-sdk` alias in `vitest.config.ts:15` | `package.json:9`; `src/plugin-sdk/` exists | `src/plugin-sdk/*.test.ts` | yes — plugin SDK is part of the supported runtime surface | keep | tsc + build |
| `exports["./plugin-sdk/*"] = "./dist/plugin-sdk/*"` | same as above (sub-paths) | `package.json:10` | same | yes | keep | tsc + build |
| `exports["./cli-entry"] = "./moltbot.mjs"` | external scripts that import the CLI entry as a module | `package.json:11`; `moltbot.mjs` present at repo root | none direct | yes — CLI entry is supported in v0 | keep | n/a |

### 8b. Root `package.json` — `bin`

| PATH | IMPORTERS | PACKAGE/WORKSPACE/VITEST REFS | TESTS | REQUIRED BY v0? | DECISION | VERIFICATION NEEDED |
|---|---|---|---|---|---|---|
| `bin.smithersbot = "./moltbot.mjs"` | post-install bin link | `package.json:14`; `moltbot.mjs` exists at repo root | none direct | yes — public CLI entry | keep | n/a |

### 8c. Root `package.json` — `files[]` (the published-package allowlist)

| PATH | IMPORTERS | PACKAGE/WORKSPACE/VITEST REFS | TESTS | REQUIRED BY v0? | DECISION | VERIFICATION NEEDED |
|---|---|---|---|---|---|---|
| `dist/acp/**` | tsc output of `src/acp/` | `package.json:17`; `src/acp/` exists | n/a (no `src/acp/**/*.test.ts`) | defer — ACP is on the unsupported CLI surface for v0; section 9 will mark it | defer | Pairs with Track H CLI hiding decision |
| `dist/agents/**` | tsc output of `src/agents/` | `package.json:18`; `src/agents/` exists | many `src/agents/**/*.test.ts` | yes (goal workers depend on agents) | keep | n/a |
| `dist/auto-reply/**` | tsc output of `src/auto-reply/` | `package.json:19`; `src/auto-reply/` exists | many `src/auto-reply/**/*.test.ts` | yes (constraint: do not delete auto-reply wholesale) | keep | Track K triages tests |
| `dist/browser/**` | tsc output of `src/browser/` | `package.json:20`; `src/browser/` exists | `src/browser/**/*.test.ts` | defer per section 1 (browser has v0 importers) | defer | Pairs with section 1 outcome |
| `dist/canvas-host/**` | tsc output of `src/canvas-host/` | `package.json:21`; `src/canvas-host/` exists | tests under `src/canvas-host/` | defer per section 3 (canvas-host has v0 importers in gateway/agents) | defer | Pairs with section 3 outcome |
| `dist/cli/**` | tsc output of `src/cli/` | `package.json:22`; `src/cli/` exists | many `src/cli/**/*.test.ts` | yes (CLI is supported) | keep | n/a |
| `dist/commands/**` | tsc output of `src/commands/` | `package.json:23`; `src/commands/` exists | many tests | yes | keep | n/a |
| `dist/config/**` | tsc output of `src/config/` | `package.json:24`; `src/config/` exists | tests | yes | keep | n/a |
| `dist/compat/**` | tsc output of `src/compat/` | `package.json:25`; `src/compat/` exists | none | yes (compat shim, kept by scope) | keep | n/a |
| `dist/control-ui/**` | populated by `pnpm ui:build` → `ui/vite.config.ts` `outDir: ../dist/control-ui` (verified) | `package.json:26`; ui workspace builds here | n/a (test handled by ui/) | defer — paired with `ui/` defer in section 2 | defer | Pairs with section 2 outcome |
| `dist/cron/**` | tsc output of `src/cron/` | `package.json:27`; `src/cron/` exists | tests | yes (cron is a v0 CLI keeper) | keep | n/a |
| `dist/channels/**` | tsc output of `src/channels/` | `package.json:28`; `src/channels/` exists | tests | yes (do not delete channels wholesale per scope) | keep | n/a |
| `dist/daemon/**` | tsc output of `src/daemon/` | `package.json:29`; `src/daemon/` exists | `src/daemon/**/*.test.ts` | defer — daemon CLI is on the unsupported list; pair with Track H | defer | Pairs with section 9 outcome |
| `dist/gateway/**` | tsc output of `src/gateway/` | `package.json:30`; `src/gateway/` exists | many tests | yes (gateway is the runtime) | keep | n/a |
| `dist/hooks/**` | tsc output of `src/hooks/` | `package.json:31`; `src/hooks/` exists | `src/hooks/**/*.test.ts` | yes (hook infrastructure stays; section 6 only narrows bundled hooks) | keep | n/a |
| `dist/infra/**` | tsc output of `src/infra/` | `package.json:32`; `src/infra/` exists | tests | yes | keep | n/a |
| `dist/media/**` | tsc output of `src/media/` | `package.json:33`; `src/media/` exists | tests | yes | keep | n/a |
| `dist/media-understanding/**` | tsc output of `src/media-understanding/` | `package.json:34`; dir exists | tests | yes | keep | n/a |
| `dist/link-understanding/**` | tsc output of `src/link-understanding/` | `package.json:35`; dir exists | tests | yes | keep | n/a |
| `dist/process/**` | tsc output of `src/process/` | `package.json:36`; `src/process/` exists | tests | yes (scope keeper) | keep | n/a |
| `dist/plugins/**` | tsc output of `src/plugins/` | `package.json:37`; `src/plugins/` exists | tests | yes (do not delete plugins wholesale per scope) | keep | n/a |
| `dist/plugin-sdk/**` | tsc output of `src/plugin-sdk/` | `package.json:38`; `src/plugin-sdk/` exists | tests | yes (exports rely on it) | keep | n/a |
| `dist/security/**` | tsc output of `src/security/` | `package.json:39`; `src/security/` exists | tests | yes (scope keeper) | keep | n/a |
| `dist/sessions/**` | tsc output of `src/sessions/` | `package.json:40`; `src/sessions/` exists | tests | yes | keep | n/a |
| `dist/providers/**` | tsc output of `src/providers/` | `package.json:41`; `src/providers/` exists | tests | yes | keep | n/a |
| `dist/telegram/**` | tsc output of `src/telegram/` | `package.json:42`; `src/telegram/` exists | many tests | yes (primary v0 surface) | keep | n/a |
| `dist/tui/**` | tsc output of `src/tui/` | `package.json:43`; `src/tui/` exists | tests | defer — TUI CLI is on the unsupported list for v0; pair with section 9 | defer | Pairs with section 9 outcome |
| `dist/tts/**` | tsc output of `src/tts/` | `package.json:44`; `src/tts/` exists | tests | yes (used by media/voice paths) | keep | n/a |
| `dist/wizard/**` | tsc output of `src/wizard/` | `package.json:45`; `src/wizard/` exists | tests | yes (onboarding wizard) | keep | n/a |
| `dist/*.js` | tsc root-level outputs (entry.js, index.js, runtime.js, version.js, logger.js, polls.js, utils.js) | `package.json:46`; root src/*.ts present | yes (root entrypoints) | keep | n/a |
| `dist/*.json` | tsc/build-info outputs (e.g. `scripts/write-build-info.ts` artifact) | `package.json:47` | none direct | keep — required for runtime build metadata | keep | n/a |
| `extensions/**` | shipped extensions (workspace dirs) | `package.json:48`; `extensions/` exists with 17 dirs | many `extensions/**/*.test.ts` | defer — Track F narrows extensions; this glob currently ships all 17 (including those queued for delete/quarantine) | defer | Re-evaluate after Track F; consider tightening to a list of v0 extensions |
| `assets/**` | shipped repo assets | `package.json:49`; `assets/` exists with `avatar-placeholder.svg`, `chrome-extension/`, `dmg-background.png`, `dmg-background-small.png` | none direct | defer — Track C removes `assets/dmg-background*.png`; remaining glob keeps `avatar-placeholder.svg` and `chrome-extension/` (the chrome-extension subdir is paired with section 1 defer) | defer | Re-evaluate after Track C + section 1 land |
| `moltbot.mjs` | bin/exports target; CLI entry | `package.json:50`; file exists at repo root | none direct | yes (CLI entry) | keep | n/a |
| `skills/**` | shipped bundled skills | `package.json:51`; `skills/` exists | `src/cli/skills-cli.test.ts:252` (peekaboo soft-skip); `src/agents/skills.build-workspace-skills-prompt.syncs-merged-skills-into-target-workspace.test.ts` fixture | defer — Track G narrows skills directory; glob currently ships everything | defer | Re-evaluate after Track G |
| `patches/**` | pnpm/jest patches; `package.json` `pnpm.overrides` and dependency patching | `package.json:52`; `patches/` exists | none direct | yes — required to apply package patches at install time | keep | n/a |
| `README.md` | public docs | `package.json:53`; exists | n/a | yes | keep | n/a |
| `README-header.png` | image referenced from README.md | `package.json:54`; file exists at repo root | n/a | no — Track C plan deletes this image and drops the README reference in the same commit | delete-now (paired with Track C) | After Track C deletion, also drop this `files[]` entry (Track E) |
| `CHANGELOG.md` | public docs | `package.json:55`; exists | n/a | yes | keep | n/a |
| `LICENSE` | public docs | `package.json:56`; exists | n/a | yes | keep | n/a |
| `scripts/postinstall.js` | invoked by `scripts.postinstall` | `package.json:57`; file exists; ran on every install | none direct | yes | keep | n/a |
| `scripts/format-staged.js` | git pre-commit hook | `package.json:58`; file exists; ref'd by `git-hooks/` | none direct | yes (git hook integration) | keep | n/a |
| `scripts/setup-git-hooks.js` | invoked by `scripts.postinstall` chain to install git hooks | `package.json:59`; file exists | none direct | yes | keep | n/a |
| `git-hooks/**` | git-hooks/ infra installed by `scripts/setup-git-hooks.js` | `package.json:60`; `git-hooks/` exists | `src/git-hooks.test.ts` | yes | keep | n/a |
| `dist/terminal/**` | tsc output of `src/terminal/` | `package.json:61`; `src/terminal/` exists | tests | yes | keep | n/a |
| `dist/routing/**` | tsc output of `src/routing/` | `package.json:62`; `src/routing/` exists | tests | yes (scope keeper) | keep | n/a |
| `dist/shared/**` | tsc output of `src/shared/` | `package.json:63`; `src/shared/` exists | tests | yes | keep | n/a |
| `dist/utils/**` | tsc output of `src/utils/` | `package.json:64`; `src/utils/` exists | tests | yes | keep | n/a |
| `dist/logging/**` | tsc output of `src/logging/` | `package.json:65`; `src/logging/` exists | tests | yes (scope keeper) | keep | n/a |
| `dist/memory/**` | tsc output of `src/memory/` | `package.json:66`; `src/memory/` exists | tests | yes (scope keeper) | keep | n/a |
| `dist/markdown/**` | tsc output of `src/markdown/` | `package.json:67`; `src/markdown/` exists | tests | yes (scope keeper) | keep | n/a |
| `dist/node-host/**` | tsc output of `src/node-host/` | `package.json:68`; `src/node-host/` exists | tests | defer — node-host CLI is on the unsupported list; pair with section 9 | defer | Pairs with section 9 outcome |
| `dist/pairing/**` | tsc output of `src/pairing/` | `package.json:69`; `src/pairing/` exists | tests | yes (paired-agent flows) | keep | n/a |

### 8d. Root `package.json` — `scripts`

| PATH | IMPORTERS | PACKAGE/WORKSPACE/VITEST REFS | TESTS | REQUIRED BY v0? | DECISION | VERIFICATION NEEDED |
|---|---|---|---|---|---|---|
| `dev` → `node scripts/run-node.mjs` | dev entry | `package.json:72`; `scripts/run-node.mjs` exists | n/a | yes | keep | n/a |
| `postinstall` → `node scripts/postinstall.js` | npm install lifecycle | `package.json:73`; file exists | none direct | yes | keep | n/a |
| `prepack` → `pnpm build && pnpm ui:build` | npm pack lifecycle | `package.json:74`; both child scripts exist | n/a | yes (constraint forbids `npm pack`, but `prepack` is still required for any future packaging) | keep | n/a |
| `build` → `tsc -p tsconfig.json && node --import tsx scripts/canvas-a2ui-copy.ts && node --import tsx scripts/copy-hook-metadata.ts && node --import tsx scripts/write-build-info.ts` | `pnpm build` (verification gate) | `package.json:75`; all referenced scripts exist | n/a | yes — but the `canvas-a2ui-copy.ts` step is paired with section 3 (canvas/vendor decision) | defer (script keeps, but `canvas-a2ui-copy.ts` invocation must be re-checked if section 3 lands a deletion later) | Pairs with section 3 outcome |
| `plugins:sync` → `node --import tsx scripts/sync-plugin-versions.ts` | manual plugin version maintenance | `package.json:76`; `scripts/sync-plugin-versions.ts` exists | none direct | defer — depends on whether plugins subsystem stays public surface in v0 | defer | n/a |
| `release:check` → `node --import tsx scripts/release-check.ts` | release-readiness check | `package.json:77`; `scripts/release-check.ts` exists | none direct | yes (used by repo workflow) | keep | n/a |
| `ui:install` → `node scripts/ui.js install` | invokes `ui/` workspace install | `package.json:78`; `scripts/ui.js` exists; `ui/` workspace member | n/a | defer — paired with `ui/` defer in section 2 | defer | Pairs with section 2 |
| `ui:dev` → `node scripts/ui.js dev` | dev server for `ui/` | `package.json:79` | n/a | defer | defer | Pairs with section 2 |
| `ui:build` → `node scripts/ui.js build` | populates `dist/control-ui/**` | `package.json:80`; invoked by `prepack` | n/a | defer | defer | Pairs with section 2 |
| `start` → `node scripts/run-node.mjs` | runtime entry | `package.json:81` | n/a | yes | keep | n/a |
| `moltbot` → `node scripts/run-node.mjs` | runtime entry alias | `package.json:82` | n/a | yes | keep | n/a |
| `gateway:watch` → `node scripts/watch-node.mjs gateway --force` | dev gateway watcher | `package.json:83`; `scripts/watch-node.mjs` exists | n/a | yes | keep | n/a |
| `gateway:dev` → `CLAWDBOT_SKIP_CHANNELS=1 node scripts/run-node.mjs --dev gateway` | dev gateway | `package.json:84` | n/a | yes; carries the stale `CLAWDBOT_*` env name (paired with Stage 2F naming cleanup, not Track E) | keep with naming concern | Future rename in a separate stage (not Stage 2G scope) |
| `gateway:dev:reset` → same with `--reset` | dev gateway | `package.json:85` | n/a | yes; same `CLAWDBOT_*` naming concern | keep with naming concern | Same as above |
| `tui` → `node scripts/run-node.mjs tui` | TUI entry | `package.json:86` | n/a | defer — pair with section 9 TUI hiding | defer | Pairs with section 9 |
| `tui:dev` → `CLAWDBOT_PROFILE=dev node scripts/run-node.mjs tui` | dev TUI entry | `package.json:87` | n/a | defer | defer | Pairs with section 9 |
| `moltbot:rpc` → `node scripts/run-node.mjs agent --mode rpc --json` | agent RPC entry | `package.json:88` | n/a | keep — agent is a v0 CLI keeper per Track H plan | keep | n/a |
| `lint` → `oxlint --type-aware src test` | verification gate | `package.json:89` | n/a | yes | keep | n/a |
| `lint:fix` → `pnpm format:fix && oxlint --type-aware --fix src test` | dev convenience | `package.json:90` | n/a | yes | keep | n/a |
| `format` → `oxfmt --check src test` | verification | `package.json:91` | n/a | yes | keep | n/a |
| `format:fix` → `oxfmt --write src test` | dev convenience | `package.json:92` | n/a | yes | keep | n/a |
| `test` → `node scripts/test-parallel.mjs` | verification gate | `package.json:93`; `scripts/test-parallel.mjs` exists | n/a | yes | keep | n/a |
| `test:watch` → `vitest` | dev | `package.json:94` | n/a | yes | keep | n/a |
| `test:ui` → `pnpm --dir ui test` | runs `ui/` tests | `package.json:95`; `ui/` workspace exists | n/a | defer — pair with section 2 | defer | Pairs with section 2 |
| `test:force` → `node --import tsx scripts/test-force.ts` | dev convenience | `package.json:96`; `scripts/test-force.ts` exists | n/a | keep (low-cost dev script) | keep | n/a |
| `test:coverage` → `vitest run --coverage` | coverage gate | `package.json:97` | n/a | yes | keep | n/a |
| `test:e2e` → `vitest run --config vitest.e2e.config.ts` | e2e gate | `package.json:98`; `vitest.e2e.config.ts` present | n/a | keep (still used by repo workflow) | keep | n/a |
| `test:live` → `CLAWDBOT_LIVE_TEST=1 vitest run --config vitest.live.config.ts` | live-model e2e | `package.json:99`; `vitest.live.config.ts` present | n/a | keep (carries `CLAWDBOT_*` env name like the gateway scripts) | keep with naming concern | n/a |
| `test:docker:onboard` → `bash scripts/e2e/onboard-docker.sh` | docker e2e | `package.json:100`; script exists | n/a | delete-now — paired with section 7b (deploy delete-now) | delete-now (paired with Track D) | Track D drops this row in the deploy-cleanup commit |
| `test:docker:gateway-network` → `bash scripts/e2e/gateway-network-docker.sh` | docker e2e | `package.json:101` | n/a | delete-now (paired with section 7b) | delete-now (paired with Track D) | Same |
| `test:docker:live-models` → `bash scripts/test-live-models-docker.sh` | docker e2e | `package.json:102` | n/a | delete-now (paired with section 7b) | delete-now (paired with Track D) | Same |
| `test:docker:live-gateway` → `bash scripts/test-live-gateway-models-docker.sh` | docker e2e | `package.json:103` | n/a | delete-now (paired with section 7b) | delete-now (paired with Track D) | Same |
| `test:docker:qr` → `bash scripts/e2e/qr-import-docker.sh` | docker e2e | `package.json:104` | n/a | delete-now (paired with section 7b) | delete-now (paired with Track D) | Same |
| `test:docker:doctor-switch` → `bash scripts/e2e/doctor-install-switch-docker.sh` | docker e2e | `package.json:105` | n/a | delete-now (paired with section 7b) | delete-now (paired with Track D) | Same |
| `test:docker:plugins` → `bash scripts/e2e/plugins-docker.sh` | docker e2e | `package.json:106` | n/a | delete-now (paired with section 7b) | delete-now (paired with Track D) | Same |
| `test:docker:cleanup` → `bash scripts/test-cleanup-docker.sh` | docker e2e | `package.json:107` | n/a | delete-now (paired with section 7b) | delete-now (paired with Track D) | Same |
| `test:docker:all` → composite of all `test:docker:*` | docker e2e | `package.json:108` | n/a | delete-now (paired with section 7b — when its constituents go, this aggregator goes) | delete-now (paired with Track D) | Same |
| `test:all` → `pnpm lint && pnpm build && pnpm test && pnpm test:e2e && pnpm test:live && pnpm test:docker:all` | super-verification | `package.json:109` | n/a | delete-now — depends on `test:docker:all` which is going away; once docker scripts go, this composite is broken | delete-now (paired with Track D) | Track D drops or rewrites without docker |
| `test:install:e2e` → `bash scripts/test-install-sh-e2e-docker.sh` | docker e2e | `package.json:110` | n/a | delete-now (paired with section 7b) | delete-now (paired with Track D) | Same |
| `test:install:smoke` → `bash scripts/test-install-sh-docker.sh` | docker smoke | `package.json:111` | n/a | delete-now (paired with section 7b) | delete-now (paired with Track D) | Same |
| `test:install:e2e:openai` → docker e2e with env | `package.json:112` | n/a | delete-now (paired with section 7b) | delete-now (paired with Track D) | Same |
| `test:install:e2e:anthropic` → docker e2e with env | `package.json:113` | n/a | delete-now (paired with section 7b) | delete-now (paired with Track D) | Same |
| `protocol:gen` → `node --import tsx scripts/protocol-gen.ts` | protocol generation | `package.json:114`; `scripts/protocol-gen.ts` exists | n/a | keep (used by maintenance flows) | keep | n/a |
| `check:loc` → `node --import tsx scripts/check-ts-max-loc.ts --max 500` | code-size gate | `package.json:115`; script exists | n/a | keep | keep | n/a |
| `debug:mermaid` → `node --import tsx scripts/debug-mermaid-png.ts` | goal/mermaid debug utility | `package.json:116`; `scripts/debug-mermaid-png.ts` exists | n/a | keep (small dev utility; section 3 also marked the script KEEP) | keep | n/a |

### 8e. `ui/package.json` (workspace member, `private:true`)

| PATH | IMPORTERS | PACKAGE/WORKSPACE/VITEST REFS | TESTS | REQUIRED BY v0? | DECISION | VERIFICATION NEEDED |
|---|---|---|---|---|---|---|
| `ui/package.json` (entire file) | sub-package consumed only by root `pnpm ui:*` scripts and `pnpm-workspace.yaml` `- ui` | root `package.json:78-80` (ui:install/dev/build); `pnpm-workspace.yaml:3` | `ui/vitest.config.ts` runs its own tests via `pnpm --dir ui test` | defer — section 2 marks `ui/` defer; this package follows | defer | Pairs with section 2 |

### 8f. `pnpm-workspace.yaml` — `packages` globs

| PATH | IMPORTERS | PACKAGE/WORKSPACE/VITEST REFS | TESTS | REQUIRED BY v0? | DECISION | VERIFICATION NEEDED |
|---|---|---|---|---|---|---|
| `- .` | root workspace member | `pnpm-workspace.yaml:2`; root `package.json` exists | n/a | yes | keep | n/a |
| `- ui` | workspace member for control UI | `pnpm-workspace.yaml:3`; `ui/package.json` exists | n/a | defer — paired with section 2 | defer | Pairs with section 2 |
| `- packages/*` | DEAD — no `packages/` directory exists at repo root (verified by `ls /home/matt/moltbot/` and `ls -d /home/matt/moltbot/packages`: "No such file or directory") | `pnpm-workspace.yaml:4`; matches zero workspace members | n/a | no | delete-now | Track E removes; tsc + pnpm install still succeed (zero matches today, so no behaviour change) |
| `- extensions/*` | matches all 17 `extensions/<name>/` workspace members | `pnpm-workspace.yaml:5`; `extensions/` has 17 dirs | many extension tests | defer — Track F narrows; this glob currently includes every queued delete/quarantine row from section 4 | defer | After Track F, decide whether to keep the wildcard or list v0 extensions explicitly |

### 8g. `pnpm-workspace.yaml` — `onlyBuiltDependencies`

| PATH | IMPORTERS | PACKAGE/WORKSPACE/VITEST REFS | TESTS | REQUIRED BY v0? | DECISION | VERIFICATION NEEDED |
|---|---|---|---|---|---|---|
| `@whiskeysockets/baileys` | listed in root `dependencies` | `pnpm-workspace.yaml:8`; `package.json:159` | n/a | yes (WhatsApp lib still listed) | keep | n/a |
| `@lydell/node-pty` | listed in root `dependencies` | `pnpm-workspace.yaml:9`; `package.json:149` | n/a | yes (TUI/pty paths) | keep | n/a |
| `@matrix-org/matrix-sdk-crypto-nodejs` | matrix extension transitive dep | `pnpm-workspace.yaml:10`; NOT in root `dependencies`; only `extensions/matrix/` consumes it | n/a | no — section 4 marks `extensions/matrix` quarantine-now | defer (will go dead once matrix quarantines) | After Track F, drop this `onlyBuiltDependencies` entry in the same commit |
| `authenticate-pam` | server-auth dep, not in root `dependencies` (deep transitive) | `pnpm-workspace.yaml:11` | n/a | defer — unclear which subsystem still pulls it; keep to avoid pnpm install regressions | defer | Re-grep after Track F + Track H |
| `esbuild` | transitive build tool dep | `pnpm-workspace.yaml:12` | n/a | yes (vite/vitest stack) | keep | n/a |
| `protobufjs` | transitive dep (likely matrix/baileys/grpc) | `pnpm-workspace.yaml:13` | n/a | defer — re-check after Track F | defer | Re-grep after Track F |
| `puppeteer` | not in root `dependencies`; probably transitive of mermaid CLI | `pnpm-workspace.yaml:14` | n/a | defer — keep until mermaid pipeline is reassessed | defer | n/a |
| `sharp` | listed in root `dependencies` | `pnpm-workspace.yaml:15`; `package.json:187` | n/a | yes (image processing) | keep | n/a |

### 8h. `vitest.config.ts` (default) — `test.include` / `test.exclude` / coverage

| PATH | IMPORTERS | PACKAGE/WORKSPACE/VITEST REFS | TESTS | REQUIRED BY v0? | DECISION | VERIFICATION NEEDED |
|---|---|---|---|---|---|---|
| include `src/**/*.test.ts` | default unit-test glob | `vitest.config.ts:24` | n/a | yes | keep | n/a |
| include `extensions/**/*.test.ts` | extension tests | `vitest.config.ts:25` | n/a | defer — follows `extensions/` decisions (section 4); keep until Track F | defer | n/a |
| include `test/format-error.test.ts` | DEAD — `ls /home/matt/moltbot/test/format-error*` returns "No such file or directory" | `vitest.config.ts:26`; no matching file | n/a | no | delete-now | Track E removes; `pnpm vitest run` still succeeds (vitest ignores missing files but it is misleading evidence) |
| exclude `dist/**` | standard build-output exclude | `vitest.config.ts:30` | n/a | yes | keep | n/a |
| exclude `**/node_modules/**` | standard | `vitest.config.ts:31` | n/a | yes | keep | n/a |
| exclude `**/vendor/**` | excludes the `vendor/a2ui/` tree | `vitest.config.ts:32` | n/a | defer — paired with section 3 vendor decision; if vendor/a2ui is quarantined or removed, this exclude can stay (harmless) | keep | n/a |
| exclude `**/*.live.test.ts` | excludes live tests from default run | `vitest.config.ts:33` | n/a | yes | keep | n/a |
| exclude `**/*.e2e.test.ts` | excludes e2e from default run | `vitest.config.ts:34` | n/a | yes | keep | n/a |
| exclude `src/telegram/bot.test.ts` | Stage 2E known-broken legacy Telegram mock (comment cites STAGE2E_REPORT) | `vitest.config.ts:35-39` | n/a | defer — outside Track E scope; tracked separately | defer | n/a |
| **coverage.exclude** rows referencing actual paths | each must point to a live `src/...` file/dir | `vitest.config.ts:51-98` | n/a | defer | defer | For each exclude entry: `src/entry.ts` exists; `src/index.ts` exists; `src/runtime.ts` exists; `src/cli/**` exists; `src/commands/**` exists; `src/daemon/**` exists; `src/hooks/**` exists; `src/agents/model-scan.ts` exists; `src/agents/pi-embedded-runner.ts` exists; `src/agents/sandbox-paths.ts` exists; `src/agents/sandbox.ts` exists; `src/agents/skills-install.ts` exists; `src/agents/pi-tool-definition-adapter.ts` exists (all verified by `ls src/`); `src/gateway/control-ui.ts` exists; `src/gateway/server-*` family exists; `src/process/tau-rpc.ts` and `src/process/exec.ts` exist; `src/tui/**` exists; `src/wizard/**` exists; `src/browser/**` exists; `src/telegram/*` exists; `src/gateway/server.ts` / `client.ts` / `protocol/**` exist; `src/infra/tailscale.ts` exists. All entries reference live paths; no dead refs here. | keep (no dead refs) |

### 8i. Root `package.json` `vitest` block (lines 240-267)

| PATH | IMPORTERS | PACKAGE/WORKSPACE/VITEST REFS | TESTS | REQUIRED BY v0? | DECISION | VERIFICATION NEEDED |
|---|---|---|---|---|---|---|
| `vitest.coverage.include` = `src/**/*.ts`; `vitest.coverage.exclude` = `src/**/*.test.ts`; `vitest.include` = `src/**/*.test.ts`; `vitest.exclude` = `dist/**`, `**/vendor/**` | DEAD — Vitest reads `vitest.config.ts` by default; this `vitest` block in `package.json` is not auto-loaded and is shadowed by the dedicated config files | `package.json:240-267`; no test command in scripts loads this block (every `test*` script either uses `node scripts/test-parallel.mjs` or `vitest run --config <file>`) | n/a | no | delete-now | Track E removes the entire `vitest` block; verification: `pnpm test` and `pnpm vitest run` still pick up `vitest.config.ts` unchanged |

### 8j. `vitest.unit.config.ts`

| PATH | IMPORTERS | PACKAGE/WORKSPACE/VITEST REFS | TESTS | REQUIRED BY v0? | DECISION | VERIFICATION NEEDED |
|---|---|---|---|---|---|---|
| include `src/**/*.test.ts`, `extensions/**/*.test.ts`, `test/format-error.test.ts` (inherited via `baseTest.include`); exclude `src/gateway/**`, `extensions/**` (added by this config) | imports `./vitest.config.ts` | `vitest.unit.config.ts:1-19`; no `package.json` script references `vitest.unit.config.ts` | none direct | defer — file is currently orphaned (no script invokes it), but it's a thin façade over `vitest.config.ts`; keep until Track E confirms no internal tooling reads it | defer | grep for `vitest.unit.config.ts` across repo before any delete |

### 8k. `vitest.gateway.config.ts`

| PATH | IMPORTERS | PACKAGE/WORKSPACE/VITEST REFS | TESTS | REQUIRED BY v0? | DECISION | VERIFICATION NEEDED |
|---|---|---|---|---|---|---|
| include `src/gateway/**/*.test.ts`; exclude inherited | imports `./vitest.config.ts` | `vitest.gateway.config.ts:1-14`; no `package.json` script references it | n/a | defer — orphaned by `package.json` scripts; keep until Track E confirms | defer | Same as above |

### 8l. `vitest.extensions.config.ts`

| PATH | IMPORTERS | PACKAGE/WORKSPACE/VITEST REFS | TESTS | REQUIRED BY v0? | DECISION | VERIFICATION NEEDED |
|---|---|---|---|---|---|---|
| include `extensions/**/*.test.ts`; exclude inherited | imports `./vitest.config.ts` | `vitest.extensions.config.ts:1-14`; no `package.json` script references it | extension tests | defer — orphaned by `package.json` scripts; keep until Track E + Track F confirm | defer | Re-evaluate after Track F |

### 8m. `vitest.e2e.config.ts`

| PATH | IMPORTERS | PACKAGE/WORKSPACE/VITEST REFS | TESTS | REQUIRED BY v0? | DECISION | VERIFICATION NEEDED |
|---|---|---|---|---|---|---|
| include `test/**/*.e2e.test.ts`, `src/**/*.e2e.test.ts`; exclude `dist/**`, `**/vendor/**`, `dist/Moltbot.app/**` | `pnpm test:e2e` (`package.json:98`) | `vitest.e2e.config.ts:1-20` | many `*.e2e.test.ts` files | yes — invoked by an existing script and part of repo verification | keep | n/a |
| exclude `dist/Moltbot.app/**` (Mac DMG output) | leftover from removed Mac app build | `vitest.e2e.config.ts:17` | n/a — `dist/Moltbot.app/` does not exist | no — Stage 2E cleaned the Mac app | delete-now (low-risk) | Track E may drop this line; harmless if left |

### 8n. `vitest.live.config.ts`

| PATH | IMPORTERS | PACKAGE/WORKSPACE/VITEST REFS | TESTS | REQUIRED BY v0? | DECISION | VERIFICATION NEEDED |
|---|---|---|---|---|---|---|
| include `src/**/*.live.test.ts`; exclude `dist/**`, `**/vendor/**`, `dist/Moltbot.app/**` | `pnpm test:live` (`package.json:99`) | `vitest.live.config.ts:1-16` | live tests | yes — invoked by an existing script | keep | n/a |
| exclude `dist/Moltbot.app/**` | leftover from removed Mac app build | `vitest.live.config.ts:12` | n/a | no | delete-now (low-risk) | Same as above |

### Section 8 summary

- **delete-now (paired):** `README-header.png` files[] entry (paired with Track C); all 14 `test:docker:*` / `test:install:*` / `test:all` scripts (paired with Track D); `pnpm-workspace.yaml` `- packages/*` glob; `vitest.config.ts` include `test/format-error.test.ts`; the entire `vitest` block in `package.json` (lines 240-267); `dist/Moltbot.app/**` excludes in `vitest.e2e.config.ts` and `vitest.live.config.ts`.
- **delete-now (standalone):** none — every delete-now row is either paired with a deletion in another track or is a low-risk dead-config row.
- **defer:** every `dist/<subdir>/**` row whose subsystem is on the defer list (browser, canvas-host, control-ui/ui, daemon, node-host, tui, extensions, skills, assets glob), `pnpm-workspace.yaml - extensions/*`, `onlyBuiltDependencies` rows tied to deferred extensions, three orphaned vitest configs (`vitest.unit.config.ts`, `vitest.gateway.config.ts`, `vitest.extensions.config.ts`), and `canvas-a2ui-copy.ts` invocation inside the `build` script (depends on section 3).
- **keep:** all remaining `dist/<subdir>/**` rows whose subsystem is a v0 keeper; `exports`, `bin`, `assets/avatar-placeholder.svg`-bearing `assets/**` glob (re-evaluate after Track C); `patches/**`; `scripts/{postinstall,format-staged,setup-git-hooks}.js`; `git-hooks/**`; README/CHANGELOG/LICENSE; all lint/format/non-docker test scripts; `protocol:gen` / `check:loc` / `debug:mermaid`; `vitest.e2e.config.ts` and `vitest.live.config.ts` (their `.Moltbot.app` exclude lines aside).

Constraint upheld: this evidence step made no edits to `package.json`, `pnpm-workspace.yaml`, or any `vitest*.config.ts` file.

## 9. CLI Subcommands

_To be populated in track-b7-evidence-cli._
