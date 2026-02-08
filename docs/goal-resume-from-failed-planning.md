# Goal Resume from Failed Planning - Implementation Summary

## Overview

This document describes the implementation of the `--replan` flag for the `moltbot goal resume` command, which allows users to recover from planning failures.

## Problem Statement

Previously, when goal planning failed due to transient errors (rate limits, network issues, API errors), the run would be left in an unrecoverable state:

- Runs in `planning` state were rejected with "Run is in an incomplete state"
- Runs in `failed` state with no plan were rejected with "Run failed: <error>"
- Users had to create a new goal from scratch, losing the run ID and context

This was identified as **Issue #2: Cannot Resume from Planning Failures** in the goal system analysis (P0 - Blocks recovery from common errors).

## Solution

Added a `--replan` flag to `moltbot goal resume` that:

1. Detects runs that failed during planning (state is `planning` or `failed` with no plan)
2. Re-invokes the planner with the original goal text
3. Attempts to load cached scout data if available from the previous run
4. Handles planning success, clarification requests, and failures
5. Transitions the run to `awaiting_approval` on success

## Implementation Details

### Files Modified

1. **src/commands/goal-resume.ts**
   - Added `replan?: boolean` to `GoalResumeOptions` type
   - Added `retryPlanning()` function to handle replanning logic
   - Added `loadScoutData()` helper to load cached scout analysis
   - Updated error handling for `planning` and `failed` states to suggest `--replan`

2. **src/cli/program/register.goal.ts**
   - Added `--replan` flag to the resume command CLI definition

3. **src/commands/goal-resume.test.ts**
   - Added comprehensive test suite for `--replan` functionality (9 new tests)
   - Tests cover: success cases, blocked responses, failures, JSON mode, quiet mode

### State Transitions

#### Before (Broken)
```
planning → [ERROR] → stuck (cannot resume)
failed (no plan) → [ERROR] → stuck (cannot resume)
```

#### After (Fixed)
```
planning --replan→ planning → awaiting_approval (success)
planning --replan→ planning → needs_clarification (blocked)
planning --replan→ planning → failed (still failing)

failed (no plan) --replan→ planning → awaiting_approval (success)
failed (no plan) --replan→ planning → needs_clarification (blocked)
failed (no plan) --replan→ planning → failed (still failing)
```

### Error Handling

When a user tries to resume a run in `planning` or `failed` (no plan) state without the `--replan` flag, they now receive a helpful error message:

**Before:**
```
Run is in an incomplete state.
```

**After:**
```
Run is in an incomplete state. Use --replan to retry planning from the original goal.
```

Or for failed runs:
```
Run failed during planning: <error>. Use --replan to retry.
```

### Scout Data Caching

The implementation attempts to reuse scout data from the previous run:

- Looks for `~/.moltbot/goals/<runId>/scout/report.json` and `plan.md`
- If found, passes the scout data to `generatePlan()` to improve plan quality
- If not found, proceeds without scout data (graceful degradation)

### JSON and Quiet Modes

The `--replan` flag works correctly in all output modes:

- **Normal mode**: Shows progress spinner and plan output
- **JSON mode** (`--json` or `--output json`): Outputs strict JSON
- **Quiet mode** (`--quiet`): Suppresses most output

## Usage Examples

### Resume from planning failure (rate limit)
```bash
$ moltbot goal "Add authentication"
# ... planning starts ...
# Rate limit error occurs, run fails

$ moltbot goal list
Run: abc123... | State: planning | Goal: Add authentication

$ moltbot goal resume abc123
Error: Run is in an incomplete state. Use --replan to retry planning from the original goal.

$ moltbot goal resume abc123 --replan
Replanning...
✓ Plan generated successfully

# Plan now awaiting approval
$ moltbot goal resume abc123 --yes
# Execution proceeds
```

### Resume from failed planning with scout data
```bash
$ moltbot goal "Refactor the auth module"
# Scout runs, then planning fails with network error

$ moltbot goal resume <runId> --replan
Replanning with cached scout data...
✓ Plan generated successfully
```

### Handle clarification during replan
```bash
$ moltbot goal "Build a dashboard"
# Planning fails

$ moltbot goal resume <runId> --replan
Replanning...

CLARIFICATION NEEDED: Which metrics should the dashboard show?
Answer: moltbot goal answer <runId> --key step:planning:input --value "CPU, memory, disk"
```

## Testing

### Unit Tests

Added 9 new tests in `src/commands/goal-resume.test.ts`:

1. ✅ Retries planning for a run in 'planning' state
2. ✅ Retries planning for a failed run with no plan
3. ✅ Suggests --replan when planning state encountered without flag
4. ✅ Suggests --replan when failed run with no plan encountered without flag
5. ✅ Handles replanning that results in blocked/needs_clarification
6. ✅ Persists error when replanning fails again
7. ✅ --replan works in JSON mode
8. ✅ --replan in quiet mode suppresses output
9. ✅ Calls generatePlan when replanning

All tests pass (30/30 in goal-resume test suite).

### Manual Testing

To manually test:

1. Create a goal that will fail during planning (e.g., by temporarily setting an invalid API key)
2. Verify the run is in `planning` or `failed` state
3. Run `moltbot goal resume <runId>` and verify the error message suggests `--replan`
4. Run `moltbot goal resume <runId> --replan` and verify it retries planning

## Error Recovery Matrix (Updated)

| Error Type | State | Resume Works? | Retry Works? | Notes |
|------------|-------|---------------|--------------|-------|
| Rate limit (planning) | `planning` | ✅ Yes (--replan) | N/A | **FIXED** |
| Network (planning) | `planning` | ✅ Yes (--replan) | N/A | **FIXED** |
| Parse error (planning) | `planning` | ✅ Yes (--replan) | N/A | **FIXED** |
| Process crash (planning) | `planning` | ✅ Yes (--replan) | N/A | **FIXED** |
| Failed (no plan) | `failed` | ✅ Yes (--replan) | N/A | **FIXED** |
| Rate limit (execution) | `blocked` | ✅ Yes | ✅ Auto | Already worked |
| Network (execution) | `blocked` | ✅ Yes | ✅ Auto | Already worked |

## Future Improvements

Potential enhancements for future iterations:

1. **Auto-retry with backoff**: Automatically retry planning on transient errors with exponential backoff
2. **Better scout data detection**: Check if scout data is stale and re-run scout if needed
3. **Preserve planning context**: Store additional context (e.g., previous error, retry count) for better diagnostics
4. **Partial plan recovery**: If planning partially succeeded (some steps generated), attempt to resume from partial state

## Related Issues

- ✅ **Issue #2 (P0)**: Cannot resume from planning failures - **FIXED**
- ⏳ **Issue #1 (P0)**: No stop/cancel command - Not addressed (different task)
- ⏳ **Issue #4 (P1)**: No execution locking - Not addressed (different task)

## Conclusion

The `--replan` flag successfully addresses the planning failure recovery issue, allowing users to retry planning when transient errors occur. This prevents users from having to recreate goals from scratch and preserves run IDs and context.

The implementation is:
- ✅ Well-tested (9 new tests, all passing)
- ✅ User-friendly (clear error messages with suggestions)
- ✅ Robust (handles success, blocking, and failure cases)
- ✅ Compatible with all output modes (normal, JSON, quiet)
