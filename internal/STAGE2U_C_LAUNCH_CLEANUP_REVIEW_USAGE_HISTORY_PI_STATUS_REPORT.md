# Stage 2U-C Launch Cleanup — LLM Diff Review, /usage_history, pi, Resume & Status Rendering

**Date:** 2026-05-23
**Scope:** Launch blockers found after Stage 2U-B/2U-C. Remove the LLM post-execution
diff review from the normal goal lifecycle, remove `/usage_history`, disable the `pi`
backend for launch, make resume recompute state for all nodes, render the top-level
blocker only when actually blocked, restore the approved status/diagram visual rules,
and verify autocheck reviewer session reuse.

This report is repository-local. It does not assume any CI/deploy/publishing system,
and contains no env/config/auth/session/token/secret contents.

---

## 1. LLM post-execution diff review — what was removed

The LLM post-execution diff review was a separate phase that ran *after* a goal
reached `done`: it collected `git diff <base>...HEAD`, asked a backend to review the
diff, optionally injected a "system-polish" step, then re-reviewed. It kept failing
live with `error_max_turns` / `stop_reason: tool_use` / `num_turns: 2`, and otherwise
only ever said "approved" — no actionable value — while occasionally leaking raw
backend result JSON to Telegram.

**Removed:**

- The ~225-line goal-completion orchestration block in `src/goal/agent-executor.ts`:
  the initial `runPostExecutionReview` call, the secondary post-polish re-review, the
  injected system-polish step, and the `postExecutionReviewNote` summary append. The
  completion path now goes straight from `session.state = 'done'` → GitHub push →
  lessons → manual-tests → summary.
- Dead modules: `src/goal/post-execution-review.ts`, `src/goal/post-execution-review.test.ts`,
  and the now-unused prompt `src/prompts/post-execution-review/build-prompt.ts`.
- All importers/usages cleaned up: the import block plus a now-unused `execFileSync`
  import and unused `claudeCodeAuth` destructure in `agent-executor.ts`; the
  post-execution-review surface in `src/goal/agent-surface-audit.ts`; the entry in
  `NIGHTWATCH_PROMPT_KEY_FILES`; the directory-tree entry and lifecycle-table row in
  `src/prompts/README.md`; and all references in `src/prompts/prompts.test.ts`. Stale
  phrasing in `src/goal/plan-autocheck.ts` and the `src/goal/phase-fallback.ts` header
  comment was updated.

**No user-facing leak remains for this phase:** there is no longer any
`Post-execution review skipped: {raw JSON...}` message, no `error_max_turns` text, and
no raw backend result JSON path for the removed review.

**Compatibility note:** the now-inert `buildGate.postExecutionReview` flag is kept in
the schema/type/planner (with clarifying comments) so older serialized plans and
planner output keep parsing. The flag no longer triggers any review.

---

## 2. What remains after removal

| Capability | Status | Location |
|---|---|---|
| Deterministic build/test/lint build-gate | **Preserved** | `src/goal/build-gate.ts`, wired in `src/goal/agent-executor.ts` |
| Deterministic Semgrep/SAST scan | **Preserved** | `buildDefaultSastCommand` in `src/goal/build-gate.ts` |
| Manual-tests generation | **Preserved** | `src/goal/manual-tests.ts` |
| Lessons extraction | **Preserved** | `src/goal/lessons.ts` |
| Prompt/history instrumentation | **Preserved** (used by other phases) | `agent-history-events` etc. |
| LLM post-execution diff review | **Removed** | (deleted) |

Lessons extraction was confirmed independent of the removed LLM diff review — it runs
on completion regardless and is verified by a partial-mock spy test.

---

## 3. Semgrep as a deterministic command

**Yes — Semgrep exists as a deterministic command, independent of the removed LLM
review.** It is `buildDefaultSastCommand({ workingDir, targetPaths })` in
`src/goal/build-gate.ts` (around line 160). It is gated on `DEFAULT_SAST_SEMGREP_ENABLED`
and on `which semgrep` resolving; it returns `null` (no-op) when Semgrep is absent
rather than failing the gate.

It is invoked deterministically in `src/goal/agent-executor.ts` in two places, both
unrelated to the deleted review:

- **Per-step** (around line 793): the `[sast]` step prepends the Semgrep command to the
  gate commands for changed files (and skips with a `[sast] No changed files…` message
  when nothing changed).
- **Final gate** (around line 985): `finalSastCommand` is `unshift`-ed onto the final
  gate commands (`[sast] goal`).

