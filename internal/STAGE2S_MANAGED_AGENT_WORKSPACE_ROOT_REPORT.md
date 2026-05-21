# Stage 2S — Managed Agent Workspace Root Report

Stage 2S introduces the SmithersBot **managed workspace root**
(`~/smithersbot-goals` by default; overridable via `SMITHERSBOT_GOALS_ROOT`)
that separates agent-visible workspace state from host-only secrets, makes
`.env.example` the portable contract for environment variable names, and
sanitizes goal/repo-chat history into an agent-readable mirror. The user-facing
"Working dir" label is renamed to "Workspace" for managed-goal-workspace flows.

This stage is **intentionally transitional**: new/default workspaces resolve
inside the managed agent root, but existing legacy `workingDir` values
(including this repository at `~/moltbot`) remain supported through the
default-on compatibility flag `config.goal.allowLegacyWorkingDir`. Full
fail-closed enforcement for non-managed workspaces is **NOT** enabled in
Stage 2S.

---

## Final directory architecture

```
~/smithersbot-goals/                       # managed root (override: SMITHERSBOT_GOALS_ROOT)
  agent/                                   # agent-visible
    workspaces/
      <workspace-name>/
        repo/                              # goal-worker cwd (managed)
          README.md
          SETUP.md
          .env.example                     # variable-name contract (placeholders only)
          src/...
    history/
      goals/<workspace-name>/<goal-id>/    # sanitized summary.json
      repo-chats/<workspace-name>/<session-id>/
      index/
        all-goals.jsonl                    # append-once global index
        all-repo-chats.jsonl
  private/                                 # host-only (chmod 0700)
    env/<workspace-name>/.env              # real env, never agent-visible
    config/
    auth/
    sessions/
  scratch/<run-id>/<task-id>/              # gateway-controlled temp state
```

The path model lives in `src/config/managed-paths.ts` with resolvers
`resolveManagedRoot`, `resolveAgentRoot`, `resolvePrivateRoot`,
`resolveScratchRoot`, `resolveWorkspaceRepoDir`,
`resolveAgentGoalHistoryDir`, `resolveAgentRepoChatHistoryDir`,
`resolveAgentHistoryIndexDir`, `resolvePrivateEnvFile`,
`resolvePrivateEnvDir`, `resolvePrivateConfigDir`, `resolvePrivateAuthDir`,
`resolvePrivateSessionsDir`, `resolveScratchDir`. Workspace names are
slugified by `slugifyWorkspaceName` (rejects `..`, leading separators,
absolute paths, empty/whitespace, control chars, NUL, embedded separators).
Classification helpers `isPathInsideAgentRoot`, `isPathInsidePrivateRoot`,
and `isPathInsideManagedRoot` use `path.resolve` + `path.relative` so the
classifier is robust against trailing slashes and `.` segments.

Legacy state directories (`~/.smithersbot`, `~/.moltbot`, `~/.clawdbot`,
`~/.clawdbot-dev`) remain resolved through `src/config/paths.ts` unchanged
during this transition.

---

## Setup changes

`scripts/setup-smithersbot.sh` now creates the full managed tree on first
run and keeps the directory list in a single `MANAGED_ROOT_SUBDIRS` bash
array consumed by both the script and `src/config/paths.test.ts`.

Created subdirectories (with `chmod 0700` on the managed root and on every
`private/*` subdir):

- `agent/workspaces`
- `agent/history/goals`
- `agent/history/repo-chats`
- `agent/history/index`
- `private/env`
- `private/config`
- `private/auth`
- `private/sessions`
- `scratch`

When setup is invoked from a repo *outside* the managed root the script
prints a single-line pointer:

```
Recommended workspace path: ~/smithersbot-goals/agent/workspaces/<repo>/repo
```

`src/security/secret-paths.ts` now exempts the literal basename
`.env.example` (case-insensitive) from the secret-file deny list. `.env`,
`.env.local`, `.env.production`, `.env.test` and other repo `.env.*` files
remain denied. The repo-root `.env.example` is present with placeholder-only
content.

`SETUP.md` now opens the "Where files live" section with the managed-root
tree, and the security notes explicitly state that
`~/smithersbot-goals/private/env/<workspace>/.env` is host-side-only and
never copied into the agent workspace.

---

## Workspace / env / history behavior

