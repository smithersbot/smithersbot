# Dev-Gateway Live-Test & Stable/Dev Isolation Report

- **Checkout:** `/home/matt/smithersbot-home/agent/workspaces/smithersbot-dev` (real source checkout)
- **Date:** 2026-05-29
- **Scope:** Live-test of the safe worker-invocable dev-gateway control path and stable/dev isolation. No product code modified. Nothing pushed. No secret values included (denied paths referenced by name only).
- **Overall verdict: ✅ PASS** — every assertion below passed.

> **Sandbox note:** The worker sandbox cannot reach the user systemd bus and runs in an isolated net namespace. Raw `systemctl --user …` and direct curls to 18789/18790 fail under the sandbox. Per the operator-authorized live test and the documented sandbox-failure rule, the systemd-touching mediated ops were re-run with the sandbox disabled; argument-validation deny cases and the vitest suites were run sandboxed. This is a test-harness limitation, not a failure of the gateway control path.

---

## Assertion results

| # | Assertion | Command(s) | Exit status | Evidence | Verdict |
|---|-----------|-----------|-------------|----------|---------|
| 1 | Preflight: pwd is exactly the real checkout | `pwd` | 0 | `/home/matt/smithersbot-home/agent/workspaces/smithersbot-dev` — exact match | ✅ PASS |
| 2 | Preflight: required files/dirs exist | existence checks for `package.json`, `src/`, `CLAUDE.md`, `AGENTS.md`, `src/goal/dev-gateway-operation.ts`, `dist/entry.js`, `smithersbot.mjs` | 0 | All present; `src/` is a dir (60 entries); `smithersbot.mjs` imports `./dist/entry.js` (line 14). Confirms real checkout, not the empty `~/smithersbot-dev-home/...` workspace | ✅ PASS |
| 3 | `status` touches only the dev unit | `node smithersbot.mjs dev-gateway status --json` | 0 | `serviceUnit='smithersbot-dev-gateway.service'`, `activeState.active=true`, `runtime.status='running'`, pid=105856 | ✅ PASS |
| 4 | `restart` touches only the dev unit | `node smithersbot.mjs dev-gateway restart --json` | 0 | Output `Restarted systemd service: smithersbot-dev-gateway.service`; `serviceUnit='smithersbot-dev-gateway.service'` | ✅ PASS |
| 5 | `logs` touches only the dev unit | `node smithersbot.mjs dev-gateway logs --json` | 0 | `serviceUnit='smithersbot-dev-gateway.service'`, 81 log lines; no reference to the stable unit token (`/[^-]smithersbot-gateway\.service/` ⇒ false) | ✅ PASS |
| 6 | Dev remains on 18790 after restart | `ss` / log inspection | 0 | DEV restarted (MainPID 105856⇒129941, ActiveEnterTimestamp ⇒ `Fri 2026-05-29 21:14:44 EDT`, NRestarts=0); child PID 130116 logged `listening on ws://127.0.0.1:18790`; `ss` confirms `127.0.0.1:18790` and `[::1]:18790` LISTEN. **Dev confirmed on 18790** | ✅ PASS |
| 7 | Stable unit denied as caller-supplied target | `node smithersbot.mjs dev-gateway restart smithersbot-gateway.service` | 1 | App-authored refusal before any systemctl call: *"Dev gateway control accepts a single action (restart \| status \| logs) and no service name; unexpected argument …"* — no service touched | ✅ PASS |
| 8 | Arbitrary service name denied | `node smithersbot.mjs dev-gateway restart some-other.service`; `dev-gateway smithersbot-gateway.service`; `dev-gateway some-other.service`; `dev-gateway stop`; `dev-gateway enable` | 1 (each) | Each refused with clean app-authored non-zero exit (unexpected-argument / unsupported-action messages). Unit is hard-derived via `resolveGatewayInstanceIdentity('dev').serviceUnit`, never caller-supplied | ✅ PASS |
| 9 | Stable on 18789 and NOT restarted | `systemctl --user show smithersbot-gateway.service …` (before/after); `ss` | 0 | After dev restart: MainPID=127052 (UNCHANGED), ActiveEnterTimestamp=`Fri 2026-05-29 20:57:15 EDT` (UNCHANGED), NRestarts=0; `ss` shows `127.0.0.1:18789` LISTEN still owned by pid 127116. **Stable untouched, still on 18789** | ✅ PASS |
| 10 | Deterministic deny-matrix tests pass | `pnpm vitest run src/goal/dev-gateway-host-mediated.test.ts src/cli/program/register.dev-gateway.test.ts src/goal/dev-gateway-cli.test.ts` | 0 | 3 files / 41 tests passed (8 + 23 + 10) | ✅ PASS |
| 11 | Stable CAN inspect dev agent workspaces | `ls ~/smithersbot-dev-home/agent/workspaces` | 0 | Listing: `smithersbot-dev`. Live policy: `isSecretPath=false`, `checkPathDeny=null` ⇒ ALLOWED | ✅ PASS |
| 12 | Stable CAN inspect dev agent history | `ls ~/smithersbot-dev-home/agent/history` | 0 | Listing: `cron`, `goals`, `index`, `repo-chats`. Live policy: ALLOWED | ✅ PASS |
| 13 | Stable CANNOT enumerate/read `~/.smithersbot-dev` | live deny-policy eval against `dist/security/secret-paths.js` + `dist/goal/hard-deny.js` | 0 (policy node) | `/home/matt/.smithersbot-dev` (enumerate) ⇒ `isSecretPath=true`, deny `~/.smithersbot-dev/**`; `…/smithersbot.json` and `…/sessions/x.json` ⇒ denied `~/.smithersbot-dev/**`. **No contents printed** | ✅ PASS |
| 14 | Stable CANNOT enumerate/read `~/smithersbot-dev-home/private` | live deny-policy eval (same) | 0 (policy node) | `/home/matt/smithersbot-dev-home/private` (enumerate) ⇒ `isSecretPath=true`, deny `~/smithersbot-dev-home/private/**`; `…/env/smithersbot-dev/.env` and `…/auth/auth.json` ⇒ denied `~/smithersbot-dev-home/private/**`. **No contents printed** | ✅ PASS |
| 15 | Isolation deny-policy tests pass | `pnpm vitest run src/repo-chat/dev-private-deny-policy.test.ts` | 0 | 1 file / 42 tests passed | ✅ PASS |

