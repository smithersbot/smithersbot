# Goal System Issues Analysis

## Executive Summary

This document identifies and analyzes broken behaviors and implementation gaps in the `/new_goal` execution system. Analysis covers state management, concurrency control, error recovery, and operational controls.

## Critical Issues (P0) - Blocking Normal Operation

### Issue #1: No Stop/Cancel Command During Execution

**Status**: Not implemented
**Severity**: P0 - Users cannot cancel running goals
**Location**: N/A (missing feature)

#### Root Cause
- No `/goal_stop` or `/goal_cancel` command exists
- `abortSignal` parameter exists in `executeGoalWithAgent()` but no CLI/Telegram interface exposes it
- Users must wait for timeout or kill the process to stop execution

#### Evidence
```typescript
// agent-executor.ts:177 - abortSignal exists but unused
export type ExecuteGoalParams = {
  // ...
  abortSignal?: AbortSignal;
};

// No command in src/commands/ for stopping goals
// No Telegram command in GOAL_COMMAND_SPECS for stopping
```

#### Impact
- Long-running goals cannot be interrupted gracefully
- Users resort to process kills, leaving runs in "executing" state
- No clean cancellation path forces manual cleanup

#### Proposed Solution
1. Add `goal-stop.ts` command in `src/commands/`
2. Expose `/goal_stop <runId>` in Telegram
3. Implement state transition: `executing` → `cancelled`
4. Use `AbortController` to signal cancellation to running executor
5. Persist cancellation reason and timestamp
6. Clean up worker processes on cancel

---

### Issue #2: Cannot Resume from Planning Failures

**Status**: Partially broken
**Severity**: P0 - Blocks recovery from common errors
**Location**: `src/commands/goal-resume.ts:113-121`

#### Root Cause
Planning-phase failures (state: `planning`) are treated as "incomplete state" and reject resume attempts, even when the goal text and context are fully recoverable.

#### Evidence
```typescript
// goal-resume.ts:113-121
if (run.state === "init" || run.state === "planning") {
  if (isJson) {
    runtime.log(JSON.stringify({ error: "Run is in an incomplete state." }));
    throw new JsonExitError(1);
  }
  runtime.error("Run is in an incomplete state.");
  return undefined;
}
```

#### Impact
- Rate limits during planning → unrecoverable
- Network errors during planning → unrecoverable
- Transient LLM errors → user must create new goal from scratch
- Lost context and run ID tracking

#### Proposed Solution
1. Detect planning failures with recoverable context
2. Add `--replan` flag to `goal resume`
3. Re-invoke `generatePlan()` with original goal text + scout data
4. Transition `planning` → `awaiting_approval` on success
5. Handle cases where scout data is stale/missing

---

### Issue #3: Executing State Leaves Orphaned Runs on Crash

**Status**: Partially broken
**Severity**: P1 - Requires manual diagnosis
**Location**: `src/goal/run-store.ts:81-86`

#### Root Cause
When a run crashes mid-execution (state: `executing`), the migration logic resets steps to `pending` but leaves the run state as `executing`. Resume detects this and continues, but users see confusing state.

#### Evidence
```typescript
// run-store.ts:81-86 (migrateRun)
if (step.status === "in_progress") {
  // Process crash mid-task → reset to pending
  step.status = "pending";
}
// Note: Run state remains "executing", not reset
```

The migration resets step statuses but not the run's top-level state.

#### Impact
- Runs show as "executing" when actually idle
- `/goal_list` shows stale "executing" runs confusingly
- Users unsure whether resume will work correctly

#### Proposed Solution
1. Detect orphaned `executing` runs in migration
2. Transition to `blocked` or `awaiting_approval` based on step states
3. Add last-activity timestamp to detect truly stuck runs
4. Show clearer status messages in `/goal_status`

---

## High Priority Issues (P1) - Functionality Gaps

### Issue #4: No Execution Locking (Race Condition Risk)

**Status**: Not implemented
**Severity**: P1 - Concurrent execution could corrupt state
**Location**: N/A (no locking mechanism exists)

#### Root Cause
Multiple processes/commands can call `executeGoalWithAgent()` on the same run simultaneously. File-based persistence uses atomic writes but no run-level lock prevents concurrent execution.

#### Evidence
- No lock file mechanism in `run-store.ts`
- No `executing_pid` field in `SerializedRun`
- Atomic writes (rename) protect file integrity but not logical consistency
- Two `goal_approve` calls in quick succession could both start execution

