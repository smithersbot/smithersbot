# Goal System Simplification - Phase 2: Simplify the Core Architecture

## Objective

Reduce code complexity and remove systemic flake sources (duplicated logic, state confusion, capability machinery, dirty tree blocking). This phase builds on a CLI worker layer that is already reliable after Phase 1.

## What Phase 1 Did

Phase 1 (see `docs/goal-simplification-phase1.md`) fixed CLI worker reliability without changing system semantics:

- **Artifact-file protocol:** CLI workers write `worker_result.json` instead of the orchestrator parsing structured JSON from stdout
- **Single process per task:** Removed the 5-turn cold-start loop; one CLI invocation gets the full timeout budget
- **Liveness detection:** Replaced the 120s no-stdout hang killer with hard timeout + PID check only
- **Evidence bundling:** Each attempt writes `attempt-N.json` with structured failure context
- **Scout async:** Scout uses async spawn instead of blocking `execFileSync`
- **Hard-deny rejection:** Denials return a tool-result error message instead of throwing/crashing/blocking

After Phase 1, CLI worker failures are understandable (real timeouts, real errors) with structured evidence. The executor, state machine, capabilities, git logic, and PI path are unchanged.

## Changes

### 1. TaskRunner Interface

**Problem:** `agent-executor.ts` (1215 LOC) contains two completely different execution paths interleaved in the same function. Lines 775-847 handle the CLI path; lines 849-1101 handle the PI path. They share some logic (retry, checkpoint, capability computation, state persistence) but have different error handling, signal detection, and state management. Bugs in one path don't get caught by the other's tests, and fixing shared logic requires editing two places.

**Files to change:**
- `src/goal/agent-executor.ts` - Extract runner interface, refactor orchestration loop
- New file: `src/goal/task-runner.ts` - Interface definition
- New file: `src/goal/pi-runner.ts` - PI backend implementation
- `src/goal/cli-worker.ts` - Adapt to implement the runner interface (becomes `cli-runner.ts` or wraps it)

**What to do:**

1. Define the `TaskRunner` interface:
   ```typescript
   interface TaskRunnerContext {
     task: PlanStep;
     plan: Plan;
     goal: string;
     workingDir: string;
     runId: string;
     denyPolicy: HardDenyList;         // hard deny list (NOT the old EffectiveCapabilities)
     completedSummaries: Array<{ id: string; summary: string }>;
     resumeAnswer?: string;
     resumeQuestion?: string;
     attemptBundles?: AttemptBundle[];  // from Phase 1
     onProgress?: (text: string) => void;
     abortSignal: AbortSignal;         // mandatory — runners must respect abort
     timeoutMs: number;                // mandatory — runners must enforce timeout
   }

   interface TaskRunnerResult {
     status: "complete" | "blocked" | "failed";
     summary?: string;
     question?: string;
     failedDetail?: FailedDetail;
     turnsUsed: number;                // always 1 for CLI, variable for PI — kept for metrics parity
     artifacts?: string[];
     blockedReason?: PlanStep["blockedReason"];
   }

   interface TaskRunner {
     execute(context: TaskRunnerContext): Promise<TaskRunnerResult>;
   }
   ```

   **Key ownership rule:** Runners never write to run state directly (no `session.*` mutations, no `saveRun()` calls). They return a `TaskRunnerResult` and the orchestrator is solely responsible for mapping it to state changes and persisting. This keeps ownership clean and makes runners testable in isolation.

2. Extract `PiTaskRunner` from the current PI path (lines 849-1101):
   - Session setup, prompt loop, signal checking, error handling
   - All PI-specific logic lives here
   - Implements `TaskRunner.execute()`

3. Adapt `CliTaskRunner` from the Phase 1 CLI worker:
   - Process spawning, result file reading, timeout management
   - Wraps `executeTaskWithCliWorker()` or replaces it
   - Implements `TaskRunner.execute()`

4. Refactor the orchestration loop in `agent-executor.ts` to use the interface:
   ```typescript
   // Resolve runner once per task based on backend
   const runner: TaskRunner = backend === "pi"
     ? piRunner
     : cliRunner;

   const result = await runner.execute(context);

   // Common post-task handling (same for both backends):
   // - Map result to task status
   // - Persist step result
   // - Write attempt bundle
   // - Write working journal entry
   // - Fire status change events
   // - Check retry eligibility
   ```

