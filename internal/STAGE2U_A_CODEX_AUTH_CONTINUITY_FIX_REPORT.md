# Stage 2U-A Codex Auth Continuity Fix Report

Generated: 2026-05-21. Host: managed dev VM (Linux 6.8.0). Codex: `codex-cli 0.133.0`.

This report records STATUS RESULTS, EXIT CODES, and NON-SECRET ERROR-CLASS
KEYWORDS ONLY. No auth file, token, env value, or Codex config secret was
printed, hashed, encoded, summarized, or persisted at any point. The auth-
continuity fix uses a symlink (never a copy), so no auth contents are duplicated
or written anywhere.

Scope: this change is Codex-only. No Claude launch behavior was touched, the
gateway was NOT restarted, and no docs beyond this single report file were
edited.

---

## 1. Root cause of AUTH_CONTINUITY_FAILURE

The Stage 2U-A proof goal (`4d92534c`) reported:

- Codex filesystem sandbox proof: **succeeded** (no API calls → no auth needed).
- Codex authenticated exec smoke: **failed** → `AUTH_CONTINUITY_FAILURE`,
  non-secret error class `unauthorized/401/403/authentication`.

Root cause: Codex reads its credentials from `$CODEX_HOME/auth.json`. The
SmithersBot launch path generates a **per-run** `CODEX_HOME` under
`/var/tmp/smithersbot-codex-<runId>/` and previously populated it with only:

- `config.toml` (the `default_permissions = "smithersbot"` permission profile), and
- `bin/codex-linux-sandbox` (a symlink to the embedded native helper).

There was **no `auth.json`** in the generated home, and the goal worker env is
credential-stripped (`buildGoalWorkerEnv` removes provider credentials), so the
authenticated Codex control plane had no way to authenticate and failed with a
401/403/authentication-class error. The filesystem sandbox proof passed in the
same shape only because it never reaches an authenticated API call.

## 2. Exact auth-continuity fix

In `src/goal/backend-sandbox.ts`:

- `CodexNativeSandboxConfig` gained two fields:
  - `authReferencePath` = `path.join(codexHome, "auth.json")` — where Codex looks
    for credentials inside the generated home.
  - `authSourcePath` = real Codex auth, resolved as
    `path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "auth.json")`
    via `resolveRealCodexAuthSource()`.
