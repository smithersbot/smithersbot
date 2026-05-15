# Prior Docs Audit

## Working-tree hits

Search scope: `docs/`, `docs.acp.md`, `RELEASE_AUDIT/`, `smithersbot_marketing/`, `openclaw-starter-kit/`, `skills/`, `templates/`, `CHANGELOG.md`, `README.md`.

Keywords searched explicitly: `moltbot-goal`, `SmithersBot`, `goal system`, `/new_goal`, `DAG`, `critical path`, `worker`, `sessions`, `repo chat`, `memory`, `learned rules`, `auto-learning`, `capability enforcement`, `orchestration`, `task graph`, `agent harness`.

Searched-area status:

| Area | Status |
|---|---|
| `docs/` | Hits for goal system, workers, sessions, memory, sandboxing, and command/control docs. |
| `docs.acp.md` | Hits for session mapping and gateway session bridging. |
| `RELEASE_AUDIT/` | Hits for SmithersBot identity, v0 scope, memory/session risk, and prior cleanup decisions. |
| `smithersbot_marketing/` | Hits for old SmithersBot-adjacent marketing material; not goal-system docs. |
| `openclaw-starter-kit/` | Hits for upstream/adjacent OpenClaw workstream, subagent, session, and learning docs. |
| `skills/` | Hits for session-log access, tmux sessions, and coding-agent background sessions; mostly generic skill docs. |
| `templates/` | One incidental keyword hit in `templates/scout_prompt_template.md`; no prior product/goal-system doc found. |
| `CHANGELOG.md` | SmithersBot fork-start hit. |
| `README.md` | Hits for inherited Moltbot positioning plus session tools, sandboxing, and broad platform claims. |

### `docs/goal-issues-analysis.md`

- Title/heading: `Goal System Issues Analysis`
- Summary: An internal audit of broken behaviors and implementation gaps in the `/new_goal` execution system, covering cancellation, planning recovery, crash recovery, locking, task retry, `/goal_list`, and capability issues. This is one of the highest-signal prior goal-system docs because it names concrete flaws and proposed fixes rather than marketing copy.
- Mine vs upstream: definitely mine. The doc is about `/new_goal`, `~/.moltbot/goals`, Telegram goal commands, and local goal executor internals, not upstream Moltbot’s general assistant surface.
- Relevance: high
- Key excerpts:
  - `docs/goal-issues-analysis.md:5`: "This document identifies and analyzes broken behaviors and implementation gaps in the `/new_goal` execution system."
  - `docs/goal-issues-analysis.md:16`: "No `/goal_stop` or `/goal_cancel` command exists"
  - `docs/goal-issues-analysis.md:47`: "### Issue #2: Cannot Resume from Planning Failures"
  - `docs/goal-issues-analysis.md:191`: "### Issue #6: /goal_list Blocking (False Alarm - No Technical Block)"
  - `docs/goal-issues-analysis.md:216`: "**No locking mechanism prevents concurrent reads during execution.**"

### `docs/goal-resume-from-failed-planning.md`

- Title/heading: `Goal Resume from Failed Planning - Implementation Summary`
- Summary: Describes the implemented `--replan` path for `moltbot goal resume`, including state transitions, scout-data reuse, JSON/quiet output modes, usage examples, and test coverage. This is strong evidence for a restart/recovery slice of the goal system.
- Mine vs upstream: definitely mine. It documents goal planning failure recovery and references files under `src/commands/goal-resume.ts` and the goal test suite.
- Relevance: high
- Key excerpts:
  - `docs/goal-resume-from-failed-planning.md:5`: "This document describes the implementation of the `--replan` flag for the `moltbot goal resume` command"
  - `docs/goal-resume-from-failed-planning.md:19`: "Added a `--replan` flag to `moltbot goal resume`"
  - `docs/goal-resume-from-failed-planning.md:21`: "Detects runs that failed during planning"
  - `docs/goal-resume-from-failed-planning.md:52`: "#### After (Fixed)"
  - `docs/goal-resume-from-failed-planning.md:86`: "Looks for `~/.moltbot/goals/<runId>/scout/report.json` and `plan.md`"

