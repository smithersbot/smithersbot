# Product Definition

## Positioning (one sentence)

SmithersBot is a Telegram-controlled coding-goal orchestrator that turns a high-level request into a validated task graph, assigns work to local agent workers, preserves auditable run artifacts, and learns scoped lessons from completed runs.

## Three-sentence explanation

SmithersBot centers on the goal system: `/new_goal` and the CLI create durable goal runs, generate structured plans, validate dependencies, and hold for operator approval before execution (`src/telegram/goal-commands.ts:483`; `src/commands/goal.ts:90`; `src/goal/goal-schemas.ts:50`). It represents work as a DAG, computes critical-path priority, routes tasks across PI/Codex/Claude Code style backends, and records worker results through a common result protocol (`src/goal/dag-render.ts:1`; `src/goal/cpm.ts:57`; `src/goal/agent-executor.ts:333`; `src/goal/task-runner.ts:5`; `src/goal/cli-worker.ts:809`). Around that execution loop it adds plan autocheck, post-execution review, build gates, hard-deny guardrails, durable artifacts, resume support, feedback revision, and scoped learned rules (`src/goal/plan-autocheck.ts:445`; `src/goal/post-execution-review.ts:206`; `src/goal/build-gate.ts:58`; `src/goal/hard-deny.ts:52`; `src/goal/run-store.ts:65`; `src/commands/goal-resume.ts:587`; `src/goal/feedback.ts:46`; `src/goal/lessons.ts:174`).

## What it does

- Creates coding goals from Telegram or CLI, persists each run, renders a plan, and waits for approval before execution (`src/telegram/goal-commands.ts:483`; `src/commands/goal.ts:236`; `src/commands/goal.ts:286`).
- Produces structured plans with steps, dependencies, backend assignments, constraints, success criteria, and build-gate metadata (`src/goal/planner.ts:14`; `src/goal/types.ts:57`; `src/goal/goal-schemas.ts:50`).
- Optionally runs an independent read-only plan autocheck/revision loop before approval (`src/goal/plan-autocheck.ts:28`; `src/goal/plan-autocheck.ts:445`; `src/goal/plan-autocheck.ts:819`).
- Converts planned work into a dependency graph, renders DAG views, and computes critical-path-aware task priority (`src/goal/dag-render.ts:62`; `src/goal/mermaid-render.ts:15`; `src/goal/cpm.ts:57`; `src/goal/agent-executor-helpers.ts:170`).
- Routes ready tasks through a common worker runner contract across PI, Codex, and Claude Code backends, with availability checks and fallback rules (`src/goal/backend-types.ts:8`; `src/goal/backend-availability.ts:114`; `src/goal/task-runner.ts:5`; `src/goal/agent-executor.ts:359`).
- Persists worker prompts, stdout/stderr, result JSON, attempt bundles, working journals, and run state for auditability and handoff (`src/goal/cli-worker.ts:294`; `src/goal/cli-worker.ts:819`; `src/goal/attempt-bundle.ts:17`; `src/goal/run-journal.ts:7`; `src/goal/run-store.ts:431`).
- Supports operator feedback, blocked-question answers, explicit resume, stale-run reconciliation, and post-execution review/build-gate checks (`src/goal/feedback.ts:46`; `src/telegram/goal-router.ts:205`; `src/commands/goal-resume.ts:587`; `src/goal/run-store.ts:131`; `src/goal/post-execution-review.ts:168`; `src/goal/build-gate.ts:58`).
- Enforces goal-specific hard-deny rules for sensitive paths, dangerous commands, publish/deploy/release operations, service restarts, and credential-like environment exposure (`src/goal/hard-deny.ts:7`; `src/goal/capability-enforcement.ts:44`; `src/goal/claude-code-env.ts:7`; `src/goal/cli-worker.ts:628`).
- Stores scoped lessons from prior runs and injects relevant learned rules into future worker prompts (`src/goal/lessons.ts:25`; `src/goal/lessons.ts:174`; `src/goal/agent-executor.ts:1024`; `src/goal/cli-worker.ts:576`).

