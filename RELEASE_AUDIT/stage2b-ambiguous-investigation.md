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