### `docs/goal-simplification-phase1.md`

- Title/heading: `Goal System Simplification - Phase 1: Make CLI Execution Reliable`
- Summary: A detailed design plan for making CLI workers reliable by replacing stdout parsing with worker result artifacts, using one process per task, changing liveness detection, adding attempt bundles, making scout async, and standardizing hard-deny behavior. It appears to capture product/architecture decisions that later workers may have implemented.
- Mine vs upstream: definitely mine. It is goal-worker-specific and refers to `src/goal/cli-worker.ts`, `worker_result.json`, scout artifacts, and capability enforcement in the local goal executor.
- Relevance: high
- Key excerpts:
  - `docs/goal-simplification-phase1.md:5`: "After this phase, CLI worker failures become understandable"
  - `docs/goal-simplification-phase1.md:9`: "Analysis of the last 10 goal runs (Feb 3-8 2026) shows a 12.5% success rate."
  - `docs/goal-simplification-phase1.md:30`: "Define a result file path convention: `<runDir>/workers/<stepId>/worker_result.json`"
  - `docs/goal-simplification-phase1.md:62`: "### 2. Single Process Per Task (Remove Cold-Start Turn Loop)"
  - `docs/goal-simplification-phase1.md:118`: "After each task attempt (both CLI and PI), write `<workerDir>/attempt-<N>.json`"
  - `docs/goal-simplification-phase1.md:145`: "### 5. Scout Becomes Async"

### `docs/goal-simplification-phase2.md`

- Title/heading: `Goal System Simplification - Phase 2: Simplify the Core Architecture`
- Summary: A follow-on architecture plan to split task runners, simplify capability machinery to hard-deny-only, and reduce state-machine complexity. It is useful product-definition source material because it states what the goal architecture is supposed to become and what complexity was considered harmful.
- Mine vs upstream: definitely mine. It references `src/goal/agent-executor.ts`, `TaskRunner`, `PiTaskRunner`, `CliTaskRunner`, and local capability modules.
- Relevance: high
- Key excerpts:
  - `docs/goal-simplification-phase2.md:5`: "Reduce code complexity and remove systemic flake sources"
  - `docs/goal-simplification-phase2.md:11`: "CLI workers write `worker_result.json` instead of the orchestrator parsing structured JSON from stdout"
  - `docs/goal-simplification-phase2.md:22`: "### 1. TaskRunner Interface"
  - `docs/goal-simplification-phase2.md:67`: "Runners never write to run state directly"
  - `docs/goal-simplification-phase2.md:107`: "### 2. Capabilities to Hard-Deny-Only"

### `docs/goal-list-blocking-investigation.md`

- Title/heading: `Investigation: /goal_list Blocking During Goal Execution`
- Summary: Investigation showing that `/goal_list` is not blocked by goal-system locks; the perceived delay comes from Telegram command processing and the Node event loop. It matters because it separates real goal-system product behavior from a false bug report.
- Mine vs upstream: definitely mine. The document is specific to the local `/goal_list` command, `src/goal/run-store.ts`, and Telegram goal command routing.
- Relevance: medium
- Key excerpts:
  - `docs/goal-list-blocking-investigation.md:5`: "`/goal_list` is **NOT** blocked by any locking mechanism"
  - `docs/goal-list-blocking-investigation.md:14`: "`src/goal/run-store.ts`: The `listRuns()` function performs"
  - `docs/goal-list-blocking-investigation.md:44`: "The perceived blocking is due to **Telegram's architecture**"

### `docs/goal-list-no-action-needed.md`

