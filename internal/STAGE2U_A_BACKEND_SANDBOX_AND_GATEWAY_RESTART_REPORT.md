# Stage 2U-A Backend Sandbox And Gateway Restart Report

Generated: 2026-05-21. Host: managed dev VM (Linux 6.8.0). This report records the
full Stage 2U-A verification matrix, audit greps, and the live sandbox probes that
were actually executed through the SmithersBot launch path on this host.

> Live-probe policy: This report marks a backend's secret-read isolation as proven
> ONLY when its native-sandbox live probe passed through the SmithersBot launch path
> on this host. Codex passed. Claude did not (no agent auth available in the worker;
> see Claude sections).

---

## Codex version/path/package facts

- `codex --version`: **codex-cli 0.133.0**
- PATH entry (JS shim): `/home/matt/.nvm/versions/node/v22.22.0/bin/codex`
  → resolves to `/home/matt/.nvm/versions/node/v22.22.0/lib/node_modules/@openai/codex/bin/codex.js`
- Native binary (multicall): `/home/matt/.nvm/versions/node/v22.22.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`
  - Single 221 MB binary. **There is no separate `codex-linux-sandbox` executable**
    in the package; the Linux sandbox helper is embedded in this binary and is
    expected to be invoked under the name `codex-linux-sandbox` on `PATH`.
- bubblewrap: `/usr/bin/bwrap`; socat: `/usr/bin/socat`.
- `codex sandbox linux --help` flag is `--permissions-profile <NAME>` (plural) plus
  `-C, --cd <DIR>`. When `--cd` is given, `--permissions-profile` is required.

## Codex fix attempts and final working implementation

The implementation generates a per-run Codex home outside agent-visible paths under
`/var/tmp/smithersbot-codex-<runId>/` containing `config.toml` (a
`default_permissions = "smithersbot"` permission profile) and a
`bin/codex-linux-sandbox` symlink to the native binary, then launches
`codex sandbox linux --permissions-profile smithersbot --cd <executionRoot> ...`
with `CODEX_HOME=<run home>` and `PATH=<run home>/bin:$PATH`. No `--sandbox`,
`workspace-write`, `danger-full-access`, or `--dangerously-bypass-approvals-and-sandbox`
flags are used.

Fix attempts and findings on this host (each verified by direct CLI probe):

1. **First live probe through SmithersBot launch path failed** with:
   `bwrap: execvp codex-linux-sandbox: No such file or directory`.
2. Confirmed the helper is embedded in the single native binary (no standalone
   `codex-linux-sandbox`); the per-run `bin/codex-linux-sandbox` symlink is the
   correct shim and is created with `PATH` prepended.
3. Direct CLI experiment **A** (`codex sandbox linux -- sh -lc echo`, no profile)
   **passed** — proving the helper symlink on `PATH` is discoverable when codex
   ro-binds all of `/`.
4. Direct CLI experiments **C/D** (adding `--permissions-profile smithersbot`)
   reproduced the failure, isolating the cause to the permissions profile, not the
   helper symlink or the `--`/`--cd` argument shape.
5. **Root cause:** the generated profile granted `write` to the workspace and `deny`
   to specific secret files, but granted **no base read** to the rest of the
   filesystem. Under a restrictive permissions profile, codex builds the bwrap
   filesystem view from the profile, so `/var/tmp/.../bin/codex-linux-sandbox`,
   `/bin/sh`, and shared libraries were **not readable inside the sandbox**, first
   yielding `execvp codex-linux-sandbox` and then `Failed to execvp sh`.
6. **Final fix (this task):** add a base `"/" = "read"` grant to
   `[permissions.smithersbot.filesystem]` in `buildCodexPermissionProfileToml`
   (`src/goal/backend-sandbox.ts`). The workspace `write` rule and the per-file
   `deny` rules override the broad read by path specificity, so the helper, `sh`,
   libs, `README.md`, and `.env.example` stay readable while secrets stay denied.
   `"/"` is an **allow (read)**, not a recursive deny — the "no broad recursive
   denies over /" requirement is preserved (`deniedReadPaths` still excludes `/`,
   `~`, `~/.smithersbot`, `~/.codex`).

## Codex live probe result

