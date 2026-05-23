# Stage 2U-C — Preflight Safety Gate

**Task:** `preflight-safety-gate` (read-only)
**Date:** 2026-05-23
**Goal:** Stage 2U-C agent flow, history durability, sandbox, prompt, and token audit
**Decision: GO ✅** — safe to proceed with Stage 2U-C instrumentation/audit edits.

This is a read-only gate. No `src/` files were modified in this step. Its purpose is to
confirm there is no overlapping in-flight edit to the status-formatting surfaces this goal
must not touch before Stage 2U-C begins editing source.

---

## 1. Git state

- **HEAD sha:** `684c8f0bff62ba8501b14fb620a2d20b7426c8c8`
- **Current branch:** `claw/run/20260523-163427Z-8cec60ca-bbca-481d-bbd4-79a07915e0eb`
- **HEAD commit:** `claw: smoke-report-and-verification — Created internal/STAGE2U_B_MANUAL_SMOKE_AND_STATUS_FORMAT_REPORT.md`

### Working-tree cleanliness

`git status --porcelain -- src/` is **empty** → **no source-tree changes are pending.**

The only working-tree entries are non-source workspace/home artifacts (not part of this goal,
not read here per the secrets policy):

```
 M .env.local            (env file — not read, hard-denied)
 M .env.production        (env file — not read, hard-denied)
 M .env.test             (env file — not read, hard-denied)
?? .bash_profile .bashrc .gitconfig .gitmodules .idea .mcp.json
?? .profile .ripgreprc .vscode .zprofile .zshrc .claude/
```

**Conclusion:** the source tree is clean. No uncommitted edits to any `src/` file, including
the status-formatting surfaces.

---

## 2. Overlapping-edit check — status-formatting surfaces

The surfaces this goal **must not touch** and their current state:

| Surface | Exists | Working-tree modified? | Last commit touching it |
|---|---|---|---|
| `src/telegram/gateway-status.ts` | yes (9639 B) | **no** | `07a3231f9` clean-gateway-status |
| `src/telegram/status-format.ts` | yes (584 B) | **no** | `bc1f6b453` shared-status-formatter |
| `/usage_status` (`src/telegram/usage-status.ts`, `bot-native-commands.ts`, `public-menu.ts`) | yes | **no** | `b31699ea1` clean-usage-status |

All three surfaces are **committed and stable at HEAD** with no pending edits.

### Is another active goal still editing them?

The runtime store `~/.smithersbot/goals` is **hard-denied** to workers, so active-run state was
read from the **sanitized agent-visible mirror** at
`/home/matt/smithersbot-goals/agent/history/` (the approved equivalent), specifically
`index/all-goals.jsonl` and `goals/smithersbot/<runId>/summary.json`.

Most-recent goal-run index entries (newest last):

| runId | timestamp (UTC) | status |
|---|---|---|
| `2361118c…` | 2026-05-23T11:50 | done |
| `c59f0436…` | 2026-05-23T13:52 | done |
| `d46a667c…` | 2026-05-23T16:09 | **cancelled** |
| `f272c465…` | 2026-05-23T16:44 | **done** |

- The status-formatting goal — **"Polish status command formatting and run Stage 2U-B manual
  smoke tests"** — is run `f272c465` (most recent, status **done**). Its three tasks are all
  `done`: *Add shared compact status formatter*, *Clean /usage_status + add /usage_history*,
  *Compress and bold /gateway_status*. An earlier attempt of the same goal (`d46a667c`) is
  `cancelled`. Both are **terminal**.
- That goal's work is already committed at/below HEAD:
  `bc1f6b453` → `b31699ea1` → `07a3231f9` → `684c8f0bf` (current HEAD).
- **No goal-run entry is in an active/in-progress state.** All recent entries are terminal
  (done / cancelled / blocked).
- The current goal (`8cec60ca`, branch `…163427Z…`) does **not** yet appear in the index —
  consistent with it just starting; nothing else is mid-write.

**Conclusion:** the overlapping status-formatting goal **finished and committed before this
goal started**. There is no concurrent writer to `gateway-status.ts`, `status-format.ts`, or
the `/usage_status` files.

---

## 3. Go / No-Go decision

**GO ✅**

Rationale:
1. Working tree has **zero pending `src/` edits**; status surfaces are committed and stable.
2. The status-formatting goal is in a **terminal (done)** state in the agent-visible history;
   no active goal is mid-write on overlapping files.
3. Stage 2U-C is **additive** (new `src/goal/agent-history-events.ts`, instrumentation wiring,
   audit reports) and is explicitly scoped **not** to edit `gateway-status.ts`,
   `status-format.ts`, or `/usage_status` formatting — so even the files at risk of conflict
   are out of this goal's edit set.

No **"wait for active goal"** blocker is required.

### Guardrails carried forward for subsequent Stage 2U-C tasks
- Do **not** edit `src/telegram/gateway-status.ts`, `src/telegram/status-format.ts`, or the
  `/usage_status` formatting (`src/telegram/usage-status.ts`).
- Do **not** change gateway restart/status formatting; do **not** restart the gateway from the
  worker.
- Do **not** read or print private env/auth/session/config contents
  (`~/.smithersbot/**`, `.env*`, etc.). Active-run state comes from the sanitized agent-visible
  mirror under `/home/matt/smithersbot-goals/agent/history/` only.

---

## 4. Method note

Commands used (all read-only): `git rev-parse HEAD`, `git status --porcelain[-/-sb]`,
`git log --oneline`, `git show --stat`, and directory/JSONL inspection of the agent-visible
history mirror. No private env/auth/session/config files were read.