- Title/heading: `Task Report: /goal_list Blocking Investigation`
- Summary: A task report concluding that no code change was needed for `/goal_list` because no locking mechanism exists in the read path. This duplicates the investigation but is useful as evidence that task workers were producing structured audit reports.
- Mine vs upstream: definitely mine. It cites local goal command/test paths and a prior goal-system issue analysis.
- Relevance: medium
- Key excerpts:
  - `docs/goal-list-no-action-needed.md:7`: "**Task**: Fix the issue where `/goal_list` command is blocked during active goal execution."
  - `docs/goal-list-no-action-needed.md:13`: "The `/goal_list` command is **NOT blocked** by any locking mechanism"
  - `docs/goal-list-no-action-needed.md:41`: "The implementation: Uses synchronous filesystem reads"
  - `docs/goal-list-no-action-needed.md:95`: "Users perceive \"blocking\" due to **Telegram bot architecture**"

### `docs/task-fix-lock-during-list-summary.md`

- Title/heading: `Task Summary: fix-lock-during-list`
- Summary: Another report for the same `/goal_list` false premise, including examined files, atomic write behavior, and a note that test coverage had been created in a previous task. Useful mainly as a worker-output artifact.
- Mine vs upstream: definitely mine. It is task-worker authored and references local goal-system files and tests.
- Relevance: medium
- Key excerpts:
  - `docs/task-fix-lock-during-list-summary.md:5`: "Fix the issue where `/goal_list` command is blocked during active goal execution."
  - `docs/task-fix-lock-during-list-summary.md:11`: "**Status**: ✅ COMPLETE - No bug exists, task based on false premise"
  - `docs/task-fix-lock-during-list-summary.md:25`: "`src/commands/goal-list.ts` - Command handler"
  - `docs/task-fix-lock-during-list-summary.md:88`: "Created comprehensive test suite: `src/commands/goal-list-concurrent.test.ts`"

### `README.md`

- Title/heading: `Moltbot — Personal AI Assistant`
- Summary: Current README still presents a broad upstream-style Moltbot personal assistant story, including gateway, Telegram inbox, voice, canvas, tools, sessions, apps, and sandboxing. It is relevant mainly as negative evidence: the public story is not yet centered on SmithersBot’s goal/worker system.
- Mine vs upstream: modified/upstream mix. The README appears to carry inherited Moltbot platform positioning with some later edits; Stage 2A notes say it was rewritten for a Telegram-only v0, but the current file still foregrounds Moltbot.
- Relevance: medium
- Key excerpts:
  - `README.md:1`: `# 🦞 Moltbot — Personal AI Assistant`
  - `README.md:13`: "**Moltbot** is a *personal AI assistant* you run on your own devices."
  - `README.md:112`: "**[Local-first Gateway](https://docs.molt.bot/gateway)** — single control plane for sessions"
  - `README.md:230`: "## Agent to Agent (sessions_* tools)"
  - `README.md:233`: "`sessions_list` — discover active sessions"
  - `README.md:304`: "**Group/channel safety:** set `agents.defaults.sandbox.mode: \"non-main\"`"

### `docs/concepts/session-tool.md`

- Title/heading: `Session Tools`
- Summary: Defines `sessions_list`, `sessions_history`, `sessions_send`, and `sessions_spawn`, including cross-session messaging, reply-back ping-pong, spawn/announce behavior, and sandbox visibility. This is a public-facing description of agent-to-agent coordination, but not specifically the `/goal` DAG system.
- Mine vs upstream: modified or likely upstream-adjacent. It is part of the broader Moltbot gateway/session tool surface, but the detailed spawn/announce behavior may be local work; authorship needs git-history confirmation.
- Relevance: medium
- Key excerpts:
  - `docs/concepts/session-tool.md:9`: "Goal: small, hard-to-misuse tool set so agents can list sessions"
  - `docs/concepts/session-tool.md:12`: "`sessions_list`"
  - `docs/concepts/session-tool.md:68`: "## sessions_send"
  - `docs/concepts/session-tool.md:84`: "After the primary run completes, Moltbot runs a **reply-back loop**"
  - `docs/concepts/session-tool.md:126`: "## sessions_spawn"
  - `docs/concepts/session-tool.md:156`: "Sandboxed sessions can use session tools"

