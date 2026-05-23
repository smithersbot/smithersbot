# Stage 2U-B — Scheduler Backend Fallback Repair Report

Generated: 2026-05-23. Repository-local, generic report. No API key, auth file,
token, env value, raw statusline payload, private hostname/path, or config secret
was printed, hashed, encoded, or persisted at any point in producing this report.

This report documents the repair of a live mixed-backend orchestration bug in
which a Codex out-of-credits failure blocked/interrupted an entire goal even
though Claude Code was available and independent runnable work remained
(observed live on goal `8cec60ca`, Stage 2U-C, step `security-sandbox-audit`).

Relevant commits (this goal):

- `d0889dde3` — `executor-fallback-and-drain`
- `1f2b9dfb5` — `display-usage-limited`
- `452d95bc3`, `e8ddd6c64` — `resume-backend-recheck`
- (this commit) — `report-and-verification`

---

## 1. Root cause

Three independent defects combined to turn one exhausted backend into a
whole-goal interruption:

1. **`out_of_credits` was treated as fatal at the global-stop layer.** In
   `src/goal/agent-executor.ts`, `FATAL_ERRORS` contained both `auth` and
   `out_of_credits`. A task that ended `blocked` with `out_of_credits` therefore
   tripped the `stopAllTasks` cascade, interrupting the entire goal — including
   independent branches assigned to a *different*, still-available backend.

2. **The fallback gate did not recognize `out_of_credits`.** The per-task
   usage-limit fallback only fired for `rate_limit`/`usage_limit`
   (`isUsageOrRateLimit`, and `pickFallbackBackend`'s eligibility check). A Codex
   `out_of_credits` failure was never offered to Claude Code even when Claude was
   enabled, compatible, and available, so the same task dead-ended instead of
   falling back.

3. **Display and resume conflated a backend usage limit with a user-input
   block.** The blocked UI mapped `out_of_credits` to a plain "worker is out of
   credits" string and the `step_blocked` notification always built a
   `task:<id>:input` required-input key, so a backend quota exhaustion rendered as
   **"needs input."** On resume, the restore loop unconditionally overwrote every
   non-success step's `blockedReason` with `"error"`, discarding the
   usage-limit classification so resume could neither recompute the right display
   state nor re-target the step to an available backend.

Net effect: Codex hitting 100% usage looked fatal, cascaded a global block,
mislabeled itself as "needs input," and lost its real reason on resume — while a
runnable, independent Claude Code task (Step 8) sat behind the global interrupt.

---

## 2. Exact files / functions changed

### Task-level fallback + drain (`executor-fallback-and-drain`)

- **`src/goal/error-patterns.ts`** — added the `UsageLimitClassReason` type
  (`out_of_credits | usage_limit | rate_limit`) and the
  `isUsageLimitClassReason()` type guard. Single source of truth: every
  usage-limit decision (fallback gate, fallback selection, display, resume) now
  routes through this one predicate so the three reasons stay in lockstep.
- **`src/goal/agent-executor-helpers.ts`** — `pickFallbackBackend()` now gates on
  `isUsageLimitClassReason(result.blockedReason)` instead of the hard-coded
  `rate_limit || usage_limit`, so `out_of_credits` is fallback-eligible exactly
  like the other two. The existing `fallbackAttempted` single-attempt guard is
  unchanged → no infinite fallback loop.
- **`src/goal/agent-executor.ts`**
  - `FATAL_ERRORS` reduced from `["out_of_credits", "auth"]` to `["auth"]`.
    Only auth still globally stops the goal; usage-limit-class reasons no longer
    cascade.
  - The fallback gate (`isUsageOrRateLimit`) now uses
    `isUsageLimitClassReason(result.blockedReason)`.
  - `out_of_credits` is surfaced as a `usage_limit` *event kind* for user-facing
    messaging (quota exhaustion, not a transient rate limit) while the precise
    reason is preserved in attempt-history classification.
  - When no compatible fallback backend exists, the task is set
    `status="blocked"`, `blockedReason="usage_limit"` (a **non-fatal, retryable**
    block — never fatal `out_of_credits`/`error`), with a clear
    no-fallback message, so resume can retry it and the scheduler keeps draining.
  - Removed the now-unused `RateLimitBlockedReason` local type.

### Display state (`display-usage-limited`)

- **`src/goal/execution-status.ts`** — added the `usage_limited`
  `ExecutionDisplayStatus` value and the `isUsageLimitedBlocked(step)` predicate
  (`blocked && isUsageLimitClassReason`). `computeDisplayStatuses` renders
  usage-limit-class blocks as `usage_limited` (visibly blocked, never plain
  pending), propagates the waiting (`soft_blocked`) state to dependents from both
  hard blocks **and** `usage_limited` blocks, keeps user-input as `blocked`, keeps
  other retryable technical blocks (error/timeout/turn_limit/process_lost/network)
  rendering as `pending`, and leaves **independent** runnable steps `pending`.
  `isRetryableBlocked` semantics are unchanged (usage-limit class stays retryable
  on resume) — only the display changed.
- **`src/goal/mermaid-render.ts`** — added a distinct `usagelimited` `classDef`
  (amber `#713F12`/`#FBBF24`, dashed), plus `STATUS_CLASS` (`usagelimited`) and
  `STATUS_EMOJI` (🪫) entries.
- **`src/telegram/goal-blocked-ui.ts`** — `describeBlockedStep` now routes all
  usage-limit-class reasons (including `out_of_credits`) through
  `describeUsageLimitBlocked` via `isUsageLimitClassReason`; `usage_limit`/
  `out_of_credits` map to the "usage limit" kind, `rate_limit` to "rate limit".
  Removed the dead `out_of_credits` → "worker is out of credits" case. The block
  description now shows backend name + limit class + reset hint; "needs input" is
  kept only for `user_input`/undefined. Attempt history is still rendered once by
  `buildBlockedCaption`.
- **`src/telegram/goal-formatting.ts`** — the `step_blocked` handler derives
  `requiredInputKey` from the actual step's `blockedReason` (looked up in
  `event.steps`): `task:<id>:input` only for `user_input`/undefined;
  `resume_execution` for usage-limit/technical blocks. So
  `sendBlockedNotification` never renders "needs input" for a backend usage limit.

