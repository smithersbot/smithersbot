# Moltbot — Project Reference

## Coding Standards

- Language: TypeScript (ESM). Use strict typing; avoid `any`.
- Keep files concise (~500 LOC guideline). Extract helpers rather than duplicating code.
- Add brief comments for tricky or non-obvious logic.
- Naming: use `moltbot` for CLI commands, package references, paths, and config keys.

## Testing

- Framework: Vitest. Colocated test files: `*.test.ts`.
- The full test suite (`pnpm test`) is very large and slow. Do NOT run it. Instead, run only the tests relevant to your changes: `pnpm vitest run src/goal/` for goal-system changes, or `pnpm vitest run <path-to-specific-test>` for anything else.
- Coverage target: 70% lines/branches/functions/statements.

## Verifying /goal Changes

If your task modifies any command in the `/goal` family, you must verify by running the relevant command(s) via the local CLI and observing actual runtime behavior.

- Run from the repository root: `node scripts/run-node.mjs <args>` (or `npm run moltbot -- <args>`).
- Do not assume a global `moltbot` binary is on PATH.
- If your change affects the gateway, restart: `systemctl --user restart moltbot-gateway-dev.service`.
- Run artifacts persist to `~/.moltbot/goals/<run_id>/` — use these to diagnose failures.
- Do not mark the task complete unless modified `/goal` behavior has been confirmed through real execution.

## Build and Lint

- Type-check: `pnpm build` (tsc).
- Lint: `pnpm lint` (oxlint). Fix lint errors before completing.
- Format: `pnpm format` (oxfmt).

## Git

- Concise, action-oriented commit messages (e.g., `CLI: add verbose flag to send`).
- Group related changes; avoid bundling unrelated refactors.
- Commit only files you changed. Use `scripts/committer "<msg>" <file...>` if available.

## Security

- Never commit secrets, API keys, tokens, credentials, real phone numbers, or live config values.
- Use fake placeholders in tests and examples.
- Do not edit: `.env*`, `*.pem`, `*.key`, `credentials*`, `.aws/**`, `.ssh/**`.

## Dependencies

- Do not add, remove, or update dependencies unless the task explicitly requires it.
- Patched dependencies (`pnpm.patchedDependencies`) must use exact versions (no `^`/`~`).

## Project Structure

- Source: `src/` — CLI wiring: `src/cli/`, commands: `src/commands/`, goal system: `src/goal/`, infra: `src/infra/`
- Tests: colocated `*.test.ts`
- Extensions/plugins: `extensions/*`
