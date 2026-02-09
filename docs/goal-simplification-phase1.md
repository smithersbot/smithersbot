# Goal System Simplification - Phase 1: Make CLI Execution Reliable

## Objective

Eliminate the top crash classes (hangs, no structured output, inconsistent state) without changing the overall system semantics. After this phase, CLI worker failures become understandable (timeout, out of credits, real task error) instead of mysterious (hung, no output, parse failure).

## Context: Current Failure Modes

Analysis of the last 10 goal runs (Feb 3-8 2026) shows a 12.5% success rate. The dominant failure modes are all in CLI worker process management:

| Failure Mode | Runs Affected | Root Cause |
|---|---|---|
| CLI worker hang (0 bytes stdout, killed at 120s) | 3 runs, 5+ tasks | stdout-based hang detection kills legitimate long operations |
| No structured output within 5 turns | 2 runs, 3+ tasks | Cold-start turns lose context; stdout JSON parsing is brittle |
| Scout timeout (execFileSync blocks) | 2 runs | Synchronous 20-min blocking call |
| Stale executing state after crash | 1 run | Process died mid-execution, no recovery |

## Changes

### 1. Artifact-File Protocol for CLI Workers

**Problem:** The orchestrator parses structured JSON from Claude Code's streaming stdout output. This involves scanning backwards through potentially 300KB+ of stream-json events looking for the last JSON object, then trying to extract a `result` field, then parsing embedded JSON within that. This fails when Claude Code produces output but never emits the expected JSON shape.

**Files to change:**
- `src/goal/cli-worker.ts` - Replace stdout parsing with file reading
- `src/goal/backend-types.ts` - Update/simplify GoalWorkerOutput if needed

**What to do:**

1. Define a result file path convention: `<runDir>/workers/<stepId>/worker_result.json`

2. Update `buildCliWorkerPrompt()` to instruct the worker:
   ```
   RESULT PROTOCOL:
   When you are done, write your result to this exact file path:
   <workerDir>/worker_result.json

   The file must contain valid JSON with one of these shapes:
     Complete: { "status": "complete", "summary": "<brief summary of what was done>" }
     Blocked:  { "status": "blocked", "question": "<what you need from the user>" }
     Failed:   { "status": "failed", "reason": "...", "whatTried": "...", "errorType": "...", "suggestedNext": "...", "needsRevert": false }

   Write the file using your file-writing tool. This is how the orchestrator knows you are done.
   Do NOT rely on printing JSON to stdout as your result mechanism.
   ```

3. After the CLI process exits, read `worker_result.json` from disk:
   - File exists + valid JSON + matches schema -> use it
   - File exists + invalid JSON -> `failed` with "worker produced invalid result file"
   - File missing -> `failed` with "worker did not produce result artifact"

4. Remove these functions (no longer needed):
   - `parseStructuredOutput()`
   - `parseClaudeCodeOutput()`
   - `parseLastJsonObject()`
   - The stdout-scanning logic in the turn loop

5. Keep stdout/stderr capture to log files for debugging. They are no longer the protocol.

