# SmithersBot README Claim — Code Survey

Eighteen sections, one per goal-brief claim, with at least two `path:line` citations each.
Cross-references pull from:

- Runtime evidence under `RELEASE_AUDIT/README_VERIFY/artifacts/claim-*.log`
- Static audit material:
  - `RELEASE_AUDIT/FEATURE_AUDIT/readme-raw-material.md`
  - `RELEASE_AUDIT/FEATURE_AUDIT/product-definition.md`
  - `RELEASE_AUDIT/FEATURE_AUDIT/feature-inventory.md`
  - `RELEASE_AUDIT/keep-vs-cut.md`

Status vocabulary: **verified | partial | unverified | roadmap | manual-required**.

---

## Claim 1 - CLI goal creation works in plan-only mode

**Evidence**

- `src/commands/goal.ts:90`, `src/commands/goal.ts:236`, `src/commands/goal.ts:286` — top-level `goal` command, plan render path, and approval gate (`readme-raw-material.md:19`, `product-definition.md:13`).
- `artifacts/claim-01-cli-help.log` — `node scripts/run-node.mjs goal --help` shows top-level form `moltbot goal [options] [command] [goal]` with subcommands `list/status/detail/resume/answer/stop`; no `new` subcommand exists.
- `artifacts/claim-01-cli-plan.log` — `MOLTBOT_STATE_DIR=$PWD/RELEASE_AUDIT/README_VERIFY/_state node scripts/run-node.mjs goal "Add a short docstring to scripts/run-node.mjs" --plan-only --output json` exited 0 and created run `5e1de960-…` with `run.json` + scout artifacts entirely inside the audit tree (no leakage to `~/.moltbot/`).
- `RELEASE_AUDIT/FEATURE_AUDIT/feature-inventory.md:16` — "CLI goal command persistence and approval gate … stops in plan-only mode or waits for approval before execution".

**Code reading verdict**

CLI goal creation in plan-only mode works on this host. The plan is persisted before execution, no worker runs without approval, and `MOLTBOT_STATE_DIR` cleanly redirects the goal state directory.

**Safe wording**

- "Create a goal from the CLI with `moltbot goal \"<task>\" --plan-only`; the plan is persisted on disk and held for approval."
- "`MOLTBOT_STATE_DIR` lets you redirect goal state to any directory."

**Unsafe wording**

- "Run `moltbot goal new \"<task>\" --plan-only`" — `new` is not a subcommand on this build; would confuse first-time users.
- "Plans always render to stdout" — with `--output json --plan-only` stdout is intentionally empty; the plan is on disk.

**Tentative status:** verified

---

## Claim 2 - Telegram goal creation (`/new_goal`)

**Evidence**

- `src/telegram/goal-commands.ts:1959-1960` — `/new_goal` handler entry (also `goal-commands.ts:97-99/484-487`, `src/telegram/bot-handlers.ts:54-58`) (`feature-inventory.md:15`, `readme-raw-material.md:19`).
- `src/telegram/goal-commands.test.ts:3094` and `:3205` — handler test coverage.
- `artifacts/claim-02-telegram.log` — static inspection only; no live Telegram message was sent in this audit.
- `RELEASE_AUDIT/FEATURE_AUDIT/product-definition.md:13` and `:47` — Telegram `/new_goal` is the headline demo path.

**Code reading verdict**

The handler is real and registered, persists a run, and gates on approval. Whether a live Telegram round trip succeeds today depends on bot token, allowlist, and gateway state, none of which were exercised here.

**Safe wording**

- "Telegram-controlled: send `/new_goal <description>` to the bot to start a goal; approve, request changes, or reject from inline buttons."

**Unsafe wording**

- "Verified end-to-end via Telegram in this release audit" — no live Telegram message was sent.
- Anything that lists `sessions_send` / `sessions_list` / `sessions_history` or repo chat as the headline Telegram capability (out of v0 per `readme-raw-material.md:78-79`).

**Tentative status:** partial

---

## Claim 3 - Structured planning (typed steps, deps, backends, criteria, constraints, build-gate)

**Evidence**

