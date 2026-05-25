# Launch Docs & Setup Polish Report

Date: 2026-05-24
Source audit: `internal/LAUNCH_DOCS_SETUP_AUDIT_REPORT.md`
Scope: docs/setup polish pass only. No source, tests, package files, scripts,
`.env*`, auth/private config, binary assets, or runtime behavior were changed.
The gateway was not restarted.

## Files changed

- `README.md` — command list, Telegram controls, smoke tests, Node floor,
  safety/auditability note, managed-workspace read/edit rule, Docker mentions
  removed. (tasks `update-readme-launch-docs`, `add-managed-workspace-rule`)
- `SETUP.md` — Node floor, smoke tests, blocked-goal answering, security-notes
  framing, managed-workspace read/edit rule, Docker mentions removed.
  (tasks `update-setup-docs`, `add-managed-workspace-rule`)
- `SECURITY.md` — unsupported Docker image/deployment/hardening claims removed;
  Node/CVE wording corrected; Operational Safety section added. (tasks
  `cleanup-security-changelog`, `fix-security-node-cve-and-safety`)
- `CHANGELOG.md` — dated 2026 launch-prep entry added. (task `cleanup-security-changelog`)
- `internal/launch-inputs/creative-direction.md` — portrait reference fixed to
  `.jpeg`; missing `screenshots/` directory marked TODO. (task `reconcile-launch-input-assets`)
- `internal/launch-inputs/demo-brief.md` — `screenshots/` reference marked TODO.
  (task `reconcile-launch-input-assets`)
- `internal/LAUNCH_DOCS_SETUP_POLISH_REPORT.md` — this report. (tasks
  `write-polish-report`, `update-polish-report-and-verify`)

## Feedback revision applied

- SECURITY.md no longer claims Node 22.12.0 includes patches for
  `CVE-2025-59466` or `CVE-2026-21636`; the CVE bullet list was removed.
- SECURITY.md keeps the floor at Node.js 22.12.0 or later and now says to use
  the latest available Node 22 LTS patch release rather than an older 22.x build.
- SECURITY.md now includes `## Operational Safety`, covering isolated
  VM/VPS/dedicated-machine operation, managed workspace repo placement for
  agent-readable/editable files, and keeping private env/config/auth/session
  files outside agent-visible history.
- README.md and SETUP.md now explicitly state that anything agents should read
  or edit must live inside a managed workspace repo:
  `~/smithersbot-goals/agent/workspaces/<workspace-name>/repo`.
- No onboarding-wizard CHANGELOG entry was added, because that implementation
  has not landed.
- Docker claims were not reintroduced.

## Audit items applied (checklist)

README command list:
- [x] Added `/gateway_status` (gateway process/service status).
- [x] Added `/usage_status` (Claude Code and Codex usage/quota status — intended
      behavior, no caveat).
- [x] Added `/goal_answer <runId> <answer>` (answer a blocked goal question; users
      can also reply to the question).
- [x] `/usage_history` kept absent from README.
- [x] Post-exec LLM diff review kept absent.
- [x] `pi` not advertised as a selectable launch backend.

README Telegram controls:
- [x] **Add Details** button named and explained.
- [x] Blocked goals can be answered by replying to the bot, tapping **Add Details**,
      or using `/goal_answer`.

README & SETUP smoke tests:
- [x] `/gateway_status` and `/usage_status` added to README first-run smoke checks
      (both lists).
- [x] `/gateway_status` and `/usage_status` added to SETUP Telegram smoke tests.
- [x] Lists kept short and practical.

Node version consistency:
- [x] README and SETUP say Node 22.12.0 or newer, matching `package.json`
      (`engines.node >=22.12.0`) and SECURITY.md.
- [x] SECURITY.md keeps the requirement at Node.js 22.12.0 or later, removes the
      CVE-specific patch claim/bullets, and uses the safer "latest available Node
      22 LTS patch release" rationale.

Safety/auditability note:
- [x] Concise launch-facing note covering: runtime artifacts mirrored redacted
      into `agent/history`; prompt artifacts/events/runtime index make runs
      inspectable; private gateway config/env/auth stays outside agent-visible
      history; workers do not receive raw secrets by default; sandboxing exists
      where implemented/probed but prompts and managed workspaces are not
      themselves kernel security boundaries.
- [x] SECURITY.md includes an `Operational Safety` section covering isolated
      operation and the agent-visible/private-file boundary.
- [x] README and SETUP include an explicit managed-workspace read/edit rule.

CHANGELOG launch entry:
- [x] Dated 2026 launch-prep entry added (fork-start entry preserved) summarizing:
      `/usage_history` removed; post-exec LLM diff review removed; pi disabled for
      launch; Telegram multi-message buffering repaired; Stage 2U-F prompt/history/
      runtime mirror cleanup; manual-tests and lessons runtime evidence; scout
      artifact reconciliation; Claude and Codex `/usage_status` improvements;
      backend-limit DAG stale blocked-state repair; repo-wide G2-G10 test hygiene
      quick wins; G1 read-only `/tmp` and `/var/tmp` test-environment batch deferred.

