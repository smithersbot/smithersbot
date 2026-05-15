---
summary: "How to install SmithersBot from a source checkout"
read_when:
  - You want to install from GitHub
  - You want to automate source installs
---

# Source install

SmithersBot v0 is installed from a local Git checkout. Hosted installer scripts are not part of the GitHub proof release.

## Requirements

- Node.js **22+**
- `pnpm`
- Git

## Install from source

```bash
git clone https://github.com/smithersbot/smithersbot.git
cd smithersbot
pnpm install
pnpm ui:build
pnpm build
pnpm moltbot onboard --install-daemon
```

Run CLI commands from the checkout with `pnpm moltbot ...`:

```bash
pnpm moltbot status
pnpm moltbot health
```

## Automation

```bash
git clone https://github.com/smithersbot/smithersbot.git "$HOME/smithersbot"
cd "$HOME/smithersbot"
pnpm install --frozen-lockfile
pnpm ui:build
pnpm build
```

## Update

```bash
cd ~/smithersbot
git pull --ff-only
pnpm install
pnpm ui:build
pnpm build
```

If the CLI cannot find built files after an update, rerun `pnpm build` from the checkout.
