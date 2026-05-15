# 🦞 Moltbot — Personal AI Assistant

<p align="center">
  <strong>EXFOLIATE! EXFOLIATE!</strong>
</p>

<p align="center">
  <a href="https://github.com/moltbot/moltbot/releases"><img src="https://img.shields.io/github/v/release/moltbot/moltbot?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="https://deepwiki.com/moltbot/moltbot"><img src="https://img.shields.io/badge/DeepWiki-moltbot-111111?style=for-the-badge" alt="DeepWiki"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

**Moltbot** is a *personal AI assistant* you run on your own devices. It answers you on Telegram, and it can speak and listen on macOS/iOS/Android while rendering a live Canvas you control. The Gateway is just the control plane — the product is the assistant.

If you want a personal, single-user assistant that feels local, fast, and always-on, this is it.

[Website](https://molt.bot) · [Docs](https://docs.molt.bot) · [Getting Started](https://docs.molt.bot/start/getting-started) · [Updating](https://docs.molt.bot/install/updating) · [Showcase](https://docs.molt.bot/start/showcase) · [FAQ](https://docs.molt.bot/start/faq) · [Wizard](https://docs.molt.bot/start/wizard) · [Docker](https://docs.molt.bot/install/docker)

Preferred setup: clone from source and run the onboarding wizard (`pnpm moltbot onboard`). It walks through gateway, workspace, the Telegram channel, and skills. The CLI wizard is the recommended path and works on **macOS, Linux, and Windows (via WSL2; strongly recommended)**.
Works with pnpm, npm, or bun.
New install? Start here: [Getting started](https://docs.molt.bot/start/getting-started)

**Subscriptions (OAuth):**
- **[Anthropic](https://www.anthropic.com/)** (Claude Pro/Max)
- **[OpenAI](https://openai.com/)** (ChatGPT/Codex)

Model note: while any model is supported, I strongly recommend **Anthropic Pro/Max (100/200) + Opus 4.5** for long‑context strength and better prompt‑injection resistance. See [Onboarding](https://docs.molt.bot/start/onboarding).

## Models (selection + auth)

- Models config + CLI: [Models](https://docs.molt.bot/concepts/models)
- Auth profile rotation (OAuth vs API keys) + fallbacks: [Model failover](https://docs.molt.bot/concepts/model-failover)

## Install (from source)

Runtime: **Node ≥22**.

```bash
git clone https://github.com/moltbot/moltbot.git
cd moltbot

pnpm install
pnpm ui:build # auto-installs UI deps on first run
pnpm build

pnpm moltbot onboard --install-daemon
```

The wizard installs the Gateway daemon (launchd/systemd user service) so it stays running.

## Quick start (TL;DR)

Runtime: **Node ≥22**.

Full beginner guide (auth, pairing, Telegram setup): [Getting started](https://docs.molt.bot/start/getting-started)

```bash
pnpm moltbot onboard --install-daemon

pnpm moltbot gateway --port 18789 --verbose

# Talk to the assistant (delivers replies back on Telegram when configured)
pnpm moltbot agent --message "Ship checklist" --thinking high
```

Upgrading? [Updating guide](https://docs.molt.bot/install/updating) (and run `pnpm moltbot doctor`).

## Development channels

- **stable**: tagged releases (`vYYYY.M.D` or `vYYYY.M.D-<patch>`), npm dist-tag `latest`.
- **beta**: prerelease tags (`vYYYY.M.D-beta.N`), npm dist-tag `beta` (macOS app may be missing).
- **dev**: moving head of `main`, npm dist-tag `dev` (when published).

Switch channels (git + npm): `pnpm moltbot update --channel stable|beta|dev`.
Details: [Development channels](https://docs.molt.bot/install/development-channels).

## From source (development)

Prefer `pnpm` for builds from source. Bun is optional for running TypeScript directly.

```bash
git clone https://github.com/moltbot/moltbot.git
cd moltbot

pnpm install
pnpm ui:build # auto-installs UI deps on first run
pnpm build

pnpm moltbot onboard --install-daemon

# Dev loop (auto-reload on TS changes)
pnpm gateway:watch
```

Note: `pnpm moltbot ...` runs TypeScript directly (via `tsx`). `pnpm build` produces `dist/` for running via Node / the packaged `moltbot` binary.

## Security defaults (DM access)

Moltbot connects to a real messaging surface. Treat inbound DMs as **untrusted input**.

Full security guide: [Security](https://docs.molt.bot/gateway/security)

Default behavior on Telegram:
- **DM pairing** (`dmPolicy="pairing"`): unknown senders receive a short pairing code and the bot does not process their message.
- Approve with: `pnpm moltbot pairing approve telegram <code>` (then the sender is added to a local allowlist store).
- Public inbound DMs require an explicit opt-in: set `dmPolicy="open"` and include `"*"` in the channel allowlist (`allowFrom`).

Run `pnpm moltbot doctor` to surface risky/misconfigured DM policies.

## Highlights

- **[Local-first Gateway](https://docs.molt.bot/gateway)** — single control plane for sessions, the Telegram channel, tools, and events.
- **Telegram inbox** — connect a Telegram bot account and route inbound chats and groups to isolated agents (workspaces + per-agent sessions).
- **[Multi-agent routing](https://docs.molt.bot/gateway/configuration)** — route inbound accounts/peers to isolated agents (workspaces + per-agent sessions).
- **[Voice Wake](https://docs.molt.bot/nodes/voicewake) + [Talk Mode](https://docs.molt.bot/nodes/talk)** — always-on speech for macOS/iOS/Android with ElevenLabs.
- **[Live Canvas](https://docs.molt.bot/platforms/mac/canvas)** — agent-driven visual workspace with [A2UI](https://docs.molt.bot/platforms/mac/canvas#canvas-a2ui).
- **[First-class tools](https://docs.molt.bot/tools)** — browser, canvas, nodes, cron, and sessions.
- **[Companion apps](https://docs.molt.bot/platforms/macos)** — macOS menu bar app + iOS/Android [nodes](https://docs.molt.bot/nodes).
- **[Onboarding](https://docs.molt.bot/start/wizard) + [skills](https://docs.molt.bot/tools/skills)** — wizard-driven setup with bundled/managed/workspace skills.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=moltbot/moltbot&type=date&legend=top-left)](https://www.star-history.com/#moltbot/moltbot&type=date&legend=top-left)

## Everything we built so far

### Core platform
- [Gateway WS control plane](https://docs.molt.bot/gateway) with sessions, presence, config, cron, webhooks, [Control UI](https://docs.molt.bot/web), and [Canvas host](https://docs.molt.bot/platforms/mac/canvas#canvas-a2ui).
- [CLI surface](https://docs.molt.bot/tools/agent-send): gateway, agent, send, [wizard](https://docs.molt.bot/start/wizard), and [doctor](https://docs.molt.bot/gateway/doctor).
- [Pi agent runtime](https://docs.molt.bot/concepts/agent) in RPC mode with tool streaming and block streaming.
- [Session model](https://docs.molt.bot/concepts/session): `main` for direct chats, group isolation, activation modes, queue modes, reply-back. Group rules: [Groups](https://docs.molt.bot/concepts/groups).
- [Media pipeline](https://docs.molt.bot/nodes/images): images/audio/video, transcription hooks, size caps, temp file lifecycle. Audio details: [Audio](https://docs.molt.bot/nodes/audio).

### Channel
- [Telegram](https://docs.molt.bot/channels/telegram) (grammY) is the supported messaging surface for v0. Group routing supports mention gating, reply tags, and per-channel chunking.

### Apps + nodes
- [macOS app](https://docs.molt.bot/platforms/macos): menu bar control plane, [Voice Wake](https://docs.molt.bot/nodes/voicewake)/PTT, [Talk Mode](https://docs.molt.bot/nodes/talk) overlay, debug tools, [remote gateway](https://docs.molt.bot/gateway/remote) control.
- [iOS node](https://docs.molt.bot/platforms/ios): [Canvas](https://docs.molt.bot/platforms/mac/canvas), [Voice Wake](https://docs.molt.bot/nodes/voicewake), [Talk Mode](https://docs.molt.bot/nodes/talk), camera, screen recording, Bonjour pairing.
- [Android node](https://docs.molt.bot/platforms/android): [Canvas](https://docs.molt.bot/platforms/mac/canvas), [Talk Mode](https://docs.molt.bot/nodes/talk), camera, screen recording, optional SMS.
- [macOS node mode](https://docs.molt.bot/nodes): system.run/notify + canvas/camera exposure.

### Tools + automation
- [Browser control](https://docs.molt.bot/tools/browser): dedicated moltbot Chrome/Chromium, snapshots, actions, uploads, profiles.
- [Canvas](https://docs.molt.bot/platforms/mac/canvas): [A2UI](https://docs.molt.bot/platforms/mac/canvas#canvas-a2ui) push/reset, eval, snapshot.
- [Nodes](https://docs.molt.bot/nodes): camera snap/clip, screen record, [location.get](https://docs.molt.bot/nodes/location-command), notifications.
- [Cron + wakeups](https://docs.molt.bot/automation/cron-jobs); [webhooks](https://docs.molt.bot/automation/webhook); [Gmail Pub/Sub](https://docs.molt.bot/automation/gmail-pubsub).
- [Skills platform](https://docs.molt.bot/tools/skills): bundled, managed, and workspace skills with install gating + UI.

### Runtime + safety
- [Channel routing](https://docs.molt.bot/concepts/channel-routing), [retry policy](https://docs.molt.bot/concepts/retry), and [streaming/chunking](https://docs.molt.bot/concepts/streaming).
- [Presence](https://docs.molt.bot/concepts/presence), [typing indicators](https://docs.molt.bot/concepts/typing-indicators), and [usage tracking](https://docs.molt.bot/concepts/usage-tracking).
- [Models](https://docs.molt.bot/concepts/models), [model failover](https://docs.molt.bot/concepts/model-failover), and [session pruning](https://docs.molt.bot/concepts/session-pruning).
- [Security](https://docs.molt.bot/gateway/security) and [troubleshooting](https://docs.molt.bot/channels/troubleshooting).

### Ops + packaging
- [Control UI](https://docs.molt.bot/web) served directly from the Gateway.
- [Tailscale Serve/Funnel](https://docs.molt.bot/gateway/tailscale) or [SSH tunnels](https://docs.molt.bot/gateway/remote) with token/password auth.
- [Nix mode](https://docs.molt.bot/install/nix) for declarative config; [Docker](https://docs.molt.bot/install/docker)-based installs.
- [Doctor](https://docs.molt.bot/gateway/doctor) migrations, [logging](https://docs.molt.bot/logging).

## How it works (short)

```
                  Telegram
                     │
                     ▼
┌───────────────────────────────┐
│            Gateway            │
│       (control plane)         │
│     ws://127.0.0.1:18789      │
└──────────────┬────────────────┘
               │
               ├─ Pi agent (RPC)
               ├─ CLI (moltbot …)
               ├─ macOS app
               └─ iOS / Android nodes
```

## Key subsystems

- **[Gateway WebSocket network](https://docs.molt.bot/concepts/architecture)** — single WS control plane for clients, tools, and events (plus ops: [Gateway runbook](https://docs.molt.bot/gateway)).
- **[Tailscale exposure](https://docs.molt.bot/gateway/tailscale)** — Serve/Funnel for the Gateway dashboard + WS (remote access: [Remote](https://docs.molt.bot/gateway/remote)).
- **[Browser control](https://docs.molt.bot/tools/browser)** — moltbot‑managed Chrome/Chromium with CDP control.
- **[Canvas + A2UI](https://docs.molt.bot/platforms/mac/canvas)** — agent‑driven visual workspace (A2UI host: [Canvas/A2UI](https://docs.molt.bot/platforms/mac/canvas#canvas-a2ui)).
- **[Voice Wake](https://docs.molt.bot/nodes/voicewake) + [Talk Mode](https://docs.molt.bot/nodes/talk)** — always‑on speech and continuous conversation.
- **[Nodes](https://docs.molt.bot/nodes)** — Canvas, camera snap/clip, screen record, `location.get`, notifications, plus macOS‑only `system.run`/`system.notify`.

## Tailscale access (Gateway dashboard)

Moltbot can auto-configure Tailscale **Serve** (tailnet-only) or **Funnel** (public) while the Gateway stays bound to loopback. Configure `gateway.tailscale.mode`:

- `off`: no Tailscale automation (default).
- `serve`: tailnet-only HTTPS via `tailscale serve` (uses Tailscale identity headers by default).
- `funnel`: public HTTPS via `tailscale funnel` (requires shared password auth).

Notes:
- `gateway.bind` must stay `loopback` when Serve/Funnel is enabled (Moltbot enforces this).
- Serve can be forced to require a password by setting `gateway.auth.mode: "password"` or `gateway.auth.allowTailscale: false`.
- Funnel refuses to start unless `gateway.auth.mode: "password"` is set.
- Optional: `gateway.tailscale.resetOnExit` to undo Serve/Funnel on shutdown.

Details: [Tailscale guide](https://docs.molt.bot/gateway/tailscale) · [Web surfaces](https://docs.molt.bot/web)

## Remote Gateway (Linux is great)

It’s perfectly fine to run the Gateway on a small Linux instance. Clients (macOS app, CLI) can connect over **Tailscale Serve/Funnel** or **SSH tunnels**, and you can still pair device nodes (macOS/iOS/Android) to execute device‑local actions when needed.

- **Gateway host** runs the exec tool and the Telegram channel connection by default.
- **Device nodes** run device‑local actions (`system.run`, camera, screen recording, notifications) via `node.invoke`.
In short: exec runs where the Gateway lives; device actions run where the device lives.

Details: [Remote access](https://docs.molt.bot/gateway/remote) · [Nodes](https://docs.molt.bot/nodes) · [Security](https://docs.molt.bot/gateway/security)

## macOS permissions via the Gateway protocol

The macOS app can run in **node mode** and advertises its capabilities + permission map over the Gateway WebSocket (`node.list` / `node.describe`). Clients can then execute local actions via `node.invoke`:

- `system.run` runs a local command and returns stdout/stderr/exit code; set `needsScreenRecording: true` to require screen-recording permission (otherwise you’ll get `PERMISSION_MISSING`).
- `system.notify` posts a user notification and fails if notifications are denied.
- `canvas.*`, `camera.*`, `screen.record`, and `location.get` are also routed via `node.invoke` and follow TCC permission status.

Elevated bash (host permissions) is separate from macOS TCC:

- Use `/elevated on|off` to toggle per‑session elevated access when enabled + allowlisted.
- Gateway persists the per‑session toggle via `sessions.patch` (WS method) alongside `thinkingLevel`, `verboseLevel`, `model`, `sendPolicy`, and `groupActivation`.

Details: [Nodes](https://docs.molt.bot/nodes) · [macOS app](https://docs.molt.bot/platforms/macos) · [Gateway protocol](https://docs.molt.bot/concepts/architecture)

## Agent to Agent (sessions_* tools)

- Use these to coordinate work across sessions without jumping between chat surfaces.
- `sessions_list` — discover active sessions (agents) and their metadata.
- `sessions_history` — fetch transcript logs for a session.
- `sessions_send` — message another session; optional reply‑back ping‑pong + announce step (`REPLY_SKIP`, `ANNOUNCE_SKIP`).

Details: [Session tools](https://docs.molt.bot/concepts/session-tool)

## Chat commands

Send these in Telegram (group commands are owner-only):

- `/status` — compact session status (model + tokens, cost when available)
- `/new` or `/reset` — reset the session
- `/compact` — compact session context (summary)
- `/think <level>` — off|minimal|low|medium|high|xhigh (GPT-5.2 + Codex models only)
- `/verbose on|off`
- `/usage off|tokens|full` — per-response usage footer
- `/restart` — restart the gateway (owner-only in groups)
- `/activation mention|always` — group activation toggle (groups only)

## Apps (optional)

The Gateway alone delivers a great experience. All apps are optional and add extra features.

If you plan to build/run companion apps, follow the platform runbooks below.

### macOS (Moltbot.app) (optional)

- Menu bar control for the Gateway and health.
- Voice Wake + push-to-talk overlay.
- Debug tools.
- Remote gateway control over SSH.

Note: signed builds required for macOS permissions to stick across rebuilds (see `docs/mac/permissions.md`).

### iOS node (optional)

- Pairs as a node via the Bridge.
- Voice trigger forwarding + Canvas surface.
- Controlled via `pnpm moltbot nodes …`.

Runbook: [iOS connect](https://docs.molt.bot/platforms/ios).

### Android node (optional)

- Pairs via the same Bridge + pairing flow as iOS.
- Exposes Canvas, Camera, and Screen capture commands.
- Runbook: [Android connect](https://docs.molt.bot/platforms/android).

## Agent workspace + skills

- Workspace root: `~/clawd` (configurable via `agents.defaults.workspace`).
- Injected prompt files: `AGENTS.md`, `SOUL.md`, `TOOLS.md`.
- Skills: `~/clawd/skills/<skill>/SKILL.md`.

## Configuration

Minimal `~/.clawdbot/moltbot.json` (model + defaults):

```json5
{
  agent: {
    model: "anthropic/claude-opus-4-5"
  }
}
```

[Full configuration reference (all keys + examples).](https://docs.molt.bot/gateway/configuration)

## Security model (important)

- **Default:** tools run on the host for the **main** session, so the agent has full access when it’s just you.
- **Group/channel safety:** set `agents.defaults.sandbox.mode: "non-main"` to run **non‑main sessions** (groups/channels) inside per‑session Docker sandboxes; bash then runs in Docker for those sessions.
- **Sandbox defaults:** allowlist `bash`, `process`, `read`, `write`, `edit`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`; denylist `browser`, `canvas`, `nodes`, `cron`, `gateway`.

Details: [Security guide](https://docs.molt.bot/gateway/security) · [Docker + sandboxing](https://docs.molt.bot/install/docker) · [Sandbox config](https://docs.molt.bot/gateway/configuration)

### [Telegram](https://docs.molt.bot/channels/telegram)

- Set `TELEGRAM_BOT_TOKEN` or `channels.telegram.botToken` (env wins).
- Optional: set `channels.telegram.groups` (with `channels.telegram.groups."*".requireMention`); when set, it is a group allowlist (include `"*"` to allow all). Also `channels.telegram.allowFrom` or `channels.telegram.webhookUrl` as needed.

```json5
{
  channels: {
    telegram: {
      botToken: "123456:ABCDEF"
    }
  }
}
```

Browser control (optional):

```json5
{
  browser: {
    enabled: true,
    color: "#FF4500"
  }
}
```

## Docs

Use these when you’re past the onboarding flow and want the deeper reference.
- [Start with the docs index for navigation and “what’s where.”](https://docs.molt.bot)
- [Read the architecture overview for the gateway + protocol model.](https://docs.molt.bot/concepts/architecture)
- [Use the full configuration reference when you need every key and example.](https://docs.molt.bot/gateway/configuration)
- [Run the Gateway by the book with the operational runbook.](https://docs.molt.bot/gateway)
- [Learn how the Control UI/Web surfaces work and how to expose them safely.](https://docs.molt.bot/web)
- [Understand remote access over SSH tunnels or tailnets.](https://docs.molt.bot/gateway/remote)
- [Follow the onboarding wizard flow for a guided setup.](https://docs.molt.bot/start/wizard)
- [Wire external triggers via the webhook surface.](https://docs.molt.bot/automation/webhook)
- [Set up Gmail Pub/Sub triggers.](https://docs.molt.bot/automation/gmail-pubsub)
- [Learn the macOS menu bar companion details.](https://docs.molt.bot/platforms/mac/menu-bar)
- [Platform guides: Windows (WSL2)](https://docs.molt.bot/platforms/windows), [Linux](https://docs.molt.bot/platforms/linux), [macOS](https://docs.molt.bot/platforms/macos), [iOS](https://docs.molt.bot/platforms/ios), [Android](https://docs.molt.bot/platforms/android)
- [Debug common failures with the troubleshooting guide.](https://docs.molt.bot/channels/troubleshooting)
- [Review security guidance before exposing anything.](https://docs.molt.bot/gateway/security)

## Advanced docs (discovery + control)

- [Discovery + transports](https://docs.molt.bot/gateway/discovery)
- [Bonjour/mDNS](https://docs.molt.bot/gateway/bonjour)
- [Gateway pairing](https://docs.molt.bot/gateway/pairing)
- [Remote gateway README](https://docs.molt.bot/gateway/remote-gateway-readme)
- [Control UI](https://docs.molt.bot/web/control-ui)
- [Dashboard](https://docs.molt.bot/web/dashboard)

## Operations & troubleshooting

- [Health checks](https://docs.molt.bot/gateway/health)
- [Gateway lock](https://docs.molt.bot/gateway/gateway-lock)
- [Background process](https://docs.molt.bot/gateway/background-process)
- [Browser troubleshooting (Linux)](https://docs.molt.bot/tools/browser-linux-troubleshooting)
- [Logging](https://docs.molt.bot/logging)

## Deep dives

- [Agent loop](https://docs.molt.bot/concepts/agent-loop)
- [Presence](https://docs.molt.bot/concepts/presence)
- [TypeBox schemas](https://docs.molt.bot/concepts/typebox)
- [RPC adapters](https://docs.molt.bot/reference/rpc)
- [Queue](https://docs.molt.bot/concepts/queue)

## Workspace & skills

- [Skills config](https://docs.molt.bot/tools/skills-config)
- [Default AGENTS](https://docs.molt.bot/reference/AGENTS.default)
- [Templates: AGENTS](https://docs.molt.bot/reference/templates/AGENTS)
- [Templates: BOOTSTRAP](https://docs.molt.bot/reference/templates/BOOTSTRAP)
- [Templates: IDENTITY](https://docs.molt.bot/reference/templates/IDENTITY)
- [Templates: SOUL](https://docs.molt.bot/reference/templates/SOUL)
- [Templates: TOOLS](https://docs.molt.bot/reference/templates/TOOLS)
- [Templates: USER](https://docs.molt.bot/reference/templates/USER)

## Platform internals

- [macOS dev setup](https://docs.molt.bot/platforms/mac/dev-setup)
- [macOS menu bar](https://docs.molt.bot/platforms/mac/menu-bar)
- [macOS voice wake](https://docs.molt.bot/platforms/mac/voicewake)
- [iOS node](https://docs.molt.bot/platforms/ios)
- [Android node](https://docs.molt.bot/platforms/android)
- [Windows (WSL2)](https://docs.molt.bot/platforms/windows)
- [Linux app](https://docs.molt.bot/platforms/linux)

## Email hooks (Gmail)

- [docs.molt.bot/gmail-pubsub](https://docs.molt.bot/automation/gmail-pubsub)

## Community

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines, governance, and how to submit PRs.

Project by Matthew Overing — see NOTICE.md for upstream attribution.
