# Stage 2U-F — Prompt Contract Cleanup & Redacted Runtime History Mirror

**Goal:** Clean up SmithersBot's agent-facing prompt contract and make agent-visible
history useful enough for future agents to debug real runs.

**Date:** 2026-05-24
**Branch:** `claw/run/20260524-145830Z-8e2ae4d0`
**Before baseline (git):** commit `ff6afd011` (`autosave before goal 8e2ae4d0…`) — the
last commit before any Stage 2U-F work landed.
**After:** working tree at this report's commit. All "after" character counts below
were computed by importing the *actual* builders (`buildPlanSystemPrompt`,
`REVIEW_INSTRUCTION`, `buildPlanQualityRubric`, `renderGroupedHardDenies`,
`writeDenyFile`, `MANUAL_TESTS_SYSTEM_PROMPT`, `buildLessonExtractionPrompt`,
`WORKER_CONTEXT`, `buildCliPromptPayload`) and rendering them; "before" counts were
computed by checking out `ff6afd011` into a detached worktree and importing the same
builders there.

---

## 1. Issues found from real prompt artifacts

Observed in recent prompt/history artifacts before this stage:

- **Scout and planner prompts were blended.** A single planning prompt mixed repo
  inspection with plan-schema instructions, with no clean conceptual phase boundary.
- **Planner/scout prompts pointed agents at `.clawdbot-dev`.** They referenced
  `.clawdbot-dev/goals/.../scout` as an output target, even though `.clawdbot-dev` is
  runtime-private and hard-denied to workers.
- **Planner and autocheck duplicated plan-quality rules.** The same self-verification,
  no-split, no-tsc-only, and vague-success-criteria rules were pasted into both prompts.
- **Planner prompt carried long inline good/bad example text** that bloated the prompt.
- **Autocheck was over-instructed** — it received planner logic it did not need.
- **Planner claimed downstream agents have "full access to filesystem/shell,"**
  conflicting with the sandbox/capability boundary.
- **History language was stale/wrong.** Prompts and the README said "raw
  stdout/stderr/transcripts are not mirrored by default," which no longer matches the
  desired truth (redacted runtime artifacts *are* mirrored with generous caps + index).
- **Worker hard-deny text repeated `DENIED:` and full reasons line-by-line** — 94
  one-line bullets, each re-stating the reason; the same block was duplicated across
  `writeDenyFile`, `buildCliWorkerPrompt`, and a static prefix.
- **Claude Code and Codex worker prompts did not share hard-deny framing.**
- **`agent/history` lacked runtime evidence** — events/prompts existed, but no scout
  report, plan, autocheck output, worker stdout/stderr, worker results, manual-tests
  output, or cron runs were available to future agents.

---

## 2. Scout / planner split

`runCliPlanning()` remains one process. `buildPlanningPrompt()` in
`src/goal/cli-planner.ts` now presents two delineated conceptual phases:

- **Scout phase** — inspect repo + project conventions, emit *compact* scout facts /
  artifact references (no giant raw dumps), and reference agent-visible history paths
  (`<managed-root>/agent/history/goals/<workspace>/<goalId>/runtime/scout/…`) rather than
  `.clawdbot-dev`.
- **Planner phase** — consume scout facts and emit the required JSON execution plan that
  satisfies the shared rubric, preserving DAG/dependency planning, backend selection,
  approval/replanning, exact focused-test requirements, and JSON-only output.

The risky **"full access to the filesystem/shell"** wording was replaced everywhere with:
*"The worker has tool access within SmithersBot's configured capability and sandbox
boundaries."* The scout template (`src/prompts/scout/scout_prompt_template.md`) now
references agent-history runtime mirrors instead of private runtime output targets.

**Replan behavior (`/goal_resume --replan`):** no fresh scout by default. When cached
scout artifacts exist, `goal-resume.ts` passes the loaded `ScoutResult` into
`runCliPlanning`, and the planner builds a *compact cached-scout* prompt
(`buildCachedScoutSummary`) with agent-history artifact references — goal text + current
plan JSON + prior feedback/replan instruction + cached scout facts — without rebuilding
the full scout template. Existing scout artifacts are preserved rather than regenerated.
A fresh-rescout path is documented as **deferred** (no existing command path supports it
safely today).