## What it does not do

- It is not primarily a public story about inherited Moltbot messaging channels, WebChat, mobile apps, plugin surfaces, or generic session tools; those are inherited, internal, or out of v0 scope per `RELEASE_AUDIT/FEATURE_AUDIT/upstream-vs-smithersbot.md`.
- It does not prove fully autonomous correctness; plans, execution, reviews, build gates, and learned lessons are evidence-backed systems, but runtime claims still need demos (`src/goal/plan-autocheck.ts:735`; `src/goal/post-execution-review.ts:214`; `src/goal/lessons.ts:581`).
- It should not be marketed as a complete security sandbox; the evidence supports explicit hard-deny guardrails, path checks, command scanning, credential stripping, and sandbox prompts, not formal isolation (`src/goal/hard-deny.ts:150`; `src/goal/capability-enforcement.ts:110`; `src/goal/cli-worker.ts:802`).
- It should not claim verified parallel execution; the public-safe claim is critical-path-aware scheduling and dependency-ready task assignment (`src/goal/cpm.ts:57`; `src/goal/agent-executor.ts:333`; `src/goal/agent-executor-helpers.ts:170`).
- It should not present repo chat, `sessions_send`, `sessions_list`, or `sessions_history` as the v0 product; those are adjacent or inherited surfaces (`src/telegram/repo-chat-commands.ts:35`; `src/agents/tools/sessions-send-tool.ts:31`; `src/agents/tools/sessions-list-tool.ts:21`; `src/agents/tools/sessions-history-tool.ts:16`).

## Who it is for

- Developers who want a phone-controlled or CLI-controlled agent loop for non-trivial coding tasks with planning, approval, execution, verification, and recovery artifacts (`src/telegram/goal-commands.ts:483`; `src/commands/goal.ts:90`; `src/goal/run-store.ts:65`).
- Operators of local agent backends who want to coordinate Codex, Claude Code, and PI-style workers without turning the system into a hosted SaaS (`src/goal/backend-types.ts:8`; `src/goal/backend-availability.ts:114`; `src/goal/cli-runner.ts:40`; `src/goal/pi-runner.ts:101`).
- Builders who care about inspectable agent work: plans, DAGs, worker prompts, result files, logs, build-gate output, and lessons are first-class artifacts (`src/goal/dag-render.ts:1`; `src/goal/cli-worker.ts:819`; `src/goal/attempt-bundle.ts:69`; `src/goal/lessons.ts:104`).

## Why it is technically interesting

- It treats agent work as an executable dependency graph rather than a single prompt or flat checklist (`src/goal/types.ts:57`; `src/goal/dag-render.ts:62`; `src/goal/cpm.ts:57`).
- It separates planning, plan review, operator approval, execution, post-execution review, and build verification into distinct stages with persisted artifacts (`src/goal/cli-planner.ts:819`; `src/goal/plan-autocheck.ts:819`; `src/commands/goal.ts:286`; `src/goal/agent-executor.ts:430`; `src/goal/post-execution-review.ts:206`; `src/goal/build-gate.ts:115`).
- It normalizes multiple worker backends behind one result protocol, so orchestration logic can react to `complete`, `blocked`, `failed`, or strategy-change outcomes consistently (`src/goal/task-runner.ts:21`; `src/goal/cli-runner.ts:86`; `src/goal/cli-worker.ts:809`).
- It makes agent execution auditable by saving prompts, stdout/stderr, result files, attempt summaries, working journals, and serialized run state (`src/goal/cli-worker.ts:294`; `src/goal/cli-worker.ts:327`; `src/goal/attempt-bundle.ts:137`; `src/goal/run-journal.ts:25`; `src/goal/run-store.ts:431`).
- It has goal-specific safety and continuity layers: hard-deny policies, capability enforcement, credential stripping, locks, stale-run reconciliation, resume, feedback revision, and scoped learned rules (`src/goal/hard-deny.ts:52`; `src/goal/capability-enforcement.ts:80`; `src/goal/claude-code-env.ts:41`; `src/goal/goal-lock.ts:97`; `src/goal/run-store.ts:131`; `src/commands/goal-resume.ts:587`; `src/goal/feedback.ts:90`; `src/goal/lessons.ts:174`).