- `src/goal/planner.ts:14`, `src/goal/types.ts:57`, `src/goal/goal-schemas.ts:50` — planner prompt, `PlanStep` shape, Zod schema (`readme-raw-material.md:20`, `feature-inventory.md:17` and `:22`).
- `artifacts/claim-03-structured-plan.log` — persisted plan in `_state/goals/5e1de960-…/run.json` contains `id`, `description`, `shortSummary`, `dependsOn: []`, `backend: "codex"`, `successCriteria`, `constraints` (4 items), `status: "pending"`, `durationMinutes`, and plan-level `buildGate: { commands: ["node --check scripts/run-node.mjs"], runBetweenSteps: false }`.
- `RELEASE_AUDIT/FEATURE_AUDIT/product-definition.md:14` — "Produces structured plans with steps, dependencies, backend assignments, constraints, success criteria, and build-gate metadata".

**Code reading verdict**

Every field named in the brief is present in the actual plan emitted on this host. Schema validation rejects duplicate step IDs and invalid dependency references (`feature-inventory.md:33`).

**Safe wording**

- "Plans are validated structured objects: typed steps, explicit `dependsOn`, per-step worker backend, success criteria, constraints, and a project build/test gate."

**Unsafe wording**

- "Plans are guaranteed to be correct" — schema proves contract checks, not semantic plan correctness (`feature-inventory.md:22`).
- "Every step has success criteria" — `successCriteria` is prompted but optional in the schema (`feature-inventory.md:22`).

**Tentative status:** verified

---

## Claim 4 - DAG / critical path

**Evidence**

- `src/goal/dag-render.ts:1/28/62`, `src/goal/cpm.ts:57`, `src/goal/agent-executor-helpers.ts:170` — DAG model, Mermaid rendering, and critical-path scoring (`readme-raw-material.md:22`, `feature-inventory.md:29-31`).
- `artifacts/claim-04-dag.log` — `MOLTBOT_STATE_DIR=… node scripts/run-node.mjs goal detail 5e1de960-…` emitted both an ASCII dependency block and a Mermaid `flowchart TD` source block; PNG rendering wired only into Telegram at `src/telegram/goal-sending.ts:800` via `src/goal/mermaid-png.ts:33`.
- `RELEASE_AUDIT/FEATURE_AUDIT/feature-inventory.md:32` — Mermaid PNG rendering "may depend on local rendering tooling".

**Code reading verdict**

CLI surface gives a text DAG and Mermaid source. PNG rendering is real but lives behind the Telegram channel only, so README should claim text DAG on the CLI and image rendering specifically in the Telegram demo section.

**Safe wording**

- "`moltbot goal detail <run_id>` renders a text DAG and Mermaid source for the goal."
- "**Text DAG verified only** on the CLI; the Telegram channel additionally renders the DAG to PNG."

**Unsafe wording**

- "Renders a graphical PNG dependency graph in the terminal" (false for the CLI).
- "Renders a Mermaid diagram out of the box on every channel" (unverified beyond the Telegram path).

**Tentative status:** verified

---

## Claim 5 - Worker orchestration (multiple local backends)

**Evidence**

- `src/goal/backend-types.ts:7-10` — declared backend ids `codex`, `claude_code` (`feature-inventory.md:40`).
- `src/goal/backend-availability.ts:114-148` — runtime probing of locally installed CLIs.
- `src/goal/cli-worker.ts:183/249/288` — dispatch path that selects the `codex` vs `claude` binary per step.
- `artifacts/claim-05-workers.log` — backend selection confirmed at the code level; `codex` was implicitly exercised by the plan-only run.
- `RELEASE_AUDIT/FEATURE_AUDIT/product-definition.md:17` — common task-runner contract across backends.

**Code reading verdict**

Two distinct local CLI backends are declared, probed, and dispatched. "Two backends actually available at runtime" depends on the operator's machine; the safe phrasing is "supports multiple local CLI backends".

**Safe wording**

- "SmithersBot can route work to local Codex or Claude Code CLI workers; whichever is installed is probed at startup."

**Unsafe wording**

- "Parallel multi-agent execution verified" — execution path was not exercised in parallel here (`feature-inventory.md:31/42`, `readme-raw-material.md:77`).
- "Both Codex and Claude Code are required" — they are gracefully clamped to whatever is available.

**Tentative status:** verified

---

## Claim 6 - Artifact trail (prompts, stdout/stderr, result JSON, attempts, journals, run state)