**Workspace resolution** (`src/commands/goal.ts` `resolveWorkingDir`)
precedence:

1. Explicit `--working-dir`
2. `config.goal.defaultWorkingDir`
3. Working-dir parsed from the user instruction
4. **NEW**: `<managed-root>/agent/workspaces/<slug>/repo`, where the slug
   comes from `config.goal.defaultWorkspaceName` if set, else the git
   toplevel basename, else `default`.

**Env**: real env values for a workspace live at
`<managed-root>/private/env/<workspace-name>/.env`. This file is never
agent-visible and never copied into the repo. The portable contract is the
repo-root `.env.example`. Project code is required to read normal process
env variables (Node: `process.env.X`, Python: `os.environ["X"]`).

`buildGoalWorkerEnv` continues to strip provider creds and does not pass
private env into worker env by default. Forwarding private env requires an
explicit, narrowly-scoped trusted-command opt-in.

**History**: on run finalize, `src/goal/run-store.ts` writes a sanitized
`summary.json` to `<managed-root>/agent/history/goals/<workspace>/<goal-id>/`
via `redactSecretValues`, and appends exactly one record to
`<managed-root>/agent/history/index/all-goals.jsonl` (id, workspace,
timestamp, status, summary path). Raw stdout/stderr blobs are never
mirrored unless explicitly flagged safe-for-history and pass through
`redactSecretValues` plus a size cap. Repo-chat sessions get the equivalent
treatment in `src/repo-chat/repo-chat-store.ts`. Canonical runtime stores at
`~/.smithersbot/goals/` and `~/.smithersbot/repo-chats/` remain in place for
this transition.

---

## Repo-chat access model

`src/repo-chat/repo-chat-worker.ts` launches the worker from the managed
agent root so the worker can read across managed workspaces, sanitized
agent history, and the agent index. Reads from `<managed-root>/private/**`
are excluded. The worker keeps its existing read-only sandbox/allowed-tools
defaults.

`src/prompts/repo-chat/repo-chat-context.ts` now references
`<managed-root>/agent/history/{goals,repo-chats,index}` as the preferred
agent-readable mirror, retains `~/.smithersbot/goals/` and `~/.moltbot/goals/`
as deprecated legacy fallbacks, and explicitly excludes
`<managed-root>/private` from repo-chat reads.

## Goal-worker access model

`src/goal/cli-worker.ts` and `src/goal/agent-executor.ts` route every new or
default goal worker into `<managed-root>/agent/workspaces/<slug>/repo`. When
the resolved `workingDir` is outside the managed agent root, the workspace
policy in `src/goal/workspace-policy.ts` emits a one-line warning
(`[goal] Workspace is outside the SmithersBot managed agent root; allowing
legacy workingDir for Stage 2S compatibility. Workspace: <path>`) but
continues. Operators who want fail-closed behavior can set
`config.goal.allowLegacyWorkingDir = false`, at which point legacy paths are
rejected at both the CLI worker layer and the executor layer.

Goal workers can read the agent root (workspaces + history + index) and
edit only their assigned workspace repo. They never receive
`<managed-root>/private/**` content.

---

## Project-code portability rule

Project code is required to read environment variables through standard
process env, never through SmithersBot's private folder layout. The
contracts are:

- Repo-root `.env.example` lists variable names with placeholder values.
- Node: `process.env.GOOGLE_DRIVE_API_KEY`.
- Python: `os.environ["GOOGLE_DRIVE_API_KEY"]`.
- Another person cloning the GitHub repo never needs SmithersBot's folder
  structure; they supply env through their own `.env`, shell env, CI
  secrets, or secret manager.
- Generated worker code must not `open("../../private/env/<workspace>/.env")`
  or any equivalent path inside `<managed-root>/private`.

`src/security/secret-paths.ts` enforces this on the read side: `.env.example`
is allow-listed, everything else under `.env*` is denied.

---

## User-facing rename: "Working dir" → "Workspace"

Renamed user-facing labels in managed-goal-workspace flows:

- `src/goal/format-output.ts` — plan label `**Workspace:**` (was
  `**Working dir:**`).
- `src/telegram/goal-commands.ts` — `Workspace updated:` (was
  `Working dir updated:`) and `Workspace:` in `goal_status` rendering
  (was `Working dir:`).
- `src/telegram/goal-sending.ts` — plan caption label updated to
  `Workspace:`.