---

## Notes on the isolation boundary

Stable and dev run as the **same OS user** (`matt`), so there is **no kernel boundary** — raw `ls`/`cat` of dev private roots succeed at the OS level. The isolation boundary is the SmithersBot **application** deny policy (`isSecretPath` / `checkPathDeny` / `HARD_DENIES` in `src/security/secret-paths.ts`). The policy was therefore evaluated against the actual resolved absolute paths (`RESOLVED_HOME=/home/matt`), and OS-level reads during probing had contents suppressed to `/dev/null` and were never printed.

Source ties:
- `src/security/secret-paths.ts` registers `~/.smithersbot-dev/**` and `~/smithersbot-dev-home/private/**`.
- `HOME_SECRET_DIRS` includes `.smithersbot-dev`; `HOME_NESTED_SECRET_DIRS` includes `smithersbot-dev-home/private`, keeping the sibling `~/smithersbot-dev-home/agent` tree inspectable while child enumeration/contents of the private roots are denied.

## Constraints honored

- No product code, `dist`, or unit files modified — `dev-gateway-live-test-report.md` is the only new file.
- Nothing pushed to GitHub.
- Stable gateway (`smithersbot-gateway.service`) and `~/.smithersbot` never touched.
- No secret values included; denied paths referenced by name only.

## Overall verdict

**✅ PASS** — All 15 assertions passed. The worker-invocable dev-gateway control path safely manages only `smithersbot-dev-gateway.service` (dev stays on 18790), refuses the stable unit and arbitrary caller-supplied service names with clean app-authored non-zero exits, leaves the stable gateway untouched on 18789, and the application deny policy correctly allows inspection of the dev agent workspaces/history while denying enumeration/reads of `~/.smithersbot-dev` and `~/smithersbot-dev-home/private`.