**Evidence**

- `src/goal/cli-worker.ts:234/273-276/294-295` — worker prompt, stdout/stderr, and `worker_result.json` write paths (`readme-raw-material.md:24`).
- `src/goal/run-journal.ts:14-78` — top-level `WORKING.md` and per-task journals.
- `src/goal/attempt-bundle.ts:35-36` and `:137` — `attempt-N.json` bundles with outcome, error class, diffstat, changed files (`feature-inventory.md:114`).
- `src/goal/run-store.ts:431` — atomic serialized run state (`feature-inventory.md:51`).
- `artifacts/claim-06-artifact-trail.log` — for the plan-only run, `run.json` plus the full `scout/` artifact set is on disk: `PLANNING_BRIEF.md`, `plan_draft.md`, `execution_plan.json`, `scout_report.json`, `planning_stdout.txt`, `planning_stderr.txt`, `planning_raw_output.txt`, `attempt-1.json`, `auth_mode.txt`, `node_specs/*.md`.

**Code reading verdict**

Every artifact class named in the brief is sourced in code. Worker-time artifacts (`workers/<stepId>/worker-prompt`, `attempt-<n>.stdout/stderr`, `worker_result.json`, `WORKING.md`) are absent here only because no worker ran in plan-only mode.

**Safe wording**

- "Every plan, worker prompt, stdout/stderr capture, attempt bundle, journal note, and run state file lives on disk under the goals state directory and can be inspected after the fact."

**Unsafe wording**

- "Captures every stdin/stdout byte of every subprocess" — true for worker CLIs but easy to overclaim.
- "Writes a database log" — there is no DB; flat files only.

**Tentative status:** verified

---

## Claim 7 - Checkpoint / recoverability

**Evidence**

- `src/goal/git-checkpoint.ts:7-8/289-322` — `autosaveIfDirty`, `startTaskCheckpoint`, `finalizeTaskCheckpoint`; also `git-checkpoint.ts:193-209` `ensureRunBranch` creating `claw/run/<UTC>-<runId>`.
- `src/goal/build-gate.ts:195-211` — `resetToTaskBaseSha` reverts the worktree to the recorded base SHA on failure (`feature-inventory.md:65`).
- `src/goal/agent-executor.ts:210/221/238/388/399/465/499/540-546/609` — wiring in the task loop.
- `artifacts/claim-07-checkpoints.log` — explicit recording of "local checkpoint commits"; no `git push` is invoked.

**Code reading verdict**

Per-task local checkpoint commits are real, wired around every task attempt, and never push to a remote. Recovery rolls the worktree back to a recorded SHA, not by stashing.

**Safe wording**

- "Before each risky step SmithersBot creates **local checkpoint commits** so a failed worker can be reverted to the pre-step state."
- "Failed attempts trigger a worktree reset to the **recoverability checkpoint** SHA."

**Unsafe wording**

- "Automatically pushes to git after each step" — FALSE.
- "Auto-pushes to your origin" — FALSE.
- "Uses git stash" — not the mechanism in use.
- "Snapshots your entire repo" — it commits dirty tracked state, not ignored/untracked-and-ignored files.

**Tentative status:** verified

---

## Claim 8 - Build gate (system blocks on real subprocess failure)

**Evidence**

- `src/goal/build-gate.ts:65-115` — `runBuildGateCommands` uses `spawnSync` and captures the real exit code + stdout/stderr; first-failure short-circuit; failure classification.
- `src/goal/agent-executor.ts:532-577` — the gate runs **after** the worker reports `status=done`.
- `src/goal/agent-executor.ts:579-661` — failure paths override the worker's `done` to `blocked` or `pending`.
- `src/goal/agent-executor.ts:739-761` — session-level `state="done"` is conditional on the final gate passing.
- `artifacts/claim-08-build-gate.log` — full citation trail; system blocks on real subprocess exit, not LLM self-assessment.
- `RELEASE_AUDIT/FEATURE_AUDIT/readme-raw-material.md:75` — "do not claim guaranteed correctness; build gates exist".

**Code reading verdict**

The build gate is a real subprocess gate, not an LLM judgement. The executor cannot mark a step or session `done` if the gate fails.

**Safe wording**