---

## 3. Shared plan-quality rubric

Created **`src/prompts/shared/plan-quality-rubric.ts`** as the single source of truth.
It exports `PLAN_QUALITY_RUBRIC`, `buildPlanQualityRubric()`, and
`PLAN_QUALITY_ANTI_PATTERN_SUMMARIES`, and covers:

- self-verifying implementation steps; no implementation/test split; no standalone
  exploration steps;
- exact focused test commands for behavior changes; no vague success criteria; no
  tsc-only logic steps; `pnpm build`/`pnpm lint` when conventions require;
- concrete files/functions; valid DAG dependencies; reasonable step granularity; no tiny
  repeated touches;
- backend selection rules; **no sandbox overclaims**; managed-workspace + secret-handling
  contract; convention-file rules.

It is consumed by:
- **Planner** (`src/prompts/planner/system-prompt.ts`) — "produce a plan satisfying this
  rubric," keeping only concise *named anti-pattern summaries* inline.
- **Autocheck** (`src/prompts/plan-autocheck/review-instruction.ts`) — "review the plan
  against this rubric."

Both import the same module, so the criteria can no longer drift.

---

## 4. Planner examples moved / compacted

The planner's long inline good/bad example text was removed; durable
examples/anti-patterns now live in the shared rubric, and the planner keeps only short
named anti-pattern summaries (e.g. *implementation/test split*, *tsc-only logic step*,
*vague success criteria*, *tiny repeated touches*, *sandbox overclaim*).

---

## 5. Autocheck simplification

Autocheck's dynamic input was slimmed to: **goal + user edits + scout facts/artifact
references + plan JSON + output contract**. It no longer receives the full planner logic
or a second hand-maintained rubric — it points at the *shared* rubric. (Note: the static
`REVIEW_INSTRUCTION` constant grew because it now *embeds* the 5,005-char shared rubric;
the autocheck-specific instruction text excluding the rubric shrank from ~5,372 to ~1,454
chars, and the duplicated criteria are gone — single-sourced, not pasted twice.)

---

## 6. Hard-deny grouping / deduplication

A single grouped renderer, **`renderGroupedHardDenies()`** in `src/goal/hard-deny.ts`,
is generated from the existing `HARD_DENIES` model (94 entries) — not a second
hand-maintained list. It:

- groups patterns by shared reason under headings, lists each pattern once,
- drops the per-item `DENIED:` prefix,
- is titled **"Hard Denies"** with the line *"These are enforced by SmithersBot policy
  and, where available, backend sandbox settings."*

It is wired via `buildCliPromptPayload` so the grouped section begins **both** the Claude
Code `--append-system-prompt` and the Codex assembled prompt (before PROJECT
CONVENTIONS / WORKER GUIDELINES). The duplicate later deny blocks in
`buildCliWorkerPrompt`, `writeDenyFile`, and `WORKER_PROMPT_STATIC_INSTRUCTION_PREFIX`
were removed. No hard-deny enforcement was weakened (env, auth/session, private
runtime/config, elevated privilege, deployment, publish, and destructive categories all
remain).

### Before / after hard-deny formatting example

**Before** (`writeDenyFile`, 94 lines, 9,384 bytes — `DENIED:` + full reason per item):

```
HARD DENIES (enforced):
- DENIED: .env* — Environment files may contain secrets
- DENIED: *.pem — Certificate files are sensitive
- DENIED: *.key — Key files are sensitive
- DENIED: auth.json — Credential files are sensitive
… (90 more one-line bullets, each repeating "DENIED:" and a full reason)
```

**After** (`renderGroupedHardDenies()`, 1,597 bytes — grouped, reason as heading, one
pattern per line, no `DENIED:`):

```
Hard Denies
These are enforced by SmithersBot policy and, where available, backend sandbox settings.

Local secret/config files. Workers cannot read SmithersBot config; ask the user to relay any required value:
- .env*
- *.pem
- *.key
- auth.json
- credentials*
- ~/.smithersbot/**
- ~/.clawdbot-dev/**
- ~/.claude/**
- ~/.codex/**
…

Elevated privileges not permitted:
- sudo
- doas
- pkexec
- nsenter
- unshare
- chroot
…
```

**Reduction:** 9,384 → 1,597 bytes (**−83%**) for the same 94 enforced patterns.

