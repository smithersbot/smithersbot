# Launch Docs & Setup Polish Report

Date: 2026-05-24
Source audit: `internal/LAUNCH_DOCS_SETUP_AUDIT_REPORT.md`
Scope: docs/setup polish pass only. No source, tests, package files, scripts,
`.env*`, auth/private config, binary assets, or runtime behavior were changed.
The gateway was not restarted.

## Files changed

- `README.md` — command list, Telegram controls, smoke tests, Node floor,
  safety/auditability note, Docker mentions removed. (task `update-readme-launch-docs`)
- `SETUP.md` — Node floor, smoke tests, blocked-goal answering, security-notes
  framing, Docker mentions removed. (task `update-setup-docs`)
- `SECURITY.md` — unsupported Docker image/deployment/hardening claims removed;
  Node 22.12.0 requirement and CVE rationale preserved. (task `cleanup-security-changelog`)
- `CHANGELOG.md` — dated 2026 launch-prep entry added. (task `cleanup-security-changelog`)
- `internal/launch-inputs/creative-direction.md` — portrait reference fixed to
  `.jpeg`; missing `screenshots/` directory marked TODO. (task `reconcile-launch-input-assets`)
- `internal/launch-inputs/demo-brief.md` — `screenshots/` reference marked TODO.
  (task `reconcile-launch-input-assets`)
- `internal/LAUNCH_DOCS_SETUP_POLISH_REPORT.md` — this report. (task `write-polish-report`)

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

Safety/auditability note:
- [x] Concise launch-facing note covering: runtime artifacts mirrored redacted
      into `agent/history`; prompt artifacts/events/runtime index make runs
      inspectable; private gateway config/env/auth stays outside agent-visible
      history; workers do not receive raw secrets by default; sandboxing exists
      where implemented/probed but prompts and managed workspaces are not
      themselves kernel security boundaries.

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

## Verification commands run (with results)

All grep alternation is escaped as `\|` (plain grep treats a bare `|` literally).

```
$ grep -n "gateway_status\|usage_status\|goal_answer\|Add Details" README.md
120:- `/gateway_status`
121:- `/usage_status`
180:- `/gateway_status`
181:- `/usage_status`
320:- Reply to a blocked question, tap **Add Details**, or use `/goal_answer <runId> <answer>` to unblock the run.
332:- `/goal_answer <runId> <answer>` answers a blocked goal question. You can also reply to the question in Telegram.
336:- `/gateway_status` shows gateway process and service status.
337:- `/usage_status` shows Claude Code and Codex usage/quota status.
```
PASS — all README additions present.

```
$ grep -rn "usage_history" README.md SETUP.md CHANGELOG.md SECURITY.md || true
CHANGELOG.md:5:- Removed the `/usage_history` command from the launch-facing operator surface.
```
PASS — only the CHANGELOG "removed" mention appears; `/usage_history` is not
advertised as a live command.

```
$ grep -rn "post-exec\|post execution\|diff review" README.md SETUP.md SECURITY.md || true
(no output)
```
PASS — post-exec LLM diff review is not advertised.

```
$ grep -rn "pi" README.md SETUP.md SECURITY.md || true
README.md:19: ...compaction...expansion...
README.md:20: ...
README.md:322: ...scoped to the chat and topic thread...
README.md:445: ...skipping code review...
README.md:450: ...strips Anthropic credential env vars...
SETUP.md:163:sudo npm install -g @anthropic-ai/claude-code
SETUP.md:351:If the goal blocks with a question, answer by replying to the bot, tapping
SETUP.md:629:sudo npm install -g @anthropic-ai/claude-code
SECURITY.md:43:pip install detect-secrets==1.5.0
```
PASS — every hit is an unrelated substring (com**pi**lation/com**pi**, ex**pi**...
no: compaction/expansion, "scoped"/"topic", "skipping", "Anthropic", "tapping",
"pip install"). None advertise `pi` as a launch-supported backend.

```
$ grep -rn "Docker\|docker\|smithersbot:latest" README.md SETUP.md SECURITY.md || true
(no output)
```
PASS — no unsupported Docker launch/deployment/hardening claim remains in any of
the three files.

```
$ grep -rn "22.12.0" README.md SETUP.md package.json SECURITY.md
README.md:97:- Node 22.12.0 or newer
SETUP.md:55:v22.12.0 or newer
package.json:121:    "node": ">=22.12.0"
SECURITY.md:24:SmithersBot requires **Node.js 22.12.0 or later** (LTS). ...
SECURITY.md:32:node --version  # Should be v22.12.0 or later
```
PASS — Node 22.12.0 floor consistent across README, SETUP, package.json, SECURITY.

```
$ test -f internal/LAUNCH_DOCS_SETUP_POLISH_REPORT.md
```
PASS — this report exists.

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