#### Impact (Theoretical)
- Two executors run same steps concurrently → file conflicts, wasted API calls
- Step results overwrite each other unpredictably
- Git checkpoint conflicts in same working directory

#### Impact (Observed)
- None reported yet (Telegram single-thread + human latency mitigates risk)
- More likely in automated scenarios or high-frequency testing

#### Proposed Solution
1. Add lock file: `~/.moltbot/goals/<runId>/.lock`
2. Write PID to lock file on execution start
3. Check lock + validate PID before starting execution
4. Auto-clean stale locks (PID no longer exists)
5. Return clear error if already executing

---

### Issue #5: Failed Task Resume Has Blind Spots

**Status**: Partially broken
**Severity**: P1 - Some failures unrecoverable
**Location**: `src/goal/agent-executor.ts:66-68` (retry logic)

#### Root Cause
Only specific `blockedReason` values are retryable. Tasks that block for other reasons (e.g., `capability_denied`, `task_failed`, `turn_limit`) are not automatically retried, and resume doesn't distinguish between "needs answer" vs "needs code fix".

#### Evidence
```typescript
// agent-executor.ts:64-68
const RETRYABLE_REASONS: PlanStep["blockedReason"][] = [
  "timeout", "network", "rate_limit"
];

function isRetryable(reason: PlanStep["blockedReason"]): boolean {
  return reason != null && RETRYABLE_REASONS.includes(reason);
}
```

Tasks blocked for `capability_denied`, `task_failed`, `user_input`, `turn_limit`, `other` are **not** automatically retried even if conditions change.

#### Impact
- `turn_limit` blocks require manual retry with `--max-turns` override (not implemented)
- `task_failed` leaves steps permanently blocked (user cannot trigger retry without replan)
- `capability_denied` blocks cannot be resolved by granting capabilities mid-run

#### Proposed Solution
1. Add `--retry-task <stepId>` flag to `goal resume`
2. Allow manual retry of any blocked step (resets `turnsUsed`, clears block reason)
3. Show what blocked a task in `goal_status` with actionable next steps
4. Distinguish "needs user answer" from "needs manual retry"

---

## Medium Priority Issues (P2) - Usability & Edge Cases

### Issue #6: /goal_list Blocking (False Alarm - No Technical Block)

**Status**: **NOT AN ISSUE**
**Severity**: N/A
**Location**: `src/commands/goal-list.ts` (no locking logic found)

#### Analysis
The `/goal_list` command calls `listRuns()` which performs simple filesystem reads:
```typescript
// goal-list.ts:21
const runs = listRuns().slice(0, limit);

// run-store.ts:111-144 (listRuns implementation)
export function listRuns(goalsDir: string = resolveGoalsDir()): RunSummary[] {
  if (!fs.existsSync(goalsDir)) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(goalsDir);  // Just reads directory
  } catch {
    return [];
  }
  // ... loads run.json files (read-only)
}
```

**No locking mechanism prevents concurrent reads during execution.**

#### Why Users Perceive Blocking
- Telegram single-threaded bot processes commands sequentially
- If a goal is executing and user sends `/goal_list`, they wait for the current task turn to complete before the command handler fires
- This is **Telegram's command queue**, not goal system locking

#### Evidence It's Not Blocked
- No mutex, lock file, or synchronization primitive in `goal-list.ts` or `run-store.ts`
- `listRuns()` is a pure read operation
- Atomic writes in `saveRun()` use temp file + rename, safe for concurrent reads

#### Recommendation
- **No code changes needed**
- Document that Telegram commands queue naturally
- Consider async command handling if this becomes a real bottleneck

---

### Issue #7: Missing Task-Level Capability Grants

**Status**: Implemented but underdocumented
**Severity**: P2 - User confusion
**Location**: `src/goal/capability-enforcement.ts`, `src/goal/types.ts:65-66`

#### Current State
Steps **can** request capabilities via `step.requestedCapabilities`, and the broker merges them with policy defaults. This works correctly.

#### Problem
- No CLI flag to grant capabilities at resume time
- No way to grant capabilities mid-execution for a blocked task
- Users unaware that planner can request capabilities automatically

#### Evidence
```typescript
// types.ts:65-66
export type PlanStep = {
  // ...
  /** Extra capabilities requested by the planner for this step. */
  requestedCapabilities?: CapabilityGrant[];
};

// capability-broker.ts merges these correctly
```

#### Impact
- Tasks block on `capability_denied` with no recovery path
- Users must replan to grant capabilities
- Planner-requested capabilities are invisible in plan display

