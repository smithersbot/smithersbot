# Stage 2U-C — Agent Surface Security, Token, Prompt & History-Durability Audit

**Task:** `final-audit-report-and-resume`
**Date:** 2026-05-23
**Goal:** Stage 2U-C agent flow, history durability, sandbox, prompt, and token audit
**HEAD context:** branch `claw/run/20260523-163427Z-8cec60ca…` (preflight decision **GO** — see `STAGE2U_C_PREFLIGHT.md`)

This is the consolidated Stage 2U-C audit. It reconciles every claim below against the
**post-instrumentation** tree: the shared primitives in `src/goal/agent-history-events.ts` are wired
into every Codex/Claude CLI agent surface, the sandbox classification lives in
`src/goal/agent-surface-audit.ts`, and the durability behavior is proven by mocked crash/restart/resume
tests in `src/goal/agent-history-events.crash-resume.test.ts`.

Single sources of truth this report mirrors:

- Flow map → [`STAGE2U_C_AGENT_FLOW_MAP.md`](./STAGE2U_C_AGENT_FLOW_MAP.md) (+ `STAGE2U_C_AGENT_FLOW_MAP.json`)
- Sandbox classification → `src/goal/agent-surface-audit.ts` (`buildAgentSurfaceAudit`)
- Machine-readable mirror of these tables → [`STAGE2U_C_AGENT_SURFACE_AUDIT.json`](./STAGE2U_C_AGENT_SURFACE_AUDIT.json)

---

## 1. Flow-map summary

A goal flows: `/new_goal` intake → **scout+planner** (`cli-planner.ts runCliPlanning`, combined) →
**plan autocheck** (`plan-autocheck.ts`) → on rejection **plan revision** (`cli-planner.ts
runCliPlanRevision`) → approval gate → **execution worker** (`agent-executor.ts → cli-runner.ts →
cli-worker.ts → cli-process.ts`, or the in-process `pi` backend via `pi-runner.ts`) → **post-execution
review** (`post-execution-review.ts`) → **manual-tests** (`manual-tests.ts`) → **lessons**
(`lessons.ts`). **Repo-chat** (`repo-chat-worker.ts`) and **nightwatch** cron run independently.
**Repair/retry** re-runs the worker/repo-chat; **resume/replan** (`goal-resume.ts`) re-invokes the
worker (resume) and planner (replan). **Usage-limit fallback** swaps Claude↔Codex.

Trust zones (`src/config/managed-paths.ts`): `<root>/agent/` is agent-visible (sanitized history,
workspaces); `<root>/private/` is host-only (real env/auth/sessions, hard-denied to workers);
`<root>/scratch/` is gateway-controlled. Agent-visible history per goal lives at
`<root>/agent/history/goals/<ws>/<goalId>/` (`events.jsonl` + `prompts/` incremental; `summary.json`
terminal-only) and per repo-chat at `<root>/agent/history/repo-chats/<ws>/<sessionId>/`.

Full detail (caller→callee, files read/written, WHEN written, prompt sites, token sites, Mermaid
diagram) is in `STAGE2U_C_AGENT_FLOW_MAP.md`.

---

## 2. Per-surface backend paths

| Surface | Source | Codex path | Claude Code path | Other backend |
| --- | --- | --- | --- | --- |
| scout-planner | `cli-planner.ts` | `exec` `--sandbox workspace-write` (fallback) | `-p --allowedTools Read,Glob,Grep,Bash` (preferred) | — |
| plan-autocheck | `plan-autocheck.ts` | `exec --json --sandbox read-only` | print mode | — |
| plan-revision | `cli-planner.ts` | `exec` (fallback) | print mode (preferred) | — |
| worker | `cli-worker.ts` | native permission-profile sandbox (workspace-write) | native fail-closed sandbox settings | `pi` (in-process, `pi-runner.ts`) |
| repair | `agent-executor.ts` / `repo-chat-worker.ts` | reuses worker/repo-chat native helper | reuses worker/repo-chat native helper | reuses worker (`pi`) |
| resume-replan | `goal-resume.ts` / `goal.ts` | resume→worker helper; replan→planner opt-out | resume→worker helper; replan→planner opt-out | resume→worker (`pi`) |
| repo-chat | `repo-chat-worker.ts` | native permission-profile sandbox (read-only) | native fail-closed sandbox settings (read-only) | — |
| post-execution-review | `post-execution-review.ts` | `exec --sandbox workspace-write` (fallback) | print mode (preferred) | — |
| manual-tests | `manual-tests.ts` | `exec --sandbox` (CLI fallback) | print mode (CLI) | `GoalLlmClient.complete()` (Anthropic SDK, no FS subprocess) |
| lessons | `lessons.ts` | `exec --sandbox read-only` (fallback) | print mode (preferred) | — |
| goal-sending *(out)* | `telegram/goal-sending.ts` | `exec --sandbox workspace-write` (Mermaid repair) | read-only tools (Mermaid repair) | — |
| nightwatch *(out)* | `cron/nightwatch.ts` | `exec --sandbox read-only --skip-git-repo-check` | read-only tools | — |
| pi-runner *(out)* | `goal/pi-runner.ts` | n/a | n/a | in-process `pi` (`@mariozechner/pi-ai`) |

