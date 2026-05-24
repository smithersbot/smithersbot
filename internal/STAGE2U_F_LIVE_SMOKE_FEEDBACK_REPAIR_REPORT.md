# Stage 2U-F Live Smoke Feedback Repair Report

Generated: 2026-05-24

This report records the feedback from the combined live Stage 2U-F smoke goal and the
repairs applied afterward. It intentionally omits secret values, raw auth/session/config
contents, raw backend JSON, and sensitive absolute paths.

## Live-Smoke Findings

The live smoke passed these checks:

- Subscription-backed worker execution worked through the configured backends with no
  API-key prompt or auth failure.
- Safe tracked repository reads worked.
- Live sandbox denial blocked sensitive content reads by category and denied the
  outside-workspace write probe.
- The redacted runtime mirror existed under `agent/history`, with valid
  `runtime/index.json` entries and no mirror failure warnings in the inspected snapshot.
- Worker hard-deny prompts were grouped, deduped, and near the beginning of the worker
  prompt.
- No secret contents were found in the inspected report or mirrored artifacts.

The smoke exposed three repair items:

- The scout/planner prompt still exposed the private runtime store as a live
  scout/planning output target.
- `runtime/manual-tests/` and per-goal lessons evidence were missing from the
  post-completion agent-history mirror.
- The cron mirror was inconclusive before any completed cron run because production only
  called the mirror after a cron run finished.

## Scout/Planner Prompt Leak

Root cause: `src/goal/cli-planner.ts` rendered the planner prompt with the raw
`scoutDir` returned by `resolveScoutDir`, which resolves through `resolveRunDir` into
`$STATE_DIR/goals/<goalId>/scout`. In the live environment, `$STATE_DIR` is the private
runtime store. That raw path was injected as `{{OUTPUT_DIR}}` into both:

- `src/prompts/scout/scout_prompt_template.md`
- the Canonical Execution Plan Output appendix built by `buildPlanAndScoutAppendix`

Fix applied: the host still keeps the private `scoutDir` internally so it can parse the
actual `execution_plan.json`, but the model-facing prompt now describes scout and plan
artifacts with the redacted mirror form:
`agent/history/goals/<workspace>/<goalId>/runtime/scout/...`.

The scout template, cached scout references, and replan prompt references were updated
so generated prompts do not instruct agents to read from, write to, or output to the
private runtime store. The private path may still appear only in hard-deny/private-runtime
context.

Regression coverage was strengthened so a full rendered planner/scout prompt using a
state directory whose path contains `.clawdbot-dev` contains no `.clawdbot-dev`
substring while still preserving distinct Scout and Planner phases and
`agent/history` scout references.

## Manual-Tests Mirror Repair

Diagnosis: the goal completion path generated manual-test artifacts after the last
runtime mirror checkpoint. The worker checkpoint mirrored prompt/result/stdout/stderr,
but post-completion `manual-tests/` artifacts were created later and were not mirrored
into agent history.

Fix applied: `src/goal/agent-executor.ts` now invokes `mirrorGoalRuntimeToAgentHistory`
best-effort after post-completion lessons extraction and manual-test generation. The
hook is fail-open like the existing mirror calls, so mirror failures record diagnostics
without failing goal completion.

Result: when manual tests are generated, `runtime/manual-tests/` is captured in
`agent/history` and indexed by `runtime/index.json`.

## Lessons Mirror Repair

Diagnosis: extracted lessons were written to the global lessons store, which is not a
per-goal runtime artifact and must not be mirrored wholesale into agent-visible history.
The live smoke therefore had no per-goal `runtime/lessons/` evidence.

Fix applied: lessons extraction now writes per-goal evidence under the run's
`lessons/` runtime directory, specifically this run's extracted lessons evidence rather
than copying the global lessons store. The post-completion mirror runs after lessons and
manual-tests work, so `runtime/lessons/` becomes visible in agent history.

This preserves the distinction between the global lessons store and per-goal runtime
evidence while giving future agents enough context to debug what happened for a single
goal.

