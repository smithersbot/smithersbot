# Moltbot — Worker Guidelines

You are a worker executing a single task within a larger goal plan. These guidelines apply to the codebase you are working in.

## Coding Standards

- Language: TypeScript (ESM). Use strict typing; avoid `any`.
- Keep files concise (~500 LOC guideline). Extract helpers rather than duplicating code.
- Add brief comments for tricky or non-obvious logic.
- Naming: use `moltbot` for CLI commands, package references, paths, and config keys.

## Testing

- Framework: Vitest. Colocated test files: `*.test.ts`.
- When you create or modify logic, add or update tests to cover your changes.
- The full test suite (`pnpm test`) is very large and slow. Do NOT run it. Instead, run only the tests relevant to your changes: `pnpm vitest run src/goal/` for goal-system changes, or `pnpm vitest run <path-to-specific-test>` for anything else.
- Coverage target: 70% lines/branches/functions/statements.
- Do not set test workers above 16.

## Verifying /goal Changes

If your task modifies any command in the `/goal` family, you must verify that change by running the relevant command(s) via the local CLI and observing the actual runtime behavior.

- Run CLI commands from the repository root: `node scripts/run-node.mjs <args>` (or `npm run moltbot -- <args>`).
- Do not assume a global `moltbot` binary is available on PATH.
- If your change affects the running gateway, restart the service: `systemctl --user restart moltbot-gateway-dev.service`.
- Logs (optional, for debugging): `journalctl --user -u moltbot-gateway-dev.service -f`.
- Run artifacts persist to `~/.moltbot/goals/<run_id>/` — use these to diagnose failures and confirm correct behavior.
- If behavior is incorrect: inspect run artifacts, fix the implementation, re-run, and repeat until the behavior matches intent.
- Do not mark the task complete unless the modified `/goal` behavior has been exercised and confirmed through real execution.

## Build and Lint

- Type-check: `pnpm build` (runs tsc).
- Lint: `pnpm lint` (oxlint). Fix lint errors before completing.
- Format: `pnpm format` (oxfmt).
- Run `pnpm lint` after making changes to catch issues early.

## Git

- Use concise, action-oriented commit messages (e.g., `CLI: add verbose flag to send`).
- Group related changes in a single commit; avoid bundling unrelated refactors.
- Never force-push, reset --hard, or run destructive git commands.
- Commit only the files you changed. Do not stage unrelated files.
- Use `scripts/committer "<msg>" <file...>` if available; otherwise `git add <specific-files> && git commit -m "<msg>"`.

## Security

- Never commit secrets, API keys, tokens, or credentials.
- Never commit real phone numbers, videos, or live configuration values.
- Use obviously fake placeholders in tests and examples.
- Do not edit files matching: `.env*`, `*.pem`, `*.key`, `credentials*`, `.aws/**`, `.ssh/**`.

## File Operations

- Prefer editing existing files over creating new ones.
- Do not edit anything under `node_modules/`.
- Do not create documentation files (README, *.md) unless the task explicitly requires it.

## Dependencies

- Do not add, remove, or update dependencies unless the task explicitly requires it.
- Any dependency with `pnpm.patchedDependencies` must use an exact version (no `^`/`~`).
- Patching dependencies requires explicit approval.

## Project Structure

- Source code: `src/`
- Tests: colocated `*.test.ts`
- CLI wiring: `src/cli/`
- Commands: `src/commands/`
- Goal system: `src/goal/`
- Infra: `src/infra/`
- Extensions/plugins: `extensions/*`