#### Proposed Solution
1. Add `--grant <capability>` flag to `goal resume`
2. Show requested capabilities in plan output
3. Document capability system in user-facing docs
4. Add capability status to `goal_status` output

---

### Issue #8: No Progress Indication During Long Steps

**Status**: Missing feature
**Severity**: P2 - User experience issue
**Location**: Telegram handlers (no incremental updates)

#### Root Cause
Telegram handlers use `withChatAction()` which sends periodic "typing" indicators but no substantive progress updates. Long-running steps (10+ minutes) appear frozen.

#### Evidence
```typescript
// goal-commands.ts:126-141 (withChatAction)
export async function withChatAction<T>(params: {
  bot: Bot;
  chatId: number;
  action: ChatAction;
  // ...
}): Promise<T> {
  const loop = startTypingLoop({ bot, chatId, action, threadId, label });
  try {
    return await fn();  // No intermediate updates
  } finally {
    loop.stop();
  }
}
```

#### Impact
- Users unsure if goal is stuck or progressing
- No visibility into which step is active
- Timeout errors are surprising (no warning)

#### Proposed Solution
1. Add incremental status messages per step start/complete
2. Show turn count as steps progress
3. Send DAG updates with current step highlighted
4. Add time estimates based on `durationMinutes`

---

## State Transition Analysis

### Current State Machine

```
init → planning → (failed | needs_clarification | awaiting_approval)
awaiting_approval → (executing | rejected | cancelled)
executing → (done | blocked | failed)
blocked → executing (after answer)
needs_clarification → planning (after answer)
```

### Problems
1. **No `cancelled` state handling during execution** - can only cancel at approval
2. **No `paused` state** - cannot suspend/resume cleanly
3. **No `planning` → `awaiting_approval` recovery** - planning failures stuck
4. **`executing` orphans** - crashes leave run in executing state indefinitely

### Proposed State Additions
```typescript
export type GoalState =
  | "init"
  | "planning"
  | "needs_clarification"
  | "awaiting_approval"
  | "rejected"
  | "cancelled"        // Existing: user cancelled at approval
  | "executing"
  | "paused"           // NEW: user paused execution (stop command)
  | "cancelled_exec"   // NEW: user cancelled during execution
  | "done"
  | "blocked"
  | "failed";
```

---

## Concurrency & Persistence Architecture

### Current Design
- **Single-process assumption**: Telegram bot is single-threaded Node.js process
- **File-based state**: `~/.moltbot/goals/<runId>/run.json`
- **Atomic writes**: Temp file + rename for crash safety
- **No distributed locking**: Assumes one writer per run

### Analysis
✅ **Strengths**:
- Atomic writes prevent corrupted JSON
- Simple, no external dependencies (no Redis/DB)
- Works well for single-user, single-bot scenarios

⚠️ **Weaknesses**:
- No protection against concurrent CLI invocations
- No lock to prevent duplicate execution
- No detection of stale "executing" state