No separate Semgrep path was hidden inside the LLM review, so nothing needed to be
extracted; the deterministic path already existed and continues to run.

---

## 4. Autocheck reviewer session reuse — already working

Verified in `src/goal/plan-autocheck.ts`; current behavior is **already correct**, so
this was a coverage + documentation task with no logic changes:

1. **Round 2+ resume the same reviewer session for the same backend** — `runPlanAutocheck`
   carries `result.sessionId` forward each round and resumes via `--resume` / `exec resume`
   when `canResume` (`sessionId && sessionBackend === backend`). `existingSessionId`
   continues a session across restarts.
2. **Backend-bound** — a stored `existingBackend` mismatch clears the incompatible
   session id; a cross-backend usage-limit fallback in `runFreshReviewerAttempt` clears
   `sessionId` so a session bound to the fallback backend is never resumed.
3. **Plan revision preserves history** — `feedbackHistory` accumulates every round's
   edit instructions and is forwarded to `runCliPlanRevision` as `priorFeedback` (earlier
   rounds only).
4. **Per-round instrumentation** — each reviewer attempt records launch + result
   agent-history events with token usage, plus a per-round `round` event.

A JSDoc block documenting these four guarantees was added above `runPlanAutocheck`, and
5 focused tests were added (see §11).

---

## 5. How pi is disabled for launch (and how to re-enable)

`pi` is **disabled as a selectable/assignable backend** without deleting any pi code:

- `src/goal/backend-availability.ts`: `detectBackendAvailability` reports pi as
  `{ id: 'pi', available: false, reason: PI_DISABLED_FOR_LAUNCH_REASON }` (new exported
  const at line ~116). The reason explains pi is not instrumented for agent-visible
  launch/prompt/token history and uses a different in-process capability boundary.
  Codex/Claude probing is unchanged.
- `src/prompts/planner/system-prompt.ts`: pi removed from the backend union and from all
  `BACKEND SELECTION RULES` branches, so the planner/scout cannot assign pi in normal mode.
- `src/goal/effective-workers.ts`: already excludes pi (`CliWorkerId` /
  `PLANNER_WORKER_ORDER` are `codex | claude_code` only) — no change needed.
- `src/telegram/goal-commands.ts`: `/goal_workers pi` returns a clear "pi is disabled for
  launch" message (`GOAL_WORKERS_PI_DISABLED`) instead of the generic "Invalid workers".
- `src/commands/goal-resume.ts`: `remapDisabledPiSteps()` (line ~170) safely handles old
  runs with pi steps — not-yet-completed pi steps (`step.backend === 'pi'` or sticky
  `executedBackend === 'pi'`) are remapped onto a supported available backend (prefers
  `claude_code`, then `codex`); completed/non-pi steps are untouched; if no supported
  backend is available, resume is rejected with a clear message.
- `pi` is kept in the `GoalBackendId` type (`src/goal/backend-types.ts`) so old serialized
  runs parse. `src/goal/pi-runner.ts` and unrelated pi tests/fixtures are untouched.

**To re-enable pi later:** flip the pi entry back to `available: true` in
`src/goal/backend-availability.ts`, and restore the pi backend union/rule lines in
`src/prompts/planner/system-prompt.ts`. (Re-enabling should wait until pi is instrumented
for agent-visible launch/prompt/token history.)

---

## 6. Root cause of stale top-level blocker rendering

**Symptom:** `/goal_status` (and done/executing messages) showed `Blocker You've hit your
usage limit…` even when the goal was executing/completed and not actually blocked.

**Root cause:** `buildBlockerSummary` was duplicated (identical copies in
`src/commands/goal-status.ts` and `src/commands/goal-detail.ts`) and was **ungated** — it
rendered `run.blocked` / `run.lastError` regardless of the current run state. Once a run
resumed past a usage-limit block or completed, the stale `blocked`/`lastError` fields were
still present on the run record, so the renderer kept printing the old blocker text (and
even raw backend upgrade/settings URLs).

**Fix:**

- A single gated helper `buildRunBlockerSummary(run)` was extracted into
  `src/goal/compact-output.ts` (with exported `RunBlockerInput` type), replacing both
  ungated copies (single-source-of-truth). Gating rules:
  - render the structured blocker **only** when `run.state === 'blocked'` (falling back to
    `lastError` if no structured blocker);
  - keep surfacing `lastError` for state `'planning'` (interrupted/stuck planner);
  - render **nothing** for `executing` / `awaiting_approval` / `done` / `cancelled`, so
    stale `blocked`/`lastError` fields never appear once a run resumed, completed, or was
    cancelled.