- "Code-related steps cannot complete until the operator-configured build/test commands actually exit zero. SmithersBot runs the commands itself with `spawnSync` and captures full stdout/stderr."

**Unsafe wording**

- "The system trusts the model when it says tests pass" — the opposite is true.
- "Sandbox executes commands safely" — the gate runs commands as configured; it does not sandbox them.

**Tentative status:** verified

---

## Claim 9 - Manual test recommendations with criticality

**Evidence**

- `src/goal/manual-tests.ts:8-62/168-172/224-226/327-399` — generation logic; criticality scale 1..10.
- `src/goal/types.ts:123-125` — `ManualTestSuggestion` type with `criticality` field.
- `src/goal/agent-executor.ts:52/1036-1048/1061-1069` — wired into the `all_done` path.
- `src/telegram/goal-formatting.ts:96`, `src/telegram/goal-sending.ts:275-288` — renders `[N/10 Critical]` in Telegram and persists on the run.
- `artifacts/claim-09-manual-tests.log` — full citation trail.

**Code reading verdict**

Manual-test generation with criticality is fully implemented and observable: typed in the goal contract, persisted on the run, and rendered to Telegram after `all_done`. The criticality value is an LLM-assigned heuristic, not a calibrated risk model.

**Safe wording**

- "After a goal completes, SmithersBot suggests the manual smoke tests it could not run itself, each ranked by an estimated criticality."

**Unsafe wording**

- "Calibrated risk score" — it is a 1..10 LLM heuristic.
- "Guaranteed test coverage" — manual tests are *suggestions*.

**Tentative status:** verified

---

## Claim 10 - Blocked-loop behavior (keep running until blocked, then report)

**Evidence**

- `src/goal/agent-executor.ts:252` — `orderStepsCriticalPathFirst`.
- `src/goal/agent-executor.ts:310/333-336/1158-1177` — main loop, `findRunnableTasks`, `pickNextTask`, dependency gate.
- `src/goal/agent-executor.ts:340-350` — operator-answer revive path.
- `src/goal/agent-executor.ts:704-714` — `step_blocked` notification while other work continues.
- `src/goal/agent-executor.ts:695-702/716-726` — FATAL_ERRORS stop-all distinction.
- `src/goal/agent-executor.ts:1074-1109` — final aggregated `fully_blocked` event and `session.state = "blocked"`.
- `artifacts/claim-10-blocked-loop.log` — full citation trail.

**Code reading verdict**

The DAG progression loop, per-step block notification, fatal-vs-recoverable distinction, and aggregated final-blocked report are all real and traceable.

**Safe wording**

- "Steps run until their dependencies are met or until they hit a blocker; SmithersBot keeps running unrelated parts of the DAG, then reports remaining blockers to the operator."

**Unsafe wording**

- "Parallel workers" — execution is sequential in this executor (`feature-inventory.md:31/39`).
- "Always retries until success" — fatal errors stop the run by design.

**Tentative status:** verified

---

## Claim 11 - Recovery loops (admit stuck → revert → retry with new context → handoff)

**Evidence**

- `src/goal/cli-worker.ts:170/659-662/1034` — stuck-loop detection in the worker.
- `src/goal/types.ts:50-54` — `RalphDetail` shape (internal name only).
- `src/goal/task-runner.ts:22-26`, `src/goal/cli-runner.ts:100-103` — task-runner result protocol.
- `src/goal/agent-executor.ts:82/192/477-530` — recovery-loop wiring.
- `src/goal/git-checkpoint.ts:7-8/296/311`, `src/goal/agent-executor.ts:499` — revert to checkpoint via `resetToTaskBaseSha`.
- `src/goal/run-journal.ts:46-78/80-90` — failure record + history.
- `src/goal/lessons.ts:35/39/415-453/487-491` — recovery-sourced lessons reinjected into later workers.
- `artifacts/claim-11-ralph-recovery.log` — note that the literal "hand off context to another agent" is implemented only as operator escalation; the same backend retries with appended context.
- `readme-raw-material.md:81` and `product-definition.md:62` — confirm "ralph" is internal jargon and MUST NOT appear in README.

**Code reading verdict**

Detect-stuck, revert, persist failure, retry with new context, and escalate to operator are all real. Multi-backend handoff is **not** implemented; the only true handoff is escalation to the operator at `maxRalphAttempts`.

