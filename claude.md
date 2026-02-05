## Workflow Orchestration

### 1. Plan Mode Default
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately – don't keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity

### 2. Subagent Strategy
- Use subagents liberally to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One task per subagent for focused execution

### 3. Self-Improvement Loop
- After ANY correction from the user, update `tasks/lessons.md` with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project

### 4. Verification Before Done
- Never mark a task complete without proving it works
- Diff your behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness

### 5. Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes – don't over-engineer
- Challenge your own work before presenting it

### 6. Autonomous Bug Fixing
- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests – then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how

## Task Management

1. **Plan First**: Write plan to `tasks/todo.md` with checkable items
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Add review section to `tasks/todo.md`
6. **Capture Lessons**: Update `tasks/lessons.md` after corrections

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.

## Self-Verification Requirement for /goal Changes

If you make a change that affects the behavior of any command in the `/goal` family, you must verify that change by running the relevant command(s) via the local CLI yourself.

Verification means executing the command paths whose behavior you modified and observing the actual runtime behavior, not reasoning about the code.

### How to Run the CLI

Run all commands from the repository root using the local Node entrypoint:

- `node scripts/run-node.mjs <args>`
- or equivalently: `npm run moltbot -- <args>`

Do not assume a global `moltbot` binary is available on PATH.

### Local Service Restart and Logs (When Applicable)

If your change affects the running gateway or command execution behavior, you need to restart the local service to observe the effect.

When running in a systemd-based dev environment, the service can be restarted with (this one is mandatory to test the change):
- `systemctl --user restart moltbot-gateway-dev.service`

To observe runtime behavior or diagnose issues after a restart, logs can be viewed with (this one is optional for debugging):
- `journalctl --user -u moltbot-gateway-dev.service -f`


### Where Run Artifacts Are Saved

Each goal run persists to:

`~/.moltbot/goals/<run_id>/`

This directory contains the authoritative runtime artifacts (run state, working notes, transcripts, etc.) and should be used to diagnose failures and confirm correct behavior.

### Failure Protocol

If the CLI behavior is incorrect, incomplete, or unexpected:
1. Inspect the run artifacts on disk.
2. Fix the implementation.
3. Re-run the affected command(s).
4. Repeat until the behavior matches intent.

Do not mark work as complete unless the modified `/goal` behavior has been exercised and confirmed through real execution.