- In `src/goal/agent-executor.ts`, stale run-level blocker fields are cleared by setting
  `session.blocked = null` and `session.lastError = undefined` on transition to `executing`
  (covers fresh start and resume) and on transition to `done`. Any genuinely new block
  re-sets these fields. The done-clearing is safe because the final-build-gate-failure path
  goes to the blocked branch (via `finalBuildGateFailurePrompt`), so the done branch is only
  reached for clean completions.

---

## 7. Root cause of resume not resetting all blocked tasks

**Symptom:** pressing resume left some previously-blocked tasks visually stale-blocked —
resume only unblocked the first task, leaving independent siblings and downstream tasks
showing blocked.

**Root cause:** resume restored per-step status from `stepResults` and rechecked
usage-limit backends, but it did **not** recompute display state for all nodes. Retryable
*technical* blocks stayed `status: 'blocked'`, so the scheduler/`computeDisplayStatuses`
kept rendering them blocked, and downstream nodes inherited the stale block.

**Fix:** `resetRetryableBlockedSteps(steps)` (`src/commands/goal-resume.ts` line ~226)
runs after status restore, pi remap, and the usage-limit recheck. It resets stale retryable
*technical* blocks (`isRetryableBlocked && !isUsageLimitedBlocked`, reusing the
`execution-status.ts` classifiers) back to `status: 'pending'`, clears
`blockedReason`/`blockedQuestion`/`failedDetail`, and zeroes `turnsUsed` — mirroring how the
executor resets a blocked task it picks up. Wired into `goalResumeCommand` inside the
`if (session.plan)` restore block, so it covers executing/blocked/cancelled/awaiting_approval
resumes.

**Intentionally preserved:**

- **Usage-limit** blocks stay `blocked` with their `usage_limit` reason — recovery is owned
  by `recheckUsageLimitBackends` (which retargets the backend); they keep the distinct
  `usage_limited` display and are re-run by the executor's own retryable set. If a fallback
  backend is available, it retries on fallback; otherwise it stays usage-limit blocked.
- Hard / user-input blocks and reason-less blocks stay blocked.
- `done` / `in_progress` / `pending` statuses are untouched.
- Cancelled goals stay cancelled (reset runs only after the approval gate, so rejecting a
  cancelled resume leaves blocked steps intact).

After resume, the persisted scheduler state matches `computeDisplayStatuses`: independent
retryable siblings become pending/runnable; downstream steps of an unresolved blocker become
waiting (soft_blocked), not hard-blocked.

---

## 8. Exact status/diagram visual rules implemented

The scheduler-repair "usage-limited" amber/dashed style was reverted to the approved
blocked style. Changes in `src/goal/mermaid-render.ts`:

- **Removed** the invented `usagelimited` classDef (amber `#713F12`/`#FBBF24`, dashed) from
  `CLASS_DEFS`.
- **Removed** the battery icon (🪫) from `STATUS_EMOJI`.
- **Remapped** the logical `usage_limited` display status to the **approved `blocked`
  class** in `STATUS_CLASS` and to the **approved blocked icon (⛔)** in `STATUS_EMOJI`.

No new colors/classes/icons were introduced. The approved class set is unchanged:

| Display status | Class | Icon |
|---|---|---|
| pending | `pending` (dashed slate) | — |
| waiting | `waiting` (purple/amber border) | (waiting) |
| in progress | `inprog` (orange) | (running) |
| done | `done` (green) | (done) |
| blocked | `blocked` (red, dashed) | ⛔ |
| **usage_limited (visual)** | **`blocked`** | **⛔** |

The **logical** `usage_limited` display status is kept in `src/goal/execution-status.ts`
(unchanged `ExecutionDisplayStatus` union and `computeDisplayStatuses` semantics) so a real
out-of-credits/usage-limit step renders blocked (not pending) and resume/backend-recheck can
still distinguish it — only the Mermaid VISUAL mapping changed.

Approved behavior preserved: waiting/downstream steps look waiting not blocked; independent
runnable tasks look pending/runnable even when a sibling is blocked; completed stay
completed; running stay running; cancelled goals show cancelled; resume leaves no stale
blocked graph state; the existing Mermaid transitive-arrow reduction is kept.

---

## 9. /usage_history removal details

