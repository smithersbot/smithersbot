# Stage 2U-E Manual-Tests And Lessons Measurements

Scope: `harden-and-optimize-manualtests-lessons`.

## Source Material

- Used the Stage 2U-C target list carried into `internal/STAGE2U_E_PREFLIGHT.md`.
- Targeted only `manual-tests` and `lessons`; worker, repo-chat, planner, autocheck, post-exec review, pi, `/usage_status`, and `/usage_history` were not changed in this task.

## Prompt Counts

Representative manual-tests fixture:
- goal: `Improve authentication reliability`
- three completed auth/session/test steps
- one recorded automated check: `pnpm vitest run src/auth.test.ts`

Representative lessons fixture:
- run: `extract-run-success`
- one existing lesson
- one plan correction, one Ralph insight, and one failed step result

| Surface | Before chars | After chars | Result |
| --- | ---: | ---: | --- |
| manual-tests combined prompt | 3104 | 3104 | unchanged; already static system prompt first |
| manual-tests user message | 680 | 680 | unchanged |
| lessons Codex prompt | 2686 | 2686 | unchanged size; static contract moved before dynamic run/correction data |
| lessons Claude wrapped prompt | 2969 | 2969 | unchanged size; inherits reordered user prompt |

Expected cache effect:
- Manual-tests keeps the stable `MANUAL_TESTS_SYSTEM_PROMPT` at the front of the combined prompt.
- Lessons now keeps the lesson-extraction contract, framing, schema, and rules before the dynamic run id, working directory, existing lessons, and correction summary. In the representative fixture, dynamic run content starts after character 1854.

## Hardening

- Manual-tests Codex CLI now uses the shared Codex native sandbox helper with `purpose: "repo-chat"`, read-only writable paths, credential-stripped env, and network enabled for the model backend.
- Manual-tests Claude Code CLI now uses the shared Claude Code sandbox launch settings with `purpose: "repo-chat"` while preserving subscription auth env construction.
- Lessons Codex CLI now uses the shared Codex native sandbox helper with `purpose: "repo-chat"` and no `--skip-git-repo-check`.
- Lessons Claude Code CLI now uses the shared Claude Code sandbox launch settings with `purpose: "repo-chat"` while preserving read-only tool prompts and subscription auth.

## Verification During Task

- Focused test command initially run: `pnpm vitest run src/goal/manual-tests.test.ts src/goal/lessons.test.ts`
- Initial result: lessons passed; manual-tests had one stale env-shape assertion after CODEX_HOME/PATH sandbox injection. The assertion was updated to verify credential stripping plus sandbox env injection.
