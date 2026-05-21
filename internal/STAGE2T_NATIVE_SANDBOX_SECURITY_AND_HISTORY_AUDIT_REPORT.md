# Stage 2T Native Sandbox, Security, Dependency, and History Audit

Date: 2026-05-21

## Summary

Stage 2T hardening is implemented and verified for the code paths covered by this task. Codex goal-worker and repo-chat launches now construct native sandbox arguments for normal SmithersBot worker flows. Claude Code is explicitly not claimed as natively filesystem-sandboxed because the available CLI surface does not expose a filesystem-root sandbox or fail-closed sandbox configuration.

The managed-root contract remains transitional: new/default workspaces live under `<managed-root>/agent/workspaces/<workspace>/repo`, agent-readable history lives under `<managed-root>/agent/history/`, and private env/config/auth/session data stays under `<managed-root>/private/` or gateway-private `~/.smithersbot`. Legacy `workingDir` compatibility remains enabled by default and is treated as trusted-local rather than isolated.

## Claude Code Sandbox Investigation

Result: not implemented as a native filesystem sandbox.

Investigation found that the Claude Code CLI path available to this repo exposes permission/tool controls such as allowed tools, but not a native filesystem sandbox root, private-root deny list, fail-closed sandbox setting, or unsandboxed-command fallback toggle that SmithersBot can pass through the current worker/repo-chat CLI launch path.

Implemented behavior:

- `claudeCodeNativeSandboxStatus()` reports `supported: false`.
- Claude Code workers and repo chat keep using tightened prompt/tool controls and credential-stripped environments, but SmithersBot does not describe these controls as a native sandbox boundary.
- Claude sandbox live probes are marked `unproven` with the reason that no native filesystem sandbox is configured.

Blocker:

- No backend-specific Claude Code filesystem sandbox/root configuration surface is available through the current CLI path in this environment.

## Codex Sandbox Investigation

Result: implemented for normal Codex goal-worker, repo-chat, and availability-probe flows.

SmithersBot now centralizes Codex sandbox argument construction in `src/goal/backend-sandbox.ts`.

Exact configuration:

- Goal workers:
  - `--sandbox workspace-write`
  - `--cd <assigned workspace repo>`
  - `-c net.allowed=false` by default, or `true` only when the plan step explicitly requires network
  - `-c sandbox_workspace_write.writable_roots=["<assigned workspace repo>/.git"]`
  - never uses `danger-full-access` or `--dangerously-bypass-approvals-and-sandbox`

- Repo chat:
  - initial Codex sessions use `--sandbox read-only`
  - for managed workspace sessions, `--cd <managed-root>/agent` so repo chat can inspect `agent/workspaces` and `agent/history`
  - `-c net.allowed=false`
  - rejects execution from `<managed-root>/private`
  - resume sessions omit unsupported fresh-session flags because `codex exec resume` rejects `--sandbox`, `--cd`, `--color`, and approval flags; sandbox/cwd are expected to inherit from the original Codex session

- Backend availability probes:
  - use the same Codex sandbox construction path and avoid dangerous bypass flags

Boundaries enforced by construction/tests:

- Codex worker sandbox root is the assigned workspace repo, not `<managed-root>` or operator home.
- Codex repo-chat managed execution root is `<managed-root>/agent`, not `<managed-root>`.
- `<managed-root>/private` is rejected as a backend execution root.
- Legacy `workingDir` values remain compatible and warn rather than flipping `allowLegacyWorkingDir` to fail-closed.

## Sandbox Probe Coverage

Static and environment-aware probe harnesses were added for goal-worker and repo-chat paths.

Denied probe cases encoded:

- `cat <managed-root>/private/env/<workspace>/.env`
- `cat ~/.smithersbot/.env`
- `cat ~/.smithersbot/smithersbot.json`
- `cat .env.local`
- `python3 -c 'open("<managed-root>/private/env/<workspace>/.env").read()'`
- `ln -s <managed-root>/private/env/<workspace>/.env ./env-link && cat ./env-link`

Allowed probe cases encoded:

- `cat README.md`
- `cat .env.example`
- `rg` over `<managed-root>/agent/history`
- normal code edit inside the assigned workspace repo

Proven by tests:

- Codex goal-worker probe prompts are threaded through normal `workspace-write` args.
- Codex repo-chat probe prompts are threaded through normal `read-only` args.
- Both Codex probe paths avoid `danger-full-access`.
- Claude Code probe readiness is `unproven` because no native filesystem sandbox is configured.

Not proven live in this run:

- Live Codex backend probes were not executed because they are gated behind `SMITHERSBOT_SANDBOX_LIVE_PROBES=1`.
- Claude Code live sandbox probes cannot prove a native filesystem sandbox until a backend-supported filesystem sandbox surface exists.