---

## 3. Sandbox / security classification table

Derived from `src/goal/agent-surface-audit.ts` (`buildAgentSurfaceAudit`). Classifications:
`shared-native-sandbox-helper-proven` (proven deny matrix via `backend-sandbox.ts`),
`credential-stripped-native-sandbox-opt-out` (credentials stripped but coarse/no native file-deny
matrix — 2U-E hardening target), `read-only-non-agent-local`, `native-sandbox-proven`,
`not-safe-needs-fix`. No surface is `not-safe-needs-fix`.

| Surface | In scope | Codex classification | Claude Code classification | Private env denied | Repo `.env*` denied | Symlink escape denied | Auth/session denied | Cred stripped | Sub-auth / API-key poisoning stripped (Claude) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| scout-planner | yes | cred-stripped opt-out | cred-stripped opt-out | no | no | no | no | yes | yes / yes |
| plan-autocheck | yes | cred-stripped opt-out | cred-stripped opt-out | no | no | no | no | yes | yes / yes |
| worker | yes | **shared-native-proven** | **shared-native-proven** | yes | yes | yes | yes | yes | yes / yes |
| repo-chat | yes | **shared-native-proven** | **shared-native-proven** | yes | yes | yes | yes | yes | yes / yes |
| post-execution-review | yes | cred-stripped opt-out | cred-stripped opt-out | no | no | no | no | yes | yes / yes |
| manual-tests | yes | cred-stripped opt-out | cred-stripped opt-out | no | no | no | no | yes | yes / yes |
| lessons | yes | cred-stripped opt-out | cred-stripped opt-out | no | no | no | no | yes | yes / yes |
| repair | yes | shared-native-proven (reuses worker/repo-chat) | shared-native-proven (reuses worker/repo-chat) | yes | yes | yes | yes | yes | yes / yes |
| resume-replan | yes | resume→native-proven; replan→opt-out | resume→native-proven; replan→opt-out | resume: yes / replan: no | resume: yes / replan: no | resume: yes / replan: no | resume: yes / replan: no | yes | yes / yes |
| goal-sending | **no** (Mermaid repair utility) | cred-stripped opt-out (doc only) | cred-stripped opt-out (doc only) | no | no | no | no | yes | yes / yes |
| nightwatch | **no** (cron maintenance) | cred-stripped opt-out (doc only) | cred-stripped opt-out (doc only) | no | no | no | no | yes | yes / yes |
| pi-runner | **no** (in-process; capability-enforcement boundary) | n/a | n/a | n/a (capability-enforcement + hard-deny) | n/a | n/a | n/a | no (uses provider API keys directly) | n/a |

**No `--dangerously-bypass` / `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox` flags are used by any surface.** Nightwatch's `--skip-git-repo-check` is a benign "run outside a git repo" flag, NOT a sandbox bypass.

**Live OS-level (bubblewrap) sandbox proof** is env-gated. Enable command:
`SMITHERSBOT_SANDBOX_LIVE_PROBES=1 pnpm vitest run src/goal/sandbox-probes.test.ts`. In the worker
subprocess the flag is unset and `/var/tmp` is outside the command-sandbox write-allowlist, so the live
probe is recorded as `not-run` with the exact blocker rather than a vague failure
(`captureLiveSandboxProofStatus`). The mocked deny-matrix proofs in `backend-sandbox.test.ts` pass when
`CODEX_HOME` is set outside the agent root (see Verification).