6. For the Codex backend (`--output-schema`): Codex already has structured output via `--output-schema`. Keep that path working but also check for `worker_result.json` as a fallback. If Codex writes valid schema output AND worker_result.json, prefer the schema output (it's more reliable for Codex).

### 2. Single Process Per Task (Remove Cold-Start Turn Loop)

**Problem:** Each task currently gets up to 5 "turns," where each turn spawns a brand new CLI process. Each new process is a cold start with no session memory - it only gets 2KB of truncated prior output as context. This means the worker loses all context between turns and often fails to produce the required JSON because it doesn't know what happened before.

**Files to change:**
- `src/goal/cli-worker.ts` - Remove the turn loop

**What to do:**

1. Replace the `for (let turn = 1; turn <= maxTurnsPerTask; turn++)` loop with a single invocation.

2. Give the single invocation the full timeout budget:
   - Use `task.durationMinutes * 2` if available (from the planner's estimate)
   - Minimum: 10 minutes
   - Maximum: 2 hours
   - This replaces the per-turn 10-minute hard timeout

3. The prompt for this single invocation should include all context upfront (goal, plan, completed summaries, working notes, capability bounds, resume context if applicable). This is what `buildCliWorkerPrompt()` already does for turn 1.

4. Remove `buildContinueWorkerPrompt()` - no longer needed since there are no continuation turns.

5. The `maxTurnsPerTask` parameter for CLI workers becomes irrelevant. It can remain for the PI path (which uses it differently - as prompt cycles within a single session). Set `turnsUsed = 1` in the CLI result.

6. After the process exits, check for `worker_result.json` (from change #1). If missing and process timed out -> `failed` with timeout. If missing and process exited cleanly -> `failed` with "no result artifact."

### 3. Liveness Detection (Replace Hang Detector)

**Problem:** The current hang detector kills the CLI process if no stdout is received for 120 seconds. This produces false kills during legitimate long operations (e.g., Claude Code doing a large multi-file edit, or waiting for an API response).

**Files to change:**
- `src/goal/cli-worker.ts` - Replace the `hangCheck` interval in `runCliProcess()`

**What to do:**

1. Remove the 120s no-stdout hang check interval from `runCliProcess()`.

2. Keep the hard timeout (now task-scoped per change #2).

3. After the process exits (or is killed by hard timeout), check if the PID is still alive:
   - `kill(pid, 0)` returns true if alive (Node: `process.kill(pid, 0)` doesn't actually send a signal, just checks)
   - If the hard timeout fires and the process doesn't respond to SIGTERM within 5s, SIGKILL

4. Optionally monitor stdout/stderr file growth as a secondary liveness signal. This is cheap: check file mtime every 30s. If the file is still growing, the process is still working. But do NOT use lack of growth as a kill trigger - only the hard timeout kills.

5. The `HANG_TIMEOUT_MS` constant and its associated interval can be removed entirely.

### 4. Evidence Bundling (Attempt Files)

**Problem:** When a task fails or a retry happens, the context about what went wrong is scattered across stdout/stderr files or lost entirely. Retries (ralphing) start with minimal context about prior failures.

**Files to change:**
- `src/goal/cli-worker.ts` - Write attempt files after each invocation
- `src/goal/agent-executor.ts` - Write attempt files for PI path too

**What to do:**

1. After each task attempt (both CLI and PI), write `<workerDir>/attempt-<N>.json`:
   ```json
   {
     "attemptNumber": 1,
     "backend": "claude_code",
     "outcome": "complete | blocked | failed | timeout | crash",
     "errorClassification": "timeout | out_of_credits | rate_limit | ...",
     "resultFile": "worker_result.json",
     "logExcerpt": "<last 2KB of stdout>",
     "diffstat": "<git diff --stat output if available>",
     "changedFiles": ["src/foo.ts", "src/bar.ts"],
     "durationMs": 45000
   }
   ```

2. On ralph (retry attempt N+1), include the prior `attempt-N.json` content in the prompt:
   ```
   PREVIOUS ATTEMPT FAILED:
   <contents of attempt-N.json, formatted readably>

   Try a different approach. Do not repeat what failed.
   ```

3. This replaces the current `appendRetryContext()` function which just appends free-text to a working notes file. The attempt bundle is structured and compact.

4. For the PI path: the attempt file captures the same info (outcome, error classification, tool calls used, duration). The PI path already has working notes that persist across attempts; the attempt file adds structured metadata.

### 5. Scout Becomes Async

**Problem:** The scout uses `execFileSync` which blocks the entire Node.js event loop for up to 20 minutes. If it times out, the run fails with no recovery path. Two of the last 10 runs failed this way.

**Files to change:**
- `src/goal/scout.ts` - Replace `execFileSync` with async spawn

**What to do:**

1. Replace `execFileSync(claudeBin, [...])` with the same `runCliProcess()` function used by CLI workers (or a variant of it). This makes the scout non-blocking.

2. Apply the same liveness detection: hard timeout only, no stdout-based hang detection.

3. The scout already produces artifact files (`scout_report.json`, `plan_draft.md`, `node_specs/`). After the process exits, validate these files exactly as `validateScoutOutput()` already does. No protocol change needed.

4. The retry logic (`runScoutWithRetry`) stays the same but uses the async spawn instead of sync exec.

5. The scout timeout should be configurable (currently hardcoded at 20 minutes). Add a `--scout-timeout` option or use the existing `timeoutMs` parameter.

6. Write `attempt-1.json` (and `attempt-2.json` on retry) for the scout too, following the same evidence bundling pattern.

### 6. Hard-Deny Rejection Behavior

**Problem (minor, included here for correctness):** When the enforcement layer hits a hard deny (secrets, sudo, etc.), the current behavior varies: sometimes it throws, sometimes it blocks the task, sometimes it returns exit code 126. This should be consistent.

**Files to change:**
- `src/goal/capability-enforcement.ts` - Standardize deny behavior

**What to do:**

1. When a hard deny is triggered, return a clear rejection message as the tool result:
   ```
   Denied: <reason>. This action is not permitted. Try a different approach.
   ```

2. Do NOT throw an exception, crash the process, block the task, or set a blocked state. The agent sees it as "that tool call returned an error" and can decide what to do next (ask the user, try differently, call mark_task_failed).

3. This applies to both PI and CLI paths:
   - PI: the enforced Bash/Read/Write/Edit wrapper returns the denial message as the tool result
   - CLI: the `capability-bounds.txt` system prompt file tells the worker what's denied; if the worker tries anyway and gets a shell error, that's the same "tool returned error" pattern

## What NOT to Change in Phase 1

- The executor's task loop structure (while/findRunnable/pickNext)
- The state machine (still 10 states)
- The capability system (policy/broker/enforcement still exist; just fix deny behavior)
- The git checkpoint system (still branch-per-task with dirty-tree blocking)
- The PI agent path (session management, goal tools, prompt loop)
- The planner (plan generation, validation, approval flow)
- Run persistence (run-store.ts)
- The resume/answer flow

## Testing Strategy

1. **Unit tests for artifact-file protocol:**
   - `worker_result.json` present + valid -> correct result
   - `worker_result.json` present + invalid JSON -> failed
   - `worker_result.json` missing -> failed
   - `worker_result.json` present but wrong schema -> failed

2. **Unit tests for single-process execution:**
   - Process exits with result file -> success
   - Process times out -> failed with timeout
   - Process crashes (non-zero exit, no result file) -> failed

3. **Integration test for liveness:**
   - Process that produces no stdout for >120s but writes result file at the end -> success (regression test for the old hang detector)

4. **Integration test for scout async:**
   - Scout completes -> artifacts validated as before
   - Scout times out -> error returned, run can continue without blocking

5. **End-to-end: run a goal with `--backend claude_code`** and verify:
   - No "CLI worker did not produce structured output" failures
   - No "appeared to hang" false kills
   - Attempt files written for each task

## Success Criteria

After Phase 1, re-running the same goals that failed should show:
- Zero "CLI worker appeared to hang (no output for 120s)" failures
- Zero "CLI worker did not produce structured output within 5 turns" failures
- Zero scout timeout crashes
- Failures are now: real timeouts (hard timeout exceeded), real errors (out of credits, auth), or real task failures (the agent couldn't do it) - all with structured evidence in attempt files

---

## What Comes Next: Phase 2

Phase 2 simplifies the core architecture now that CLI execution is reliable:

- **TaskRunner interface:** Extract `PiRunner` and `CliRunner` from the monolithic executor, sharing one orchestration loop
- **Capabilities to hard-deny-only:** Replace the 3-file policy/broker/enforcement system (~960 LOC) with a single ~150 LOC deny-list module
- **State machine simplification:** 6 states instead of 10, cleaner resume logic
- **Branch-based per-task git checkpoints:** Run on `claw/run/<runId>`, autosave commits, never block on dirty tree
- **Stateful ralphing:** Retry consumes the attempt bundle from Phase 1
- **Explicit backend selection:** Plan specifies backend per task, `--backend` overrides all, drop heuristic router

See `docs/goal-simplification-phase2.md` for the full Phase 2 plan.