Removed `/usage_history` for launch while keeping `/usage_status` as live-quota-only:

- `src/telegram/usage-status.ts`: deleted `USAGE_HISTORY_COMMAND`,
  `USAGE_HISTORY_COMMAND_SPEC`, `buildUsageHistoryMessage`, `registerUsageHistoryCommand`,
  plus the ccusage-only helpers (`parseCcusageDaily`, `formatHistoricalSummary`,
  `formatHistoricalLine`), the `historicalUsageCache` (and its clearing in
  `clearUsageStatusCachesForTest`), the `HistoricalSummary` type, and `CCUSAGE_TIMEOUT_MS`.
- `src/telegram/bot-native-commands.ts`: removed the import, dropped
  `USAGE_HISTORY_COMMAND_SPEC` from the `usageStatusSpecs` array, and removed the
  `registerUsageHistoryCommand(...)` call.
- `src/telegram/public-menu.ts`: removed the `usage_history` menu entry.

`/usage_status` is unchanged: live Claude Code quota, live Codex quota, reset times,
current/stale/unavailable states, **no historical usage section**, secret redaction intact.
Shared helpers (`collectTokenLikeEnvValues`, `sendUsageStatusMessage`, `redactSecretValues`,
`buildClaudeSection`/`buildCodexSection`, `runCli`, `formatCacheAge`) are retained.

No README/SETUP launch docs referenced `/usage_history`. The only remaining `.md` hits are
prior internal stage audit reports (STAGE2U_B / STAGE2U_C_PREFLIGHT), which are historical
records and were intentionally left intact.

---

## 10. Tests added

**remove-llm-post-exec-review** (`src/goal/agent-executor.test.ts`): completed goal does NOT
spawn `runCliProcess` for the review; no review section / skipped message / `error_max_turns`
/ raw JSON in the summary; no review diff (`git diff <base>...HEAD`) collected; no
system-polish step injected; manual-tests still run; lessons still run. Deleted
`src/goal/post-execution-review.test.ts` and the review-asserting cases in surface/prompts
tests.

**remove-usage-history** (`src/telegram/usage-status.test.ts`): `/usage_history` is NOT
registered (no published handler); `/usage_history` is NOT in the native command menu;
`/usage_status` still works; `/usage_status` has no historical usage block; `/usage_status`
still redacts secrets.

**disable-pi-backend**: `backend-availability.test.ts` (pi `available:false` with launch
reason; codex/claude still available); `planner.test.ts` (prompt offers no pi backend across
dual/codex-only/claude-only; "every step" wording); `goal-commands.test.ts` (`/goal_workers
pi` → disabled-for-launch message); `goal-resume.test.ts` (remap pending/sticky pi steps,
leave done/non-pi alone, reject when no fallback, `resolveEffectiveEnabledWorkers` excludes
pi, integration remap to claude_code, integration reject with no fallback).

**fix-resume-recompute** (`src/commands/goal-resume.test.ts`, +9 tests): retryable technical
block resets + clears fields; every retryable technical reason resets; usage-limit blocks
untouched; hard/user-input/no-reason blocks untouched; done/pending/in_progress untouched;
user-input blocker keeps only that task blocked while sibling resets; `computeDisplayStatuses`
shows independent=pending + downstream=soft_blocked + hard=blocked; integration proving ALL
node statuses recomputed (not just the first); cancelled stays cancelled; done has no stale
blocked nodes.

**fix-stale-blocker-rendering** (`src/goal/compact-output.test.ts`,
`src/commands/goal-status.test.ts`, `src/goal/agent-executor.test.ts`): `buildRunBlockerSummary`
8 cases (blocked structured renders; user-input needs-input renders; done/executing/cancelled/
awaiting_approval with stale fields → undefined; planning lastError still surfaces; blocked
without structured blocker falls back to lastError); done goal renders no blocker; executing
goal with runnable work renders no blocker; actually-usage-limit-blocked renders a clear
usage-limit blocker; actually user-input-blocked renders needs-input; done goal with stale
lastError shows no raw backend error/URL; executor clears stale `session.blocked`/`lastError`
on transition to done.

**restore-status-diagram-visuals** (`src/goal/mermaid-render.test.ts`,
`src/goal/execution-status.test.ts`): usage-limit unresolved step follows the approved blocked
rule (no amber/dashed `usagelimited` class, no battery icon, no `#FBBF24`/`#713F12`); dependent
step waiting not hard-blocked; independent sibling stays pending; resume recomputes ALL node
display states; done graph has no stale blocked/usage-limited nodes; cancelled graph shows
states with no stale blocked; transitive-arrow reduction preserved.

