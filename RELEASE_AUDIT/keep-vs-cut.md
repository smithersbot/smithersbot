# W3 — Keep vs Cut for Telegram-only public v0

Scope: Public v0 ships **Telegram only**. Default for every surface below is **out** unless concrete file/line evidence shows the Telegram path requires it (compile-time or runtime). WebChat is **internal/investigate** unless evidence proves it is strictly required.

Classification key: `in` = ship in v0; `out` = exclude; `internal` = keep in repo for internal dev only, exclude from published artifact; `investigate` = unresolved — see notes.

Evidence convention: `file:line` references are linked to imports/usages discovered with `rg`.

---

## 1. `extensions/*`

| path | classification | reason | recommended action |
| --- | --- | --- | --- |
| extensions/telegram | in | Telegram channel plugin: `extensions/telegram/clawdbot.plugin.json:3` declares `channels:["telegram"]`; bootstrapped via `extensions/telegram/index.ts:1-19`. | keep |
| extensions/bluebubbles | out | BlueBubbles channel plugin (`extensions/bluebubbles/package.json:5`, "Moltbot BlueBubbles channel plugin"). | cut |
| extensions/discord | out | Discord channel plugin (`extensions/discord/package.json:5`). | cut |
| extensions/googlechat | out | Google Chat channel plugin (`extensions/googlechat/package.json:5`). | cut |
| extensions/imessage | out | iMessage channel plugin (`extensions/imessage/package.json:5`). | cut |
| extensions/line | out | LINE channel plugin (`extensions/line/package.json:5`). | cut |
| extensions/matrix | out | Matrix channel plugin (`extensions/matrix/package.json:5`). | cut |
| extensions/mattermost | out | Mattermost channel plugin (`extensions/mattermost/package.json:5`). | cut |
| extensions/msteams | out | MS Teams channel plugin (`extensions/msteams/package.json:5`). | cut |
| extensions/nextcloud-talk | out | Nextcloud Talk channel plugin (`extensions/nextcloud-talk/package.json:5`). | cut |
| extensions/nostr | out | Nostr channel plugin (`extensions/nostr/clawdbot.plugin.json:3` channels:["nostr"]). | cut |
| extensions/signal | out | Signal channel plugin (`extensions/signal/package.json:5`). | cut |
| extensions/slack | out | Slack channel plugin (`extensions/slack/package.json:5`). | cut |
| extensions/tlon | out | Tlon/Urbit channel plugin (`extensions/tlon/package.json:5`). | cut |
| extensions/twitch | out | Twitch channel plugin (`extensions/twitch/clawdbot.plugin.json:3` channels:["twitch"]). | cut |
| extensions/voice-call | out | Voice-call plugin (`extensions/voice-call/package.json:5`); out of v0 per spec. | cut |
| extensions/whatsapp | out | WhatsApp channel plugin (`extensions/whatsapp/package.json:5`). | cut |
| extensions/zalo | out | Zalo channel plugin (`extensions/zalo/package.json:5`). | cut |
| extensions/zalouser | out | Zalo personal-account plugin (`extensions/zalouser/clawdbot.plugin.json:3` channels:["zalouser"]). | cut |
| extensions/copilot-proxy | investigate | Provider plugin (`extensions/copilot-proxy/clawdbot.plugin.json:3` providers:["copilot-proxy"]). Not channel-specific. Useful for v0 if we want optional provider auth, otherwise cut. | investigate |
| extensions/google-antigravity-auth | investigate | Provider OAuth (`extensions/google-antigravity-auth/clawdbot.plugin.json:3` providers:["google-antigravity"]). Optional auth plugin. | investigate |
| extensions/google-gemini-cli-auth | investigate | Provider OAuth (`extensions/google-gemini-cli-auth/clawdbot.plugin.json:3` providers:["google-gemini-cli"]). Optional auth plugin. | investigate |
| extensions/qwen-portal-auth | investigate | Provider OAuth (`extensions/qwen-portal-auth/clawdbot.plugin.json:3` providers:["qwen-portal"]). Optional auth plugin. | investigate |
| extensions/diagnostics-otel | investigate | OpenTelemetry exporter (`extensions/diagnostics-otel/clawdbot.plugin.json:2`). No channel dependency; optional. | investigate |
| extensions/llm-task | investigate | Generic JSON-only LLM tool (`extensions/llm-task/clawdbot.plugin.json:3`). Not channel-bound; could ship. | investigate |
| extensions/lobster | investigate | Workflow tool with resumable approvals (`extensions/lobster/clawdbot.plugin.json:3`). Not channel-bound. | investigate |
| extensions/memory-core | investigate | Core memory search (`extensions/memory-core/clawdbot.plugin.json:3` kind:"memory"). Storage backend optional. | investigate |
| extensions/memory-lancedb | investigate | LanceDB-backed long-term memory (`extensions/memory-lancedb/clawdbot.plugin.json:3`). Optional, heavy native deps. | investigate |
| extensions/open-prose | investigate | OpenProse VM skill pack (`extensions/open-prose/clawdbot.plugin.json:3` skills:["./skills"]). Bundles skills. | investigate |

