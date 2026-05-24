# STAGE2U_F — Claude Code goal-worker sandbox exact-file deny gap

## Summary

A live sandbox smoke test found that Claude Code goal-worker **Bash subprocesses**
could content-read real-home auth/session/credential files even though repo `.env*`
files were denied. `cat <path> >/dev/null` returned `rc=0` (contents suppressed but
the read succeeded) for:

- `~/.codex/auth.json`
- a file under `~/.ssh`
- a regular file under `~/.claude`

This change makes the Claude worker sandbox deny those files by adding each as an
**exact, existing, regular-file** entry in `sandbox.filesystem.denyRead`, discovered
metadata-only and bounded. The directory denies and the broad `permissions.deny`
Read rules remain as defense-in-depth.

## Root cause

Claude Code 2.1.x enforces `sandbox.filesystem.denyRead` for sandboxed Bash via
per-entry bubblewrap mounts. Live differential probing established that:

- **Exact regular-file** entries are mounted reliably and DO block Bash child reads
  (the repo `.env*` denies worked).
- **Directory/prefix** entries — and `permissions.deny Read(.../**)` rules — do **not**
  reliably block Bash child content reads recursively.

The worker previously emitted only a deliberately **minimal** `filesystem.denyRead`
matrix: the exact repo `.env*` files plus two *directory* entries (`~/.claude` and the
managed private root). The broader home credential dirs (`~/.codex`, `~/.ssh`,
`~/.gnupg`, legacy state dirs) were never in `filesystem.denyRead` at all — they were
only in `permissions.deny Read(.../**)`, which does not gate Bash. The minimal matrix
had been trimmed earlier because stacking large **directory** denies hung bubblewrap
startup (startup cost scales with denied directory-tree size). The fix sidesteps that:
individual **file** mounts are cheap (one mount target each, no tree walk).

## Code changes

All in `src/goal/backend-sandbox.ts` (Claude path only; Codex policy untouched):

- **`ClaudeDenyReadDeps`** extended with injectable, defaulted FS primitives
  (`readDir`, `isRegularFile`, `isDirectory`) so discovery is fully unit-testable
  against fixtures and never touches the real home in tests. A `ResolvedClaudeDenyDeps`
  type captures the resolved set; `resolveClaudeDenyDeps` now defaults the new deps to
  `fs.readdirSync` / `fs.statSync().isFile()` / `fs.statSync().isDirectory()` (each
  wrapped in try/catch).
- **`resolveExistingRealFiles`** — like the existing `resolveExistingRealPaths` but
  additionally requires the resolved real target to be a **regular file**. Symlinks are
  resolved to their real target first, then non-regular targets (dirs, sockets, fifos,
  broken links) are dropped, so every exact-file entry is a real, mountable bwrap file
  target. `uniqueValues` dedupes.
- **`discoverSensitiveFilesInDir`** — a shallow, bounded directory scan. Reads listings
  and stat metadata only (never file contents); bounded by per-category depth and a
  shared global entry budget (`SENSITIVE_SCAN_BUDGET = 1000`). Subdirectories at the
  depth limit are detected but never descended into, so it never walks `node_modules` or
  another large nested tree.
- **`isRepoEnvFileName`** / **`isSensitiveCredentialFileName`** + `SENSITIVE_FILE_BASENAMES`
  / `SENSITIVE_FILE_EXTENSIONS` — name predicates for top-level repo env files and for
  credential/secret files inside credential dirs.
- **`buildClaudeSensitiveFileDenies`** — assembles the exact-file candidate set
  (explicit fixed home files + managed private env, plus bounded scans of the repo top
  level and the small home credential dirs) and returns it via `resolveExistingRealFiles`.
- **`buildClaudeDenyReadPaths`** — now unions (a) the existing dir/literal denies
  (`resolveExistingRealPaths` over the repo `.env*` literals + `~/.claude` + managed
  private root, kept for back-compat and defense-in-depth) with (b)
  `buildClaudeSensitiveFileDenies`, deduped via `uniqueValues`.

Unchanged (per requirements): `permissions.deny` broad `Read(.../**)` rules
(`buildClaudeReadToolDenies`), `allowRead`, subscription auth env stripping, no
`--bare`, no `**` globs in `filesystem.denyRead`, and the Codex sandbox path.

Production discovery reads only directory listings + stat metadata of the real home —
**never file contents** — complying with the "do not read private contents" rule.

## Sensitive file categories covered (where present)

- **Repo env (top-level, non-recursive):** `.env` and any `.env.*`, excluding
  `.env.example` / `.env.sample` templates.
- **Managed private env/config:** `<privateRoot>/env/<workspace>/.env` plus a bounded
  scan of that workspace's private dir. The private-root **directory** deny is also kept
  (covers symlink-escape).
- **Claude (`~/.claude`):** `.credentials.json`, `settings.json`, `settings.local.json`,
  config `*.json` (depth 1 — does not walk `~/.claude/projects` session transcripts).
  The `~/.claude` directory deny is also kept.
- **Codex (`~/.codex`):** `auth.json`, `config.toml`, config `*.json`/`*.toml`.
- **SSH (`~/.ssh`):** private keys (`id_*` excluding `*.pub`), `*.pem`/`*.key`, `config`,
  `known_hosts`, `authorized_keys`.
- **GPG (`~/.gnupg`):** `*.kbx`, `*.gpg`, `trustdb.gpg`, `private-keys-v1.d/*` (depth 2).
- **Legacy SmithersBot/Moltbot/Clawdbot dirs** (`~/.smithersbot`, `~/.moltbot`,
  `~/.clawdbot`, `~/.clawdbot-dev`): `.env`, `*.json` config/session/credential.
