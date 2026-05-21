# Stage 2Q Prompt and Verification Baseline Report

Date: 2026-05-20

## Summary

Stage 2Q centralized active prompt sources, unified worker backend instruction files behind one shared contract, strengthened planner/checker rules so implementation tasks are self-verifying, and restored the broad verification baseline.

The broad verification matrix is clean after one additional in-scope test cleanup fix in `src/agents/session-write-lock.test.ts`: the test now exercises lock cleanup for termination signals without triggering the production signal re-raise path inside the Vitest worker.

## Prompt Centralization

Active SmithersBot prompts now live under `src/prompts/` with lifecycle subfolders:

- `src/prompts/scout/`
- `src/prompts/planner/`
- `src/prompts/plan-autocheck/`
- `src/prompts/worker/`
- `src/prompts/repo-chat/`
- `src/prompts/post-execution-review/`
- `src/prompts/manual-tests/`
- `src/prompts/lessons/`
- `src/prompts/repair/`
- `src/prompts/agent-workspace/`

`src/prompts/README.md` maps lifecycle steps to their prompt sources and documents build-copy behavior. Runtime consumers import prompt text or thin loaders from this tree instead of carrying drift-prone inline prompt copies.

Scout prompt copying remains active: `scripts/copy-scout-template.ts` now copies `src/prompts/scout/scout_prompt_template.md` into `dist/prompts/scout/` during `pnpm build`.

Cron isolated-agent workspace templates were restored in a public-safe centralized location under `src/prompts/agent-workspace/` instead of the deleted `docs/reference/templates/` tree.

## Worker Context Unification

Decision: `CLAUDE.md` and `AGENTS.md` are equivalent backend instruction files and should not diverge.

Canonical source:

- `src/goal/worker-context/shared-worker-contract.md`

Mirrors:

- `src/goal/worker-context/AGENTS.md`
- `src/goal/worker-context/CLAUDE.md`

The three files are byte-for-byte identical. No backend-specific appendix is intentionally kept.

The shared contract preserves and merges:

- one-task boundary
- result protocol
- stuck/Ralph behavior
- production-quality expectations
- verification requirements
- git rules
- security rules
- file-operation rules
- dependency rules
- "Do NOT restart the gateway service during goal execution"

Strengthened verification behavior:

- Task `SUCCESS CRITERIA` are the minimum bar, not the full verification contract.
- Every code-changing task must include implementation, tests, and focused verification in the same task.
- Logic changes require adding/updating tests in the same task and running the smallest relevant test slice.
- TypeScript source or test changes require `pnpm exec tsc -p tsconfig.json`.
- Build/runtime wiring changes require `pnpm build`.
- Lint-sensitive source changes require `pnpm lint` or the narrow project lint command.
- Workers must list exact verification commands before reporting completion.

## Planner and Checker Behavior

Planner prompts now explicitly instruct that implementation and tests belong in the same task by default. They reject the old loophole where task-level success criteria could replace the global verification contract.

Plan autocheck/review prompts now flag:

- implementation/test splits where task A implements behavior and task B later adds tests
- logic-changing tasks with only `tsc` in success criteria
- command-handler/config/prompt/worker/repo-chat tasks without targeted regression tests
- vague success criteria that do not name test commands or paths
- many tiny repeated-touch tasks that should be fewer self-verifying tasks

Allowed cases remain:

- final verification matrix tasks
- report-writing tasks
- genuinely independent tasks
- large migrations where the plan explicitly explains why tests must be split

## Stage 2P Regression Examples

Bad 529 example now flagged:

- `add-529-transient-classifier` implements classifier behavior but only runs `pnpm exec tsc -p tsconfig.json`.
- tests are deferred into a later task.

Good 529 variant now expected:

- one task implements classifier behavior, updates messages/tests, and runs the focused Anthropic/backend fallback test slice plus applicable typecheck/build/lint.

Bad repo-chat example now flagged:

- output extraction, resolution-order fix, and regression tests are split into separate tasks touching the same behavior.

Good repo-chat variant now expected:

- one task updates repo-chat extraction/resolution behavior, adds regression tests, and runs `pnpm vitest run src/repo-chat/` plus applicable typecheck/build/lint.

The regression fixtures in planner/autocheck tests fence these Stage 2P patterns so future plans should reduce over-splitting and make implementation tasks self-verifying by default.

## Baseline Failure Groups

### `src/agents/clawdbot-gateway-tool.test.ts`

Fixed stale runtime expectation from old naming to current SmithersBot output. No old branding was reintroduced.

Additional verification uncovered and fixed a separate agents-suite cleanup issue: `src/agents/session-write-lock.test.ts` directly invoked termination cleanup for signals without another listener, causing the production re-raise path to terminate the Vitest worker. The test now registers a temporary keep-alive listener for every signal case, proving cleanup without killing the worker.

