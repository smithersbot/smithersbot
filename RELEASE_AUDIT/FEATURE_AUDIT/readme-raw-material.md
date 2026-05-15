# README Raw Material

## Best old doc snippets worth preserving

- `git:f26ab617637795670978cbe465b4891fde27b969^:docs/customer-guide.md`: "This guide shows you how to use SmithersBot in Telegram."
- `git:f26ab617637795670978cbe465b4891fde27b969^:docs/customer-guide.md`: "Use the `/new_goal` command in your chat with the bot."
- `git:f26ab617637795670978cbe465b4891fde27b969^:docs/customer-guide.md`: "After you give your bot a `/new_goal` command it will create a plan for you to approve."
- `git:f26ab617637795670978cbe465b4891fde27b969^:docs/customer-guide.md`: "Once the goal plan is approved, it executes its tasks in its optimal time saving order."
- `git:f26ab617637795670978cbe465b4891fde27b969^:docs/customer-guide.md`: "If a task gets blocked, it will send you a message and continue to try and complete other tasks that aren't dependant on blocked tasks."
- `git:f26ab617637795670978cbe465b4891fde27b969^:docs/customer-guide.md`: "If you have a question you'd like to ask but you don't want to change anything use repo chat."
- `git:5913f848f59b57a8c76a376136f5dea866b56098:docs/customer-guide.md`: "Simple guide for customers using SmithersBot in Telegram"
- `git:5913f848f59b57a8c76a376136f5dea866b56098:docs/customer-guide.md`: "Tip: write tasks in plain language."
- `git:5913f848f59b57a8c76a376136f5dea866b56098:docs/setup-call-checklist.md`: "Customer knows `/new_goal` and `/goal_status`"
- `docs/goal-simplification-phase1.md:30`: "Define a result file path convention: `<runDir>/workers/<stepId>/worker_result.json`"
- `docs/goal-simplification-phase2.md:11`: "CLI workers write `worker_result.json` instead of the orchestrator parsing structured JSON from stdout"

## Accurate feature bullets

- Telegram and CLI goal creation: `/new_goal` and `goal new` create persisted goal runs, generate a plan, and hold for approval or plan-only review before execution (`src/telegram/goal-commands.ts:483`; `src/commands/goal.ts:90`; `src/commands/goal.ts:236`; `src/commands/goal.ts:286`).
- Structured planning contract: planner output is validated into steps, dependencies, backend assignments, success criteria, constraints, and build-gate metadata (`src/goal/planner.ts:14`; `src/goal/types.ts:57`; `src/goal/goal-schemas.ts:50`).
- Independent plan autocheck: a read-only reviewer can inspect a generated plan and trigger revision rounds before approval (`src/goal/plan-autocheck.ts:28`; `src/goal/plan-autocheck.ts:445`; `src/goal/plan-autocheck.ts:819`).
- DAG and critical-path scheduling: SmithersBot models goal work as a dependency graph and orders runnable tasks by critical-path-aware priority (`src/goal/dag-render.ts:1`; `src/goal/dag-render.ts:62`; `src/goal/cpm.ts:57`; `src/goal/agent-executor-helpers.ts:170`).
- Multi-backend worker orchestration: task runners normalize PI, Codex, and Claude Code style workers behind a common result contract (`src/goal/backend-types.ts:8`; `src/goal/backend-availability.ts:114`; `src/goal/task-runner.ts:5`; `src/goal/cli-runner.ts:40`; `src/goal/pi-runner.ts:101`).
- Auditable worker attempts: worker prompts, stdout/stderr, result JSON, repair logs, attempt bundles, and working journals are persisted for inspection and handoff (`src/goal/cli-worker.ts:294`; `src/goal/cli-worker.ts:819`; `src/goal/attempt-bundle.ts:17`; `src/goal/run-journal.ts:7`).
- Resume and recovery: goal state is stored under the goals state directory, stale in-progress runs can be reconciled, and `goal resume` continues from persisted state (`src/goal/run-store.ts:65`; `src/goal/run-store.ts:131`; `src/commands/goal-resume.ts:456`; `src/commands/goal-resume.ts:587`).
- Review and build gates: completed runs can go through read-only diff review and configured verification commands with captured output and failure classification (`src/goal/post-execution-review.ts:168`; `src/goal/post-execution-review.ts:206`; `src/goal/build-gate.ts:58`; `src/goal/build-gate.ts:115`).
- Goal-specific learned rules: completed runs can produce scoped lessons that are stored and injected into later worker prompts for the same workspace or global scope (`src/goal/lessons.ts:25`; `src/goal/lessons.ts:174`; `src/goal/agent-executor.ts:1024`; `src/goal/cli-worker.ts:576`).
- Explicit safety guardrails: hard-deny policies, capability enforcement, sandbox prompt contracts, and credential-like environment stripping reduce risky worker actions without claiming complete isolation (`src/goal/hard-deny.ts:52`; `src/goal/capability-enforcement.ts:80`; `src/goal/claude-code-env.ts:7`; `src/goal/cli-worker.ts:628`).

