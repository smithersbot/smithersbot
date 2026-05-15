# SmithersBot README Verification Log

One section per claim (1..18). Each section records the commands run, exit codes, key output lines, skipped checks, the reason for the final status, and a cross-reference to both the per-claim artifact and the matching section of `_evidence/code-survey.md`.

Status vocabulary: `{verified, partial, unverified, roadmap, manual-required}`.

---

## Claim 1 - Goal creation (CLI plan-only)

- **Commands run**
  - `node scripts/run-node.mjs goal --help` — exit `0`.
  - `MOLTBOT_STATE_DIR=$PWD/RELEASE_AUDIT/README_VERIFY/_state node scripts/run-node.mjs goal "Add a short docstring to scripts/run-node.mjs" --plan-only --output json` — exit `0`.
- **Key output**
  - Help text reports top-level form `Usage: moltbot goal [options] [command] [goal]` and lists subcommands `list / status / detail / resume / answer / stop`; **no `new` subcommand**.
  - Plan-only run created `RELEASE_AUDIT/README_VERIFY/_state/goals/5e1de960-5456-4dc2-a1c7-a1bdf231cdc6/` with `run.json` (2923 B, mode 0600) and the full `scout/` artifact set; `state: planning`, `scoutStatus: success`, `blocked: null`; no run entry was created under `~/.moltbot/goals/`.
- **Skipped checks** — Execution beyond `--plan-only` was intentionally skipped (workers do not run in plan-only mode).
- **Status reason** — Real CLI surface accepts the form `moltbot goal "<task>" --plan-only`, plan is persisted on disk, and `MOLTBOT_STATE_DIR` cleanly redirects state away from `~/.moltbot/`. **verified**.
- **Cross-references** — `artifacts/claim-01-cli-help.log`, `artifacts/claim-01-cli-plan.log`; `_evidence/code-survey.md` → "Claim 1 - CLI goal creation works in plan-only mode".

---

## Claim 2 - Telegram goal creation (`/new_goal`)

- **Commands run** — None (static inspection only).
- **Key evidence**
  - `src/telegram/goal-commands.ts:1959-1960` registers both `/new_goal` and the legacy `/goal` alias against the same async handler.
  - `src/telegram/goal-commands.ts:97-99` lists `new_goal` as the first published command spec; `:484-487` carries the user-visible "Usage: /new_goal <description>" string.
  - `src/telegram/bot-handlers.ts:54-58` shows the bot's own self-description of the goal flow.
  - `src/telegram/goal-commands.test.ts:3094` and `:3205` confirm `registerTelegramGoalCommands` exposes a callable handler under the `new_goal` key in tests.
- **Skipped checks** — No live Telegram message was sent: would require a running gateway, bot token, allowlist, and chat, all out of scope for this read-only worker (and gateway restart is hard-denied during goal execution).
- **Status reason** — Handler is real, registered, tested, and reachable; live round-trip is manual-required, so the overall claim is **partial**.
- **Cross-references** — `artifacts/claim-02-telegram.log`; `_evidence/code-survey.md` → "Claim 2 - Telegram goal creation (`/new_goal`)".

---

## Claim 3 - Structured planning

- **Commands run** — Plan extracted from the persisted `run.json` produced by the Claim 1 invocation: `MOLTBOT_STATE_DIR=$PWD/RELEASE_AUDIT/README_VERIFY/_state node scripts/run-node.mjs goal "Add a short docstring to scripts/run-node.mjs" --plan-only --output json` (exit `0`).
- **Key output (extracted from `_state/goals/5e1de960-…/run.json`)**
  - `plan.goal` = `"Add a short docstring to scripts/run-node.mjs"`; `plan.workingDir` = `/home/matt/moltbot`.
  - Single step `add-run-node-docstring`: `status: "pending"`, `dependsOn: []`, `backend: "codex"`, `successCriteria` present, `constraints` = 4 items, `durationMinutes: 5`.
  - Plan-level `buildGate` = `{ "commands": ["node --check scripts/run-node.mjs"], "runBetweenSteps": false }`.