Notes:
- `extensions/qwen-portal-auth/package.json` is missing (only `clawdbot.plugin.json`, `index.ts`, `oauth.ts`, `README.md` present). Open question for operator: is this extension fully usable as a workspace plugin?
- The Telegram extension imports symbols re-exported from `clawdbot/plugin-sdk` (`extensions/telegram/src/channel.ts:1-30`), which is `src/plugin-sdk/index.ts`. That barrel re-exports `../telegram/accounts.js` etc. (`src/plugin-sdk/index.ts:302`), so `src/telegram/*` is required for the Telegram extension to compile.

---

## 2. `skills/*`

All 52 skills under `skills/*` are user-facing automation packs (CLI integrations, third-party services). None are referenced by the Telegram channel path (`rg telegram /home/matt/moltbot/skills` returned 0 matches). Each skill is independent runtime tooling.

Default: **out** for every skill. Telegram v0 does not require any.

| path | classification | reason | recommended action |
| --- | --- | --- | --- |
| skills/1password | out | 1Password CLI integration (`skills/1password/SKILL.md`); not used by Telegram path. | cut |
| skills/apple-notes | out | macOS Notes integration; macOS app is out of v0. | cut |
| skills/apple-reminders | out | macOS Reminders integration; macOS app is out of v0. | cut |
| skills/bear-notes | out | Bear notes mac CLI; macOS only. | cut |
| skills/bird | out | X/Twitter CLI integration. | cut |
| skills/blogwatcher | out | RSS/Atom feed monitor. | cut |
| skills/blucli | out | BluOS speaker CLI. | cut |
| skills/bluebubbles | out | BlueBubbles skill (channel out of v0). | cut |
| skills/camsnap | out | RTSP camera capture. | cut |
| skills/canvas | out | Canvas (LMS) integration. | cut |
| skills/clawdhub | out | ClawdHub registry CLI. | cut |
| skills/coding-agent | out | Background Codex/Claude Code runner. | cut |
| skills/discord | out | Discord skill (channel out of v0). | cut |
| skills/eightctl | out | Eight Sleep pod control. | cut |
| skills/food-order | out | Foodora reorder CLI. | cut |
| skills/gemini | out | Gemini CLI. | cut |
| skills/gifgrep | out | GIF search/download. | cut |
| skills/github | out | GitHub CLI workflow guidance. | cut |
| skills/gog | out | Google Workspace CLI. | cut |
| skills/goplaces | out | Google Places CLI. | cut |
| skills/himalaya | out | Himalaya email CLI. | cut |
| skills/imsg | out | iMessage CLI (channel out of v0). | cut |
| skills/local-places | out | Local places proxy. | cut |
| skills/mcporter | out | MCP server porter. | cut |
| skills/model-usage | out | CodexBar usage CLI. | cut |
| skills/nano-banana-pro | out | Gemini 3 image gen. | cut |
| skills/nano-pdf | out | PDF editing. | cut |
| skills/notion | out | Notion API. | cut |
| skills/obsidian | out | Obsidian vault tools. | cut |
| skills/openai-image-gen | out | OpenAI Images API. | cut |
| skills/openai-whisper | out | Local Whisper CLI. | cut |
| skills/openai-whisper-api | out | Whisper API. | cut |
| skills/openhue | out | Philips Hue CLI. | cut |
| skills/oracle | out | Oracle CLI prompt guide. | cut |
| skills/ordercli | out | Foodora order CLI. | cut |
| skills/peekaboo | out | macOS UI automation. | cut |
| skills/sag | out | ElevenLabs TTS. | cut |
| skills/session-logs | out | Session log search. | cut |
| skills/sherpa-onnx-tts | out | Local TTS. | cut |
| skills/skill-creator | out | Meta skill for creating skills. | cut |
| skills/slack | out | Slack skill (channel out of v0). | cut |
| skills/songsee | out | Spectrogram tool. | cut |
| skills/sonoscli | out | Sonos control. | cut |
| skills/spotify-player | out | Spotify CLI. | cut |
| skills/summarize | out | URL/podcast summarizer. | cut |
| skills/things-mac | out | Things 3 mac integration. | cut |
| skills/tmux | out | Tmux remote control. | cut |
| skills/trello | out | Trello API. | cut |
| skills/video-frames | out | ffmpeg frame extractor. | cut |
| skills/voice-call | out | Voice-call skill (out of v0). | cut |
| skills/wacli | out | WhatsApp wacli (channel out of v0). | cut |
| skills/weather | out | Weather forecast. | cut |

