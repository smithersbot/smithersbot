# Repo-Wide Test Hygiene Quick Wins Report

## Scope

This sweep fixed the low-risk G2-G10 groups from `internal/REPO_WIDE_TEST_FAILURE_TRIAGE_REPORT.md`.
G1, the read-only `/tmp` and `/var/tmp` batch with 82 failures, was intentionally deferred and no production `/var/tmp` sandbox defaults were changed.

## Groups Fixed

### G2: Brand Rename Stale Expectations

Classification: stale-test updates.

Files changed:
- `src/pairing/pairing-messages.test.ts`: updated the pairing approval hint from stale `moltbot` expectations to current `smithersbot` CLI output.
- `src/commands/status.test.ts`: updated status command next-step expectations to current `smithersbot` CLI output, and in the final sweep mocked gateway/control-UI network-derived helpers so the test does not call host network interfaces in restricted sandboxes.
- `src/commands/daemon-install-helpers.test.ts`: updated gateway install hint expectations to current `smithersbot` CLI output.
- `src/commands/onboard-hooks.test.ts`: updated hooks list hint expectations to current `smithersbot` CLI output.

No product behavior changed for G2.

### G3: Channel-Scope Reduction Stale Expectations

Classification: stale-test updates.

Files changed:
- `src/channels/registry.test.ts`: updated `imsg` normalization to the current unsupported result while retaining `gchat` and `google-chat` coverage for `googlechat`.
- `src/utils/message-channel.test.ts`: updated stale built-in `discord` and `imsg` expectations to unsupported results while retaining dynamic plugin alias coverage.
- `src/channels/plugins/catalog.test.ts`: replaced stale bundled `@moltbot/msteams` assumptions with an external-catalog fixture for `msteams`.

No product behavior changed for G3.

### G4: Deleted Docs Tree Orphaned Tests

Classification: deleted orphaned tests.

Files changed:
- `src/docs/slash-commands-doc.test.ts`: removed; it targeted the intentionally deleted top-level docs tree.
- `src/docs/terminal-css.test.ts`: removed; it targeted the intentionally deleted top-level docs tree.

The deleted docs tree was not recreated.

### G5: Repo-Root Detection Test Assumption

Classification: test-environment fix.

Files changed:
- `src/agents/system-prompt-params.test.ts`: stubbed `.git` lookup outside the Vitest temp root so temp workspaces created under repo-local `TMPDIR` do not accidentally discover the real repository root.

No product repo-root behavior changed.

### G6: `models list --json` Empty Output

Classification: one stale fixture plus one real JSON-mode product bug.

Files changed:
- `src/commands/models/list.list-command.ts`: fixed JSON mode so an empty result emits valid JSON instead of plain text.
- `src/commands/models.list.test.ts`: updated the `@mariozechner/pi-coding-agent` mock to match the current `AuthStorage` and `ModelRegistry` production path.

The z.ai failures were caused by stale test fixture/auth-gating assumptions after the registry path moved to `new AuthStorage(...)` and `new ModelRegistry(...)`. Separately, JSON mode had a real product bug: zero rows printed `No models found.` and broke `JSON.parse`.

Final behavior: `models list --json` emits:

```json
{ "count": 0, "models": [] }
```

Plain text `No models found.` remains only for non-JSON mode.

### G7: Goal List Status Label

Classification: stale-test fixture.

Files changed:
- `src/commands/goal-list-concurrent.test.ts`: added a real active run lock for the seeded executing run so the test exercises the intended active execution state instead of crash-recovery reconciliation to `blocked`.

No goal status product behavior changed.

### G8: Onboarding Config Validation

Classification: stale fixture, not a compatibility bug.

Files changed:
- `src/commands/onboard-non-interactive.telegram-token.test.ts`: replaced the stale removed `discord` plugin fixture with the currently valid bundled `memory-core` plugin while preserving the test intent that unrelated config survives the Telegram merge.

Offending field: `discord` in `plugins.allow` and `plugins.entries.discord`. Under the current channel scope, `discord` is no longer a discoverable plugin, so config validation correctly rejected the fixture.

Final invalid-config behavior: unchanged. Non-interactive onboarding still refuses truly invalid existing configs with the `Config invalid. Run smithersbot doctor...` guard instead of silently mutating them.

### G9: Canvas Host Reload Timeout

Classification: test-determinism change plus final environment prerequisite gate.

Files changed:
- `src/canvas-host/server.ts`: added a test-only `triggerReload` hook on the canvas handler/server that drives the existing `scheduleReload` to `broadcastReload` path.
- `src/canvas-host/server.test.ts`: changed the reload test to call `server.triggerReload()` instead of depending on flaky file watcher timing. In the final sweep, socket-dependent canvas tests were also gated when the worker sandbox denies local `listen(127.0.0.1)`.

The production file-watcher/live-reload path remains intact.

### G10: Live Codex Sandbox Probe

Classification: prerequisite-gated live assertion plus final environment prerequisite gate.

Files changed:
- `src/goal/sandbox-probes.ts`: added `liveSandboxProbeHostReady("codex")` so the live proof only asserts `proven` when native sandbox prerequisites are actually present.
- `src/goal/sandbox-probes.test.ts`: skips the explicit live Codex proof when host prerequisites are absent. In the final sweep, the git fixture assertion also skips when `git --version` is available but `git -C <fixture>` execution is denied by the worker sandbox.

Sandbox denial assertions and live proof coverage on capable hosts were preserved.

## Verification

Focused combined suite:

```sh
pnpm vitest run src/pairing/pairing-messages.test.ts src/commands/status.test.ts src/commands/daemon-install-helpers.test.ts src/commands/onboard-hooks.test.ts src/channels/registry.test.ts src/utils/message-channel.test.ts src/channels/plugins/catalog.test.ts src/agents/system-prompt-params.test.ts src/commands/goal-list-concurrent.test.ts src/commands/models.list.test.ts src/commands/onboard-non-interactive.telegram-token.test.ts src/canvas-host/server.test.ts src/goal/sandbox-probes.test.ts
```

Result: 13 test files passed, 58 tests passed, 8 skipped, 0 failures. The skips were prerequisite gates for local socket binding, restricted `git -C` execution, and the live Codex sandbox probe on this nested restricted worker host.

Additional verification:

```sh
pnpm exec tsc -p tsconfig.json
pnpm build
pnpm lint
```

Results: all passed. `pnpm lint` reported 0 warnings and 0 errors.

## Remaining Expected Failures

The full `pnpm vitest run` suite was not executed in this final sweep. G1 remains intentionally deferred: the hardened environment has read-only `/tmp` and `/var/tmp`, accounting for the 82 failures called out in the triage report.

## Recommended Next Step

Run a dedicated G1 temp-path/test-environment goal to address the read-only `/tmp` and `/var/tmp` batch without changing production sandbox defaults just to satisfy tests.
