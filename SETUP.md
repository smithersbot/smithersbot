# SmithersBot Setup

SmithersBot should be run from an isolated environment, not directly on your primary personal computer.

Good options:

- VirtualBox VM
- VPS
- Docker container
- dedicated machine
- isolated development machine

The goal is to give agents useful access to a working directory, not unnecessary access to your whole life.

## What you need

- Linux environment
- Telegram account
- GitHub account, if you are cloning a private repo
- Codex account, Claude account, or both

SmithersBot needs at least one worker backend:

- Codex CLI, or
- Claude Code CLI

Codex-only is valid. Claude Code-only is valid. Both is recommended.

## 1. Install system packages

On Ubuntu:

```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y git curl ca-certificates gnupg build-essential
```

## 2. Install Node 22

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

Check it:

```bash
node --version
npm --version
```

Expected:

```text
v22.x.x
```

## 3. Install pnpm

Try Corepack first:

```bash
sudo corepack enable
corepack prepare pnpm@10.23.0 --activate
pnpm --version
```

If `pnpm` is still not available, use npm:

```bash
sudo npm install -g pnpm@10.23.0
pnpm --version
```

Expected:

```text
10.23.0
```

## 4. Clone SmithersBot

After SmithersBot is public:

```bash
git clone https://github.com/smithersbot/smithersbot.git
cd smithersbot
```

If the repo is still private, authenticate with GitHub CLI first:

```bash
sudo apt install -y gh
gh auth login
gh auth setup-git
gh auth status
```

Then clone:

```bash
gh repo clone smithersbot/smithersbot
cd smithersbot
```

Confirm you are in the repo:

```bash
node -p "require('./package.json').name"
```

Expected:

```text
smithersbot
```

## 5. Install and build SmithersBot

```bash
pnpm install --frozen-lockfile
pnpm build
```

If either command fails, stop and fix that before continuing.

## 6. Install and sign into Codex or Claude Code

You need at least one of these.

### Option A: Codex CLI

Install Codex:

```bash
sudo npm install -g @openai/codex
codex --version
```

Sign in:

```bash
codex login
```

Test it:

```bash
codex "say only: codex works"
```

Expected response:

```text
codex works
```

### Option B: Claude Code CLI

Install Claude Code:

```bash
sudo npm install -g @anthropic-ai/claude-code
claude --version
```

Sign in:

```bash
claude
```

Follow the login flow.

Then test it:

```bash
claude -p "say only: claude works"
```

Expected response:

```text
claude works
```

You can install both Codex and Claude Code, but only one is required.

## 7. Create a Telegram bot

Open Telegram.

Message the official BotFather:

```text
@BotFather
```

Create a new bot:

```text
/newbot
```

When BotFather asks for a display name, enter something like:

```text
SmithersBot
```

When BotFather asks for a username, enter a unique username ending in `bot`, for example:

```text
your_smithersbot_bot
```

BotFather will give you a token that looks like:

```text
1234567890:AA...
```

Keep that token private. You will paste it into the setup script in the next step.

## 8. Run the SmithersBot setup script

From the SmithersBot repo root:

```bash
bash scripts/setup-smithersbot.sh
```

The setup script will:

- ask for your Telegram bot token
- verify the token
- tell you to open your new Telegram bot and press **Start**
- detect your Telegram private chat ID automatically
- ask you to confirm the detected ID
- create `~/.smithersbot/.env`
- create `~/.smithersbot/smithersbot.json`
- generate a gateway auth token
- set `gateway.mode` to `local`
- set file permissions to `600`
- print the next command to run

When the script tells you to open your bot, go to Telegram, open the bot username you created, and press **Start**.

Then return to the terminal and continue.

## 9. Install the SmithersBot background service

From the SmithersBot repo root:

```bash
bash scripts/install-smithersbot-user-service.sh
```

Start the service:

```bash
systemctl --user enable --now smithersbot-gateway.service
```

Check that it is running:

```bash
systemctl --user status smithersbot-gateway.service --no-pager
```

View logs:

```bash
journalctl --user -u smithersbot-gateway.service -f
```

To stop following logs, press:

```text
Ctrl-C
```

That only stops the log view. It does not stop SmithersBot.

## 10. Run Telegram smoke tests

Open your SmithersBot Telegram bot and send:

```text
/help
```

Then:

```text
/commands
```

Then:

```text
/goal_list
```

Set your repo chat backend.

For Codex:

```text
/chat_backend codex
```

For Claude Code:

```text
/chat_backend claude_code
```

Test repo chat:

```text
/repo_chat say only: repo chat works
```

Test a tiny goal:

```text
/new_goal Inspect the repository state and report whether the working tree is clean. Do not edit files.
```

Approve the plan only if it is harmless and read-only.

## 11. Restart test

Restart the gateway:

```bash
systemctl --user restart smithersbot-gateway.service
```

Then in Telegram:

```text
/goal_list
```

You should still see previous goal state.

## 12. Optional: start SmithersBot after reboot

If you want the user service to start after reboot without you opening a terminal first:

```bash
loginctl enable-linger "$USER"
```

Then reboot and check:

```bash
systemctl --user status smithersbot-gateway.service --no-pager
```

## Daily commands

Restart SmithersBot:

```bash
systemctl --user restart smithersbot-gateway.service
```

Stop SmithersBot:

```bash
systemctl --user stop smithersbot-gateway.service
```

Start SmithersBot:

```bash
systemctl --user start smithersbot-gateway.service
```

View logs:

```bash
journalctl --user -u smithersbot-gateway.service -f
```

## Where files live

SmithersBot stores local config and state here:

```text
~/.smithersbot/
```

Important files and directories:

```text
~/.smithersbot/.env
~/.smithersbot/smithersbot.json
~/.smithersbot/goals/
~/.smithersbot/repo-chats/
```

Check permissions:

```bash
ls -l ~/.smithersbot/.env ~/.smithersbot/smithersbot.json
```

Expected:

```text
-rw-------
```

## Security notes

Do not commit tokens or local config files.

Do not paste your Telegram bot token into chat.

Do not run SmithersBot directly on your primary personal machine.

Run it in an isolated environment.

The gateway needs the Telegram token, but worker processes should not receive Telegram or config secrets.

## Troubleshooting

### `corepack: command not found`

Node is missing or installed incorrectly.

Run:

```bash
node --version
```

If Node is missing, reinstall Node 22:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

### `pnpm: command not found`

Try:

```bash
sudo corepack enable
corepack prepare pnpm@10.23.0 --activate
```

Fallback:

```bash
sudo npm install -g pnpm@10.23.0
```

### Private repo clone fails

Authenticate GitHub CLI:

```bash
gh auth login
gh auth setup-git
gh auth status
```

Then clone again.

### Telegram does not respond

Check the service:

```bash
systemctl --user status smithersbot-gateway.service --no-pager
```

Check logs:

```bash
journalctl --user -u smithersbot-gateway.service -f
```

Make sure you pressed **Start** in the Telegram bot chat.

### Repo chat works, but `/new_goal` fails

Check installed backends:

```bash
command -v codex || true
command -v claude || true
```

At least one should exist.

Test Codex:

```bash
codex "say only: codex works"
```

Test Claude Code:

```bash
claude -p "say only: claude works"
```

### `Planning failed: claude binary not found on PATH`

Claude Code is not installed or not available to the service.

If you want Claude Code:

```bash
sudo npm install -g @anthropic-ai/claude-code
claude
```

If you want Codex-only, SmithersBot should fall back to Codex.

### Runtime says Moltbot, Clawdbot, or Clawd

Public runtime output should say SmithersBot. Old names may remain as compatibility aliases or attribution, but fresh setup should not show old branding in banners, doctor output, service names, log paths, Bonjour names, or setup instructions.