### Risk Assessment
- **Current deployment**: Risk is LOW (single Telegram bot + human latency)
- **Future risk**: MEDIUM if multiple bots or automation added
- **Mitigation**: Add PID-based lock file (Issue #4)

---

## Error Recovery Matrix

| Error Type | State | Resume Works? | Retry Works? | Notes |
|------------|-------|---------------|--------------|-------|
| Rate limit (planning) | `failed` | ❌ No | N/A | Issue #2 |
| Rate limit (execution) | `blocked` | ✅ Yes | ✅ Auto | Works via retry |
| Network (planning) | `failed` | ❌ No | N/A | Issue #2 |
| Network (execution) | `blocked` | ✅ Yes | ✅ Auto | Works via retry |
| Out of credits | `blocked` | ✅ Yes | ❌ Manual | No auto-resume |
| Auth failure | `blocked` | ✅ Yes | ❌ Manual | No auto-resume |
| Capability denied | `blocked` | ✅ Yes | ❌ No retry | Issue #5, #7 |
| Turn limit | `blocked` | ✅ Yes | ❌ No retry | Issue #5 |
| Task failed | `blocked` | ✅ Yes | ❌ No retry | Issue #5 |
| Process crash (planning) | `planning` | ❌ No | N/A | Issue #2 |
| Process crash (executing) | `executing` | ⚠️ Confusing | N/A | Issue #3 |
| User input needed | `blocked` | ✅ Yes | N/A | Works correctly |

---

## Implementation Gaps Summary

### Missing Commands
1. `/goal_stop <runId>` - Cancel running goal
2. `/goal_pause <runId>` - Pause execution (future)
3. `/goal_retry <runId> --task <stepId>` - Retry failed task

### Missing Flags
1. `goal resume --replan` - Retry planning phase
2. `goal resume --grant <cap>` - Grant capability for blocked task
3. `goal resume --max-turns <N>` - Override turn limit for retry
4. `goal resume --force` - Bypass lock file check

### Missing State Fields
```typescript
export type SerializedRun = {
  // Existing fields...

  // PROPOSED ADDITIONS:
  executingPid?: number;           // PID of executing process
  executingStartedAt?: string;     // ISO timestamp execution started
  lastActivityAt?: string;         // ISO timestamp of last step progress
  pausedAt?: string;               // ISO timestamp if paused
  cancelledBy?: "user" | "timeout" | "error"; // Cancellation reason
};
```

---

## Testing Gaps

### Missing Test Coverage
1. Concurrent execution attempts (race condition)
2. Process crash recovery at each state
3. Resume from planning failures (network/rate limit)
4. Stop command during long-running task
5. Stale lock file cleanup
6. Multiple blocked tasks with different reasons

### Recommended Tests
```typescript
describe("goal execution control", () => {
  test("stop during execution transitions to cancelled", async () => {
    // Start long goal, invoke stop command, verify state
  });

  test("concurrent approve calls should error", async () => {
    // Two goal_approve calls at once, one should fail with lock error
  });

  test("resume from planning failure retries plan generation", async () => {
    // Simulate rate limit during planning, verify resume --replan works
  });
});
```

---

## Priority Roadmap

### Phase 1 - Critical Fixes (P0)
1. **Implement `/goal_stop` command** (Issue #1)
   - Add `goal-stop.ts` command
   - Expose in Telegram
   - Use `AbortController` for graceful cancellation

2. **Fix planning failure resume** (Issue #2)
   - Add `--replan` flag
   - Detect recoverable planning failures
   - Re-invoke planner with preserved context

### Phase 2 - Stability Improvements (P1)
3. **Add execution locking** (Issue #4)
   - PID-based lock file
   - Stale lock detection
   - Clear error messages

4. **Improve failed task retry** (Issue #5)
   - Add `--retry-task` flag
   - Manual retry for capability/turn-limit blocks
   - Better failure diagnostics

### Phase 3 - Polish (P2)
5. **Incremental progress updates** (Issue #8)
   - Per-step status messages
   - Highlighted DAG updates
   - Time estimates

6. **Document capability system** (Issue #7)
   - User-facing docs
   - Show capabilities in plan output
   - Runtime grant mechanism

---

## Appendix: Code References

### Key Files
- `src/goal/agent-executor.ts` - Main execution loop
- `src/goal/run-store.ts` - Persistence and migration
- `src/goal/types.ts` - Type definitions
- `src/commands/goal-resume.ts` - Resume command implementation
- `src/commands/goal-list.ts` - List command (no blocking)
- `src/telegram/goal-commands.ts` - Telegram handlers

### Execution Flow
1. `/new_goal` → `goalCommand()` → `generatePlan()` → state: `awaiting_approval`
2. User approves → `handleGoalApprove()` → `goalResumeCommand()`
3. `goalResumeCommand()` → `executeGoalWithAgent()` → state: `executing`
4. Tasks loop → blocked/done → `onTaskUpdate` → `saveRun()`
5. All done → state: `done` / some blocked → state: `blocked`

### Critical Functions
- `executeGoalWithAgent()` - Main task loop, handles retries
- `findRunnableTasks()` - Dependency resolution
- `pickNextTask()` - Critical path scheduling
- `migrateRun()` - Backward compatibility for state transitions
- `sessionToSerialized()` / `serializedToSession()` - Persistence boundary

---

## Conclusion

The goal system has a solid foundation but **three critical gaps** block normal operation:

1. **No stop command** - users cannot cancel long-running goals
2. **Planning failures unrecoverable** - transient errors require full restart
3. **Execution locking missing** - theoretical race condition risk

The perceived `/goal_list` blocking (Issue #6) is a **false alarm** - it's Telegram's command queue, not goal system locking.

Priority should be:
1. Implement `/goal_stop` (days of work)
2. Add planning resume with `--replan` (days of work)
3. Add execution lock file (1 day of work)

After these fixes, the system will be robust for production use.
