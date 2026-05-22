# Stage 2U-A Live Proof And Restart Gate Report

Generated: 2026-05-22. Host: managed dev VM (Linux 6.8.0). Codex: `codex-cli
0.133.0`. Claude Code: `2.1.143 (Claude Code)`.

This report records STATUS RESULTS, EXIT CODES, and NON-SECRET ERROR-CLASS
KEYWORDS / BOOLEANS ONLY. No auth file, token, env value, secret, or config
secret was printed, hashed, encoded, summarized, or persisted at any point. Every
live probe redirects file reads to `/dev/null` and emits only `<marker>=<exit>`
booleans, so no contents can leak through stdout. The Codex auth-continuity fix
uses a symlink (never a copy), so no auth contents are duplicated or written
anywhere (confirmed: 2 generated `auth.json` references under
`/var/tmp/smithersbot-codex-*` are symlinks, 0 are regular files).

Scope: this task ran the verification sweep + host-side live proofs and wrote
this single report. The gateway was **NOT** restarted. No global Codex/Claude
config was changed (per-run homes/settings live under `/var/tmp` / `os.tmpdir()`,
outside agent-visible and repo paths). No sandbox deny rule was weakened and no
broad read grant was added.

---

## 1. Status summary (required fields)

| Field | Result |
| --- | --- |
| Codex authenticated exec | **succeeded** |
| Codex filesystem sandbox | **succeeded** |
| SECURITY_FAILURE_read_succeeded | **no** |
| AUTH_CONTINUITY_FAILURE | **no** |
| SAFE_READ_FAILURE | **no** |
| Claude live sandbox | **environment-blocked** (NOT proven — pending operator login) |
| Gateway unit resolved | `moltbot-gateway-dev.service` |
| **safe to run `/gateway_restart`** | **yes** |

Determination rule (restart safe ONLY if all hold): Codex authenticated exec
succeeds AND Codex filesystem sandbox proof succeeds AND no
SECURITY_FAILURE_read_succeeded AND no AUTH_CONTINUITY_FAILURE AND no
SAFE_READ_FAILURE. **All five conditions are met → restart is safe.** Claude is
not required for Codex-only restart readiness; its status (environment-blocked /
still pending) is reported explicitly in §5 and does not block the Codex-only
restart gate.

---

## 2. Verification sweep (all exit 0)

Run from the repo root
(`/home/matt/smithersbot-goals/agent/workspaces/smithersbot/repo`):

| Command | Result | Exit |
| --- | --- | --- |
| `pnpm vitest run src/goal/backend-sandbox.test.ts src/goal/sandbox-probes.test.ts src/repo-chat/sandbox-probes.test.ts` | 33 passed, 2 skipped (the 2 live-bwrap probes skip without the live env flags) | 0 |
| `pnpm exec tsc -p tsconfig.json` | clean | 0 |
| `pnpm build` | tsc + copy steps OK | 0 |
| `pnpm lint` | 0 warnings, 0 errors (2326 files) | 0 |

---

## 3. Codex authenticated exec proof (worker launch shape)

Driven through the **same generated CODEX_HOME / PATH / permission-profile launch
shape the real goal-worker/repo-chat path uses** — `writeCodexNativeSandboxConfig`
(generated `CODEX_HOME` under `/var/tmp/smithersbot-codex-<runId>/` with the
`default_permissions = "smithersbot"` `config.toml`, the `bin/codex-linux-sandbox`
helper symlink, and the `auth.json` symlink to the real source) +
`mergeCodexNativeSandboxEnv` (`CODEX_HOME=<generated home>`,
`PATH=<home>/bin:$PATH`), then `codex exec --json --cd <executionRoot>`. **No**
plain normal-user `codex exec` was used; **no** `--sandbox` / `workspace-write` /
`danger-full-access` / `--dangerously-bypass-approvals-and-sandbox` flags were
emitted.

Command (env: `SMITHERSBOT_CODEX_SANDBOX_ROOT=/var/tmp`; emits booleans/exit
only, never contents):

