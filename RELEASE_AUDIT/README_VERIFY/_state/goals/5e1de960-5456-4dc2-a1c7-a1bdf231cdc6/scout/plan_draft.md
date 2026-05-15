BEGIN_PLAN_DRAFT
GOAL_ID: 5e1de960-5456-4dc2-a1c7-a1bdf231cdc6

## Mermaid Dependency Graph

graph TD
  add-run-node-docstring["Add docstring to scripts/run-node.mjs"]

## Node Summary

| Node ID | Type | Objective | Verification | Effort | Risk | Uncertainty |
|--------|------|-----------|--------------|--------|------|-------------|
| add-run-node-docstring | Impl | Add a short docstring to scripts/run-node.mjs | node --check scripts/run-node.mjs | 1 | 1 | 1 |

### Calibration Anchors

- **Effort:** 1 = trivial one-liner change, 2 = small focused change (~10 min), 3 = moderate implementation (~20 min), 4 = substantial multi-file work (~30 min), 5 = complex cross-cutting change (30+ min)
- **Risk:** 1 = safe isolated change, 3 = touches shared code, 5 = changes critical paths or public APIs
- **Uncertainty:** 1 = well-understood with clear approach, 3 = some unknowns, 5 = significant unknowns requiring exploration

## Edge Justifications

- (no edges — single-node plan)

## Project Conventions

CLAUDE.md exists at the project root. Key conventions:
- TypeScript ESM project; Node 22+ baseline; prefer Bun for TS execution.
- Local CLI entry point referenced as `node scripts/run-node.mjs <args>` (per /goal self-verification section).
- Add brief code comments for tricky/non-obvious logic.
- Keep changes minimal and focused; avoid unrelated refactors.
- Lint/format with `pnpm lint` (oxlint) and `pnpm format` (oxfmt).

AGENTS.md: not present at project root (only `tools.md` is mentioned as the agent notes file).

END_PLAN_DRAFT