- `src/commands/goal.ts` — CLI `Workspace: <path>` line.

Unchanged on purpose (these print the daemon-service `workingDirectory`,
not the managed goal workspace):

- `src/cli/daemon-cli/status.print.ts:86`
- `src/cli/node-cli/daemon.ts:533`

All internal identifiers (`workingDir` config/types, `parseWorkingDirInstruction`,
`resolveWorkingDir`, `ensureWorkingDir`) remain unchanged so existing
config files and APIs keep working.

---

## Private-env trusted host-side load behavior

`src/goal/workspace-private-env.ts` exposes `loadWorkspacePrivateEnv(name)`
that:

1. Slugifies the workspace name via `slugifyWorkspaceName`.
2. Resolves `<managed-root>/private/env/<slug>/.env`.
3. Verifies the resolved file is still inside
   `<managed-root>/private/env/<slug>/` and is literally named `.env`
   (defends against traversal even after slug acceptance).
4. Returns `{}` if the file does not exist; otherwise parses dotenv.

This loader is **host-side-only**:

- Called only by trusted gateway-side commands (Telegram/CLI gateway code).
- Its return value never flows into `buildGoalWorkerEnv` by default.
- Forwarding any private env value to a worker requires the
  trusted-command opt-in surface — there is no default-on path that gives a
  CLI worker raw secrets from `private/env`.

---

## What IS enforced now vs what is INTENTIONALLY NOT claimed

**Enforced now (Stage 2S):**

- Default goal workspace resolves into the managed agent root.
- Managed-root path model is the single source of truth for new path
  resolution; resolvers and slugifier reject traversal.
- `.env.example` is allowed; `.env`, `.env.local`, `.env.production`,
  `.env.test` and other `.env.*` files stay denied.
- `loadWorkspacePrivateEnv` refuses any path outside
  `<managed-root>/private/env/<slug>/.env`.
- Goal-worker env stripping continues to remove provider credentials.
- Repo-chat worker cwd is the managed agent root; private root is excluded.
- Goal/repo-chat history mirrors are sanitized through
  `redactSecretValues` and do not include raw stdout/stderr or transcripts
  by default; global indexes append at-most-once per id.
- User-facing managed-goal label is "Workspace" (not "Working dir").
- Setup script creates the managed tree with `chmod 0700` on `private/*`
  and on the managed root when practical.

**Intentionally NOT claimed in Stage 2S:**

- Full fail-closed enforcement for non-managed workspaces is **OFF**.
  `config.goal.allowLegacyWorkingDir` defaults to `true`; legacy
  `workingDir` values (including this repo at `~/moltbot`) keep working
  and emit a warning. Operators may opt into fail-closed by setting the
  flag to `false`, but the default is permissive.
- No claim of OS-level / kernel isolation beyond what the underlying
  Codex/Claude sandbox already provides. The managed root is a layout +
  policy boundary, not a syscall jail.
- Repo-chat read isolation against `<root>/private` is enforced by the
  worker cwd, allowed-tools defaults, and sanitized history layout — not by
  a filesystem-level chroot.
- Legacy `~/.smithersbot/goals` remains the canonical runtime store for
  this stage; agent/history is a sanitized mirror, not a replacement.
- Workers do not receive raw secrets in env by default, but Stage 2S does
  not assert this is verified by an independent runtime probe — it is a
  code-path property of `buildGoalWorkerEnv`.

---

## Migration path: `~/moltbot` → `~/smithersbot-goals/agent/workspaces/smithersbot/repo`

Concrete steps, in order:

1. **Run setup** to create the managed tree:
   ```
   bash scripts/setup-smithersbot.sh
   ```
   This creates `~/smithersbot-goals/agent/...`, `~/smithersbot-goals/private/...`,
   and `~/smithersbot-goals/scratch/` with `chmod 0700` on `private/*`.

2. **Move (or clone) the repo into the managed path**:
   ```
   mv ~/moltbot ~/smithersbot-goals/agent/workspaces/smithersbot/repo
   ```
   or, to keep `~/moltbot` intact while testing:
   ```
   git clone ~/moltbot ~/smithersbot-goals/agent/workspaces/smithersbot/repo
   ```

