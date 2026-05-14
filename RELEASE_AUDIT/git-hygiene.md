# Git Hygiene State Capture

This file records Stage 1 read-only git state for public-release readiness. It intentionally contains data-capture sections only; inventory entries and cleanup recommendations are deferred to the W5 narrative subtask.

## Repository Size And Counts

| Measurement | Value | Source |
| --- | ---: | --- |
| `.git` size on disk | 227M | `du -sh .git` |
| Commits across all refs | 10,385 | `git log --all --oneline \| wc -l` |
| Tags | 45 | `git for-each-ref refs/tags \| wc -l` |

## Remotes

| Remote | URL | Direction | Classification | Evidence |
| --- | --- | --- | --- | --- |
| openclaw | `https://github.com/openclaw/openclaw.git` | fetch | drop | `git remote -v` |
| openclaw | `https://github.com/openclaw/openclaw.git` | push | drop | `git remote -v` |
| origin | `https://github.com/smithersbot/smithersbot.git` | fetch | drop | `git remote -v` |
| origin | `https://github.com/smithersbot/smithersbot.git` | push | drop | `git remote -v` |
| personal | `https://github.com/moocember/moltbot-private.git` | fetch | drop | `git remote -v` |
| personal | `DISABLED` | push | drop | `git remote -v` |
| upstream | `https://github.com/moltbot/moltbot` | fetch | keep | `git remote -v` |
| upstream | `https://github.com/moltbot/moltbot` | push | keep | `git remote -v` |

## Branch Census

| Metric | Count | Source |
| --- | ---: | --- |
| Total local and remote refs | 797 | `git for-each-ref refs/heads refs/remotes` |
| Local branches | 152 | `git for-each-ref refs/heads refs/remotes` |
| Remote branches | 645 | `git for-each-ref refs/heads refs/remotes` |

| Prefix / Group | Count | Notes |
| --- | ---: | --- |
| `main` | 1 | Local `main` branch. |
| `claw/run/*` | 131 | Local goal/run branches. |
| `claw/<id>/*` | 7 | Local ID-scoped claw branches outside `claw/run/*`. |
| `backup/*` | 1 | Local backup branch. |
| `origin/*` | 46 | Remote-tracking refs under `origin`. |
| `upstream/*` | 301 | Remote-tracking refs under `upstream`. |
| `openclaw/*` | 292 | Remote-tracking refs under `openclaw`. |
| `personal/*` | 6 | Remote-tracking refs under `personal`. |
| Other local refs | 12 | Includes `develop`, `experiment/*`, `fix/*`, `goal-*`, `integrate/*`, `preview/*`, `rescue/*`, and `smithers/*`. |

## Git User Identity

| Config key | Value | Flag | Source |
| --- | --- | --- | --- |
| `user.email` | `123456+yourhandle@users.noreply.github.com` | Placeholder-looking value with `yourhandle`. | `git config --get user.email` |
| `user.name` | `M O` | Short personal initials rather than project/release identity. | `git config --get user.name` |

## Stash Listing

| Stash | Description | Source |
| --- | --- | --- |
| `stash@{0}` | `WIP on openclaw-telegram-plan-ux: 9bc87fd7b fixed CPM ordering` | `git stash list` |

## Last 20 Commit Subjects

Captured via `git log -n20 --format=%s` on the current branch (`claw/run/20260514-211302Z-afe5de59-e529-4874-aa3d-257af9f2ba98`).

