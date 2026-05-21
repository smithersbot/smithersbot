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
- Verify before reporting completion. Run the smallest relevant test slice plus typecheck, build, and lint when behavior changes.
- If verification fails, inspect the output, fix the implementation, and rerun the affected command.
- If an environment limitation blocks verification, report the exact command and blocker.

## Goal-System Self-Verification
- Stage 2S defaults new goal workspaces to `~/smithersbot-goals/agent/workspaces/<workspace>/repo`.
- Legacy `workingDir` values outside the managed agent root remain supported during this transition with a warning; operators can set `goal.allowLegacyWorkingDir=false` to fail closed.
- Real workspace env files live host-side in `~/smithersbot-goals/private/env/<workspace>/.env` and are not agent-visible.
- Agents should use repo-root `.env.example` for variable names and project code should read normal environment variables, such as `process.env.GOOGLE_DRIVE_API_KEY` or `os.environ["GOOGLE_DRIVE_API_KEY"]`.
- Goal workers do not receive raw private env values by default. Private env may only be loaded by trusted host-side commands with an explicit opt-in, and SmithersBot does not claim OS-level isolation beyond the native Codex/Claude sandbox currently in use.
- If a change affects any command in the `/goal` family, exercise the affected CLI path yourself before marking the work complete.
- Use the local Node entrypoint from the repository root:

```sh
node scripts/run-node.mjs <args>
```

- Goal run artifacts are saved under:

```text
~/.smithersbot/goals/<run_id>/
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
