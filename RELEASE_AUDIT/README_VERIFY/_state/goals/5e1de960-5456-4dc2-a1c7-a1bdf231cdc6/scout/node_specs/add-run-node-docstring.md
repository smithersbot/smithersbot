GOAL_ID: 5e1de960-5456-4dc2-a1c7-a1bdf231cdc6
Type: Impl
Objective: Add a short docstring to scripts/run-node.mjs describing the script's purpose

Requirements:
1. Insert a concise top-of-file comment block in scripts/run-node.mjs immediately after the `#!/usr/bin/env node` shebang.
2. The docstring must describe what the script does: it is the local dev entrypoint used by `node scripts/run-node.mjs <args>` (and `npm run moltbot -- <args>`), which conditionally builds TypeScript to `dist/` (using `tsgo` by default, or `tsc` when `CLAWDBOT_TS_COMPILER=tsc`) when sources are newer than `dist/.buildstamp`, then spawns Node on `moltbot.mjs` with the forwarded args. It also honors `--json`/`--output json` to suppress non-JSON output and `CLAWDBOT_FORCE_BUILD=1` to force a rebuild.

Constraints:
- Do not modify any runtime behavior, control flow, env-var handling, or build/run logic.
- Do not reorder or rename existing code, variables, or imports.
- Keep the docstring concise (roughly 5–15 lines); plain JS block comment (`/** ... */` or `// ...` lines) is acceptable — match the file's existing comment style.
- Do not introduce new dependencies or files.

Verification: node --check scripts/run-node.mjs
