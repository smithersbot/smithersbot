# SmithersBot

A Telegram-controlled multi-agent goal execution harness for local coding and research work.

SmithersBot turns a one-line goal into a structured plan, runs the plan as a DAG of local CLI workers (Codex or Claude Code), and persists every plan, prompt, attempt, journal note, and run state file to disk. You approve, reject, or revise plans from Telegram. Code-related steps are gated by your own build and test commands, scanned with Semgrep, run through a typed deny check on tool calls, and committed to a per-run recoverability checkpoint before each task. If a worker gets stuck, SmithersBot reverts to the pre-step checkpoint, records what failed, retries with new context, and escalates to you when the retry budget is spent.

> CLI command rename to `smithersbot` is still being completed. The binary is published as `smithersbot`, but the executable's own help text and the verified examples below still use `moltbot` as the command name. Use whichever your local install resolves; the subcommand surface is the same.

## Demo

Demo coming soon.

## Quick start

Create a goal from the CLI and hold the plan for approval:

```bash
moltbot goal "<task>" --plan-only
```

The plan is persisted on disk and held for approval. Set `MOLTBOT_STATE_DIR` to redirect goal state to any directory.

From Telegram, send `/new_goal <description>` to the bot to start a goal; approve, request changes, or reject from inline buttons on the plan message.

## Telegram controls

- Plan messages carry inline buttons for **Approve**, **Plan Detail**, **Request changes**, and **Reject**.
- Reply to the plan to revise it.
- Reply to a blocked question to unblock the run.
- Reply to the done message to suggest follow-up work via **Incorporate Feedback**.
- Routing is scoped to the chat and topic thread the run was started in.

Live inline-button round-trips, reply-edit revisions, blocked-question answers, and Incorporate Feedback have unit-test coverage but were not exercised end-to-end in a live Telegram session for this release; verify them on your own bot before relying on them.

## Repo chat

Telegram-only: `/repo_chat <question>` (alias `/rc`) asks a read-only question about the repo. Replies to a prior repo-chat message continue the same session.

The backend is configurable to use Codex or Claude Code via `/chat_backend`; until set, the command is disabled.

A live round-trip on both backends and reply-continuation of an existing session were not exercised end-to-end in this release; treat the live path as manual-required.

## How planning works

Plans are validated structured objects: typed steps, explicit `dependsOn`, per-step worker backend, success criteria, constraints, and a project build/test gate.

```bash
moltbot goal detail <run_id>
```

This renders a text DAG and a Mermaid source block. The text DAG was verified on the CLI; the Telegram channel additionally renders the DAG to PNG.

## Worker backends

SmithersBot can route work to local Codex or Claude Code CLI workers. Whichever is installed on `PATH` is probed at startup and assigned work.

SmithersBot uses local CLI backends (Codex and Claude Code), so it runs against whichever logins are already installed on the operator's machine.

## What gets saved on disk

Every plan, worker prompt, stdout/stderr capture, attempt bundle, journal note, and run state file lives on disk under the goals state directory and can be inspected after the fact.

Each working directory can carry its own `CLAUDE.md`; SmithersBot also remembers per-directory and global lessons and injects the relevant ones into the worker prompt under a labelled section.

Completed runs can extract scoped lessons; later workers in the same working directory or globally automatically receive the relevant lessons in their prompt under a labelled section.

## Safety rails

- **Build/test gate.** Code-related steps cannot complete until the operator-configured build/test commands actually exit zero; SmithersBot runs the commands itself with `spawnSync` and captures full stdout/stderr.
- **Semgrep.** After each code-related step SmithersBot runs Semgrep against changed files (cadence configurable to `off`, `step`, or `goal`); a failed scan blocks the step the same way any other build-gate command failure does.
- **Hard-deny on tool calls.** Worker tool calls run through a typed deny check that blocks reads/writes to sensitive paths (env files, SSH keys, credentials) and a recursive command scanner that blocks dangerous shell forms, elevated-privilege commands, and publish/deploy/release commands.
- **Per-task git checkpoints.** Before each task starts, SmithersBot makes a local checkpoint commit on a per-run branch so a failed worker can be reverted to the pre-step state via a recoverability checkpoint reset. Checkpoint commits are local only; nothing is pushed.

## Recovery behavior

Steps run until their dependencies are met or until they hit a blocker; SmithersBot keeps running unrelated parts of the DAG, then reports remaining blockers to the operator with a consolidated question.

When a worker gets stuck, SmithersBot reverts the working tree to the pre-step recoverability checkpoint, records what failed, and retries the task with new context; if still stuck after a configurable retry budget, it escalates to the operator with the full failure history. There is no automatic handoff between backends; escalation goes to you.

If the gateway crashes mid-run, the next start reconciles stale in-progress steps; `moltbot goal resume <run_id>` continues from the persisted run state on disk.

After a goal completes, SmithersBot suggests the manual smoke tests it could not run itself, each ranked by an estimated 1..10 criticality.

## Nightwatch

Nightwatch is a scheduled daily code review that runs in the background and delivers a summary plan to your configured Telegram chat; schedule and chat are configurable through `/nightwatch`.

## Status and limitations

SmithersBot is a personal, single-operator harness. A few things are worth knowing up front:

- Execution is sequential, not parallel.
- Recovery is bounded by a retry budget; it is not self-healing.
- Manual-test criticality is an LLM 1..10 heuristic, not a calibrated risk score.
- Read-only repo chat: Claude Code excludes the `Write` tool but allows `Bash`; Codex runs `--sandbox workspace-write` and relies on prompt compliance.
- Subscription-mode auth strips Anthropic credential env vars from the worker environment so the local CLI uses its own login; it is not a free or unlimited Claude.
- Crash recovery is best-effort and rolls the interrupted step back to `pending` to be replayed; it is not a formal guarantee.
- Per-directory memory: only `CLAUDE.md` is plumbed by the goal worker; `AGENTS.md` is read natively by Codex but not by the harness; `MEMORY.md` belongs to a different subsystem and is not read by the goal worker.
- The following sub-features have code-path and unit-test coverage but were not exercised end-to-end in this release; verify them live before relying on them in operator-facing copy: live inline plan buttons on a real Telegram message; live reply-to-plan revisions, reply-to-blocked-question answers, and reply-to-done feedback via Incorporate Feedback; live `/repo_chat` round-trip on both backends and `/repo_chat` reply-continuation of an existing session.

## Attribution

SmithersBot is a personal fork of OpenClaw, originally forked when the upstream project was still named Moltbot. See `NOTICE.md` for attribution and license details.

## License

MIT. See `LICENSE`.
