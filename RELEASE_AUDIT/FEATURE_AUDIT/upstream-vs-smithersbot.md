# Upstream vs SmithersBot

Inputs checked:
- `RELEASE_AUDIT/FEATURE_AUDIT/prior-docs.md` exists and is non-empty.
- `RELEASE_AUDIT/FEATURE_AUDIT/feature-inventory.md` exists and is non-empty.
- Validation references: `RELEASE_AUDIT/STAGE2A_REPORT.md` and `RELEASE_AUDIT/keep-vs-cut.md`.

Classification rule: a feature is treated as SmithersBot-added only when `feature-inventory.md` marks it `likely mine` or `definitely mine`. Rows marked `modified` are treated as inherited or shared infrastructure unless the public disposition is limited to the SmithersBot-specific goal use.

## Upstream Moltbot Features Inherited

| feature | classification | evidence file(s) | public README disposition | one-line rationale |
| --- | --- | --- | --- | --- |
| `sessions_list` agent tool | upstream/shared inherited | `src/agents/tools/sessions-list-tool.ts:21`; `src/agents/tools/sessions-list-tool.ts:82` | omit | Inventory marks this `modified` and `omit`; it is gateway/session plumbing rather than the SmithersBot goal product. |
| `sessions_history` agent tool | upstream/shared inherited | `src/agents/tools/sessions-history-tool.ts:16`; `src/agents/tools/sessions-history-tool.ts:77` | omit | Inventory marks this `modified` and useful, but not clearly SmithersBot-added public functionality. |
| `sessions_send` agent tool | upstream/shared inherited | `src/agents/tools/sessions-send-tool.ts:31`; `src/agents/tools/sessions-send-tool.ts:185` | omit | Cross-session messaging can be confused with DAG workers; inventory explicitly says to avoid v0 public claims. |
| Session tool policy and sandbox exposure | upstream/shared inherited | `src/agents/tool-policy.ts:21`; `src/agents/sandbox/constants.ts:15` | omit | Inventory marks this `modified` infrastructure, not part of the public SmithersBot story. |
| Generic CLI progress infrastructure | upstream/shared inherited | `src/cli/progress.ts:1`; `src/goal/format-output.ts:1` | mention only through goals | Inventory marks progress output `modified`; the public value is goal status formatting, not the generic spinner/progress layer. |

## SmithersBot Features I Added

