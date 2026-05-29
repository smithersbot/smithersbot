# Safe Dev-Gateway Service Control for Stable Workers — Final Report

Goal: Add a safe gateway/host-mediated operation that lets stable workers running a
goal in the **smithersbot-dev** context restart / check status / read recent logs for
**only** `smithersbot-dev-gateway.service`, without giving workers broad host or systemd
access and without weakening the stable gateway protections.

## 1. Files changed

All changes are confined to `src/` (commits `c43ff6b` + `b454ac5`):

| File | Change |
| --- | --- |
| `src/goal/dev-gateway-operation.ts` | **New.** The mediated operation: fixed dev unit + exactly three actions (`restart`, `status`, `logs`); the single source of truth for advertised actions. |
| `src/goal/dev-gateway-operation.test.ts` | **New.** Focused tests proving the fixed-unit + three-action allowlist (mocked systemd only). |
| `src/daemon/systemd.ts` | Added host helpers `readSystemdServiceActiveState` (is-active) and `readSystemdServiceRecentLogs` (recent journal lines), following the existing `systemctl --user` / `journalctl` pattern. |
| `src/goal/cli-worker.ts` | Rewrote `DEV_GATEWAY_WORKER_INSTRUCTION` to point workers at the mediated operation (derived from the policy), gated to inject only when the dev context is active. |
| `src/goal/cli-worker.test.ts` | Tests: guidance present only when dev context active; advertises exactly the three dev-unit actions; never the stable unit; no raw dev `systemctl --user restart` instruction. |
| `src/goal/hard-deny.test.ts` | Test: arbitrary (non-dev/non-stable) service-name `systemctl` operations remain denied in the dev workspace. |

The capability is gated through `resolveDevGatewayWorkerContext({workingDir}).active`
(dev workspace **and** dev unit present) and the dev hard-deny set is selected in
`src/goal/agent-executor.ts` only when that context is active. Outside the dev context
the guidance/tool surface is absent and the standard `HARD_DENIES` block all
`systemctl --user restart`.

## 2. Exact implementation of the safe dev-gateway operation

`src/goal/dev-gateway-operation.ts`:

- **Fixed unit (never caller-supplied):**
  ```ts
  export const DEV_GATEWAY_OPERATION_UNIT = resolveGatewayInstanceIdentity("dev").serviceUnit;
  const DEV_GATEWAY_SERVICE_UNIT = DEV_GATEWAY_OPERATION_UNIT;          // smithersbot-dev-gateway.service
  const STABLE_GATEWAY_SERVICE_UNIT = resolveGatewayInstanceIdentity("stable").serviceUnit;
  const DEV_GATEWAY_OPERATION_ENV = { CLAWDBOT_SYSTEMD_UNIT: DEV_GATEWAY_SERVICE_UNIT };
  ```
  The unit is resolved from `resolveGatewayInstanceIdentity("dev")` — the resolver,
  never a hardcoded string — and pinned into the env passed to every systemd helper.
  The request shape accepts **only** an action; supplying any other key (e.g. a unit
  name) is rejected:
  ```ts
  if (keys.length !== 1 || !Object.hasOwn(input, "action")) {
    throw new Error("Dev gateway operation accepts only an action; the service unit is fixed to the dev gateway.");
  }
  ```

- **Exactly three allowed actions** (anything else throws):
  ```ts
  export const DEV_GATEWAY_OPERATION_ACTIONS = ["restart", "status", "logs"] as const;
  // ...
  throw new Error(`Unsupported dev gateway operation "${action}". Allowed actions: restart, status, logs.`);
  ```
  - `restart` → `restartSystemdService({ env: {CLAWDBOT_SYSTEMD_UNIT: dev-unit}, ... })`
  - `status`  → `readSystemdServiceActiveState(...)` (is-active) + `readSystemdServiceRuntime(...)`
  - `logs`    → `readSystemdServiceRecentLogs({ ..., lines: 80 })` (recent journal lines)

- **Stable can never be touched:** every helper is invoked with the dev-unit env only;
  there is no code path that passes the stable unit. A defensive guard refuses to run if
  the two identities ever resolve equal:
  ```ts
  function assertDevGatewayUnitOnly() {
    if (DEV_GATEWAY_SERVICE_UNIT === STABLE_GATEWAY_SERVICE_UNIT) {
      throw new Error("Refusing dev gateway operation because dev and stable units resolve equally.");
    }
  }
  ```

- **No stop/enable/disable/reinstall** is exposed — only the three actions above exist.

