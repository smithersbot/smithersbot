# Launch Docs & Setup Audit Report

**Type:** Read-only audit (preparation for the docs/setup polish pass). No source,
setup, test, or docs files were modified. The only file written by this task is
this report.

**Audit date:** 2026-05-24

---

## 1. Repository state

### Current HEAD

```
31377add120cff2fff48e18234e04321356bf389
```

Branch at audit time: `claw/run/20260525-022237Z-6ad0c622-bcb3-47a8-8c57-33fdde46da8c`.

### Git status summary (no secret contents printed)

`git status --short` shows, summarized in prose (no file contents were read or
printed for any secret-bearing file):

- **Modified, tracked:** `.env.local`, `.env.production`, `.env.test`. These are
  environment/secret-bearing files. They appear modified because the sandbox
  mounts them as character-device nodes; **their contents were never read or
  printed**, and they are explicitly out of scope for this audit (not part of the
  one allowed write).
- **Untracked, environment noise:** sandbox-seeded shell/profile dotfiles
  (`.bash_profile`, `.bashrc`, `.gitconfig`, `.gitmodules`, `.profile`,
  `.ripgreprc`, `.zprofile`, `.zshrc`), editor/config dirs (`.idea`, `.vscode`,
  `.mcp.json`), and the agent workspace dir `.claude/`. None of these are product
  changes.
- **Untracked, product source:** `src/telegram/codex-quota-runner.ts` — a new
  source file belonging to the **in-progress Codex telemetry repair** referenced
  in the goal context. It is not tracked yet and is **not** touched by this audit.
- **This audit creates exactly one file:** `internal/LAUNCH_DOCS_SETUP_AUDIT_REPORT.md`.

---

## 2. Documentation surfaces found

There is **no top-level `docs/` directory**. Documentation lives at the repo root,
in `internal/`, and in per-directory contract files.

### Public, user-facing docs (root)

| File | Size | Role | Notes |
| --- | --- | --- | --- |
| `README.md` | ~27 KB (451 lines) | Primary product doc: pitch, quick start, fresh setup, how-it-works, operator flows, Telegram controls + command list, repo chat, safety rails, memory, execution/recovery, Nightwatch, status/limitations | Source of most user-facing claims |
| `SETUP.md` | ~12 KB (613 lines) | Install + runbook: isolation, packages, Node 22, pnpm, clone, build, Codex/Claude login, BotFather, setup script, systemd user service, smoke tests, restart test, file layout, security notes, troubleshooting | Thorough; a few gaps below |
| `CONTRIBUTING.md` | small | Single-maintainer governance, PR norms, AI-assisted PR checklist, upstream attribution | Current |
| `SECURITY.md` | small | Private disclosure email, web-interface "local only", Node 22.12.0 + CVE rationale, Docker hardening, detect-secrets | Current; Docker section asserts an "official image" (see gaps) |
| `NOTICE.md` | small | OpenClaw/Moltbot fork attribution, fork SHA `4583f88…`, downstream-change note | Current |
| `CHANGELOG.md` | tiny | Only a fork-start entry (2026-01-29). No launch entries | Stale/empty for launch |
| `LICENSE` | small | MIT, Overing + Steinberger | Current |
| `.env.example` | tiny | Variable-name contract — `TELEGRAM_BOT_TOKEN` placeholder + comment pointing config to `channels.telegram.allowFrom`/`groups`. **Placeholders only; safe.** | Current |

### Package metadata (`package.json`)

- `name: smithersbot`, `version: 2026.1.29`, `description: "SmithersBot — a
  Telegram-controlled multi-agent goal execution harness."`, `author: Matthew
  Overing <contact@smithersbot.com>`, `homepage: https://smithersbot.com`,
  `bugs`/`repository` → `github.com/smithersbot/smithersbot`, `license: MIT`.
- `engines.node: >=22.12.0`; `packageManager: pnpm@10.23.0`.
- `bin: smithersbot → ./smithersbot.mjs`. `files[]` ships `README.md`,
  `CHANGELOG.md`, `LICENSE`, `assets/**`, dist, scripts subset.
- Keywords: `telegram, bot, agent, assistant, cli, ai`.

### CLI / help surface

