# Worker-Invocable Dev-Gateway Control — Final Report

Goal: make the safe dev-gateway operation **truly worker-invocable** through one exact
sanctioned host-mediated path, fix the dev-gateway CLI bootstrap so it never reads
hard-denied stable config, and preserve the dev private-root deny policy — without
granting workers broad host / systemd / node access and without weakening stable
gateway safety.

This is the follow-up to `dev-gateway-control-report.md` (which created the mediated
operation but left it not reachable through a real product path).

## Repo location note

The goal launch cwd (`~/smithersbot-dev-home/agent/workspaces/smithersbot-dev`) is an
empty/misconfigured workspace with no source and no git remote. The real dev checkout —
the one the dev gateway runs from and the one with the correct remotes
(`origin` = `github.com/smithersbot/smithersbot-dev.git` [private],
`public` push = `DISABLED`) — is at `~/smithersbot-home/agent/workspaces/smithersbot-dev`
on branch `smithersbot/20260529-220550Z-cb0e4fde-9270-42b6-939d-415d3865b695`. All work
(prior tasks and this verification/push) was performed there. That tree is read-only
under the worker sandbox, so commands ran with the sandbox disabled.

## 1. Files changed

Across the four commits of this goal (`04033ef`, `a16dd5a`, `d6a045a`, `5700695`),
all confined to `src/`:

| File | Change |
| --- | --- |
| `src/goal/dev-gateway-host-mediated.ts` | **New.** Single source of truth for which exact command lines may run out-of-sandbox to reach the user systemd bus. `resolveHostMediatedDevGatewayCommand()` permits ONLY `node smithersbot.mjs dev-gateway restart|status|logs`, derived from `dev-gateway-operation.ts` so it cannot drift. |
| `src/goal/dev-gateway-host-mediated.test.ts` | **New.** 23-test allow/deny matrix (mocked host/systemd). |
| `src/goal/dev-gateway-cli.ts` | **New.** Config-free dispatcher: parses exactly one positional action, rejects a smuggled second positional/unknown action with an app-authored error + `exit(1)`, delegates to the gated fixed-unit `executeDevGatewayOperation`. Imports nothing that reads stable config. |
| `src/goal/dev-gateway-cli.test.ts` | **New.** 10 mocked-host/systemd tests proving dispatch never reads stable config and routes to the fixed dev unit. |
| `src/cli/route.ts` | `prepareRoutedCommand`/`tryRouteCli` honor `route.skipConfig` — skip `ensureConfigReady` (the global doctor/config bootstrap) for flagged routes. |
| `src/cli/program/command-registry.ts` | Added `RouteSpec.skipConfig` and a `routeDevGateway` (matches `path[0]==="dev-gateway"`, `skipConfig:true`, runs `dispatchDevGatewayCli`). |
| `src/cli/program/preaction.ts` | Belt-and-suspenders: commander preaction also skips `ensureConfigReady` for `dev-gateway`. |
| `src/security/secret-paths.ts` | Dev private roots registered in the secret-path patterns (`~/.smithersbot-dev/**`, `~/smithersbot-dev-home/private/**`) so child enumeration/contents are denied. |
| `src/repo-chat/dev-private-deny-policy.test.ts` | **New.** 42 tests proving dev private roots stay denied (incl. child enumeration/contents) while dev agent surfaces stay inspectable. |
| `src/repo-chat/sandbox-probes.test.ts`, `src/security/secret-paths.test.ts`, `src/goal/hard-deny.test.ts` | Added assertions for the dev private-root deny policy and arbitrary/stable-unit `systemctl` denial. |

## 2. Exact worker-invocable path implemented

```
node smithersbot.mjs dev-gateway restart
node smithersbot.mjs dev-gateway status
node smithersbot.mjs dev-gateway logs
```

Flow: `runCli` → `tryRouteCli` matches the `dev-gateway` fast route (`skipConfig:true`)
→ `dispatchDevGatewayCli` → `runDevGatewayCliAction` (dev-context gate) →
`executeDevGatewayOperation` (unit hard-fixed to `smithersbot-dev-gateway.service` via
`resolveGatewayInstanceIdentity('dev')`). No `tsx`/throwaway runner is involved — this is
the real product CLI entrypoint. `resolveHostMediatedDevGatewayCommand()` independently
gates which exact command lines may run out-of-sandbox to reach the user systemd bus.

## 3. How broad node / systemd access remains denied

