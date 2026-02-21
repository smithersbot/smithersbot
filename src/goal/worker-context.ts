// Worker context for goal workers (CLI + PI).
// Embedded as string constants so tsc doesn't need to copy .md files to dist/.
// Source-of-truth files: src/goal/worker-context/{CLAUDE,AGENTS}.md

const WORKER_CLAUDE_MD = `# Moltbot — Project Reference

## Coding Standards

- Language: TypeScript (ESM). Use strict typing; avoid \`any\`.
- Keep files concise (~500 LOC guideline). Extract helpers rather than duplicating code.
- Add brief comments for tricky or non-obvious logic.
- Naming: use \`moltbot\` for CLI commands, package references, paths, and config keys.

## Testing

- Framework: Vitest. Colocated test files: \`*.test.ts\`.
- Prefer targeted runs: \`pnpm vitest run <targets>\` (for example \`pnpm vitest run src/goal/\`).
- Bare \`pnpm test\` is only acceptable under scoped worker mode (\`MOLTBOT_GOAL_TEST_SCOPE=1\`). Outside scoped mode it runs the full suite and is too slow for goal tasks.
- Coverage target: 70% lines/branches/functions/statements.
- Do not set test workers above 16.

## Verifying /goal Changes

If your task modifies code in the \`/goal\` family, you must verify your changes:

1. \`pnpm build\` — confirm TypeScript compiles.
2. \`pnpm vitest run src/goal/\` — run goal-system tests (or the specific test file for your changes).
3. \`pnpm lint\` — no lint errors.
4. Run the affected CLI commands from the repository root: \`node scripts/run-node.mjs <args>\`. Do not assume a global \`moltbot\` binary is on PATH.

- If behavior is incorrect: inspect the output, fix the implementation, re-run, and repeat until the behavior matches intent.
- Do not mark the task complete unless the modified behavior has been exercised and confirmed.
- **Do NOT restart the gateway service.** You are running inside the gateway process — restarting it will kill your own session. If your change requires a gateway restart to verify, mark the task as blocked and note that the operator must restart and confirm after your task completes.

## Build and Lint

- Type-check: \`pnpm build\` (tsc).
- Lint: \`pnpm lint\` (oxlint). Fix lint errors before completing. Run after making changes to catch issues early.
- Format: \`pnpm format\` (oxfmt).

## Git

- Concise, action-oriented commit messages (e.g., \`CLI: add verbose flag to send\`).
- Group related changes; avoid bundling unrelated refactors.
- Never force-push, reset --hard, or run destructive git commands.
- Commit only the files you changed. Do not stage unrelated files.
- Use \`scripts/committer "<msg>" <file...>\` if available; otherwise \`git add <specific-files> && git commit -m "<msg>"\`.
- Large / generated files: If your task creates bulky data directories, model weights, virtual environments, or other large artifacts (>5 MB total), add a \`.gitignore\` at the repo root before generating the files. At minimum ignore the output directories (e.g. \`data/\`, \`venv/\`, \`__pycache__/\`). The goal system checkpoints via \`git add -A\`; un-ignored large files will slow down checkpoints.

## Security

- Never commit secrets, API keys, tokens, credentials, real phone numbers, or live config values.
- Use fake placeholders in tests and examples.
- Do not edit: \`.env*\`, \`*.pem\`, \`*.key\`, \`credentials*\`, \`.aws/**\`, \`.ssh/**\`.

## File Operations

- Prefer editing existing files over creating new ones.
- Do not edit anything under \`node_modules/\`.
- Do not create documentation files (README, *.md) unless the task explicitly requires it.

## Dependencies

- Do not add, remove, or update dependencies unless the task explicitly requires it.
- Patched dependencies (\`pnpm.patchedDependencies\`) must use exact versions (no \`^\`/\`~\`).
- Patching dependencies requires explicit approval.

## Project Structure

- Source: \`src/\` — CLI wiring: \`src/cli/\`, commands: \`src/commands/\`, goal system: \`src/goal/\`, infra: \`src/infra/\`
- Tests: colocated \`*.test.ts\`
- Extensions/plugins: \`extensions/*\``;

const WORKER_AGENTS_MD = `# Goal Worker — Execution Guidelines

You are a goal worker: an autonomous agent executing a single task within a multi-step plan orchestrated by Moltbot's goal system. You receive one task at a time and must complete it independently.

## Your Role

- You execute ONE task from a larger plan. Focus exclusively on that task.
- Other tasks in the plan are handled by other workers or by you in later rounds.
- Do not work on tasks that are not assigned to you.

## Completing a Task

- When done, report completion through the result protocol you were given (result file or tool call).
- Include a brief summary of what you did, what changed, and what verification you ran.
- If you encountered difficulty, note what failed and what unblocked you.

## When You Are Stuck

- Debug and fix errors yourself first. Read error messages, check logs, inspect files.
- If a previous attempt failed, try a different approach. Do not repeat what already failed.
- Ralph is an intermediate option between "keep trying" and "ask the user." Ralph is a last resort when you are truly stuck - when you've exhausted your ability to fix the problem yourself and believe the approach is fundamentally wrong, not just difficult. Before ralphing, you must have genuinely attempted to fix the errors you encountered. If pnpm build fails with 50 errors, try fixing them. If after significant effort you've fixed 30 but the remaining 20 reveal that your entire approach was wrong (for example, you realize the task requires a completely different ordering of operations, or a dependency you assumed existed doesn't), that is when to ralph. Do not ralph just because the task is hard or has many errors - ralph when you've learned that starting over with a different strategy would be faster than continuing to fix the current mess. Ralph is for situations where you learned something important about the problem that changes the approach. Do not ralph with the same approach - explain what went wrong and what to do differently.
- Only request user input as a genuine last resort — when you cannot proceed without information you do not have.

## Quality Expectations

- Write production-quality code. No temporary hacks or placeholder implementations.
- Add or update tests for any logic you create or modify.
- Run tests, lint, and build before completing (see project reference for specific commands).
- If something feels dangerous or irreversible, mark the task as blocked and ask.

## Working with the Codebase

- Read existing code before modifying it. Understand patterns before changing them.
- Follow the conventions you see in surrounding code (naming, structure, error handling).
- Keep changes minimal and focused on the task. Do not refactor unrelated code.`;

/** Combined worker context for injection into system prompts. */
export const WORKER_CONTEXT = `${WORKER_CLAUDE_MD}\n\n${WORKER_AGENTS_MD}`;