Recommended action for the whole directory: exclude `skills/**` from the v0 publish payload (currently included via `package.json:files` `"skills/**"`).

---

## 3. `apps/ios` + `apps/android` + `apps/macos`

| path | classification | reason | recommended action |
| --- | --- | --- | --- |
| apps/ios | out | iOS SwiftUI app (`apps/ios/Sources`, `apps/ios/project.yml`); explicitly out of v0 per goal spec. | cut |
| apps/android | out | Android Gradle app (`apps/android/build.gradle.kts`, `apps/android/app`); explicitly out of v0. | cut |
| apps/macos | out | macOS SwiftUI app (`apps/macos/Sources`, `apps/macos/Package.swift`); explicitly out of v0. | cut |
| apps/shared/MoltbotKit | out | Shared Swift kit used by iOS + macOS apps (`apps/shared/MoltbotKit`); has no consumer in v0 once iOS/macOS are cut. | cut |

Note: cutting these removes the WebChat UI client (native chat tab) — see §5.

---

## 4. `src/*` channel surfaces

Telegram and shared routing/channel infrastructure are **in**. Other channel directories are **out** at the channel level, but the Telegram path currently hard-imports several pieces of the WhatsApp Web module (`src/web/*`) and the gateway control protocol references the `webchat` internal channel constant. Specific shared dependencies are called out below.

| path | classification | reason | recommended action |
| --- | --- | --- | --- |
| src/telegram | in | Telegram channel implementation; required by the Telegram extension via `clawdbot/plugin-sdk` re-exports (`src/plugin-sdk/index.ts:302`). | keep |
| src/channels | in | Shared channel registry, allowlists, gating, dock (`src/channels/registry.ts`, `src/channels/dock.ts`); imported by Telegram extension (`extensions/telegram/src/channel.ts:7-26`). | keep |
| src/routing | in | Session-key + route resolution (`src/routing/resolve-route.ts`, `src/routing/session-key.ts`); imported by `src/plugin-sdk/index.ts:120`. | keep |
| src/auto-reply | in | Auto-reply pipeline used by every channel including Telegram (`src/auto-reply/reply/commands-allowlist.ts:16` imports `../../telegram/accounts.js`; `src/plugin-sdk/index.ts:122-139` re-exports auto-reply types). | keep |
| src/gateway | in | Gateway WebSocket server + protocol — Telegram runs under it; `src/gateway/server-chat.ts:18` references the `webchat` internal channel; `src/plugin-sdk/index.ts:70` exports gateway types. | keep |
| src/cli, src/commands, src/config, src/infra, src/agents, src/sessions, src/process, src/security, src/shared, src/utils, src/types, src/runtime.ts, src/index.ts, src/entry.ts, src/logger.ts, src/logging, src/globals.ts | in | Core CLI / config / infra / agent runtime; not channel-specific. | keep |
| src/web | investigate | Despite the name, this is the **WhatsApp Web** (Baileys) channel — `src/web/login.ts`, `src/web/outbound.ts` (`sendMessageWhatsApp`), `src/web/auto-reply/*`, `src/web/accounts.ts`. The Telegram path **currently hard-imports** several symbols from it: `loadWebMedia` at `src/telegram/send.ts:20`, `src/infra/outbound/message-action-runner.ts:43`, `src/plugins/runtime/index.ts:113`; `sendMessageWhatsApp` type at `src/infra/outbound/deliver.ts:19`; `resolveWhatsAppAccount` at `src/auto-reply/reply/commands-allowlist.ts:17` and `src/channels/plugins/directory-config.ts:6`; `hasAnyWhatsAppAuth` at `src/config/plugin-auto-enable.ts:12`. So `src/web/` is a compile-time dep of the Telegram path today, but the only piece functionally needed by Telegram is the shared media loader (`src/web/media.ts`). Recommend extracting `src/web/media.ts` (and the small WA auth-config helpers used by gating) to a shared `src/media/*` location and dropping the rest. | investigate (refactor for Stage 2) |
| src/channel-web.ts + src/channel-web.barrel.test.ts | investigate | Barrel re-export of WhatsApp web pieces (`src/channel-web.ts:1-30`). Same status as `src/web/`. | investigate |
| src/channels/web | investigate | Re-export shim pointing to `src/channel-web` (`src/channels/web/index.ts:2-13`). Same status as `src/web/`. | investigate |
| src/whatsapp | out | Standalone WhatsApp channel surface (separate from `src/web/`). Not required by Telegram. | cut |
| src/discord | out | Discord channel implementation. | cut |
| src/slack | out | Slack channel implementation. | cut |
| src/signal | out | Signal channel implementation. | cut |
| src/imessage | out | iMessage channel implementation. | cut |
| src/line | out | LINE channel implementation. | cut |
| src/macos | investigate | Mac-app integration surface (likely tied to macOS app/gateway). Audit before removal. | investigate |
| src/canvas-host | investigate | A2UI canvas WebSocket host (`src/canvas-host/server.ts`, `src/canvas-host/a2ui.ts`). Not channel-bound; ties into the Control UI. Keep only if v0 surfaces it. | investigate |
| src/cron, src/daemon, src/docs, src/goal, src/hooks, src/markdown, src/media, src/media-understanding, src/link-understanding, src/memory, src/node-host, src/pairing, src/plugins, src/plugin-sdk, src/providers, src/repo-chat, src/scripts, src/tts, src/tui, src/terminal, src/test-helpers, src/test-utils, src/wizard, src/acp, src/agents, src/browser, src/compat | in | Core runtime + tooling; not channel-specific. Audit individually for credentialing/secrets but ship. | keep |