**PASSED through the SmithersBot launch path** (`SMITHERSBOT_CODEX_SANDBOX_LIVE_PROBES=1`,
via `codexNativeSandboxStatus()`, which generates the same config/helper used by
`buildCliArgs` and `buildCodexRepoChatArgs`):

```json
{
  "proven": true,
  "codexPath": "/home/matt/.nvm/versions/node/v22.22.0/bin/codex",
  "version": "codex-cli 0.133.0",
  "configPath": "/var/tmp/smithersbot-codex-live-codex-<ts>/config.toml",
  "helperPath": "/var/tmp/smithersbot-codex-live-codex-<ts>/bin/codex-linux-sandbox",
  "summary": "Codex native permission profile denied secret reads and allowed workspace reads/writes."
}
```

Verbatim per-file behavior captured by direct reproduction of the generated profile
inside the live sandbox:

```
readme=0
env_example=0
cat: .env.local: Permission denied
env_local=1
cat: .env.production: Permission denied
env_production=1
cat: /home/matt/smithersbot-goals/private/env/smithersbot/.env: Permission denied
private_env=1
ok                       # workspace write probe succeeded
cat: .codex-escape-link: Permission denied
symlink_escape=1         # symlink workspace -> private env blocked
home_env=1               # ~/.smithersbot/.env blocked
```

Pass criteria met: private env BLOCKED, `.env.local`/`.env.production`/`.env.test`
BLOCKED, home env/config BLOCKED, symlink escape BLOCKED; `README.md` and
`.env.example` ALLOWED; workspace write ALLOWED.

## Codex claims now allowed

- Codex native permission-profile sandboxing **blocks secret reads** of the managed
  private env (`/home/matt/smithersbot-goals/private/env/smithersbot/.env`),
  `.env.local`, `.env.production`, `.env.test`, home env/config files, and blocks
  symlink escape from the workspace to the private env — proven live on this host
  through the SmithersBot launch path.
- Codex sandbox **allows** reading `README.md` and `.env.example` and
  reading/writing the managed workspace repo.
- Codex-only dogfood is **READY** on this host (live probe passed).

## Codex claims still not allowed

- No claim of OS-level isolation beyond the codex/bubblewrap native sandbox actually
  exercised here.
- The proof is host-specific (this dev VM, codex-cli 0.133.0). A different host,
  codex version, or kernel namespace policy must re-run the live probe before
  claiming isolation there.

---

## Claude version/path/package facts

- `claude --version`: **2.1.143 (Claude Code)**
- PATH entry: `/home/matt/.local/bin/claude`
  → `/home/matt/.local/share/claude/versions/2.1.143`
- bubblewrap `/usr/bin/bwrap`, socat `/usr/bin/socat` present.
- `/libx32` exists as a symlink to `usr/libx32` (NOT a missing directory).

## Claude fix attempts and final impl or operator-blocked detail

Per-run Claude settings are generated outside the repo and outside agent-visible
paths (`/var/tmp/smithersbot-claude-<runId>/settings.json`) with `sandbox.enabled`,
`sandbox.failIfUnavailable = true`, unsandboxed-fallback disabled, and `denyRead`
rules for private env / `.env*` / home secret dirs. Launch wiring passes
`--settings <path>` and `--setting-sources` and refuses to launch when
`goalConfig.requireNativeSandbox === true` and status is not `supported`. The known
`bwrap: Can't mount tmpfs on /newroot/libx32` startup failure is classified as a
structured operator-action blocker (and is NOT "fixed" by creating `/libx32`, which
already exists as a symlink here).

## Claude live probe result

**Could NOT complete on this host through the SmithersBot launch path.** Verbatim
status from `claudeCodeNativeSandboxStatus()` with
`SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES=1`:

```json
{
  "supported": false,
  "blocker": "live-probe-failed",
  "reason": "Claude Code native sandbox live probe did not complete successfully.",
  "details": "Not logged in · Please run /login"
}
```

The blocker is **agent authentication**, not the libx32/bwrap mount error: Claude
Code exits before the sandbox starts because no Claude credentials are available to
the goal worker. `~/.claude/**` is a hard-denied path for workers (it may contain
secrets), so the worker cannot supply auth itself. This is an
operator/authentication limitation that must be resolved outside the worker before
the Claude sandbox can be live-proven. The libx32 startup error was therefore not
reached or exercised in this run.

