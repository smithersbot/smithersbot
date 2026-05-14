# Secrets & PII Audit

## Secrets sweep: env files, credential-shaped strings, signing, and 1Password

Scope: this section covers `.env` / `*.env*`, common API key shapes (`sk-*`, `sk-ant-*`, `AKIA*`, `AIza*`, `ghp_*`, `xoxb-*`, `xoxp-*`, JWT `eyJ*`), 1Password vault references, bundle IDs, signing identities, and fastlane configuration. Stage 1 did not read `.env*` file contents; environment files were identified by path only.

### Environment files

| File | Evidence | What it looks like | Severity | Git history evidence | Recommended action |
| --- | --- | --- | --- | --- | --- |
| `.env` | `find` output: `./.env`; not listed by `git ls-files -- .env .env.example apps/ios/fastlane/.env.example` | Local untracked environment file; contents intentionally not inspected | blocker | `git log -n 3 -- .env` returned no commits | Remove from any public packaging path; confirm it is untracked before public release; do not commit |
| `.env.example` | `find` output: `./.env.example`; tracked by `git ls-files -- .env .env.example apps/ios/fastlane/.env.example` | Tracked env template; contents intentionally not inspected in Stage 1 | risk | `git log -n 3 -- .env.example` returned `16dfc1a5b 2025-11-24 Add warelay CLI with Twilio webhook support` | Review and rewrite to fake placeholders only before public release |
| `apps/ios/fastlane/.env.example` | `find` output: `./apps/ios/fastlane/.env.example`; tracked by `git ls-files -- .env .env.example apps/ios/fastlane/.env.example` | Tracked fastlane env template; contents intentionally not inspected in Stage 1 | risk | `git log -n 3 -- apps/ios/fastlane/.env.example` returned `10d95348b 2025-12-14 fix(ios): make fastlane beta lane work`, `322a36f36 2025-12-14 chore(fastlane): support p8 key path`, `a1d16c61e 2025-12-14 feat(ios): add fastlane setup` | Cut from Telegram-only v0 public pack or rewrite as generic placeholder docs |

### Credential-shaped matches

| File:line | Redacted snippet | What it looks like | Severity | Git history evidence | Recommended action |
| --- | --- | --- | --- | --- | --- |
| `src/commands/models/list.status.test.ts:10` | `sk-ant-XXXX...7890` | Fake Anthropic access token fixture in a test | nit | Not checked; fake test fixture | Keep only if clearly fake; consider shortening to non-key-shaped placeholder |
| `src/commands/models/list.status.test.ts:11` | `sk-ant-XXXX...7890` | Fake Anthropic refresh token fixture in a test | nit | Not checked; fake test fixture | Keep only if clearly fake; consider shortening to non-key-shaped placeholder |
| `src/commands/models/list.status.test.ts:18` | `sk-ant-XXXX...wxyz` | Fake Anthropic API key fixture in a test | nit | Not checked; fake test fixture | Keep only if clearly fake; consider shortening to non-key-shaped placeholder |
| `src/commands/models/list.status.test.ts:46` | `sk-openai-XXXX...wxyz` | Fake OpenAI API key fixture in a test | nit | Not checked; fake test fixture | Keep only if clearly fake; consider shortening to non-key-shaped placeholder |
| `src/gateway/ws-log.test.ts:22` | `sk-XXXX...3456` | Fake provider token fixture in websocket log redaction test | nit | Not checked; fake test fixture | Keep as redaction coverage or rewrite to obvious placeholder |
| `src/logging/redact.test.ts:9` | `sk-XXXX...cdef` | Fake OpenAI-style key in redaction test | nit | Not checked; fake test fixture | Keep as redaction coverage or rewrite to obvious placeholder |
| `src/slack/monitor/media.test.ts:31` and related lines | `xoxb-XXXX...oken` | Fake Slack bot token repeated in Slack media tests | nit | Not checked; fake test fixture | Keep as redaction/auth-header coverage or rewrite to obvious placeholder |
| `src/auto-reply/reply.triggers.trigger-handling.reports-active-auth-profile-key-snippet-status.e2e.test.ts:112` | `sk-test-XXXX...cdef` | Fake provider key fixture in e2e test | nit | Not checked; fake test fixture | Keep only if clearly fake |
| `src/cli/program.smoke.test.ts:152` | `sk-opencode-XXXX...test` | Fake auth key fixture in CLI smoke test | nit | Not checked; fake test fixture | Keep only if clearly fake |
| `src/commands/auth-choice.test.ts:239` | `sk-opencode-XXXX...test` | Fake auth key fixture in command test | nit | Not checked; fake test fixture | Keep only if clearly fake |

No `AKIA...`, `AIza...`, `ghp_...`, `xoxp-...`, or JWT `eyJ...` credential-shaped matches were found by the Stage 1 ripgrep sweep outside excluded sensitive paths and generated/vendor directories.

### 1Password references

