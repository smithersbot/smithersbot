# Stage 2G Evidence Ledger

This document collects evidence for Stage 2G repo minimization decisions.
Each subsystem section below will be populated in subsequent steps (B2–B7).
No deletions or quarantines should occur until the relevant section is filled
and the DECISION column is set.

## Column Legend

Every row in every section below uses this shared schema:

| Column | Meaning |
| --- | --- |
| **PATH** | The file or directory under consideration. |
| **IMPORTERS** | Code paths (under `src/`, `extensions/`, `scripts/`, etc.) that import or otherwise depend on PATH. Empty = no importers found. |
| **PACKAGE/WORKSPACE/VITEST REFS** | Mentions in `package.json` (files[], scripts, bin, exports), `pnpm-workspace.yaml` globs, and `vitest.config.ts` include/exclude entries. |
| **TESTS** | Test files that cover PATH or assert behavior provided by it. |
| **REQUIRED BY v0?** | yes / no / unclear. v0 surface = Telegram control, `/new_goal` planning + execution, repo chat, goal status/list/resume/stop, goal lessons/memory, external verification, Nightwatch, local CLI support. |
| **DECISION** | One of: `delete-now`, `quarantine-now`, `keep`, `defer`. |
| **VERIFICATION NEEDED** | The minimal command(s) that must pass after the decision is applied (e.g. `pnpm exec tsc`, `pnpm build`, `pnpm lint`, targeted `pnpm vitest run <slice>`). |

## 1. Browser / Chrome Extension

_To be populated in track-b2-evidence-browser-ui-canvas._

## 2. UI

_To be populated in track-b2-evidence-browser-ui-canvas._

## 3. Canvas / Vendor

_To be populated in track-b2-evidence-browser-ui-canvas._

## 4. Extensions

_To be populated in track-b3-evidence-extensions._

## 5. Skills

_To be populated in track-b4-evidence-skills-hooks._

## 6. Hooks

_To be populated in track-b4-evidence-skills-hooks._

## 7. Deploy

_To be populated in track-b5-evidence-deploy._

## 8. Package / Workspace / Test Config

_To be populated in track-b6-evidence-package-workspace._

## 9. CLI Subcommands

_To be populated in track-b7-evidence-cli._