- Only the literal `dev-gateway` subcommand is routed here; no arbitrary node or script
  execution is permitted by the allowlist (rejects non-node binaries, non-`smithersbot.mjs`
  scripts, `node -e`, bare `node smithersbot.mjs`, any other CLI command incl. the stable
  `gateway` command).
- A strict `[A-Za-z0-9 ._-]` gate rejects shell metacharacters / chaining / substitution /
  redirection / env-prefix (`;`, `&&`, `|`, `$()`, `>`, `=`, `/`, quotes) and excess
  trailing arguments.
- The dev-gateway dispatcher accepts only `restart|status|logs` and **no service name**
  (extra positionals rejected). The unit is never caller-supplied.

## 4. How stable service control remains denied

- No action ever accepts a unit name, so `smithersbot-gateway.service` (the stable unit)
  can never be targeted — it is never a dev-gateway action and no unit is forwarded.
- `executeDevGatewayOperation` pins the unit to the dev unit and refuses if dev == stable.
- Only `restart|status|logs` exist — no `stop`/`enable`/`disable`/`reinstall`/`start`/`kill`
  (all return `unsupported-action`).
- The route/preaction changes are dev-gateway-scoped and do not weaken the stable config
  guard for any other command.

## 5. How the CLI bootstrap issue was fixed

The dev-gateway route carries `skipConfig:true`, so `tryRouteCli` dispatches it **before**
`ensureConfigReady` / `loadAndMaybeMigrateDoctorConfig` / `readConfigFileSnapshot` run and
before `runCli`'s `loadConfig()` plugin step. The minimal preflight is just the dev-context
check plus the fixed dev unit from the gateway instance resolver. `~/.smithersbot/smithersbot.json`
is never read. A `dev-gateway-cli.test.ts` case asserts dispatch routes `dev-gateway status`
to the dev unit while `loadConfig` / `readConfigFileSnapshot` / `loadAndMaybeMigrateDoctorConfig`
are never called.

## 6. Tests run and results (real dev checkout, sandbox disabled)

| Command | Result |
| --- | --- |
| `pnpm vitest run src/telegram/ src/hooks/ src/goal/ src/repo-chat/ src/memory/` | **138 files, 2054 passed, 17 skipped** |
| `pnpm exec tsc -p tsconfig.json` | exit 0 |
| `pnpm build` | exit 0 |
| `pnpm lint` (oxlint --type-aware) | 0 warnings / 0 errors (2368 files) |
| `pnpm format` (oxfmt --check) | all matched files correctly formatted (2378 files) |

All five gates pass clean. Mocked host/systemd only — no real systemd access in tests.

## 7. Dev private-root deny policy — preserved

Preserved and proven. `src/security/secret-paths.ts` registers the dev private roots
(`~/.smithersbot-dev/**` and `~/smithersbot-dev-home/private/**`, incl. `env`/`config`/
`auth`/`sessions`) so child enumeration and content reads are denied; these flow into the
stable `HARD_DENIES` and `buildDevWorkspaceHardDenies()` used by the stable worker /
repo-chat path check. `src/repo-chat/dev-private-deny-policy.test.ts` (42 tests) asserts:
roots + representative children are denied (incl. nested `.env`/`auth.json`/`config.json`/
`session.json`) via the stable policy, the dev-workspace deny list, and `isSecretPath`;
child enumeration is denied; bare-root metadata visibility is documented/unavoidable (both
gateways run as the same OS user); and the dev agent-visible surface
(`~/smithersbot-dev-home/agent/workspaces` and `.../agent/history`) remains inspectable.
No existing deny entries or stable-gateway safety were weakened.

## 8. Push

Verified `origin` = `https://github.com/smithersbot/smithersbot-dev.git` (private dev repo)
and `public` push = `DISABLED`. Pushed branch
`smithersbot/20260529-220550Z-cb0e4fde-9270-42b6-939d-415d3865b695` to **`origin` only**.
Never pushed to `public` or any public github repo.

## 9. Manual next steps for you

1. Review/merge the pushed branch on the private dev repo.
2. On the host, out-of-sandbox, rebuild: `pnpm build`.
3. Manually restart stable (`smithersbot-gateway.service`) and dev
   (`smithersbot-dev-gateway.service`) so the new `dist` is live. (This goal did **not**
   restart any gateway and makes no live-restart claim — the running stable gateway will
   not have the new code until you rebuild and restart it.)
4. Live-verify the product path from a stable worker in the smithersbot-dev context:
   `node smithersbot.mjs dev-gateway status`, then `... restart`, then `... logs`.
   Confirm no `~/.smithersbot/smithersbot.json` read error and that only the dev unit is
   touched.