5. The orchestration loop now handles ONLY:
   - Task selection (critical-path scoring)
   - Git checkpoints (change #4)
   - Calling `runner.execute()`
   - Post-task processing (persist, journal, events)
   - Retry decisions (change #5)
   - Goal outcome determination

6. Target: `agent-executor.ts` drops from ~1215 LOC to ~400-500 LOC. `pi-runner.ts` ~300 LOC. `cli-runner.ts` ~200 LOC (most logic already exists from Phase 1).

### 2. Capabilities to Hard-Deny-Only

**Problem:** The capability system spans 3 files (~960 LOC): `capability-policy.ts` (392 LOC), `capability-broker.ts`, `capability-enforcement.ts` (282 LOC), plus `capability-types.ts`. It supports expandable grants, TTL-scoped grants, per-step capability requests from the planner, command-prefix matching, path-glob scope checking, and a merge algorithm. In practice, the only part that catches real issues is the hard deny list (secrets, sudo, force-push). The expandable capability system adds planner prompt complexity and creates `capability_denied` blocks that confuse users.

**Files to change:**
- Remove: `src/goal/capability-broker.ts`
- Rewrite: `src/goal/capability-policy.ts` -> `src/goal/hard-deny.ts` (~150 LOC)
- Simplify: `src/goal/capability-enforcement.ts` (~100 LOC, deny checks only)
- Simplify: `src/goal/capability-types.ts` (keep only `HardDeny` type)
- `src/goal/planner.ts` - Remove capability fields from plan schema
- `src/goal/agent-executor.ts` - Remove `computeEffectiveCapabilities()` calls

**What to do:**

1. Create `src/goal/hard-deny.ts` with a single exported deny list:
   ```typescript
   export type HardDeny = {
     pattern: string;    // glob for paths, explicit command/token pattern for commands
     reason: string;     // human-readable explanation
     type: "path" | "command";
   };

   export const HARD_DENIES: HardDeny[] = [
     // --- Path denies (glob-matched against file paths) ---
     { pattern: ".env*", reason: "Environment files may contain secrets", type: "path" },
     { pattern: "*.pem", reason: "Certificate files are sensitive", type: "path" },
     { pattern: "*.key", reason: "Key files are sensitive", type: "path" },
     { pattern: "credentials*", reason: "Credential files are sensitive", type: "path" },
     { pattern: ".aws/**", reason: "AWS config may contain secrets", type: "path" },
     { pattern: ".ssh/**", reason: "SSH config may contain secrets", type: "path" },
     { pattern: "*id_rsa*", reason: "SSH keys are sensitive", type: "path" },

     // --- Command denies (token-aware matching, see checkCommandDeny below) ---
     { pattern: "sudo", reason: "Elevated privileges not permitted", type: "command" },
     { pattern: "npm publish", reason: "Publishing not permitted", type: "command" },
     { pattern: "rm -rf /", reason: "Recursive root deletion not permitted", type: "command" },
     { pattern: "mkfs", reason: "Filesystem formatting not permitted", type: "command" },
     { pattern: "dd if=", reason: "Raw disk writes not permitted", type: "command" },

     // Deploy tools — explicit commands, NOT a *deploy* substring glob.
     // Substring globs cause false positives on filenames, echo statements, docs.
     { pattern: "vercel", reason: "Deployment not permitted", type: "command" },
     { pattern: "flyctl deploy", reason: "Deployment not permitted", type: "command" },
     { pattern: "kubectl apply", reason: "Deployment not permitted", type: "command" },
     { pattern: "helm install", reason: "Deployment not permitted", type: "command" },
     { pattern: "helm upgrade", reason: "Deployment not permitted", type: "command" },
     { pattern: "terraform apply", reason: "Deployment not permitted", type: "command" },
     { pattern: "serverless deploy", reason: "Deployment not permitted", type: "command" },
     { pattern: "gh release create", reason: "Release creation not permitted", type: "command" },
   ];

   export function checkPathDeny(filePath: string): HardDeny | null { ... }

   /**
    * Token-aware command deny check.
    *
    * For commands like "git push", checks if args contain --force or --force-with-lease.
    * For "rm", checks if args contain -rf with target / or empty expansion.
    * For simple commands like "sudo", checks if the command starts with that token.
    *
    * This avoids false positives from substring matching (e.g., a filename
    * containing "deploy" or an echo statement mentioning "sudo").
    */
   export function checkCommandDeny(command: string): HardDeny | null { ... }
   ```

   **Important:** `git rebase -i` is removed from the deny list. It's interactive, but the real risk (hanging) is solved by runner timeouts and `stdin: "ignore"`. Legitimate local rebase operations should not be blocked.

2. Simplify enforcement to deny-only:
   ```typescript
   // In enforced Bash wrapper:
   const deny = checkCommandDeny(command);
   if (deny) {
     return `Denied: ${deny.reason}. This action is not permitted. Try a different approach.`;
   }
   // Otherwise: allow the command to run

   // In enforced Read/Write/Edit wrapper:
   const deny = checkPathDeny(filePath);
   if (deny) {
     return `Denied: ${deny.reason}. This action is not permitted. Try a different approach.`;
   }
   // Otherwise: allow the operation
   ```

3. Remove from the planner prompt: the `capabilities` field from the step schema. Steps no longer request capabilities. The planner just plans tasks; enforcement happens at runtime.

4. Remove from the executor: `computeEffectiveCapabilities()` calls, the `effective` variable, the capability-denial batching logic (lines 1047-1070).

5. For CLI workers: the `capability-bounds.txt` file becomes a simple deny list instead of a grants+denies document.

6. Delete `capability-broker.ts` entirely. Simplify `capability-types.ts` to just the `HardDeny` type.

### 3. State Machine Simplification

**Problem:** The state machine has 10 states (`init`, `planning`, `needs_clarification`, `awaiting_approval`, `rejected`, `cancelled`, `executing`, `blocked`, `failed`, `done`) with complex transitions. The resume logic in `goal-resume.ts` (468 LOC) must handle every transition, and the `failed` state is particularly problematic (it gets synthesized into `blocked` via `aggregateBlockedDetails`). Several states are redundant or represent the same semantic concept.

**Files to change:**
- `src/goal/types.ts` - Reduce state enum
- `src/commands/goal-resume.ts` - Simplify resume logic
- `src/commands/goal.ts` - Update state transitions
- `src/goal/agent-executor.ts` - Update state transitions
- `src/goal/run-store.ts` - Migration for existing runs

**What to do:**

1. Reduce to 6 states:
   ```typescript
   type GoalState =
     | "planning"           // was: init, planning
     | "awaiting_approval"  // unchanged
     | "executing"          // unchanged
     | "blocked"            // was: blocked, needs_clarification, failed (with plan)
     | "done"               // unchanged
     | "cancelled";         // was: rejected, cancelled
   ```

2. **Disambiguate `blocked`:** The `blocked` state covers multiple scenarios. Add a `blockedAt` discriminator to prevent resume logic from becoming if/else spaghetti:
   ```typescript
   type BlockedDetail = {
     blockedAt: "planning" | "execution";
     prompt: string;              // question to show the user
     requiredInputKey: string;    // answer key for goal answer command
     stepId?: string;             // which step, if execution-time
   };
   ```
   - `blockedAt: "planning"` — planner needs clarification before generating/accepting plan. Resume re-enters planning.
   - `blockedAt: "execution"` — one or more steps need user input. Resume re-enters execution loop.

   This replaces the current `run.blocked` shape and makes the resume switch clean:
   ```typescript
   case "blocked":
     if (run.blockedDetail.blockedAt === "planning") {
       // Re-enter planning with the user's answer
     } else {
       // Re-enter execution loop (answer already stored)
     }
   ```

3. State transitions:
   ```
   planning -> awaiting_approval | blocked (blockedAt: "planning")
   awaiting_approval -> executing | cancelled
   executing -> done | blocked (blockedAt: "execution")
   blocked -> executing (via answer + resume) | planning (via answer + resume, if blockedAt planning)
   cancelled -> awaiting_approval (via resume)
   ```

4. Simplify resume logic to a clear switch:
   ```typescript
   switch (run.state) {
     case "done":
       error("Run already completed");
     case "blocked":
       if (run.blockedDetail.blockedAt === "planning") {
         // Re-enter planning with answer context
       } else {
         // Show question and answer key, or if answer provided, re-enter executing
       }
     case "executing":
       // Crash recovery: auto-save dirty state, re-enter executing
     case "cancelled":
       // Re-enter approval flow
     case "awaiting_approval":
       // Re-enter approval flow
     case "planning":
       // Retry planning (requires --replan)
   }
   ```

5. Add migration in `loadRun()` for existing runs:
   - `init` -> `planning`
   - `needs_clarification` -> `blocked` with `blockedAt: "planning"`
   - `rejected` -> `cancelled`
   - `failed` with plan -> `blocked` with `blockedAt: "execution"` (synthesize blocked details as current code does)
   - `failed` without plan -> `cancelled`

6. The `blocked` state now covers all "waiting for user input" scenarios, with `blockedAt` making the kind unambiguous:
   - Task blocked during execution (needs user answer) — `blockedAt: "execution"`
   - Planner needs clarification (formerly `needs_clarification`) — `blockedAt: "planning"`
   - All tasks failed (formerly `failed`, now `blocked` with aggregated details) — `blockedAt: "execution"`
   - Out of credits / auth error (already `blocked`) — `blockedAt: "execution"`

### 4. Branch-Based Per-Task Git Checkpoints

**Problem:** The current git checkpoint system creates a branch per task (`claw/<runId>/<taskId>`), blocks execution if the working tree is dirty, and has fragile orphaned-commit logic for crash recovery. Dirty tree blocking is the most common friction point - it prevents execution after crashes or when agents leave uncommitted changes.

**Files to change:**
- `src/goal/git-checkpoint.ts` - Rewrite checkpoint logic
- `src/goal/agent-executor.ts` - Update checkpoint calls
- `src/goal/types.ts` - Add per-task checkpoint state to types

**What to do:**

1. **Run branch creation happens when execution starts** (not during planning/approval). When the executor is about to run the first task:
   ```
   if (working tree dirty) {
     git add -A && git commit -m "claw: autosave before goal <runId>"
   }
   git checkout -B claw/run/<runId>
   ```

2. Per-task checkpoint state stored in run.json:
   ```typescript
   type TaskCheckpoint = {
     baseSha: string;           // HEAD *after* any autosave, when task actually starts
     beforeCommit?: string;     // autosave commit SHA (if tree was dirty before task)
     afterCommit?: string;      // post-task commit SHA (if task made changes)
   };

   // In SerializedRun:
   taskCheckpoints: Record<string, TaskCheckpoint>;
   ```

3. At task start:
   ```
   if (working tree dirty) {
     git add -A
     git commit -m "claw: autosave before <taskId>"
     record beforeCommit = HEAD     // the autosave commit
   }
   record baseSha = HEAD            // AFTER autosave — this is the clean checkpoint state
   ```
   **Critical:** `baseSha` is recorded after the autosave commit, not before. It always reflects the clean checkpoint state that this task starts from.

4. At task end (if task made changes):
   ```
   git add -A
   git commit -m "claw: <taskId> - <summary>"
   record afterCommit = HEAD
   ```

5. On crash resume:
   ```
   if (working tree dirty) {
     git add -A
     git commit -m "claw: crash recovery autosave"
     // Continue to next task; don't block
   }
   ```

6. **Accumulate mode only** (v1 default and only option): Tasks build on each other. Each task starts from where the previous one left off. No reset between tasks.

7. **Never block on dirty tree.** The only case where git operations block execution is if git itself is broken (not a repo, corrupted index, etc.) - and that's a real error, not a policy decision.

8. Remove from current code:
   - `isWorkingTreeClean()` check that blocks execution
   - `commitOrphanedChanges()` (replaced by the general autosave logic)
   - Branch-per-task naming (`claw/<runId>/<taskId>`) - replaced by one branch per run
   - `resetToCheckpoint()` and `resetOnRetry` config (no reset in accumulate mode)

### 5. Stateful Ralphing

**Problem:** Current retries are nearly stateless. The retry appends free-text to a working notes file and resets the task, but the agent on the next attempt has minimal context about what went wrong. For CLI workers, the retry is a completely cold start. True ralphing requires the retry to understand what the previous attempt did and failed at.

**Files to change:**
- `src/goal/agent-executor.ts` - Update retry logic to use attempt bundles
- `src/goal/cli-worker.ts` (or `cli-runner.ts`) - Include prior attempt in retry prompt
- `src/goal/pi-runner.ts` - Include prior attempt context

**What to do:**

1. On retry, the runner receives the prior attempt bundles (from Phase 1's `attempt-N.json` files):
   ```typescript
   // In TaskRunnerContext (from change #1):
   attemptBundles?: AttemptBundle[];
   ```

2. For CLI retries, the prompt includes a structured failure summary:
   ```
   PREVIOUS ATTEMPT FAILED (attempt 1 of 2):
   Outcome: timeout
   Duration: 45s
   Changed files: src/goal/foo.ts, src/goal/bar.ts
   Log excerpt: <last 2KB>

   The previous attempt timed out. Try a different, simpler approach.
   Do not repeat the same strategy.
   ```

3. For PI retries, the working notes already persist (the PI session writes them). Additionally include the attempt bundle metadata so the agent knows the structured failure reason, not just free-text notes.

4. Backend-specific retry policy:
   ```typescript
   // PI: retry on transient errors
   const PI_RETRYABLE = ["rate_limit", "network", "timeout"];

   // CLI: retry on process-level failures only
   const CLI_RETRYABLE = ["timeout", "crash"];
   ```
   **Important distinction for CLI:** "exited cleanly + no result file" = prompt/protocol failure, no retry. "Crashed/timed out + no result file" = process-level failure, retry allowed (because the crash/timeout is the root cause, not the missing file).

5. Keep `appendRetryContext()` as a compatibility layer for one release after Phase 2 ships. Attempt bundles become the primary retry context source; `appendRetryContext()` continues to write free-text notes as a fallback. Remove it in a subsequent release once attempt bundles are fully validated.

6. Cap at 2 attempts (configurable via `retryConfig.maxAttempts`). Each attempt's evidence is preserved in `attempt-N.json` regardless of outcome.

### 6. Explicit Backend Selection

**Problem:** The backend router (`backend-router.ts`) uses keyword heuristics to classify tasks: it checks if the description contains words like "code", "test", "docs", "analysis" and routes accordingly. This is a hidden source of non-determinism - the same task description could route differently based on word choice, and the fallback chain (codex -> claude_code -> pi) adds another layer of unpredictability.

**Files to change:**
- Remove: `src/goal/backend-router.ts`
- `src/goal/planner.ts` - Make `backend` a required field in step schema (or default to a configured value)
- `src/goal/agent-executor.ts` - Simplify backend resolution
- `src/cli/program/register.goal.ts` - `--backend` flag already exists

**What to do:**

1. Backend selection rules (in priority order):
   - `--backend <id>` CLI flag -> all tasks use this backend (highest priority)
   - `step.executedBackend` -> sticky across resume (if task already started on claude_code, keep it)
   - `step.backend` from the plan -> planner's per-task choice
   - Default backend from config or `"claude_code"` as ultimate fallback

2. The planner prompt should specify that `backend` is an optional field on each step with a default:
   ```
   Each step may include:
   - backend: "pi" | "claude_code" | "codex" (default: "claude_code")
   ```
   Giving the planner a default avoids random omissions. The default should match your cost preference (`"claude_code"` if you're optimizing for subscription cost).

3. If the specified backend is unavailable (binary not found, etc.), immediately mark the task as `blocked` with a clear message: "Backend 'codex' is not available. Install it or use `--backend pi` to override."

4. Remove `classifyTask()`, `detectBackendAvailability()` probing, and the fallback chain logic from `backend-router.ts`. Delete the file.

5. Keep `step.executedBackend` for stickiness across resume (if a task started on claude_code, resume it on claude_code).

## Testing Strategy

1. **TaskRunner interface tests:**
   - Mock runner returns complete -> orchestrator persists done state
   - Mock runner returns blocked -> orchestrator persists blocked state
   - Mock runner throws -> orchestrator handles gracefully
   - Both PiRunner and CliRunner pass the same interface contract tests

2. **Hard-deny-only capability tests:**
   - `checkPathDeny(".env.local")` -> denied
   - `checkPathDeny("src/foo.ts")` -> allowed
   - `checkCommandDeny("sudo rm -rf /")` -> denied
   - `checkCommandDeny("pnpm test")` -> allowed
   - Enforcement wrapper returns rejection message (not throw)

3. **State machine tests:**
   - Each valid transition works
   - Invalid transitions return clear errors
   - Migration of old state values to new states
   - Resume from each state follows the documented path

4. **Git checkpoint tests:**
   - Dirty tree -> autosave commit + continue (not block)
   - Task completes -> after-commit recorded
   - Crash resume with dirty tree -> autosave + continue
   - Run branch created correctly

5. **Stateful ralphing tests:**
   - Retry receives prior attempt bundle
   - CLI retry prompt includes structured failure context
   - Backend-specific retry policy respected

6. **Explicit backend selection tests:**
   - `--backend pi` forces all tasks to PI
   - Plan-specified backend respected per task
   - Unavailable backend -> immediate blocked with message

## Success Criteria

Structural outcomes (primary):
- **No duplicated orchestration logic:** One task loop, one post-task handler, one retry decision point — regardless of backend
- **Deterministic state transitions:** 6 states, every transition documented, `blockedAt` discriminates planning vs execution unambiguously
- **No dirty-tree blocks:** Runs always start, even after crashes. Autosave commits preserve work.
- **Backend selection is deterministic:** No keyword heuristics, no fallback chains. Plan says which backend, `--backend` overrides.
- **No capability-denied blocks from planner mismatch:** Hard deny only; the planner doesn't need to understand capabilities
- **Each backend independently testable:** PiRunner and CliRunner both implement TaskRunner, can be tested with mock contexts

LOC indicators (secondary — splitting files may increase total slightly while improving structure):
- `agent-executor.ts` drops to ~400-500 LOC (orchestration only)
- Capability system drops from ~960 LOC to ~250 LOC
- `goal-resume.ts` drops from ~468 LOC to ~200 LOC
- `backend-router.ts` deleted (~200 LOC removed)
