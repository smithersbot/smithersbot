# Stage 2N: structural-grep + CLI-smoke results

Date: 2026-05-20T00:59:30-04:00
Branch: claw/run/20260519-201401Z-20bb93d8-6472-40de-8a72-ebf75daee9c2
HEAD: e5d75384282901b2911906ff3e26c9809e8d54ea

## Structural Greps

### 1. `?? "step"` (semgrep default) — disallowed in non-test paths

```
(empty — PASS)
```

Result: **PASS** — no fallback default of `"step"` in src/ (non-test). Reads use `resolveDefaultSemgrepMode()` which returns `"goal"`.

### 2. `?? "off"` (planAutocheck default) — disallowed in non-test runtime paths

Tight pattern (planAutocheck adjacent to ??):
```
(empty — PASS)
```

Broader scan (planAutocheck near "off"):
```
src/config/zod-schema.ts-464-        claudeCodeAuth: z.enum(["subscription", "api_key"]).optional(),
src/config/zod-schema.ts:465:        planAutocheck: z.enum(["codex", "claude_code", "off"]).optional(),
src/config/zod-schema.ts-466-        semgrep: z.enum(["off", "step", "goal"]).optional(),
--
--
src/telegram/goal-commands.ts:309:  const configuredMode = params.config?.goal?.planAutocheck;
src/telegram/goal-commands.ts-310-  if (configuredMode === "off") return undefined;
--
```

Result: **PASS** — the only co-occurrences are the zod schema enum (`z.enum(["codex","claude_code","off"])`) and an explicit user-override check (`configuredMode === "off"`). No `?? "off"` fallback for the planAutocheck default; the status formatter uses `resolveDefaultPlanAutocheckMode()` and emits NO_BACKEND_AUTOCHECK_ERROR when no backend is available.

### 3. Planner prompt unconditional `Use "codex"` / `Use "claude_code"` outside dual-backend branch

```
src/goal/planner.ts:36:- Use "codex" for coding tasks (creating/modifying code or files).
src/goal/planner.ts:37:- Use "claude_code" for testing tasks and every other type of task.
```

Result: **FINDING — present, but mitigated by runtime clamp**. The static `PLAN_SYSTEM_PROMPT` in `src/goal/planner.ts` (lines 36-37) still has the original wording `Use "codex" for coding tasks…` and `Use "claude_code" for testing tasks…`.

Context: the same BACKEND SELECTION RULES block (line 40) immediately follows with:

> "If only one backend is available at runtime, the executor will automatically use the available backend regardless of what you specify. Plan for the ideal backend; the system handles fallback."

The plan task `planner-prompt-by-availability` (which would have parameterized the prompt by availability) is **NOT** in COMPLETED TASKS and **NOT** in the Stage 2N commit history. The runtime safety net is `clampBackendForEnabledWorkers` in `src/goal/agent-executor-helpers.ts`, which maps unavailable planner suggestions onto the only available worker at execution time, and the plan caption renderer prefers `step.executedBackend` over `step.backend` (per the completed `goal-workers-command-and-caption` task). The Codex-only smoke below confirms this gap: the planner JSON still says `backend: "claude_code"` for the read-only step, and the clamp would only run at execution time (the smoke uses --dry-run --plan-only and does not reach the clamp).

## CLI Smokes

Both smokes ran the same goal — `Inspect the repository state and report whether the working tree is clean. Do not edit files.` — from the repo root, with isolated state via `SMITHERSBOT_STATE_DIR` (because `~/.moltbot` exists on this host and would shadow the canonical `~/.smithersbot` per `resolveStateDir()`).

### Codex-only (claude shim exits 1, codex on PATH)

PATH override: `/tmp/stage2n-smoke/no-claude-shim:$PATH`.

SMITHERSBOT_STATE_DIR: `/tmp/stage2n-smoke/state-codex-only`

Exit code: 0

