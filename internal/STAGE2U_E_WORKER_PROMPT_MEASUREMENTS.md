# Stage 2U-E Worker Prompt Measurements

Scope: `optimize-worker-prompt`.

Source material used: Stage 2U-C identified worker prompts as the highest-value token target and Stage 2U-E preflight scoped this task to `src/goal/cli-worker.ts`, `src/prompts/worker/worker-context.ts`, `src/goal/attempt-bundle.ts`, and `src/goal/cli-worker.test.ts`. The worker sandbox was not changed.

## Prompt Structure

- `buildCliWorkerPrompt` now starts with a byte-stable static instruction prefix containing the worker role, hard-deny preamble, verification requirement, and complete/ralph/blocked/failed result contract.
- Dynamic run content now starts at `DYNAMIC TASK CONTEXT:` and contains the goal, plan context, lessons, completed tasks, resume context, assigned task, success criteria, constraints, concrete hard-deny list, previous attempt summary, and result path.
- Codex and Claude Code prompt artifact capture still persists the assembled prompt before backend spawn, and token usage capture remains in the worker result path.

## Attempt History

- `formatAttemptBundleSummary` now preserves structured labels for attempt number, backend, outcome, duration, changed files, diffstat, error classification, Ralph details, build-gate failure, log excerpt, and tool calls.
- Noisy build-gate output and log excerpts are compacted to a bounded start/end summary when they exceed 1200 characters.

## Prompt Counts

Representative fixture:
- task: `optimize-worker-prompt`
- one completed preflight task
- one lesson
- full hard-deny list
- failed prior attempt with repeated build output and log excerpt

| Surface | Before chars | After chars | Delta | Notes |
| --- | ---: | ---: | ---: | --- |
| Worker prompt | 23353 | 14646 | -8707 | Static prefix moved first and repeated attempt history compacted. |
| Attempt summary only | 12131 | 2861 | -9270 | Build-gate output and log excerpt retain start/end context with omission marker. |

Stable worker prefix in the representative fixture: 1775 chars. Dynamic context starts after character 1775.

Expected cache effect: the worker role, security framing, verification rule, and result contract are now the leading stable prefix across different tasks and retry attempts. Dynamic task/run/history data follows that prefix, so repeated worker launches should gain cache reuse on the first 1775 characters while also sending substantially less repeated failure output on retries.

## Verification During Task

- `pnpm vitest run src/goal/cli-worker.test.ts`
- `pnpm exec tsc -p tsconfig.json`
- `pnpm build`
