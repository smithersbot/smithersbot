---
summary: "Setup guide: keep your Moltbot setup tailored while staying up-to-date"
read_when:
  - Setting up a new machine
  - You want “latest + greatest” without breaking your personal setup
---

# Setup

Last updated: 2026-01-01

## TL;DR
- **Tailoring lives outside the repo:** `~/.smithersbot/workspace` (workspace) + `~/.smithersbot/moltbot.json` (config). (v0 paths)
- **Stable workflow:** install the macOS app; let it run the bundled Gateway.
- **Bleeding edge workflow:** run the Gateway yourself via `pnpm gateway:watch`, then let the macOS app attach in Local mode.

## Prereqs (from source)
- Node `>=22`
- `pnpm`
- Docker (optional; only for containerized setup/e2e — see [Docker](/install/docker))

## Tailoring strategy (so updates don’t hurt)

If you want “100% tailored to me” *and* easy updates, keep your customization in:

- **Config:** `~/.smithersbot/moltbot.json` (JSON/JSON5-ish) — v0 path
- **Workspace:** `~/.smithersbot/workspace` (skills, prompts, memories; make it a private git repo) — v0 path

Bootstrap once:

```bash
moltbot setup
```

From inside this repo, use the local CLI entry:

```bash
moltbot setup
```

If you don’t have a global install yet, run it via `pnpm moltbot setup`.

## Stable workflow (macOS app first)

1) Install + launch **Moltbot.app** (menu bar).
2) Complete the onboarding/permissions checklist (TCC prompts).
3) Ensure Gateway is **Local** and running (the app manages it).
4) Link surfaces (example: WhatsApp):

```bash
moltbot channels login
```

5) Sanity check:

```bash
moltbot health
```

If onboarding is not available in your build:
- Run `moltbot setup`, then `moltbot channels login`, then start the Gateway manually (`moltbot gateway`).

## Bleeding edge workflow (Gateway in a terminal)

Goal: work on the TypeScript Gateway, get hot reload, keep the macOS app UI attached.

### 0) (Optional) Run the macOS app from source too

If you also want the macOS app on the bleeding edge:

```bash
./scripts/restart-mac.sh
```

### 1) Start the dev Gateway

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch` runs the gateway in watch mode and reloads on TypeScript changes.

### 2) Point the macOS app at your running Gateway

In **Moltbot.app**:

- Connection Mode: **Local**
The app will attach to the running gateway on the configured port.

### 3) Verify

- In-app Gateway status should read **“Using existing gateway …”**
- Or via CLI:

```bash
moltbot health
```

### Common footguns
- **Wrong port:** Gateway WS defaults to `ws://127.0.0.1:18789`; keep app + CLI on the same port.
- **Where state lives:**
  - Credentials: `~/.smithersbot/credentials/` (v0 path)
  - Sessions: `~/.smithersbot/agents/<agentId>/sessions/` (v0 path)
  - Logs: `/tmp/moltbot/`

## Credential storage map

Use this when debugging auth or deciding what to back up:

- **WhatsApp**: `~/.smithersbot/credentials/whatsapp/<accountId>/creds.json` (v0 path)
- **Telegram bot token**: config/env or `channels.telegram.tokenFile`
- **Discord bot token**: config/env (token file not yet supported)
- **Slack tokens**: config/env (`channels.slack.*`)
- **Pairing allowlists**: `~/.smithersbot/credentials/<channel>-allowFrom.json` (v0 path)
- **Model auth profiles**: `~/.smithersbot/agents/<agentId>/agent/auth-profiles.json` (v0 path)
- **Legacy OAuth import**: `~/.smithersbot/credentials/oauth.json` (v0 path)
More detail: [Security](/gateway/security#credential-storage-map).

## Updating (without wrecking your setup)

- Keep `~/.smithersbot/` (v0 path) as “your stuff”; don’t put personal prompts/config into the repo.
- Updating source: `git pull` + `pnpm install` (when lockfile changed) + keep using `pnpm gateway:watch`.

## Linux (systemd user service)

Linux installs use a systemd **user** service. By default, systemd stops user
services on logout/idle, which kills the Gateway. Onboarding attempts to enable
lingering for you (may prompt for sudo). If it’s still off, run:

```bash
sudo loginctl enable-linger $USER
```

For always-on or multi-user servers, consider a **system** service instead of a
user service (no lingering needed). See [Gateway runbook](/gateway) for the systemd notes.

## Related docs

- [Gateway runbook](/gateway) (flags, supervision, ports)
- [Gateway configuration](/gateway/configuration) (config schema + examples)
- [Discord](/channels/discord) and [Telegram](/channels/telegram) (reply tags + replyToMode settings)
- [Moltbot assistant setup](/start/clawd)
- [macOS app](/platforms/macos) (gateway lifecycle)
