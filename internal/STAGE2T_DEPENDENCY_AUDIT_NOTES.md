# Stage 2T Dependency Audit Notes

## Removed Now

- `@line/bot-sdk`: root dependency only; no root source/script/test/active-extension import matched `from "@line/bot-sdk"` or `require("@line/bot-sdk")`. LINE support is not an active workspace package in `pnpm-workspace.yaml`.
- `@slack/bolt`, `@slack/web-api`: root dependencies only; Slack remains represented by generic config/plugin types, but the native SDK packages are not imported by root source, scripts, tests, or active extensions.
- `@whiskeysockets/baileys`: root dependency only; no active source import. Removed its stale `onlyBuiltDependencies` entry from `pnpm-workspace.yaml`.
- `@lit-labs/signals`, `@lit/context`, `@mariozechner/mini-lit`: root dev dependencies only; UI uses its own `ui/package.json` dependencies and root code does not import these packages.
- `@typescript/native-preview`, `docx-preview`, `quicktype-core`, `rolldown`, `signal-utils`, `wireit`: root dev dependencies only; no import or script reference in root source, scripts, tests, UI, or active extensions.

`pnpm install --lockfile-only --offline` updated `pnpm-lock.yaml`. The lock refresh also dropped stale lock importers for packages that are no longer listed in `pnpm-workspace.yaml`; no extension package manifests were edited.

## Candidates To Remove Later

- `@homebridge/ciao`: kept because `src/infra/bonjour.ts` dynamically imports it.
- `@mermaid-js/mermaid-cli`: kept because `src/goal/mermaid-png.ts` resolves and invokes the `mmdc` binary from `node_modules/.bin`.
- `@mozilla/readability`: kept because `src/agents/tools/web-fetch-utils.ts` dynamically imports it.
- `@lydell/node-pty`: kept because `src/agents/bash-tools.exec.ts` dynamically imports it for PTY fallback.
- `node-llama-cpp`, `@napi-rs/canvas`: kept as optional dependencies with explicit runtime error paths and tests.

## Kept Intentionally

- Telegram stack: `grammy`, `@grammyjs/runner`, `@grammyjs/transformer-throttler`, `@grammyjs/types` are imported by active Telegram runtime/tests.
- Pi agent stack: `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`, `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui` are actively imported across providers, agent runtime, goal tools, and TUI.
- `@sinclair/typebox`: actively imported by agent/gateway schemas and extension code.
- `lit` and `lucide`: root UI/control code imports these directly; the separate `ui/` package also maintains its own manifest.
- `@vitest/coverage-v8`, `oxlint`, `oxlint-tsgolint`, `oxfmt`, `tsx`, `typescript`, `vitest`: kept because package scripts reference the tools directly.

## Evidence Commands

- `pnpm list --depth 0`
- `pnpm why <candidate-package>` for each removed package before removal.
- `rg "from ['\"]<candidate-package>|require\(['\"]<candidate-package>" src scripts test tests extensions package.json` for each removed package.
- `rg "knip|depcheck|dependency|unused" package.json scripts src test tests .github` found no repo-local dependency checker script.
