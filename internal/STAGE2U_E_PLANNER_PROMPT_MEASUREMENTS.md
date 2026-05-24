# Stage 2U-E Planner Slice Measurements

Scope: `harden-and-optimize-planner`.

Source material used: Stage 2U-C identified `scout-planner` and `plan-revision` as credential-stripped native-sandbox opt-out surfaces and identified `buildPlanningPrompt` / `buildPlanRevisionPrompt` as prompt-cache targets.

## Hardening

- `runCliPlanning` now launches Codex through the shared Codex native sandbox helper using the `repo-chat` profile. Scout artifact generation grants write access only to the Codex temp scout directory; repo paths remain read-only.
- `runCliPlanning` now launches Claude Code with generated shared sandbox settings using the `repo-chat` profile. Scout artifact generation grants write access only to the canonical scout directory; repo paths remain read-only.
- `runCliPlanRevision` now launches Codex and Claude Code with the shared `repo-chat` read-only sandbox profiles. Revision output remains stdout/artifacts only.
- Subscription auth still uses `buildClaudeCodeEnv`; API-key/env poisoning remains stripped; no dangerous skip flags are emitted.

## Prompt Counts

Representative fixture:
- workers: `claude_code`, `codex`
- goal: `Implement a representative feature with tests, planning, and documentation updates.`
- workspace: `/home/matt/smithersbot-goals/agent/workspaces/smithersbot/repo`

| Surface | Before chars | After chars | Delta | Notes |
| --- | ---: | ---: | ---: | --- |
| Scout/planner with scout artifacts | 21528 | 21522 | -6 | Stable `buildPlanSystemPrompt` prefix now appears before dynamic scout context; duplicated system block in the scout appendix was removed. |
| Planner without scout artifacts | 13923 | 13923 | 0 | Already had stable system prompt first. |
| Plan revision/replan | 14755 | 14755 | 0 | Already had stable system prompt first; this slice preserved content and hardened launch config. |

Stable planner prefix in the representative fixture: 13745 chars.

Expected cache effect: scout/planner prompts now expose the planner/scout schema, DAG, backend-selection, managed-workspace, and safety instructions as the first stable prefix across different goals. Dynamic goal/repo/scout paths follow that prefix, improving cache reuse without weakening plan requirements.

## Verification

- `pnpm vitest run src/goal/cli-planner.test.ts src/goal/backend-sandbox.test.ts`
- `pnpm exec tsc -p tsconfig.json`
- `pnpm build`
- `pnpm lint`
