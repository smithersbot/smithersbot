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
sudo apt install -y git curl ca-certificates gnupg build-essential bubblewrap socat
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

The SmithersBot app checkout can live anywhere on the isolated machine. The
setup wizard will create a separate managed agent workspace for the repo that
workers should read or edit.

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

## 5. Install and sign into Codex or Claude Code

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

## 6. Create a Telegram bot

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

## 7. Run the SmithersBot setup script

From the SmithersBot repo root:

```bash
bash scripts/setup-smithersbot.sh
```

The setup script will:

- verify that it is running from a SmithersBot checkout
- require Node 22.12.0 or newer, `pnpm`, and `git`
- warn if neither Codex nor Claude Code is available yet, then continue with
  install/login-later instructions
- ask "Where should SmithersBot store workspaces, redacted history, and private
  project env files?", defaulting to `~/smithersbot-home`
- create the managed tree under that root
- ask how SmithersBot should address you, defaulting to `sir`
- ask whether there is a repo you would like SmithersBot to work on first:
  this checkout, another local repo path, a repo URL to clone, or **No thanks**
  to add workspaces yourself later
- for a first workspace, ask for a workspace name, defaulting to the actual
  project or repo name such as `smithersbot` for this checkout or `my-app` for
  `https://github.com/acme/my-app.git`
- create or reuse an isolated agent workspace at
  `<managedRoot>/agent/workspaces/<workspaceName>`
- create `<managedRoot>/private/env/<workspaceName>/.env` outside the workspace
  with placeholder-only content and mode `600`
- if you choose **No thanks**, skip creating a first workspace and print the
  paths to use later for agent-editable workspaces and private project env files
- ask for your Telegram bot token
- verify the token
- tell you to open `@<your_bot_username>` (your new bot, **not** `@BotFather`) and press **Start**, or send any message
- detect your Telegram private chat ID automatically
- ask you to confirm the detected ID
- create `~/.smithersbot/.env`
- create `~/.smithersbot/smithersbot.json`
- store `agents.defaults.identity.operatorHonorific` in the generated config
  and, when you create or reuse a first workspace, store that workspace as the
  default
- generate a gateway auth token
- set `gateway.mode` to `local`
- set file permissions to `600`
- ask whether SmithersBot should run in the background and keep working after
  you close the terminal, defaulting to yes
- when accepted, install and start the user service
  `smithersbot-gateway.service`; when declined, print the manual gateway command

The script proceeds step by step and does not end with an extra setup summary
screen.

When the script tells you to open your bot, go to Telegram and open the bot username you created (the one ending in `bot`, **not** `@BotFather`), then press **Start** or send any message.

Then return to the terminal and continue.

The honorific prompt accepts a name, `boss`, or a blank value for no honorific.
Leaving the prompt at its default writes `operatorHonorific: "sir"` and produces
the default Telegram preface, `Right away, sir.`

The setup wizard is a shell wizard for launch, not a TUI.

## 8. Run Telegram smoke tests

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

Then:

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

Once these tests pass, SmithersBot is ready to use.

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

## Where Files Live

SmithersBot uses two roots: a gateway-private state directory and a managed
agent root. The gateway-private state directory stores SmithersBot's own
credentials and runtime state. The managed agent root stores project workspaces,
redacted history, and host-side project secrets outside the agent-readable tree.

### Gateway-Private State

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

### Managed Agent Root

The managed root defaults to `~/smithersbot-home` and is overridable with
`SMITHERSBOT_GOALS_ROOT`. Existing installs that used the former default
`~/smithersbot-goals` are still respected when `~/smithersbot-home` is absent
and the override is unset. It separates the agent-readable area from a private
area that workers never see:

```text
~/smithersbot-home/
  agent/
    workspaces/<workspace-name>/        # project files agents can read/edit
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

Agent read/edit rule: anything you want SmithersBot agents to read or edit must live inside a managed workspace:
`~/smithersbot-home/agent/workspaces/<workspace-name>`. Files outside managed
workspaces are not part of the agent's normal read/edit surface. Keep separate
projects in separate workspace folders. Keep a redacted `.env.example` in each
project workspace, and never put API keys or secrets anywhere under `agent/`.
Existing legacy `workspaces/<workspace-name>/repo` workspaces are still
supported.

Secret model: `~/.smithersbot/.env` is for SmithersBot/gateway secrets such as
the Telegram bot token. Project/workspace secrets belong in
`~/smithersbot-home/private/env/<workspace-name>/.env`, which is not
agent-visible. Private env, config, auth, and session files live outside the
workspace.

Managed workspaces organize access for workers and repo chat, but are not by themselves a kernel boundary. Backend-native sandboxing is configured per worker; if it cannot be established, workers fail and escalate to the user by blocking the task. Backend-specific live probes can confirm sandbox behavior on a host.

Prompts and convention files are not security boundaries. Codex `--sandbox workspace-write` alone is
not treated as a complete security boundary. Claude sandboxing requires its native sandbox
support to be available and verified.

### Portability rule for project code

Project code committed by goal workers must read configuration through standard
environment variables — for example `process.env.GOOGLE_DRIVE_API_KEY` (Node) or
`os.environ["GOOGLE_DRIVE_API_KEY"]` (Python). The repo-root `.env.example` is
the portable variable-name contract — it must contain placeholder values only.

Workers do NOT receive raw secrets in env by default. Real env files at
`~/smithersbot-home/private/env/<workspace-name>/.env` may only be loaded by
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
path (`~/smithersbot-home/agent/workspaces/<workspace-name>`).

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
`~/smithersbot-home/private/env/<workspace-name>/.env`. That tree is not
agent-visible and is loaded only by trusted host-side commands. Project code
inside `~/smithersbot-home/agent/workspaces/<workspace-name>` should read
configuration through normal environment variables and document variable names
in the repo's `.env.example`.

Goal and repo-chat history under `~/smithersbot-home/agent/history` is a
redacted audit trail for prompts, events, and runtime indexes. It is meant for
inspection, not secret storage. Native backend sandboxing is configured per
worker, and workers fail and block the task if backend-native sandboxing cannot
be established. The backend-specific live probes can confirm sandbox behavior on a
host; prompts, convention files, and managed workspace paths are not kernel
security boundaries.

## Troubleshooting

### I declined background service setup

If you declined background service setup, install the user service manually from the SmithersBot repo root:

```bash
bash scripts/install-smithersbot-user-service.sh
```

Start SmithersBot:

```bash
systemctl --user enable --now smithersbot-gateway.service
```

Check status:

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

If systemd is unavailable or you prefer foreground mode, run the gateway directly from the SmithersBot app checkout:

```bash
node scripts/run-node.mjs gateway
```

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