3. **Create the host-side env file** (real values; never agent-visible):
   ```
   mkdir -p ~/smithersbot-goals/private/env/smithersbot
   chmod 700 ~/smithersbot-goals/private/env/smithersbot
   # author ~/smithersbot-goals/private/env/smithersbot/.env with real values
   ```

4. **Point gateway config at the managed workspace**: edit the gateway's
   `config.goal.defaultWorkingDir` (or `defaultWorkspaceName`) to
   `smithersbot` (resolves to
   `~/smithersbot-goals/agent/workspaces/smithersbot/repo`).

5. **Restart the gateway** (operator-driven; not done during goal
   execution): use the operator's normal restart procedure.

6. **Dogfood**:
   - `/repo_chat` → ask about README, SETUP, and prior history; confirm the
     answer cites `<managed-root>/agent/...` and never `<managed-root>/private/...`.
   - `/new_goal` → confirm the run resolves cwd to the managed workspace
     and that the printed label says `Workspace:`.

7. **(Optional, future stage)** flip `config.goal.allowLegacyWorkingDir`
   to `false` to convert legacy `workingDir` use from "warn + allow" into
   fail-closed. Do this only after every active workspace lives under the
   managed root.

---

## Migration notes from `~/.smithersbot`, `~/.moltbot`, `~/.clawdbot-dev`

- `~/.smithersbot/.env`, `~/.smithersbot/smithersbot.json`,
  `~/.smithersbot/credentials/**`, `~/.smithersbot/sessions/**` remain the
  gateway's private state and are unchanged. They are not migrated into the
  managed root.
- `~/.smithersbot/goals/` and `~/.smithersbot/repo-chats/` remain the
  canonical runtime stores. Sanitized summaries are mirrored into
  `<managed-root>/agent/history/{goals,repo-chats}/` for agent and
  repo-chat consumption.
- `~/.moltbot/**` (legacy state under the old project name) is still
  accepted by legacy resolvers in `src/config/paths.ts`. New deployments
  should use `~/.smithersbot/**` for gateway state and
  `~/smithersbot-goals/**` for the managed agent root.
- `~/.clawdbot-dev/**` continues to be respected as a dev-profile state
  root via `CLAWDBOT_STATE_DIR` and the existing legacy resolvers; it is
  orthogonal to the managed root.
- The repo's own legacy `~/moltbot` working dir (where this run is being
  executed) keeps working under the default-on `allowLegacyWorkingDir`
  flag, with a Stage 2S warning emitted at worker launch.

---

## Tests added

- **Path model** (`src/config/paths.test.ts`): default root, env override,
  `~` expansion, workspace repo inside agent root, agent history dirs
  inside agent root, private + scratch dirs outside agent root,
  slugifier accept/reject (including embedded NUL and control chars), and
  the helper classifiers; plus a test that parses
  `scripts/setup-smithersbot.sh` `MANAGED_ROOT_SUBDIRS` and asserts each
  entry maps to a resolver-derived managed path. (21 tests.)
- **Security**: `src/security/secret-paths.test.ts` gains explicit
  `.env.example`-is-allowed cases and verifies other `.env.*` variants
  remain denied. (70 tests in this file.)
- **Setup**: `test/setup-smithersbot.test.ts` asserts the new managed-root
  tree is created with `chmod 0700` on `private/*`, the
  "Managed root:" output is printed, the `SMITHERSBOT_GOALS_ROOT` override
  is honored, and the recommended-workspace-path pointer prints when the
  script runs outside the managed root.
- **Goal worker / env**: `src/commands/goal.test.ts` covers the new
  managed default in `resolveWorkingDir`, that explicit `--working-dir`
  still wins, that legacy `workingDir` still resolves with
  `allowLegacyWorkingDir=true`, and that out-of-managed `workingDir` is
  rejected only when the flag is `false`. `src/goal/cli-worker.test.ts` and
  `src/goal/agent-executor.test.ts` mirror the same compatibility at the
  worker / executor layers, plus assert `buildGoalWorkerEnv` strips
  provider creds and never carries private env values by default. A
  focused test covers `loadWorkspacePrivateEnv` refusing paths outside
  `<managed-root>/private/env/<slug>/`.
- **History mirror**: `src/goal/run-store.test.ts` and
  `src/repo-chat/repo-chat-store.test.ts` assert summaries are written
  through `redactSecretValues`, do not include raw stdout/stderr or
  transcripts unless explicitly opted in, and that the global indexes
  append exactly once per id.