```sh
node --import tsx -e '
import { writeCodexNativeSandboxConfig, mergeCodexNativeSandboxEnv } from "./src/goal/backend-sandbox.ts";
import { spawnSync } from "node:child_process";
const cfg = writeCodexNativeSandboxConfig({ workingDir: process.cwd(), runId: "auth-smoke-" + Date.now(), purpose: "goal-worker", sandboxRoot: "/var/tmp" });
const env = mergeCodexNativeSandboxEnv(process.env, cfg);
const r = spawnSync("codex", ["exec", "--json", "--cd", cfg.executionRoot, "Print exactly this and nothing else: codex-auth-ok"], { env, encoding: "utf8", timeout: 120000 });
const out = (r.stdout || "") + "\n" + (r.stderr || "");
console.log("exit=" + r.status);
console.log("auth_ok=" + (out.includes("codex-auth-ok") ? "yes" : "no"));
console.log("auth_error=" + (/unauthorized|401|403|authentication/i.test(out) ? "yes" : "no"));
'
```

Result (STATUS / EXIT / KEYWORD only):

```
codex_home_is_generated=yes      # CODEX_HOME under /var/tmp/smithersbot-codex-*
path_has_helper_dir=yes          # PATH starts with <generated home>/bin
auth_ref_is_symlink=yes          # generated auth.json is a symlink, not a copy
exit=0
auth_ok=yes                      # model returned exactly codex-auth-ok
auth_error=no                    # no unauthorized/401/403/authentication
```

This demonstrates the four required properties:

- **(a) generated-CODEX_HOME auth continuity works** — `exit=0`, `auth_ok=yes`,
  `auth_error=no` with the generated home + auth symlink (no env credentials, no
  copy);
- **(b) exact `codex-auth-ok` output** — `auth_ok=yes`;
- **(c) generated `CODEX_HOME/auth.json` blocked from the sandboxed shell** —
  proven in §4 by `codex_auth=1`;
- **(d) real `~/.codex/auth.json` blocked from the sandboxed shell** — proven in
  §4 by `real_codex_auth=1`.

→ **Codex authenticated exec: succeeded.** No AUTH_CONTINUITY_FAILURE.

---

## 4. Codex filesystem sandbox proof (deny/allow matrix)

Driven through `codexNativeSandboxStatus()` (the same config/helper generation
used by `buildCliArgs` / `buildCodexRepoChatArgs`), which launches
`codex sandbox linux --permissions-profile smithersbot --cd <executionRoot> sh
-lc '<probe>'` and requires the full deny/allow matrix to pass.

Command (env: `SMITHERSBOT_SANDBOX_LIVE_PROBES=1`,
`SMITHERSBOT_CODEX_SANDBOX_LIVE_PROBES=1`,
`SMITHERSBOT_CODEX_SANDBOX_ROOT=/var/tmp`; emits booleans only):

```sh
node --import tsx -e '
import { codexNativeSandboxStatus } from "./src/goal/backend-sandbox.ts";
const s = codexNativeSandboxStatus({ workingDir: process.cwd(), purpose: "goal-worker", sandboxRoot: "/var/tmp" });
console.log("proven=" + ("proven" in s ? s.proven : "n/a"));
if (!("proven" in s) || s.proven !== true) { console.log("blocker=" + s.blocker); console.log("reason=" + s.reason); }
'
```

Result:

```
proven=true
```

`proven=true` is returned ONLY when every check below holds (each read redirected
to `/dev/null` — booleans only, never contents):

