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

If your task modifies code in the `/goal` family, you must verify your changes:

1. `pnpm build` — confirm TypeScript compiles.
2. `pnpm vitest run src/goal/` — run goal-system tests (or the specific test file for your changes).
3. `pnpm lint` — no lint errors.
4. Run the affected CLI commands from the repository root: `node scripts/run-node.mjs <args>`. Do not assume a global `moltbot` binary is on PATH.

- If behavior is incorrect: inspect the output, fix the implementation, re-run, and repeat until the behavior matches intent.
- Do not mark the task complete unless the modified behavior has been exercised and confirmed.
- **Do NOT restart the gateway service.** You are running inside the gateway process — restarting it will kill your own session. If your change requires a gateway restart to verify, mark the task as blocked and note that the operator must restart and confirm after your task completes.

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
