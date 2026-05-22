SmithersBot is a GitHub-first Node/TypeScript project for Telegram and the local goal-system runtime.

## Scope
- Keep public surfaces generic and repository-local; do not add private hostnames, personal paths, credentials, release secrets, or maintainer-only operations.
- Do not claim CI, deployment, npm publishing, or non-Telegram channel support exists unless the repository implements it.
- Do not edit operator-local systemd files and do not run live gateway restarts from workers.
- Do not read or print private env, auth, session, credential, token, key, or local config files.

## Layout
- Source code lives in `src/`.
- Telegram runtime code lives in `src/telegram/`.
- Goal-system code lives in `src/goal/`.
- Tests are colocated as `*.test.ts` unless an existing area uses another local pattern.
- Extension packages live under `extensions/`; deferred reference extensions may remain under `internal/extensions/`.
- Generated output belongs in `dist/` and should not be edited by hand.

## Commands
- Runtime baseline: Node 22+.
- Install dependencies: `pnpm install`.
- Type-check: `pnpm exec tsc -p tsconfig.json`.
- Build: `pnpm build`.
- Lint: `pnpm lint`.
- Run targeted tests: `pnpm vitest run <path>`.
- Run the local CLI entrypoint: `node scripts/run-node.mjs <args>`.

## Coding Standards
- TypeScript is ESM; prefer strict typing and avoid `any` unless there is no reasonable alternative.
- Keep changes focused on the requested task and avoid unrelated refactors or formatting churn.
- Follow the patterns already used near the code you are touching.
- Add brief comments only for non-obvious behavior.
- Do not edit `node_modules/`, generated output, dependency patches, or sensitive config files without explicit approval.

## Deprecated Aliases
- `SMITHERSBOT_*` environment variables are canonical for new code and docs.
- `MOLTBOT_*` and `CLAWDBOT_*` environment variables are accepted as deprecated compatibility aliases where supported.
- `clawdbot/plugin-sdk` remains a compatibility import alias.
- New active extension code should import from `smithersbot/plugin-sdk`.

## Git And Safety
- Do not push, publish, rewrite history, delete branches, remove remotes, or run release commands unless explicitly asked.
- Keep commits small and scoped when commits are requested.
- Stage only files related to the task.
- Never commit secrets, credentials, tokens, private keys, live phone numbers, or private configuration values.
- Use obvious placeholders in examples and tests, such as `+15555550123`, `/Users/test/...`, and `your-tailnet.ts.net`.

## Verification
- Verify before reporting completion.
- For behavior changes, run the smallest relevant Vitest slice plus `pnpm exec tsc -p tsconfig.json`, `pnpm build`, and `pnpm lint`.
- If a change affects `/goal` commands, exercise the affected CLI path with `node scripts/run-node.mjs <affected goal args>`.
- If verification fails, inspect the output, fix the implementation, and rerun the affected command.
- If an environment limitation blocks verification, report the exact command and blocker.
