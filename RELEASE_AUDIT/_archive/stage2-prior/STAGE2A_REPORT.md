# Stage 2A — GitHub Proof-Release Cleanup Report

This report reflects actual observed repo state at W6 time. It is not a
template. Every section was verified against the live working tree, `git log`,
`git status --porcelain`, `git remote -v`, and `git branch -a`.

## HEAD anchor (W0) vs current HEAD

| Marker         | SHA                                        |
| -------------- | ------------------------------------------ |
| W0 anchor      | `2de36795c63f55a9cc7aef97091572ebf041d7ef` |
| Current HEAD   | `07f09f9dd519add7884ec93cf5eb3a65f03b1665` |

The current HEAD is the orchestrator's `claw: w5-package-identity` autosave
commit, placed on top of W5's worker commit `a57d42ed` so the worker-status
summary is captured in git history. All worker-authored commits (W1–W5) sit
between the W0 anchor and current HEAD.

## Per-worker commit SHAs (W1–W5)

`git log -n 15 --format='%H %s'` was used to enumerate the relevant range.
The worker-authored commits, in order, are:

| Worker | SHA        | Subject                                                                                                       |
| ------ | ---------- | ------------------------------------------------------------------------------------------------------------- |
| W1     | `97e96403` | `chore(identity): rewrite SmithersBot governance and add NOTICE.md`                                           |
| W2     | `0cfddb84` | `docs(attribution): replace upstream credits with NOTICE.md and fork-start CHANGELOG`                         |
| W3     | `f26ab617` | `docs(surface): rewrite README, install docs, issue templates for Telegram-only v0; delete customer-guide`   |
| W4     | `ddbb3c75` | `chore(pii): sanitize personal paths and identifiers in docs, scripts, and test fixtures`                     |
| W5     | `a57d42ed` | `build(pkg): SmithersBot identity in package.json (name, bin, description, author, homepage, repository, bugs, keywords)` |

Full SHAs:

```text
97e96403527e527815075f898b3ee473fb7c4005  chore(identity): rewrite SmithersBot governance and add NOTICE.md
0cfddb840c30db79fd9bb0810e2dac29b4fa02c0  docs(attribution): replace upstream credits with NOTICE.md and fork-start CHANGELOG
f26ab617637795670978cbe465b4891fde27b969  docs(surface): rewrite README, install docs, issue templates for Telegram-only v0; delete customer-guide
ddbb3c75eeba3fb9fc133d2ab056fd385b99498d  chore(pii): sanitize personal paths and identifiers in docs, scripts, and test fixtures
a57d42ed812ef72901794b254e8429f9bf441244  build(pkg): SmithersBot identity in package.json (name, bin, description, author, homepage, repository, bugs, keywords)
```

W3 spanned three sub-steps (readme, issue-templates+install, onboarding+delete)
but resolved to a single squashed worker commit `f26ab617`, as required.
Similarly W4 spanned two sub-steps (docs/scripts, then test fixtures) and
landed as a single worker commit `ddbb3c75`. Orchestrator `claw: ...` autosave
commits between these are status-summary artifacts and do not count against
the "one commit per code-touching worker" rule.

## Working-tree state at start vs now