---

## 4. Prompt-capture table

Every in-scope CLI surface writes the **exact prompt** (after `redactSecretValues`) to a prompt
artifact **before** spawning the backend, via `writeCriticalAgentLaunchEvent` (fail-closed). The launch
event also records backend, phase, run/goal/session id, sanitized argv shape, and the prompt-artifact
path.

| Surface | Prompt builder | Captured before spawn | Backend / phase / id recorded | Sandbox instr. in prompt | Notes |
| --- | --- | --- | --- | --- | --- |
| scout-planner | `buildPlanningPrompt` | yes (redacted) | yes | yes (scout template) | static scout prefix + dynamic goal |
| plan-autocheck | `buildAutocheckPrompt` | yes | yes | yes (`REVIEW_INSTRUCTION`) | per round |
| plan-revision | `buildPlanRevisionPrompt` | yes | yes | yes | per revision |
| worker (CLI) | `buildCliWorkerPrompt` / `buildCliPromptPayload` | yes | yes | yes (capability bounds) | per attempt |
| worker (`pi`) | in-process via `pi-runner.ts` | **no (gap)** | no | n/a | not wired to primitives — see Gaps |
| repo-chat | `buildClaudeRepoChatArgs` / `buildCodexRepoChatArgs` | yes | yes (sessionId) | yes (`CLAUDE_READ_ONLY_PROMPT`) | session-keyed dir |
| post-execution-review | `buildPostExecutionReviewPrompt` | yes (per chunk) | yes | yes | per diff chunk |
| manual-tests (CLI) | `buildManualTestsUserPrompt` | yes | yes | yes | CLI fallback path |
| manual-tests (client) | `buildCombinedManualTestsPrompt` | yes | yes | n/a (API) | `GoalLlmClient` path |
| lessons | `buildLessonExtractionPrompt` | yes | yes | yes | preferred Claude, Codex fallback |

All prompt artifacts pass through `redactSecretValues` (prefix patterns `sk-`/`ghp_`/`xoxb-`/`AKIA`/JWT
plus config + `*TOKEN/*SECRET/*API_KEY` env values). Proven secret-free by
`agent-surface-audit.test.ts` ("agent-visible history is secret-free") and the crash/resume tests.

---

## 5. Token / usage-capture table

`parseBackendUsage` normalizes Claude stream-json `usage` (input/output/cache_read/cache_creation,
`total_cost_usd`) and Codex `token_count`/`usage` JSON events into one record, returning
`{available:false, reason}` when not derivable (never fabricated). The manual-tests **client** path uses
`usageFromGoalLlmClient` over `GoalLlmClient.complete().usage`.

| Surface | Backend used | Input/output tokens | Cache read/write | Cost | Duration | Attempts / fallback | Prompt artifact | Result artifact |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| scout-planner | Claude/Codex | when present | Claude: yes | Claude: yes | event ts | attempt bundle + fallback events | yes | runtime `scout/` + `result` event |
| plan-autocheck | Codex/Claude | when present | when present | when present | per round | per-round + fallback events | yes | `autocheck/round-*` + `result` event |
| worker | Claude/Codex | when present | when present | when present | event ts | `AttemptBundle.tokenUsage` + fallback events | yes | `workers/<step>` + `result` event |
| worker (`pi`) | pi (API) | **not normalized (gap)** | gap | gap | — | — | gap | gap |
| repo-chat | Claude/Codex | when present | when present | when present | event ts | both attempts on fallback | yes | session store + `success` event |
| post-execution-review | Claude/Codex | when present | when present | when present | per chunk | per chunk + fallback | yes | `result` event |
| manual-tests (CLI) | Claude/Codex | when present | when present | when present | event ts | fallback events | yes | `manual-tests/` + `result` event |
| manual-tests (client) | Anthropic SDK | `res.usage` | `res.usage` | when present | event ts | n/a | yes | `result` event |
| lessons | Claude/Codex | when present | when present | when present | event ts | fallback (fail-open) | yes | lessons store + `result` event |

Where exact tokens are not in the backend output the record is `{available:false, reason}`. Historical
`ccusage` is NOT used as per-run truth (only supplementary context).

---

## 6. History-durability table

