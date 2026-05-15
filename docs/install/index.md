---
summary: "Install SmithersBot from source"
read_when:
  - Installing SmithersBot
  - You want to install from GitHub
---

# Install

SmithersBot v0 is installed from a source checkout. Hosted installer scripts and npm release packaging are deferred until a later public release stage.

## Quick install from source

```bash
git clone https://github.com/smithersbot/smithersbot.git
cd smithersbot
pnpm install
pnpm ui:build
pnpm build
pnpm moltbot onboard --install-daemon
```

Next step (if you skipped onboarding):

```bash
pnpm moltbot onboard --install-daemon
```

## System requirements

- **Node >=22**
- macOS, Linux, or Windows via WSL2
- `pnpm` only if you build from source

## Choose your install path

### 1) Source checkout

```bash
git clone https://github.com/smithersbot/smithersbot.git
cd smithersbot
pnpm install
pnpm ui:build
pnpm build
```

Run commands from the checkout:

```bash
pnpm moltbot status
pnpm moltbot health
```

Details: [Installer internals](/install/installer).

### 2) Update an existing checkout

```bash
cd ~/smithersbot
git pull --ff-only
pnpm install
pnpm ui:build
pnpm build
```

### 3) From source (contributors/dev)

```bash
git clone https://github.com/smithersbot/smithersbot.git
cd smithersbot
pnpm install
pnpm ui:build # auto-installs UI deps on first run
pnpm build
pnpm moltbot onboard --install-daemon
```

Tip: if you don’t have a global install yet, run repo commands via `pnpm moltbot ...`.

### 4) Other install options

- Docker: [Docker](/install/docker)
- Nix: [Nix](/install/nix)
- Ansible: [Ansible](/install/ansible)
- Bun (CLI only): [Bun](/install/bun)

## After install

- Run onboarding: `pnpm moltbot onboard --install-daemon`
- Quick check: `pnpm moltbot doctor`
- Check gateway health: `pnpm moltbot status` + `pnpm moltbot health`
- Open the dashboard: `pnpm moltbot dashboard`

## Update / uninstall

- Updates: [Updating](/install/updating)
- Migrate to a new machine: [Migrating](/install/migrating)
- Uninstall: [Uninstall](/install/uninstall)