- **Repo-chat access**: `src/repo-chat/repo-chat-worker.test.ts` asserts
  the worker's allow-root contains `<root>/agent`, excludes
  `<root>/private`, that reads from `agent/history` succeed, and that
  reads from `private/env` fail.
- **Naming**: `src/goal/format-output.test.ts` and
  `src/telegram/goal-commands.test.ts` assert the new `Workspace:` text and
  that the old `**Working dir:**` plan label is gone for managed-goal
  flows.
- **Prompts / docs**: `src/prompts/prompts.test.ts` asserts the Stage 2S
  Workspace section is present in the shared worker contract (with 16
  specific needles including `~/smithersbot-goals`, `SMITHERSBOT_GOALS_ROOT`,
  `process.env`, `os.environ`, the private env path, sanitized summaries,
  `buildGoalWorkerEnv`, the trusted host-side phrasing, the no-OS-isolation
  disclaimer, and the `allowLegacyWorkingDir` legacy wording), and a
  repo-chat context test asserts the new history references and the
  exclusion of `<managed-root>/private`. Byte-identical mirroring of the
  contract into `AGENTS.md` and `CLAUDE.md` is verified by the existing
  mirror invariant.

---

## Verification results

All Stage 2S verification commands ran from this branch
(`claw/run/20260521-150813Z-f29b93fe-aaeb-4676-a6c0-68a6c5ae1814`). Raw logs
are in `internal/stage2s-verification-logs/`.

| # | Command | Exit | Result |
|---|---------|------|--------|
| 1 | `pnpm vitest run src/config/ src/security/ src/goal/ src/repo-chat/ src/telegram/goal-commands.test.ts src/telegram/repo-chat-commands.test.ts` | 0 | 94 test files passed (1 skipped); 1449 tests passed (9 skipped); 71.73s. |
| 2 | `pnpm vitest run src/prompts/` | 0 | 1 test file passed; 37 tests passed; 3.92s. |
| 3 | `pnpm exec tsc -p tsconfig.json` | 0 | No diagnostics. |
| 4 | `pnpm build` | 0 | `tsc` + canvas/a2ui copy + hook metadata + scout template + worker-contract copy + build-info write all succeeded. |
| 5 | `pnpm lint` | 0 | `oxlint --type-aware src test` → 0 warnings, 0 errors over 2319 files in 17.5s. |
| 6 | `pnpm test` | 0 | Worker env runs the goal-scoped parallel suite (`MOLTBOT_GOAL_TEST_SCOPE=1`): 1 test file passed; 15 tests passed; matches the Stage 2Q baseline. |
| 7 | `git diff --stat` | 0 | Empty (working tree clean apart from the new `internal/stage2s-verification-logs/` directory). Stage 2S commit-range diff (`git diff --stat HEAD~6...HEAD`) shows 37 files changed, 1777 insertions(+), 35 deletions(-). |
| 8 | `git grep -n 'smithersbot-goals' -- src scripts README.md SETUP.md` | 0 | 20 hits across README.md, SETUP.md, `scripts/setup-smithersbot.sh`, `src/config/managed-paths.ts`, `src/commands/goal.test.ts`, `src/config/paths.test.ts`, `src/goal/worker-context/{AGENTS,CLAUDE,shared-worker-contract}.md`, `src/prompts/prompts.test.ts`, `src/prompts/repo-chat/repo-chat-context.ts`. |
| 9 | `git grep -nE '\\.env\\.example\|private/env\|agent/history\|agent/workspaces' -- src scripts README.md SETUP.md` | 0 | 81 hits across managed-paths, secret-paths, repo-chat-worker, repo-chat-context, agent-history, setup script, README, SETUP, worker-context, prompts.test.ts, and the new test files. |
| 10 | `git grep -n 'workingDir' -- src/goal src/commands src/telegram src/config` | 0 | 766 hits — internal `workingDir` identifiers preserved across config, goal, telegram, commands. |
| 11 | `git grep -n 'Workspace:' -- src README.md SETUP.md` | 0 | 19 hits: managed-workspace label flows in goal/format-output.ts, telegram/goal-commands.ts, commands/goal.ts, agents commands, auto-reply commands-context-report, plus the workspace-policy warning, and the new label assertions in tests. |
| 12 | `git grep -n 'Working dir:' -- src README.md SETUP.md` | 0 | 3 hits, all intentional: `src/cli/daemon-cli/status.print.ts:86` and `src/cli/node-cli/daemon.ts:533` print the daemon `workingDirectory` (not the managed goal workspace), and `src/goal/format-output.test.ts:159` asserts the negative `not.toContain('**Working dir:**')` invariant. |