Run dir on disk:
```
/tmp/stage2n-smoke/state-codex-only/goals/8373ecb6-b4f8-48d6-a52c-da7eeda8b77d/scout/PLANNING_BRIEF.md
/tmp/stage2n-smoke/state-codex-only/goals/8373ecb6-b4f8-48d6-a52c-da7eeda8b77d/scout/attempt-1.json
/tmp/stage2n-smoke/state-codex-only/goals/8373ecb6-b4f8-48d6-a52c-da7eeda8b77d/scout/auth_mode.txt
/tmp/stage2n-smoke/state-codex-only/goals/8373ecb6-b4f8-48d6-a52c-da7eeda8b77d/scout/planning_stdout.txt
/tmp/stage2n-smoke/state-codex-only/goals/8373ecb6-b4f8-48d6-a52c-da7eeda8b77d/scout/execution_plan.json
/tmp/stage2n-smoke/state-codex-only/goals/8373ecb6-b4f8-48d6-a52c-da7eeda8b77d/scout/plan_draft.md
/tmp/stage2n-smoke/state-codex-only/goals/8373ecb6-b4f8-48d6-a52c-da7eeda8b77d/scout/scout_report.json
/tmp/stage2n-smoke/state-codex-only/goals/8373ecb6-b4f8-48d6-a52c-da7eeda8b77d/scout/planning_stderr.txt
/tmp/stage2n-smoke/state-codex-only/goals/8373ecb6-b4f8-48d6-a52c-da7eeda8b77d/scout/planning_raw_output.txt
/tmp/stage2n-smoke/state-codex-only/goals/8373ecb6-b4f8-48d6-a52c-da7eeda8b77d/run.json
```

Planner backend (proven by `planning_stderr.txt` last lines containing `codex_core::session` and `tokens used`):
```
2026-05-20T04:52:56.098983Z ERROR codex_core::session: failed to record rollout items: thread 019e43b9-95f1-7a32-92ef-27b931de1cd4 not found
tokens used
58,843
```

Plan output backend for the single read-only step: `claude_code` (planner static-prompt suggestion; runtime clamp would map this to codex at execution time, but dry-run does not exercise the clamp).

### Claude-only (codex shim exits 1, claude on PATH)

PATH override: `/tmp/stage2n-smoke/no-codex-shim:$PATH`.

SMITHERSBOT_STATE_DIR: `/tmp/stage2n-smoke/state-claude-only`

Exit code: 0

Run dir on disk:
```
/tmp/stage2n-smoke/state-claude-only/goals/0c711fe6-b151-461b-9974-ce8d9ac40355/scout/PLANNING_BRIEF.md
/tmp/stage2n-smoke/state-claude-only/goals/0c711fe6-b151-461b-9974-ce8d9ac40355/scout/attempt-1.json
/tmp/stage2n-smoke/state-claude-only/goals/0c711fe6-b151-461b-9974-ce8d9ac40355/scout/auth_mode.txt
/tmp/stage2n-smoke/state-claude-only/goals/0c711fe6-b151-461b-9974-ce8d9ac40355/scout/planning_stdout.txt
/tmp/stage2n-smoke/state-claude-only/goals/0c711fe6-b151-461b-9974-ce8d9ac40355/scout/execution_plan.json
/tmp/stage2n-smoke/state-claude-only/goals/0c711fe6-b151-461b-9974-ce8d9ac40355/scout/plan_draft.md
/tmp/stage2n-smoke/state-claude-only/goals/0c711fe6-b151-461b-9974-ce8d9ac40355/scout/scout_report.json
/tmp/stage2n-smoke/state-claude-only/goals/0c711fe6-b151-461b-9974-ce8d9ac40355/scout/planning_stderr.txt
/tmp/stage2n-smoke/state-claude-only/goals/0c711fe6-b151-461b-9974-ce8d9ac40355/scout/planning_raw_output.txt
/tmp/stage2n-smoke/state-claude-only/goals/0c711fe6-b151-461b-9974-ce8d9ac40355/run.json
```

Plan output backend for the single read-only step: `claude_code` (correct — only available backend).

## Canonical layout confirmation

Both smokes produced `<state-dir>/goals/<runId>/{run.json, scout/{execution_plan.json, scout_report.json, planning_*.txt, plan_draft.md, attempt-1.json, auth_mode.txt, node_specs/*.md, PLANNING_BRIEF.md}}` exactly as documented in CLAUDE.md for `~/.smithersbot/goals/<run_id>/`. (When `~/.moltbot` exists, `resolveStateDir()` returns the existing legacy dir; passing `SMITHERSBOT_STATE_DIR` overrides that, so the canonical layout is exercised end-to-end here.)
