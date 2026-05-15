# SmithersBot - README Outline

Short headings + bullets covering the SmithersBot story. Only claims classified `verified` or `partial` in `claim-matrix.md` appear; `roadmap` and `unverified` items are omitted. Bullet wording mirrors the Safe README wording column of `claim-matrix.md`; partial claims use their partial-safe phrasing.

## Quick start

- Create a goal from the CLI with `moltbot goal "<task>" --plan-only`; the plan is persisted on disk and held for approval. `MOLTBOT_STATE_DIR` redirects goal state to any directory.
- Telegram-controlled: send `/new_goal <description>` to the bot to start a goal; approve, request changes, or reject from inline buttons.

## How a goal becomes a plan

- Plans are validated structured objects: typed steps, explicit `dependsOn`, per-step worker backend, success criteria, constraints, and a project build/test gate.
- `moltbot goal detail <run_id>` renders a text DAG and a Mermaid source block; text DAG verified only on the CLI, while the Telegram channel additionally renders the DAG to PNG.

## Worker backends

- SmithersBot can route work to local Codex or Claude Code CLI workers; whichever is installed on PATH is probed at startup and assigned work.
- SmithersBot uses local CLI backends (Codex and Claude Code), so it runs against whichever logins are already installed on the operator's machine.

## What you get on disk

- Every plan, worker prompt, stdout/stderr capture, attempt bundle, journal note, and run state file lives on disk under the goals state directory and can be inspected after the fact.
- Each working directory can carry its own `CLAUDE.md`; SmithersBot also remembers per-directory and global lessons and injects the relevant ones into the worker prompt under a labelled section.
- Completed runs can extract scoped lessons; later workers in the same working directory or globally automatically receive the relevant lessons in their prompt under a labelled section.

## Safety rails

- Code-related steps cannot complete until the operator-configured build/test commands actually exit zero; SmithersBot runs the commands itself with `spawnSync` and captures full stdout/stderr.
- After each code-related step SmithersBot runs Semgrep against changed files (cadence configurable to `off`, `step`, or `goal`); a failed scan blocks the step the same way any other build-gate command failure does.
- Worker tool calls run through a typed deny check that blocks reads/writes to sensitive paths (env files, SSH keys, credentials) and a recursive command scanner that blocks dangerous shell forms, elevated-privilege commands, and publish/deploy/release commands.
- Before each task starts, SmithersBot makes a local checkpoint commit on a per-run branch so a failed worker can be reverted to the pre-step state via a recoverability checkpoint reset.

## When things go wrong

- Steps run until their dependencies are met or until they hit a blocker; SmithersBot keeps running unrelated parts of the DAG, then reports remaining blockers to the operator with a consolidated question.
- When a worker gets stuck, SmithersBot reverts the working tree to the pre-step recoverability checkpoint, records what failed, and retries the task with new context; if still stuck after a configurable retry budget, it escalates to the operator with the full failure history.
- If the gateway crashes mid-run, the next start reconciles stale in-progress steps; `moltbot goal resume <run_id>` continues from the persisted run state on disk.

## After the run

- After a goal completes, SmithersBot suggests the manual smoke tests it could not run itself, each ranked by an estimated 1..10 criticality.

## Nightwatch

- Nightwatch is a scheduled daily code review that runs in the background and delivers a summary plan to your configured Telegram chat; schedule and chat are configurable through `/nightwatch`.

---

Sources: `RELEASE_AUDIT/README_VERIFY/claim-matrix.md`, `RELEASE_AUDIT/README_VERIFY/verification-log.md`.