- **Guidance is derived from the policy** so the advertised tool can never drift from the
  enforced allowlist:
  ```ts
  export function describeDevGatewayMediatedActions(): string[] {
    const detail = {
      restart: `restart ${DEV_GATEWAY_OPERATION_UNIT}`,
      status: `status / is-active for ${DEV_GATEWAY_OPERATION_UNIT}`,
      logs: `recent journal lines for ${DEV_GATEWAY_OPERATION_UNIT}`,
    };
    return DEV_GATEWAY_OPERATION_ACTIONS.map((a) => `${a} — ${detail[a]}`);
  }
  ```

## 3. Proof that stable service control remains denied

- **Operation layer:** `executeDevGatewayOperation` only ever drives the dev unit; it
  accepts no unit name, and `assertDevGatewayUnitOnly()` aborts if dev==stable.
- **Hard-deny layer (`src/goal/hard-deny.ts`):** in the dev workspace the blanket
  `systemctl --user restart` deny is replaced with two dev-aware command denies:
  - `DEV_GATEWAY_RESTART_NON_DEV_PATTERN` — denies `systemctl [--user] restart <anything>`
    unless the unit is the dev gateway (covers stable, unknown, and unit-less restarts).
  - `DEV_GATEWAY_MANAGE_STABLE_PATTERN` — denies **any** `systemctl` subcommand
    (enable/start/stop/disable/reload/restart) that references the stable unit
    (`referencesStableGatewayUnit`).
  All other denies — secret/config paths including `~/.smithersbot`, publish/deploy,
  `moltbot gateway restart`, etc. — are preserved unchanged.
- **Guidance layer:** `DEV_GATEWAY_WORKER_INSTRUCTION` explicitly states the worker must
  *never restart, reinstall, stop, enable, disable, or otherwise modify
  smithersbot-gateway.service* and *never modify ~/.smithersbot*, and that the mediated
  operation "can never target smithersbot-gateway.service or any other unit."
- Verified by `src/goal/hard-deny.test.ts` and `src/goal/cli-worker.test.ts`.

## 4. Proof that arbitrary service names are denied

- **Operation layer:** the request schema rejects any payload other than a bare
  `action` (no `unit`/service-name field is accepted), and the action allowlist rejects
  anything outside `restart|status|logs`. Tested in `dev-gateway-operation.test.ts`
  (caller-supplied stable/arbitrary units rejected with **no** systemctl/journalctl call
  emitted for those units).
- **Hard-deny layer:** `DEV_GATEWAY_RESTART_NON_DEV_PATTERN` denies a `systemctl restart`
  of any non-dev unit name, and `hard-deny.test.ts` includes a case proving an arbitrary
  (non-dev, non-stable) service name is denied.

## 5. Exact tests / verification commands run (all passed)

```
pnpm vitest run src/telegram/ src/hooks/ src/goal/ src/repo-chat/ src/memory/
  → Test Files 135 passed (135); Tests 1973 passed | 17 skipped (1990)
pnpm exec tsc -p tsconfig.json   → exit 0 (no type errors)
pnpm build                       → exit 0
pnpm lint  (oxlint --type-aware) → 0 warnings, 0 errors
pnpm format (oxfmt --check)      → all matched files correctly formatted
```

Focused colocated tests included in the sweep:
`src/goal/dev-gateway-operation.test.ts` (6 tests), `src/goal/cli-worker.test.ts`,
`src/goal/hard-deny.test.ts`, `src/goal/dev-gateway-workspace.test.ts`. All systemd/host
operations are mocked (`vi.mock("node:child_process")`); **no real `systemctl`/journalctl
access is required in CI.**

## 6. Manual next steps for the operator (rebuild + restart STABLE)

The new capability ships in the **smithersbot-dev** checkout but does **not** become
active for stable workers until the running **stable** gateway is rebuilt and restarted
by you. From the stable checkout (`~/smithersbot-home/agent/workspaces/smithersbot-stable`):

1. Merge/pull these changes into the stable checkout (private `origin` only — never the
   public remote).
2. `pnpm install` (if deps changed — they did not here) and `pnpm build`.
3. Restart the stable gateway manually:
   `systemctl --user restart smithersbot-gateway.service`
   then `systemctl --user status smithersbot-gateway.service --no-pager`.
4. After stable is back up, exercise the mediated operation end-to-end against the
   **dev** unit (`smithersbot-dev-gateway.service`) — restart, then status, then logs —
   to confirm it works through the new host-mediated path.

## 7. Live verification disclaimer

**Live dev-gateway restart was NOT verified in this goal.** The mediated operation runs
host-side and only becomes active after you manually rebuild and restart the stable
gateway (step 6 above); the worker sandbox cannot reach the user systemd bus. No live
`systemctl`/journalctl call against any unit was made — all tests use mocked systemd. No
live dev-gateway restart verification is claimed.

Nothing was pushed; changes are committed locally (`b454ac5`) on the dev branch only.
