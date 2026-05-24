# Stage 2U-E Codex Trusted-Directory Helper Fix Report

Date: 2026-05-24

## Summary

Stage 2U-E moved the planner/replan/autocheck/manual-tests/lessons Codex CLI
launches onto the shared native sandbox exec helper
(`appendCodexNativeSandboxExecArgs` in `src/goal/backend-sandbox.ts`). That move
dropped Codex's benign `--skip-git-repo-check` trust-preflight flag, so Codex
refused to run from the managed agent root with:

```
Not inside a trusted directory and --skip-git-repo-check was not specified.
```

The fix centralizes the flag in the shared helper: it appends
`--skip-git-repo-check` exactly once (deduped), immediately before
`--cd <executionRoot>`. This propagates to every Codex surface routed through the
helper without duplicating the flag for the repo-chat caller that already passes
it. No sandbox deny policy, TOML profile, `CODEX_HOME`/`PATH`, auth/session, or
symlink-escape behavior changed.

## Root Cause

- Before Stage 2U-E, the affected Codex phases carried `--skip-git-repo-check`
  on their own. Stage 2U-E consolidated their launch-arg construction through the
  shared native sandbox exec helper, which only appended `--cd executionRoot`.
- For planner/checker-style launches, the execution root is the **managed agent
  root** (`--cd /home/matt/smithersbot-goals/agent`), which is not a git
  repository. Codex's startup performs a git/trusted-directory preflight: when
  the working directory is not inside a trusted git repo and
  `--skip-git-repo-check` is absent, Codex aborts before doing any work.
- The shared helper had stopped carrying that benign preflight flag, so those
  phases (planner, replan, fresh autocheck, manual-tests, lessons, and any
  worker/repair routed through the helper) hit the trusted-directory abort.

## Live Reproduction Reference

Goal `d2bd1e68` launched fresh plan-autocheck via the shared helper with:

```
codex ... exec --json --color never --cd /home/matt/smithersbot-goals/agent ...
```

Codex failed at startup with:

```
Not inside a trusted directory and --skip-git-repo-check was not specified.
```

The autocheck phase did not run.

## Why the Managed Agent Root cwd Is Intentional

For planner and checker phases, `--cd /home/matt/smithersbot-goals/agent` (the
managed agent root) is deliberate, not accidental:

- These phases need visibility into the managed agent root, including
  `agent/workspaces/<workspace>/repo` and the agent-visible history under
  `agent/history/` (sanitized goal and repo-chat summaries).
- Anchoring at the managed agent root lets the planner reason about the workspace
  layout and lets checker phases consult agent-visible run history.
- The managed agent root is not itself a git repo, which is exactly why Codex's
  git/trusted-directory preflight trips without the skip flag.

This cwd choice is correct and is preserved by the fix; only the missing benign
preflight flag is restored.

## Why `--skip-git-repo-check` Is the Correct Benign Fix

- `--skip-git-repo-check` only skips Codex's git/trusted-directory **preflight**.
  It tells Codex "don't refuse just because cwd isn't inside a trusted git repo."
- It does **not** disable, weaken, or bypass the sandbox. It is unrelated to the
  approval/sandbox enforcement flags.
- The actual sandbox enforcement remains entirely in the shared native sandbox
  helper plus the generated config: the Codex permission-profile TOML, the
  generated `CODEX_HOME`, and the `PATH` wiring. None of those changed.

### Explicit confirmation: this is NOT a sandbox bypass

- The fix adds only `--skip-git-repo-check`. It does **not** add any dangerous
  skip/bypass flag (no `--dangerously-skip-permissions`,
  `--allow-dangerously-skip-permissions`, or
  `--dangerously-bypass-approvals-and-sandbox`). Tests assert those dangerous
  flags remain absent.
- Deny rules (private env, repo `.env*`, `~/.codex/auth.json`, sessions, symlink
  escape) are unchanged. Read-only repo posture and write-path scoping are
  unchanged. The generated TOML profile and `CODEX_HOME`/`PATH` behavior are
  unchanged.

## Exact Helper Changed

`appendCodexNativeSandboxExecArgs(args, config)` in
`src/goal/backend-sandbox.ts`:

```ts
export function appendCodexNativeSandboxExecArgs(
  args: string[],
  config: CodexNativeSandboxConfig,
): string[] {
  if (!args.includes("--skip-git-repo-check")) {
    args.push("--skip-git-repo-check");
  }
  args.push("--cd", config.executionRoot);
  return args;
}
```

- Appends `--skip-git-repo-check` exactly once (dedup guard for callers, such as
  repo-chat, that already pass it explicitly).
- Appends `--skip-git-repo-check` **before** `--cd config.executionRoot`.
- Leaves the generated sandbox config (`config.args`, `appendCodexSandboxArgs`),
  env merge (`mergeCodexNativeSandboxEnv` → `CODEX_HOME`/`PATH`), the TOML
  profile, and all deny/read-only path logic untouched.

## Surfaces Covered

Because the fix is centralized in the shared helper, every Codex surface routed
through it inherits the flag:

- scout/planner
- plan revision / replan
- fresh plan-autocheck (session-bound resume still resumes by session, unchanged)
- manual-tests CLI
- lessons (lesson extraction)
- worker/repair when routed through the helper
- repo-chat fresh/resume — already passed `--skip-git-repo-check`, so the dedup
  guard keeps it appearing exactly once (no duplication)

## Misleading "Fallback" Observation (documentation only)

For goal `d2bd1e68`, the observed "fallback" event around the failed autocheck
was misleading. `runWithBackendFallback` (`src/goal/phase-fallback.ts`) only
falls back to the next backend by default when the error is classified as a
usage/rate-limit error (`detectUsageLimitKind` returns a kind); any other error
breaks immediately unless `fallbackOnAnyError` is set. The trusted-directory
launch error is **not** a usage/rate-limit error, so it was **terminal** for the
autocheck phase — it could not be recovered by switching backends.

This is recorded for clarity only. No broad backend-fallback redesign is made or
proposed in this goal; the correct fix is the centralized benign preflight flag
above.

## Tests Added / Updated

- `src/goal/backend-sandbox.test.ts`
  - Helper appends `--skip-git-repo-check` exactly once before
    `--cd <executionRoot>` (asserts arg order
    `["exec", "--json", "--skip-git-repo-check", "--cd", "/repo"]`).
  - Helper does not duplicate the flag when the caller already passes it.
  - Generated sandbox config (`config.args`) is left unchanged by the helper.
  - Existing deny/read-only/TOML config behavior assertions unchanged.
- `src/goal/cli-planner.test.ts`
  - Codex planner args include `--skip-git-repo-check` and still contain `--cd`.
  - Codex plan-revision args include `--skip-git-repo-check` and still contain
    `--cd`.
  - No dangerous skip/bypass flags
    (`--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`,
    `--dangerously-bypass-approvals-and-sandbox` all absent).
  - `CODEX_HOME`/`PATH`, env stripping, and deny-path TOML assertions unchanged.
- `src/goal/plan-autocheck.test.ts`
  - Fresh Codex autocheck includes `--skip-git-repo-check` (flipped the prior
    `not.toContain` assertion to `toContain`).
  - `--sandbox` still absent; backend/session/`CODEX_HOME` behavior unchanged.
- `src/goal/manual-tests.test.ts`
  - Fresh Codex manual-tests args include `--skip-git-repo-check`.
  - Read-only sandbox/helper behavior (`--sandbox`/`workspace-write` absent)
    unchanged.
- `src/goal/lessons.test.ts`
  - Codex lesson extraction includes `--skip-git-repo-check` (flipped both prior
    `not.toContain` assertions to `toContain`).
  - No-dangerous-flag and deny-path assertions unchanged.
- `src/repo-chat/repo-chat-worker.test.ts`
  - Fresh repo-chat path asserts `--skip-git-repo-check` appears **exactly once**
    so the dedup guard is regression-covered.

## Verification Results

Commands run by the implementation task (`fix-codex-trusted-directory-helper`):

- `pnpm vitest run src/goal/backend-sandbox.test.ts src/goal/cli-planner.test.ts src/goal/plan-autocheck.test.ts src/goal/manual-tests.test.ts src/goal/lessons.test.ts src/repo-chat/repo-chat-worker.test.ts` — passed.
- `pnpm exec tsc -p tsconfig.json` — passed.
- `pnpm build` — passed.
- `pnpm lint` — passed.

This report task is documentation-only and changes no source; verification of the
code change is owned by the implementation task above.

## Manual Verification Steps (operator)

Run these in an operator-approved environment. Do not run them from the worker;
the worker must not restart the gateway.

1. Restart the gateway (operator-initiated; worker restart is prohibited during
   goal execution).
2. Rerun the live launch smoke goal.
3. Confirm the planner runs (no trusted-directory abort from the managed agent
   root cwd).
4. Confirm autocheck runs instead of skipping (the previously terminal
   trusted-directory launch error no longer occurs).
5. Confirm worker execution runs.
6. Confirm manual-tests and lessons run.
7. Confirm no secret/private-config contents appear in any output (no private
   env, repo `.env*`, auth/session contents, API keys, tokens, or raw statusline
   JSON).

## Out of Scope (unchanged)

- No sandbox deny policy change.
- No Stage 2U-E redo.
- No `/usage_status` change; `/usage_history` not restored.
- No post-exec LLM review reintroduction.
- No `pi` enablement.
- No resume/display logic change.
- No broad backend-fallback redesign (fallback note is documentation only).
- No gateway restart from the worker.

## Verdict

- Trusted-directory regression fixed at the shared helper: yes
- Benign `--skip-git-repo-check` appended once, deduped, before `--cd`: yes
- Not a sandbox bypass; deny/read-only/TOML/env unchanged: yes
- All affected Codex surfaces covered without repo-chat duplication: yes
- Regression tests added/updated across the six files: yes
- Typecheck, build, lint, focused tests clean: yes