---

## 7. Redacted runtime mirror

Module: **`src/goal/runtime-mirror.ts`**. `.clawdbot-dev` stays the private
source-of-truth store; `agent/history` gets a redacted mirror for future agents and
repo-chat.

### Mirror scope & exact artifacts

- **Goal mirror** (`mirrorGoalRuntimeToAgentHistory`): `resolveRunDir(goalId)` →
  `resolveAgentGoalHistoryDir(workspace, goalId)/runtime/…`, preserving directory shape.
  Categories classified: `run` (`run.json`), `working` (`WORKING.md`), `scout/`,
  `autocheck/` (also `replan/`), `workers/` (prompt + result + stdout + stderr),
  `manual-tests/`, `lessons/` (if present).
- **Cron mirror** (`mirrorCronRuntimeToAgentHistory`): `resolveCronStorePath()`
  (`jobs.json`) + `runs/*.jsonl` → `resolveAgentRoot()/history/cron/…` (include filter
  restricts to `jobs.json` and `runs/`).

### Skipped by default

`.bak` (backup file), forbidden files, lock files (`.lock`), database files
(`.sqlite/.sqlite3/.db/.db3`), secret paths, sockets, and non-regular files. Binary
content is detected via a NUL/control-byte heuristic. **Forbidden files:** names starting
`.env`/`credentials`, ending `.pem/.key/.p12/.pfx/.token`, plus `auth.json`,
`oauth.json`, `moltbot.json`, `clawdbot.json`, `smithersbot.json`.

### Cap policy (generous)