| feature | classification | evidence file(s) | public README disposition | one-line rationale |
| --- | --- | --- | --- | --- |
| Telegram `/new_goal` planning flow | SmithersBot-added | `src/telegram/goal-commands.ts:483`; `src/commands/goal.ts:90` | core | This is the primary user entrypoint: authenticated Telegram/CLI goal creation, planning, autocheck option, and approval before execution. |
| CLI goal persistence and approval gate | SmithersBot-added | `src/commands/goal.ts:102`; `src/commands/goal.ts:236`; `src/commands/goal.ts:286` | core | The CLI mirrors the goal workflow by persisting a run, rendering a plan, and stopping for approval or plan-only use. |
| Structured planner contract | SmithersBot-added | `src/goal/planner.ts:14`; `src/goal/types.ts:57`; `src/goal/goal-schemas.ts:50` | core | Planner output is constrained into typed plans with steps, dependencies, backends, success criteria, and constraints. |
| Unified CLI planner with scout artifacts | SmithersBot-added | `src/goal/cli-planner.ts:36`; `src/goal/cli-planner.ts:574`; `src/goal/cli-planner.ts:819` | core | The planner can use local agent CLIs, save planning/scout artifacts, validate the result, and persist a canonical plan. |
| Plan autocheck reviewer loop | SmithersBot-added | `src/goal/plan-autocheck.ts:28`; `src/goal/plan-autocheck.ts:445`; `src/goal/plan-autocheck.ts:819` | core | Generated plans can be reviewed by a separate read-only pass and revised before approval. |
| DAG construction and rendering model | SmithersBot-added | `src/goal/dag-render.ts:1`; `src/goal/dag-render.ts:62`; `src/goal/types.ts:104` | core | SmithersBot represents planned work as a dependency graph rather than a flat checklist. |
| Critical-path computation | SmithersBot-added | `src/goal/cpm.ts:1`; `src/goal/cpm.ts:57`; `src/goal/agent-executor.ts:248` | core | Task scheduling uses critical-path data, but README wording should avoid unverified parallel-execution claims. |
| Critical-path-first task assignment | SmithersBot-added | `src/goal/agent-executor.ts:333`; `src/goal/agent-executor-helpers.ts:170`; `src/goal/agent-executor-helpers.ts:186` | core | Runnable tasks are selected using dependency readiness and critical-path priority. |
| Backend probing and availability gating | SmithersBot-added | `src/goal/backend-types.ts:8`; `src/goal/backend-availability.ts:114`; `src/goal/agent-executor.ts:359` | core | SmithersBot can route work across local PI, Codex, and Claude Code backends while blocking unavailable workers. |
| Configurable backend routing and fallback | SmithersBot-added | `src/goal/agent-executor-helpers.ts:9`; `src/goal/agent-executor.ts:273`; `src/goal/agent-executor.ts:374` | core | Planned or configured backends are resolved per task, with fallback behavior when enabled tools differ from the plan. |
| Per-task orchestration loop | SmithersBot-added | `src/goal/agent-executor.ts:309`; `src/goal/agent-executor.ts:430`; `src/goal/agent-executor.ts:684` | core | The executor advances task state, retries eligible outcomes, records results, and journals success or failure. |
| TaskRunner abstraction for PI and CLI workers | SmithersBot-added | `src/goal/task-runner.ts:5`; `src/goal/cli-runner.ts:40`; `src/goal/pi-runner.ts:101` | core | A shared result contract lets different worker backends report complete, blocked, failed, or strategy-change outcomes uniformly. |
| CLI worker prompt and JSON result protocol | SmithersBot-added | `src/goal/cli-worker.ts:576`; `src/goal/cli-worker.ts:782`; `src/goal/cli-worker.ts:809` | core | Worker prompts include constraints, prior context, lessons, hard-denies, and an explicit result-file protocol. |
| Atomic goal run store | SmithersBot-added | `src/goal/run-store.ts:15`; `src/goal/run-store.ts:65`; `src/goal/run-store.ts:431` | core | Goal state is persisted under the state directory with atomic private writes and serialized plans/results/metadata. |
| Working journals and attempt context | SmithersBot-added | `src/goal/run-journal.ts:7`; `src/goal/run-journal.ts:46`; `src/goal/agent-executor.ts:685` | core | Runs and tasks leave working notes that make retries and handoffs inspectable. |
| Crash reconciliation and explicit resume | SmithersBot-added | `src/goal/run-store.ts:131`; `src/commands/goal-resume.ts:456`; `src/commands/goal-resume.ts:587` | core | The system can detect stale runs, reset interrupted steps, and resume, though robust claims need an interrupted-run demo. |
| Read-only post-execution diff review | SmithersBot-added | `src/goal/post-execution-review.ts:168`; `src/goal/post-execution-review.ts:206`; `src/goal/post-execution-review.ts:263` | core | Completed work can be reviewed against the final diff and success criteria before being accepted. |
| Command-based build gate | SmithersBot-added | `src/goal/build-gate.ts:3`; `src/goal/build-gate.ts:58`; `src/goal/build-gate.ts:115` | core | Plans can carry verification commands that run sequentially with timeouts and failure classification. |
| Default changed-file Semgrep SAST gate | SmithersBot-added | `src/goal/build-gate.ts:129`; `src/goal/build-gate.ts:144`; `src/goal/build-gate.ts:192` | mention | Security scanning is useful, but optional and PATH/network-sensitive, so it should not be a primary public claim. |
| Telegram goal control loop | SmithersBot-added | `src/telegram/goal-commands.ts:392`; `src/telegram/bot-handlers.ts:546`; `src/telegram/bot-handlers.ts:589` | core | Telegram is the v0 control surface for approving, resuming, answering, and receiving goal progress. |
| Reply-based goal routing | SmithersBot-added | `src/telegram/goal-router.ts:3`; `src/telegram/goal-router.ts:205`; `src/telegram/bot-handlers.ts:512` | core | Replies to plan, edit, blocked-question, and feedback messages route deterministically back to the correct run. |
| Telegram goal buttons and reactions | SmithersBot-added | `src/telegram/goal-sending.ts:115`; `src/telegram/bot-handlers.ts:773`; `src/telegram/goal-commands.ts:1482` | mention | Useful demo UX, but the README should emphasize the orchestration loop rather than every Telegram control. |
| Persistent goal lessons | SmithersBot-added | `src/goal/lessons.ts:25`; `src/goal/lessons.ts:104`; `src/goal/lessons.ts:155` | core | SmithersBot has a goal-specific lesson store separate from broader Moltbot memory. |
| Scoped learned rules injected into workers | SmithersBot-added | `src/goal/lessons.ts:174`; `src/goal/cli-runner.ts:52`; `src/goal/cli-worker.ts:576` | core | Lessons from prior runs are filtered by workspace/global scope and injected into worker context. |
| Automatic lesson extraction | SmithersBot-added | `src/goal/agent-executor.ts:1024`; `src/goal/lessons.ts:581`; `src/goal/lessons.ts:627` | core | Completed runs can produce reusable lessons, but public copy should avoid broad autonomous self-improvement claims. |
| Manual feedback revision loop | SmithersBot-added | `src/goal/feedback.ts:46`; `src/goal/feedback.ts:90`; `src/telegram/goal-commands.ts:950` | core | Operator feedback can revise remaining work while preserving completed work and build-gate configuration. |
| Hard-deny policy model | SmithersBot-added | `src/goal/capability-types.ts:3`; `src/goal/hard-deny.ts:7`; `src/goal/hard-deny.ts:52` | core | The goal system has explicit path and command deny rules for sensitive paths, credentials, deploys, publishing, and restarts. |
| Capability enforcement wrapper | SmithersBot-added | `src/goal/capability-enforcement.ts:44`; `src/goal/capability-enforcement.ts:80`; `src/goal/capability-enforcement.ts:115` | core | PI tool calls are checked against hard-deny rules before command or file operations proceed. |
| CLI worker sandbox and credential stripping | SmithersBot-added | `src/goal/claude-code-env.ts:7`; `src/goal/cli-worker.ts:628`; `src/goal/cli-worker.ts:802` | core | External workers are launched with workspace-write/sandbox prompt constraints and broad credential-like env vars stripped. |
| Worker result and log artifacts | SmithersBot-added | `src/goal/cli-worker.ts:64`; `src/goal/cli-worker.ts:294`; `src/goal/cli-worker.ts:819` | core | Worker prompts, stdout/stderr, repairs, and result files are persisted for auditability. |
| Attempt bundles | SmithersBot-added | `src/goal/attempt-bundle.ts:17`; `src/goal/attempt-bundle.ts:69`; `src/goal/attempt-bundle.ts:137` | core | Each attempt can capture backend, outcome, error class, diff/log snippets, duration, and build-gate metadata. |