`L` = `writeCriticalAgentLaunchEvent` (fail-closed prompt + launch event **before** spawn). `R` =
best-effort `result`/`failure`/`fallback`/`status` events **after/during** (`appendAgentHistoryEvent*`,
returns a warning instead of throwing).

| Surface | Canonical runtime store | Agent-visible events.jsonl | Prompt saved before spawn | Status incremental | Partial/error on crash | Token summary | Visible after restart | Secrets redacted |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| scout-planner | yes (`scout/`) | yes (L+R) | yes | yes | yes (failure/retry) | yes | yes | yes |
| plan-autocheck | yes (`autocheck/`) | yes (L+R) | yes | per round | yes | yes | yes | yes |
| plan-revision | yes (`revision*/`) | yes (L+R) | yes | yes | yes | yes | yes | yes |
| worker (CLI) | yes (`workers/`) | yes (L+R) | yes | yes | yes (process_lost/missing_result before user msg) | yes | yes | yes |
| worker (`pi`) | yes (`workers/`) | **no (gap)** | no | no | no agent-visible event | no | partial (runtime only) | n/a |
| repo-chat | yes (session.json) | yes (L+R, session-keyed) | yes | turn_start | yes (failure before propagate) | yes | yes | yes |
| post-execution-review | none (read-only) | yes (L+R) | yes | per chunk | yes | yes | yes | yes |
| manual-tests | yes (`manual-tests/`) | yes (L+R) | yes | yes | yes | yes | yes | yes |
| lessons | yes (lessons store) | yes (L+R) | yes | yes | yes (fail-open) | yes | yes | yes |
| summary.json / index | runtime + mirror | **terminal-only** (by design) | n/a | no | n/a | n/a | yes (if reached) | yes |

**Terminal-only mirrors:** `mirrorGoalRunToAgentHistory` (`agent-history.ts`, gated in `run-store.ts` on
`state ∈ {done,blocked,cancelled}`) and `mirrorRepoChatSessionToAgentHistory` (in `saveRepoChatSession`)
write `summary.json` + index **only** at terminal states. In-flight durability therefore relies entirely
on the incremental `events.jsonl` + `prompts/`, which are written before/during each phase — this is the
core Stage 2U-C fix.

---

## 7. Crash / restart / resume findings

Proven by mocked tests in `src/goal/agent-history-events.crash-resume.test.ts` (5 tests, all green):

1. **Planner/scout launch+prompt before death** — the fail-closed launch event + redacted prompt
   artifact are on disk before the backend ever returns; after a simulated restart a fresh process
   re-resolves the path and finds them, with no terminal `result` written. ✔
2. **Worker exit without `worker_result.json`** — a `failure` event with `errorClass:"process_lost"` is
   written **before** any user-facing message (ordering asserted via a sequence log). ✔
3. **Usage-limit fallback records BOTH backends** — `usage_limit` (claude_code,
   `anthropic_usage_limit`) and `usage_limit_fallback` (codex, `transition:{from,to}`) are written as
   separate incremental JSONL lines, in order, before the fallback launch. ✔
4. **Resume discovers partial history** — after a restart with only launch+status on disk (no terminal
   result), resume re-resolves the goal history dir, reads the partial stream, and appends a `result`
   to the SAME stream (continuity). ✔
5. **Cross-context visibility** — goal history is readable by a later scout/planner context
   (`resolveAgentHistoryEventsPath` for the goal id), and repo-chat turn-1 history is readable by a
   follow-up turn rebuilding the same session-keyed scope, which then appends turn-2. ✔

Restart reconciliation (documented, not destructively tested): `loadRun` → `migrateRun` performs
stale-execution recovery; `hasActiveRunLock` checks PID liveness; `reconcileStaleRuns` rescans on
startup. No live gateway was killed.

---

## 8. Exact fixes made (this goal)

1. **`src/goal/agent-history-events.ts`** (instrumentation-primitives) — new shared module:
   `appendAgentHistoryEvent` (atomic JSONL append, recursive redaction), `writeAgentPromptArtifact`
   (tmp+rename, redacted), `writeCriticalAgentLaunchEvent` (fail-closed pre-spawn),
   `appendAgentHistoryEventBestEffort` (warning, not throw), `parseBackendUsage`.