At W0 start (quoted from `RELEASE_AUDIT/STAGE2A_NOTES.md` §"Working-tree state
at W0 start"):

```text

```

(`git status --porcelain` was empty — clean tree; no dirty paths outside
`RELEASE_AUDIT/`. Gate result: proceed.)

At W6 time (re-ran `git status --porcelain` just now):

```text

```

Working tree is clean. The only Stage 2A artifact not yet present in HEAD at
the moment this report is being authored is this report file itself; if it is
committed it will land as a separate `docs(stage2a): record cleanup report`
commit, otherwise it will be the only working-tree dirt at the moment W6
finishes.

## W5 tsc verification outcome

**PASS.** Path taken in this run: **W5 committed**.

- Command: `pnpm exec tsc -p tsconfig.json` (direct invocation — **not**
  `pnpm build`, which would have triggered a2ui/copy/build-info side effects
  that are out of scope for 2A).
- Exit code: `0`, zero output.
- Resulting commit: `a57d42ed812ef72901794b254e8429f9bf441244`.
- Source: `RELEASE_AUDIT/STAGE2A_NOTES.md` §"W5 — package.json identity
  outcome".

The alternate halt path (`W5: no commit (tsc verification failure)`) was not
taken. No tsc-failure capture exists in STAGE2A_NOTES.md because none was
needed.

## Per-worker acceptance confirmation

- **W0 — preflight**: passed. Clean-tree gate satisfied; HEAD anchor recorded;
  canonical identity quoted; remote/branch baselines captured; optional
  merge-base refinement failed on the single allowed attempt, fallback
  fork-point SHA `4583f88626f20efedc454d893afaaf898c23523b` retained. No
  commit, as required.
- **W1 — identity**: passed. `SECURITY.md` rewritten to `contact@smithersbot.com`
  with the `docs.molt.bot/gateway/security` link replaced and MIT/disclosure
  structure preserved. `.github/FUNDING.yml` deleted. `CONTRIBUTING.md`
  reduced to single-maintainer governance with GitHub Issues for
  bugs/feedback and no SLA. Repo-local `git config user.name`/`user.email`
  set (never `--global`). `NOTICE.md` created at repo root citing W0's
  fork-point SHA and naming the upstream copyright holder. Single commit
  `97e96403` with hooks running normally.
- **W2 — attribution**: passed. `scripts/clawtributors-map.json`,
  `scripts/update-clawtributors.ts`, `scripts/update-clawtributors.types.ts`
  deleted. No `scripts.*` entry in `package.json` referenced
  `update-clawtributors`, so package.json was not edited in W2. `README.md`
  contributor avatar grid, Steinberger credit + steipete.me link, and Mario
  Zechner / pi-mono credit removed and replaced with a single
  "Project by Matthew Overing — see NOTICE.md" line. `CHANGELOG.md`
  truncated to a single SmithersBot fork-start (2026-01-29) entry citing
  `4583f886`. Single commit `0cfddb84`.
- **W3 — public-facing docs and links**: passed. `README.md` stripped of CI
  badge, Discord shield, `discord.gg/clawd`, `nix-clawdbot`, `clawdhub.com`
  link-bar entries, hero `<img>`, and any non-Telegram channel advertising;
  install instructions rewritten as source-clone steps with no
  `molt.bot/install*` URLs. `.github/ISSUE_TEMPLATE/{bug_report.md,
  feature_request.md,config.yml}` rewritten for SmithersBot with GitHub
  Issues-only contact. `docs/install/installer.md`, `docs/install/index.md`,
  `docs/start/getting-started.md` source-install rewrite (files kept, not
  deleted). `docs/start/onboarding.md` and `docs/start/setup.md` had
  `~/.clawdbot` / `~/clawd` paths replaced with `~/.smithersbot/...` (v0)
  placeholders; macOS-app onboarding bodies left intact and flagged in
  STAGE2A_NOTES.md for 2B. `docs/customer-guide.md` deleted. Single commit
  `f26ab617`.
- **W4 — private artifacts and PII**: passed. `AGENTS.md` and `CLAUDE.md`
  scrubbed of 1Password vault paths, internal SSH targets, `flawd-bot` /
  `exe.dev` references, and personal `~/.clawdbot` operator notes
  (placeholders / removals only). `scripts/auth-monitor.sh`,
  `scripts/systemd/clawdbot-auth-monitor.service`, and
  `scripts/termux-sync-widget.sh` had hardcoded `/home/admin` paths and
  personal SSH targets replaced with `user@gateway-host` / `~/`
  placeholders. `docs/automation/gmail-pubsub.md` Gmail example replaced
  with `user@example.com`. `.env` confirmed gitignored via
  `git check-ignore .env` without being read or modified. The five
  permitted test fixtures (`src/commands/gateway-status.test.ts`,
  `src/commands/health-format.test.ts`,
  `src/commands/doctor.warns-per-agent-sandbox-docker-browser-prune.test.ts`,
  `src/infra/ssh-config.test.ts`, `src/media/parse.test.ts`) sanitized to
  `/Users/example/`, `gateway.example`, `user@example.com` placeholders;
  each fixture exercised individually via `pnpm vitest run <file>` and
  passed. No other `src/**` file edited. Single commit `ddbb3c75`.
- **W5 — package.json identity**: passed. Only the explicitly listed fields
  edited (`name`, `bin`, `description`, `author`, `homepage`, `repository`,
  `bugs`, `keywords`); `version`, `engines`, `dependencies`,
  `devDependencies`, `scripts`, `files`, `exports`, `main`, `type`,
  `packageManager` left untouched. Real origin URL
  `https://github.com/smithersbot/smithersbot.git` used in
  `repository`/`bugs` — no `<TBD-org>` placeholder, no TODO(stage2b).
  JSON validity confirmed via the `node -e "JSON.parse(...)"` one-liner.
  Direct `pnpm exec tsc -p tsconfig.json` invocation passed with exit 0
  and zero output. Single commit `a57d42ed`.

## Files created during Stage 2A

| Path                                  | Notes                                                      |
| ------------------------------------- | ---------------------------------------------------------- |
| `NOTICE.md`                           | Upstream MIT attribution, fork-point SHA, copyright holder |
| `RELEASE_AUDIT/STAGE2A_NOTES.md`      | W0 anchor + baselines, canonical identity, W5 outcome      |
| `RELEASE_AUDIT/STAGE2A_REPORT.md`     | This report                                                |

## Files deleted during Stage 2A

| Path                                    | Verified absent at W6 |
| --------------------------------------- | --------------------- |
| `scripts/clawtributors-map.json`        | yes                   |
| `scripts/update-clawtributors.ts`       | yes                   |
| `scripts/update-clawtributors.types.ts` | yes                   |
| `.github/FUNDING.yml`                   | yes                   |
| `docs/customer-guide.md`                | yes                   |

(`ls` returned `No such file or directory` for each path at W6 time.)

## Remote and branch comparison (W0 baseline vs current)

`git remote -v` at W0 start (quoted from STAGE2A_NOTES.md):

```text
openclaw	https://github.com/openclaw/openclaw.git (fetch)
openclaw	https://github.com/openclaw/openclaw.git (push)
origin	https://github.com/smithersbot/smithersbot.git (fetch)
origin	https://github.com/smithersbot/smithersbot.git (push)
personal	https://github.com/moocember/moltbot-private.git (fetch)
personal	DISABLED (push)
upstream	https://github.com/moltbot/moltbot (fetch)
upstream	https://github.com/moltbot/moltbot (push)
```

`git remote -v` at W6 (re-ran just now):

```text
openclaw	https://github.com/openclaw/openclaw.git (fetch)
openclaw	https://github.com/openclaw/openclaw.git (push)
origin	https://github.com/smithersbot/smithersbot.git (fetch)
origin	https://github.com/smithersbot/smithersbot.git (push)
personal	https://github.com/moocember/moltbot-private.git (fetch)
personal	DISABLED (push)
upstream	https://github.com/moltbot/moltbot (fetch)
upstream	https://github.com/moltbot/moltbot (push)
```

**Remotes: unchanged.** Byte-for-byte identical to the W0 baseline.

`git branch -a | wc -l` at W0 start: **`799`**
`git branch -a | wc -l` at W6: **`799`**

**Branch count: unchanged.** No branch operations performed during 2A.

## Executed git/npm/pnpm commands (no prohibited ops)

The complete set of git / npm / pnpm command-classes invoked across W0–W6:

- `git status --porcelain` — repeated for gate checks and report.
- `git rev-parse HEAD` — recorded W0 anchor; recorded current HEAD.
- `git log -n <N> --format='%H %s'` — enumerate worker commits.
- `git show --stat --format='' <sha>` — verify W1 and W2 commit contents.
- `git remote -v` — capture W0 baseline; verify unchanged at W6.
- `git branch -a | wc -l` — capture W0 baseline; verify unchanged at W6.
- `git fetch upstream main 2>/dev/null && git merge-base upstream/main HEAD`
  — single optional attempt in W0; failed cleanly; no retry.
- `git config user.name "Matthew Overing"` (repo-local) — W1 only.
- `git config user.email "contact@smithersbot.com"` (repo-local) — W1 only.
- `git diff --check` — workers W2, W3, W4 (whitespace check only).
- `git diff --stat` — change-scope review across W1–W5.
- `git ls-files <path>` — verify `docs/customer-guide.md` absent after W3.
- `git check-ignore .env` — confirm `.env` gitignored in W4 (no read/modify).
- `scripts/committer "<msg>"` (hooks running normally, no `--no-verify`)
  — once per code-touching worker (W1–W5).
- `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"`
  — W5 JSON validity check.
- `pnpm exec tsc -p tsconfig.json` — W5 only; passed.
- `pnpm vitest run <file>` — W4 only; one invocation per touched fixture;
  five files total, all passed.

**Not executed (prohibited):** `git push`, `git push --force`,
`--force-with-lease`, `git filter-repo`, `git filter-branch`, `git rebase -i`,
`git gc`, `git repack`, `git reflog expire`, `git remote remove`,
`git remote add`, `git branch -D`, `git branch -d`, `git stash drop`,
`git stash clear`, `git tag` create/delete, `npm publish`, `pnpm publish`,
`npm pack` (even `--dry-run`), `pnpm install`, `pnpm lint`, `pnpm test`
(full), `pnpm build`. No `--no-verify` / `-n` hook-skip flag was used.

## TODO(stage2b) markers introduced

**None.** The W5 plan explicitly opted for the existing
`https://github.com/smithersbot/smithersbot.git` origin URL in
`package.json` `repository`/`bugs`, so no `<TBD-org>` placeholder and no
TODO(stage2b) marker for the org/repo URL was introduced. No other
worker added a TODO(stage2b) marker.

## Deferred to Stage 2B

The following items are explicitly out of scope for 2A and remain deferred:

- `package.json` `files` allowlist trim (and any other `package.json` field
  not enumerated in W5).
- Source-channel directory deletion: `src/web`, `src/whatsapp`, `src/discord`,
  `src/slack`, `src/signal`, `src/imessage`, `src/line`, `src/channel-web.ts`,
  `src/channels/web/`.
- Native-app deletion: `apps/ios`, `apps/android`, `apps/macos`,
  `apps/shared/MoltbotKit`.
- `apps/macos` About-surface PII scrub
  (`apps/macos/Sources/Moltbot/AboutSettings.swift` and adjacent surfaces).
- macOS-app onboarding rewrite/removal: full body rewrite of
  `docs/start/onboarding.md` and the macOS-app sections of
  `docs/start/setup.md` (Stage 2A only swapped `~/.clawdbot` / `~/clawd`
  path strings to `~/.smithersbot/...`).
- `src/web` extraction and any architectural refactor.
- Extension deletion: `extensions/*` (including `extensions/bluebubbles`).
- `extensions/bluebubbles` fixture PII sanitization (phone numbers etc.) —
  paired with that extension's deletion.
- Peripheral directory deletion: `Swabble/`, `smithersbot_marketing/`,
  `openclaw-starter-kit/`.
- `dependabot.yml` trim.
- Git remote/branch/stash hygiene (remote removal, branch pruning, stash
  cleanup).
- History squash / rewrite of any kind.
- Public `git push` to the SmithersBot origin.
- CI workflow creation (the README CI badge was removed in 2A; a real
  workflow + re-added badge belongs in 2B).
- Any follow-up internal self-import work surfaced by the W5 build
  verification — **N/A this run**, because W5 tsc passed cleanly.

## Go / No-Go recommendation

**Go (with the deferred-to-2B caveats above).**

The Stage 2A acceptance surface — what a stranger lands on when they open the
public repo — is clean:

- No upstream attribution leakage on the public reading path. `README.md`,
  `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, and the issue templates
  carry SmithersBot identity; upstream credit is consolidated in `NOTICE.md`
  per MIT.
- No personal PII in operator-facing docs that surface publicly:
  `AGENTS.md`, `CLAUDE.md`, the named scripts, and the five test fixtures
  all use generic placeholders.
- No dead links visible on the public path. Hosted `molt.bot/install*`
  references are gone from the public install docs; `discord.gg/clawd`,
  `clawdhub.com`, `nix-clawdbot`, and the CI badge are removed.
- `package.json` identity carries SmithersBot fields with a real
  `repository` URL — no `<TBD-org>` placeholders.
- Working tree is clean, no remotes/branches were touched, no prohibited
  operations were performed, and every code-touching worker landed exactly
  one conventional-style commit with hooks running normally.

Stage 2A does **not** assert that the repo is ready for an `npm publish` or
that the source tree is channel-trimmed; both are explicitly Stage 2B. It
asserts that the GitHub-visible reading surface is presentable.

---

*Report generated at W6 from live repo state; not a template.*