## Features Present But Excluded From Public v0

| feature | classification | evidence file(s) | public README disposition | one-line rationale |
| --- | --- | --- | --- | --- |
| Legacy/direct LLM planner parser | SmithersBot-added but excluded from v0 story | `src/goal/planner.ts:157`; `src/goal/planner.ts:377`; `src/goal/planner.ts:454` | omit | Inventory marks it partial and says the main flow appears to be `runCliPlanning`; keep it out of public positioning unless verified. |
| PI-agent goal tool signals | SmithersBot-added but not standalone | `src/goal/goal-tools.ts:43`; `src/goal/goal-tools.ts:100`; `src/goal/goal-tools.ts:162` | omit | This is a worker implementation detail, better folded into the worker-orchestration claim. |
| Telegram-configurable plan autocheck command | SmithersBot-added admin surface | `src/telegram/goal-commands.ts:103`; `src/telegram/goal-commands.ts:2035`; `src/telegram/goal-commands.ts:2081` | omit | The public claim should be plan autocheck, not the operator command used to configure it. |
| Mermaid/PNG rendering as a standalone promise | SmithersBot-added but demo-gated | `src/goal/mermaid-render.ts:1`; `src/telegram/goal-sending.ts:37`; `src/commands/goal-detail.ts:177` | mention after verification | Inventory warns image rendering may depend on local rendering tooling; avoid screenshot/PNG promises before a clean demo. |
| Telegram repo-chat command surface | SmithersBot-added adjacent feature | `src/telegram/repo-chat-commands.ts:35`; `src/telegram/repo-chat-commands.ts:401`; `src/telegram/repo-chat-commands.ts:475` | omit from v0 README | Repo chat is adjacent to goals and inventory marks maturity unclear, so it should not define public v0. |
| Telegram repo-chat threaded sessions | SmithersBot-added adjacent feature | `src/telegram/repo-chat-commands.ts:149`; `src/telegram/repo-chat-commands.ts:300`; `src/telegram/bot-handlers.ts:662` | omit from v0 README | Static evidence exists, but the feature is partial and risks diluting the goal-system positioning. |
| Telegram free-text repo chat mode | SmithersBot-added adjacent feature | `src/telegram/bot-handlers.ts:222`; `src/telegram/bot-handlers.ts:478`; `src/telegram/bot-handlers.repo-chat-routing.test.ts:43` | omit | Inventory already marks it `omit`; it can blur the goal-orchestration story. |
| Robust review-output parsing | SmithersBot-added implementation detail | `src/goal/post-execution-review.ts:29`; `src/goal/post-execution-review.ts:82`; `src/goal/post-execution-review.ts:140` | omit | Useful reliability plumbing, but not a separate product feature. |
| Lesson extraction prompt guardrails | SmithersBot-added implementation detail | `src/goal/lessons.ts:545`; `src/goal/lessons.ts:561`; `src/goal/lessons.ts:575` | omit | Good internal quality control; too detailed for public v0 and vulnerable to overclaiming self-improvement. |
| Telegram `/goal_lessons` management | SmithersBot-added admin surface | `src/telegram/goal-commands.ts:130`; `src/telegram/goal-commands.ts:2719`; `src/telegram/goal-formatting.ts:332` | omit | Operator/admin command; mention learned rules only at the product level. |
| Symlink-aware sensitive path blocking | SmithersBot-added guardrail detail | `src/goal/capability-enforcement.ts:110`; `src/goal/capability-enforcement.ts:138`; `src/goal/hard-deny.ts:121` | omit | Important implementation detail, but the README should not imply formal security proof. |
| Token-aware recursive command-deny scanner | SmithersBot-added guardrail detail | `src/goal/hard-deny.ts:150`; `src/goal/hard-deny.ts:568`; `src/goal/hard-deny.ts:1302` | omit | Technically interesting but heuristic; avoid marketing it as a complete shell parser or sandbox. |
| Pi runner session artifacts | SmithersBot-added but partial | `src/goal/pi-runner.ts:101`; `src/goal/pi-runner.ts:462`; `src/goal/pi-runner.ts:474` | omit | Inventory marks this partial and not fully traced/executed; avoid public claims until verified. |