Concrete Telegram → WhatsApp-Web couplings to extract before cutting `src/web/*`:
- `src/telegram/send.ts:20` → `loadWebMedia` from `../web/media.js`
- `src/infra/outbound/message-action-runner.ts:43` → `loadWebMedia`
- `src/infra/outbound/deliver.ts:19` → type `sendMessageWhatsApp`
- `src/auto-reply/reply/commands-allowlist.ts:17` → `resolveWhatsAppAccount`
- `src/channels/plugins/directory-config.ts:6` → `resolveWhatsAppAccount`
- `src/config/plugin-auto-enable.ts:12` → `hasAnyWhatsAppAuth`
- `src/plugins/runtime/index.ts:113-124` → `loadWebMedia`, `getActiveWebListener`, `auth-store`, `loginWeb`, `login-qr`, `sendMessageWhatsApp`, `sendPollWhatsApp`

---

## 5. `src/web` or WebChat

There are two distinct things named "web" in this repo. Both are classified here.

### 5a. `src/web/*` (WhatsApp Web / Baileys)

Already covered in §4: this is the WhatsApp web channel, not a chat UI. Classification: **investigate**, currently a compile-time dep of the Telegram path but functionally only the media helper is needed.

### 5b. WebChat (gateway WebSocket chat UI)

WebChat is a separate concept: the gateway's native chat UI surface, served via WebSocket methods (`chat.history`, `chat.send`, `chat.inject`). It is documented at `docs/web/webchat.md:1-30` and `docs/platforms/mac/webchat.md`. The client is the macOS/iOS SwiftUI app and the `ui/` Control UI; there is no embedded HTTP chat UI in v0.

| path | classification | reason | recommended action |
| --- | --- | --- | --- |
| WebChat protocol surface (in `src/gateway/`) | internal | Telegram path references the `webchat` internal-channel constant in shared code: `src/utils/message-channel.ts:17` defines `INTERNAL_MESSAGE_CHANNEL = "webchat"`; `src/gateway/protocol/client-info.ts:2-23` declares `WEBCHAT_UI` and `WEBCHAT` mode/name constants; `src/gateway/server-chat.ts:18` reads heartbeat visibility for the `webchat` channel; `src/gateway/server-methods/chat.ts` and `src/gateway/server-methods/agent.ts` implement the WS chat methods. Removing the `webchat` constant would cascade through `src/auto-reply/reply/*`, `src/infra/outbound/agent-delivery.ts`, `src/commands/sandbox-explain.ts`, `src/agents/tools/sessions-send-tool.ts`, `src/agents/tools/agent-step.ts`. Keep the **constant and protocol plumbing in source**, but disable user-facing exposure. | keep code, disable user-facing surface |
| WebChat clients (apps/ios, apps/macos, ui/ Control UI) | out | iOS/macOS apps are out of v0 (§3). `ui/` is the in-browser Control UI (see §6, `ui/`). | cut |