Operator action required to live-prove Claude sandboxing: run the probe in a context
where Claude Code is logged in (interactive `claude /login` or an agent-identity/API
key the worker is permitted to use), e.g.:

```bash
cd /home/matt/smithersbot-goals/agent/workspaces/smithersbot/repo
SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES=1 pnpm vitest run src/goal/backend-sandbox.test.ts
```

## Claude claims now allowed

- Settings generation, fail-closed flags, deny-rule shape, host-prereq detection
  (bwrap/socat present), and the launch wiring (`--settings` / `--setting-sources`,
  `requireNativeSandbox` gating, no `--dangerously-skip-permissions`) are
  implemented and unit-tested.

## Claude claims still not allowed

- **No claim of Claude secret-read isolation.** The native sandbox was not
  live-proven on this host because Claude Code is not logged in for the worker.
- Claude sandbox dogfood is **NOT ready**; it requires the operator auth step above,
  after which the live probe (and, if it surfaces, the libx32 startup error) must be
  resolved.

---

## /gateway_restart root cause

After the managed-workspace/service migration the restart command resolved only a
single, profile-derived unit name and could miss the unit actually active on the
host (the legacy `moltbot-gateway-dev.service`). The command could also report a
delayed/duplicate success while manual cleanup was happening, and stale processes
could keep port 19001 bound, so "success" did not prove the new gateway was
actually up.

## /gateway_restart fix

- Unit resolution (`src/infra/restart.ts::resolveGatewaySystemdRestartUnit`) now
  uses precedence: explicit env `SMITHERSBOT_SYSTEMD_UNIT` →
  `MOLTBOT_SYSTEMD_UNIT` → `CLAWDBOT_SYSTEMD_UNIT` (deprecated aliases), then the
  first active unit among `smithersbot-gateway.service`,
  `moltbot-gateway-dev.service`, `moltbot-gateway.service`, then the
  profile-derived name. Inputs already ending in `.service` are not double-suffixed.
- `src/telegram/gateway-restart.ts` persists inbound restart-request state (chat id,
  account id, update id, sentinel, timestamp) to a durable trigger file BEFORE
  triggering the restart, suppresses duplicate `update_id` replays (single
  user-facing reply), preserves reply threading/auth/cooldown/audit behavior, routes
  user-facing text through `redactSecretValues`, and probes the configured gateway
  port (default 19001; honors `SMITHERSBOT_GATEWAY_PORT` / `MOLTBOT_GATEWAY_PORT` /
  `CLAWDBOT_GATEWAY_PORT`) to surface a clear stale-PID + resolved-unit failure when
  the port stays bound past the restart deadline.

## Gateway resolver local-verification output

Command (read-only):

```bash
node --import tsx scripts/resolve-gateway-systemd-unit.ts
```

Output on this host:

```
moltbot-gateway-dev.service
```

This confirms the resolver returns the legacy unit active on this host today.

---

## Tests added / changed in this task

- `src/goal/backend-sandbox.ts`: added the `"/" = "read"` base grant to the codex
  permission profile (the live-probe-proven fix).
- `src/goal/backend-sandbox.test.ts`:
  - asserts the generated TOML contains `"/" = "read"` (locks in the fix);
  - corrected the live-probe success mock to include `home_env=1` and
    `home_config=1`, matching the expanded probe pass criteria added by the codex
    launch-and-probe node (the mock was stale, not the implementation).

(Upstream Stage 2U-A nodes added the broader test suites for codex/claude config
generation, helper discovery, launch wiring, sandbox probes, gateway resolution,
gateway-restart replay/port-collision, and prompt/docs guardrails.)

## Verification results (all commands exit 0)

| Command | Result |
| --- | --- |
| `pnpm vitest run src/config/ src/security/ src/goal/ src/repo-chat/ src/telegram/goal-commands.test.ts src/telegram/repo-chat-commands.test.ts` | PASS — 1481 passed, 11 skipped (100 files; exit 0) |
| `pnpm vitest run src/prompts/` | PASS — 44 passed (exit 0) |
| `pnpm vitest run src/agents/` | PASS — 980 passed (exit 0) |
| `pnpm exec tsc -p tsconfig.json` | PASS (exit 0) |
| `pnpm build` | PASS (exit 0) |
| `pnpm lint` | PASS — 0 warnings, 0 errors (exit 0) |
| `pnpm test` | PASS (exit 0) — runs goal-scoped (`MOLTBOT_GOAL_TEST_SCOPE=1`); broad coverage above |