**Safe wording**

- "When a worker gets stuck, SmithersBot reverts to the pre-step checkpoint, writes what failed, and retries with new context; if still stuck after a limit, it escalates to the operator."

**Unsafe wording**

- Any use of the internal token *ralph* in user-facing copy.
- "Hands off context to another AI" — there is no automatic multi-backend handoff.
- "Self-healing" — recovery is bounded by `maxRalphAttempts`.

**Tentative status:** partial

---

## Claim 12 - Nightwatch

**Evidence**

- `src/cron/nightwatch.ts:30-37` — `NIGHTWATCH_DEFAULTS`, `NIGHTWATCH_JOB_NAME='nightwatch-daily'`.
- `src/cron/nightwatch.ts:594-655` — `buildNightwatchPrompt`.
- `src/cron/nightwatch.ts:658-725` — `runNightwatch` (git-change gate → `handleGoal` → Telegram delivery).
- `src/cron/nightwatch.ts:727-775` — `registerNightwatchJob`.
- `src/telegram/nightwatch-commands.ts:17-22/24-32` — user-facing `/nightwatch` command and usage.
- `src/telegram/bot-native-commands.ts:54-56/174/185/530-533` — registered as a native Telegram command.
- Test coverage in `src/cron/nightwatch.test.ts`, `src/telegram/nightwatch-commands.test.ts`, `src/gateway/server-cron.nightwatch.test.ts`.
- `artifacts/claim-12-nightwatch.log` — full citation trail.

**Code reading verdict**

Nightwatch is a real, named cron job with a registered handler, a user-facing Telegram command, and test coverage. The token is user-facing today.

**Safe wording**

- "**Nightwatch** is a scheduled daily code review that runs in the background and delivers a summary to your Telegram chat."

**Unsafe wording**

- "Runs at exactly 3am UTC" — the schedule is configurable (`NIGHTWATCH_DEFAULTS`); do not commit to a specific time in README.
- "Reviews production deploys" — Nightwatch runs against a working directory, not a deploy target.

**Tentative status:** verified

---

## Claim 13 - Per-directory agent memory

**Evidence**

- `src/goal/cli-runner.ts:37-38/76-84` — `readProjectConventions` reads project `CLAUDE.md`.
- `src/goal/cli-worker.ts:60/231/267-272/284/700` — explicit harness injection of `## PROJECT CONVENTIONS` for the **codex** worker prompt.
- `src/goal/cli-runner.test.ts:70-82`, `src/goal/cli-worker.test.ts:294` — regression tests confirm Codex gets the injected block and Claude Code does **not** (Claude inherits via native CLI cwd discovery at `cli-worker.ts:330`).
- `src/goal/lessons.ts:174-180` — `getLessonsForContext` filters by `workingDir` (project scope) and includes global scope.
- `src/goal/cli-worker.ts:540-582` — labelled `LESSONS FROM PRIOR RUNS` block reaches every worker.
- `src/goal/conventions.ts:30`, `src/goal/planner.ts:51/54/61` — `AGENTS.md` is read **only** by Codex natively and referenced in planner prompts; the goal worker does **not** read `AGENTS.md` itself.
- `artifacts/claim-13-per-dir-memory.log` — full narrowing of the claim.
- `feature-inventory.md:91` — "filters lessons by current working directory plus global lessons".

**Code reading verdict**

Per-directory `CLAUDE.md` is delivered to both backends (explicit for Codex, native for Claude Code) and project-scoped lessons are filtered by `workingDir`. `AGENTS.md` and `MEMORY.md` are **not** plumbed through the goal worker harness, so the public phrasing must narrow to `CLAUDE.md + scoped lessons`.

**Safe wording**

- "Each working directory can carry its own `CLAUDE.md`; SmithersBot also remembers per-directory and global lessons and injects the relevant ones into the worker prompt."

**Unsafe wording**

- "Reads `CLAUDE.md`, `AGENTS.md`, and `MEMORY.md` in every working directory" — only `CLAUDE.md` is plumbed by the goal worker.
- "Cross-machine memory" — lessons live in the local state dir.

**Tentative status:** partial

---

## Claim 14 - Semgrep / security scan

**Evidence**