## What should be demoed

- Create a goal from Telegram with `/new_goal`, show the generated plan, approve it, and show progress/status delivery through the Telegram control loop (`src/telegram/goal-commands.ts:483`; `src/telegram/goal-commands.ts:580`; `src/telegram/bot-handlers.ts:589`).
- Create the same kind of goal from CLI, show plan-only or approval-gated behavior, then resume execution (`src/commands/goal.ts:90`; `src/commands/goal.ts:236`; `src/commands/goal-resume.ts:456`; `src/commands/goal-resume.ts:587`).
- Show the DAG and critical-path ordering from a multi-step plan, including a status/detail view (`src/goal/dag-render.ts:62`; `src/goal/cpm.ts:57`; `src/commands/goal-detail.ts:177`; `src/telegram/goal-sending.ts:37`).
- Show a worker attempt directory containing prompt, stdout/stderr, result JSON, attempt bundle, and working notes (`src/goal/cli-worker.ts:234`; `src/goal/cli-worker.ts:294`; `src/goal/cli-worker.ts:819`; `src/goal/attempt-bundle.ts:17`; `src/goal/run-journal.ts:7`).
- Show one blocked task or feedback revision flow, then resume with the answer/revised plan (`src/telegram/goal-router.ts:205`; `src/goal/feedback.ts:46`; `src/telegram/goal-commands.ts:950`; `src/commands/goal-resume.ts:587`).
- Show one guardrail denial for a safe fake dangerous command/path, and one build-gate failure with targeted remediation guidance (`src/goal/hard-deny.ts:52`; `src/goal/capability-enforcement.ts:115`; `src/goal/build-gate.ts:58`; `src/goal/build-gate.ts:115`).
- Show a completed run generating or injecting scoped lessons into a later worker prompt (`src/goal/agent-executor.ts:1024`; `src/goal/lessons.ts:174`; `src/goal/cli-worker.ts:576`).

## What should be omitted from README

- Upstream Moltbot/OpenClaw as the headline product story; credit it in a dedicated ancestry/credits section instead of leading with inherited channel features (`RELEASE_AUDIT/FEATURE_AUDIT/upstream-vs-smithersbot.md`).
- Broad non-Telegram channel positioning, mobile/mac app claims, WebChat, plugins, and generic gateway/session features that Stage 2A classified as out, internal, or investigate (`RELEASE_AUDIT/FEATURE_AUDIT/feature-inventory.md`; `RELEASE_AUDIT/keep-vs-cut.md`).
- `sessions_send`, `sessions_list`, and `sessions_history` as public v0 features because they are marked modified/inherited and easy to confuse with DAG workers (`src/agents/tools/sessions-send-tool.ts:31`; `src/agents/tools/sessions-list-tool.ts:21`; `src/agents/tools/sessions-history-tool.ts:16`).
- Repo-chat as a primary feature because the inventory marks it adjacent, unclear/partial in places, and not central to the SmithersBot goal product (`src/telegram/repo-chat-commands.ts:35`; `src/telegram/repo-chat-commands.ts:149`; `src/telegram/bot-handlers.ts:662`).
- Formal security or autonomy claims such as "safe sandbox," "self-improving AI engineer," "fully autonomous," "guaranteed recovery," or "parallel agent execution" until the concrete flows are verified (`src/goal/hard-deny.ts:150`; `src/goal/lessons.ts:581`; `src/goal/run-store.ts:131`; `src/goal/agent-executor.ts:333`).
- Internal jargon such as `ralph`, result-file paths, lock-file implementation details, and capability-bound filenames unless used in developer docs (`src/goal/agent-executor.ts:477`; `src/goal/goal-lock.ts:5`; `src/goal/cli-worker.ts:739`).