## Useful-Internal-Only Features

| feature | classification | evidence file(s) | public README disposition | one-line rationale |
| --- | --- | --- | --- | --- |
| Run-message persistence for Telegram routing | SmithersBot-added internal support | `src/telegram/goal-sending.ts:188`; `src/telegram/goal-sending.ts:236`; `src/telegram/goal-router.ts:120` | omit | Critical to reply routing, but too implementation-specific for public README copy. |
| Telegram deterministic local intents | SmithersBot-added UX helper | `src/telegram/bot-handlers.ts:53`; `src/telegram/bot-handlers.ts:83`; `src/telegram/bot-handlers.ts:103` | omit | Useful operator convenience, not a standalone product promise. |
| Telegram text fragmentation handling | SmithersBot-added transport helper | `src/telegram/bot-handlers.ts:252`; `src/telegram/bot-handlers.ts:705`; `src/telegram/command-fragments.test.ts:478` | omit | Operational reliability feature for long messages; not core public positioning. |
| File-based planning/run locks | SmithersBot-added internal coordination | `src/goal/goal-lock.ts:5`; `src/goal/goal-lock.ts:97`; `src/telegram/goal-commands.ts:1435` | mention only as reliability | Local filesystem locks are useful internals; avoid implying distributed concurrency control. |
| Capability-bounds artifact | SmithersBot-added internal audit artifact | `src/goal/cli-worker.ts:174`; `src/goal/cli-worker.ts:739`; `src/goal/cli-worker.test.ts:1005` | omit | Useful for debugging/audit trails, but too low-level for the README. |
| Working journals for continuity | SmithersBot-added internal artifact | `src/goal/run-store.ts:492`; `src/goal/run-journal.ts:25`; `src/goal/pi-runner.ts:464` | mention only under artifacts | Keep the public claim to auditable run artifacts; do not expose internal terminology like `ralph`. |

## Validation Against Stage 2A Signals

| signal | agreement/disagreement | trusted signal |
| --- | --- | --- |
| `RELEASE_AUDIT/STAGE2A_REPORT.md` says W3 rewrote public docs for a Telegram-only v0. | Partial disagreement: the feature inventory shows Telegram is the v0 control surface, but the product center is the goal/worker/DAG system, not Telegram alone. | Trusted `feature-inventory.md` for product definition, while keeping Stage 2A's Telegram-only public-surface constraint. |
| `RELEASE_AUDIT/keep-vs-cut.md` keeps Telegram and shared goal/runtime code in scope. | Agreement: the SmithersBot-added rows above are concentrated in `src/goal`, `src/commands/goal*.ts`, and `src/telegram/goal*.ts`. | Trusted both signals. |
| `RELEASE_AUDIT/keep-vs-cut.md` marks non-Telegram channels, mobile/mac apps, skills, WebChat clients, and broad plugin surfaces out/internal/investigate. | Agreement: none of those surfaces are used as public README positioning here. | Trusted `keep-vs-cut.md` for public exposure. |
| `RELEASE_AUDIT/keep-vs-cut.md` treats memory surfaces as investigate, while `feature-inventory.md` marks goal lessons as core. | Apparent disagreement resolved by scope: broad Moltbot workspace/vector memory remains investigate, but goal-specific lessons are SmithersBot-added and evidence-backed. | Trusted `feature-inventory.md` for `src/goal/lessons.ts` goal lessons; trusted `keep-vs-cut.md` for omitting broader memory plugins/docs. |
| Prior docs in `prior-docs.md` identify goal issues, simplification plans, and deleted SmithersBot customer-guide/setup-call docs as high-signal. | Agreement: those docs support the conclusion that older public copy should be mined for goal-system language, not broad upstream Moltbot platform claims. | Trusted `prior-docs.md` for historical context, but did not add features unless present in `feature-inventory.md`. |
