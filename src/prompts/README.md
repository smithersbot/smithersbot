# src/prompts/

Centralized home for SmithersBot's active goal-system and repo-chat prompts.
Every lifecycle step that sends an LLM a prompt has its canonical text or
builder in this tree. Source files in `src/goal/`, `src/repo-chat/`, etc.
re-export from here so the prompt body is never duplicated.

Historical or internal prompt artifacts under `internal/`, `docs/`, and
`scripts/` are intentionally *not* migrated — only active runtime prompts live
here.

## Layout

```
src/prompts/
  README.md                         this file
  scout/
    scout_prompt_template.md        runtime template (copied to dist at build)
    loader.ts                       resolves the template path
  planner/
    system-prompt.ts                buildPlanSystemPrompt()
  plan-autocheck/
    review-instruction.ts           REVIEW_INSTRUCTION constant
  worker/
    worker-context.ts               WORKER_CONTEXT / WORKER_CLAUDE_CONTEXT
                                    / WORKER_AGENTS_CONTEXT — reads from
                                    src/goal/worker-context/shared-worker-contract.md
  agent-workspace/
    templates.ts                    local/isolated agent workspace bootstrap
                                    templates
  repo-chat/
    repo-chat-context.ts            REPO_CHAT_CONTEXT
    response-file-instruction.ts    buildResponseFileInstruction()
                                    and CODEX_STYLE_DIRECTIVE
  manual-tests/
    system-prompt.ts                MANUAL_TESTS_SYSTEM_PROMPT
  lessons/
    extraction-prompt.ts            buildLessonExtractionPrompt()
                                    and buildClaudeExtractionPrompt()
  repair/
    repo-chat-repair.ts             REPO_CHAT_SANDBOX_REPAIR_PROMPT
```

## Lifecycle map

Every active LLM lifecycle step must have an explicit persistence behavior.
Agent-readable copies go under `<managed-root>/agent/history/` as sanitized
summaries, indexed artifacts, and a redacted runtime mirror.
Redacted runtime artifacts are mirrored into agent history with generous caps and an index.
Forbidden files, private env values, gateway config, and credentials must never
be mirrored into agent history.

| Lifecycle step          | Prompt source                                                       | Used by                                       | Persistence behavior |
| ----------------------- | ------------------------------------------------------------------- | --------------------------------------------- | -------------------- |
| Scout                   | `scout/scout_prompt_template.md` + `scout/loader.ts`                | `src/goal/scout.ts`, `src/goal/cli-planner.ts`| Persisted inside goal run state and mirrored through the sanitized goal summary under `agent/history/goals/<workspace>/<runId>/summary.json` (indexed once in `agent/history/index/all-goals.jsonl`); the redacted scout artifacts are also mirrored into agent history through the runtime mirror with generous caps and an index. |
| Planner system prompt   | `planner/system-prompt.ts`                                          | `src/goal/planner.ts`, `src/goal/cli-planner.ts` | Plan metadata is persisted in `run.json` and mirrored as sanitized plan summary/step metadata under `agent/history/goals/<workspace>/<runId>/summary.json`; the redacted raw planner output is mirrored into agent history through the runtime mirror with generous caps and an index. |
| Plan autocheck reviewer | `plan-autocheck/review-instruction.ts`                              | `src/goal/plan-autocheck.ts`                  | Review outcome is persisted as goal-run metadata and becomes searchable through the sanitized goal summary; the redacted reviewer output is mirrored into agent history through the runtime mirror with generous caps and an index. |
| Worker context (CLI)    | `worker/worker-context.ts` (reads `src/goal/worker-context/shared-worker-contract.md`) | `src/goal/cli-worker.ts`, `src/goal/pi-runner.ts` | Worker result/status is persisted in the runtime run store and mirrored as sanitized step status/title metadata in the goal summary; the redacted worker stdout/stderr is mirrored into agent history through the runtime mirror with generous caps and an index. |
| Agent workspace bootstrap | `agent-workspace/templates.ts`                                  | `src/agents/workspace.ts`, cron isolated-agent runs | No LLM call is made by the bootstrap template loader itself; generated workspace instruction files are local workspace artifacts, not history records. |
| Repo-chat context       | `repo-chat/repo-chat-context.ts`                                    | `src/repo-chat/repo-chat-worker.ts`           | Repo-chat session metadata is persisted in the runtime repo-chat store and mirrored as sanitized summaries under `agent/history/repo-chats/<workspace>/<sessionId>/summary.json`; indexed once in `agent/history/index/all-repo-chats.jsonl`. |
| Repo-chat delivery      | `repo-chat/response-file-instruction.ts`                            | `src/repo-chat/repo-chat-worker.ts`           | Final response text is persisted through the repo-chat session store with secret redaction before the sanitized summary mirror is updated; temp response files are runtime scratch artifacts and are not mirrored. |
| Repo-chat repair        | `repair/repo-chat-repair.ts`                                        | `src/repo-chat/repo-chat-worker.ts`           | Repair output is treated as repo-chat response content and follows the same redacted repo-chat session persistence; repair scratch files/transcripts are not mirrored. |
| Manual-test suggester   | `manual-tests/system-prompt.ts`                                     | `src/goal/manual-tests.ts`                    | Suggested manual checks are stored in goal-run metadata when produced and exposed via the sanitized goal summary; the redacted manual-tests output is mirrored into agent history through the runtime mirror with generous caps and an index. |
| Lesson extraction       | `lessons/extraction-prompt.ts`                                      | `src/goal/lessons.ts`                         | Extracted lessons are persisted as reusable lessons in the runtime store; any goal-run linkage is searchable through the sanitized goal summary, while the redacted lessons artifacts are mirrored into agent history through the runtime mirror with generous caps and an index. |

## Build wiring

- `scripts/copy-scout-template.ts` copies `scout/scout_prompt_template.md`
  into `dist/prompts/scout/` so the compiled runtime can resolve it via the
  loader.
- `scripts/copy-worker-contract.ts` copies the canonical
  `src/goal/worker-context/shared-worker-contract.md` and its byte-identical
  mirrors (`AGENTS.md`, `CLAUDE.md`) into `dist/goal/worker-context/` so the
  compiled `worker/worker-context.ts` loader can read the contract at runtime.
- All other prompts ship as TypeScript modules and are emitted to
  `dist/prompts/**` by `tsc`.

## Worker context unification

Workers see one canonical contract regardless of backend:

- `src/goal/worker-context/shared-worker-contract.md` — single source of truth.
- `src/goal/worker-context/AGENTS.md` — Codex-readable mirror (byte-identical).
- `src/goal/worker-context/CLAUDE.md` — Claude Code-readable mirror (byte-identical).

`src/prompts/worker/worker-context.ts` loads `shared-worker-contract.md` at
module load. `WORKER_CLAUDE_CONTEXT`, `WORKER_AGENTS_CONTEXT`, and
`WORKER_CONTEXT` all resolve to the same string — there is no backend-specific
appendix. Drift between the three markdown files is caught by the suite in
`src/prompts/prompts.test.ts`.

## When adding a new active prompt

1. Place the canonical text or builder in the appropriate lifecycle subfolder.
2. Import from `src/prompts/<lifecycle>/...` in the consumer (do not paste the
   prompt body into the consumer).
3. If the prompt is read from disk at runtime, extend
   `scripts/copy-scout-template.ts` (or add a new copy script) so the file is
   present under `dist/prompts/`.
4. Add a row to the lifecycle table above.
5. Cover the new path with a `src/prompts/*.test.ts` resolution test.
