# Stage 2U-E Token And Hardening Report

Date: 2026-05-24

## Source Material

This report reconciles the Stage 2U-E implementation against the Stage 2U-C outputs and the Stage 2U-E slice measurement notes. It does not redo the Stage 2U-C audit.

Source material used:

- `internal/STAGE2U_E_PREFLIGHT.md`
- `internal/STAGE2U_E_WORKER_PROMPT_MEASUREMENTS.md`
- `internal/STAGE2U_E_PLANNER_PROMPT_MEASUREMENTS.md`
- `internal/STAGE2U_E_AUTOCHECK_PROMPT_MEASUREMENTS.md`
- `internal/STAGE2U_E_MANUALTESTS_LESSONS_PROMPT_MEASUREMENTS.md`
- Stage 2U-C source list recorded in preflight: `internal/STAGE2U_C_AGENT_SURFACE_SECURITY_TOKEN_PROMPT_AUDIT.md`, `internal/STAGE2U_C_AGENT_SURFACE_AUDIT.json`, `internal/STAGE2U_C_AGENT_FLOW_MAP.md`, `internal/STAGE2U_C_AGENT_FLOW_MAP.json`, `internal/STAGE2U_C_LAUNCH_CLEANUP_REVIEW_USAGE_HISTORY_PI_STATUS_REPORT.md`, and `internal/STAGE2U_C_RESUME_USER_INPUT_DISPLAY_FIX_REPORT.md`

## Surfaces Changed

- `scout-planner` and plan revision/replan now use the shared backend sandbox helper for Codex and Claude Code CLI launches.
- `plan-autocheck` now uses the shared backend sandbox helper for fresh reviewer launches while preserving session-bound resume behavior.
- `manual-tests` CLI backends now use the shared backend sandbox helper; the in-process `GoalLlmClient` path remains unchanged because it does not spawn a filesystem-executing CLI.
- `lessons` CLI backends now use the shared backend sandbox helper.
- Worker, planner, autocheck, manual-tests, and lessons prompts were reordered or preserved as static-prefix-first surfaces, with repeated history compacted where safe.
- `src/goal/agent-surface-audit.ts` now classifies the shipped in-scope CLI surfaces as `shared-native-sandbox-helper-proven`.

## Surfaces Not Changed

- Worker and repo-chat sandboxing were not changed; they already used the shared helper.
- Post-exec LLM diff review was not changed because it has been removed from the normal lifecycle.
- `pi` was not changed because it is disabled for launch and is not instrumented as a Codex/Claude CLI surface.
- Goal-sending Mermaid repair and nightwatch were not changed. They remain excluded utility callers and are still classified as credential-stripped native-sandbox opt-out for documentation.
- `/usage_status` was not changed and `/usage_history` was not restored.

## Hardening

Made:

- Planner Codex: shared Codex native permission-profile config with repo-chat read-only posture and scout-temp writes only when scout artifacts are enabled.
- Planner Claude Code: shared generated sandbox settings with repo read-only and scout-dir writes only when scout artifacts are enabled.
- Plan revision/replan: shared repo-chat read-only helper profile for both CLI backends.
- Plan-autocheck: shared repo-chat read-only helper profile for fresh reviewer launches; backend-bound session resume semantics preserved.
- Manual-tests CLI: shared repo-chat read-only helper profile for both CLI backends; Codex keeps model network enabled.
- Lessons CLI: shared repo-chat read-only helper profile for both CLI backends; Codex no longer uses `--skip-git-repo-check`.
- Audit classification: in-scope Codex/Claude CLI surfaces now record private env, repo `.env*`, symlink escape, and auth/session denies as true where the shared helper is used.

Deferred:

- Goal-sending Mermaid repair: excluded utility path, not a goal/agent task execution surface; acceptable for launch per target scope.
- Nightwatch: excluded cron maintenance path, not a per-goal agent surface; acceptable for launch per target scope.
- `pi`: disabled for launch and not a Codex/Claude CLI surface; needs a separate capability-enforcement and instrumentation review before any launch enablement.
- Live OS-level sandbox probes: env-gated by `SMITHERSBOT_CODEX_SANDBOX_LIVE_PROBES` / Claude equivalent probe flags; not required for this worker sweep.

## Prompt Measurements

| Surface | Before chars | After chars | Delta | Stable prefix / effect |
| --- | ---: | ---: | ---: | --- |
| Worker prompt | 23,353 | 14,646 | -8,707 | Stable prefix 1,775 chars; repeated attempt output compacted. |
| Scout/planner with scout artifacts | 21,528 | 21,522 | -6 | Stable planner prefix 13,745 chars; dynamic scout/goal context follows. |
| Planner without scout artifacts | 13,923 | 13,923 | 0 | Already static-prefix-first; preserved. |
| Plan revision/replan | 14,755 | 14,755 | 0 | Already static-prefix-first; preserved. |
| Plan-autocheck round 1 | 6,977 | 6,977 | 0 | Review instruction prefix 5,372 chars moved first. |
| Plan-autocheck round 2 | 7,049 | 7,049 | 0 | Same stable 5,372-char prefix; session reuse preserved. |
| Manual-tests combined prompt | 3,104 | 3,104 | 0 | Already static system prompt first; preserved. |
| Manual-tests user message | 680 | 680 | 0 | Unchanged. |
| Lessons Codex prompt | 2,686 | 2,686 | 0 | Static lesson contract moved before dynamic run context. |
| Lessons Claude wrapped prompt | 2,969 | 2,969 | 0 | Inherits reordered lessons prompt. |

