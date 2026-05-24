# STAGE2U_F — Sandbox test-gating fix (offline verification green)

## Summary

`pnpm vitest run src/goal/backend-sandbox.test.ts src/goal/sandbox-probes.test.ts
src/goal/cli-worker.test.ts` reported 93 passed / 1 skipped / **15 failed**. The 15
failures were a test-environment / stale-assertion problem, not a product regression:
the offline status/probe tests assumed a host where the repo and the OS temp dir live
*outside* the SmithersBot agent root. On this dogfood host neither is true, so the
generated sandbox config landed inside the agent root and the (correct) production
guard fail-closed. This change makes the offline command deterministic and green while
keeping every live sandbox proof explicitly gated. No production sandbox behavior was
changed.

The same environmental root cause (`vitest.config.ts` redirects `TMPDIR` to
`<repo>/.tmp/vitest`, and on this host the repo is itself inside the agent root and is a
git repo) also broke two more files in the wider `src/goal` suite — `cli-planner.test.ts`
(30, same sandbox-gating guard) and `git-checkpoint.unit.test.ts` (1, `findGitRoot` walked
up into the repo's `.git`). Both are fixed with the same test-only approach, so the entire
`src/goal` suite is now green.

## Failures found

14 in `backend-sandbox.test.ts`, 1 in `cli-worker.test.ts`:

- Codex status/config: `writes config and makes codex-linux-sandbox visible…`,
  `returns a structured fail-closed blocker until the Codex live probe…`,
  `reports proven only after the live permission-profile probe passes`,
  `fails closed when the real ~/.codex/auth.json read is not blocked`.
- Codex auth continuity: `symlinks the generated auth.json…`,
  `skips the auth symlink (no copy) when the real auth source is absent`.
- Claude status/probe: `returns a structured fail-closed blocker until the live
  probe…`, `reports supported only after the live deny/allow matrix passes`,
  `fails closed (unsupported) when a denied read succeeds…`, `reports unsupported when
  an allowed read fails…`, `classifies a not-logged-in / settings-not-honored failure…`,
  `classifies the known bwrap /newroot/libx32 startup failure…`, `runs status-only
  Claude subscription-auth differential probes…`, `reports generated-settings-hidden
  auth as a status-only blocker`.
- cli-worker: `uses Codex native permission-profile config for goal-worker launches`.

## Classification

**Group A — offline test incorrectly requiring an outside-agent host path (13 tests).**
Root cause: `vitest.config.ts` redirects `TMPDIR`/`TMP`/`TEMP` to `<repo>/.tmp/vitest`,
so under vitest `os.tmpdir()` resolves *inside the repo*. On this host the repo itself
lives under the real agent root (`~/smithersbot-goals/agent/...`, since
`SMITHERSBOT_GOALS_ROOT` is unset and `resolveManagedRoot()` defaults to
`~/smithersbot-goals`). These tests passed `workingDir: process.cwd()` (the real repo)
and a settings/sandbox root derived from `HOST_TEMP_ROOT` (= `os.tmpdir()`). Both sat
under the agent root and under the workspace, so the production guards in
`writeCodexNativeSandboxConfig` / `writeClaudeCodeSandboxSettings`
(`isPathInsideAgentRoot(...) || startsWith(workingDir)` →
*"must be outside agent-visible paths"*) threw, and the status/probe functions reported
`config-generation-failed` / `settings-generation-failed` instead of the expected
`live-probe-required` / `live-probe-failed` / `operator-action-required` /
`generated-settings-hiding-claude-auth`. The guards are correct production behavior; the
tests were host-dependent. (Confirmed: calling the same functions directly with an
outside-agent root returns `live-probe-required`.)

**Group B — stale assertion from older sandbox behavior (1 test).** `cli-worker`'s
`uses Codex native permission-profile config…` expected the codex exec args without
`--skip-git-repo-check`. Production now appends that trust-preflight skip
(`appendCodexNativeSandboxExecArgs`, also asserted by `appends the Codex trust preflight
skip once…`). Stale expectation, not a bug.

No true product regressions, no brittle-binary-discovery failures (the codex
binary-discovery `find` is mocked via `mockExecFileSync`).

## Files changed

- `src/goal/backend-sandbox.test.ts` — added `setupIsolatedSandboxRoots()`: it points
  `SMITHERSBOT_GOALS_ROOT` at a fresh fixture managed root, creates a fixture
  `workingDir` under it, returns a sibling `sandboxRoot` (outside the fixture agent
  root, not a parent of `workingDir`), and registers env-restore + cleanup via
  `onTestFinished` so the test body stays flat. The 14 failing tests now take
  `workingDir`/`sandboxRoot` from the helper instead of `process.cwd()` /
  `HOST_TEMP_ROOT`; two `cwd: process.cwd()` spawn assertions became `cwd: workingDir`.
- `src/goal/cli-worker.test.ts` — added `--skip-git-repo-check` to the expected codex
  exec args (one line).
- `src/goal/cli-planner.test.ts` — the planner runs in `process.cwd()`; under vitest the
  managed root and `codexSandboxRoot` are mkdtemp'd under `os.tmpdir()` (= the repo), so
  `codexHome.startsWith(workingDir)` fail-closed. `beforeEach` now spies `process.cwd()`
  to a fixture checkout `<managedRoot>/checkout/smithersbot/repo` — *outside* the fixture
  agent root (mirrors a normal CI checkout, so repo-chat `executionRoot` resolves to the
  workspace), keeping the workspace name `smithersbot` so every path assertion stays
  valid. The sibling `codexSandboxRoot` is then outside the agent root and not a parent
  of `workingDir`. `afterEach` restores the spy.
- `src/goal/git-checkpoint.unit.test.ts` — `findGitRoot returns null when no .git is
  found` walked up from an `os.tmpdir()` dir that, under vitest, lives inside this git
  repo (so it found the repo's `.git`). It now walks a synthetic absolute path whose
  ancestors down to `/` contain no `.git`.

No production files changed in this round — all fixes are test-only. (The
`backend-sandbox.ts` / `sandbox-probes.ts` diffs in the working tree are the earlier
exact-file deny fix.)

## Why offline tests are now deterministic

- They no longer depend on where the checkout lives or on `os.tmpdir()`: the agent root,
  workspace, and sandbox root are all fixture temp dirs created per test with a fixed
  relative layout, so the guards always see the sandbox config *outside* the agent root
  and *outside* the workspace — independent of host or `SMITHERSBOT_GOALS_ROOT`.
- They do not require `/home/matt` or any real host path, real bwrap/Claude/Codex, or
  subscription login. Live host execution stays mocked (`mockExecFileSync` /
  `mockSpawnSync`); the tests assert only the structured status/probe contract.
- `onTestFinished` restores `SMITHERSBOT_GOALS_ROOT` and removes the temp dirs even on
  failure, so there is no cross-test leakage.

## How to run the explicit live proofs

Live proofs remain opt-in and never faked:

- `it.runIf(isLiveSandboxProbeEnabled())(...)` in `sandbox-probes.test.ts` runs the full
  goal-worker live probe only when `SMITHERSBOT_SANDBOX_LIVE_PROBES=1`; otherwise it is
  skipped and the readiness tests assert `status: "not-run"` with a reason naming the
  env var.
- Claude / Codex native status live probes are gated by
  `SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES=1` / `SMITHERSBOT_CODEX_SANDBOX_LIVE_PROBES=1`.

Commands:

```
# Claude live differential probe (requires bwrap + Claude Code subscription login)
SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES=1 pnpm vitest run src/goal/sandbox-probes.test.ts

# Full goal-worker live sandbox probe (requires real host sandbox support)
SMITHERSBOT_SANDBOX_LIVE_PROBES=1 pnpm vitest run src/goal/sandbox-probes.test.ts
```

## Verification results

```
# Focused offline command (the task's success criteria)
pnpm vitest run src/goal/backend-sandbox.test.ts src/goal/sandbox-probes.test.ts src/goal/cli-worker.test.ts
  → 108 passed | 1 skipped (0 failed)   [skip = gated live worker probe]

# Full goal-system suite (extended under the "all tests pass" directive)
pnpm vitest run src/goal
  → 925 passed | 9 skipped (0 failed), 48 files

pnpm exec tsc -p tsconfig.json   → exit 0
pnpm build                       → exit 0
pnpm lint                        → 0 warnings, 0 errors

# Live proof remains explicit and green
SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES=1 pnpm vitest run src/goal/sandbox-probes.test.ts
  → 5 passed | 1 skipped
```

No sandbox deny assertions were weakened and the new exact-file deny coverage from the
prior task is untouched.

## Out of scope: pre-existing failures elsewhere in the repo

A full `pnpm vitest run` shows 26 failures across 15 files in **unrelated subsystems**
(none in `src/goal`/sandbox): `pairing/pairing-messages`, `commands/models.list`,
`docs/terminal-css`, `channels/plugins/catalog`, `agents/system-prompt-params`,
`channels/registry`, `canvas-host/server`, several `commands/*`, `utils/message-channel`,
`docs/slash-commands-doc`, and `test/setup-smithersbot`. They are pre-existing (my changes
are confined to `src/goal` test files) and are a mix of genuine domain issues — e.g.
`docs/assets/terminal.css` missing (ENOENT), `msteams` absent from the channel catalog,
`models.list` emitting `"No models found."` instead of JSON, pairing message/branding text
— plus a few that share the same vitest-tmp environmental class fixed here (e.g.
`agents/system-prompt-params` cwd). Fixing them spans many subsystems and includes real
product/domain decisions, so they are outside this sandbox test-gating task and are left
for a separate, scoped effort.