## Security Sweep

Fixed bounded issues:

- Managed-root trust-zone checks now follow symlink ancestors so symlinked private targets are not classified as agent-visible.
- Goal workers reject managed private paths and private symlink targets while preserving legacy `workingDir` compatibility.
- Repo-chat rejects private symlink cwd.
- Worker and repo-chat env stripping removes generic `*_TOKEN` and OAuth-style credential variables in addition to known provider/gateway secrets.
- Agent-history summary/index tests cover redaction and append-once behavior.

Reviewed risk areas:

- Direct `process.env` usage in worker/repo-chat/agent surfaces is primarily config lookup, test setup, or credential-stripped env construction. LLM subprocess launch paths use `buildClaudeCodeEnv(...)`, `buildCredentialStrippedEnv(...)`, or the centralized CLI runner env stripping path.
- Agent-readable history writes are routed through sanitized run/repo-chat summaries and append-once indexes.
- Remaining `Working dir:` labels are daemon status/CLI status output, not goal/repo-chat history artifacts.
- README/SETUP/prompt docs avoid claiming full OS-level isolation beyond backend-specific probes that passed.

Deferred findings:

- Claude Code native filesystem sandboxing remains deferred until Claude Code exposes a usable CLI/config surface.
- Codex resume sandboxing depends on original-session inheritance because the current `codex exec resume` path rejects fresh-session sandbox flags.
- Live backend sandbox proofs require an operator-enabled run with `SMITHERSBOT_SANDBOX_LIVE_PROBES=1`.

## Dependency Audit

Removed from manifest/lockfile now:

- `@line/bot-sdk`
- `@slack/bolt`
- `@slack/web-api`
- `@whiskeysockets/baileys`
- `@lit-labs/signals`
- `@lit/context`
- `@mariozechner/mini-lit`
- `@typescript/native-preview`
- `docx-preview`
- `quicktype-core`
- `rolldown`
- `signal-utils`
- `wireit`

Also removed:

- stale Baileys `onlyBuiltDependencies` entry from `pnpm-workspace.yaml`

Evidence:

- `rg` over `package.json`, `pnpm-lock.yaml`, and `pnpm-workspace.yaml` finds no removed package names.
- `pnpm list --depth 0 --lockfile-only` no longer lists the removed packages.
- Plain `pnpm list --depth 0` still showed stale installed packages from the current `node_modules` state; this is an installed-tree artifact, not a manifest/lockfile dependency. A normal `pnpm install` would prune local `node_modules`, but network is restricted in this worker environment and no networked install was run.

Candidates kept intentionally:

- `@homebridge/ciao`: dynamically imported by `src/infra/bonjour.ts`.
- `@mermaid-js/mermaid-cli`: used by `src/goal/mermaid-png.ts` via `mmdc`.
- `@mozilla/readability`: dynamically imported by `src/agents/tools/web-fetch-utils.ts`.
- `@lydell/node-pty`: dynamically imported by PTY fallback code.
- `node-llama-cpp`, `@napi-rs/canvas`: optional runtime dependencies with explicit fallback/error paths.

Other intentionally kept groups:

- Telegram runtime packages.
- Pi agent/runtime packages.
- `@sinclair/typebox`, `lit`, `lucide`.
- Tooling referenced by package scripts: `@vitest/coverage-v8`, `oxlint`, `oxlint-tsgolint`, `oxfmt`, `tsx`, `typescript`, `vitest`.

## LLM Lifecycle History Coverage

| Lifecycle step | Persistence behavior |
| --- | --- |
| Scout | Persisted inside goal run state and mirrored as sanitized goal summary under `agent/history/goals/<workspace>/<runId>/summary.json`; indexed once in `agent/history/index/all-goals.jsonl`. |
| Planner system prompt | Plan metadata is persisted in `run.json` and mirrored as sanitized plan/step metadata; raw planner output remains in runtime artifacts and is not mirrored to agent history. |
| Plan autocheck reviewer | Review outcome is persisted as goal-run metadata and mirrored through the sanitized goal summary; raw reviewer transcript is not mirrored. |
| Worker context | Worker status/result is persisted in the runtime run store and mirrored only as sanitized step metadata; raw stdout/stderr/transcripts are not mirrored. |
| Agent workspace bootstrap | No LLM call is made by the bootstrap template loader; generated workspace instruction files are local workspace artifacts, not history records. |
| Repo-chat context | Repo-chat session metadata is persisted in the runtime store and mirrored as sanitized summaries under `agent/history/repo-chats/<workspace>/<sessionId>/summary.json`; indexed once in `agent/history/index/all-repo-chats.jsonl`. |
| Repo-chat delivery | Final response text is persisted through the repo-chat store with secret redaction before sanitized summary mirror update; temp response files are runtime scratch artifacts. |
| Repo-chat repair | Repair output follows the same redacted repo-chat persistence path; repair scratch files/transcripts are not mirrored. |
| Post-execution review | Review result is stored with the goal run and mirrored only through sanitized goal summary metadata; raw diff/prompt/transcript is not mirrored. |
| Manual-test suggester | Suggested manual checks are stored in goal-run metadata when produced and exposed through the sanitized goal summary; raw model transcript is not mirrored. |
| Lesson extraction | Extracted lessons are persisted as reusable runtime-store lessons; goal-run linkage is searchable through sanitized summaries while raw prompts/transcripts are not mirrored. |