### Resume (`resume-backend-recheck`)

- **`src/commands/goal-resume.ts`**
  - New exported `recheckUsageLimitBackends()`: before `executeGoalWithAgent`, it
    finds steps blocked with a usage-limit-class reason whose sticky
    `executedBackend` is now unavailable (`detectBackendAvailability` /
    `isBackendAvailable`); if a compatible enabled CLI backend is available it
    re-targets `step.executedBackend` via the executor's own
    `pickFallbackBackend` (no duplicated fallback logic); if none is available it
    leaves the step usage-limit blocked; it honors an explicit `backendOverride`
    lock and skips `pi`.
  - The restore-status loop now **preserves** the persisted
    `blockedReason`/`blockedQuestion` (defaulting to `"error"` only when none was
    recorded) instead of unconditionally overwriting with `"error"`, so
    `usage_limit`/`rate_limit`/`out_of_credits` survive resume.
  - `requiresExecutionAnswer` already treats non-`user_input` blocks as
    auto-retryable, so a usage-limit block resumes without a fake `/goal_answer`.
  - Display state for all nodes is derived from the preserved statuses/reasons via
    `computeDisplayStatuses`, so nothing is left visually stale-blocked.

---

## 3. How task-level fallback now works

When a task ends `blocked` with any usage-limit-class reason
(`out_of_credits`/`usage_limit`/`rate_limit`) and the backend is not `pi`:

1. The failed original-backend attempt is recorded with its usage-limit
   classification (attempt history names the original backend).
2. `pickFallbackBackend` selects the *other* enabled, compatible, available CLI
   backend — in **both** directions (`codex → claude_code` and
   `claude_code → codex`).
3. If a fallback backend exists, the **same task** is retried once on it
   (`fallbackAttempted` single-attempt guard prevents an infinite loop), and the
   user-facing progress messages name **both** the original and fallback backend
   (`formatUsageLimitFallbackMessage` / `RecoveryMessage` / `ExhaustedMessage`).