The `webchat` symbol is **not** strictly required for the Telegram path to compile in isolation; it is required because the shared chat/agent pipeline (`src/infra/outbound/agent-delivery.ts`, `src/gateway/server-methods/agent.ts`) routes all assistant traffic through this internal channel. So the protocol code is `internal` — keep the code, do not advertise or expose the surface in v0.

Open question for operator: do we want to **strip the WebChat WS methods** (`chat.history`, `chat.send`, `chat.inject`) from v0 entirely, or just gate them behind an explicit config flag? Either is feasible; stripping forces a wider refactor.

---

## 6. Top-level peripheral dirs

| path | classification | reason | recommended action |
| --- | --- | --- | --- |
| Swabble/ | out | Standalone Swift wake-word daemon (`Swabble/README.md:1-30`, `Swabble/Package.swift`, MIT © Peter Steinberger in `Swabble/LICENSE`). Independent project, macOS 26 target; not used by Telegram path. | cut (extract to its own repo) |
| smithersbot_marketing/ | out | Marketing one-pager assets (`smithersbot_marketing/one-pager.html`, `one-pager.pdf`, `styles.css`); upstream/old-product branding. | cut |
| openclaw-starter-kit/ | out | OpenClaw starter-kit content (`openclaw-starter-kit/README.md:1-30` references OpenClaw + dated postmortem). Not used by code; documentation for a different product family. | cut |
| vendor/a2ui | investigate | Third-party A2UI spec + renderers (`vendor/a2ui/README.md`, `vendor/a2ui/LICENSE`). Consumed by `src/canvas-host/a2ui.ts`. Vendored third-party code — verify license + provenance before publishing; either keep as-is with attribution or replace with an npm dep. | investigate |
| packages/clawdbot | investigate | Compat shim: `packages/clawdbot/package.json:5` description "Compatibility shim that forwards to moltbot", declares `bin: { moltbot: ./bin/moltbot.js }` and a `workspace:*` dep on `moltbot`. Exists to keep the legacy `clawdbot` CLI name working. Decide whether v0 publishes the `clawdbot` name at all. | investigate |
| packages/moltbot | out | Empty (only `node_modules`); placeholder directory. | cut (or .gitignore the empty dir) |
| templates/ | investigate | Single file `templates/scout_prompt_template.md`. Used at runtime by the goal/scout planner — `rg scout_prompt_template` should be run in Stage 2 to confirm. If runtime references it, keep; otherwise cut. | investigate |
| ui/ | investigate | Lit-based "moltbot-control-ui" (`ui/package.json:2` `"name": "moltbot-control-ui"`). This is the gateway Control UI (the in-browser chat tab). Not bundled with the npm CLI today (not in `package.json:files`). For v0: if we want a working browser chat experience for Telegram-only operators, keep; otherwise cut. | investigate |
| assets/ | investigate | `assets/avatar-placeholder.svg`, `assets/chrome-extension/`, `assets/dmg-background*.png`. DMG backgrounds are mac-app artifacts (out of v0). Chrome extension is unrelated to Telegram path. Avatar placeholder is referenced by Control UI / gateway. | investigate (prune to what's referenced) |
| test/ | in | Vitest top-level test harness: `test/setup.ts`, `test/fixtures/`, `test/global-setup.ts`, plus integration tests for inbound/auto-reply (`test/auto-reply.retry.test.ts`, `test/inbound-contract.providers.test.ts`, `test/gateway.multi.e2e.test.ts`, `test/media-understanding.auto.e2e.test.ts`, `test/provider-timeout.e2e.test.ts`). Required to run the Vitest suite — `vitest.config.ts` references `test/setup.ts`. | keep (internal-only; not in published `files`) |

Notes:
- `test/` is **internal**: it is referenced by `vitest.config.ts` but not in `package.json:files`, so it never ships to npm. Marking `in` here means "keep in the repo," not "publish."
- `ui/` is also internal: not in `package.json:files`; it's a workspace package consumed via the gateway control-UI loader.

---

## Memory & state

(Placeholder for the `w3-memory-state` subtask, which is run after this report and appends a `Memory & state` section here.)

---

## Open questions for operator

1. Should v0 publish the `clawdbot` CLI alias at all (currently shipped via `package.json:bin.clawdbot` and `packages/clawdbot`)? If not, both surfaces can be cut.
2. WebChat: strip the `chat.history` / `chat.send` / `chat.inject` WS methods entirely, or keep the protocol code and rely on the absence of clients (apps/ios, apps/macos, ui/) to make the surface inert?
3. Should `src/web/media.ts` and the small WA auth-config helpers used by Telegram (`hasAnyWhatsAppAuth`, `resolveWhatsAppAccount`) be extracted to channel-agnostic locations in Stage 2 so the whole WhatsApp-Web tree can be cut cleanly?
4. Provider auth extensions (`copilot-proxy`, `google-antigravity-auth`, `google-gemini-cli-auth`, `qwen-portal-auth`): ship in v0 for optional provider auth, or cut to minimize attack surface?
5. `vendor/a2ui`: keep as vendored or replace with an upstream package reference before publishing?
6. `extensions/qwen-portal-auth` is missing its `package.json` — intentional, or an oversight that blocks workspace install?

```jsonl
{"path":"extensions/telegram","category":"keep_or_cut","finding":"Telegram channel plugin; required for v0","severity":"info","action":"keep","v0_scope":"in","notes":"clawdbot.plugin.json declares channels:['telegram']"}
{"path":"extensions/bluebubbles","category":"keep_or_cut","finding":"BlueBubbles channel plugin; not Telegram","severity":"risk","action":"cut","v0_scope":"out","notes":"Telegram-only v0 scope"}
{"path":"extensions/discord","category":"keep_or_cut","finding":"Discord channel plugin; not Telegram","severity":"risk","action":"cut","v0_scope":"out"}
{"path":"extensions/googlechat","category":"keep_or_cut","finding":"Google Chat channel plugin","severity":"risk","action":"cut","v0_scope":"out"}
{"path":"extensions/imessage","category":"keep_or_cut","finding":"iMessage channel plugin","severity":"risk","action":"cut","v0_scope":"out"}
{"path":"extensions/line","category":"keep_or_cut","finding":"LINE channel plugin","severity":"risk","action":"cut","v0_scope":"out"}
{"path":"extensions/matrix","category":"keep_or_cut","finding":"Matrix channel plugin","severity":"risk","action":"cut","v0_scope":"out"}
{"path":"extensions/mattermost","category":"keep_or_cut","finding":"Mattermost channel plugin","severity":"risk","action":"cut","v0_scope":"out"}
{"path":"extensions/msteams","category":"keep_or_cut","finding":"MS Teams channel plugin","severity":"risk","action":"cut","v0_scope":"out"}
{"path":"extensions/nextcloud-talk","category":"keep_or_cut","finding":"Nextcloud Talk channel plugin","severity":"risk","action":"cut","v0_scope":"out"}
{"path":"extensions/nostr","category":"keep_or_cut","finding":"Nostr channel plugin","severity":"risk","action":"cut","v0_scope":"out"}
{"path":"extensions/signal","category":"keep_or_cut","finding":"Signal channel plugin","severity":"risk","action":"cut","v0_scope":"out"}
{"path":"extensions/slack","category":"keep_or_cut","finding":"Slack channel plugin","severity":"risk","action":"cut","v0_scope":"out"}
{"path":"extensions/tlon","category":"keep_or_cut","finding":"Tlon/Urbit channel plugin","severity":"risk","action":"cut","v0_scope":"out"}
{"path":"extensions/twitch","category":"keep_or_cut","finding":"Twitch channel plugin","severity":"risk","action":"cut","v0_scope":"out"}
{"path":"extensions/voice-call","category":"keep_or_cut","finding":"Voice-call plugin","severity":"risk","action":"cut","v0_scope":"out","notes":"Explicitly out of v0 per scope"}
{"path":"extensions/whatsapp","category":"keep_or_cut","finding":"WhatsApp channel plugin","severity":"risk","action":"cut","v0_scope":"out"}
{"path":"extensions/zalo","category":"keep_or_cut","finding":"Zalo channel plugin","severity":"risk","action":"cut","v0_scope":"out"}
{"path":"extensions/zalouser","category":"keep_or_cut","finding":"Zalo personal-account plugin","severity":"risk","action":"cut","v0_scope":"out"}
{"path":"extensions/copilot-proxy","category":"keep_or_cut","finding":"Optional provider-auth plugin","severity":"nit","action":"investigate","v0_scope":"investigate","notes":"Decide whether v0 ships optional provider auth"}
{"path":"extensions/google-antigravity-auth","category":"keep_or_cut","finding":"Optional provider OAuth plugin","severity":"nit","action":"investigate","v0_scope":"investigate"}
{"path":"extensions/google-gemini-cli-auth","category":"keep_or_cut","finding":"Optional provider OAuth plugin","severity":"nit","action":"investigate","v0_scope":"investigate"}
{"path":"extensions/qwen-portal-auth","category":"keep_or_cut","finding":"Optional provider OAuth plugin; missing package.json","severity":"risk","action":"investigate","v0_scope":"investigate","notes":"package.json absent — confirm install path before shipping"}
{"path":"extensions/diagnostics-otel","category":"keep_or_cut","finding":"OpenTelemetry exporter plugin","severity":"nit","action":"investigate","v0_scope":"investigate"}
{"path":"extensions/llm-task","category":"keep_or_cut","finding":"Generic JSON LLM tool plugin","severity":"nit","action":"investigate","v0_scope":"investigate"}
{"path":"extensions/lobster","category":"keep_or_cut","finding":"Workflow tool plugin","severity":"nit","action":"investigate","v0_scope":"investigate"}
{"path":"extensions/memory-core","category":"keep_or_cut","finding":"Core memory search plugin","severity":"nit","action":"investigate","v0_scope":"investigate"}
{"path":"extensions/memory-lancedb","category":"keep_or_cut","finding":"LanceDB memory plugin (heavy native deps)","severity":"nit","action":"investigate","v0_scope":"investigate"}
{"path":"extensions/open-prose","category":"keep_or_cut","finding":"OpenProse VM skill pack","severity":"nit","action":"investigate","v0_scope":"investigate"}
{"path":"skills","category":"keep_or_cut","finding":"52 user-facing skill packs; none referenced by Telegram path; included in package.json files glob","severity":"risk","action":"cut","v0_scope":"out","notes":"Remove 'skills/**' from package.json:files for v0; keeps repo source but excludes from npm publish"}
{"path":"apps/ios","category":"keep_or_cut","finding":"iOS SwiftUI app — out of v0","severity":"info","action":"cut","v0_scope":"out"}
{"path":"apps/android","category":"keep_or_cut","finding":"Android app — out of v0","severity":"info","action":"cut","v0_scope":"out"}
{"path":"apps/macos","category":"keep_or_cut","finding":"macOS SwiftUI app — out of v0","severity":"info","action":"cut","v0_scope":"out"}
{"path":"apps/shared/MoltbotKit","category":"keep_or_cut","finding":"Shared Swift kit; orphaned once iOS/macOS cut","severity":"info","action":"cut","v0_scope":"out"}
{"path":"src/telegram","category":"keep_or_cut","finding":"Telegram channel source; required by extensions/telegram via plugin-sdk re-exports","severity":"info","action":"keep","v0_scope":"in","notes":"src/plugin-sdk/index.ts:302 re-exports from src/telegram/accounts"}
{"path":"src/channels","category":"keep_or_cut","finding":"Shared channel registry/dock/allowlists","severity":"info","action":"keep","v0_scope":"in","notes":"extensions/telegram/src/channel.ts:7-26 imports from plugin-sdk which re-exports src/channels"}
{"path":"src/routing","category":"keep_or_cut","finding":"Routing + session-key infra","severity":"info","action":"keep","v0_scope":"in","notes":"src/plugin-sdk/index.ts:120 exports routing/session-key"}
{"path":"src/auto-reply","category":"keep_or_cut","finding":"Auto-reply pipeline shared across channels","severity":"info","action":"keep","v0_scope":"in"}
{"path":"src/gateway","category":"keep_or_cut","finding":"Gateway WS server + protocol — Telegram runs under it","severity":"info","action":"keep","v0_scope":"in","notes":"References INTERNAL_MESSAGE_CHANNEL=webchat at src/gateway/server-chat.ts:18"}
{"path":"src/web","category":"keep_or_cut","finding":"WhatsApp Web (Baileys) channel; currently hard-imported by Telegram path","severity":"blocker","action":"investigate","v0_scope":"investigate","notes":"Telegram imports loadWebMedia/sendMessageWhatsApp/resolveWhatsAppAccount/hasAnyWhatsAppAuth — extract shared media helper before cutting; see src/telegram/send.ts:20, src/infra/outbound/deliver.ts:19, src/auto-reply/reply/commands-allowlist.ts:17, src/channels/plugins/directory-config.ts:6, src/config/plugin-auto-enable.ts:12, src/plugins/runtime/index.ts:113-124"}
{"path":"src/channel-web.ts","category":"keep_or_cut","finding":"Barrel re-export of WhatsApp Web pieces","severity":"risk","action":"investigate","v0_scope":"investigate","notes":"src/channel-web.ts:1-30; tied to src/web/"}
{"path":"src/channels/web","category":"keep_or_cut","finding":"Shim re-exporting WhatsApp Web pieces","severity":"risk","action":"investigate","v0_scope":"investigate","notes":"src/channels/web/index.ts:2-13"}
{"path":"src/whatsapp","category":"keep_or_cut","finding":"WhatsApp channel surface — not used by Telegram","severity":"risk","action":"cut","v0_scope":"out"}
{"path":"src/discord","category":"keep_or_cut","finding":"Discord channel surface","severity":"risk","action":"cut","v0_scope":"out"}
{"path":"src/slack","category":"keep_or_cut","finding":"Slack channel surface","severity":"risk","action":"cut","v0_scope":"out"}
{"path":"src/signal","category":"keep_or_cut","finding":"Signal channel surface","severity":"risk","action":"cut","v0_scope":"out"}
{"path":"src/imessage","category":"keep_or_cut","finding":"iMessage channel surface","severity":"risk","action":"cut","v0_scope":"out"}
{"path":"src/line","category":"keep_or_cut","finding":"LINE channel surface","severity":"risk","action":"cut","v0_scope":"out"}
{"path":"src/macos","category":"keep_or_cut","finding":"Mac-app integration surface","severity":"nit","action":"investigate","v0_scope":"investigate","notes":"Likely orphaned after apps/macos cut — verify"}
{"path":"src/canvas-host","category":"keep_or_cut","finding":"A2UI canvas WS host; ties into Control UI","severity":"nit","action":"investigate","v0_scope":"investigate"}
{"path":"WebChat protocol surface","category":"keep_or_cut","finding":"webchat is the internal-channel constant used by shared auto-reply/agent pipeline; protocol methods chat.history/send/inject in src/gateway/server-methods/chat.ts","severity":"risk","action":"investigate","v0_scope":"internal","notes":"src/utils/message-channel.ts:17 INTERNAL_MESSAGE_CHANNEL='webchat'; src/gateway/protocol/client-info.ts:2-23"}
{"path":"Swabble","category":"keep_or_cut","finding":"Standalone Swift wake-word daemon; not used by core","severity":"risk","action":"cut","v0_scope":"out","notes":"MIT © Peter Steinberger; extract to own repo"}
{"path":"smithersbot_marketing","category":"keep_or_cut","finding":"Marketing one-pager + PDF assets","severity":"risk","action":"cut","v0_scope":"out","notes":"Old-product branding (smithersbot)"}
{"path":"openclaw-starter-kit","category":"keep_or_cut","finding":"OpenClaw starter-kit content","severity":"risk","action":"cut","v0_scope":"out","notes":"Different product family; unused at runtime"}
{"path":"vendor/a2ui","category":"keep_or_cut","finding":"Third-party A2UI spec/renderers consumed by src/canvas-host","severity":"nit","action":"investigate","v0_scope":"investigate","notes":"Check license + provenance before publishing"}
{"path":"packages/clawdbot","category":"keep_or_cut","finding":"Compat shim publishing the clawdbot CLI name","severity":"risk","action":"investigate","v0_scope":"investigate","notes":"Decide whether v0 publishes clawdbot alias"}
{"path":"packages/moltbot","category":"keep_or_cut","finding":"Empty placeholder directory","severity":"nit","action":"cut","v0_scope":"out"}
{"path":"templates","category":"keep_or_cut","finding":"templates/scout_prompt_template.md — runtime usage unverified","severity":"nit","action":"investigate","v0_scope":"investigate"}
{"path":"ui","category":"keep_or_cut","finding":"moltbot-control-ui Lit app; not in package.json:files","severity":"nit","action":"investigate","v0_scope":"investigate","notes":"Decide whether v0 ships in-browser Control UI"}
{"path":"assets","category":"keep_or_cut","finding":"Mixed assets: avatar-placeholder.svg, chrome-extension/, dmg-background*.png","severity":"nit","action":"investigate","v0_scope":"investigate","notes":"DMG backgrounds are mac-app artifacts — prune"}
{"path":"test","category":"keep_or_cut","finding":"Vitest top-level harness; required to run the test suite","severity":"info","action":"keep","v0_scope":"internal","notes":"Not in package.json:files"}
```