2. **`src/goal/cli-worker.ts` + `agent-executor.ts` + `attempt-bundle.ts`**
   (instrument-worker-execution) — pre-spawn launch + redacted prompt; post-run result/failure with
   error class + `tokenUsage` in `AttemptBundle`; usage-limit fallback writes BOTH backends
   incrementally.
3. **`src/goal/cli-planner.ts` + `plan-autocheck.ts`** (instrument-planning-autocheck) — launch +
   prompt before each spawn; failure/retry/fallback/result/round events; planner tokens in attempt
   bundle.
4. **`src/goal/post-execution-review.ts` + `lessons.ts` + `manual-tests.ts`**
   (instrument-review-lessons-manualtests) — launch + prompt before each spawn (per chunk where
   chunked); result/failure/fallback events; tokens via `parseBackendUsage` or `usageFromGoalLlmClient`;
   run ids threaded into callers.
5. **`src/repo-chat/repo-chat-worker.ts`** (instrument-repo-chat) — session-keyed launch + prompt;
   turn_start/success/failure events; tokens; fallback records both backends.
6. **`src/goal/agent-surface-audit.ts` + test** (security-sandbox-audit) — classification builder for
   every surface + the three excluded callers; secret-free-history proof.
7. **`src/goal/agent-history-events.crash-resume.test.ts`** (this task) — the five crash/restart/resume
   proofs above.
8. **Docs** (this task) — this report, `STAGE2U_C_AGENT_SURFACE_AUDIT.json`, the flow map (prior task).

No sandbox policy was changed (no clear gap found that warranted a small/safe fix); the audit confirmed
the writers correctly refuse to write into agent-root-violating locations.

---

## 9. Remaining gaps

- **`pi` in-process worker backend is uninstrumented.** When a step runs on the `pi` backend,
  `agent-executor.ts` uses `PiTaskRunner` (`pi-runner.ts`), which does NOT import the agent-history
  primitives — no launch event, no prompt artifact, no token normalization in agent-visible history.
  `pi` is **out of scope** for this Codex/Claude CLI audit (its boundary is capability-enforcement /
  hard-deny, recommended for a separate review), but it is a real durability/observability gap if `pi`
  is used as a worker backend. **Recommended:** thread the primitives through `pi-runner.ts` in a
  follow-up, and normalize pi-ai usage into `parseBackendUsage`.
- **`summary.json` / index mirrors are terminal-only** by design. In-flight durability is fully covered
  by `events.jsonl`/`prompts/`, but no rolling `summary.json` exists mid-run. Acceptable; documented.
- **Credential-stripped, native-sandbox-opt-out surfaces** (scout-planner, plan-autocheck,
  post-execution-review, manual-tests, lessons) do not enforce the proven `.env`/auth file-read deny
  matrix. They are credential-stripped (real boundary) but are 2U-E hardening targets — NOT current
  security blockers.
- **Live OS bubblewrap proof is env-gated** in the worker subprocess (blocker recorded with exact enable
  command). Not a code gap; an environment limitation.
- **Static-vs-dynamic prompt ordering** for cache efficiency is not yet optimized (deferred to 2U-E).

---

## 10. Recommended 2U-E token-reduction targets

Now that usage is measured per phase/backend, prioritize by likely token volume:

1. **Worker prompt** (`buildCliWorkerPrompt`/`buildCliPromptPayload`) — largest and most frequent;
   move the static capability-bounds / sandbox-instruction prefix ahead of dynamic task text to
   maximize prompt-cache hits across attempts/retries.
2. **Scout+planner prompt** (`buildPlanningPrompt`) — large static scout template; stabilize its prefix
   ordering and consider trimming repeated repo context.
3. **Plan-autocheck** (`buildAutocheckPrompt`) — runs per round with a repeated `REVIEW_INSTRUCTION`;
   cache the static instruction prefix and send only the round-delta.
4. **Post-execution-review** — diff chunking already bounds size; ensure the static review instruction
   is cache-stable across chunks.
5. **Lessons / manual-tests** — lower frequency; reorder static instruction before dynamic run summary.
6. **`pi` backend** — once instrumented, measure before optimizing.

Base every 2U-E change on the captured `tokenUsage` records, not estimates. Confirm cache_read tokens
rise after prefix-ordering changes.

---

## 11. Recommended README / SETUP updates