| File:line | Redacted snippet | What it looks like | Severity | Git history evidence | Recommended action |
| --- | --- | --- | --- | --- | --- |
| `AGENTS.md:163` | `op://Private/Npmjs/...` | Private 1Password vault item path for npm OTP workflow | risk | Not checked; operational instruction is repo guidance | Rewrite for public docs; move private publish procedure out of the public repository |
| `skills/1password/references/cli-examples.md:10` | `op://app-prod/db/password` | Example 1Password item path | nit | Not checked; appears illustrative | Keep only if this skill is excluded from v0 or rewrite to clearly fake placeholders |
| `skills/1password/references/cli-examples.md:11` | `op://app-prod/db/...otp` | Example 1Password OTP path | nit | Not checked; appears illustrative | Keep only if this skill is excluded from v0 or rewrite to clearly fake placeholders |
| `skills/1password/references/cli-examples.md:12` | `op://app-prod/ssh...` | Example 1Password SSH key path | nit | Not checked; appears illustrative | Keep only if this skill is excluded from v0 or rewrite to clearly fake placeholders |
| `skills/1password/references/cli-examples.md:13` | `op://app-prod/server/...` | Example output-file command with key material path | nit | Not checked; appears illustrative | Keep only if this skill is excluded from v0 or rewrite to clearly fake placeholders |
| `skills/1password/references/cli-examples.md:17` | `op://app-prod/db/password` | Example env-var secret reference | nit | Not checked; appears illustrative | Keep only if this skill is excluded from v0 or rewrite to clearly fake placeholders |
| `skills/1password/references/cli-examples.md:23` | `op://app-prod/db/password` | Example template injection reference | nit | Not checked; appears illustrative | Keep only if this skill is excluded from v0 or rewrite to clearly fake placeholders |

### Bundle IDs, signing identities, and fastlane

| File:line | Redacted snippet | What it looks like | Severity | Git history evidence | Recommended action |
| --- | --- | --- | --- | --- | --- |
| `src/daemon/constants.ts:14` | `com.clawdbot.gateway` | Legacy launchd bundle/label naming exposed in source | risk | Not checked | Rewrite to Moltbot naming or cut legacy migration code from public v0 if not needed |
| `src/daemon/constants.ts:15` | `com.steipete.clawdbot.gateway` | Personal legacy launchd label in source | risk | Not checked | Rewrite/cut for public v0; confirm migration requirement |
| `src/commands/doctor.migrates-routing-allowfrom-channels-whatsapp-allowfrom.test.ts:392` | `com.steipete.clawdbot.gateway` | Personal legacy label in test fixture | risk | Not checked | Rewrite test fixture unless needed for explicit migration coverage |
| `apps/macos/Sources/Moltbot/LaunchAgentManager.swift:5` | `com.steipete.clawdbot` | Personal legacy launch agent prefix in macOS app | risk | Not checked | Cut macOS app from Telegram-only v0 pack or rewrite legacy identifiers |
| `apps/macos/Sources/Moltbot/LaunchAgentManager.swift:6` | `com.clawdbot.mac` | Legacy launch agent prefix in macOS app | risk | Not checked | Cut macOS app from Telegram-only v0 pack or rewrite legacy identifiers |
| `apps/ios/Sources/Gateway/GatewaySettingsStore.swift:5` | `com.clawdbot.gateway` | Legacy gateway service identifier in iOS app | risk | Not checked | Cut iOS app from Telegram-only v0 pack or rewrite legacy identifiers |
| `apps/ios/Sources/Gateway/GatewaySettingsStore.swift:6` | `com.clawdbot.bridge` | Legacy bridge service identifier in iOS app | risk | Not checked | Cut iOS app from Telegram-only v0 pack or rewrite legacy identifiers |
| `apps/ios/Sources/Gateway/GatewaySettingsStore.swift:8` | `com.clawdbot.node` | Legacy node service identifier in iOS app | risk | Not checked | Cut iOS app from Telegram-only v0 pack or rewrite legacy identifiers |
| `apps/shared/MoltbotKit/Sources/MoltbotKit/InstanceIdentity.swift:9` | `com.clawdbot.shared` | Legacy shared app group/suite name | risk | Not checked | Cut mobile/shared app code from Telegram-only v0 pack or rewrite identifiers |
| `apps/shared/MoltbotKit/Sources/MoltbotKit/GatewayTLSPinning.swift:21` | `com.clawdbot.shared` | Legacy shared app group/suite name | risk | Not checked | Cut mobile/shared app code from Telegram-only v0 pack or rewrite identifiers |
| `apps/ios/project.yml:71` | `Apple Development` | Signing identity setting for iOS project | risk | Not checked | Cut iOS app from v0 or replace with generic signing docs |
| `apps/ios/fastlane/Fastfile:72` | `IOS_DEVELOPMENT_TEAM` | Fastlane release/upload configuration requiring Apple team credentials | risk | Not checked | Cut fastlane from Telegram-only v0 pack |
| `apps/ios/fastlane/SETUP.md:14` | `apps/ios/fastlane/.env` | Instructions to create a local fastlane env file | risk | Not checked | Cut fastlane docs from Telegram-only v0 pack or rewrite as generic contributor-only docs |
| `scripts/codesign-mac-app.sh:18` | `Apple Development: Your Name (TEAMID)` | Placeholder signing identity in script | nit | Not checked | Keep only if macOS app is excluded; otherwise move to private release docs |
| `docs/platforms/mac/signing.md:16` | `Apple Development: Your Name (TEAMID)` | Placeholder signing identity in docs | nit | Not checked | Cut macOS docs from Telegram-only v0 pack or keep as generic docs |
| `docs/platforms/mac/xpc.md:40` | `Apple Development: <Developer Name> (<TEAMID>)` | Placeholder signing identity in docs | nit | Not checked | Cut macOS docs from Telegram-only v0 pack or keep as generic docs |

### Open questions for operator

Open question for operator: Is the untracked `.env` expected local state, and can it be deleted or moved before packaging a public release?

Open question for operator: Should Stage 2 preserve legacy `com.clawdbot` / `com.steipete.clawdbot` migration identifiers in code, or remove them because public v0 only ships Telegram?
