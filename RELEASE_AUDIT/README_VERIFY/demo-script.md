# SmithersBot - 60-90 Second Demo Script

A narrated walkthrough from goal to a blocked-or-completed result. Every shown CLI command appears in `verification-log.md` (claims 1, 3, 4, 6); Telegram-only steps are explicitly labelled `(manual)`. Wording mirrors the Safe README wording column of `claim-matrix.md`.

Worked-example run id: `5e1de960-5456-4dc2-a1c7-a1bdf231cdc6` (the plan-only run created during Claim 1 and reused for Claim 4 / Claim 6).

---

## 0:00 - Hook (5s)

Narrator: "SmithersBot turns a one-line goal into a validated, persisted plan and runs it with local CLI workers - with a build gate, recovery loop, and crash recovery on top."

## 0:05 - Create a goal from the CLI (15s)

```
MOLTBOT_STATE_DIR=$PWD/RELEASE_AUDIT/README_VERIFY/_state node scripts/run-node.mjs goal "Add a short docstring to scripts/run-node.mjs" --plan-only
```

Narrator: "We call `moltbot goal "<task>" --plan-only`. SmithersBot scouts the working directory and writes a validated structured plan to disk - typed steps, explicit `dependsOn`, per-step worker backend, success criteria, constraints, and a project build/test gate. Nothing runs yet."

## 0:20 - Inspect the plan and DAG (15s)

```
MOLTBOT_STATE_DIR=$PWD/RELEASE_AUDIT/README_VERIFY/_state node scripts/run-node.mjs goal detail 5e1de960-5456-4dc2-a1c7-a1bdf231cdc6
```

Narrator: "`goal detail <run_id>` renders a text DAG and a Mermaid source block - text DAG verified only on the CLI, while the Telegram channel additionally renders the DAG to PNG."

## 0:35 - Approve the plan (10s)

`/new_goal <description>` (manual) - Telegram-controlled: send `/new_goal <description>` to the bot to start a goal; approve, request changes, or reject from inline buttons. An operator approves before any worker runs.

## 0:45 - Workers dispatch on local CLI backends (10s)

Narrator: "Once approved, SmithersBot routes each step to a local Codex or Claude Code CLI worker; whichever is installed on PATH is probed at startup and assigned work. SmithersBot uses local CLI backends - it runs against whichever logins are already installed on the operator's machine."

## 0:55 - Artifacts land on disk (10s)

Narrator: "Every plan, worker prompt, stdout/stderr capture, attempt bundle, journal note, and run state file lives on disk under the goals state directory and can be inspected after the fact. For this worked example, everything is under `RELEASE_AUDIT/README_VERIFY/_state/goals/5e1de960-5456-4dc2-a1c7-a1bdf231cdc6/`."

## 1:05 - Build gate and security scan (10s)

Narrator: "After the worker reports done, SmithersBot runs the operator-configured build/test commands itself with `spawnSync` and captures full stdout/stderr; a step cannot complete until the commands actually exit zero. Semgrep is prepended at step cadence by default."

## 1:15 - Checkpoint, recovery, and resume (15s)

Narrator: "Each task is bracketed by a local checkpoint commit on a per-run branch, so a failed worker can be reverted to the pre-step state via a recoverability checkpoint reset. If a worker gets stuck, SmithersBot enters its recovery loop: revert and retry the task with new context, and if still stuck after a configurable retry budget, escalate to the operator with the full failure history. If the gateway crashes mid-run, the next start reconciles stale in-progress steps and `moltbot goal resume <run_id>` continues from the persisted run state on disk."

## 1:30 - Outcome

Narrator: "Result: a completed run with manual smoke-test suggestions ranked 1..10 by criticality - or a consolidated blocked report waiting for the operator."

---

Sources: `RELEASE_AUDIT/README_VERIFY/claim-matrix.md`, `RELEASE_AUDIT/README_VERIFY/verification-log.md`.