- `src/goal/build-gate.ts:7` — `DEFAULT_SAST_SEMGREP_ENABLED = true` (`feature-inventory.md:63`).
- `src/goal/agent-executor.ts:179` — `semgrepMode` default `"step"`.
- `src/goal/agent-executor.ts:539-555` — path-scoped Semgrep scan prepended to the build gate after each completed step.
- `src/goal/agent-executor.ts:732-737` — whole-repo Semgrep scan on the final gate when cadence is `"goal"`.
- `src/goal/build-gate.ts:160-192` — command shape: `which semgrep && semgrep --config auto --error --severity ERROR --timeout 600 …`.
- `src/goal/build-gate.ts:15-19` — infra-failure classification routes to `build_gate_infra_failed`.
- `src/types.goal.ts:3/31-32` — operator can toggle via `config.goal.semgrep ∈ {off, step, goal}`.
- Tests: `src/goal/agent-executor.test.ts:902/970/1004/1046`, `src/goal/build-gate.test.ts:26/60`.
- `artifacts/claim-14-semgrep.log` — full citation trail.

**Code reading verdict**

Semgrep is **on by default** and runs after every code-related step. Not roadmap — implemented, tested, and routed through the build gate.

**Safe wording**

- "After each code-related step SmithersBot runs Semgrep against changed files (configurable per cadence: `off`, `step`, or `goal`)."

**Unsafe wording**

- "Replaces a full security review" — Semgrep is a SAST scan, not a pen test.
- "Always offline" — `--config auto` may fetch rules from the network and can fail as infra (`feature-inventory.md:63`).

**Tentative status:** verified

---

## Claim 15 - Local Claude Code / Codex CLI backends (subscription support)

**Evidence**

- `src/goal/backend-types.ts:7-10` — backend ids restricted to `{codex, claude_code}`.
- `src/goal/cli-worker.ts:183/288` — backend → binary selection (`codex` vs `claude`).
- `src/goal/cli-worker.ts:327-336` — spawned via `runCliProcess`.
- `src/goal/cli-worker.ts:782-799` — Codex command shape: `codex exec --json --sandbox workspace-write --cd … -c net.allowed=true`.
- `src/goal/cli-worker.ts:802-816` — Claude command shape: `claude -p --verbose --output-format stream-json --allowedTools … --append-system-prompt …`.
- `src/goal/backend-availability.ts:114-148` — both CLIs probed on PATH before dispatch.
- `src/types.goal.ts:1` — `ClaudeCodeAuthMode = 'subscription' | 'api_key'`.
- `src/goal/cli-worker.ts:230` — default `subscription`.
- `src/goal/claude-code-env.ts:7-11/54-67` — strips `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY_OLD` from worker env so the Claude Code CLI uses its own login.
- `src/goal/cli-worker.ts:250` — writes `auth_mode.txt` audit artifact.
- `artifacts/claim-15-subscriptions.log` — full citation trail.

**Code reading verdict**

Both workers are real local CLI subprocesses; subscription auth is the default for the Claude Code worker and the harness strips Anthropic credential env vars so the CLI uses its own login.

**Safe wording**

- "SmithersBot **uses local CLI backends** (Codex and Claude Code) so it works against whichever logins are already installed on the operator's machine."

**Unsafe wording**

- "Free unlimited Claude" — the harness does not promise free or unlimited usage.
- "No API keys ever" — `api_key` mode also exists; the harness simply strips credentials in subscription mode.

**Tentative status:** verified

---

## Claim 16 - Guardrails (hard-deny / capability enforcement)

**Evidence**

- `src/goal/hard-deny.ts:7/26/41/52` — typed hard-deny rules: sensitive paths, credentials, elevated-privilege commands, publish/deploy/release, destructive commands, gateway restarts (`feature-inventory.md:105`).
- `src/goal/capability-enforcement.ts:44/51/66/80/103/115` — wraps PI coding tools so Bash → `checkCommandDeny`, Read/Write/Edit → `checkPathDeny`; denials produce user-visible results.
- `src/goal/capability-enforcement.ts:110/128/131/138`, `src/goal/hard-deny.ts:71/121` — symlink-aware path checks (lexical + canonical) with non-existent-target fallback.
- `src/goal/hard-deny.ts:150/205/568/876/1047/1250/1302` — token-aware recursive command scanner.
- `artifacts/claim-16-denial-probe.mjs` — safe in-process probe.
- `artifacts/claim-16-guardrails.log` — 9/9 PASS: HardDeny match for every dangerous input (`rm -rf /`, `sudo cat /etc/shadow`, `npm publish`, `kubectl apply …`, `.env`, `~/.ssh/id_rsa`, `credentials.json`) and `null` for harmless baselines (`echo hello world`, `README.md`), exit code 0, no dangerous command executed.