SECURITY.md Docker cleanup:
- [x] Docker image/deployment/hardening claims removed (no official image,
      `smithersbot:latest`, data volume, or `--read-only`/`--cap-drop` claims
      remain). No broad Docker guidance substituted.

Launch input asset references:
- [x] Portrait reference corrected to
      `internal/launch-inputs/assets/smithersbot-portrait.jpeg`.
- [x] Missing `launch-inputs/screenshots/` directory marked TODO in
      creative-direction.md and demo-brief.md; no fake screenshots created.
- [x] Confirmed intro `.mp4` and jingle `.mp3` references already correct.

Personalization stance:
- [x] No docs imply setup asks how to address the operator (no name prompt /
      operatorName). No stray personalization mention required post-launch marking.

Post-launch marking:
- [x] Deferred items (Codex telemetry repair, backend-limit DAG manual test, demo
      build, dev gateway, persistent-agent architecture, OODA loops, G1 temp-path
      cleanup) are out of scope and not advertised in README/SETUP, so no stray
      mention required post-launch marking.

## Items intentionally NOT applied (with reasons)

1. **Demo section left as-is.** README still states "Demo coming soon. The demo
   asset is not included in this repository yet." The real demo is not done yet —
   only the intro asset exists — so the "coming soon" stance is accurate and was
   preserved per operator decision.
2. **No `/usage_status` Codex caveat added.** Codex usage telemetry is expected to
   be fixed before launch, so launch docs describe the intended behavior
   (`/usage_status` shows Claude Code and Codex usage/quota status) rather than the
   temporary bug.
3. **Docker claims removed, not softened.** Unsupported Docker image/deployment/
   hardening claims were deleted from SECURITY.md (and any README/SETUP mentions)
   rather than reworded, so the docs do not imply an official Docker image or
   deployment path exists.
4. **No onboarding-wizard CHANGELOG entry added.** That implementation has not
   landed, so this docs pass did not add a launch note for it.

## Verification commands run (with results)

All grep alternation is escaped as `\|` (plain grep treats a bare `|` literally).

```
$ grep -n "CVE-2025-59466\|CVE-2026-21636" SECURITY.md || true
(no output)
```
PASS — the CVE-specific Node 22.12.0 patch claim and bullet list are gone.

```
$ grep -n "22.12.0 or later" SECURITY.md
24:SmithersBot requires **Node.js 22.12.0 or later**.
30:node --version  # Should be v22.12.0 or later
```
PASS — SECURITY.md keeps the Node 22.12.0-or-later requirement.

```
$ grep -n "Operational Safety" SECURITY.md
33:## Operational Safety
```
PASS — SECURITY.md contains the new Operational Safety section.

```
$ grep -n "must live inside a managed workspace repo" README.md SETUP.md
README.md:77:Agent read/edit rule: anything you want SmithersBot agents to read or edit must live inside a managed workspace repo:
SETUP.md:454:Agent read/edit rule: anything you want SmithersBot agents to read or edit must live inside a managed workspace repo:
```
PASS — README.md and SETUP.md both contain the explicit managed-workspace
read/edit rule.

```
$ grep -in "docker\|smithersbot:latest" README.md SETUP.md SECURITY.md || true
(no output)
```
PASS — no Docker claim or `smithersbot:latest` reference was reintroduced.

```
$ grep -rn "22.12.0" README.md SETUP.md package.json SECURITY.md
README.md:102:- Node 22.12.0 or newer
SETUP.md:55:v22.12.0 or newer
package.json:121:    "node": ">=22.12.0"
SECURITY.md:24:SmithersBot requires **Node.js 22.12.0 or later**.
SECURITY.md:30:node --version  # Should be v22.12.0 or later
```
PASS — Node 22.12.0 floor remains consistent across README, SETUP, package.json,
and SECURITY.

```
$ test -f internal/LAUNCH_DOCS_SETUP_POLISH_REPORT.md
```
PASS — this report exists.

Additional confirmation:

```
$ grep -in "onboarding" CHANGELOG.md || true
(no output)
```
PASS — no onboarding-wizard CHANGELOG entry was added.

## Remaining docs/setup TODOs before launch

- Capture and add real product screenshots; create
  `internal/launch-inputs/screenshots/` (currently TODO-marked, not yet present).
- Replace the README "Demo coming soon" stance with the real demo once the demo
  asset is produced.
- Confirm Codex `/usage_status` telemetry repair lands before launch (tracked
  separately; out of scope for this docs pass, so no caveat was added).
- The following remain deferred / post-launch and are not advertised in launch
  docs: dev gateway, persistent Claude/Codex instance across scout → planning →
  worker, long-horizon OODA-loop goal pursuit, operator-name personalization,
  backend-limit DAG manual resume test, and the G1 read-only `/tmp` / `/var/tmp`
  test-environment batch.
