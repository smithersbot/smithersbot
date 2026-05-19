# Fresh VM Dogfood Checklist

Manual checklist for a new isolated VM named `SmithersBot2`.

Do not put real tokens, real chat IDs, or personal machine paths in committed files. Keep secrets in local VM configuration only.

1. Create or prepare the fresh `SmithersBot2` VM.
2. Confirm the VM is isolated from the operator's primary personal machine.
3. Install system prerequisites (`git`, `curl`, `ca-certificates`, build tooling).
4. Install Node 22 or newer, then check `node --version` reports `v22.x.x`.
5. Enable Corepack and activate the project's pnpm version (10.23.0):

   ```bash
   sudo corepack enable
   corepack prepare pnpm@10.23.0 --activate
   pnpm --version
   ```

6. Install at least one worker backend CLI. Either is sufficient on its own:

   - Codex CLI (`sudo npm install -g @openai/codex` then `codex login`), or
   - Claude Code CLI (`sudo npm install -g @anthropic-ai/claude-code` then `claude`).

   Confirm the installed backend is on `PATH` and signed in.

7. Clone SmithersBot from the public repository:

   ```bash
   git clone https://github.com/smithersbot/smithersbot.git
   cd smithersbot
   ```

   If the repo is still private for the operator, authenticate with `gh auth login` first, then `gh repo clone smithersbot/smithersbot`. Do not reference dogfood-only branches in public docs.

8. Install dependencies and build:

   ```bash
   pnpm install --frozen-lockfile
   pnpm build
   ```

9. Create the Telegram bot via `@BotFather` and copy the bot token. Do not paste the token into chat. Keep it ready for the next step.

10. Run the setup script. You will only paste the Telegram bot token; the script auto-discovers your private chat ID:

    ```bash
    bash scripts/setup-smithersbot.sh
    ```

    The script:

    - reads the bot token via hidden input (never echoed),
    - calls `getMe` to verify the token and shows `@<bot_username>`,
    - tells you to open the bot and press **Start**,
    - polls `getUpdates` for up to 60s, filters to `message.chat.type === "private"`, prefers the newest update by `update_id`, ignores group/supergroup/channel/edited/callback updates,
    - shows the detected `chat.id` (and `from.id` only when it differs) and asks `Use this Telegram private chat ID for allowFrom? [Y/n]`,
    - on timeout, offers retry or manual entry,
    - on Telegram `409 Conflict` (webhook active), prints actionable `deleteWebhook` instructions and exits,
    - prompts for the repo-chat backend (`codex` or `claude_code`) unless `--backend` was passed,
    - generates a `gateway.auth.token` via `crypto.randomBytes`,
    - writes `~/.smithersbot/.env` and `~/.smithersbot/smithersbot.json` with mode `600`,
    - sets `gateway.mode = "local"` and `channels.telegram.allowFrom = ["<chat id>"]`,
    - prints the next command to run.

11. Install the user-level systemd unit:

    ```bash
    bash scripts/install-smithersbot-user-service.sh
    ```

    The script writes `~/.config/systemd/user/smithersbot-gateway.service` with `EnvironmentFile=%h/.smithersbot/.env`, `WorkingDirectory=<repo path>`, and `ExecStart=<node bin> scripts/run-node.mjs gateway`. It does not reference `moltbot-gateway-dev.service`. A `--dry-run` flag prints the resolved unit without writing it.

12. Start and check the service:

    ```bash
    systemctl --user enable --now smithersbot-gateway.service
    systemctl --user status smithersbot-gateway.service --no-pager
    ```

    The unit reads `~/.smithersbot/.env` and the gateway also auto-loads that file in process. You should not need to `source ~/.smithersbot/.env` anywhere.

13. Tail the logs in a second terminal:

    ```bash
    journalctl --user -u smithersbot-gateway.service -f
    ```

14. In the configured Telegram chat, send:

    ```text
    /help
    /commands
    /goal_list
    ```

15. Set the repo-chat backend with the one you installed:

    ```text
    /chat_backend codex
    ```

    or

    ```text
    /chat_backend claude_code
    ```

16. Run a repo chat smoke test:

    ```text
    /repo_chat say only: repo chat works
    ```

17. Run a tiny read-only goal smoke test:

    ```text
    /new_goal Inspect the repository state and report whether the working tree is clean. Do not edit files.
    ```

    Approve the plan only if it is harmless and read-only. `/new_goal` must not fail with `claude binary not found on PATH` when only Codex is installed; the planner falls through to Codex when Claude Code is absent and vice versa. Post-execution review and manual-test generation use whichever backend is available.

18. Confirm goal artifacts were written under `~/.smithersbot/goals/<run_id>/`.

19. Restart the gateway to verify persistence:

    ```bash
    systemctl --user restart smithersbot-gateway.service
    ```

    Then in Telegram send `/goal_list` (or `/goal_resume <runId>`) and confirm previous state is still visible.

20. Optional: enable lingering so the service starts after reboot without a login session:

    ```bash
    loginctl enable-linger "$USER"
    ```

## Notes

- `SMITHERSBOT_*` env vars are canonical for new installs. Legacy `MOLTBOT_*` and `CLAWDBOT_*` aliases are still accepted for existing installs but should not be used on a fresh VM.
- Worker processes (Codex, Claude Code, repo-chat) never receive Telegram or gateway secrets. The credential-stripping pipeline removes `TELEGRAM_BOT_TOKEN`, `*_GATEWAY_TOKEN`, Slack/Discord tokens, etc., before spawning workers.
- Public runtime output should say SmithersBot. If you see `Moltbot`, `Clawd`, or `moltbot-gateway-dev.service` in fresh-setup banners, doctor output, log paths, or systemd unit names, file it as a Stage 2N regression.