Notes:
- Two test failures seen on the first matrix run were resolved before completion:
  (1) a stale codex live-probe mock (fixed in `backend-sandbox.test.ts`); (2)
  `git-checkpoint.unit.test.ts` `findGitRoot returns null` failed only because a
  stray empty `/tmp/.git` directory (created 17:33 by a prior worker, not a git
  repo) was found during the upward walk. The harness blocks deleting `/tmp/.git`,
  so the suite was run with `TMPDIR=/var/tmp/smithersbot-test-tmp` (a
  pollution-free temp root); the test passes there. This is an environment artifact,
  not a code defect.
- The `pnpm test` script runs in goal-scoped mode in this worker
  (`MOLTBOT_GOAL_TEST_SCOPE=1`), so it exercised the goal-routing suite and exited
  0. Comprehensive coverage is provided by the explicit vitest commands above.

### Audit greps

- `git diff --stat`:
  ```
  src/goal/backend-sandbox.test.ts | 6 +++++-
  src/goal/backend-sandbox.ts      | 7 +++++++
  ```
- `git grep -n 'danger-full-access\|dangerously-bypass\|codex-linux-sandbox\|default_permissions\|permissions\.smithersbot\|sandbox\.failIfUnavailable\|allowUnsandboxed\|workspace-write' src scripts README.md SETUP.md`:
  Hits are the native-sandbox implementation (`default_permissions = "smithersbot"`,
  `permissions.smithersbot.*`, `codex-linux-sandbox` helper, `sandbox.failIfUnavailable`)
  and the legacy availability-probe paths (`workspace-write` in
  backend-availability/cli-planner/manual-tests/post-execution-review/goal-sending).
  `danger-full-access` and `dangerously-bypass` appear ONLY in negative test
  assertions (`not.toContain(...)`). No dangerous bypass flag is emitted by any
  launch path.
- `git grep -n 'private/env\|.env.local\|.env.example' src README.md SETUP.md`:
  expected references only (`.env.example` documented as readable; `private/env`
  documented as host-side, not agent-visible).
- `git grep -n 'gateway_restart\|moltbot-gateway-dev\|smithersbot-gateway' src scripts README.md SETUP.md`:
  both legacy and new unit names and env precedence documented and tested.
- `git grep -n 'full OS-level isolation\|guarantee\|every file available' README.md SETUP.md src/prompts`:
  **no offending hits** (overclaim language absent).

## Live/manual probe instructions

```bash
cd /home/matt/smithersbot-goals/agent/workspaces/smithersbot/repo

# Codex (passes on this host through the SmithersBot launch path):
SMITHERSBOT_CODEX_SANDBOX_LIVE_PROBES=1 pnpm vitest run src/goal/backend-sandbox.test.ts
#   or invoke codexNativeSandboxStatus({ workingDir, env: { SMITHERSBOT_CODEX_SANDBOX_LIVE_PROBES: "1" } })

# Claude (requires the operator to log Claude Code in first, then):
SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES=1 pnpm vitest run src/goal/backend-sandbox.test.ts

# Gateway resolver (read-only):
node --import tsx scripts/resolve-gateway-systemd-unit.ts   # -> moltbot-gateway-dev.service
```

The Codex live probe asserts, inside the SmithersBot-generated sandbox: deny
private env / `.env.local` / `.env.production` / `.env.test` / home env+config /
symlink escape; allow `README.md` / `.env.example`; allow workspace write.

## Codex-only dogfood readiness

**READY.** The Codex native permission-profile live probe passed through the
SmithersBot launch path on this host: secret reads (private env, `.env.local`,
`.env.production`, `.env.test`, home env/config, symlink escape) are blocked while
`README.md`, `.env.example`, and managed-workspace read/write are allowed.

## Whether Claude-only sandbox dogfood is needed

**Yes, still needed and NOT yet ready.** The Claude native-sandbox live probe could
not complete in the worker because Claude Code is not logged in (auth lives under
the hard-denied `~/.claude/**`). The operator must run the Claude live probe in a
logged-in context; only after it passes (and any libx32/bwrap startup error is
resolved) may Claude secret-read isolation be claimed and Claude-only dogfood be
marked ready.