Coverage tests:

- `src/prompts/prompts.test.ts` checks lifecycle table coverage and docs guardrails.
- `src/goal/run-store.test.ts` and `src/repo-chat/repo-chat-store.test.ts` cover sanitized mirrors and append-once indexes.

## Prompt And Docs Updates

Updated surfaces:

- `src/goal/worker-context/shared-worker-contract.md`
- `src/goal/worker-context/AGENTS.md`
- `src/goal/worker-context/CLAUDE.md`
- `src/prompts/repo-chat/repo-chat-context.ts`
- `src/prompts/planner/system-prompt.ts`
- `src/prompts/plan-autocheck/review-instruction.ts`
- `src/prompts/README.md`
- `README.md`
- `SETUP.md`

Updated message:

- Agents work inside SmithersBot-managed workspaces.
- Real env files live outside the agent-visible workspace.
- `.env.example` is the portable variable-name contract.
- Project code should read normal env vars such as `process.env.KEY` or `os.environ["KEY"]`.
- Workers do not receive raw secrets by default.
- Native backend sandboxing is claimed only where implemented and verified.
- Legacy `workingDir` values are transitional trusted-local compatibility paths.
- Full OS-level isolation is not claimed unless backend-specific probes pass.

## Verification Results

Required verification matrix:

- `pnpm vitest run src/config/ src/security/ src/goal/ src/repo-chat/ src/telegram/goal-commands.test.ts src/telegram/repo-chat-commands.test.ts` passed: 98 files passed, 1 skipped; 1471 tests passed, 11 skipped.
- `pnpm vitest run src/prompts/` passed: 1 file, 41 tests.
- `pnpm vitest run src/agents/` passed: 195 files, 980 tests.
- `pnpm exec tsc -p tsconfig.json` passed.
- `pnpm build` passed.
- `pnpm lint` passed: 0 warnings, 0 errors.
- `pnpm test` passed: 1 file, 19 tests.

Required audit commands:

- `git diff --stat` before report creation produced no output.
- `git grep -n "danger-full-access|sandbox|failIfUnavailable|allowUnsandboxed|workspace-write" src scripts README.md SETUP.md || true` completed; key results include Codex sandbox builders/tests, docs guardrails, and no normal goal-worker/repo-chat `danger-full-access` launch path.
- `git grep -n "process.env" src/goal src/repo-chat src/agents src/commands src/telegram | head -200` completed; reviewed output for worker/repo-chat/agent env handling.
- `git grep -n "agent/history|all-goals.jsonl|all-repo-chats.jsonl" src README.md SETUP.md` completed; results include managed path helpers, sanitized history stores, prompt lifecycle docs, and repo-chat context.
- `git grep -n "private/env|.env.local|.env.example" src README.md SETUP.md` completed; results include private env helpers/tests, sandbox probes, prompt/docs contract wording, and `.env.example` allow tests.
- `git grep -n "Working dir:" src README.md SETUP.md` completed; remaining matches are daemon status output and a regression test asserting goal output does not include `**Working dir:**`.
- `pnpm list --depth 0` completed; it still listed stale installed packages from local `node_modules` despite manifest/lockfile removal.
- `pnpm list --depth 0 --lockfile-only` completed and matched the pruned manifest/lockfile state.
- `pnpm why <audited-candidate...>` completed; it reported kept candidates and stale installed removed packages from local `node_modules`.

## Dogfood Readiness

Codex-only dogfood: ready for a controlled run. Static tests and full verification passed, and normal Codex launch construction now uses native sandbox flags for goal workers and repo chat. A live sandbox proof still needs `SMITHERSBOT_SANDBOX_LIVE_PROBES=1` in an operator-approved environment.

Claude-only sandbox dogfood: needed before any Claude native-sandbox claim. Current status is intentionally unproven because SmithersBot cannot pass a native Claude Code filesystem sandbox through the available CLI path.