4. If no fallback is possible (explicit `backendOverride` lock, single enabled
   worker, fallback backend not enabled or unavailable), the task is left
   `blocked` with the **non-fatal, retryable** `usage_limit` reason and a clear
   message — never a fatal `out_of_credits`/`error` — so it stays retryable on
   resume.

---

## 4. How the scheduler drains runnable work before globally blocking

`out_of_credits` was removed from `FATAL_ERRORS`, so a usage-limit failure no
longer triggers the `stopAllTasks` global cascade (only `auth` does). The
executor's main loop keeps pulling tasks while `findRunnableTasks()` returns any
step whose dependencies are satisfied. Consequently:

- An independent runnable Claude Code task continues even while a Codex branch is
  usage-limit blocked.
- A usage-limit-blocked task with no fallback is marked retryable-blocked but does
  **not** stop unrelated runnable work.
- Dependency-blocked tasks correctly wait for their upstreams.
- The goal enters the global blocked/interrupted state **only** once
  `findRunnableTasks()` is empty **and** at least one unresolved blocker remains.

---

## 5. How display state distinguishes usage-limit-blocked vs waiting vs needs-input

| Condition | `blockedReason` | Display status | Mermaid | Telegram |
|---|---|---|---|---|
| Backend usage limit | `out_of_credits` / `usage_limit` / `rate_limit` | `usage_limited` | 🪫 amber `usagelimited` class | "usage limit"/"rate limit" + backend + reset hint; `resume_execution` |
| User input needed | `user_input` / undefined | `blocked` | ⛔ red `blocked` class | "needs input"; `task:<id>:input` |
| Dependent of a blocker | (waiting on a blocking dep) | `soft_blocked` | ⏳ `waiting` class | waiting |
| Retryable technical | `error`/`timeout`/`turn_limit`/`process_lost`/`network` | `pending` (re-runs on resume) | pending | — |
| Independent runnable | (none) | `pending` | pending | runnable |

Key invariants: a real usage-limit blocker is **never** disguised as plain
pending; "needs input" is reserved for genuine user-input blocks; an independent
runnable sibling stays `pending` even when another sibling is `usage_limited`.

---

## 6. How resume handles backend usage-limit blockers

On `/goal_resume`:

1. Persisted `blockedReason`/`blockedQuestion` are preserved (no blanket
   `"error"` overwrite), so the usage-limit classification survives.
2. `recheckUsageLimitBackends` rechecks live backend availability for every
   usage-limit-blocked step.
3. If a step's sticky backend is unavailable and a compatible enabled backend is
   available, the step is re-targeted to it (e.g. Codex out → Claude) so the
   executor retries there instead of dead-ending on "backend not available."
4. If the sticky backend is available again, the step is left untouched — the
   executor retries it and performs its own runtime fallback if it hits the limit
   again.
5. If no compatible backend is available, the step stays clearly usage-limit
   blocked (not `"error"`, not "needs input").
6. An explicit `backendOverride` lock is always honored.
7. Display state is recomputed for **all** nodes (independent + downstream) via
   `computeDisplayStatuses`, so nothing is left visually stale-blocked; the goal
   does not globally interrupt until runnable work is drained.

---

## 7. Tests added

**`src/goal/error-patterns.test.ts`** — `isUsageLimitClassReason` coverage (true
for the three usage-limit reasons; false for auth/user_input/process_lost/
task_failed/error/undefined/null).

**`src/goal/agent-executor.test.ts`** — converted the former `out_of_credits`
global-block test to use `auth`, plus six regression tests under "usage-limit
fallback and drain (executor-fallback-and-drain)":
- (a) Codex `out_of_credits` falls back to Claude and an independent Claude task
  still runs;
- (b) Codex `out_of_credits` falls back to Claude on the same task and completes;
- (c) Codex `out_of_credits` with fallback unavailable becomes usage-limit
  blocked while an unrelated task runs;
- (d) the goal blocks only after every runnable task is drained;
- (e) a mixed dependency graph is not prematurely interrupted by one usage-limited
  branch;
- (f) the **8cec60ca shape** — Task7 Codex `out_of_credits`, Task8 independent
  Claude runnable, Task9 depends on several priors, Task10 depends on Task9 —
  asserting Task8 runs, Codex falls back to Claude where compatible, no global
  block while Task8 is runnable, usage-limited tasks visibly usage-limited, and a
  correct final global state after drain.

