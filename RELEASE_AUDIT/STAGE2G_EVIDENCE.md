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

_To be populated in track-b3-evidence-extensions._

## 5. Skills

_To be populated in track-b4-evidence-skills-hooks._

## 6. Hooks

_To be populated in track-b4-evidence-skills-hooks._

## 7. Deploy

_To be populated in track-b5-evidence-deploy._

## 8. Package / Workspace / Test Config

_To be populated in track-b6-evidence-package-workspace._

## 9. CLI Subcommands

_To be populated in track-b7-evidence-cli._
