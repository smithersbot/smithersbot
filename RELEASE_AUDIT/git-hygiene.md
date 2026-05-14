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