| Cap | Value | Applies to |
| --- | --- | --- |
| `RUNTIME_MIRROR_TEXT_CAP_BYTES` | 10 MB | text / JSON artifacts |
| `RUNTIME_MIRROR_STREAM_CAP_BYTES` | 25 MB | files whose path contains `stdout`/`stderr`/`response` |
| `RUNTIME_MIRROR_HARD_CAP_BYTES` | 50 MB | absolute ceiling (min'd against per-file cap) |

Over-cap files keep **head + tail** joined by
`RUNTIME_MIRROR_TRUNCATION_MARKER` (`[... runtime mirror truncated: kept head and tail ...]`).
The current real-world 604 KB autocheck output and 129 KB worker stdout mirror fully
(well under cap).

### Redaction mechanism

`redactRuntimeMirrorText()` wraps `redactSecretValues` (signature unchanged) and adds:
known in-memory secret values; private-key blocks
(`-----BEGIN … PRIVATE KEY----- … -----END … PRIVATE KEY-----`); API-key-like
(`sk-`/`rk-`), GitHub PAT/token-like (`github_pat_…`, `gh[opsu]_…`), and JWT-like
(`eyJ….….…`) strings; common `key: value` secret patterns
(`token|password|secret|api_key|authorization|bot_token|signing_secret`); and sensitive
host paths (Claude/Codex auth/session, managed private env, private runtime/config). It
returns a **redaction count**. Placeholder is `[REDACTED]`. Safe repo paths, line order,
JSON shape, and command shape are preserved. Unredacted fallback artifacts are never
written if redaction fails.

### Index format

`runtime/index.json` (goal) and `history/cron/index.json` (cron). Each entry:
`relativePath`, `kind`, `category`, `originalBytes`, `mirroredBytes`, `redactionCount`,
`truncated`, `skipped`, `skipReason?`, `sourceKind` (`goal-runtime` | `cron-runtime`).
The index records the source *kind*, not the full sensitive source path.

### Timing / wiring (fail-open)

Hooked into the lifecycle, all best-effort: scout/plan artifacts mirrored on the
`runCliPlanning` success path; autocheck artifacts after each round in
`plan-autocheck.ts`; worker prompt/result/stdout/stderr after each attempt in
`cli-worker.ts` (after redaction/persist); cron artifacts at the `server-cron.ts`
`finished` hook after `appendCronRunLog`. On any mirror failure a warning event is
written via `appendAgentHistoryEventBestEffort` and execution continues.

---

## 8. `.clawdbot-dev` prompt cleanup

Audited scout/planner, autocheck, worker, manual-tests, lessons, and repo-chat surfaces.
Generated prompts no longer instruct agents to read/write/output to `.clawdbot-dev`;
where history/artifacts are needed they reference `agent/history`. `.clawdbot-dev` now
appears only as the denied bullet (`- ~/.clawdbot-dev/**`) inside the grouped hard-deny
section. A cross-cutting regression test in `src/prompts/prompts.test.ts` builds 16
agent-facing surfaces and asserts: each names `.clawdbot-dev` only in the denied context,
`agent/history` is referenced where needed, and `.clawdbot-dev` is never a read/write
target.

---

## 9. Updated history language

The outdated *"raw stdout/stderr/transcripts are not mirrored by default"* wording was
replaced with the canonical sentence:

> **Redacted runtime artifacts are mirrored into agent history with generous caps and an
> index.**

Applied in `src/prompts/README.md` (lifecycle-map intro + every per-step persistence
cell for scout/planner/autocheck/worker/manual-tests/lessons), `src/prompts/repo-chat/
repo-chat-context.ts`, and the byte-identical worker contracts
(`shared-worker-contract.md`, `AGENTS.md`, `CLAUDE.md`). The README lifecycle test was
updated to assert the new sentence is present and the old wording is gone.

---

## 10. Manual-tests / lessons input cleanup

- **Manual-tests** (`buildManualTestsUserPrompt`): now consumes goal summary, changed
  surfaces, automated checks already run, live gaps derived from runtime events, and
  links/paths to agent-history runtime artifacts (`buildRuntimeArtifactReferences`)
  instead of pasting full run context. It keeps the instruction not to suggest already-run
  build/lint/test commands, the JSON output contract, and the human/live focus. Output is
  passed through `redactSecretValues`.
- **Lessons** (`buildCorrectionSummary`): now consumes completed/failed attempt
  summaries, compact failure summaries, and redacted stdout/stderr *history paths*
  (agent-history runtime mirror references, never `.clawdbot-dev`) plus manual feedback,
  instead of embedding huge raw transcripts. Redaction happens before any lesson text can
  be re-injected into future prompts; lesson extraction remains fail-open.

---

## 11. Before / after prompt character counts

Computed by importing the actual builders at `ff6afd011` (before) and the current tree
(after).

| Surface | Before | After | Δ |
| --- | ---: | ---: | --- |
| Planner system prompt — `buildPlanSystemPrompt()` | 13,745 | 10,816 | **−2,929 (−21.3%)** |
| Scout template — `scout_prompt_template.md` | 6,867 | 7,124 | +257 (+3.7%, agent-history refs / phase clarity) |
| Shared rubric — `buildPlanQualityRubric()` | — (did not exist) | 5,005 | **new single source** |
| Autocheck — `REVIEW_INSTRUCTION` (incl. embedded shared rubric) | 5,372 | 6,459 | +1,087 (now embeds 5,005-char shared rubric) |
| Autocheck-specific text (REVIEW_INSTRUCTION − shared rubric) | 5,372 | ~1,454 | **−3,918 (−73%)** |
| Worker hard-deny block — `writeDenyFile` output | 9,384 | 1,597 | **−7,787 (−83%)** |
| Worker contract — `WORKER_CONTEXT` | 8,318 | 8,364 | +46 (grouped-deny + mirror language) |
| Worker static prefix — `WORKER_PROMPT_STATIC_INSTRUCTION_PREFIX` | 1,773 | 1,563 | −210 (−11.8%) |
| Worker Claude shape — `buildCliPromptPayload(claude).appendedSystemPrompt` | n/a (builder shape changed) | 9,963 | grouped deny + WORKER_CONTEXT |
| Worker Codex shape — `buildCliPromptPayload(codex).promptArg` (dynamic stubbed) | n/a (builder shape changed) | 10,091 | grouped deny + conventions + guidelines |
| Manual-tests static — `MANUAL_TESTS_SYSTEM_PROMPT` | 2,389 | 2,389 | 0 (static unchanged; **dynamic user prompt** restructured to compact run-evidence) |
| Lessons static — `buildLessonExtractionPrompt(empty)` | 1,983 | 1,983 | 0 (static unchanged; **`buildCorrectionSummary`** now compact + mirror paths) |

Notes:
- The planner shrank ~21% by moving examples into the shared rubric and keeping only
  named anti-pattern summaries.
- Autocheck's *constant* grew only because the shared rubric is now embedded once;
  the autocheck-specific text and all duplicated criteria dropped ~73%.
- The before worker prompt assembled deny text via a different (non-exported) payload
  path, so its `buildCliPromptPayload` shape is "n/a (builder shape changed)"; the
  apples-to-apples win is the `writeDenyFile` block at −83%.
- Manual-tests and lessons *static* scaffolding is intentionally stable; the real
  reduction is in the **dynamic** inputs (full run context → compact run evidence +
  agent-history references), which are input-dependent and not a fixed character count.

---

## 12. Verification results

Focused suites run per task during the stage (all green at their commits):

- `src/prompts/prompts.test.ts`, `src/goal/cli-planner.test.ts`, `src/goal/planner.test.ts`,
  `src/goal/plan-autocheck.test.ts`
- `src/goal/runtime-mirror.test.ts`
- `src/commands/goal-resume.test.ts`
- `src/goal/hard-deny.test.ts`, `src/goal/cli-worker.test.ts`
- `src/cron/run-log.test.ts`, `src/gateway/server-cron.nightwatch.test.ts`
- `src/goal/manual-tests.test.ts`, `src/goal/lessons.test.ts`
- `src/goal/agent-surface-audit.test.ts`, `src/repo-chat/repo-chat-worker.test.ts`
- `pnpm exec tsc -p tsconfig.json` clean; `pnpm build` succeeds; `pnpm lint` 0/0.

This report task additionally re-ran **`pnpm build`** to confirm the tree still builds:
see "Verification" line at the end of this stage. The cross-cutting sweep
(`final-verification-matrix`) runs the full focused matrix + `tsc` + `build` + `lint` as
the closing task.

---

## 13. Remaining gaps

- **Fresh-rescout during replan** is documented as *deferred*: no existing command path
  supports a safe explicit rescout, so normal replan reuses cached scout context only.
- **Dev gateway / docs polish** is intentionally out of scope for this stage.
- **Demo video** not recorded (out of scope).
- Manual-tests/lessons *dynamic* input sizes are input-dependent; the win is structural
  (compact run evidence + mirror references) rather than a fixed character target.
- Live end-to-end confirmation of mirrored artifacts under `agent/history/.../runtime`
  requires a gateway restart + a disposable goal run, which a worker must not perform —
  see manual steps below.

---

## 14. Manual verification steps

1. Restart the gateway (operator action — workers must not restart it).
2. Run a small disposable goal.
3. Confirm scout/plan/worker/autocheck/manual-test artifacts appear under
   `agent/history/goals/<workspace>/<goalId>/runtime/…` and `agent/history/cron/…`.
4. Confirm no generated prompt instructs the agent to use `.clawdbot-dev`.
5. Confirm the hard-deny section is grouped and appears once at the start of both the
   Claude Code and Codex worker prompts.
6. Confirm redacted raw worker/autocheck output is available for debugging in the mirror
   (e.g. the 604 KB autocheck output and 129 KB worker stdout are present in full).
7. Confirm no fake planted secrets appear anywhere under `agent/history` and that
   `index.json` records non-zero `redactionCount` where redaction occurred.

---

## 15. Final verdict

- **Scout/planner prompt split:** yes
- **Planner/autocheck rubric shared:** yes
- **Planner examples compacted:** yes
- **Autocheck simplified:** yes
- **Hard-deny prompt grouped/deduped:** yes
- **Redacted runtime mirror implemented:** yes
- **.clawdbot-dev removed from agent-facing output instructions:** yes
- **Manual-tests/lessons input cleaned:** yes
- **Behavior preserved:** yes
- **Ready for dev gateway/docs polish:** yes
- **Replan uses cached scout context:** yes
- **Fresh scout avoided during normal replan:** yes

---

## 16. Live-smoke feedback repairs

The combined live Stage 2U-F smoke found three follow-up issues after this contract
work: the scout/planner prompt still exposed the private runtime store as a planning
artifact target, post-completion manual-test and lessons artifacts were missing from the
agent-history runtime mirror, and cron mirroring was not wired before the first completed
cron run. The repairs and verification are summarized in
`internal/STAGE2U_F_LIVE_SMOKE_FEEDBACK_REPAIR_REPORT.md`.