- CLI entry `smithersbot.mjs` (bin `smithersbot`). README documents
  `smithersbot goal "<task>" --plan-only` and `node scripts/run-node.mjs gateway`.
- Telegram `/help` and `/commands` are the live in-product help surfaces;
  `/commands` renders from `PUBLIC_TELEGRAM_MENU` (see §4).

### Worker-contract docs

- `CLAUDE.md` and `AGENTS.md` at repo root — **byte-for-byte identical** worker
  contracts (drift guarded by `src/prompts/prompts.test.ts`). Several src
  subdirectories carry their own `AGENTS.md`/`CLAUDE.md` (e.g.
  `src/repo-chat/repo-chat-context/`). `src/prompts/README.md` documents the
  prompt/contract surfaces.

### Launch inputs (`internal/launch-inputs/`)

| File | Purpose |
| --- | --- |
| `positioning.md` | Core line ("Leave agents running without giving up control."), audience, problem/answer, proof points, claims-to-avoid, CTAs |
| `demo-brief.md` | Landing-page/launch-kit brief; references a 16s intro video already synced to the jingle |
| `creative-direction.md` | "Smitherscore" landing-page art direction: chapter/exhibit layout, `#f1e6cb` background, serif wordmark, copy lines |
| `style-reference.html` | Composition reference (uses fake data — explicitly "do not copy content") |
| `assets/smithersbot-intro.mp4` | Finished 16s demo intro |
| `assets/smithersbot-portrait.jpeg` | Hero portrait |
| `assets/smithersbot-jingle.mp3` | Demo jingle |

### Repo-root assets (`assets/`)

- `smithersbot-flowchart.png` (referenced by README "How it works"),
  `avatar-placeholder.svg`, `chrome-extension/`.

### Internal reports (`internal/*.md`)

- ~40 stage reports (STAGE2*, triage, smoke). **Historical record, not user
  docs.** They legitimately still mention removed/disabled surfaces (see §3).

---

## 3. Stale or missing documentation found

### Good news: public docs are clean of removed-surface residue

A repo-wide search for `usage_history`, post-execution LLM diff review, and
disabled `pi` found **no residue in any public doc** (`README.md`, `SETUP.md`,
`CONTRIBUTING.md`, `SECURITY.md`, `NOTICE.md`, `CHANGELOG.md`). All hits are in
`internal/` historical reports, `agent/history/` run artifacts, and src
test/source modules (e.g. `pi-runner.ts`, `capability-enforcement.ts` still exist
because `pi` is *disabled*, not deleted). Those are expected and out of scope.

README "review" language was checked: every mention refers to **Codex plan
review**, **manual/user review**, or **Nightwatch daily code review** — none refer
to the removed post-execution LLM diff review. ✔

### Missing / stale items (public docs)

1. **README Telegram command list omits live commands.** README lines 322–337
   list 16 commands but omit three operator-relevant surfaces that exist today:
   - `/gateway_status` (in `PUBLIC_TELEGRAM_MENU`, "Advanced & admin")
   - `/usage_status` (in `PUBLIC_TELEGRAM_MENU`, "Advanced & admin")
   - `/goal_answer` (live native command + reply flow; not in the public menu but
     is the documented way to answer a blocked question)
   This is the single most important doc-vs-reality gap. (Confirmed against
   `src/telegram/public-menu.ts`, `goal-commands.ts`, `gateway-status.ts`,
   `usage-status.ts`, `goal-router.ts`.)
2. **"Add Details" inline flow is unnamed in docs.** README "Telegram controls"
   says "Reply to a blocked question to unblock the run" but never names the
   **✏️ Add Details** button (`goal-blocked-ui.ts`, `callback_data gAD:`) that
   appears on blocked messages. Operators see a button the docs do not explain.
3. **`/goal_answer` is never named** in README or SETUP, even though it is the
   primary keyboard path to answer a blocked run and is surfaced in
   tips/usage strings (`goal-router.ts`, `goal-commands.ts`).
4. **README "Demo" section is stale relative to available assets.** README says
   "Demo coming soon. The demo asset is not included in this repository yet,"
   but a finished 16s intro exists at
   `internal/launch-inputs/assets/smithersbot-intro.mp4` (just not in a
   shippable/public location). Demo wiring is a launch task, not "not yet
   filmed."