- **Fixed home credential files:** `~/.netrc`, `~/.npmrc`, `~/.pypirc`,
  `~/.git-credentials`.
- **Common credential patterns** (service-account/oauth/token JSON, `*.pem`/`*.key`/
  `*.crt`/`*.cer`/`*.p12`/`*.pfx`): applied **only** inside the bounded credential dirs
  and as fixed home files — never a repo-wide scan, to avoid the node_modules walk and
  avoid denying legitimate repo fixtures.
- **Symlink targets:** any sensitive symlink resolves to and denies its real target.

`~/.aws` is included in the scan set, so `~/.aws/credentials`/`config` are denied when
present and silently skipped when absent.

## Symlink + bounded-traversal strategy

- **Symlinks:** every candidate is passed through `realPath` (`fs.realpathSync`) and only
  the resolved **real target** is emitted — never the link path — because bwrap cannot
  mount over a symlink. `resolveExistingRealFiles` additionally drops targets that are not
  regular files. `uniqueValues` collapses collisions (e.g. `~/.clawdbot -> ~/.moltbot`).
- **Bounded traversal:** discovery scans only the repo top level (depth 1, env files
  only) and the small home credential dirs (depth 1, except `~/.gnupg` depth 2 for
  `private-keys-v1.d`). All scans share one global entry budget. Subdirectories at the
  depth limit are detected but not descended, so `node_modules`, `~/.cache`, and
  `~/.claude/projects` are never walked. No `**` globs are emitted for the filesystem
  denyRead.

## Tests run

```
pnpm vitest run src/goal/backend-sandbox.test.ts src/goal/sandbox-probes.test.ts src/goal/cli-worker.test.ts
pnpm exec tsc -p tsconfig.json   # clean
pnpm build                       # clean
pnpm lint                        # 0 warnings, 0 errors
```

Result: `tsc`, `build`, `lint` clean. Test totals: 93 passed, 1 skipped, 15 failed.

**All 15 failures are pre-existing and environmental** (live-probe / Codex
binary-discovery tests that require a real bwrap + claude/codex host). Verified by
stashing the change and re-running: the baseline shows the identical 14 failures in
`backend-sandbox.test.ts` and 1 in `cli-worker.test.ts`. This change adds one new passing
test and introduces no regressions.

New / updated tests:

- `backend-sandbox.test.ts`: new "denies exact existing sensitive home/credential files
  via metadata-bounded discovery" — builds a real fake-home fixture and asserts
  `filesystem.denyRead` contains the exact `.claude/.credentials.json`, `.codex/auth.json`,
  `.ssh/id_ed25519`, GPG keyring + `private-keys-v1.d/*.key`, `.netrc`, the managed
  private env, repo `.env.local`, and a discovered `.env.staging`; that the `~/.claude`
  dir AND a file under it both appear (directory deny is not the only coverage); that
  `README.md` / `.env.example` / the `.pub` key stay readable; that a nonexistent path is
  skipped; that no `**` globs are emitted; that a `.clawdbot -> .moltbot` symlink resolves
  to the real target (no mount-over-symlink entry); that the repo `node_modules` and a
  decoy `~/.cache` tree are never walked; and that the broad `permissions.deny` Read rules
  remain. The previous "minimal proven-safe deny matrix" test was reframed to assert the
  empty-home-scan case (only dir/literal denies remain) and made hermetic by stubbing the
  new FS deps. The two other denyReadDeps tests were stubbed to scan no home dirs.
- `sandbox-probes.ts` / `.test.ts`: fixture now creates fake `~/.codex/auth.json`,
  `~/.ssh/id_ed25519`, `~/.claude/.credentials.json`; new denied probe cases ("home codex
  auth", "home ssh key", "home claude credentials", "bash home codex auth"); the
  expected denied-label list and a fixture-existence assertion were updated to match.

## Manual verification — rerun the live smoke

On a host with bubblewrap + Claude Code logged in (subscription), with live probes
enabled:

```
export SMITHERSBOT_CLAUDE_SANDBOX_LIVE_PROBES=1
pnpm vitest run src/goal/sandbox-probes.test.ts
```

The live probe runs the goal worker with `HOME=<fixture fake home>` and the generated
native sandbox settings, then executes the probe commands from sandboxed Bash. Confirm:

1. **DENIED (now blocked):** `cat ~/.codex/auth.json`, `cat ~/.ssh/id_ed25519`,
   `cat ~/.claude/.credentials.json`, `bash -c 'cat ~/.codex/auth.json'`, the managed
   private env, repo `.env*`, and the private symlink escape all return `rc != 0` and the
   sentinel content is never printed.
2. **ALLOWED (still readable):** `cat README.md`, `cat .env.example`, the agent-history
   search, and the repo edit all succeed.
3. **Subscription auth still works:** `claude --version` / the auth differential probes
   report `blocker: none` (no `api-key-env-poisoning`, no `missing-subscription-login`).
4. **No startup regression:** the sandbox starts in ~tens of seconds (no bwrap hang).

To reproduce the original gap against the **real** home (read-only check, no content
printed), run the same `cat <path> >/dev/null; echo $?` probes from a sandboxed worker
Bash and confirm each now returns non-zero for the real `~/.codex/auth.json`, a real
`~/.ssh` key, and a real regular file under `~/.claude`.

### Contingency

The exact-file mounts are cheap and bounded, so startup cost should stay low — but only
the live smoke can prove no startup regression. If a specific dir + nested-file pairing
turns out to fail bwrap mount ordering, drop that overlapping **directory** entry from
`filesystem.denyRead` (keep it in `permissions.deny`) while retaining the exact-file
denies.
