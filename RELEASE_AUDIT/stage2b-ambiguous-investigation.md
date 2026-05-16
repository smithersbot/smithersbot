# Stage 2B — Ambiguous Extension Investigation

Decisions for Stage-1 `investigate` extensions. Evidence is collected from grep
sweeps over `src/` (including tests), `package.json`, `scripts/`, `.github/`.

Decision rule:
- Zero non-test src/ references → **CUT** (safe to delete in Stage 2B).
- Any non-test src/ reference (runtime/load-bearing) → **DEFER** to Stage 2C
  (cutting requires src/* edits which are out of Stage 2B scope).
- Only test-fixture references → recorded explicitly and decided case-by-case.

## Provider / Auth Extensions

| Extension | Plugin ID (clawdbot.plugin.json) | Provider ID | Relative imports `extensions/<name>` | Plugin-ID literal hits in src/ | Provider-ID literal hits in src/ | Decision | Reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| copilot-proxy | `copilot-proxy` | `copilot-proxy` | none in src/ (only `.secrets.baseline:857,860` and `.github/labeler.yml:186`) | `src/config/plugin-auto-enable.ts:35` (PROVIDER_PLUGIN_IDS entry); `src/commands/auth-choice.apply.ts:6` (imports `./auth-choice.apply.copilot-proxy.js`); `src/commands/auth-choice.apply.copilot-proxy.ts:8-10` (authChoice/pluginId/providerId triple); `src/commands/auth-choice-options.ts:85,180`; `src/commands/auth-choice.preferred-provider.ts:25`; `src/commands/onboard-types.ts:33` | same as plugin-ID column (id == provider here) | **DEFER** | Heavy runtime coupling: registered in `PROVIDER_PLUGIN_IDS`, dispatched from `auth-choice.apply.ts` via a dedicated `auth-choice.apply.copilot-proxy.ts`, listed in onboarding choices and preferred-provider map. Cutting requires src/* edits which are out of Stage 2B scope. |
| google-antigravity-auth | `google-antigravity-auth` | `google-antigravity` | none in src/ (only `.secrets.baseline:866,869`, `RELEASE_AUDIT/*`, `.github/labeler.yml:194`) | `src/config/plugin-auto-enable.ts:32`; `src/config/plugin-auto-enable.test.ts:47`; `src/commands/auth-choice.apply.ts:8`; `src/commands/auth-choice.apply.google-antigravity.ts:9` | `src/commands/auth-choice.apply.google-antigravity.ts:8,10`; `src/commands/auth-choice.preferred-provider.ts:18`; `src/commands/auth-choice-options.ts:79,164`; `src/commands/onboard-types.ts:23`; `src/agents/live-model-filter.ts:53`; `src/agents/pi-embedded-runner/google.ts:152,167`; `src/agents/pi-embedded-helpers/google.ts:5,16`; `src/agents/auth-profiles/oauth.ts:15`; `src/utils/provider-utils.ts:23-24`; `src/infra/provider-usage.types.ts:24`; `src/infra/provider-usage.fetch.antigravity.ts:212-273`; `src/infra/provider-usage.shared.ts:10,21`; `src/infra/provider-usage.auth.ts:160,189`; `src/infra/provider-usage.load.ts:61`; plus tests under `src/agents/`, `src/auto-reply/`, `src/config/`, `src/infra/`, `src/commands/` | **DEFER** | Pervasive runtime coupling: plugin auto-enable, auth-choice dispatch, onboarding type union, model selection, provider usage fetcher/auth/shared, embedded runner branching. Cutting requires src/* edits out of Stage 2B scope. |
| google-gemini-cli-auth | `google-gemini-cli-auth` | `google-gemini-cli` | none in src/ (only `RELEASE_AUDIT/*`, `.github/labeler.yml:198`) | `src/config/plugin-auto-enable.ts:33`; `src/commands/auth-choice.apply.ts:9`; `src/commands/auth-choice.apply.google-gemini-cli.ts:9` | `src/commands/auth-choice.apply.google-gemini-cli.ts:8,10`; `src/commands/auth-choice.preferred-provider.ts:19`; `src/commands/auth-choice-options.ts:79,169`; `src/commands/onboard-types.ts:24`; `src/agents/live-model-filter.ts:49`; `src/agents/pi-embedded-runner/google.ts:152,167`; `src/agents/pi-embedded-helpers/google.ts:5`; `src/agents/auth-profiles/oauth.ts:15`; `src/utils/provider-utils.ts:17`; `src/infra/provider-usage.types.ts:23`; `src/infra/provider-usage.shared.ts:9,20`; `src/infra/provider-usage.auth.ts:160,188`; `src/infra/provider-usage.load.ts:63`; plus tests under `src/agents/`, `src/providers/` | **DEFER** | Pervasive runtime coupling: plugin auto-enable, auth-choice dispatch, onboarding type union, OAuth profile branching, model API switch in embedded runner, provider usage stack. Cutting requires src/* edits out of Stage 2B scope. |
| qwen-portal-auth | `qwen-portal-auth` | `qwen-portal` | none in src/ (only `RELEASE_AUDIT/*`, `.github/labeler.yml:222`) | `src/config/plugin-auto-enable.ts:34`; `src/commands/auth-choice.apply.ts:13`; `src/commands/auth-choice.apply.qwen-portal.ts:9` | `src/commands/auth-choice.apply.qwen-portal.ts:8,10`; `src/commands/auth-choice.preferred-provider.ts:31`; `src/commands/auth-choice-options.ts:61,178`; `src/commands/onboard-types.ts:34`; `src/commands/onboard-non-interactive/local/auth-choice.ts:383`; `src/providers/qwen-portal-oauth.ts:32`; `src/agents/auth-profiles/oauth.ts:6,60`; `src/agents/auth-profiles/external-cli-sync.ts:28,48,58`; `src/agents/auth-profiles/constants.ts:9`; `src/agents/models-config.providers.ts:435,437`; `src/agents/model-selection.ts:31`; `src/agents/model-auth.ts:268`; `src/agents/cli-credentials.ts:63,182`; plus tests under `src/agents/`, `src/providers/`, `src/commands/` | **DEFER** | Pervasive runtime coupling: plugin auto-enable, auth-choice dispatch, dedicated provider OAuth refresh in `src/providers/qwen-portal-oauth.ts`, CLI-credentials sync, model-selection normalization, auth-profile constants. Cutting requires src/* edits out of Stage 2B scope. |

### Summary

All four provider/auth extensions are **DEFER to Stage 2C**. None has a relative
`extensions/<name>` import from src/, but every one is referenced by plugin-id
or provider-id literals in src/ runtime modules (notably
`src/config/plugin-auto-enable.ts` `PROVIDER_PLUGIN_IDS` and the
`src/commands/auth-choice.apply.*` dispatch chain). Stage 2C must remove the
matching src/* entries before deleting the extension directories.

### Stage 2C cleanup checklist for these extensions

When Stage 2C is ready to drop these, the following src/* surfaces will need
edits (non-exhaustive, derived from the evidence above):

- `src/config/plugin-auto-enable.ts` `PROVIDER_PLUGIN_IDS` entries.
- `src/commands/auth-choice.apply.ts` imports + dispatch.
- `src/commands/auth-choice.apply.{copilot-proxy,google-antigravity,google-gemini-cli,qwen-portal}.ts` files.
- `src/commands/auth-choice.preferred-provider.ts` map entries.
- `src/commands/auth-choice-options.ts` choice/option entries.
- `src/commands/onboard-types.ts` union members.
- `src/commands/onboard-non-interactive/local/auth-choice.ts` qwen branch.
- `src/agents/auth-profiles/oauth.ts`, `external-cli-sync.ts`, `constants.ts`.
- `src/agents/model-selection.ts`, `model-auth.ts`, `cli-credentials.ts`, `models-config.providers.ts`.
- `src/agents/pi-embedded-runner/google.ts`, `pi-embedded-helpers/google.ts`, `live-model-filter.ts`.
- `src/providers/qwen-portal-oauth.ts` (+ `qwen-portal-oauth.test.ts`).
- `src/infra/provider-usage.*` stack (types, fetch, shared, auth, load) for google-antigravity / google-gemini-cli.
- `src/utils/provider-utils.ts` normalization.
- Matching `*.test.ts` updates.

## Non-Channel Extensions

| Extension | Plugin ID (clawdbot.plugin.json) | Relative imports `extensions/<name>` | Plugin-ID literal hits in src/ | package.json / scripts / .github hits | Decision | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| diagnostics-otel | `diagnostics-otel` | none in src/ | none | `.github/labeler.yml:187,190` (label rule); none in `package.json`; none in `scripts/` | **CUT** | Zero src/ references. Safe to delete in Stage 2B; only `.github/labeler.yml` label rule needs trimming. |
| llm-task | `llm-task` | none in src/ | none | `.github/labeler.yml:199,202` (label rule); none in `package.json`; none in `scripts/` | **CUT** | Zero src/ references. Safe to delete in Stage 2B; only `.github/labeler.yml` label rule needs trimming. |
| lobster | `lobster` | none in src/ | `src/agents/tool-policy.plugin-only-allowlist.test.ts:6-7,13,26,30,36,38,44,48-49` (test uses `"lobster"` as synthetic plugin id inside an inline `PluginToolGroups` fixture); `src/config/config.tools-alsoAllow.test.ts:12,30,47` (test uses `"lobster"` as an `alsoAllow` token in a synthetic config). Unrelated false-positive hits: `src/agents/session-slug.ts:73` (slug wordlist), `src/config/ui-seam-color.test.ts:12` (uses `"lobster"` as a non-hex string to assert rejection). | `.github/labeler.yml:203,206` (label rule); none in `package.json`; none in `scripts/` | **CUT** (test-fixture refs only, no fixture trim required) | All `"lobster"` plugin-id references in src/ are inside tests that construct synthetic plugin/tool groups inline; nothing loads the real `extensions/lobster/` directory. Tests will pass unchanged after the extension is deleted, so no test edit is strictly required. `.github/labeler.yml` label rule needs trimming. |
| memory-core | `memory-core` | none in src/ | Runtime (non-test) hits: `src/plugins/slots.ts:17` (default `memory` slot = `"memory-core"`); `src/plugins/config-state.ts:71` (`plugins.entries["memory-core"]` lookup); `src/commands/status.scan.ts:35,152` (default slot value + branch); `src/gateway/tools-invoke-http.ts:138` (user guidance string). Test hits: `src/plugins/config-state.test.ts:8,43,50`; `src/plugins/loader.test.ts:150-208` (multiple); `src/plugins/slots.test.ts:10,12,24,32,34,36,79`; `src/plugins/cli.test.ts:13`; `src/commands/status.test.ts:294`. | `scripts/e2e/Dockerfile:17` (`COPY extensions/memory-core`); `.github/labeler.yml:207,210`; none in `package.json` | **KEEP** | Pervasive non-test runtime coupling: declared as the default `memory` slot in `src/plugins/slots.ts`, branched on in `src/commands/status.scan.ts`, and named in gateway guidance. E2E Docker image also copies it explicitly. Required for v0 memory functionality. |
| memory-lancedb | `memory-lancedb` | none in src/ | none | `.github/labeler.yml:211,214` (label rule); none in `package.json`; none in `scripts/`. `.secrets.baseline:909-921` references the extension's own files (not a runtime coupling). | **CUT** | Zero src/ references. Heavy native-deps optional backend, no runtime coupling. Safe to delete in Stage 2B; `.github/labeler.yml` label rule and `.secrets.baseline` entries for the deleted files need trimming. |
| open-prose | `open-prose` | none in src/ | `src/agents/skills.loadworkspaceskillentries.test.ts:47,54,72,86,93` — test creates a synthetic plugin under a tmpdir (`<tmp>/.clawdbot/extensions/open-prose`) with its own `moltbot.plugin.json` and skills, then asserts that an enabled plugin's skills load. The real `extensions/open-prose/` directory is not read by this test. | `.github/labeler.yml:215,218` (label rule); `docs/prose.md:30` (docs reference `./extensions/open-prose`); none in `package.json`; none in `scripts/` | **CUT** (test-fixture refs only, no fixture trim required) | All src/ references are synthetic fixture strings in a single test that manufactures the plugin layout under a tmpdir; nothing loads the real extension. Tests will pass unchanged after deletion. `.github/labeler.yml` label rule needs trimming; `docs/prose.md` is a downstream doc to address in the tiny-broken-refs step. |

### Summary

Of the six non-channel extensions investigated:

- **KEEP**: `memory-core` (default memory slot, branched on across `src/plugins/slots.ts`, `src/plugins/config-state.ts`, `src/commands/status.scan.ts`, `src/gateway/tools-invoke-http.ts`, plus `scripts/e2e/Dockerfile`).
- **CUT** (zero src/ refs): `diagnostics-otel`, `llm-task`, `memory-lancedb`.
- **CUT** (test-fixture refs only, no fixture trim required): `lobster`, `open-prose`. Both have plugin-id literal hits only inside tests that construct synthetic plugin fixtures inline / under tmpdirs; deleting the real extension dirs leaves the tests valid.

### Stage 2B follow-up for these cuts

When the `prune-non-channel-extensions` step deletes the five CUT extensions, the following ancillary edits must be made in later Stage 2B steps:

- `.github/labeler.yml`: drop the `extensions: diagnostics-otel | llm-task | lobster | memory-lancedb | open-prose` label rules (handled by `trim-github-configs`).
- `.secrets.baseline`: drop entries pointing at deleted extension files (e.g. `extensions/memory-lancedb/config.ts`, `extensions/memory-lancedb/index.test.ts`, `extensions/open-prose/skills/prose/SKILL.md`, `extensions/open-prose/skills/prose/state/postgres.md`).
- `docs/prose.md`: remove or rewrite the install reference `moltbot plugins install ./extensions/open-prose` (handled by `fix-tiny-broken-refs`).
- Note: `scripts/e2e/Dockerfile:17` `COPY extensions/memory-core ./extensions/memory-core` is for the KEPT extension and must remain.