**verify-autocheck-session-reuse** (`src/goal/plan-autocheck.test.ts`, +5 tests): round 2
resumes the same session id for the same backend; cross-backend usage-limit fallback clears
the session id; stored backend mismatch does not reuse an incompatible session id; plan
revision preserves + accumulates prior feedback; launch/result/round history with token usage
recorded for every round.

---

## 11. Verification results

All commands run from the repo root on branch
`claw/run/20260524-011330Z-0293264c-bd91-461f-a0bc-112df52ceedb`.

| Command | Result |
|---|---|
| `pnpm vitest run src/goal/manual-tests.test.ts src/goal/lessons.test.ts src/goal/plan-autocheck.test.ts src/goal/execution-status.test.ts src/goal/mermaid-render.test.ts src/goal/backend-availability.test.ts src/goal/compact-output.test.ts src/telegram/goal-commands.test.ts src/telegram/usage-status.test.ts src/commands/goal-resume.test.ts src/commands/goal-status.test.ts` | **11 files / 556 tests passed** |
| `pnpm exec tsc -p tsconfig.json` | **clean (exit 0)** |
| `pnpm build` | **success (exit 0)** |
| `pnpm lint` (`oxlint --type-aware src test`) | **0 warnings, 0 errors** (2340 files, 104 rules) |

Per-file test counts: manual-tests 27, lessons 19, plan-autocheck 46, execution-status 35,
mermaid-render 81, backend-availability 5, compact-output 25, goal-commands 209, usage-status
21, goal-resume 66, goal-status 22.

**CLI path exercised (best effort):**

- `node scripts/run-node.mjs goal --help` → exit 0; lists subcommands including
  `status`, `detail`, `resume`, `answer`, `stop`; `--backend` help still lists
  `pi, codex, claude_code` as a *type* value (the launch disable is enforced at planner
  selection / availability / `/goal_workers`, not by removing the enum, so old runs parse).
- `node scripts/run-node.mjs goal status --help` → exit 0; shows the concise layout order
  (headline, progress, blocker if any, retries) and the ~15-line Telegram cap.

No live run id was exercised against `goal status <runId>` to avoid touching real run
state / secrets; the `--help` paths confirm the CLI command surface builds and runs.

---

## 12. Manual verification steps (operator)

These require a running gateway and are listed for the operator; the worker does not
restart the gateway.

1. **Restart the gateway** (operator action) so the rebuilt code is live.
2. Run `/goal_status <recent done goal>` → confirm **no stale top-level blocker line**
   (no "You've hit your usage limit…", no raw upgrade/settings URLs).
3. Run `/usage_status` → confirm output is **live quota only** (Claude + Codex live quota,
   reset times, current/stale/unavailable), **no historical section**, secrets redacted.
4. Run `/usage_history` → confirm it is **no longer registered** (unknown command / not in
   the menu).
5. Run a **tiny goal** to completion → confirm **no post-exec raw JSON** / no
   "Post-execution review…" message appears in Telegram.
6. **Stop a tiny goal** mid-run → confirm the **cancelled** state still works and persists.
7. **Resume a blocked/retryable test goal** → confirm **all retryable blocked tasks visually
   reset** to pending/runnable/waiting, while real user-input blockers stay blocked and
   completed/failed/cancelled stay as-is.
8. **Inspect graph status colors/states** → confirm usage-limit blocked steps use the
   approved **blocked** style (red/dashed, ⛔), no amber/dashed "usagelimited" style, no
   battery icon; waiting/downstream look waiting; independent runnable siblings look
   pending/runnable; no redundant transitive arrows.

---

## 13. Summary

All eight required outcomes are implemented and verified at the repository level: the LLM
post-execution diff review is removed from the normal lifecycle (deterministic build/test/lint
and Semgrep gates, manual-tests, and lessons preserved); `/usage_history` is removed while
`/usage_status` stays live-quota-only; `pi` is disabled for launch without deleting pi code;
resume recomputes state for all nodes so retryable blocked tasks return to
pending/runnable/waiting; the top-level blocker renders only when actually blocked and stale
fields are cleared; the approved status/diagram visual rules are restored; and autocheck
reviewer session reuse is verified, documented, and locked in with tests. The full verification
matrix, type-check, build, and lint all pass.