- **Skipped checks** — Plans with multi-step `dependsOn` graphs were not exercised here; schema validation (duplicate id / invalid dep) was not separately probed.
- **Status reason** — Every field named in the brief (typed steps, deps, backends, criteria, constraints, build-gate) is present on the actual persisted plan. **verified**.
- **Cross-references** — `artifacts/claim-03-structured-plan.log`; `_evidence/code-survey.md` → "Claim 3 - Structured planning (typed steps, deps, backends, criteria, constraints, build-gate)".

---

## Claim 4 - DAG / critical path

- **Commands run**
  - `MOLTBOT_STATE_DIR=$PWD/RELEASE_AUDIT/README_VERIFY/_state node scripts/run-node.mjs goal detail 5e1de960-5456-4dc2-a1c7-a1bdf231cdc6` — exit `0`, 35 stdout lines, 0 stderr lines.
- **Key output**
  - Stdout contains a `**Dependencies (ASCII)**` block (text DAG with `[ ]` / `[x]` markers and `deps:` lines) AND a `**Dependency Graph**` `mermaid` code block (`flowchart TD` source).
  - No PNG file path, no rendered image, no base64-encoded image appears in CLI stdout.
- **Skipped checks** — Telegram-side PNG rendering (`src/telegram/goal-sending.ts:800` → `src/goal/mermaid-png.ts:33`) was not exercised in this audit.
- **Status reason** — CLI surface emits both a text DAG and Mermaid source; PNG rendering is wired only into the Telegram channel. Recorded as **"text DAG verified only"** for the CLI surface. **verified**.
- **Cross-references** — `artifacts/claim-04-dag.log`; `_evidence/code-survey.md` → "Claim 4 - DAG / critical path".

---

## Claim 5 - Worker orchestration (multiple local CLI backends)

- **Commands run** — None as a dedicated probe; `codex` was implicitly exercised by the Claim 1 plan-only run (planner output marked steps `backend: "codex"`, which requires `codex` to be reachable on PATH at planning time).
- **Key evidence**
  - `src/goal/backend-types.ts:7-8` declares `GoalBackendId = "pi" | "codex" | "claude_code"` and `:10` declares `DEFAULT_ENABLED_WORKERS = ["codex", "claude_code"]` (the two CLI worker IDs).
  - `src/goal/backend-availability.ts:114-148` actively probes `codex exec --help` and `claude --help` on PATH with `spawnSync`, returning per-backend `{ available, reason }`.
  - `src/goal/cli-worker.ts:183` and `:288` select the binary per backend (`backend === "codex" ? "codex" : "claude"`).
- **Skipped checks** — `detectBackendAvailability()` was not invoked directly in this worker; `claude_code` availability on the publishing host is host-state and was not separately probed.
- **Status reason** — Two distinct local CLI backends are declared, probed, and dispatched; safe phrasing is "uses local CLI backends" (do not promise both will always be available). **verified**.
- **Cross-references** — `artifacts/claim-05-workers.log`; `_evidence/code-survey.md` → "Claim 5 - Worker orchestration (multiple local backends)".

---

## Claim 6 - Artifact trail

- **Commands run** — On-disk inventory of `RELEASE_AUDIT/README_VERIFY/_state/goals/5e1de960-…/` created by Claim 1.
- **Key output (artifacts present on disk for this plan-only run)**
  - `run.json` (2923 B, mode 0600).
  - `scout/PLANNING_BRIEF.md` (17616 B), `scout/plan_draft.md`, `scout/execution_plan.json`, `scout/scout_report.json`, `scout/planning_stdout.txt`, `scout/planning_stderr.txt`, `scout/planning_raw_output.txt`, `scout/attempt-1.json`, `scout/auth_mode.txt`, `scout/node_specs/add-run-node-docstring.md`.
- **Skipped checks** — Worker-dispatch-time artifacts (`workers/<stepId>/worker-prompt-<n>.txt`, `attempt-<n>.stdout.txt`, `attempt-<n>.stderr.txt`, `worker_result.json`, `WORKING.md`) are absent because the run is plan-only; their write sites are sourced in code at `src/goal/cli-worker.ts:234/273-276/294-295`, `src/goal/run-journal.ts:14-78`, and `src/goal/attempt-bundle.ts:35-36`.
- **Status reason** — Every artifact class the brief names is sourced in code and either present on disk for this run or would be created on first worker dispatch. **verified**.
- **Cross-references** — `artifacts/claim-06-artifact-trail.log`; `_evidence/code-survey.md` → "Claim 6 - Artifact trail (prompts, stdout/stderr, result JSON, attempts, journals, run state)".