### `docs/cli/sessions.md`

- Title/heading: ``moltbot sessions``
- Summary: Minimal CLI reference for listing stored conversation sessions and recent activity. Relevant for session inventory, but not a goal-system source doc.
- Mine vs upstream: likely upstream or modified upstream. It describes the inherited Moltbot session listing CLI, not SmithersBot-specific orchestration.
- Relevance: low
- Key excerpts:
  - `docs/cli/sessions.md:2`: "CLI reference for `moltbot sessions`"
  - `docs/cli/sessions.md:9`: "List stored conversation sessions."
  - `docs/cli/sessions.md:12`: "moltbot sessions"

### `docs.acp.md`

- Title/heading: `Moltbot ACP Bridge`
- Summary: Documents an Agent Client Protocol bridge that maps ACP sessions to gateway sessions, supports listing sessions, translates prompts to gateway `chat.send`, and maps cancellation. It is not goal-system-specific, but it provides session orchestration evidence for IDE/gateway integration.
- Mine vs upstream: modified or likely mine. ACP bridge documentation appears to be a local integration doc rather than generic upstream marketing, but authorship needs git-history confirmation.
- Relevance: low
- Key excerpts:
  - `docs.acp.md:3`: "This document describes how the Moltbot ACP (Agent Client Protocol) bridge works"
  - `docs.acp.md:8`: "`moltbot acp` exposes an ACP agent over stdio"
  - `docs.acp.md:56`: "Each ACP session maps to a single Gateway session key."
  - `docs.acp.md:145`: "ACP `listSessions` maps to Gateway `sessions.list`"
  - `docs.acp.md:174`: "ACP sessions are stored in memory for the bridge process lifetime."

### `docs/concepts/memory.md`

- Title/heading: `Memory`
- Summary: Describes workspace Markdown memory, automatic memory flush before compaction, vector memory search, memory tools, and session indexing. It is relevant to the requested memory/learned-rules audit but appears to be a broader Moltbot feature rather than the goal DAG system.
- Mine vs upstream: modified or upstream-adjacent. Current docs use Moltbot naming and mention `.clawdbot` storage; Stage 2A inventory flagged this as a risk/investigate surface.
- Relevance: medium
- Key excerpts:
  - `docs/concepts/memory.md:9`: "Moltbot memory is **plain Markdown in the agent workspace**."
  - `docs/concepts/memory.md:37`: "## Automatic memory flush (pre-compaction ping)"
  - `docs/concepts/memory.md:78`: "Moltbot can build a small vector index"
  - `docs/concepts/memory.md:203`: "`memory_search` — returns snippets with file + line ranges."
  - `docs/concepts/memory.md:330`: "Session logs live on disk (`~/.clawdbot/agents/<agentId>/sessions/*.jsonl`)."

### `docs/cli/memory.md`

- Title/heading: ``moltbot memory``
- Summary: CLI reference for memory status, indexing, and search. It is useful evidence that memory is exposed as a command surface, but it does not define the SmithersBot goal-system product.
- Mine vs upstream: likely upstream or modified upstream. It describes the general memory plugin slot and CLI commands.
- Relevance: low
- Key excerpts:
  - `docs/cli/memory.md:8`: "# `moltbot memory`"
  - `docs/cli/memory.md:10`: "Manage semantic memory indexing and search."
  - `docs/cli/memory.md:11`: "Provided by the active memory plugin"
  - `docs/cli/memory.md:20`: "moltbot memory status"
  - `docs/cli/memory.md:26`: "moltbot memory search \"release checklist\""

### `docs/multi-agent-sandbox-tools.md`