**Notes on `pnpm test`:** The Stage 2Q baseline established that the goal
worker's environment runs the goal-scoped parallel test slice
(`MOLTBOT_GOAL_TEST_SCOPE=1`), producing `1 file/15 tests`. Stage 2S
preserves that result. Independent runs of the broader unit suite outside
the worker env still surface pre-existing, Stage 2S-unrelated failures in
channels/pairing/onboard/teams catalog/auth code paths — those failures
exist on `main` and are out of scope for this stage. The Stage 2S surface
(`src/config/`, `src/security/`, `src/goal/`, `src/repo-chat/`,
`src/telegram/goal-commands.test.ts`, `src/telegram/repo-chat-commands.test.ts`,
`src/prompts/`) is fully green.

---

## Manual dogfood instructions

To exercise Stage 2S end-to-end on a host:

1. **Fresh managed root**
   ```
   bash scripts/setup-smithersbot.sh
   ls -la ~/smithersbot-goals
   ls -ld ~/smithersbot-goals/private ~/smithersbot-goals/private/env
   ```
   Expect: `agent/`, `private/`, `scratch/` present; `private/*` is 700.

2. **Stage the repo into a managed workspace**
   ```
   git clone ~/moltbot ~/smithersbot-goals/agent/workspaces/smithersbot/repo
   ```

3. **Create a fake real env (host-side)**
   ```
   mkdir -p ~/smithersbot-goals/private/env/smithersbot
   chmod 700 ~/smithersbot-goals/private/env/smithersbot
   printf 'STAGE2S_CANARY=stage2s-real-canary-do-not-leak\n' \
     > ~/smithersbot-goals/private/env/smithersbot/.env
   chmod 600 ~/smithersbot-goals/private/env/smithersbot/.env
   ```

4. **Confirm the repo has `.env.example`**
   ```
   head ~/smithersbot-goals/agent/workspaces/smithersbot/repo/.env.example
   ```

5. **Start the gateway** through the operator's normal procedure.

6. **/repo_chat**
   - Ask the bot about README.md and prior goal history.
   - Confirm citations reference `<managed-root>/agent/...` only.
   - Confirm no answer references `<managed-root>/private/...` or
     `STAGE2S_CANARY`.

7. **/new_goal "inspect repo state"**
   - Confirm the run is bound to the managed workspace.
   - Confirm the plan caption shows `Workspace:` (not `Working dir:`).

8. **/new_goal "summarize the variables in .env.example"**
   - Confirm the goal reads `.env.example` from the managed repo.
   - Confirm generated code, if any, references variables via `process.env.X`
     / `os.environ['X']` rather than opening
     `~/smithersbot-goals/private/env/smithersbot/.env`.

9. **Grep for canary leakage**
   ```
   grep -R "STAGE2S_CANARY" ~/smithersbot-goals/agent || echo "no agent leak"
   grep -R "stage2s-real-canary-do-not-leak" ~/.smithersbot/goals || echo "no runtime leak"
   ```
   Expect both `no agent leak` and `no runtime leak`.

10. **Toggle the legacy compatibility flag (optional)**
    - Set `config.goal.allowLegacyWorkingDir = false` in gateway config.
    - Re-run `/new_goal` from a legacy workingDir like `~/moltbot` — the
      worker should reject with the Stage 2S workspace error. Re-enable
      the flag afterward.

---

## Final Codex-only dogfood readiness

Yes. The Stage 2S managed-root path model, transitional compatibility flag,
sanitized history mirrors, `Workspace:` rename, prompt/doc refresh, and
focused test surface are in place. The goal worker can be exercised from
this repository's current legacy path under the default-on
`allowLegacyWorkingDir` flag, and from a freshly staged managed workspace
once an operator follows the migration steps above. Stage 2S leaves
fail-closed enforcement for non-managed workspaces deliberately disabled
so existing installs continue to work; a follow-up stage can flip the
default once operators have migrated.