5. **CHANGELOG.md has no launch content.** Only the fork-start entry. A launch
   release entry is missing.
6. **Node-version floor is stated loosely.** README says "Node 22 or newer";
   `package.json` (`>=22.12.0`) and `SECURITY.md` (22.12.0 + CVE rationale)
   require the patch floor. README/SETUP should state **22.12.0** consistently.
7. **`/usage_status` Codex caveat is undocumented.** `usage-status.ts` advertises
   "Show Claude Code and Codex usage quota," but Codex telemetry repair is still
   in progress (untracked `codex-quota-runner.ts`); Codex numbers may be
   stale/unavailable. No doc states this caveat.
8. **SECURITY.md Docker claims may overstate reality.** It references an
   "official image (`smithersbot:latest`)" and `smithersbot-data` volume. There
   is no published image in this launch scope; this should be softened to
   "if you build a container" or removed until an image exists.
9. **`pi` disabled state is undocumented for users** (intentional today — it is
   not a user-facing backend at launch). Confirm docs simply never present `pi`
   as a selectable backend; current README/SETUP correctly do not. ✔ (No action
   beyond a note.)

---

## 4. Command inventory (doc-vs-reality)

Source of truth: `src/telegram/public-menu.ts` (`PUBLIC_TELEGRAM_MENU`) plus the
handler modules (`goal-commands.ts`, `repo-chat-commands.ts`, `gateway-status.ts`,
`gateway-restart.ts`, `usage-status.ts`, `goal-router.ts`, `goal-sending.ts`,
`goal-blocked-ui.ts`, `goal-formatting.ts`).

### Public menu commands

| Command | Menu group | Current behavior | Doc status (README) | Needed update |
| --- | --- | --- | --- | --- |
| `/new_goal <desc>` | Core workflow | Create a goal; Claude drafts, Codex reviews, plan returned for approval | Documented | OK |
| `/goal_status` | Core workflow | Render the goal's task DAG flowchart | Documented (incl. node legend) | OK |
| `/goal_list` | Core workflow | List recent goal runs | Documented | OK |
| `/goal_resume <runId>` | Core workflow | Resume an interrupted run from persisted state | Documented | OK |
| `/goal_stop` | Core workflow | Stop a running goal | Documented | OK |
| `/repo_chat <q>` | Repo chat | Read-only repo/active-goal question; bare message also starts repo chat | Documented | OK |
| `/chat_backend` | Repo chat | Set repo-chat backend (codex / claude_code) | Documented | OK |
| `/goal_lessons` | Diagnostics & tuning | Show/manage goal lessons | Documented | OK |
| `/goal_plan_autocheck` | Diagnostics & tuning | Toggle automatic plan checks | Documented | OK |
| `/goal_semgrep` | Diagnostics & tuning | Configure Semgrep checks | Documented | OK |
| `/goal_workers` | Diagnostics & tuning | Configure worker concurrency (note: `pi` returns a launch-disabled message) | Documented | Add note that `pi` is disabled if `/goal_workers pi` is shown |
| `/goal_github_push` | Diagnostics & tuning | Toggle auto GitHub push + PR for completed runs (marked dangerous/admin) | Documented | OK |
| `/nightwatch` | Advanced & admin | Configure scheduled daily code review | Documented | OK |
| `/gateway_status` | Advanced & admin | Show gateway process and service status | **MISSING from README list** | **Add to README command list** |
| `/usage_status` | Advanced & admin | Show Claude Code + Codex usage quota (Claude limit rendering repaired; Codex telemetry repair in progress) | **MISSING from README list** | **Add to README; note Codex caveat** |
| `/gateway_restart` | Advanced & admin | Restart gateway service (resolves systemd unit; env precedence documented) | Documented | OK |
| `/help` | Help | Operator help | Documented | OK |
| `/commands` | Help | List public command surface (renders from menu) | Documented | OK |

### Other live native commands (not in the public menu but real)