## What needs verification before public claims

- Run `node scripts/run-node.mjs goal new "<small coding task>" --plan-only` and confirm the CLI creates a persisted run, renders a structured plan, and does not execute without approval (`src/commands/goal.ts:90`; `src/commands/goal.ts:236`; `src/commands/goal.ts:286`).
- Run `node scripts/run-node.mjs goal new "<multi-step coding task>" --plan-only`, then inspect the run artifacts under the configured goals state directory and confirm DAG/dependency data is present and renderable (`src/goal/run-store.ts:65`; `src/goal/dag-render.ts:62`; `src/goal/mermaid-render.ts:15`).
- Run `node scripts/run-node.mjs goal detail <run_id>` and confirm the status/detail output includes the expected DAG or text fallback without relying on unavailable local rendering tooling (`src/commands/goal-detail.ts:177`; `src/goal/format-output.ts:1`; `src/goal/mermaid-render.ts:46`).
- Run an approved CLI goal through `node scripts/run-node.mjs goal resume <run_id>` and confirm a worker attempt writes prompt, stdout/stderr, result JSON, attempt bundle, working notes, and serialized run state (`src/commands/goal-resume.ts:587`; `src/goal/cli-worker.ts:294`; `src/goal/cli-worker.ts:819`; `src/goal/attempt-bundle.ts:137`; `src/goal/run-journal.ts:25`; `src/goal/run-store.ts:431`).
- Run a goal with a deliberately failing configured build-gate command and confirm failure classification, captured output, and targeted remediation guidance are stored and surfaced (`src/goal/build-gate.ts:58`; `src/goal/build-gate.ts:94`; `src/goal/build-gate.ts:115`).
- Run a goal with plan autocheck enabled and confirm rejected plans create revision artifacts under `<run>/autocheck`, while accepted plans proceed to approval (`src/goal/plan-autocheck.ts:445`; `src/goal/plan-autocheck.ts:776`; `src/goal/plan-autocheck.ts:819`).
- Run a fake-sensitive path or dangerous command through an appropriate worker/tool path and confirm hard-deny enforcement blocks it without touching sensitive files (`src/goal/hard-deny.ts:52`; `src/goal/capability-enforcement.ts:80`; `src/goal/capability-enforcement.ts:115`).
- Run a blocked-task flow and answer it through Telegram reply routing or the equivalent CLI flow, then confirm execution resumes against the same run (`src/telegram/goal-router.ts:205`; `src/commands/goal-resume.ts:456`; `src/goal/agent-executor.ts:1158`).
- Run a feedback revision flow and confirm completed work is preserved, new/revised work returns to pending, dangling dependencies are removed, and build-gate config is preserved (`src/goal/feedback.ts:46`; `src/goal/feedback.ts:90`; `src/telegram/goal-commands.ts:950`).
- Run an interrupted goal/resume demo and confirm stale in-progress steps are reconciled, the run is marked resumable, and `goal resume` continues from persisted state (`src/goal/run-store.ts:131`; `src/commands/goal-resume.ts:456`; `src/commands/goal-resume.ts:587`).
- Run a completed goal with lesson extraction enabled, then start a second goal in the same working directory and confirm relevant lessons are injected into the worker prompt (`src/goal/agent-executor.ts:1024`; `src/goal/lessons.ts:174`; `src/goal/cli-worker.ts:576`).
- Run the Telegram `/new_goal` approval/demo path in a real configured Telegram chat and confirm approval buttons, replies, status/detail, and final delivery route to the correct run (`src/telegram/goal-commands.ts:483`; `src/telegram/goal-sending.ts:115`; `src/telegram/goal-router.ts:173`; `src/telegram/bot-handlers.ts:589`).