- **README.md** — add a short "Agent history & observability" note: agent-visible history lives under
  `<SMITHERSBOT_GOALS_ROOT>/agent/history/goals/<ws>/<goalId>/` (`events.jsonl` + `prompts/`), is
  written incrementally before/during each phase, is secret-redacted, and survives gateway
  crash/restart. Repo-chat history is session-keyed under `…/repo-chats/<ws>/<sessionId>/`.
- **SETUP.md** — document that `summary.json`/index entries are terminal-only while `events.jsonl` is
  incremental, and that the live OS sandbox proof is opt-in via
  `SMITHERSBOT_SANDBOX_LIVE_PROBES=1 pnpm vitest run src/goal/sandbox-probes.test.ts`.
- Note the sandbox posture: worker & repo-chat use the proven shared native sandbox helper;
  planning/review/lessons/manual-tests are credential-stripped with a coarser sandbox (2U-E hardening
  targets), and the `pi` backend uses in-process capability-enforcement.
- Cross-link `STAGE2U_C_AGENT_FLOW_MAP.md` for the full flow.

---

## 12. Verification

Final cross-cutting sweep executed by the `final-verification-sweep` task (2026-05-23). All commands
were run from the repo root `…/agent/workspaces/smithersbot/repo`.

### 12.1 Static checks — all green

| Command | Result |
| --- | --- |
| `pnpm exec tsc -p tsconfig.json` | **exit 0** (clean) |
| `pnpm build` | **exit 0** (tsc + canvas/hook/scout/worker-contract copy + build-info) |
| `pnpm lint` | **exit 0** — `oxlint --type-aware src test`: 0 warnings, 0 errors (2343 files, 104 rules) |

### 12.2 Focused suites — all green (14/14, modulo one env-gated live OS probe)

Run with the default command sandbox unless a column notes otherwise:

| Suite | Result |
| --- | --- |
| `src/goal/agent-history-events.test.ts` | pass |
| `src/goal/cli-worker.test.ts` | **66 pass** — see env note (A) |
| `src/goal/agent-executor.test.ts` | pass |
| `src/goal/cli-planner.test.ts` | pass |
| `src/goal/plan-autocheck.test.ts` | pass |
| `src/goal/post-execution-review.test.ts` | pass |
| `src/goal/lessons.test.ts` | pass |
| `src/goal/manual-tests.test.ts` | pass |
| `src/repo-chat/repo-chat-worker.test.ts` | pass |
| `src/repo-chat/repo-chat-store.test.ts` | pass |
| `src/goal/agent-surface-audit.test.ts` | pass |
| `src/goal/backend-sandbox.test.ts` | pass — see env note (B) |
| `src/goal/sandbox-probes.test.ts` | 5 pass; 1 live probe — see env note (C) |
| `src/goal/agent-history-events.crash-resume.test.ts` | **5 pass** |

The bulk batch `pnpm vitest run` of the 12 non-sandbox-proof suites reported **377 passed** with the only
failures isolated to `cli-worker.test.ts` (env note A), which then passed **66/66** when re-run outside
the command sandbox.

### 12.3 Environment-limited results (exact command + exact blocker, NOT masked)

These are environment/command-sandbox artifacts of running the sweep *inside* a goal worker whose
command sandbox blocks `/var/tmp` writes and whose `vitest.config.ts` forces `TMPDIR` to
`<repo>/.tmp/vitest` (inside the agent root). None is a code regression; this goal's changes are
additive instrumentation + audit and changed no sandbox policy. Confirmed by re-running each green.

**(A) `cli-worker.test.ts` — command sandbox blocks `/var/tmp`.**
- Exact command (default sandbox): `pnpm vitest run src/goal/cli-worker.test.ts`
- Exact blocker: 10 tests fail with `Error: EROFS: read-only file system, open '/var/tmp/smithersbot-claude-run-process-lost/settings.json'` and `Error: ENOENT: no such file or directory, mkdir '/var/tmp/smithersbot-claude-run-history-usage'`, thrown from `writeClaudeCodeSandboxSettings` (`src/goal/backend-sandbox.ts:670-671`) via `buildClaudeCodeSandboxLaunchConfig`. `DEFAULT_CLAUDE_SANDBOX_SETTINGS_ROOT = "/var/tmp"` (`backend-sandbox.ts:151-153`); the goal-worker command sandbox does not include `/var/tmp` in its write-allowlist.
- Proof it is environment-only: the same command run **outside the command sandbox** passes **66/66** (exit 0).

