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

## Channel Extensions

Twelve candidate channel-plugin extensions investigated. For each, evidence
gathered from four grep sweeps: (a) `extensions/<name>` relative imports
in `src/`; (b) plugin-id string literal; (c) channel-id string literal
across `src/infra/outbound/*`, `src/gateway/*`, `src/channels/*`,
`src/config/*`; (d) test-fixture references. Plugin-id == channel-id for
every candidate (verified in each `extensions/<name>/clawdbot.plugin.json`).

Decision rule:
- Zero refs → **CUT**.
- Any non-test src/ reference (infra/outbound, gateway, channels, config,
  utils, security, auto-reply, agents, commands) → **DEFER** to Stage 2C
  (cutting requires src/* edits out of Stage 2B scope).
- Only test-fixture references → recorded explicitly; default to **DEFER**
  when the fixture asserts behavior on the channel id.

| Extension | Plugin-ID / Channel-ID | `extensions/<name>` imports in src/ | Non-test src/ references (runtime coupling) | Test-only src/ references | Other (`package.json`, `scripts/`, `.github/`) | Decision | Reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| bluebubbles | `bluebubbles` | none | `src/agents/tools/message-tool.ts:275` (`channel !== "bluebubbles"`); `src/channels/plugins/status-issues/bluebubbles.ts:63,80,91`; `src/channels/plugins/group-mentions.ts:226,364`; `src/infra/outbound/outbound-session.ts:554,576,809` (stripProviderPrefix + channel literal + `case "bluebubbles"`); `src/infra/outbound/target-resolver.ts:140,311,378` | `src/agents/tools/message-tool.test.ts:112,114,148,153`; `src/auto-reply/chunk.test.ts:368`; `src/config/schema.test.ts:92,101,103`; `src/config/plugin-auto-enable.test.ts:121`; `src/config/config.plugin-validation.test.ts:161,168`; `src/gateway/test-helpers.mocks.ts:133,135`; `src/infra/outbound/outbound-session.test.ts:74`; `src/infra/outbound/message-action-runner.test.ts:366,368,398,432` | `.github/labeler.yml:4` (label rule) | **DEFER** | Heavy runtime coupling: dedicated `src/channels/plugins/status-issues/bluebubbles.ts` module, special-cased in `target-resolver.ts` alongside iMessage, branched on in `message-tool.ts`, registered in outbound-session switch. Cutting requires src/* edits out of Stage 2B scope. |
| googlechat | `googlechat` | none | `src/channels/dock.ts:217`; `src/channels/registry.ts:11,62-67,105-106` (declared in `BUILTIN_CHANNEL_IDS` array, registry entry with `docsPath`/`docsLabel`, normalization aliases `google-chat`/`gchat`); `src/channels/plugins/group-mentions.ts:169,180`; `src/config/types.hooks.ts:28`; `src/utils/message-channel.ts:25` | `src/channels/registry.test.ts:12-13,24` | `.github/labeler.yml:15` | **DEFER** | Declared as a built-in channel in `src/channels/registry.ts` (in `BUILTIN_CHANNEL_IDS`, full registry entry, plus two normalization aliases) and referenced in `src/config/types.hooks.ts` channel union. Cutting requires src/* edits out of Stage 2B scope. |
| line | `line` | none | `src/line/bot-message-context.ts:150,161,287,324,335,437`; `src/line/send.ts:147,169,215,257,312,360,413,454,498`; `src/line/bot-handlers.ts:87,100,133`; `src/line/monitor.ts:141,163,235,277,352` (entire `src/line/` source-channel directory uses `channel: "line"`, `pluginId: "line"`, `readChannelAllowFromStore("line")`) | none for the channel-id literal beyond `src/line/` itself; note unrelated CLI/text-context hits in `src/cli/memory-cli.ts:265,556` and `src/cli/progress.ts:20,55` are display-fallback strings, not the channel id, and `src/imessage/client.ts:74` is a stream-reader event name | `.github/labeler.yml:26` | **DEFER** | Channel-id literal pervasive throughout `src/line/` source-channel directory (handlers, send, monitor, message context). `src/line/` is explicitly out of Stage 2B scope per the goal ("Do not delete source-channel directories like ... src/line"); cleanup of both extension and src/line/ is a Stage 2C task. |
| matrix | `matrix` | none | `src/infra/outbound/outbound-session.ts:453,462,803` (stripProviderPrefix + channel literal + `case "matrix"`) | `src/config/schema.test.ts:56`; `src/gateway/test-helpers.mocks.ts:118,120`; `src/infra/outbound/deliver.test.ts:203,208,215,218,239` | `.github/labeler.yml:31` | **DEFER** | Runtime coupling in `src/infra/outbound/outbound-session.ts` outbound dispatch (dedicated branch + switch case). Cutting requires src/* edits out of Stage 2B scope. |
| mattermost | `mattermost` | none | `src/infra/outbound/outbound-session.ts:531,807` (channel literal + `case "mattermost"`) | none in the strict-channel-id sense beyond outbound dispatch | `.github/labeler.yml:36` | **DEFER** | Runtime coupling in outbound-session dispatch switch. Cutting requires src/* edits out of Stage 2B scope. |
| msteams | `msteams` | none | `src/utils/message-channel.ts:24-26` (alias `"teams" → "msteams"`); `src/security/fix.ts:276`; `src/config/zod-schema.hooks.ts:29` (`z.literal("msteams")`); `src/config/legacy.rules.ts:29` (legacy path rule key); `src/config/legacy.migrations.part-1.ts:129`; `src/config/types.hooks.ts:32`; `src/infra/outbound/outbound-session.ts:496,805`; `src/commands/channels/capabilities.ts:187` (`if (channelId === "msteams")`) | `src/utils/message-channel.test.ts:24,26,58,60`; `src/agents/pi-embedded-runner.get-dm-history-limit-from-session-key...test.ts:172,191`; `src/auto-reply/reply/route-reply.test.ts:85,89,94,96,335,352,447`; `src/channels/plugins/catalog.test.ts:10,17`; `src/channels/plugins/load.test.ts:26,27,31,33,49,63,69`; `src/commands/channels/capabilities.test.ts:116,129`; `src/config/channel-capabilities.test.ts:91,104,165,167`; `src/gateway/hooks.test.ts:115,127,138,140`; `src/gateway/server.agent.gateway-server-agent-b.e2e.test.ts:89,91,133,147,163,173,217`; `src/gateway/test-helpers.mocks.ts:113,115`; `src/infra/outbound/message.test.ts:38,56,101,122-123,137,145,150,159,161` | `.github/labeler.yml:41` | **DEFER** | Heaviest runtime coupling among the twelve: declared as a `z.literal` in config hooks schema, name-normalization alias in `src/utils/message-channel.ts`, capability-specific branch in `src/commands/channels/capabilities.ts`, legacy-config migration rule, hooks channel union, plus outbound-session dispatch. Cutting requires src/* edits out of Stage 2B scope. |
| nextcloud-talk | `nextcloud-talk` | none | `src/infra/outbound/outbound-session.ts:602,811` (channel literal + `case "nextcloud-talk"`) | `src/agents/pi-embedded-runner.get-dm-history-limit-from-session-key...test.ts:173,192` (channel-list fixture asserting DM history limit defaults) | `.github/labeler.yml:46` | **DEFER** | Runtime coupling in outbound-session dispatch switch and asserted in pi-embedded-runner DM-history channel-list fixture. Cutting requires src/* edits out of Stage 2B scope. |
| nostr | `nostr` | none | `src/infra/outbound/outbound-session.ts:674,680,817` (stripProviderPrefix + channel literal + `case "nostr"`) | none | `.github/labeler.yml:51` | **DEFER** | Runtime coupling in outbound-session dispatch (target-resolver branch + switch). Cutting requires src/* edits out of Stage 2B scope. |
| tlon | `tlon` | none | `src/infra/outbound/outbound-session.ts:703,739,819` (stripProviderPrefix + channel literal + `case "tlon"`) | none | `.github/labeler.yml:74` | **DEFER** | Runtime coupling in outbound-session dispatch (target-resolver branch + switch). Cutting requires src/* edits out of Stage 2B scope. |
| twitch | `twitch` | none | none | none | none in `.github/labeler.yml` (no entry); none in `package.json`; none in `scripts/`. Only refs are `docs/channels/twitch.md:23` (`moltbot plugins install ./extensions/twitch`) and `extensions/twitch/README.md:8` (self) plus historical `RELEASE_AUDIT/*` rows. | **CUT** | Zero src/ references of any kind (no import, no plugin-id literal, no channel-id literal, no test fixture). Not declared in `BUILTIN_CHANNEL_IDS`, not dispatched in `outbound-session.ts`, not labeled in `.github/labeler.yml`. Only post-deletion follow-up: `docs/channels/twitch.md` install snippet (handled by `fix-tiny-broken-refs`). |
| zalo | `zalo` | `src/commands/onboarding/plugin-install.test.ts:38,99,179` — test fixture that uses the literal path `"extensions/zalo"` as a `localPath` for the install-flow harness | `src/infra/outbound/outbound-session.ts:619,629,813` (stripProviderPrefix + channel literal + `case "zalo"`) | `src/cli/pairing-cli.test.ts:111,113-114` (`pairing list zalo` flow); `src/commands/onboarding/plugin-install.test.ts:27,29,33,56,70,99,179` (asserts the onboarding install flow resolves `extensions/zalo` and adds it to `cfg.plugins.allow`); `src/gateway/test-helpers.mocks.ts:123,125` | `.github/labeler.yml:89` | **DEFER** | Runtime coupling in outbound-session dispatch plus a load-bearing onboarding test (`src/commands/onboarding/plugin-install.test.ts`) that asserts behavior using the literal path `"extensions/zalo"` and the `"zalo"` plugin id — deleting the directory would break that test. Cutting requires src/* edits out of Stage 2B scope. |
| zalouser | `zalouser` | none | `src/infra/outbound/outbound-session.ts:646,657,815` (stripProviderPrefix + channel literal + `case "zalouser"`) | `src/gateway/test-helpers.mocks.ts:128,130`; `src/infra/outbound/outbound-session.test.ts:87` | `.github/labeler.yml:94` | **DEFER** | Runtime coupling in outbound-session dispatch (separate branch from `zalo`) plus outbound-session test asserts the channel id. Cutting requires src/* edits out of Stage 2B scope. |

### Summary

Of the twelve channel extensions investigated:

- **CUT** (zero src/ refs): `twitch`. Only `docs/channels/twitch.md:23` and `extensions/twitch/README.md:8` reference the extension path; no source coupling, not declared in `BUILTIN_CHANNEL_IDS`, not dispatched in `outbound-session.ts`, not labeled in `.github/labeler.yml`.
- **DEFER to Stage 2C** (non-test src/ runtime coupling): `bluebubbles`, `googlechat`, `line`, `matrix`, `mattermost`, `msteams`, `nextcloud-talk`, `nostr`, `tlon`, `zalo`, `zalouser`. All have channel-id literals dispatched from `src/infra/outbound/outbound-session.ts` (`case "<id>"`) and/or referenced in registry/config/utils/security modules; cutting requires the matching src/* edits which are out of Stage 2B scope. `line` additionally has its full source-channel directory under `src/line/` which is explicitly out of Stage 2B scope per the goal text.

This matches the plan's expected DEFER channel set (`discord`, `imessage`, `signal`, `slack`, `voice-call`, `whatsapp` already enumerated by the goal as coupled-channel extensions) plus the eleven additional channels DEFERed here from non-test src/ evidence.

### Stage 2B follow-up for the CUT entry

When the `prune-channel-extensions` step deletes `extensions/twitch`:

- `.github/labeler.yml`: no entry to trim (none exists for twitch).
- `docs/channels/twitch.md`: remove or rewrite the install snippet `moltbot plugins install ./extensions/twitch` (handled by `fix-tiny-broken-refs`); consider whether the entire doc page should be deleted in the same step.

### Stage 2C cleanup checklist for the DEFER channels

When Stage 2C is ready to drop these channel extensions, the following src/* surfaces will need edits (non-exhaustive, derived from the evidence above):

- `src/infra/outbound/outbound-session.ts` per-channel branches (`case "bluebubbles" | "matrix" | "mattermost" | "msteams" | "nextcloud-talk" | "nostr" | "tlon" | "zalo" | "zalouser"`) and their `stripProviderPrefix` helpers.
- `src/channels/registry.ts` `BUILTIN_CHANNEL_IDS` + `googlechat` registry entry + normalization aliases.
- `src/channels/dock.ts` `googlechat` entry.
- `src/channels/plugins/group-mentions.ts` `bluebubbles` and `googlechat` branches.
- `src/channels/plugins/status-issues/bluebubbles.ts` (entire module).
- `src/agents/tools/message-tool.ts` `bluebubbles` branch.
- `src/infra/outbound/target-resolver.ts` `bluebubbles | imessage` numeric-target branches.
- `src/commands/channels/capabilities.ts` `msteams` branch.
- `src/utils/message-channel.ts` `googlechat`, `msteams` (incl. `teams` alias).
- `src/security/fix.ts` `msteams` entry.
- `src/config/zod-schema.hooks.ts`, `src/config/legacy.rules.ts`, `src/config/legacy.migrations.part-1.ts`, `src/config/types.hooks.ts` `msteams`/`googlechat` literals.
- `src/line/` (entire source-channel directory — Stage 2C source-channel cleanup).
- Matching `*.test.ts` updates across `src/agents/`, `src/auto-reply/`, `src/channels/`, `src/cli/`, `src/commands/`, `src/config/`, `src/gateway/`, `src/infra/outbound/`, `src/utils/`.
