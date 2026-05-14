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

## PII and personal-data sweep

Scope: this section covers real-looking NANP `+1` phone numbers outside reserved fictional ranges, real-looking emails outside `example.com` / `example.org` / test domains, hardcoded `/home/<user>/` and `/Users/<user>/` paths, private hostnames / SSH targets, and personal handles in code, comments, and operator docs. Stage 1 did not inspect denied sensitive files such as `.env*`, key files, credential files, or `moltbot.json`.

### Blockers

| File:line | What it looks like | Severity | Git history evidence | Recommended action |
| --- | --- | --- | --- | --- |
| `scripts/clawtributors-map.json:34-37` | Personal email-to-GitHub mapping containing redacted Gmail addresses such as `s***@gmail.com` and `h***@gmail.com` | blocker | Not checked; this is an attribution helper with current-file PII evidence | Remove personal email mappings from public pack or replace with non-email contributor IDs |
| `SECURITY.md:7` | Security contact uses a personal Gmail address, redacted as `s***@gmail.com` | blocker | Not checked; public security contact must be project-owned | Replace with project-owned security contact before public release |

### Risks

| File:line | What it looks like | Severity | Git history evidence | Recommended action |
| --- | --- | --- | --- | --- |
| `AGENTS.md:28-30` and `CLAUDE.md:28-30` | Private exe.dev VM operations and `ssh exe.dev` target | risk | Not checked; repo-local operator guidance | Move private VM operations to private docs or rewrite as generic provider guidance |
| `AGENTS.md:115` and `CLAUDE.md:115` | Private Fly app / SSH target command naming `flawd-bot` | risk | Not checked; repo-local operator guidance | Remove private deployment target from public repo |
| `scripts/termux-sync-widget.sh:9` | Hardcoded SSH target plus absolute path `/home/admin/moltbot/...` | risk | Not checked; script contains private host/path assumptions | Cut from Telegram-only v0 public pack or rewrite with placeholders |
| `scripts/auth-monitor.sh:6` and `scripts/systemd/clawdbot-auth-monitor.service:7` | Hardcoded `/home/admin/moltbot/scripts/auth-monitor.sh` path | risk | Not checked; private ops path | Rewrite to generic install path or remove from public pack |
| `apps/macos/Tests/MoltbotIPCTests/WideAreaGatewayDiscoveryTests.swift:31,47` | Internal Tailscale hostname and personal path `/Users/s***e/moltbot/src/entry.ts` | risk | Not checked; app code is out of v0 but public pack would expose private host/path fixtures | Cut macOS app/tests from v0 pack or rewrite fixtures |
| `src/commands/health-format.test.ts:23,33` | Personal config path `/Users/s***e/.clawdbot-dev/moltbot.json` | risk | Not checked; test fixture exposes private username and state path | Rewrite fixture to `/Users/user/...` or remove with out-of-v0 tests |
| `src/commands/doctor.warns-per-agent-sandbox-docker-browser-prune.test.ts:398,405,407,410` | Personal workspace paths under `/Users/s***e/...` | risk | Not checked; test fixture exposes private username/workspace | Rewrite fixture to generic username |
| `src/commands/gateway-status.test.ts:207,228,246,254,272` | Personal SSH user and internal Tailscale hostname `s***e@peters-mac-studio-1.sheep-coho.ts.net` | risk | Not checked; test fixture exposes private user/host | Rewrite fixture to generic `user@gateway-host.tailnet.ts.net` |
| `src/infra/ssh-config.test.ts:21,22,53,54` | Personal SSH user and internal Tailscale hostname `s***e@peters-mac-studio-1.sheep-coho.ts.net` | risk | Not checked; test fixture exposes private user/host | Rewrite fixture to generic user/host |
| `apps/macos/Sources/Moltbot/AboutSettings.swift:53-55,80` | Personal website, social handle, email, and copyright attribution | risk | Not checked; macOS app is out of v0 but public pack would expose personal contact surfaces | Cut macOS app from v0 pack or replace with project-owned contacts |
| `docs/index.md:225,232` | Personal maintainer handle and a contributor Gmail address, redacted as `n***@gmail.com` | risk | Not checked; public docs attribution surface | Rewrite public docs attribution and remove direct personal email |
| `docs/platforms/mac/logging.md:23` | Personal blog attribution to `steipete.me` | risk | Not checked; macOS docs are out of v0 | Cut macOS docs from Telegram-only v0 or replace with neutral reference |
| `docs/automation/gmail-pubsub.md:98,167,180,227,228,236,237,249` | Repeated real-looking `m***@gmail.com` account placeholder | risk | Not checked; public onboarding example could be mistaken for a live project account | Rewrite to `user@example.com` or a reserved example domain |
| `docs/gateway/security/index.md:752` | Old-product contact `security@clawd.bot` | risk | Not checked; old public security surface | Replace with current project-owned security contact |
| `extensions/bluebubbles/src/targets.test.ts:27,28,50,136,138,179,181` and `extensions/bluebubbles/src/send.test.ts:202,218` | Real-looking NANP numbers outside `+1555` reserved examples, redacted as `+1********29` | risk | Not checked; BlueBubbles is out of v0 | Cut BlueBubbles extension from v0 pack or rewrite numbers to reserved fictional `+1555...` values |
| `src/media/parse.test.ts:13,14,19,20` | Personal-looking `/Users/pete/My File.png` fixture path | risk | Not checked; fixture exposes a real first-name home path | Rewrite to `/Users/user/...` |

### Nits

| File:line | What it looks like | Severity | Git history evidence | Recommended action |
| --- | --- | --- | --- | --- |
| `LICENSE:3` and `README.md:463,467,481` | Personal creator attribution and `steipete` profile links | nit | Not checked; also covered by attribution audit | Preserve legal attribution where required, but move product contact surfaces to project-owned links |
| `CONTRIBUTING.md:8,12-19` | Named maintainers and social handles for `@steipete`, `@thewilloftheshadow`, and `@joshp123` | nit | Not checked; governance text | Replace with project governance language for public fork release |
| `CHANGELOG.md:68,74,95,164,464,479,484,590,593,628,780,803,809,811,813-820,853,880,881,897` | Contributor handles in historical changelog entries | nit | Not checked; historical attribution | Keep if preserving history, or add release-note context that old handles/PRs refer to upstream history |
| `skills/wacli/SKILL.md:33,35`, `skills/imsg/SKILL.md:21`, and `skills/voice-call/SKILL.md:14` | Phone-number examples use `+14155551212` or `+15555550123`; mostly reserved-looking examples but out-of-v0 skills | nit | Not checked; skills are out of Telegram-only v0 unless separately included | Cut out-of-v0 skills or standardize all examples on reserved fictional `+1555...` values |

### Open questions for operator

Open question for operator: Should Stage 2 preserve historical personal attribution in `CHANGELOG.md`, `LICENSE`, and README while replacing only active contact/governance surfaces?

Open question for operator: Are scripts under `scripts/termux-*`, `scripts/auth-monitor.sh`, and `scripts/systemd/` part of any intended public v0 packaging path, or can they be removed from the pack entirely?
