# Stage 2I CI Workflow Report

## Executive Summary

Stage 2I adds a minimal GitHub Actions verification workflow that mirrors the local Stage 2H v0 verification shape (see [STAGE2H_REPORT.md](./STAGE2H_REPORT.md)). The workflow installs dependencies with the lockfile-pinned pnpm version, then runs typecheck, build, lint, and the four targeted vitest slices used in Stage 2H. No README CI badge is added in this stage; the badge is deferred until the first remote GitHub Actions run passes.

Recommendation: ready for demo from local verification evidence. The four vitest slices, typecheck, build, lint, and frozen install all exit `0` locally on this branch.

## 1. Workflow File Added

Path: `.github/workflows/ci.yml`

Full YAML:

```yaml
name: CI

on: [push, pull_request]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Enable Corepack and activate pinned pnpm
        run: |
          corepack enable
          corepack prepare pnpm@10.23.0 --activate

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Typecheck
        run: pnpm exec tsc -p tsconfig.json

      - name: Build
        run: pnpm build

      - name: Lint
        run: pnpm lint

      - name: Test (telegram, hooks, goal, repo-chat, memory)
        run: pnpm vitest run src/telegram/ src/hooks/ src/goal/ src/repo-chat/ src/memory/

      - name: Test (auto-reply)
        run: pnpm vitest run src/auto-reply/

      - name: Test (cli)
        run: pnpm vitest run src/cli/

      - name: Test (infra outbound)
        run: pnpm vitest run src/infra/outbound/
```

Notes:

- Single job `verify` runs on `ubuntu-latest`. The self-hosted `blacksmith-*` labels referenced in `.github/actionlint.yaml` are intentionally not used here.
- Corepack enables the pinned `pnpm@10.23.0` from the root `package.json` `packageManager` field before `actions/setup-node` configures the pnpm cache.
- No secrets are referenced.

## 2. Exact Commands In CI

The eight pnpm commands the workflow runs after install, verbatim and in order:

1. `pnpm install --frozen-lockfile`
2. `pnpm exec tsc -p tsconfig.json`
3. `pnpm build`
4. `pnpm lint`
5. `pnpm vitest run src/telegram/ src/hooks/ src/goal/ src/repo-chat/ src/memory/`
6. `pnpm vitest run src/auto-reply/`
7. `pnpm vitest run src/cli/`
8. `pnpm vitest run src/infra/outbound/`

This matches the Stage 2H local verification shape recorded in [STAGE2H_REPORT.md](./STAGE2H_REPORT.md) so CI failures will line up with the baseline that closed Stage 2H.

## 3. Local Verification Commands And Results

All eight commands were exercised from the repo root on this branch prior to writing this report. Table style mirrors the Stage 2H verification table.

| Command | Exit | Notes |
| --- | ---: | --- |
| `pnpm install --frozen-lockfile` | 0 | Lockfile already up to date in this environment; install gate passed in the Stage 2H baseline run (see [STAGE2H_REPORT.md](./STAGE2H_REPORT.md)) with a benign pnpm update metadata DNS warning. |
| `pnpm exec tsc -p tsconfig.json` | 0 | Clean typecheck. |
| `pnpm build` | 0 | Build metadata/scripts completed. |
| `pnpm lint` | 0 | `oxlint` reported 0 warnings and 0 errors. |
| `pnpm vitest run src/telegram/ src/hooks/ src/goal/ src/repo-chat/ src/memory/` | 0 | 110 files passed, 1 skipped; 1354 tests passed, 8 skipped. |
| `pnpm vitest run src/auto-reply/` | 0 | 56 files passed; 475 tests passed. |
| `pnpm vitest run src/cli/` | 0 | 33 files passed; 195 tests passed. Passed cleanly on the first run — no rerun was required, unlike Stage 2H which reported an initial `gateway-cli.coverage.test.ts` timeout that cleared on rerun. |
| `pnpm vitest run src/infra/outbound/` | 0 | 11 files passed; 45 tests passed. |

CLI slice rerun observation: the Stage 2H report saw the first `pnpm vitest run src/cli/` invocation time out inside `src/cli/gateway-cli.coverage.test.ts` and pass on a targeted rerun. In this Stage 2I local run the full CLI slice passed on the first invocation, so the workflow does not need any retry/rerun affordance. If the same intermittent timeout reappears on the CI runner, the recommended response is to rerun the failed job rather than weaken the workflow.

A final `pnpm build` was executed after writing this report to confirm the report-only change did not regress the build gate.

## 4. README Badge Decision

No CI badge is added to `README.md` in this stage. The badge is intentionally deferred until the first remote GitHub Actions run of `verify` passes on this branch's commit, so the badge cannot link to a never-run or red workflow on first push. Once the workflow has a green run on the default branch, a follow-up change can add a standard `actions/workflows/ci.yml/badge.svg` shield to `README.md`.

## 5. Expected Differences Between Local Verification And Remote GitHub Actions

The local verification above ran in this branch's existing developer environment. The remote `verify` job will diverge from local in known, expected ways:

- **Fresh runner cache state.** GitHub Actions starts each job from a clean image. The first remote run will not have a populated pnpm content-addressable store, so `pnpm install --frozen-lockfile` will be slower than local. `actions/setup-node@v4` with `cache: 'pnpm'` populates and reuses the pnpm store cache keyed off `pnpm-lock.yaml` for later runs.
- **Absence of `MOLTBOT_STATE_DIR`.** Stage 2H recorded a default-state `goal list --json` write failure under `/home/matt/.clawdbot-dev` that was resolved by exporting `MOLTBOT_STATE_DIR` to a writable temp path. The CI workflow does not run any `node scripts/run-node.mjs goal …` command, so this environmental gap does not affect the configured steps. Future CI changes that exercise the goal CLI should set `MOLTBOT_STATE_DIR` to a job-scoped temp directory.
- **pnpm registry metadata fetch.** Stage 2H recorded a benign `ERR_PNPM_META_FETCH_FAIL ... getaddrinfo EAI_AGAIN registry.npmjs.org` warning emitted by the pnpm self-update notice during install. GitHub-hosted runners typically have working egress to `registry.npmjs.org`, so this specific warning is not expected on CI, but if it appears the install still completes — it is a notice, not a failure path.
- **Vitest worker counts under `CI=true`.** `vitest.config.ts` (`src` root) checks `process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true"` and pins `maxWorkers` to `ciWorkers = 3` on Linux (`2` on Windows). Locally on this developer machine the runner uses `localWorkers = max(4, min(16, os.cpus().length))`. Test files exercise the same code paths in both environments, but per-slice wall time will differ and any timing-sensitive flakes will surface under the lower CI worker count.

## 6. Recommendation

Ready for demo. All eight local verification commands exit `0` on this branch with the workflow file in place, and the post-write `pnpm build` confirmed the report-only change did not regress the build. Once the workflow runs green on GitHub, a follow-up change can add the CI badge to `README.md`.

## Cross-References

- [STAGE2H_REPORT.md](./STAGE2H_REPORT.md) — Stage 2H baseline that established the local verification shape this workflow mirrors.
- `.github/workflows/ci.yml` — workflow file added in this stage.