**`src/goal/goal-workflow-integration.test.ts`** — rewrote the
"out_of_credits blocks all remaining tasks immediately" test to assert the new
contract (no global block; independent runnable work drains; dependent waits).

**`src/goal/execution-status.test.ts`** — usage-limit cascade → `usage_limited`;
each usage-limit reason → `usage_limited`; independent runnable sibling stays
`pending` while a `usage_limited` sibling is blocked; retryable technical →
`pending` during resume; `usage_limited` dep propagates `soft_blocked`; graph
state matches scheduler (usage_limited stays retryable); new `isUsageLimitedBlocked`
predicate describe block.

**`src/goal/mermaid-render.test.ts`** — `usage_limited` maps to 🪫 and the
distinct `usagelimited` class/classDef.

**`src/telegram/goal-commands.test.ts`** — `out_of_credits` renders as a backend
usage limit (usage-limited), not "needs input"; user-input still renders "needs
input"; the `step_blocked` notification for a usage-limit block renders as
interrupted/needs-resume and never "needs input".

**`src/commands/goal-resume.test.ts`** — `recheckUsageLimitBackends` unit cases
(retargets to an available alternate; stays usage-limit blocked with no
compatible backend; left alone when sticky backend available again; respects
`backendOverride`); resume after Codex exhausted with Claude available retries on
Claude; auto-retries a usage-limit block without a fake `/goal_answer` even with a
stale input key; resume recomputes display state for all nodes.

**`src/goal/run-store.test.ts`** — round-trips `executedBackend` and the
usage-limit `blockedReason` so the resume backend-recheck fields survive
persistence; the cascade resume-visual test updated so the `out_of_credits` step
expects `usage_limited`.

---

## 8. Verification results

Focused test matrix (success-criteria command):

```
pnpm vitest run \
  src/goal/agent-executor.test.ts \
  src/goal/execution-status.test.ts \
  src/goal/blocked.test.ts \
  src/goal/run-store.test.ts \
  src/commands/goal-resume.test.ts \
  src/telegram/goal-commands.test.ts \
  src/goal/mermaid-render.test.ts
```

Result: **7 test files passed, 462 tests passed** (exit 0).

Per-file counts:

| File | Tests |
|---|---|
| `src/telegram/goal-commands.test.ts` | 208 |
| `src/goal/mermaid-render.test.ts` | 74 |
| `src/goal/agent-executor.test.ts` | 56 |
| `src/commands/goal-resume.test.ts` | 51 |
| `src/goal/run-store.test.ts` | 36 |
| `src/goal/execution-status.test.ts` | 32 |
| `src/goal/blocked.test.ts` | 5 |
| **Total** | **462** |

Supplementary (predicate unit coverage, run earlier with the executor suite):
`pnpm vitest run src/goal/agent-executor.test.ts src/goal/error-patterns.test.ts`
→ 75 passed.

Type-check / build / lint:

```
pnpm exec tsc -p tsconfig.json   # clean, exit 0
pnpm build                       # success, exit 0 (tsc + copy/build-info scripts all OK)
pnpm lint                        # oxlint --type-aware src test → Found 0 warnings and 0 errors (exit 0)
```

All verification commands passed. No tests were weakened or skipped to make the
sweep pass.

---

## 9. Manual verification steps (documentation only — not executed here)

These steps are for an operator to run against a live gateway. This report step
did **not** restart the gateway and did **not** resume goal `8cec60ca`.

1. Restart the gateway.
2. Resume goal `8cec60ca`.
3. Confirm Step 8 can run with Claude Code.
4. Confirm Codex-blocked work retries with Claude if compatible.
5. Confirm no false "needs input".
6. Confirm the graph shows real usage-limit blockers clearly.

---

## 10. Out of scope (unchanged by this goal)

- Stage 2U-C was not continued.
- The gateway was not restarted; goal `8cec60ca` was not resumed.
- No sandbox policy change.
- No `/usage_status` formatting change.
- No token-architecture change.
- No usage-limit blocker was hidden as pending to make the graph look clean.
- No work was assigned to Codex; this repair goal ran entirely on Claude Code.