- Title/heading: `Multi-Agent Sandbox & Tools Configuration`
- Summary: Describes per-agent sandboxing and per-agent tool restrictions, including per-agent auth stores, allow/deny policies, and Docker sandbox modes. This informs safety/sandbox positioning but is not specific to the goal/worker DAG layer.
- Mine vs upstream: modified or upstream-adjacent. It appears to document a general Moltbot multi-agent gateway capability, not the SmithersBot goal system.
- Relevance: medium
- Key excerpts:
  - `docs/multi-agent-sandbox-tools.md:12`: "Each agent in a multi-agent setup can now have its own"
  - `docs/multi-agent-sandbox-tools.md:13`: "**Sandbox configuration**"
  - `docs/multi-agent-sandbox-tools.md:14`: "**Tool restrictions**"
  - `docs/multi-agent-sandbox-tools.md:24`: "Auth is per-agent"
  - `docs/multi-agent-sandbox-tools.md:84`: "**Result:**"

### `RELEASE_AUDIT/STAGE2A_REPORT.md`

- Title/heading: `Stage 2A — GitHub Proof-Release Cleanup Report`
- Summary: Prior cleanup report that records SmithersBot fork identity work, README/docs edits, package identity, deferred items, and the decision to keep upstream credit in `NOTICE.md`. It is crucial context for separating upstream Moltbot from SmithersBot public positioning, though it is not a feature spec.
- Mine vs upstream: definitely mine. It is a local release audit report about SmithersBot proof-release cleanup.
- Relevance: high
- Key excerpts:
  - `RELEASE_AUDIT/STAGE2A_REPORT.md:26`: "`chore(identity): rewrite SmithersBot governance and add NOTICE.md`"
  - `RELEASE_AUDIT/STAGE2A_REPORT.md:111`: "`CHANGELOG.md` truncated to a single SmithersBot fork-start"
  - `RELEASE_AUDIT/STAGE2A_REPORT.md:113`: "**W3 — public-facing docs and links**"
  - `RELEASE_AUDIT/STAGE2A_REPORT.md:272`: "Peripheral directory deletion: `Swabble/`, `smithersbot_marketing/`, `openclaw-starter-kit/`."
  - `RELEASE_AUDIT/STAGE2A_REPORT.md:291`: "No upstream attribution leakage on the public reading path."

### `RELEASE_AUDIT/brand-references.md`

- Title/heading: `W1 Brand & Naming References`
- Summary: Static scan of brand tokens and public-surface recommendations, including evidence that SmithersBot references were concentrated in a deleted customer guide and test fixtures. It is relevant to product definition because it warns that the current README/branding is not a reliable source of truth.
- Mine vs upstream: definitely mine. It is a local audit artifact with release-scope recommendations.
- Relevance: high
- Key excerpts:
  - `RELEASE_AUDIT/brand-references.md:26`: "`Moltbot` and `moltbot` dominate the current product surface"
  - `RELEASE_AUDIT/brand-references.md:34`: "Rewrite public README for v0."
  - `RELEASE_AUDIT/brand-references.md:40`: "Customer-specific SmithersBot guide is not generic public Moltbot documentation."
  - `RELEASE_AUDIT/brand-references.md:68`: "Public README | Rewrite"
  - `RELEASE_AUDIT/brand-references.md:74`: "SmithersBot references | Cut or rewrite"

### `RELEASE_AUDIT/inventory-W3.jsonl`

- Title/heading: none; JSONL inventory
- Summary: Prior inventory rows identifying memory, SmithersBot marketing, source memory files, goal artifacts, and public-v0 actions. It is useful as structured audit input, not as public README source.
- Mine vs upstream: definitely mine. It is generated release-audit output specific to the SmithersBot cleanup.
- Relevance: medium
- Key excerpts:
  - `RELEASE_AUDIT/inventory-W3.jsonl:53`: "`smithersbot_marketing` ... Old-product branding (smithersbot)"
  - `RELEASE_AUDIT/inventory-W3.jsonl:62`: "`src/memory` ... Memory indexing/search source tree"
  - `RELEASE_AUDIT/inventory-W3.jsonl:63`: "`src/cli/memory-cli.ts` ... `moltbot memory status|index|search` CLI"
  - `RELEASE_AUDIT/inventory-W3.jsonl:78`: "`~/.moltbot/goals/<runId>/` ... External goal-run artifacts directory"

