# SmithersBot Setup

SmithersBot should be run from an isolated environment, not directly on your primary personal computer.

Good options:

- VirtualBox VM
- VPS
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
v22.12.0 or newer
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
- tell you to open `@<your_bot_username>` (your new bot, **not** `@BotFather`) and press **Start**, or send any message
- detect your Telegram private chat ID automatically
- ask you to confirm the detected ID
- create `~/.smithersbot/.env`
- create `~/.smithersbot/smithersbot.json`
- generate a gateway auth token
- set `gateway.mode` to `local`
- set file permissions to `600`
- print the next command to run

When the script tells you to open your bot, go to Telegram and open the bot username you created (the one ending in `bot`, **not** `@BotFather`), then press **Start** or send any message.

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

`/gateway_restart` resolves the active user service during the migration. The
explicit env precedence is `SMITHERSBOT_SYSTEMD_UNIT`, then deprecated
`MOLTBOT_SYSTEMD_UNIT`, then deprecated `CLAWDBOT_SYSTEMD_UNIT`; otherwise
SmithersBot detects active units including `smithersbot-gateway.service` and
legacy `moltbot-gateway-dev.service`.

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
/gateway_status
```

Then:

```text
/usage_status
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

If the goal blocks with a question, answer by replying to the bot, tapping
**Add Details**, or sending `/goal_answer <runId> <answer>`.

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

SmithersBot uses two roots: a gateway-private state directory and a managed
agent root. Stage 2S introduces the managed agent root as the new default for
new goal workspaces; existing installs that still use only `~/.smithersbot`
continue to work without changes.

### Gateway-private state (unchanged)

Gateway credentials, the Telegram bot token, and the canonical runtime stores
for goals and repo-chats live here:

```text
~/.smithersbot/
~/.smithersbot/.env
~/.smithersbot/smithersbot.json
~/.smithersbot/goals/
~/.smithersbot/repo-chats/
```

Workers never read this tree directly.

### Managed agent root (Stage 2S, transitional)

The managed root defaults to `~/smithersbot-goals` and is overridable with
`SMITHERSBOT_GOALS_ROOT`. It separates the agent-readable area from a private
area that workers never see:

```text
~/smithersbot-goals/
  agent/
    workspaces/<workspace-name>/repo/   # where goal workers run
    history/
      goals/<workspace>/<goalId>/       # sanitized goal-run summaries
      repo-chats/<workspace>/           # sanitized repo-chat sessions
      index/                            # global JSONL indexes for search
  private/
    env/<workspace-name>/.env           # real env, host-side only
    config/
    auth/
    sessions/
  scratch/<runId>/<taskId>/             # gateway-controlled temp state
```

Agent read/edit rule: anything you want SmithersBot agents to read or edit must live inside a managed workspace repo:
`~/smithersbot-goals/agent/workspaces/<workspace-name>/repo`. Files outside
managed workspaces are not part of the agent's normal read/edit surface. Private
env, config, auth, and session files live outside the workspace and are not agent-visible.

Stage 2S is intentionally transitional:

- New/default goal workspaces resolve inside the managed agent root.
- Managed workspaces organize access for workers and repo chat, but are not by
  themselves a kernel boundary.
- Legacy `workingDir` values (including `~/moltbot` or any path outside the
  managed root) are still supported and emit a one-line warning. You can opt
  into fail-closed behavior with `config.goal.allowLegacyWorkingDir = false`.
- Native backend sandboxing is used only where SmithersBot implements and
  verifies it for the selected backend. Codex and Claude Code secret-read
  isolation is claimed only after backend-specific live probes pass on the host;
  otherwise that backend remains unproven or blocked on the reported operator
  action. Codex `--sandbox workspace-write` alone is not enough evidence of
  secret-read isolation, and Claude sandboxing requires its native sandbox to
  start successfully. Prompts and convention files are not security boundaries.

### Portability rule for project code

Project code committed by goal workers must read configuration through standard
environment variables — for example `process.env.GOOGLE_DRIVE_API_KEY` (Node) or
`os.environ["GOOGLE_DRIVE_API_KEY"]` (Python). The repo-root `.env.example` is
the portable variable-name contract — it must contain placeholder values only.

Workers do NOT receive raw secrets in env by default. Real env files at
`~/smithersbot-goals/private/env/<workspace-name>/.env` may only be loaded by
trusted host-side commands (gateway-side flows) with an explicit, narrowly-scoped
opt-in. Worker subprocesses never see those values unless that opt-in is set.
Runtime artifacts are mirrored in redacted form under `agent/history`, including
prompt artifacts, events, and runtime indexes that make runs inspectable without
exposing private gateway config, env, auth, or session data.

### Initial setup order

`scripts/setup-smithersbot.sh` creates the managed tree on first run, including
`agent/workspaces`, `agent/history/{goals,repo-chats,index}`,
`private/{env,config,auth,sessions}`, and `scratch`, and applies `chmod 0700` to
the managed root and `private/*` where practical. If you run setup from a repo
outside the managed root, the script prints the recommended managed workspace
path (`~/smithersbot-goals/agent/workspaces/<repo>/repo`).

### Permission check

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

Real env files for managed workspaces live at
`~/smithersbot-goals/private/env/<workspace-name>/.env`. That tree is not
agent-visible and is loaded only by trusted host-side commands. Project code
inside `~/smithersbot-goals/agent/workspaces/<workspace-name>/repo` should read
configuration through normal environment variables and document variable names
in the repo's `.env.example`.

Goal and repo-chat history under `~/smithersbot-goals/agent/history` is a
redacted audit trail for prompts, events, and runtime indexes. It is meant for
inspection, not secret storage. Native backend sandboxing is used only where
SmithersBot has implemented and live-probed it; prompts, convention files, and
managed workspace paths are not kernel security boundaries.

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

### `Planning failed: No worker backend available`

SmithersBot needs at least one worker backend available to the gateway service: Codex or Claude Code. If both are installed, planning uses the normal Claude-then-Codex flow. If only one is installed, planning and post-goal review use that one.

Install or fix Codex:

```bash
codex "say only: codex works"
```

Install or fix Claude Code:

```bash
sudo npm install -g @anthropic-ai/claude-code
claude
```

### Runtime says Moltbot, Clawdbot, or Clawd

Public runtime output should say SmithersBot. Old names may remain as compatibility aliases or attribution, but fresh setup should not show old branding in banners, doctor output, service names, log paths, Bonjour names, or setup instructions.