## Suggested README sections

1. SmithersBot
2. What SmithersBot Does
3. Quick Demo: Telegram Goal to Worker Results
4. Core Concepts: Goals, Plans, DAGs, Workers
5. Installation and Local Requirements
6. Configure Telegram
7. Create Your First Goal
8. Inspect Plans, Status, Artifacts, and Resume
9. Safety Guardrails and Limits
10. Learned Rules
11. What Is Not Public v0
12. Credit to Upstream Moltbot/OpenClaw
13. Development Status and Verification Checklist

## Claims that are safe to make now

- SmithersBot has Telegram and CLI goal entrypoints that create persisted goal runs and approval-gated plans (`src/telegram/goal-commands.ts:483`; `src/commands/goal.ts:90`; `src/commands/goal.ts:236`).
- SmithersBot stores goal plans and execution state in a dedicated goal run store (`src/goal/run-store.ts:65`; `src/goal/run-store.ts:431`).
- SmithersBot validates planner output against structured goal schemas (`src/goal/goal-schemas.ts:50`; `src/goal/planner.ts:377`; `src/goal/planner.ts:431`).
- SmithersBot represents planned work as a dependency graph and computes critical-path data (`src/goal/dag-render.ts:62`; `src/goal/cpm.ts:57`).
- SmithersBot has a common task-runner/result contract for PI and CLI worker backends (`src/goal/task-runner.ts:5`; `src/goal/task-runner.ts:21`; `src/goal/cli-runner.ts:40`; `src/goal/pi-runner.ts:101`).
- SmithersBot writes worker prompts, stdout/stderr, result files, and attempt bundles as run artifacts (`src/goal/cli-worker.ts:294`; `src/goal/cli-worker.ts:819`; `src/goal/attempt-bundle.ts:137`).
- SmithersBot has hard-deny rules for sensitive files, destructive commands, elevated privilege commands, publish/deploy/release commands, and gateway restarts (`src/goal/hard-deny.ts:7`; `src/goal/hard-deny.ts:52`; `src/goal/capability-types.ts:3`).
- SmithersBot can store goal-specific lessons and inject scoped learned rules into worker prompts (`src/goal/lessons.ts:25`; `src/goal/lessons.ts:174`; `src/goal/cli-worker.ts:576`).
- SmithersBot has post-execution review and command-based build-gate code paths (`src/goal/post-execution-review.ts:206`; `src/goal/build-gate.ts:58`).

## Claims that require a demo or test first