### `CHANGELOG.md`

- Title/heading: `SmithersBot — fork-start (2026-01-29)`
- Summary: Minimal fork-start changelog entry pointing to upstream Moltbot history via a specific commit. Useful for attribution and product-origin context; it contains no goal-system feature details.
- Mine vs upstream: definitely mine. It is the fork-start marker for SmithersBot.
- Relevance: medium
- Key excerpts:
  - `CHANGELOG.md:3`: "## SmithersBot — fork-start (2026-01-29)"
  - `CHANGELOG.md:5`: "Forked from moltbot/moltbot @ 4583f88626f20efedc454d893afaaf898c23523b."

### `smithersbot_marketing/one-pager.html`

- Title/heading: `Operational Bottleneck One-Pager`
- Summary: Old marketing one-pager for operational systems in manufacturing, not a SmithersBot goal-system README. It may explain older business positioning, but it should not be treated as product documentation for public v0.
- Mine vs upstream: definitely mine. It names Matthew Overing and appears as custom marketing collateral.
- Relevance: low
- Key excerpts:
  - `smithersbot_marketing/one-pager.html:6`: `<title>Operational Bottleneck One-Pager</title>`
  - `smithersbot_marketing/one-pager.html:13`: `<p class="header-name">Matthew Overing</p>`
  - `smithersbot_marketing/one-pager.html:18`: "Stop Being the Integration Layer in Your Own Company"
  - `smithersbot_marketing/one-pager.html:34`: "What I build"

### `openclaw-starter-kit/README.md`

- Title/heading: `OpenClaw Survival Guide`
- Summary: Adjacent upstream/OpenClaw starter material about running an autonomous OpenClaw setup, including watchdogs, cron, sessions, subagents, and known issues. It is useful contrast material for upstream/inherited features and for "what not to overclaim."
- Mine vs upstream: upstream/adjacent, not SmithersBot. The repo is explicitly OpenClaw-branded and appears intended as a separate starter kit.
- Relevance: medium
- Key excerpts:
  - `openclaw-starter-kit/README.md:1`: "# OpenClaw Survival Guide"
  - `openclaw-starter-kit/README.md:21`: "I've been running OpenClaw 24/7 for about two weeks now."
  - `openclaw-starter-kit/README.md:51`: "## The self-healing loop"
  - `openclaw-starter-kit/README.md:228`: "Sessions lose context after compaction."
  - `openclaw-starter-kit/README.md:229`: "**Subagents are unreliable.**"

### `openclaw-starter-kit/docs/WORKSTREAMS.md`

- Title/heading: `WORKSTREAMS.md — One Canonical Chat, Many Workstreams (SSOT)`
- Summary: OpenClaw guide for managing parallel work through one canonical chat and a single source-of-truth status file. It resembles a precursor pattern to SmithersBot's goal orchestration ideas but does not describe the implemented goal DAG system.
- Mine vs upstream: upstream/adjacent. It is OpenClaw starter kit material, not current SmithersBot implementation docs.
- Relevance: medium
- Key excerpts:
  - `openclaw-starter-kit/docs/WORKSTREAMS.md:1`: "One Canonical Chat, Many Workstreams"
  - `openclaw-starter-kit/docs/WORKSTREAMS.md:7`: "**One canonical chat** for decisions, approvals, and receipts."
  - `openclaw-starter-kit/docs/WORKSTREAMS.md:8`: "**One Single Source of Truth (SSOT)** for workstream status"
  - `openclaw-starter-kit/docs/WORKSTREAMS.md:77`: "**Supports parallel work:** multiple streams, one brain."

