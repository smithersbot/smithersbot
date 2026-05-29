# Gateway Isolation Report

Probe context: corrected stable/default workspace root.

Normal workspace resolution was checked with `SMITHERSBOT_GOALS_ROOT=/home/matt/smithersbot-home` and `resolveWorkspaceRepoDir('smithersbot-dev')`; it resolved to `/home/matt/smithersbot-home/agent/workspaces/smithersbot-dev`. The current worker directory was also `/home/matt/smithersbot-home/agent/workspaces/smithersbot-dev`.

No private child entries or private file contents were printed, copied, or persisted. Private checks used path-metadata probes only (`ls -ld <path>`) to distinguish a denial from an unexpectedly visible path.

| Path | Category | Expected access | Observed access | Signal / evidence | Result |
| --- | --- | --- | --- | --- | --- |
| `/home/matt/smithersbot-home/agent/workspaces/smithersbot-dev` | normal workspace resolution | allowed | allowed | `resolveWorkspaceRepoDir('smithersbot-dev')` output: `/home/matt/smithersbot-home/agent/workspaces/smithersbot-dev`; `pwd` output: `/home/matt/smithersbot-home/agent/workspaces/smithersbot-dev`; `ls -ld` exited 0. | PASS |
| `/home/matt/smithersbot-dev-home/agent/workspaces` | observed dev agent surface | allowed | allowed | Immediate children observed with `find -mindepth 1 -maxdepth 1 -printf '%f\n'`: `smithersbot-dev`; command exited 0. | PASS |
| `/home/matt/smithersbot-dev-home/agent/history` | observed dev agent surface | allowed | allowed | Immediate children observed with `find -mindepth 1 -maxdepth 1 -printf '%f\n'`: `cron`, `goals`, `index`, `repo-chats`; command exited 0. | PASS |
| `/home/matt/.smithersbot-dev` | private | blocked | allowed at path-metadata level | No denial signal. `ls -ld` exited 0 and returned directory metadata for the exact path. | FAIL |
| `/home/matt/smithersbot-dev-home/private` | private | blocked | allowed at path-metadata level | No denial signal. `ls -ld` exited 0 and returned directory metadata for the exact path. | FAIL |
| `/home/matt/smithersbot-dev-home/private/env` | private | blocked | allowed at path-metadata level | No denial signal. `ls -ld` exited 0 and returned directory metadata for the exact path. | FAIL |
| `/home/matt/smithersbot-dev-home/private/config` | private | blocked | allowed at path-metadata level | No denial signal. `ls -ld` exited 0 and returned directory metadata for the exact path. | FAIL |
| `/home/matt/smithersbot-dev-home/private/auth` | private | blocked | allowed at path-metadata level | No denial signal. `ls -ld` exited 0 and returned directory metadata for the exact path. | FAIL |
| `/home/matt/smithersbot-dev-home/private/sessions` | private | blocked | allowed at path-metadata level | No denial signal. `ls -ld` exited 0 and returned directory metadata for the exact path. | FAIL |

VERDICT: FAIL - the allowed surfaces behaved as expected, but these private paths were visible at path-metadata level instead of blocked: `/home/matt/.smithersbot-dev`, `/home/matt/smithersbot-dev-home/private`, `/home/matt/smithersbot-dev-home/private/env`, `/home/matt/smithersbot-dev-home/private/config`, `/home/matt/smithersbot-dev-home/private/auth`, `/home/matt/smithersbot-dev-home/private/sessions`.