---

## Claim 7 - Checkpoint / recoverability

- **Commands run** — None (static inspection only; no `git` mutation was triggered by this read-only worker, in keeping with the multi-agent safety rules).
- **Key evidence**
  - `src/goal/git-checkpoint.ts:289-294` (`autosaveIfDirty`), `:296-309` (`startTaskCheckpoint` captures `{ baseSha, beforeCommit? }`), `:311-322` (`finalizeTaskCheckpoint` writes `claw: <taskId> - <summary>`), `:193-209` (`ensureRunBranch` for `claw/run/<UTC>-<runId>`).
  - `src/goal/build-gate.ts:195-211` (`resetToTaskBaseSha` = `git reset --hard <baseSha>`).
  - Executor wiring at `src/goal/agent-executor.ts:221` (one-time pre-flight autosave), `:238` (run branch), `:388` (task-entry checkpoint), `:465` (success commit), `:499` and `:609` (failure-path reset).
  - No `git push` is called from the per-task loop; the only push site (`pushRunBranch`, `git-checkpoint.ts:211-238`) is privacy-gated and called separately by a PR-creation flow.
- **Skipped checks** — Did not run a real failing task to observe the reset live; verified via code path + executor tests at `src/goal/agent-executor.test.ts:507/565/635/713/789/828/869/1126/1166`.
- **Status reason** — Per-task **local checkpoint commits** with **recoverability checkpoint** resets are real and wired; nothing pushes to git from the per-task loop. **verified**.
- **Cross-references** — `artifacts/claim-07-checkpoints.log`; `_evidence/code-survey.md` → "Claim 7 - Checkpoint / recoverability".

---

## Claim 8 - Build gate (system blocks on real subprocess failure)

- **Commands run** — None (static inspection of the gate path; this worker is forbidden from running build/lint/test suites).
- **Key evidence**
  - `src/goal/build-gate.ts:65-115` — `runBuildGateCommands` uses `spawnSync("bash", ["-lc", trimmed], { cwd, encoding: "utf8", timeout: BUILD_GATE_COMMAND_TIMEOUT_MS })`, evaluates `result.error` and `result.status !== 0`, and returns `{ passed: false, failedCommand, output, failureKind }`.
  - `src/goal/agent-executor.ts:532-577` — gate runs only **after** the worker reports `status = "done"`.
  - `src/goal/agent-executor.ts:579-661` — on failure the executor overrides `task.status = "done"` to `"blocked"` (infra failure / retry exhaustion) or to `"pending"` after `resetToTaskBaseSha`.
  - `src/goal/agent-executor.ts:739-761` — session-level `state = "done"` is conditional on the **final** gate passing.
- **Skipped checks** — No real build/test invocation was performed by this worker.
- **Status reason** — The gate is a real subprocess gate with captured exit code, stdout, and stderr; the executor cannot mark a step or session `done` if the gate fails. **verified**.
- **Cross-references** — `artifacts/claim-08-build-gate.log`; `_evidence/code-survey.md` → "Claim 8 - Build gate (system blocks on real subprocess failure)".

---

## Claim 9 - Manual test recommendations with criticality

