# SmithersBot Agent Guide

## Scope
- SmithersBot v0 is a GitHub-first Node/TypeScript project focused on Telegram and the local goal-system runtime.
- Keep public surfaces generic and repository-local. Do not add private hostnames, personal paths, credentials, release secrets, or maintainer-specific operations.
- Do not claim CI, deployment, npm publishing, or non-Telegram channel support exists unless the repository implements it.

## Project Layout
- Source code lives in `src/`.
- Telegram runtime code lives in `src/telegram/`.
- Goal-system code lives in `src/goal/`.
- Tests are colocated as `*.test.ts` unless an existing area uses another local pattern.
- Extension packages live under `extensions/`; deferred extension directories may remain in-tree as reference code.
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
- TypeScript is ESM. Prefer strict typing and avoid `any` unless there is no reasonable alternative.
- Keep changes focused on the requested task. Avoid unrelated refactors and formatting churn.
- Follow the patterns already used near the code you are touching.
- Add brief comments only for non-obvious behavior.
- Do not edit `node_modules/`, generated output, or dependency patches without explicit approval.

## Deprecated Aliases
- `CLAWDBOT_*` environment variables are accepted for backward compatibility.
- New code and docs should use the matching `MOLTBOT_*` names.
- `clawdbot/plugin-sdk` remains a compatibility import alias.
- New active extension code should import from `smithersbot/plugin-sdk`.

## Git And Safety
- Do not push, publish, rewrite history, delete branches, remove remotes, or run release commands unless explicitly asked.
- Keep commits small and scoped when commits are requested.
- Stage only files related to the task.
- Never commit secrets, credentials, tokens, private keys, live phone numbers, or private configuration values.
- Use obvious placeholders in examples and tests, such as `+15555550123`, `/Users/test/...`, and `your-tailnet.ts.net`.

## Verification
- Verify before reporting completion. Run the smallest relevant test slice plus typecheck, build, and lint when behavior changes.
- If verification fails, inspect the output, fix the implementation, and rerun the affected command.
- If an environment limitation blocks verification, report the exact command and blocker.

## Goal-System Self-Verification
- If a change affects any command in the `/goal` family, exercise the affected CLI path yourself before marking the work complete.
- Use the local Node entrypoint from the repository root:

```sh
node scripts/run-node.mjs <args>
```

- Goal run artifacts are saved under:

```text
~/.moltbot/goals/<run_id>/
```

- Use those artifacts to diagnose failures, including run state, working notes, transcripts, and raw model outputs.
- For goal-system changes, run:

```sh
pnpm build
pnpm vitest run src/goal/
pnpm lint
node scripts/run-node.mjs <affected goal args>
```

- Do not mark `/goal` behavior complete unless the modified command path has been exercised and confirmed through real execution.