### `openclaw-starter-kit/docs/archive/SPRINT_SYSTEM.md`

- Title/heading: `The Sprint System (archived)`
- Summary: Archived OpenClaw doc about breaking large projects into AI-executable tasks, queuing them in a state file, monitoring subagent progress, and notifying on starts/completions. It looks like conceptual ancestry for SmithersBot task planning, but not direct product docs.
- Mine vs upstream: upstream/adjacent. It is archived OpenClaw starter kit content and uses OpenClaw/sprint terminology rather than SmithersBot goal commands.
- Relevance: medium
- Key excerpts:
  - `openclaw-starter-kit/docs/archive/SPRINT_SYSTEM.md:3`: "Sprints are how you break big projects into small, AI-executable tasks."
  - `openclaw-starter-kit/docs/archive/SPRINT_SYSTEM.md:62`: "## Queuing Sprints"
  - `openclaw-starter-kit/docs/archive/SPRINT_SYSTEM.md:105`: "**Check sub-agent progress** every few minutes"
  - `openclaw-starter-kit/docs/archive/SPRINT_SYSTEM.md:135`: "**AI writes sprint specs**"
  - `openclaw-starter-kit/docs/archive/SPRINT_SYSTEM.md:138`: "**AI executes** autonomously through heartbeats"

### `openclaw-starter-kit/docs/archive/META_LEARNING.md`

- Title/heading: `Meta-Learning Systems (archived)`
- Summary: Archived OpenClaw concept doc for auto-learning from mistakes, incident learning, self-review, and user pattern detection. It is relevant to the requested "auto-learning / learned rules" search, but it is explicitly archived and high-bloat.
- Mine vs upstream: upstream/adjacent. It is in the OpenClaw starter kit and recommends OpenClaw built-ins, not SmithersBot implementation.
- Relevance: low
- Key excerpts:
  - `openclaw-starter-kit/docs/archive/META_LEARNING.md:3`: "How your AI learns from mistakes, adapts to patterns, and gets smarter over time."
  - `openclaw-starter-kit/docs/archive/META_LEARNING.md:5`: "This design can be *high-bloat*"
  - `openclaw-starter-kit/docs/archive/META_LEARNING.md:15`: "tracks success rates, adapts strategy over time"
  - `openclaw-starter-kit/docs/archive/META_LEARNING.md:84`: "Scans memory files for patterns about the user"

### `skills/session-logs/SKILL.md`

- Title/heading: `session-logs`
- Summary: Skill doc for searching historical session JSONL files using `jq` and `rg`. Relevant for sessions/history access and audit archaeology, but it is a local skill instruction rather than a SmithersBot product doc.
- Mine vs upstream: modified or local skill. It is bundled in this repo and references Moltbot metadata, but the `.clawdbot` path suggests inherited naming remains.
- Relevance: low
- Key excerpts:
  - `skills/session-logs/SKILL.md:9`: "Search your complete conversation history stored in session JSONL files."
  - `skills/session-logs/SKILL.md:17`: "Session logs live at: `~/.clawdbot/agents/<agentId>/sessions/`"
  - `skills/session-logs/SKILL.md:19`: "**`sessions.json`** - Index mapping session keys to session IDs"
  - `skills/session-logs/SKILL.md:96`: "Sessions are append-only JSONL"

### `templates/scout_prompt_template.md`

- Title/heading: unverified; only an incidental keyword hit was inspected
- Summary: The only scoped keyword hit in `templates/` was an incidental "critical paths" risk-rating line, not a prior SmithersBot, goal-system, DAG, worker, session, or orchestration doc. No relevant prior doc found in `templates/`.
- Mine vs upstream: unverified. The hit is too incidental to classify.
- Relevance: low
- Key excerpts:
  - `templates/scout_prompt_template.md:93`: "Risk: 1 = safe isolated change, 3 = touches shared code, 5 = changes critical paths or public APIs"
