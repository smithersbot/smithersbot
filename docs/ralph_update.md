/new_goal Implement plan-level autocheck and ralphing (voluntary revert-and-retry) in the goal system to prevent workers from self-reporting success on broken work and to give them a proper escape hatch when stuck.

## Background

Goal 9e1ec66a demonstrated two critical flaws in the goal system:

1. **No independent verification.** The executor trusts worker_result.json completely. A worker narrowed tsconfig.json include from "src/**/*" to ["src/index.ts"] to make pnpm build pass without fixing broken imports. The executor accepted "status: complete" and marked the goal done. The build was actually broken.

2. **No escape hatch for stuck workers.** When clean-deps-configs attempt 1 honestly reported failure ("build_failure_unresolved_imports"), the system had nowhere useful to go — "failed" is not auto-retried, needsRevert is captured but never acted on, and WORKING.md is never mentioned to the worker. Attempt 2 was dispatched after user intervention but chose to cheat (narrow tsconfig) rather than fail again, because failing again would just bounce back to the user with no progress.

## What to implement

Three changes: planner output gains autocheck config and step-level criteria, the worker gains a "ralph" output status, and the executor gains autocheck execution and ralph handling.

### 1. Planner changes

Update the planner prompt and plan output schema to require two new things:

**Plan-level autocheck config:**
```typescript
type PlanAutocheck = {
  commands: string[];        // e.g. ["pnpm build"] — empty for non-code projects
  runBetweenSteps: boolean;  // true = check after each step, false = only after all steps
}

Add an autocheck field to the plan schema. The planner decides what commands to run based on the project. For Node.js projects with a build script in package.json, it should use ["pnpm build"]. For non-code projects, it should set commands to []. Do NOT auto-detect at runtime — the planner makes this decision at plan time.

Step-level success criteria and constraints:

// Add to PlanStep in types.ts
successCriteria?: string;    // verifiable "done when" condition
constraints?: string[];      // things the worker MUST NOT do

Update the planner prompt to require these on every step. successCriteria should be specific and verifiable (e.g. "pnpm build exits 0 with the full src/**/* tsconfig include intact"). constraints should list things that are off-limits (e.g. "Do not narrow tsconfig.json include to hide errors — fix the consuming code instead").

The planner prompt should follow these structured planning best practices:

• Each step must have a clear, verifiable success condition so the executor and the worker both know when the step is truly done
• Each step must list explicit constraints so workers know what approaches are off-limits
• Steps should include expected deliverables, not just task descriptions
• The autocheck commands serve as the plan's "stop token" — the objective gate that determines if work is actually complete
2. Worker prompt changes (cli-worker.ts)

Update the worker prompt (the buildWorkerPrompt function and the worker-context.ts instructions) to:

a) Add ralph as a third output status. Update the result protocol section to present four options:

Complete (task done):

{ "status": "complete", "summary": "brief summary of what was done" }

Ralph (stuck after genuine attempt — use only when continuing is slower than reverting and retrying with a different strategy):

{
  "status": "ralph",
  "approachTried": "Specific description of what you did step by step",
  "specificErrors": "Exact error messages or failure output you encountered",
  "keyInsight": "What you learned about the problem structure that wasn't obvious from the task description",
  "suggestedApproach": "Concrete step-by-step strategy for the next attempt to follow instead"
}

Blocked (need user input):

{ "status": "blocked", "question": "specific question for the user" }

Failed (impossible/out of scope):

SmithersBot, [2026-02-20 10:12 AM]
{ "status": "failed", "reason": "...", "whatTried": "...", "errorType": "...", "suggestedNext": "...", "needsRevert": false }

b) Explain when to ralph. Add this to the worker context instructions (worker-context.ts "When You Are Stuck" section):

"Ralph is a last resort when you are truly stuck — when you've exhausted your ability to fix the problem yourself and believe the approach is fundamentally wrong, not just difficult. Before ralphing, you must have genuinely attempted to fix the errors you encountered. If pnpm build fails with 50 errors, try fixing them. If after significant effort you've fixed 30 but the remaining 20 reveal that your entire approach was wrong (e.g. you realize the task requires a completely different ordering of operations, or a dependency you assumed existed doesn't), THAT is when to ralph. Do not ralph just because the task is hard or has many errors — ralph when you've learned that starting over with a different strategy would be faster than continuing to fix the current mess.

Ralph is for situations where you learned something important about the problem that changes the approach. Do not ralph with the same approach — explain what went wrong and what to do differently."

c) Include the step's successCriteria and constraints in the prompt. When building the worker prompt, include a section like:

SUCCESS CRITERIA:
{step.successCriteria}

CONSTRAINTS (do NOT violate these):
- {step.constraints[0]}
- {step.constraints[1]}
...

d) Update the output schema. Add the ralph status to GOAL_WORKER_OUTPUT_SCHEMA in cli-worker.ts (the validateWorkerOutput function and the output-schema.json that gets written to the worker directory). The schema should accept status "ralph" with required fields: approachTried, specificErrors, keyInsight, suggestedApproach (all strings, all required).

3. Executor changes (agent-executor.ts)

a) Ralph handling. In the task execution loop, after reading the worker result, handle the new "ralph" status:

• In cli-runner.ts mapWorkerOutput(): add a case for status "ralph" that returns a new result type (e.g. { status: "ralph", ...ralph fields }).
• In agent-executor.ts, when the task runner returns status "ralph":  1. Check the ralph counter for this task. If >= 2 ralphs already, treat as "blocked" with blockedReason "task_failed" and escalate to the user. Include all ralph history in the blocked message so the user has full context.
  2. If under the limit: git reset --hard to the task's checkpoint baseSha (the clean pre-task state). This is the actual revert.
  3. Format the ralph output into a structured WORKING.md (http://working.md/) entry under the goal's working directory. Use a clear format:
## Ralph (attempt N) — {timestamp}
### Approach tried
{approachTried}
### Errors encountered  
{specificErrors}
### Key insight
{keyInsight}
### Suggested approach for next attempt
{suggestedApproach}

  4. Increment the ralph counter for this task (store in the step's metadata or run state).
  5. Reset task status to "pending" and loop back to dispatch a new attempt.
  6. The new attempt's prompt will include the ralph context via the previousAttempt mechanism (already exists in cli-runner.ts) plus the WORKING.md (http://working.md/) content.
  7. Send a Telegram progress update: "Task {taskId}: ralph (attempt {N}/2) — reverting to clean state, dispatching new attempt."

b) Autocheck execution. After a step reports "complete" (and after the commit is recorded):

• If plan.autocheck.runBetweenSteps is true AND plan.autocheck.commands is non-empty, run the autocheck:  1. Execute each command in plan.autocheck.commands sequentially in the goal's workingDir using child_process.execSync (or spawn) with a timeout of 5 minutes per command.
  2. Capture stdout and stderr. Check exit code.
  3. If all commands exit 0: accept the step as done, proceed normally.
  4. If any command fails: do NOT mark the step done. Instead, treat this as an autocheck failure:
a. Log the failure output.
b. Feed the error output back to the same step as a synthetic ralph-like retry: reset to checkpoint, provide the autocheck failure output as context, dispatch a new worker attempt with a prompt like: "The autocheck ({failed command}) failed after you reported complete. Fix the errors. Here is the output:\n{stdout+stderr}". Include the step's constraints in the retry prompt.
c. After the fix attempt completes, re-run the autocheck.
d. Max 2 autocheck-fix cycles. If still failing, mark the task "blocked" with the autocheck error output.
  5. Send Telegram progress updates for autocheck status.

• Also run the autocheck as a final gate after ALL steps are done, regardless of runBetweenSteps. This is the last check before marking the goal "done".
• If plan.autocheck is undefined or commands is empty, skip autocheck entirely (no error, no warning — this is expected for non-code projects).
c) Persist autocheck and ralph state in run.json. Add to the run/session state:

autocheckConfig?: PlanAutocheck;          // from the plan
stepRalphCounts?: Record<string, number>; // ralph count per step
autocheckResults?: {                      // most recent autocheck result per step
  [stepId: string]: {
    passed: boolean;
    failedCommand?: string;
    output?: string;
    timestamp: string;
  }
};

4. Type changes (types.ts, backend-types.ts)

Update GoalWorkerOutput union type to include the ralph variant:

| { status: "ralph"; approachTried: string; specificErrors: string; keyInsight: string; suggestedApproach: string }

Update PlanStep to include:

successCriteria?: string;
constraints?: string[];

Add PlanAutocheck type and add autocheck?: PlanAutocheck to the plan type.

Update TaskRunnerResult in the relevant types to handle the ralph status.

5. Tests

Add tests for:

• Ralph output parsing and validation in cli-worker.ts (new status accepted, all fields required)
• Ralph handling in agent-executor: revert to checkpoint, WORKING.md (http://working.md/) update, retry dispatch, max ralph limit
• Autocheck execution: runs commands, checks exit codes, handles failure with retry
• Autocheck skip: when commands is empty, no error
• Plan schema validation: autocheck config, successCriteria, constraints accepted
Implementation notes

• The ralph git revert uses the existing taskCheckpoints.baseSha — this is already tracked per step in run.json. Use git reset --hard {baseSha} in the workingDir.
• The autocheck commands run as the executor process, NOT through a worker. Use child_process.spawn or execSync with the workingDir as cwd.
• The planner prompt changes should reference the existing planner prompt in planner.ts — add instructions for autocheck config and step-level criteria/constraints to the existing plan output format.
• Keep the existing "failed" status and its error types (out_of_credits, auth, rate_limit, etc.) unchanged. Ralph is a new, separate status — it is NOT a replacement for failed. Failed means "this can't be done" or "infrastructure problem". Ralph means "I learned something, let a fresh instance try with my notes."
• The worker-context.ts "When You Are Stuck" section currently says "Only request user input as a genuine last resort." Update this to present ralph as the intermediate option between "keep trying" and "ask the user."