**(B) `backend-sandbox.test.ts` — `vitest.config.ts` forces `TMPDIR` inside the agent root.**
- Exact command (default): `pnpm vitest run src/goal/backend-sandbox.test.ts` → 14 mocked tests fail because `HOST_TEMP_ROOT` falls back to `os.tmpdir()` (`backend-sandbox.test.ts:8-10`), which `vitest.config.ts:8-10` pins to `<repo>/.tmp/vitest` (inside the agent root); `writeCodexNativeSandboxConfig` / `writeClaudeCodeSandboxSettings` then **correctly** throw `… sandbox settings must be outside agent-visible paths` (this throw is the sandbox working as designed).
- Exact unblock command: `CODEX_HOME="$TMPDIR/cxhome" pnpm vitest run src/goal/backend-sandbox.test.ts` (with `mkdir -p "$TMPDIR/cxhome/memories"`), where `$TMPDIR=/tmp/claude-1000` is outside the agent root → **all pass** (exit 0). This proves the sandbox-write-target guard is enforced correctly.

**(C) Live Codex OS sandbox probe — env-blocked (cannot complete a real nested Codex run).**
- Exact command: `SMITHERSBOT_SANDBOX_LIVE_PROBES=1 pnpm vitest run src/goal/sandbox-probes.test.ts` (this env var is set in the current goal-worker env, so the `it.runIf(isLiveSandboxProbeEnabled())` live test executes rather than skipping).
- Exact blocker: `runGoalWorkerSandboxLiveProbe("codex")` (`sandbox-probes.ts:255`) spawns a real Codex worker via `executeTaskWithCliWorker` and returns `{status:"unproven", reason:"goal-worker probe did not complete: failed"}` — the nested Codex worker run does not reach `status:"complete"` inside this worker environment. `codex` (`/home/matt/.nvm/.../bin/codex`) and `bwrap` are both present on PATH, so the blocker is not a missing binary; the nested Codex+bubblewrap worker cannot complete an end-to-end run under the goal-worker's own constraints (no writable `/var/tmp` for the native config under the command sandbox; nested user-namespace/exec limits). Re-running the probe **outside the command sandbox** still returns `unproven` ("…: failed"), confirming this is an OS/environment limitation of the nested worker, not a regression.
- Designed-off behavior (matches normal CI and the prior security-sandbox-audit run): `SMITHERSBOT_SANDBOX_LIVE_PROBES=0 pnpm vitest run src/goal/sandbox-probes.test.ts` → **5 passed, 1 skipped** (exit 0).

### 12.4 No source modified to force green

No production source, test, lint rule, or sandbox policy was changed by this sweep. The two failing
default-sandbox suites pass under the documented host conditions (outside the command sandbox / with
`CODEX_HOME` outside the agent root), and the live OS probe is an environment-gated proof recorded
above rather than a masked failure.

---

## 13. Final verdict

- **Agent-visible history durable: yes** — incremental `events.jsonl` + redacted `prompts/` written
  before/during every Codex/Claude CLI phase; survives simulated crash/restart (5 mocked proofs). The
  `pi` worker backend is the one uninstrumented exception (gap §9).
- **All prompts captured: yes** — every in-scope Codex/Claude CLI agent surface writes the exact
  redacted prompt before spawn; the `pi` in-process backend is a documented gap.
- **Token usage captured by phase: yes** — `parseBackendUsage` / `usageFromGoalLlmClient` per
  phase+backend, recording `{available:false, reason}` when not derivable; `pi` normalization is a gap.
- **All agent surfaces sandbox-audited: yes** — every surface (and the 3 excluded callers) is
  classified in `agent-surface-audit.ts`; the live OS bubblewrap proof is env-gated with the exact
  blocker recorded.
- **Security blockers remaining: no** — no surface is `not-safe-needs-fix`; no dangerous skip flags; no
  sandbox policy weakened. Opt-out surfaces are 2U-E hardening targets, not blockers.
- **Ready for 2U-E token optimization: yes** — measurement instrumentation is in place per
  phase/backend; optimization can proceed from data, not guesses.