Expected token/cache effect:

- Worker has the largest direct prompt-size reduction: 8,707 fewer characters in the representative fixture, mostly from compacting repeated failed-attempt output.
- Planner and autocheck now put the high-stability schema/rubric/safety content first, improving prefix-cache eligibility even when total character count is unchanged.
- Manual-tests was already ordered correctly and did not grow.
- Lessons now starts with the stable extraction contract; dynamic run/correction details follow.

Actual tokenUsage comparison:

- No comparable live provider tokenUsage before/after sample was available inside this worker run.
- Tests continue to cover tokenUsage parsing/capture for worker, planner, autocheck, manual-tests, and lessons history/result paths.

## Instrumentation

Prompt artifact capture still works:

- Worker prompt artifact pre-spawn capture is covered by `src/goal/cli-worker.test.ts`.
- Planner and plan-revision prompt artifact capture is covered by `src/goal/cli-planner.test.ts`.
- Autocheck launch/prompt history per round is covered by `src/goal/plan-autocheck.test.ts`.
- Manual-tests and lessons prompt artifacts are covered by `src/goal/manual-tests.test.ts` and `src/goal/lessons.test.ts`.

History and token capture still work:

- Incremental redacted history events remain covered by `src/goal/agent-history-events.test.ts` and `src/goal/agent-surface-audit.test.ts`.
- Per-surface tokenUsage capture remains covered by the focused tests listed above.

## Tests Added Or Updated

- `src/goal/cli-worker.test.ts`: stable worker prefix, result contract, safety instructions, dynamic task details, compacted attempt history, prompt artifact capture, token capture.
- `src/goal/cli-planner.test.ts`: shared helper launch behavior, deny/read-only config expectations, env stripping, dangerous flag absence, fallback behavior, stable prefixes, prompt artifact and token capture, plan validation preservation.
- `src/goal/plan-autocheck.test.ts`: shared helper launch behavior, session reuse/backend switch behavior, stable review prefix, compact prior feedback, per-round history, token capture.
- `src/goal/manual-tests.test.ts`: shared helper launch behavior, prompt/token preservation, criticality metadata, fallback behavior, secret redaction.
- `src/goal/lessons.test.ts`: shared helper launch behavior, extraction contract, fail-open behavior, prompt/token preservation, secret redaction.
- `src/goal/backend-sandbox.test.ts`: shared helper deny/read-only/write-path behavior used by hardened surfaces.
- `src/goal/agent-surface-audit.test.ts`: reconciled classification counts and opt-out exclusions.

## Verification Results

Initial env-limited attempt:

- `CODEX_HOME=/tmp/smithersbot-stage2ue-codex-home pnpm vitest run src/goal/cli-worker.test.ts src/goal/cli-planner.test.ts src/goal/plan-autocheck.test.ts src/goal/manual-tests.test.ts src/goal/lessons.test.ts src/goal/agent-history-events.test.ts src/goal/agent-surface-audit.test.ts src/goal/backend-sandbox.test.ts`
- Result: failed because this worker sandbox cannot write the requested `/tmp/.../memories` path. The command was rerun with `CODEX_HOME` under the provided writable `/var/tmp/.../memories` root, outside the managed agent workspace.

Successful verification:

- `pnpm vitest run src/goal/agent-surface-audit.test.ts`: passed, 11 tests.
- `CODEX_HOME=/var/tmp/smithersbot-codex-23612172-c183-4eb2-912b-06219a8202f9-reconcile-audit-report-and-verify-attempt-1/memories/stage2ue-codex-home pnpm vitest run src/goal/cli-worker.test.ts src/goal/cli-planner.test.ts src/goal/plan-autocheck.test.ts src/goal/manual-tests.test.ts src/goal/lessons.test.ts src/goal/agent-history-events.test.ts src/goal/agent-surface-audit.test.ts src/goal/backend-sandbox.test.ts`: passed, 264 tests.
- `pnpm exec tsc -p tsconfig.json`: passed.
- `pnpm build`: passed.
- `pnpm lint`: passed with 0 warnings and 0 errors.

## Launch Impact

Stage 2U-E reduces launch risk by moving the remaining in-scope Codex/Claude CLI opt-out surfaces onto the shared helper, without changing scheduler fallback semantics, `/usage_status`, `/usage_history`, gateway formatting, post-exec review removal, or `pi` launch-disabled behavior. Prompt changes improve cache friendliness and reduce repeated worker retry content while preserving result contracts, safety instructions, history capture, and token capture.

Remaining follow-ups:

- Run live OS-level sandbox probes in an operator-approved environment when launch validation wants live proof instead of generated-config/test proof.
- Review excluded Mermaid repair and nightwatch utility callers separately if they become launch-critical agent surfaces.
- Keep `pi` disabled until it has equivalent instrumentation and a separate capability-boundary review.

## Verdict

- Opt-out surfaces hardened where safe: yes
- Worker prompt optimized: yes
- Planner prompt optimized: yes
- Autocheck prompt optimized: yes
- Manual-tests prompt optimized: yes
- Lessons prompt optimized: yes
- Behavior preserved: yes
- Ready for docs/setup polish: yes