| # | Subject (truncated to first line) | Pattern |
| ---: | --- | --- |
| 1 | `claw: w3-memory-state - Appended Memory & state section to RELEASE_AUDIT/keep-vs-cut.md. Invento` | auto-generated `claw: <task>` |
| 2 | `claw: w6-url-inventory - Appended Section 6 URL inventory to RELEASE_AUDIT/broken-public-surface.` | auto-generated `claw: <task>` |
| 3 | `claw: w4-pii-sweep - Appended the PII and personal-data sweep to RELEASE_AUDIT/secrets-and-pi` | auto-generated `claw: <task>` |
| 4 | `claw: w5-git-state - Created RELEASE_AUDIT/git-hygiene.md with W5 state-capture sections: .gi` | auto-generated `claw: <task>` |
| 5 | `claw: w2-attribution-debt - W2 attribution debt: produced RELEASE_AUDIT/attribution-debt.md covering` | auto-generated `claw: <task>` |
| 6 | `claw: w1-brand-references - Created RELEASE_AUDIT/brand-references.md with token-frequency table, co` | auto-generated `claw: <task>` |
| 7 | `claw: w6-templates-docker-onboarding - Appended Sections 3 (issue/PR templates), 4 (Docker defaults), and 5 (in` | auto-generated `claw: <task>` |
| 8 | `claw: w4-secrets-sweep - Created RELEASE_AUDIT/secrets-and-pii.md with the W4 secrets sweep cover` | auto-generated `claw: <task>` |
| 9 | `claw: w6-package-and-ci - Created RELEASE_AUDIT/broken-public-surface.md with package metadata and` | auto-generated `claw: <task>` |
| 10 | `claw: w3-keep-vs-cut - Produced RELEASE_AUDIT/keep-vs-cut.md with six sections (extensions/*, s` | auto-generated `claw: <task>` |
| 11 | `claw: split-response-files - Updated repo-chat Codex handling to use separate manual and last-message` | auto-generated `claw: <task>` |
| 12 | `claw: fix-repo-chat-placeholder-fallback - Made repo-chat response files authoritative by attempting repair before` | auto-generated `claw: <task>` |
| 13 | `claw: fix-codex-resume-arg-shape - Narrowed the codex resume arg list in src/repo-chat/repo-chat-worker.ts` | auto-generated `claw: <task>` |
| 14 | `claw: fix-codex-readonly-and-memory-regressions - src/repo-chat/repo-chat-worker.ts: (1) buildCodexRepoChatArgs now passes` | auto-generated `claw: <task>` |
| 15 | `claw: fix-codex-repo-chat-resume - src/repo-chat/repo-chat-worker.ts: extractSessionIdFromStdout sessionIdF` | auto-generated `claw: <task>` |
| 16 | `claw: autosave before goal 7a14de44-cf99-402d-a66b-067fb7d3f9eb` | auto-generated `claw: autosave` |
| 17 | `claw: write-availability-tests - Added src/goal/backend-availability.test.ts covering signal retry succes` | auto-generated `claw: <task>` |
| 18 | `claw: remove-cache - Removed module-level cachedAvailability and cachedCodexAskForApproval fr` | auto-generated `claw: <task>` |
| 19 | `claw: fix-probe-retry - Updated src/goal/backend-availability.ts so runProbe() retries once afte` | auto-generated `claw: <task>` |
| 20 | `claw: wire-cli-and-verify - Added lazy-loaded gstack CLI structure registration and new src/cli/gstack-cli.ts` | auto-generated `claw: <task>` |

Findings:

- 20 of 20 (100%) of the most recent subjects are auto-generated `claw: <slug>` prefixes produced by the `/goal` worker pipeline. None look like hand-authored Conventional Commit subjects (`feat:`, `fix:`, `chore:`, etc.).
- Subjects routinely contain the prefix `claw:` (legacy/internal brand), the body is a worker-blurb fragment, and one subject (#16) is a literal `autosave` checkpoint referencing a run UUID. These artifacts are appropriate for a goal-run branch but would be public-history noise on `main`.
- The current branch is itself an auto-generated `claw/run/<ts>-<uuid>` branch (per Stage 1 system prompt); commits do not appear on `main` in this listing.

## `.gitattributes` Review

`.gitattributes` is a single line (`* text=auto eol=lf`) per `cat .gitattributes`. No fork-specific or stale entries; no broken patterns. Minimal and safe for public release.

## `.gitignore` Review

Source: `cat .gitignore` (76 lines). Per-line observations follow.

| Line(s) | Pattern | Classification | Notes |
| --- | --- | --- | --- |
| 3, 63 | `.env` | duplicate | Listed twice; once in the top block and again after the fastlane block. Harmless but should be deduped. |
| 6, 20, 38 | `*.bun-build`, `*.bun-build`, `**/*.bun-build` | duplicate / overlapping | Three near-identical entries. Consolidate to one `**/*.bun-build`. |
| 7 | `pnpm-lock.yaml` | fork-specific risk | Repository documents `pnpm install` (CLAUDE.md) but ignores the lockfile. Public consumers reproducing builds will not get a locked dep graph; investigate whether this was inherited from upstream Bun-first config. |
| 8 | `bun.lock` | fork-specific risk | Same concern as above: with Bun preferred for dev (`bun install`) but `bun.lock` ignored, no checked-in lockfile exists. |
| 21 | `apps/macos/.build/` | out-of-v0 | macOS app build cache; per W3 macOS app is out of v0. Pattern is correct but the directory is irrelevant to Telegram-only ship. |
| 22 | `apps/shared/MoltbotKit/.build/` | out-of-v0 | Same — macOS/iOS shared kit, out of v0. |
| 25 | `bin/clawdbot-mac` | stale brand reference | References legacy `clawdbot-mac` binary name; the project now uses `moltbot` (see W1 brand-references). |
| 26 | `bin/docs-list` | unused-looking | No corresponding file produced by current repo per `git ls-files bin/`. Investigate whether this is dead. |
| 27 | `apps/macos/.build-local/` | out-of-v0 | macOS local build dir; macOS app is out of v0. |
| 28-29 | `apps/macos/.swiftpm/`, `apps/shared/MoltbotKit/.swiftpm/` | out-of-v0 | SwiftPM caches for macOS-only surfaces. |
| 30 | `Core/` | unused-looking | Top-level `Core/` is not produced by Telegram path; investigate whether this is left over from a removed surface. |
| 31-33 | `apps/ios/*.xcodeproj/`, `apps/ios/*.xcworkspace/`, `apps/ios/.swiftpm/` | out-of-v0 | iOS app artifacts; iOS app is out of v0. |
| 35-36 | `apps/ios/Clawdbot.xcodeproj/`, `apps/ios/Clawdbot.xcodeproj/**` | stale brand reference | Two entries hard-coded to legacy `Clawdbot.xcodeproj` name — out-of-date if the Xcode project was renamed during rebrand. Cross-references W1 brand-references blockers. |
| 37 | `apps/macos/.build/**` | duplicate | Overlaps line 21 `apps/macos/.build/`. |
| 39 | `apps/ios/*.xcfilelist` | out-of-v0 | iOS-only filelist; out of v0. |
| 42-43 | `vendor/a2ui/renderers/lit/dist/`, `src/canvas-host/a2ui/*.bundle.js` | keep | Build artifacts for A2UI canvas host; keep regardless of v0 ship scope. |
| 44 | `src/canvas-host/a2ui/*.map` | keep | Sourcemap artifact for same. |
| 45 | `.bundle.hash` | keep | Matches `src/canvas-host/a2ui/.bundle.hash` per CLAUDE.md. |
| 48-55 | `apps/ios/fastlane/*` (multiple) | out-of-v0 / duplicate | iOS fastlane entries; iOS is out of v0. Lines 49 and 55 are duplicates of `apps/ios/fastlane/report.xml`. |
| 58-59 | `apps/ios/*.ipa`, `apps/ios/*.dSYM.zip` | out-of-v0 | iOS build artifacts. |
| 62 | `apps/ios/*.mobileprovision` | out-of-v0 | iOS provisioning. |
| 67 | `.vscode/` | nit | Personal editor config ignored — fine; flag for op review. |
| 68 | `IDENTITY.md` | investigate | Looks like a personal/identity scratchpad ignored from tracking; investigate whether this is a known artifact. |
| 69 | `USER.md` | investigate | Same pattern; investigate. |
| 70 | `.tgz` | broken-looking | Bare suffix `.tgz` matches files literally named `.tgz`, not all `*.tgz`. Likely intended `*.tgz`. |
| 73 | `.serena/` | unknown | External tool state directory; classification unknown to Stage 1 reader. |
| 74-75 | `.moltbot-goal-workspace/`, `.moltbot-goal-worker-results/` | fork-specific / internal | Goal-worker runtime artifacts; correct to ignore but reveals goal-run infrastructure to public readers. |

## Narrative Summary

The repository is large and shows clear fork-history scars: a 227 MB `.git` directory, ~10,385 commits across all refs, and 645 remote-tracking branches concentrated under three upstreams (`upstream` 301, `openclaw` 292, `personal` 6) plus `origin/*` 46. Three of the four configured remotes (`openclaw`, `origin` → `smithersbot/smithersbot.git`, `personal` → `moltbot-private.git`) point at unrelated or private repositories and should be removed from public-publishing clones. The current head is on an auto-generated `claw/run/*` branch, and 131 such branches exist locally; the last 20 commit subjects are 20/20 auto-generated `claw: <slug>` worker artifacts. The git identity is also problematic: `user.email` is a `yourhandle@users.noreply.github.com` placeholder and `user.name` is the personal initials `M O`. A WIP stash sits on a legacy `openclaw-telegram-plan-ux` branch. `.gitattributes` is clean; `.gitignore` has several duplicated patterns, stale Clawdbot/`clawdbot-mac` brand entries (lines 25, 35-36) that pair with W1 brand-reference blockers, one likely-broken pattern (`.tgz` instead of `*.tgz`), and two suspicious local-scratchpad ignores (`IDENTITY.md`, `USER.md`) that should be confirmed not to exist in untracked working trees before publishing.

## Pre-Publish Cleanup Checklist

Descriptive only — no shell commands inline (see Stage 2 heading at the bottom).

1. **Reset remotes.** Decide the single public-publish remote and remove the rest (`openclaw`, `origin → smithersbot`, `personal → moltbot-private`) so a public clone does not fetch from unrelated upstreams. Keep `upstream → github.com/moltbot/moltbot` only if the public-publish target is `moltbot/moltbot`.
2. **Prune branches.** Drop the 131 `claw/run/*` worker branches and 7 `claw/<id>/*` branches before publishing. Decide whether the `backup/*`, `experiment/*`, `fix/*`, `goal-*`, `integrate/*`, `preview/*`, `rescue/*`, `smithers/*`, and `develop` local branches should travel with the public release; default is no.
3. **Prune remote-tracking refs.** After remotes are removed, garbage-collect remote-tracking refs so `git for-each-ref refs/remotes` does not still report 645 entries from removed remotes.
4. **Set publishing identity.** Replace `user.email = 123456+yourhandle@users.noreply.github.com` and `user.name = M O` with the project release identity (project bot account or org maintainer). This is repo-local config so the change only affects this checkout.
5. **Drop the WIP stash.** The single stash references `openclaw-telegram-plan-ux` and is unlikely to be meaningful for the public release; confirm with operator before dropping.
6. **Shrink `.git`.** 227 MB is heavy for a public clone; investigate large blobs, dropped branches' loose objects, and pack consolidation. Consider a fresh shallow re-publish from a chosen commit instead of pushing full history if upstream/openclaw blobs are pulling weight.
7. **Decide commit-history strategy.** Last 20 subjects are 100% auto-generated `claw: ...` worker artifacts. Either (a) squash/replace the release branch onto a curated history before publishing, or (b) accept goal-worker-style subjects on the public record. Document the decision.
8. **Tidy `.gitignore`.** Dedupe `.env` (lines 3, 63), `*.bun-build` family (lines 6, 20, 38), `apps/macos/.build/` (lines 21, 37), and `apps/ios/fastlane/report.xml` (lines 49, 55). Fix the `.tgz` pattern (likely intended `*.tgz`). Update or remove stale Clawdbot/`clawdbot-mac` patterns (lines 25, 35-36) in sync with the rebrand work captured in W1. Decide whether to commit lockfiles (`pnpm-lock.yaml`, `bun.lock`) rather than ignoring them for a public release.
9. **Confirm working-tree hygiene.** Verify `IDENTITY.md`, `USER.md`, `.local/`, `.serena/`, `.vscode/`, `Core/`, `bin/docs-list` do not exist as untracked-but-real files in the publishing checkout before tagging.
10. **Tag review.** 45 tags exist; confirm tags align with the public release versioning plan or prune stale upstream tags (Stage 2 task).

## Candidate Stage 2 commands — DO NOT RUN IN STAGE 1

Everything below is reference material. Stage 1 must not execute any of it. Operators reviewing Stage 2 should run each command in a clean, backed-up checkout and verify intent before running.

```sh
# Reset remotes (Stage 2 only)
git remote remove openclaw
git remote remove origin
git remote remove personal
# Optionally re-point origin at the public publish target:
git remote add origin https://github.com/moltbot/moltbot.git

# Prune local goal/run branches (Stage 2 only)
git for-each-ref --format='%(refname:short)' refs/heads/claw/run | xargs -r -n1 git branch -D
git for-each-ref --format='%(refname:short)' refs/heads/claw   | xargs -r -n1 git branch -D
# Review before deleting these:
git for-each-ref refs/heads/backup refs/heads/experiment refs/heads/fix refs/heads/goal-* \
                 refs/heads/integrate refs/heads/preview refs/heads/rescue refs/heads/smithers

# Prune remote-tracking refs after the corresponding remote is removed (Stage 2 only)
git remote prune upstream
git remote prune origin

# Set publishing identity for this repo (Stage 2 only)
git config user.email "<project-release-email>"
git config user.name  "<project-release-name>"

# Drop the WIP stash (Stage 2 only — verify content first)
git stash show -p stash@{0}
git stash drop stash@{0}

# Shrink .git after pruning (Stage 2 only)
git reflog expire --expire=now --all
git gc --prune=now --aggressive

# History cleanup options (Stage 2 only — pick exactly one)
# Option A — curated public main from existing HEAD via fresh orphan:
git checkout --orphan public-main
git commit -m "Initial public release"
# Option B — interactive squash of recent goal-worker commits prior to publish:
git rebase -i <chosen-base-commit>
```