| Command | Current behavior | Doc status | Needed update |
| --- | --- | --- | --- |
| `/goal_approve <id>` | Approve + execute a plan (keyboard fallback to Approve button/reaction) | README mentions "Approve" buttons; command name appears in `/help` | Optional: mention `/goal_approve` as the typed equivalent |
| `/goal_answer <id> <answer>` | Answer a blocked goal's clarification question (also via reply-to) | **Not named in README/SETUP** | **Add to README controls + SETUP** |

### Inline / button flows

| Flow | Trigger | Current behavior | Doc status | Needed update |
| --- | --- | --- | --- | --- |
| Plan approval | Inline buttons ❤️ Approve / 🔍 Plan Detail / ✏️ Request changes / Reject; or 👍/❤️ reaction; or `/goal_approve` | Approve runs the plan; Request changes opens ForceReply → revise; Plan Detail shows detail | Documented | OK |
| Incorporate Feedback | 🔄 button on the done message (`gIF:`) → ForceReply → replan | Sends completed goal back to planning with feedback | Documented (named) | OK |
| Add Details | ✏️ button on a blocked message (`gAD:`) | Opens ForceReply to add detail/answer to a blocked run | **Button not named in docs** | **Name it in README controls** |

### Removed / disabled surfaces (must NOT reappear in docs)

| Surface | State | Doc status | Needed update |
| --- | --- | --- | --- |
| `/usage_history` | **Removed** for launch (only `/usage_status` live-quota remains) | Absent from public docs ✔ | Keep absent; do not re-add |
| Post-execution LLM diff review | **Removed** from goal-completion path (dead modules deleted) | Absent from public docs ✔; README "review" = plan/manual/Nightwatch only | Keep absent |
| `pi` backend | **Disabled** (reported unavailable; removed from planner assignment; `/goal_workers pi` returns disabled message; code retained) | Not presented as a user backend ✔ | Keep absent from user docs; do not advertise as selectable |

---

## 5. Setup flow audit (`SETUP.md` + `scripts/setup-smithersbot.sh`)

### Covered well

- Isolation guidance (VM/VPS/Docker/dedicated); "what you need" (Linux, Telegram,
  optional GitHub, Codex/Claude).
- System packages; **Node 22** via NodeSource; **pnpm 10.23.0** via Corepack with
  npm fallback; clone (public + private `gh`); `pnpm install --frozen-lockfile`
  + `pnpm build`.
- Backend install/login/test for **Codex** (`codex login`, smoke) and **Claude
  Code** (`claude`, `claude -p` smoke); "at least one required, both recommended."
- **BotFather** bot creation walkthrough.
- **Setup script** behavior is documented: asks for bot token, verifies it, tells
  operator to open their bot (not BotFather) and press Start, auto-detects chat
  ID, asks to confirm, creates `~/.smithersbot/.env` + `smithersbot.json`,
  generates gateway auth token, sets `gateway.mode=local`, `chmod 600`.
- **systemd user service**: `install-smithersbot-user-service.sh`,
  `enable --now`, `status`, `journalctl`, `gateway_restart` unit resolution with
  `SMITHERSBOT_SYSTEMD_UNIT` → `MOLTBOT_SYSTEMD_UNIT` → `CLAWDBOT_SYSTEMD_UNIT`
  precedence and active-unit detection.
- Smoke tests, restart test, `loginctl enable-linger`, daily start/stop/restart,
  file-layout (gateway-private vs managed agent root), portability rule,
  `.env.example` contract, security notes, troubleshooting (corepack/pnpm/clone/
  Telegram/`No worker backend available`/legacy-branding).

### Setup flow gaps

1. **No "how to address the operator" prompt — PENDING / unsupported.** The audit
   explicitly checked: `scripts/setup-smithersbot.sh` does **not** ask the
   operator's name or preferred form of address, and there is **no**
   `operatorName`/`addressAs`/`preferredName` field anywhere in `src/`. So
   personalized addressing is **not supported today**. Docs should either (a)
   omit any claim of personalized addressing, and/or (b) explicitly mark
   "address the operator by name" as a post-launch idea. Do not imply it works.