- End-to-end CLI goal flow works: run `node scripts/run-node.mjs goal new "<small coding task>" --plan-only` and confirm a persisted run, rendered structured plan, and no execution without approval (`src/commands/goal.ts:90`; `src/commands/goal.ts:236`; `src/commands/goal.ts:286`).
- DAG display works cleanly in the current environment: run `node scripts/run-node.mjs goal detail <run_id>` after creating a multi-step plan and confirm DAG or text fallback renders correctly (`src/commands/goal-detail.ts:177`; `src/goal/format-output.ts:1`; `src/goal/mermaid-render.ts:46`).
- Approved worker execution writes the full artifact set: run `node scripts/run-node.mjs goal resume <run_id>` on an approved goal and inspect prompt, stdout/stderr, `worker_result.json`, attempt bundle, working notes, and `run.json` (`src/commands/goal-resume.ts:587`; `src/goal/cli-worker.ts:294`; `src/goal/cli-worker.ts:819`; `src/goal/attempt-bundle.ts:137`; `src/goal/run-journal.ts:25`; `src/goal/run-store.ts:431`).
- Plan autocheck visibly revises or accepts a plan: run a goal with plan autocheck enabled and confirm `<run>/autocheck` artifacts and approval behavior (`src/goal/plan-autocheck.ts:445`; `src/goal/plan-autocheck.ts:776`; `src/goal/plan-autocheck.ts:819`).
- Build-gate failure handling is demoable: run a goal with a deliberately failing configured build-gate command and confirm failure classification, captured output, and targeted remediation guidance (`src/goal/build-gate.ts:58`; `src/goal/build-gate.ts:94`; `src/goal/build-gate.ts:115`).
- Guardrail denial is demoable without touching sensitive files: run a fake-sensitive path or dangerous command through an appropriate worker/tool path and confirm denial (`src/goal/hard-deny.ts:52`; `src/goal/capability-enforcement.ts:80`; `src/goal/capability-enforcement.ts:115`).
- Blocked-task resume works end to end: run a blocked-task flow, answer through Telegram reply routing or equivalent CLI path, and confirm execution resumes against the same run (`src/telegram/goal-router.ts:205`; `src/commands/goal-resume.ts:456`; `src/goal/agent-executor.ts:1158`).
- Feedback revision preserves completed work: run a feedback revision flow and confirm completed work stays complete, revised work returns to pending, dangling dependencies are removed, and build-gate config remains (`src/goal/feedback.ts:46`; `src/goal/feedback.ts:90`; `src/telegram/goal-commands.ts:950`).
- Crash/restart recovery is robust enough for public copy: interrupt an executing goal, run `node scripts/run-node.mjs goal resume <run_id>`, and confirm stale steps are reconciled and execution continues (`src/goal/run-store.ts:131`; `src/commands/goal-resume.ts:456`; `src/commands/goal-resume.ts:587`).
- Learned rules improve a later run: complete a goal with lesson extraction enabled, start a second goal in the same working directory, and confirm relevant lessons are injected into the worker prompt (`src/goal/agent-executor.ts:1024`; `src/goal/lessons.ts:174`; `src/goal/cli-worker.ts:576`).
- Telegram v0 UX is ready for screenshots: run `/new_goal` in a real configured Telegram chat and confirm approval buttons, reply routing, status/detail, blocked-question handling, and final delivery (`src/telegram/goal-commands.ts:483`; `src/telegram/goal-sending.ts:115`; `src/telegram/goal-router.ts:173`; `src/telegram/bot-handlers.ts:589`).

## Forbidden / unsafe claims

- Do not claim SmithersBot is primarily a broad Moltbot personal assistant, multi-channel gateway, mobile app, WebChat, or plugin platform; those surfaces are inherited, internal, out of v0, or not the SmithersBot story (`RELEASE_AUDIT/FEATURE_AUDIT/upstream-vs-smithersbot.md`; `RELEASE_AUDIT/keep-vs-cut.md`).
- Do not claim complete autonomy or guaranteed correctness; review, build gates, and lessons exist, but runtime behavior still needs demos and human/operator approval remains central (`src/goal/post-execution-review.ts:206`; `src/goal/build-gate.ts:58`; `src/goal/lessons.ts:581`).
- Do not claim formal sandboxing or security isolation; evidence supports explicit hard-deny guardrails, path/command checks, prompt constraints, and credential stripping, not a complete isolation boundary (`src/goal/hard-deny.ts:150`; `src/goal/capability-enforcement.ts:110`; `src/goal/cli-worker.ts:802`).
- Do not claim verified parallel execution; evidence supports DAG modeling and critical-path-aware task ordering, while execution demos were not run in this audit (`src/goal/cpm.ts:57`; `src/goal/agent-executor.ts:333`; `src/goal/agent-executor-helpers.ts:170`).
- Do not headline `sessions_send`, `sessions_list`, or `sessions_history`; they are classified as inherited/shared infrastructure and should be omitted from v0 public positioning (`src/agents/tools/sessions-send-tool.ts:31`; `src/agents/tools/sessions-list-tool.ts:21`; `src/agents/tools/sessions-history-tool.ts:16`).
- Do not headline repo chat; it is adjacent, partly unclear/partial, and risks diluting the goal-system positioning (`src/telegram/repo-chat-commands.ts:35`; `src/telegram/repo-chat-commands.ts:149`; `src/telegram/bot-handlers.ts:662`).
- Do not promise Mermaid PNG screenshots/rendering works everywhere until `goal detail` and Telegram detail rendering are verified in a clean environment (`src/goal/mermaid-render.ts:1`; `src/telegram/goal-sending.ts:37`; `src/commands/goal-detail.ts:177`).
- Do not use internal jargon such as `ralph`, capability-bound file names, worker result paths, or lock-file mechanics in public-facing README copy unless moved to developer documentation (`src/goal/agent-executor.ts:477`; `src/goal/goal-lock.ts:5`; `src/goal/cli-worker.ts:739`).