- **Commands run** — None (static inspection only; manual-test generation only fires on a completed run, and this audit's run is plan-only).
- **Key evidence**
  - `src/goal/manual-tests.ts:8-62` — `MANUAL_TESTS_SYSTEM_PROMPT` instructs the model to emit `criticality` integers 1..10.
  - `src/goal/manual-tests.ts:168-172` — `clampCriticality` clamps to 1..10 (default 5).
  - `src/goal/manual-tests.ts:224-226` — `fallbackCriticality` decays 3..6 when the model returns fewer suggestions than requested.
  - `src/goal/manual-tests.ts:327-399` — public `generateManualTests`.
  - `src/goal/types.ts:123-125` — `ManualTestSuggestion = { description, criticality, reason?, detail }`.
  - `src/goal/agent-executor.ts:52/1036-1048/1061-1069` — wired into the `all_done` path; fail-open with `manualTestsError`.
  - `src/telegram/goal-formatting.ts:96`, `src/telegram/goal-sending.ts:275-288` — renders `[N/10 Critical]` and persists on the run record.
- **Skipped checks** — `all_done` was not exercised in this audit; no live Telegram render was produced.
- **Status reason** — Generation, typed contract, wiring, and channel render are all sourced in code; criticality is an LLM heuristic (not a calibrated risk score). **verified**.
- **Cross-references** — `artifacts/claim-09-manual-tests.log`; `_evidence/code-survey.md` → "Claim 9 - Manual test recommendations with criticality".

---

## Claim 10 - Blocked-loop behavior

- **Commands run** — None (static inspection only).
- **Key evidence**
  - `src/goal/agent-executor.ts:252` — `orderStepsCriticalPathFirst`.
  - `:310/333-336/1158-1177` — main `while (true)` loop, `findRunnableTasks` gating on `dependsOn`, `pickNextTask` by score and successors.
  - `:340-350` — operator-answer revive path.
  - `:704-714` — `step_blocked` notification while other work continues.
  - `:62-63/695-702/716-726` — FATAL_ERRORS stop-all distinction; non-fatal blockers continue the rest of the DAG.
  - `:1074-1109` — aggregated `fully_blocked` event + `session.state = "blocked"` once nothing else is runnable.
- **Skipped checks** — No live blocked run was exercised.
- **Status reason** — All four behaviors (DAG drain, per-step block notify, fatal-vs-recoverable, aggregated final-blocked report) are sourced in code. **verified**.
- **Cross-references** — `artifacts/claim-10-blocked-loop.log`; `_evidence/code-survey.md` → "Claim 10 - Blocked-loop behavior (keep running until blocked, then report)".

---

## Claim 11 - Recovery loops (admit stuck → revert → retry → escalate)

- **Commands run** — None (static inspection only).
- **Key evidence**
  - `src/goal/cli-worker.ts:170/659-662/1034` — worker prompt teaches the stuck-self-report shape and parses it on exit.
  - `src/goal/types.ts:50-54` — typed `RalphDetail` (internal name) with `approachTried`, `specificErrors`, `keyInsight`, `suggestedApproach`.
  - `src/goal/task-runner.ts:22-26` and `src/goal/cli-runner.ts:100-103` — translates worker output into a `TaskRunnerResult` with status `"ralph"`.
  - `src/goal/agent-executor.ts:82` (`DEFAULT_MAX_RALPH_ATTEMPTS = 2`), `:183/192`, `:477-530` — count, increment, escalate or retry with appended history; `:499` calls `resetToTaskBaseSha`.
  - `src/goal/git-checkpoint.ts:7-8/296/311`, `src/goal/build-gate.ts:195-211` — revert mechanics.
  - `src/goal/run-journal.ts:46-78/80-90` — failure record + consolidated history used as the blocked-question handoff.
  - `src/goal/lessons.ts:35/39/415-453/487-491` — recovery insights survive as scoped lessons reinjected into later workers.
- **Skipped checks** — No live stuck-loop scenario was exercised; literal handoff to a different model/backend is **not** implemented (only operator escalation).
- **Status reason** — Detect-stuck, revert, persist failure, retry with new context, and escalate-to-operator are all implemented; automatic multi-backend handoff is not. Safe wording must describe operator escalation, not multi-agent handoff. **partial**.
- **Cross-references** — `artifacts/claim-11-ralph-recovery.log`; `_evidence/code-survey.md` → "Claim 11 - Recovery loops (admit stuck → revert → retry with new context → handoff)".

---

## Claim 12 - Nightwatch

- **Commands run** — None (static inspection only; cron / Telegram were not exercised).
- **Key evidence**
  - `src/cron/nightwatch.ts:30-37` — `NIGHTWATCH_DEFAULTS` (cron `0 3 * * *`, default repo path, timezone), `NIGHTWATCH_JOB_NAME = "nightwatch-daily"`.
  - `:594-655` — `buildNightwatchPrompt`.
  - `:658-725` — `runNightwatch` (git-change gate → `handleGoal` → Telegram delivery).
  - `:727-775` — `registerNightwatchJob` registers/replaces the job in the cron service.
  - `src/telegram/nightwatch-commands.ts:17-22` — `NIGHTWATCH_COMMAND_SPECS` describing `/nightwatch`; `:24-32` — `/nightwatch on|off|time|tz|chat` usage.
  - `src/telegram/bot-native-commands.ts:54-56/174/185/530-533` — native command registration.
  - Tests: `src/cron/nightwatch.test.ts`, `src/telegram/nightwatch-commands.test.ts`, `src/gateway/server-cron.nightwatch.test.ts`.
- **Skipped checks** — Live cron trigger and live Telegram delivery were not exercised.
- **Status reason** — Real cron job with a registered handler, a user-facing Telegram command surface, and test coverage. The token "nightwatch" is user-facing today. **verified**.
- **Cross-references** — `artifacts/claim-12-nightwatch.log`; `_evidence/code-survey.md` → "Claim 12 - Nightwatch".

---

## Claim 13 - Per-directory agent memory

- **Commands run** — None as a dedicated probe; the `LESSONS FROM PRIOR RUNS` block is directly observable in this worker's own prompt, which is direct evidence that the lessons-injection path is wired (also verifies for Claim 17).
- **Key evidence**
  - `src/goal/cli-runner.ts:37-38/76-84` — `readProjectConventions` reads `<workingDir>/CLAUDE.md` (gated to Codex backend only).
  - `src/goal/cli-worker.ts:60/231/267-272/284/700` — `projectConventions` is passed into the worker payload and prepended as a `## PROJECT CONVENTIONS` section in the Codex prompt.
  - Test coverage: `src/goal/cli-runner.test.ts:70-82` (CLAUDE.md reaches Codex), `src/goal/cli-worker.test.ts:294` (it does **not** reach the Claude Code worker as an injection — Claude Code inherits CLAUDE.md via its native cwd discovery at `cli-worker.ts:330`).
  - `src/goal/lessons.ts:174-180` — `getLessonsForContext(workingDir)` filters project-scoped lessons by `workingDir` and includes global-scoped ones.
  - `src/goal/cli-worker.ts:540-582` — labelled `LESSONS FROM PRIOR RUNS` block emitted in every worker prompt.
  - `AGENTS.md` is read natively by Codex (`cli-worker.ts:782-799`) but the goal worker harness does **not** open it itself (`src/goal/conventions.ts:30`, `src/goal/planner.ts:51/54/61`). `MEMORY.md` is owned by a different subsystem and is not read by the goal worker (zero hits in a recursive grep across `src/goal/` for `MEMORY.md`).
- **Skipped checks** — No live Claude Code run with a per-dir CLAUDE.md was exercised; only the test assertions and the code path were inspected.
- **Status reason** — Per-directory CLAUDE.md is honoured end-to-end on both backends (explicit injection for Codex, native discovery for Claude Code); project-scoped lessons are filtered by `workingDir`. Public wording must narrow to `CLAUDE.md + scoped lessons` (do not include `AGENTS.md`/`MEMORY.md`). **partial**.
- **Cross-references** — `artifacts/claim-13-per-dir-memory.log`; `_evidence/code-survey.md` → "Claim 13 - Per-directory agent memory".

---

## Claim 14 - Semgrep / security scan

- **Commands run** — None (static inspection only; this worker is forbidden from running the build/lint/test suites that would trigger Semgrep).
- **Key evidence**
  - `src/goal/build-gate.ts:7` — `DEFAULT_SAST_SEMGREP_ENABLED = true`.
  - `src/goal/agent-executor.ts:179` — `semgrepMode = config?.goal?.semgrep ?? "step"`.
  - `:539-555` — when cadence is `"step"`, a path-scoped Semgrep command is prepended to the build gate after each completed step.
  - `:732-737` — when cadence is `"goal"`, a whole-repo Semgrep scan is prepended to the **final** gate.
  - `src/goal/build-gate.ts:160-192` — command shape: `semgrep scan --config auto --error --quiet --severity ERROR --timeout 600 --exclude 'node_modules' --exclude 'dist' --exclude '.git' --exclude '.next' --exclude 'build' --exclude '*.test.ts' --exclude '.moltbot-goal-worker-results' <target>`; `which semgrep` returning non-zero silently degrades to skip.
  - `src/goal/build-gate.ts:15-19` — infra-class failures route to `build_gate_infra_failed`.
  - `src/types.goal.ts:3/31-32` — operator toggle `config.goal.semgrep ∈ {off, step, goal}`.
  - Tests: `src/goal/agent-executor.test.ts:902/970/1004/1046`, `src/goal/build-gate.test.ts:26/60`.
- **Skipped checks** — No live Semgrep run was exercised in this audit.
- **Status reason** — Semgrep is **on by default** at step cadence, prepended to the build gate, and toggleable; failures route through the existing blocked path. Not roadmap. **verified**.
- **Cross-references** — `artifacts/claim-14-semgrep.log`; `_evidence/code-survey.md` → "Claim 14 - Semgrep / security scan".

---

## Claim 15 - Claude Code / Codex CLI backends (subscription)

- **Commands run** — None as a dedicated probe; codex was implicitly probed at planning time during Claim 1.
- **Key evidence**
  - `src/goal/backend-types.ts:7-10` — backend ids restricted to `{codex, claude_code}`.
  - `src/goal/cli-worker.ts:183` and `:288` — `command = backend === "codex" ? "codex" : "claude"`.
  - `src/goal/cli-worker.ts:327-336` — `runCliProcess({ command, args, cwd, env: workerEnv })`.
  - `src/goal/cli-worker.ts:782-799` — Codex arg list: `codex [--ask-for-approval never] exec --json --sandbox workspace-write --cd <workingDir> -c net.allowed=true [--model <id>] <prompt>`.
  - `src/goal/cli-worker.ts:802-816` — Claude Code arg list: `claude -p --verbose --output-format stream-json --allowedTools <list> --append-system-prompt <denies+context> [--model <id>] <prompt>`.
  - `src/goal/backend-availability.ts:114-148` — both CLIs probed on PATH before dispatch.
  - `src/types.goal.ts:1` — `ClaudeCodeAuthMode = "subscription" | "api_key"`; `src/goal/cli-worker.ts:230` defaults `claudeCodeAuth = "subscription"`.
  - `src/goal/claude-code-env.ts:7-11/54-67` — `AUTH_KEYS_TO_STRIP = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY_OLD"]` removed from the worker env in subscription mode.
  - `src/goal/cli-worker.ts:249-250` — auth mode persisted to `auth_mode.txt` artifact.
- **Skipped checks** — No live `claude` or `codex` worker invocation was performed by this audit; both binaries' actual presence on the publishing host is host-state.
- **Status reason** — Both workers are real local CLI subprocesses; subscription auth is the default for Claude Code and the harness strips Anthropic credential env vars so the CLI uses its own login. Safe wording = **"uses local CLI backends"**; never promise *free* or *unlimited*. **verified**.
- **Cross-references** — `artifacts/claim-15-subscriptions.log`; `_evidence/code-survey.md` → "Claim 15 - Local Claude Code / Codex CLI backends (subscription support)".

---

## Claim 16 - Guardrails (hard-deny / capability enforcement)

- **Commands run**
  - `node --import tsx RELEASE_AUDIT/README_VERIFY/artifacts/claim-16-denial-probe.mjs` — exit `0`, failures `0 / 9`.
- **Key output (verbatim from the probe stdout)**
  - `HARD_DENIES total entries: 43`.
  - Command deny: `[PASS] rm-rf-root` (`rm -rf /`), `[PASS] sudo-prefix` (`sudo cat /etc/shadow`), `[PASS] npm-publish` (`npm publish`), `[PASS] kubectl-apply` (`kubectl apply -f manifest.yaml`); `[PASS] harmless-echo` (`echo hello world` → ALLOW).
  - Path deny: `[PASS] env-file` (`.env`), `[PASS] ssh-private-key` (`/home/user/.ssh/id_rsa`), `[PASS] credentials-json` (`credentials.json`); `[PASS] harmless-readme` (`README.md` → ALLOW).
- **Skipped checks** — No dangerous command was executed; the probe only invokes the pure predicates `checkCommandDeny` / `checkPathDeny` with fake forbidden strings as plain JS arguments.
- **Status reason** — Pure deny-check functions exported from `src/goal/hard-deny.ts:7/121/1250/1302` and wired into the worker tool surface at `src/goal/capability-enforcement.ts:44/50-56/66/93/115`; 9/9 pass on a safe in-process probe. **verified**.
- **Cross-references** — `artifacts/claim-16-guardrails.log`, `artifacts/claim-16-denial-probe.mjs`; `_evidence/code-survey.md` → "Claim 16 - Guardrails (hard-deny / capability enforcement)".

---

## Claim 17 - Lessons / memory injection

- **Commands run** — None as a dedicated probe; this worker's own prompt contains a labelled `LESSONS FROM PRIOR RUNS` block, providing direct end-to-end evidence that the injection path is live.
- **Key evidence**
  - `src/goal/lessons.ts:25` (`LESSONS_FILENAME = "goal-lessons.json"`), `:35` (sources), `:42-52` (`Lesson` shape), `:66` (state-dir-aware `resolveLessonsPath`), `:74-83` (`atomicWriteJson` chmod 0600), `:127-153` (`acquireLessonsWriteLock`, 5s deadline).
  - Writers: `:155` `addLesson`, `:581` `extractRunLessons` (calls Claude Code first then Codex; records each candidate via `addLesson(... source:"autocheck", scope: ...)`).
  - Extraction guardrails: `:538-579` `buildLessonExtractionPrompt` requires kebab-case patterns, scope ∈ `{global, project}`, rejects already-fixed descriptions.
  - Readers: `:174-180` `getLessonsForContext(workingDir)` returns global + matching project lessons.
  - Injection: `src/goal/cli-runner.ts:33-52` threads lessons into the worker call; `src/goal/cli-worker.ts:540-582/576-582` emits the labelled `LESSONS FROM PRIOR RUNS` block in the prompt.
- **Skipped checks** — Did not exercise `extractRunLessons` on a fresh completed run (the run created in this audit was plan-only).
- **Status reason** — Writers, readers, and worker-prompt injection are all live; the labelled block is observable in this worker's own prompt. **verified**.
- **Cross-references** — `artifacts/claim-17-lessons-injection.log`; `_evidence/code-survey.md` → "Claim 17 - Lessons / memory injection".

---

## Claim 18 - Resume / crash recovery

- **Commands run** — None (static inspection only; gateway restart is hard-denied during goal execution).
- **Key evidence**
  - `src/goal/run-store.ts:31-40` — `atomicWriteJson` (temp + rename + chmod 0600).
  - `:43-47` — `saveRun` flushes the complete `SerializedRun` on every mutation.
  - `:50-63` — `loadRun` runs `migrateRun` and rewrites the file when state changed (converging the on-disk shape on every read).
  - `:66-170` — `migrateRun`: when no live lock matches `<goalsDir>/.locks/runs/<runId>.lock` (`:182-202` `hasActiveRunLock`), legacy `running`/`in_progress` step statuses reset to `pending` and run-level `executing` is recovered to `done` (if all steps done) or `blocked` with a synthesized `BlockedDetail { blockedAt: "execution", prompt: "Run was interrupted (gateway restart or process exit). Use goal resume to continue.", requiredInputKey: "resume_execution" }`.
  - `:223-247` — `reconcileStaleRuns` sweep.
  - `src/gateway/server-startup.ts:43-50` — the sweep is wired into gateway startup.
  - `src/commands/goal-resume.ts:340` — `loadRun(resolvedId)` reads the reconciled run; `:360` branches on `run.state === "blocked"`; `:189` and `:470` repeatedly reload from disk.
- **Skipped checks** — Did not crash + restart the gateway in this audit (forbidden). Recovery is at-least-once for the interrupted step (rolled back to `pending` and replayed).
- **Status reason** — Atomic persistence + lock-aware migration + startup sweep + resume reading reconciled state together implement crash recovery. **verified**.
- **Cross-references** — `artifacts/claim-18-resume-recovery.log`; `_evidence/code-survey.md` → "Claim 18 - Resume / crash recovery".

---

Sources: `RELEASE_AUDIT/README_VERIFY/artifacts/INDEX.md`, `RELEASE_AUDIT/README_VERIFY/_evidence/code-survey.md`, and `RELEASE_AUDIT/README_VERIFY/artifacts/claim-01..18-*.log`.