### `src/goal/cli-process.test.ts`

Current baseline passes. The credential-stripped subprocess environment contract remains intact: LLM subprocesses default to stripped env unless explicit backend env is supplied.

### `src/security/audit.test.ts`

Current baseline passes. Stage 2O secret-path gating and redaction behavior were not weakened.

### `src/security/fix.test.ts`

Fixed current-channel drift in the test fixture and added `googlechat` to the config fixer group-policy tightening path. This preserves, rather than weakens, group-policy protections.

### `src/telegram/bot.media.includes-location-text-ctx-fields-pins.test.ts`

Current baseline passes. The previous timeout/import-cycle failure is resolved without quarantine.

### `src/telegram/webhook.test.ts`

Current baseline passes. Webhook tests use safe localhost ephemeral binding and assert the actual bound port.

### Cron Isolated-Agent Template

Current baseline passes. Missing workspace templates are sourced from centralized prompt/workspace template files instead of restoring broad deleted docs trees.

## Tests Added or Updated

Prompt and planning quality tests now prove:

- active prompts resolve from `src/prompts/`
- scout prompt copy still works
- worker `AGENTS.md` and `CLAUDE.md` mirror the shared contract
- worker shared rules cannot drift silently
- strengthened verification rules are present in worker context
- planner prompt requires implementation and tests in the same task by default
- planner prompt says `SUCCESS CRITERIA` are additive minimums
- plan autocheck flags implementation/test splits
- plan autocheck flags logic-changing `tsc`-only success criteria
- Stage 2P bad/good 529 and repo-chat fixtures are covered

Baseline tests were updated or fixed in:

- `src/agents/clawdbot-gateway-tool.test.ts`
- `src/agents/session-write-lock.test.ts`
- `src/security/fix.test.ts`
- Telegram webhook/media tests
- cron isolated-agent workspace template tests

## Verification Results

Commands run before this report was written:

- `pnpm vitest run src/goal/ src/prompts/ src/config/` - passed, 86 files passed, 1 skipped; 1052 tests passed, 9 skipped.
- `pnpm vitest run src/security/` - passed, 5 files passed; 129 tests passed.
- `pnpm vitest run src/agents/` - first run failed due `src/agents/session-write-lock.test.ts` killing the Vitest worker through the production signal re-raise path; fixed in-scope test cleanup and reran.
- `pnpm vitest run src/agents/session-write-lock.test.ts` - passed, 1 file; 8 tests passed.
- `pnpm vitest run src/agents/` - passed after the fix, 195 files passed; 980 tests passed.
- `pnpm vitest run src/telegram/` - passed, 54 files passed; 614 tests passed.
- `pnpm vitest run src/cron/` - passed, 9 files passed; 69 tests passed.
- `pnpm vitest run src/repo-chat/` - passed, 2 files passed; 69 tests passed.
- `pnpm vitest run src/telegram/goal-commands.test.ts` - passed, 1 file; 196 tests passed.
- `pnpm exec tsc -p tsconfig.json` - passed.
- `pnpm build` - passed; scout prompt and worker contract copy steps completed.
- `pnpm lint` - passed, 0 warnings and 0 errors.
- `git diff --stat` - before report, showed only `src/agents/session-write-lock.test.ts | 8 ++------`.
- `git grep -n "SUCCESS CRITERIA" src/ AGENTS.md CLAUDE.md` - passed; found planner, worker-context, tests, and prompt references.
- `git grep -n "Run the smallest relevant test slice" src/ AGENTS.md CLAUDE.md` - passed; found global and worker-context references.
- `git grep -n "scout_prompt_template.md"` - passed; active references point at `src/prompts/scout/` and build-copy scripts/tests, with only historical internal report/log mentions.
- `git grep -n -E "worker-context/AGENTS.md|worker-context/CLAUDE.md|shared-worker-contract"` - passed; active references point at the shared worker contract and mirror tests/build copy.

Final verification after this report:

- `pnpm test` - passed, 1 file passed; 15 tests passed.

## Remaining Failures or Blockers

None.

No remaining failure required weakening Stage 2O protections or operator decision.

## Intentional Prompt Drift

None. Active prompt text is centralized under `src/prompts/` or loaded through thin wrappers from that tree. Historical `internal/` reports and prior verification logs still mention old paths as historical artifacts only.

## Dogfood Readiness

This should reduce future goal over-splitting because the planner, worker contract, and autocheck now all express the same rule: code-changing tasks must be self-verifying and task success criteria are additive minimums.

The broad verification baseline is clean enough for final Codex-only dogfood.