## Cron Mirror Repair

Diagnosis branch taken: the cron mirror helper already knew how to create
`agent/history/cron/index.json` and mirror `jobs.json` when a cron store exists even if
there are no run logs. The production wiring was the limiting factor: the gateway only
called the mirror after a cron run finished.

Fix applied: `src/gateway/server-cron.ts` now performs a small best-effort cron mirror
when an existing cron store is available during gateway cron setup/startup. It does not
trigger or schedule cron runs. The existing include filter remains limited to
`jobs.json` and `runs/*.jsonl`, and backup files remain excluded.

Status: the repair implements the index-before-runs behavior for an existing cron store.
A future live smoke after gateway restart should see `agent/history/cron/index.json`
when the cron store exists, even before a completed cron run is available.

## Tests Added Or Updated

Prompt leak repair:

- `src/goal/cli-planner.test.ts`
- `src/goal/scout.test.ts`
- `src/prompts/prompts.test.ts`

Manual-tests and lessons mirror repair:

- `src/goal/agent-executor.test.ts`
- `src/goal/manual-tests.test.ts`
- `src/goal/lessons.test.ts`
- `src/goal/runtime-mirror.test.ts`

Cron mirror repair:

- `src/goal/runtime-mirror.test.ts`
- `src/gateway/server-cron.nightwatch.test.ts`

Focused verification commands reported by the repair tasks:

- `pnpm vitest run src/goal/cli-planner.test.ts src/goal/scout.test.ts src/prompts/prompts.test.ts`
- `pnpm vitest run src/goal/agent-executor.test.ts src/goal/manual-tests.test.ts src/goal/lessons.test.ts src/goal/runtime-mirror.test.ts`
- `pnpm vitest run src/goal/runtime-mirror.test.ts`
- `pnpm vitest run src/gateway/server-cron.nightwatch.test.ts`
- `pnpm exec tsc -p tsconfig.json`
- `pnpm build`
- `pnpm lint`

All focused verification reported by the repair tasks passed.

This report task additionally re-ran:

- `test -f internal/STAGE2U_F_LIVE_SMOKE_FEEDBACK_REPAIR_REPORT.md`
- report scan for home-directory absolute paths and token/private-key marker bodies
- `pnpm vitest run src/prompts/prompts.test.ts src/goal/runtime-mirror.test.ts src/gateway/server-cron.nightwatch.test.ts`
- `pnpm build`
- `pnpm lint`

Those commands passed. `pnpm build` includes `tsc -p tsconfig.json`.

## Manual Verification After Gateway Restart

An operator can validate the repairs after the next gateway restart with a small
disposable goal:

1. Let the normal planner, autocheck, worker, manual-test, and lessons lifecycle run.
2. Inspect only agent-visible history under `agent/history/goals/<workspace>/<goalId>/`.
3. Confirm generated planner/scout prompts reference
   `agent/history/goals/<workspace>/<goalId>/runtime/scout/...` for scout artifacts and
   do not instruct agents to use the private runtime store as a read/write/output target.
4. Confirm worker hard-deny content remains grouped, deduped, and near the beginning.
5. Confirm `runtime/manual-tests/` appears after completion when manual tests are
   generated.
6. Confirm `runtime/lessons/` contains per-goal lessons evidence and does not copy the
   global lessons store.
7. Confirm `runtime/index.json` records byte counts, redaction counts, truncation flags,
   skipped flags, and skip reasons where applicable.
8. If a cron store exists, confirm `agent/history/cron/index.json` and `jobs.json` are
   mirrored before any new completed cron run is required; if run logs exist, confirm
   `runs/*.jsonl` entries are mirrored and backup files are excluded.
9. Confirm no secret values, raw auth/session/config contents, token bodies, or
   sensitive absolute paths appear in prompts, reports, or mirrored history.

## Result

The live-smoke feedback has been addressed in code and tests. The remaining validation
is operational: after the gateway runs the updated code, perform the manual verification
steps above against a new disposable goal and cron store state.