2. **Smoke-test list omits `/gateway_status` and `/usage_status`.** Both SETUP
   smoke sections (and README's) list `/help`, `/commands`, `/goal_list`,
   `/repo_chat`, `/new_goal` but not the two admin status commands that are now
   live. Adding them gives operators a one-line health check.
3. **Node floor inconsistency.** SETUP installs `setup_22.x` and checks
   `v22.x.x`; README says "Node 22 or newer"; `package.json`/`SECURITY.md` require
   **22.12.0**. SETUP's expected-output block should call out the 22.12.0 minimum.
4. **`/goal_answer` not taught in the setup runbook.** A new operator running the
   tiny test goal is not told how to answer if the goal asks a question.
5. **Env/config expectations are accurate but split.** The managed-root vs
   gateway-private split, `.env.example` placeholder-only contract, and
   "workers never receive raw secrets" are stated correctly in both README and
   SETUP. No correction needed — just confirm the polish pass keeps both copies
   in sync.

---

## 6. Safety / history / sandbox documentation gaps

Current coverage is **strong** — README "Safety rails," "Full execution trail,"
"Execution and recovery," and the SETUP "Where files live" + "Security notes"
sections already document most of this accurately. Specific check against the
required topics:

| Topic | Documented today? | Gap / needed update |
| --- | --- | --- |
| Managed workspace (agent root vs private) | Yes (README "Where files live", SETUP) | Keep README/SETUP copies in sync; both still labeled "Stage 2S, transitional" — confirm that label is intended for launch or soften it |
| Agent-visible history under `agent/history/` | Yes (sanitized goals/repo-chats/index trees) | OK; consider a one-line "what the agent can vs cannot see" summary |
| Redacted runtime mirror (scout, autocheck, workers, manual-tests, lessons, cron index) | Partially — README "Full execution trail" describes the on-disk trail; the **redacted mirror** specifically is documented mainly in `internal/` + `src/prompts/README.md` | Add a short user-facing note that runtime artifacts are mirrored **redacted** into `agent/history` |
| Prompt artifacts | Yes (execution trail) | OK |
| Event logs | Indirect (journald via SETUP; on-disk journals via README) | OK |
| `runtime/index.json` | Not named in public docs | Optional: mention the JSONL/index search surface for auditability |
| No secret / raw private config exposure | Yes — strong (README portability rule + SETUP security notes; "workers do not receive raw secrets") | OK; keep |
| Sandbox posture and limitations | Yes — explicitly hedged ("not a kernel boundary," "prompts/convention files are not security boundaries," backend isolation only after live probes) | OK; this honesty is a launch strength — keep |
| Backend usage-limit / fallback behavior | Yes (README flowchart legend explains usage-limit → auto-recover/fallback, not red) | OK; align with `/usage_status` Codex caveat |
| Codex/Claude status & quota | Partially — `/usage_status` exists but is **absent from README**; Codex telemetry caveat undocumented | Add `/usage_status` + Codex caveat |
| Operator controls: approve / stop / resume / add details / incorporate feedback | Mostly — approve/stop/resume/feedback documented; **Add Details** + **`/goal_answer`** under-documented | Name Add Details + `/goal_answer` |

---

## 7. Demo script recommendation

Use the existing `internal/launch-inputs/assets/smithersbot-intro.mp4` (16s, jingle-synced)
as the **cold open**, then record the real operator loop. Recommended flow (mirrors
README "Full operator loop" and the creative-direction chapter structure
I. Plan → II. Approve → III. Run → IV. Verify):

1. **Repo chat (think first).** Send a plain Telegram message asking how to phrase
   a goal; repo chat drafts a strong `/new_goal` prompt. *(Capture: repo-chat
   screenshot.)*
2. **`/new_goal`.** Paste the prompt. *(Capture: the sent goal.)*
3. **Plan draft + review.** Claude drafts, Codex reviews. *(Capture: plan
   flowchart image + Plan Detail.)*
4. **Request changes → approve.** Click Request changes, describe an edit, then
   Approve. *(Capture: inline buttons; the revised plan.)*
5. **Execution + external gate.** Tasks run; show one task failing, reverting to
   checkpoint, and a fresh retry succeeding. *(Capture: `/goal_status` DAG with
   running/done nodes.)*
6. **Blocked question → answer.** Show a focused Telegram question and answering
   it (reply or **Add Details** / `/goal_answer`). *(Capture: blocked node + Add
   Details button.)*
7. **Completion + manual checks.** SmithersBot reports checks it could not run.
   *(Capture: completion message.)*
8. **Incorporate Feedback.** Feed a failed manual check back; replan adds a fix
   task. *(Capture: 🔄 Incorporate Feedback.)*
9. **(Optional) `/usage_status` + `/gateway_status`** as a closing "still in
   control / observable" beat.

**Screenshot/GIF/video moments needed (asset checklist):**
repo-chat reply · `/new_goal` sent · plan flowchart · Plan Detail · Request-changes
ForceReply · approval · `/goal_status` mid-run DAG · blocked node + Add Details ·
completion message · Incorporate Feedback · `/usage_status`. Mark missing ones as
TODO; **do not fabricate** Telegram content, goal IDs, or flowcharts (per
creative-direction).

---

## 8. README / website update recommendation

**README**

- Add `/gateway_status`, `/usage_status` (with Codex caveat), and `/goal_answer`
  to the Telegram commands list; name the **Add Details** button in "Telegram
  controls."
- Replace the "Demo coming soon / not included" copy with the real intro video
  embed/link once the asset is placed in a shippable location, or a one-line
  "Watch the demo" CTA pointing at smithersbot.com.
- State the exact Node floor (**22.12.0**) consistently with `package.json` and
  `SECURITY.md`.
- Decide whether the "Stage 2S, transitional" framing stays in a launch README or
  is softened to a stable "Where files live" description.

**Website (smithersbot.com landing page)** — follow `internal/launch-inputs/`:

- Positioning: **"Leave agents running without giving up control."** Differentiate
  explicitly from raw Codex / `claude` / Claude Code `/goal`:
  - plan is reviewed (Claude drafts, Codex reviews) and **operator-approved**
    before any execution;
  - **fresh worker per task** instead of one degrading long session;
  - **build/test verification runs outside the worker** — the agent cannot fake
    completion;
  - **DAG plan + critical path** keeps working around blocked tasks;
  - **git checkpoint + revert/retry** per task;
  - **full, inspectable execution trail** + repo chat over it;
  - **Telegram-native** approve/stop/resume/feedback control from anywhere.
- Honor creative-direction (chapter/exhibit layout, `#f1e6cb`, serif wordmark,
  intro video + jingle, no autoplay, real assets only).
- Mark explicitly **post-launch** on the site: dev gateway, persistent-agent /
  session architecture, long-horizon OODA loops, and any "personalized
  addressing" idea.
- Respect positioning's claims-to-avoid: do **not** claim fully autonomous,
  safe-by-default, enterprise-ready, hosted SaaS, multi-user, or no-review.

**Asset note:** `creative-direction.md`/`demo-brief.md` reference
`launch-inputs/assets/smithersbot-portrait.png` and a `launch-inputs/screenshots/`
folder, but the actual asset is `smithersbot-portrait.jpeg` and **no `screenshots/`
directory exists**. The polish pass must reconcile these names and supply/placehold
the screenshots.

---

## 9. Known limitations (for the launch "Status and limitations" section)

- **G1 read-only `/tmp` and `/var/tmp` broad-test environment batch is deferred**
  unless launch policy changes (intentional).
- **Dev gateway is deferred post-launch** (not launch-blocking).
- **Persistent-agent / session architecture is deferred post-launch.**
- **Long-horizon OODA loops are deferred post-launch.**
- **`/usage_status` Codex telemetry caveat:** Claude usage-limit rendering is
  repaired; **Codex telemetry repair is still in progress** (untracked
  `src/telegram/codex-quota-runner.ts`). Until it lands, Codex quota numbers may be
  stale or unavailable; docs should say so.
- **Outstanding manual test:** the **backend-limit DAG stale blocked-state fix**
  is implemented but **still needs manual verification** (resume a run that hit a
  backend usage limit and confirm sibling nodes are not stuck red). Do not claim
  it is fully verified in launch docs until that manual test passes.
- Existing README caveats remain true: execution is **sequential, not parallel**;
  subscription-mode auth uses the operator's own CLI login (not free/unlimited);
  crash recovery is best-effort (interrupted step rolled back to `pending`).
- `pi` backend is **disabled** at launch (not a user-facing option).

---

## 10. Docs/setup implementation task list

Grouped MUST / SHOULD / AFTER launch. Each item: file(s), exact change, why, how
to verify.

### MUST DO BEFORE LAUNCH

1. **Add missing live commands to README command list.**
   - File: `README.md` ("Telegram commands" list, ~lines 322–337).
   - Change: add `/gateway_status` ("shows gateway process and service status"),
     `/usage_status` ("shows Claude Code and Codex usage quota; Codex figures may
     be limited while telemetry repair lands"), and `/goal_answer <runId> <answer>`
     ("answer a blocked goal's question; you can also reply to the question").
   - Why: README undercounts the live operator surface; these are the main status
     + unblock commands.
   - Verify: every `PUBLIC_TELEGRAM_MENU` command in `src/telegram/public-menu.ts`
     appears in README; `grep -n "gateway_status\|usage_status\|goal_answer" README.md`.

2. **Name the Add Details flow in README controls.**
   - File: `README.md` ("Telegram controls", ~lines 312–318).
   - Change: add a bullet — replying to a blocked question, or tapping the
     **✏️ Add Details** button, sends your answer to the blocked run.
   - Why: operators see the button; docs must explain it.
   - Verify: README references "Add Details"; matches `src/telegram/goal-blocked-ui.ts`.

3. **Document the `/usage_status` Codex caveat + remove `/usage_history` risk.**
   - File: `README.md` (and SETUP smoke tests if `/usage_status` is added there).
   - Change: note Codex quota may be stale/unavailable while telemetry repair is
     in progress; confirm `/usage_history` is **not** referenced anywhere.
   - Why: avoid promising accurate Codex numbers; keep removed command absent.
   - Verify: `grep -rn "usage_history" README.md SETUP.md` returns nothing;
     caveat present.

4. **Align the Node version floor to 22.12.0.**
   - Files: `README.md` ("Prerequisites"), `SETUP.md` (step 2 expected output).
   - Change: state **Node 22.12.0 or newer** to match `package.json` engines and
     `SECURITY.md`.
   - Why: the patch floor exists for security CVEs; loose wording undercuts it.
   - Verify: README/SETUP show `22.12.0`; consistent with
     `package.json` `engines.node`.

5. **Resolve the demo placeholder.**
   - File: `README.md` ("Demo" section).
   - Change: replace "Demo coming soon / not included" with either the embedded/
     linked intro video (once placed in a shippable path) or a "Watch the demo"
     CTA to smithersbot.com.
   - Why: a finished intro already exists; current copy understates readiness.
   - Verify: README demo section links to a real, present asset or live URL.

### SHOULD DO BEFORE LAUNCH

6. **Add `/gateway_status` + `/usage_status` to the smoke-test runbooks.**
   - Files: `SETUP.md` (step 10), `README.md` ("First Telegram smoke tests").
   - Change: include both as a quick post-install health check.
   - Why: gives operators a one-line "is it alive / am I within quota" check.
   - Verify: both commands appear in both smoke lists.

7. **Decide and apply the "how to address the operator" stance.**
   - Files: `SETUP.md`, `README.md` (and `internal/launch-inputs/*` if it claims
     personalization).
   - Change: since neither the setup script nor config supports a preferred name,
     either omit any personalization claim or mark it explicitly post-launch.
   - Why: do not imply a feature that does not exist
     (`scripts/setup-smithersbot.sh` has no name prompt; no `operatorName` in src).
   - Verify: no doc implies personalized addressing as a current feature.

8. **Add a "what the agent can and cannot see" safety note.**
   - Files: `README.md` ("Full execution trail"/"Safety rails"), `SETUP.md`
     ("Security notes").
   - Change: one short paragraph — runtime artifacts are mirrored **redacted**
     into `agent/history`; workers never read gateway-private config/real env;
     sandbox is not a kernel boundary.
   - Why: makes the auditability story explicit and sets honest expectations.
   - Verify: note present; consistent with `src/prompts/README.md` mirror
     description.

9. **Add a CHANGELOG launch entry.**
   - File: `CHANGELOG.md`.
   - Change: add a dated launch entry summarizing removed `/usage_history`,
     removed post-exec LLM review, disabled `pi`, repaired `/usage_status`,
     Telegram multi-message buffering, Stage 2U-F history cleanup.
   - Why: currently only a fork-start entry; launch needs a record.
   - Verify: CHANGELOG has a 2026 launch entry.

10. **Soften SECURITY.md Docker section.**
    - File: `SECURITY.md` ("Docker Security").
    - Change: reword "official image (`smithersbot:latest`)" to "if you build a
      container image" until a published image exists.
    - Why: avoid implying a published artifact that is not in launch scope.
    - Verify: no claim of an existing official image.

11. **Reconcile launch-input asset references.**
    - Files: `internal/launch-inputs/creative-direction.md`,
      `internal/launch-inputs/demo-brief.md` (and/or the asset files).
    - Change: fix portrait reference (`.png` vs actual `.jpeg`) and the missing
      `screenshots/` directory; list every still-missing screenshot.
    - Why: the demo/landing-page build depends on these paths resolving.
    - Verify: referenced asset paths exist or are listed as TODO placeholders.

### AFTER LAUNCH

12. **Build the smithersbot.com landing page** per `internal/launch-inputs/`
    (chapter/exhibit layout, intro video, jingle, real screenshots). Verify: page
    matches creative direction; uses only real assets; CTAs correct.
13. **Mark deferred architecture as post-launch** wherever roadmap is described:
    dev gateway, persistent-agent/session architecture, long-horizon OODA loops,
    optional operator-name personalization. Verify: each labeled post-launch.
14. **Document `runtime/index.json` / JSONL search** as an auditability feature
    once stable. Verify: doc names the index and how to grep it.
15. **Re-run the docs↔menu reconciliation** after the Codex telemetry repair lands
    and after the backend-limit DAG manual test passes; update `/usage_status`
    caveat and limitations accordingly. Verify: caveats removed only when true.

---

## 11. Recommended next `/new_goal` scope (docs/setup polish pass)

> **`/new_goal`** Do the launch docs/setup polish pass identified in
> `internal/LAUNCH_DOCS_SETUP_AUDIT_REPORT.md`. Edit only docs/setup surfaces
> (`README.md`, `SETUP.md`, `CHANGELOG.md`, `SECURITY.md`, and the
> `internal/launch-inputs/*` asset references) — do **not** change source code,
> tests, or command behavior, and do **not** touch `.env*`/auth/private config.
> Apply every MUST-DO item and as many SHOULD-DO items as are safe: add
> `/gateway_status`, `/usage_status` (with the Codex telemetry caveat), and
> `/goal_answer` to the README command list; name the **Add Details** button;
> align the Node floor to 22.12.0; replace the stale Demo placeholder; add the
> `/usage_status`+`/gateway_status` smoke-test lines; resolve the "how to address
> the operator" stance (it is currently unsupported — omit or mark post-launch);
> add the redacted-mirror/agent-visibility safety note; add a CHANGELOG launch
> entry; soften the SECURITY.md Docker claim; and reconcile the launch-input asset
> references. Treat `src/telegram/public-menu.ts` as the command source of truth.
> Keep `CLAUDE.md` and `AGENTS.md` byte-identical. Verify with: the README
> command list covers every `PUBLIC_TELEGRAM_MENU` entry; `grep` confirms no
> `/usage_history`, post-exec-LLM-review, or user-facing `pi` references reappear;
> and `pnpm lint` if any lint-sensitive file changed (docs-only changes need no
> broad test run). Leave the backend-limit DAG stale-blocked-state manual test and
> the Codex telemetry repair as separate tracked items.

---

## Verification performed for this audit

- `test -f internal/LAUNCH_DOCS_SETUP_AUDIT_REPORT.md` → file created (this report).
- Read-only inspection only: `git rev-parse HEAD`, `git status --short`
  (summarized, no secret contents printed), and reads of `README.md`, `SETUP.md`,
  `CONTRIBUTING.md`, `SECURITY.md`, `NOTICE.md`, `CHANGELOG.md`, `LICENSE`,
  `.env.example`, `package.json`, `src/telegram/public-menu.ts`, command handler
  modules, and `internal/launch-inputs/*`.
- No source, setup, test, or doc files were modified. `pnpm lint` was intentionally
  not run because no lint-sensitive files changed (only this report was written).