**Code reading verdict**

Hard-deny is a real, exported, typed deny check connected into the worker tool surface. The deny check matched every fake forbidden input and let harmless baselines through.

**Safe wording**

- "Worker tool calls go through a typed deny check that blocks reads/writes to sensitive paths (env files, SSH keys, credentials) and a recursive command scanner that blocks dangerous shell forms, elevated privileges, and publish/deploy/release commands."

**Unsafe wording**

- "Sandbox" — there is no OS-level isolation; this is policy-and-scan enforcement.
- "Cannot leak secrets" — credential env stripping reduces risk, it does not eliminate it (`readme-raw-material.md:76`).
- Internal token *capability-bound filenames* in public copy.

**Tentative status:** verified

---

## Claim 17 - Lessons / memory injection

**Evidence**

- `src/goal/lessons.ts:25/42/66/74/85/104/127/155/174/182/198` — persistent JSON lesson store with validation, atomic private writes, write lock, `workingDir`, pattern, source, scope, runId, stepId, createdAt (`feature-inventory.md:66`, `:90`).
- `src/goal/lessons.ts:273/310/338/378/415/456/471/487/538/565/581/590/600/614/629` — `extractRunLessons` after a completed run with corrections, revisions, recovery insights, or failures (`feature-inventory.md:67`, `:92`).
- `src/goal/lessons.ts:545/561/564/565/575` — extraction guardrails: rejects planner/reviewer/manual-test advice; rejects already-fixed descriptions; project vs global scope (`feature-inventory.md:93`).
- `src/goal/cli-runner.ts:33-52`, `src/goal/cli-worker.ts:540-582` — readers stitched into the worker-prompt path; labelled `LESSONS FROM PRIOR RUNS` block.
- `artifacts/claim-17-lessons-injection.log` — confirms this worker's own prompt contains the labelled block.

**Code reading verdict**

Writers, readers, and worker-prompt injection are all live. Lessons are scoped by `workingDir` and global scope is separately capped.

**Safe wording**

- "Completed runs can produce scoped lessons; later workers in the same directory or globally automatically receive the relevant lessons in their prompt."

**Unsafe wording**

- "Shared lessons across machines" — lessons live in the local state dir.
- "Every run produces lessons" — extraction is fail-open (`feature-inventory.md:67`).
- "Self-improving AI engineer" — explicitly listed as a forbidden claim in `product-definition.md:61`.

**Tentative status:** verified

---

## Claim 18 - Resume / crash recovery

**Evidence**

- `src/goal/run-store.ts:31-47` — atomic on-disk persistence with private mode (`feature-inventory.md:51`).
- `src/goal/run-store.ts:66-151` — lock-aware migration including reset of `executing → blocked` with synthesized `BlockedDetail` (`feature-inventory.md:54`).
- `src/goal/run-store.ts:223-247` — `reconcileStaleRuns` sweep.
- `src/gateway/server-startup.ts:43-50` — sweep wired into gateway startup.
- `src/commands/goal-resume.ts:340/360` — `loadRun` reads reconciled state, then resume continues from persisted state (also `:456/:587` in `readme-raw-material.md:25`).
- `artifacts/claim-18-resume-recovery.log` — full citation trail.

**Code reading verdict**

Stale in-progress work is reconciled on gateway startup; `goal resume <run_id>` reads the reconciled state and continues. No new in-flight work is silently lost or double-run.

**Safe wording**

- "If the gateway crashes mid-run, the next start reconciles stale in-progress steps; `moltbot goal resume <run_id>` continues from the persisted state."

**Unsafe wording**

- "Guaranteed crash recovery" — best-effort, not a formal guarantee (`product-definition.md:26`).
- "Distributed/HA" — the lock is local-filesystem only (`feature-inventory.md:53`).

**Tentative status:** verified
