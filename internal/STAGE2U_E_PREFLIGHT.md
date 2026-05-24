# Stage 2U-E Preflight And Target Confirmation

Date: 2026-05-24

This is a narrow preflight for Stage 2U-E. It uses the Stage 2U-C audit outputs as source material and does not redo the full audit.

## Repository State

- HEAD: `8749c0ca887d89c5a2ffab230ba82dfa20c8e982`
- Branch: `claw/run/20260524-034653Z-23612172-c183-4eb2-912b-06219a8202f9`
- Filename-only git status at preflight:
  - `M .env.local`
  - `M .env.production`
  - `M .env.test`

The `.env*` files above were recorded by filename only and were not read. This preflight task will not modify them.

## Active Goals And Runs

Active-run state was checked only from the sanitized agent-visible mirror under:

`/home/matt/smithersbot-goals/agent/history/`

The runtime `~/.smithersbot/goals` store was not read.

Sanitized mirror findings:

- The current Stage 2U-E goal directory exists at `agent/history/goals/smithersbot/23612172-c183-4eb2-912b-06219a8202f9/` with `events.jsonl`; no terminal `summary.json` was present at preflight time.
- Sanitized `summary.json` entries with resume/display/status wording are terminal (`done`, `blocked`, or `cancelled`) in the mirror. The specific resume/display-fix goal is `2b69ce0d-6258-47ff-bba0-915d7001e5c7`, status `done`, title `Fix answered user-input resume normalization and blocked-step label formatting`.
- The broader launch-cleanup goal that removed LLM review, removed `/usage_history`, disabled `pi`, and fixed resume/status rendering is `0293264c-bd91-461f-a0bc-112df52ceedb`, status `done`.

Resume/display fix active state: not active. It is terminal `done` in the sanitized mirror, so there is no active-goal overlap to avoid for Stage 2U-E source edits.

Resume/display fix disjointness: even if treated conservatively, the Stage 2U-E target edit set below is disjoint from the known resume/display-fix report scope, which centered on resume/display normalization and blocked-label formatting. The report says it changed no sandbox policy, backend fallback logic, token architecture, post-exec review removal, `/usage_status`, or `pi` behavior (`internal/STAGE2U_C_RESUME_USER_INPUT_DISPLAY_FIX_REPORT.md:256-262`).

## Stage 2U-C Source Material Used

- `internal/STAGE2U_C_AGENT_SURFACE_SECURITY_TOKEN_PROMPT_AUDIT.md`
- `internal/STAGE2U_C_AGENT_SURFACE_AUDIT.json`
- `internal/STAGE2U_C_AGENT_FLOW_MAP.md`
- `internal/STAGE2U_C_AGENT_FLOW_MAP.json`
- `internal/STAGE2U_C_LAUNCH_CLEANUP_REVIEW_USAGE_HISTORY_PI_STATUS_REPORT.md`
- `internal/STAGE2U_C_RESUME_USER_INPUT_DISPLAY_FIX_REPORT.md`

Relevant 2U-C findings carried forward:

- Remaining credential-stripped native-sandbox opt-out surfaces were scout/planner, plan-autocheck, post-execution-review, manual-tests, and lessons; these were identified as 2U-E hardening targets, not current security blockers (`internal/STAGE2U_C_AGENT_SURFACE_SECURITY_TOKEN_PROMPT_AUDIT.md:241-244`).
- Static-vs-dynamic prompt ordering for cache efficiency was explicitly deferred to 2U-E (`internal/STAGE2U_C_AGENT_SURFACE_SECURITY_TOKEN_PROMPT_AUDIT.md:247`).
- `pi` was identified as uninstrumented for agent-visible launch/prompt/token history and a separate boundary (`internal/STAGE2U_C_AGENT_SURFACE_SECURITY_TOKEN_PROMPT_AUDIT.md:232-238`).

## Required Confirmations

LLM post-execution diff review is removed:

- The launch-cleanup report says the post-execution diff review was removed from the normal goal-completion path: the completion path now goes from `session.state = 'done'` to GitHub push, lessons, manual-tests, and summary (`internal/STAGE2U_C_LAUNCH_CLEANUP_REVIEW_USAGE_HISTORY_PI_STATUS_REPORT.md:24-30`).
- It also says the dead modules `src/goal/post-execution-review.ts`, `src/goal/post-execution-review.test.ts`, and `src/prompts/post-execution-review/build-prompt.ts` were removed (`internal/STAGE2U_C_LAUNCH_CLEANUP_REVIEW_USAGE_HISTORY_PI_STATUS_REPORT.md:31-32`).
- `git ls-files` confirms those removed post-execution-review files are not tracked at this preflight.

`pi` is disabled for launch:

- The launch-cleanup report says `pi` is disabled as a selectable/assignable backend without deleting pi code (`internal/STAGE2U_C_LAUNCH_CLEANUP_REVIEW_USAGE_HISTORY_PI_STATUS_REPORT.md:112-115`).
- It cites `src/goal/backend-availability.ts` reporting `pi` unavailable with a launch-disabled reason and `src/prompts/planner/system-prompt.ts` removing pi from planner/scout assignment rules (`internal/STAGE2U_C_LAUNCH_CLEANUP_REVIEW_USAGE_HISTORY_PI_STATUS_REPORT.md:116-124`).
- It also cites `/goal_workers pi` returning a disabled-for-launch message and old pi steps being remapped safely on resume (`internal/STAGE2U_C_LAUNCH_CLEANUP_REVIEW_USAGE_HISTORY_PI_STATUS_REPORT.md:125-130`).

`/usage_history` remains removed:

- The launch-cleanup report says `/usage_history` was removed for launch while `/usage_status` remains live-quota-only (`internal/STAGE2U_C_LAUNCH_CLEANUP_REVIEW_USAGE_HISTORY_PI_STATUS_REPORT.md:245-260`).
- It cites removal from `src/telegram/usage-status.ts`, native command registration, and the public menu (`internal/STAGE2U_C_LAUNCH_CLEANUP_REVIEW_USAGE_HISTORY_PI_STATUS_REPORT.md:249-257`).
- The same report states remaining markdown hits are only historical internal reports (`internal/STAGE2U_C_LAUNCH_CLEANUP_REVIEW_USAGE_HISTORY_PI_STATUS_REPORT.md:264-266`).

## Files This Goal Will Edit

Planned Stage 2U-E implementation edit set:

- `src/goal/cli-worker.ts`
- `src/goal/cli-worker.test.ts`
- `src/prompts/worker/worker-context.ts`
- `src/goal/attempt-bundle.ts`
- `src/goal/cli-planner.ts`
- `src/goal/cli-planner.test.ts`
- `src/prompts/planner/system-prompt.ts`
- `src/prompts/scout/scout_prompt_template.md`
- `src/goal/plan-autocheck.ts`
- `src/goal/plan-autocheck.test.ts`
- `src/prompts/plan-autocheck/review-instruction.ts`
- `src/goal/manual-tests.ts`
- `src/goal/manual-tests.test.ts`
- `src/prompts/manual-tests/*`
- `src/goal/lessons.ts`
- `src/goal/lessons.test.ts`
- `src/prompts/lessons/*`
- `src/goal/agent-surface-audit.ts`
- `src/goal/agent-surface-audit.test.ts`
- `src/goal/backend-sandbox.ts` only if scout/planner needs a small safe parameterization
- `src/goal/backend-sandbox.test.ts` only if `backend-sandbox.ts` changes
- `internal/STAGE2U_E_TOKEN_AND_HARDENING_REPORT.md`

This preflight task edited only:

- `internal/STAGE2U_E_PREFLIGHT.md`

## Files This Goal Will Not Edit

Not editing due to active-goal overlap:

- None. The resume/display-fix goal is terminal `done` in the sanitized mirror.

Not editing due to scope or explicit exclusions:

- `.env.local`
- `.env.production`
- `.env.test`
- `src/goal/post-execution-review.ts`
- `src/goal/post-execution-review.test.ts`
- `src/prompts/post-execution-review/build-prompt.ts`
- `src/repo-chat/repo-chat-worker.ts`
- `src/repo-chat/repo-chat-worker.test.ts`
- `src/goal/pi-runner.ts`
- `src/goal/goal-sending.ts`
- `src/cron/nightwatch.ts`
- `src/commands/goal-resume.ts`
- `src/telegram/usage-status.ts`
- `src/telegram/goal-commands.ts`
- `src/telegram/bot-native-commands.ts`
- `src/telegram/public-menu.ts`
- generated output under `dist/`
- operator-local systemd or gateway service files
- private env/config/auth/session files

## Final 2U-E Target List

Hardening targets:

- scout/planner
- plan revision/replan
- plan-autocheck
- manual-tests CLI path
- lessons

Prompt/cache optimization targets:

- worker prompt
- scout/planner prompt
- plan revision/replan prompt
- plan-autocheck round prompts
- manual-tests prompts
- lessons prompts

Audit/report target:

- reconcile `src/goal/agent-surface-audit.ts` and `src/goal/agent-surface-audit.test.ts` classifications after implementation
- produce `internal/STAGE2U_E_TOKEN_AND_HARDENING_REPORT.md`

Exclusions:

- worker and repo-chat sandbox hardening, because they already use the proven shared native sandbox helper
- post-exec LLM diff review, because it has been removed
- `pi`, because it is disabled for launch
- goal-sending Mermaid repair and nightwatch unless a small safe change is obviously necessary
- `/usage_status` changes
- restoring `/usage_history`
- gateway restart/status formatting
- scheduler fallback semantics
- live gateway restarts