- `buildCodexNativeSandboxConfig` populates both fields.
- `writeCodexNativeSandboxConfig` calls `linkCodexAuthReference(config)` after
  writing `config.toml` and the helper symlink. `linkCodexAuthReference`:
  - returns early if source === reference, or if the real source does not exist
    (best-effort; control-plane auth still resolves via the real `CODEX_HOME`
    when present);
  - force-removes any stale link, then **`fs.symlinkSync(authSourcePath,
    authReferencePath)`** — a **symlink, never a copy**, so no auth contents are
    duplicated or persisted;
  - never `chmod`s the link (a Linux `chmod` follows the symlink and would mutate
    the real auth file's permissions); the generated `CODEX_HOME` directory is
    created mode `0o700`, so the link is owner-only.
- `buildCodexDeniedReadPaths` keeps `~/.codex/auth.json` in the deny list **and**
  additionally denies the resolved `authSourcePath` (deduped when `CODEX_HOME`
  is unset, so they collapse to the same path).

Net effect: the unsandboxed Codex control plane follows
`$CODEX_HOME/auth.json` → real `~/.codex/auth.json` and authenticates, while the
generated home keeps `config.toml` (permission profile) + helper + auth symlink.
No `--sandbox`, `workspace-write`, `danger-full-access`, or
`--dangerously-bypass-approvals-and-sandbox` flags are emitted; the worker codex
launch shape remains `codex exec --json --cd <executionRoot>` with
`CODEX_HOME=<generated home>` and `PATH=<generated home>/bin:$PATH`.

## 3. Why auth is NOT exposed to the sandboxed shell/LLM

- The generated `<codexHome>/auth.json` is a symlink whose target is the real
  `~/.codex/auth.json`. Codex's permission profile denies that target
  (`~/.codex/auth.json` + the resolved `authSourcePath` are both in
  `deniedReadPaths`). Inside the sandbox, a read of the generated symlink
  resolves to the denied real path and is blocked — the **same symlink-target
  deny mechanism the existing `symlink_escape` probe already proves**.
- Both paths are therefore unreadable to the sandboxed command: the generated
  `<codexHome>/auth.json` AND the real `~/.codex/auth.json`. Only the
  **unsandboxed** Codex control plane (outside the bubblewrap view) follows the
  link to authenticate.
- The live probe in `codexNativeSandboxStatus` was extended to assert this: it
  now runs `cat <codexHome>/auth.json >/dev/null; echo codex_auth=$?` and
  requires `codex_auth=1` (blocked), alongside the existing `symlink_escape=1`
  assertion. The `passed` predicate and the test success mock were updated to
  match.
- No read grant was widened. `README.md` and `.env.example` remain readable only
  through the existing explicit workspace `executionRoot` allow rule. The single
  pre-existing `"/" = "read"` base grant (required so `/bin/sh` and the
  `codex-linux-sandbox` helper stay executable under bubblewrap) is unchanged;
  the auth fix adds **zero** new read grants. No broad recursive deny was added
  over `/`, `~`, or `~/.codex`.
- Because the fix is a symlink, no auth bytes are read, copied, printed, hashed,
  encoded, summarized, or persisted by SmithersBot.

## 4. Tests added

`src/goal/backend-sandbox.test.ts` — new `Codex native sandbox auth continuity`
suite (11 tests):

- carries an auth reference targeting the real `~/.codex/auth.json` with
  `codexHome` outside agent roots;
- keeps `default_permissions = "smithersbot"` in the generated `config.toml`;
- denies private env, repo env files, and `~/.codex/auth.json` without broad
  recursive denies;
- keeps `README.md` and `.env.example` readable via the workspace grant without
  broad read grants;
- blocks both the generated and real auth paths from the sandboxed shell;
- symlinks the generated `auth.json` to the real auth source for control-plane
  auth (asserts a symlink, not a copy);
- skips the auth symlink (no copy) when the real auth source is absent;
- introduces no broad read grant beyond the single sandbox-bootstrap base;
- emits no danger-full-access / dangerously-bypass / `--sandbox workspace-write`
  flags.

The existing `reports proven only after the live permission-profile probe
passes` test was updated so its success mock includes `codex_auth=1`.

`src/goal/cli-worker.test.ts` — `launches codex with the auth-continuous
generated CODEX_HOME shape`: asserts `env.CODEX_HOME` is the generated
`/var/tmp/smithersbot-codex-*` home, `env.PATH` includes the helper dir, the
home holds `config.toml` (`default_permissions = "smithersbot"`) + the
`codex-linux-sandbox` helper, the auth reference is a symlink to the real source
when one exists, and args are `exec --json --cd <workingDir>` with no
`--sandbox`/`workspace-write`/danger flags.

`src/repo-chat/repo-chat-worker.test.ts` — `uses the auth-continuous codex
launch shape with a read-only agent-root execution root`: asserts the same
generated `CODEX_HOME` shape (config.toml `default_permissions` + helper + auth
reference symlink when source exists), read-only execution (no `= "write"`
grants), `--cd` pinned to the agent root, and no sandbox/danger flags.

`src/goal/sandbox-probes.test.ts` and `src/repo-chat/sandbox-probes.test.ts`
were left unchanged (the new auth fields do not shift threaded-args
expectations) and remain green: they still enumerate denied private-env + repo
`.env`/`.env.local`/`.env.production`/`.env.test` cases and allowed
`README.md`/`.env.example` cases with no broad-flag grants.

## 5. Verification results

All four required matrix commands were run on this host and **all exit 0**:

| Command | Result | Exit |
| --- | --- | --- |
| `pnpm vitest run src/goal/backend-sandbox.test.ts src/goal/cli-worker.test.ts src/repo-chat/repo-chat-worker.test.ts src/goal/sandbox-probes.test.ts src/repo-chat/sandbox-probes.test.ts` | 155 passed, 2 skipped (5 files passed) | 0 |
| `pnpm exec tsc -p tsconfig.json` | clean | 0 |
| `pnpm build` | tsc + copy steps OK | 0 |
| `pnpm lint` | 0 warnings, 0 errors (2326 files) | 0 |

## 6. Host-side proof

The authenticated Codex exec smoke and the filesystem sandbox live probe were
**not** run inside this goal worker, by worker-sandbox limitation, not by code
defect:

- The goal worker env is credential-stripped (`buildGoalWorkerEnv`), so an
  authenticated Codex exec from inside the worker would fail for lack of
  credentials regardless of the fix — a false negative.
- The auth files live under hard-denied `~/.codex/**`; the worker may not read
  them, and the fix deliberately keeps them unreadable to the sandboxed command.
- The Codex filesystem live probe needs nested Linux user namespaces
  (bubblewrap), which the worker sandbox does not grant.

The fix must therefore be proven host-side (the same place the
`4d92534c` proof was run). Exact host-side commands (run from the repo root;
each emits STATUS / EXIT / KEYWORD only, never file contents):

### (a) Filesystem sandbox still passes (no API calls)

```sh
cd /home/matt/smithersbot-goals/agent/workspaces/smithersbot/repo
SMITHERSBOT_CODEX_SANDBOX_LIVE_PROBES=1 node --import tsx -e '
import { codexNativeSandboxStatus } from "./src/goal/backend-sandbox.ts";
const s = codexNativeSandboxStatus({ purpose: "goal-worker" });
console.log("proven=" + ("proven" in s ? s.proven : "n/a"));
if (!("proven" in s) || s.proven !== true) console.log("blocker=" + (s).blocker);
'
```

Expected: `proven=true`. The probe internally requires
`readme=0`, `env_example=0`, `env_local=1`, `env_production=1`, `env_test=1`,
`home_env=1`, `home_config=1`, `private_env=1`, `codex_auth=1` (generated
auth.json blocked), `symlink_escape=1` (private env via symlink blocked), and a
successful workspace write — i.e. private env blocked, `.env.local` blocked,
`README.md` allowed, `.env.example` allowed, symlink escape blocked.

### (b) Authenticated codex exec returns exactly `codex-auth-ok`

```sh
cd /home/matt/smithersbot-goals/agent/workspaces/smithersbot/repo
node --import tsx -e '
import { writeCodexNativeSandboxConfig, mergeCodexNativeSandboxEnv } from "./src/goal/backend-sandbox.ts";
import { spawnSync } from "node:child_process";
const cfg = writeCodexNativeSandboxConfig({ workingDir: process.cwd(), runId: "auth-smoke-" + Date.now(), purpose: "goal-worker" });
const env = mergeCodexNativeSandboxEnv(process.env, cfg);
const r = spawnSync("codex", ["exec", "--json", "--cd", cfg.executionRoot, "Print exactly this and nothing else: codex-auth-ok"], { env, encoding: "utf8", timeout: 120000 });
const out = (r.stdout || "") + "\n" + (r.stderr || "");
console.log("exit=" + r.status);
console.log("auth_ok=" + (out.includes("codex-auth-ok") ? "yes" : "no"));
console.log("auth_error=" + (/unauthorized|401|403|authentication/i.test(out) ? "yes" : "no"));
'
```

Expected: `exit=0`, `auth_ok=yes`, `auth_error=no`. This uses the **real worker
launch shape** — generated `CODEX_HOME` (`config.toml` profile + helper + auth
symlink), `PATH=<home>/bin:$PATH` via `mergeCodexNativeSandboxEnv`, and
`exec --json --cd <executionRoot>` with no `--sandbox`/danger flags — so a pass
proves auth continuity through the exact path the worker uses.

### (c) No auth/secret contents were printed

Both commands above print only `proven=`/`blocker=`/`exit=`/`auth_ok=`/
`auth_error=` — booleans, exit codes, and keyword-presence flags. They never
`cat`/echo any auth, token, env, or config file. The symlink-based fix means
SmithersBot reads zero auth bytes. To confirm post-run that no auth material
leaked into the generated home, an operator may verify the reference is a link
(not a regular file) without reading it:

```sh
find /var/tmp -maxdepth 2 -name auth.json -path '*smithersbot-codex-*' -type l -printf '%p -> link OK\n'
```

(`-type l` matches only symlinks; a regular file would not match. This prints the
path and link status, never contents.)

## 7. Is it now safe to run `/gateway_restart`?

**Not yet — pending the host-side authenticated smoke in §6(b).**

Restart-safety rule: restart is safe ONLY if BOTH (i) the Codex filesystem
sandbox proof passes AND (ii) the authenticated Codex exec smoke returns exactly
`codex-auth-ok` — or an operator explicitly accepts the restart risk.

- Codex filesystem sandbox proof: previously **succeeded** (`4d92534c`); the fix
  preserves it and adds the `codex_auth=1` deny assertion. Re-confirm with
  §6(a).
- Authenticated Codex exec smoke: the code-level fix is implemented and the
  launch-shape tests pass, but the live `codex-auth-ok` smoke (§6(b)) requires
  host credentials and was not run inside this credential-stripped worker.

Determination: an operator should run §6(a) and §6(b) host-side. If
§6(a) yields `proven=true` and §6(b) yields `exit=0 / auth_ok=yes /
auth_error=no`, then `/gateway_restart` is safe. Until both are confirmed (or
the risk is explicitly accepted by an operator), do not restart.