| Check | Required | Meaning |
| --- | --- | --- |
| `readme=0` | allow | `README.md` readable |
| `env_example=0` | allow | `.env.example` readable |
| `env_local=1` | deny | repo `.env.local` blocked |
| `env_production=1` | deny | repo `.env.production` blocked |
| `env_test=1` | deny | repo `.env.test` blocked |
| `private_env=1` | deny | managed `/home/matt/smithersbot-goals/private/env/smithersbot/.env` blocked |
| `home_env=1` | deny | `~/.smithersbot/.env` blocked |
| `home_config=1` | deny | `~/.smithersbot/smithersbot.json` blocked |
| `codex_auth=1` | deny | generated `CODEX_HOME/auth.json` blocked from sandbox |
| `real_codex_auth=1` | deny | real `~/.codex/auth.json` blocked from sandbox |
| `symlink_escape=1` | deny | symlink workspace → private env blocked |
| workspace write `ok` | allow | managed workspace writable |

→ **Codex filesystem sandbox: succeeded.**
→ **SECURITY_FAILURE_read_succeeded: no** (no denied read returned exit 0; all
deny markers are `=1`).
→ **SAFE_READ_FAILURE: no** (`readme=0` and `env_example=0` — both safe reads
succeeded).

---

## 5. Claude live sandbox proof

Driven through the host-side script `scripts/prove-claude-sandbox.ts`, which
calls `claudeCodeNativeSandboxStatus()` (Claude driven via its generated
fail-closed `--settings` with `--allowedTools Bash`, no danger-skip flags) and
prints only status / exit / keyword booleans.

Command (env: `SMITHERSBOT_SANDBOX_LIVE_PROBES=1`,
`SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES=1`):

```sh
SMITHERSBOT_SANDBOX_LIVE_PROBES=1 SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES=1 \
  node --import tsx scripts/prove-claude-sandbox.ts
```

Result (STATUS / EXIT / KEYWORD only):

```
claude-live-sandbox: environment-blocked
blocker: operator-action-required
reason: Claude Code is not logged in, so the native sandbox deny/allow live probe could not run.
operator-command: claude /login && SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES=1 node --import tsx scripts/prove-claude-sandbox.ts
exit: 2
```

**Claude live sandbox: environment-blocked → NOT proven, still pending.** The
exact blocker is operator authentication: Claude Code is not logged in for this
context, and the worker cannot supply auth because `~/.claude/**` is hard-denied.
The deny/allow matrix code path (managed private env / repo `.env.local` /
symlink-escape BLOCKED; `README.md` / `.env.example` ALLOWED) is implemented and
unit-tested; it will report `supported` only when an operator runs the probe
above in a logged-in Claude context. No Claude secret-read isolation is claimed
on this host. (If, after login, Claude surfaces the known
`bwrap: Can't mount tmpfs on /newroot/libx32` startup error, that is classified
as a separate operator-action blocker and must also be resolved before Claude is
proven.)

---

## 6. Gateway unit resolution

Read-only resolution via `scripts/resolve-gateway-systemd-unit.ts`:

```sh
node --import tsx scripts/resolve-gateway-systemd-unit.ts
```

Output on this host:

```
moltbot-gateway-dev.service
```

This is the legacy unit currently active on this host, resolved by
`resolveGatewaySystemdRestartUnit()` (first active among
`smithersbot-gateway.service`, `moltbot-gateway-dev.service`,
`moltbot-gateway.service`, after the env-override precedence).

---

## 7. Restart gate determination

| Gate condition | Status |
| --- | --- |
| Codex authenticated exec succeeds | ✅ yes (§3) |
| Codex filesystem sandbox proof succeeds | ✅ yes (§4) |
| No SECURITY_FAILURE_read_succeeded | ✅ yes (§4) |
| No AUTH_CONTINUITY_FAILURE | ✅ yes (§3) |
| No SAFE_READ_FAILURE | ✅ yes (§4) |

All Codex restart-gate conditions are met. Claude is environment-blocked and is
NOT required for the Codex-only restart gate; it remains pending operator login
(§5) and must be live-proven before any Claude secret-read isolation is claimed
or Claude-only dogfood is marked ready.

**safe to run /gateway_restart: yes**

(Codex-only restart readiness. The gateway was not restarted by this task; an
operator must run `/gateway_restart` against `moltbot-gateway-dev.service`. The
restart command itself is out of scope here and is denied to the worker.)
