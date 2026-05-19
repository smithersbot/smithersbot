# Fresh VM Dogfood Checklist

Manual checklist for a new isolated VM named `SmithersBot2`.

Do not put real tokens, real chat IDs, or personal machine paths in committed files. Keep secrets in local VM configuration only.

1. Create or prepare the fresh `SmithersBot2` VM.
2. Confirm the VM is isolated from the operator's primary personal machine.
3. Install Node 22 or newer.
4. Install `git`.
5. Enable Corepack so `pnpm` is available:

   ```bash
   corepack enable
   ```

6. Install Claude Code CLI and/or Codex CLI.
7. Log in to the chosen CLI backend as the operator and confirm it is on `PATH`.
8. Clone the cleaned SmithersBot branch:

   ```bash
   git clone https://github.com/smithersbot/smithersbot.git
   cd smithersbot
   ```

9. Run the setup script and answer the prompts for the Telegram bot token, allowed user/chat ID, and repo-chat backend:

   ```bash
   scripts/setup-smithersbot.sh
   ```

   The script writes local-only config under `~/.smithersbot`, including `~/.smithersbot/.env` and `~/.smithersbot/smithersbot.json`, with file mode `600`.

10. If a non-default state directory is needed, use `SMITHERSBOT_STATE_DIR`.
11. Legacy `MOLTBOT_*` and `CLAWDBOT_*` aliases remain accepted for existing installs, but new setup should use `SMITHERSBOT_*`.
12. Start the gateway from the repository root:

    ```bash
    node scripts/run-node.mjs gateway
    ```

13. In the configured Telegram chat, send `/help`.
14. Send `/commands`.
15. Send `/goal_list`.
16. Set the repo chat backend with one available backend:

    ```text
    /chat_backend codex
    ```

    or

    ```text
    /chat_backend claude_code
    ```

17. Run a repo chat smoke test:

    ```text
    /repo_chat say only: repo chat works
    ```

18. Run a tiny goal smoke test that should not edit files:

    ```text
    /new_goal Inspect the repository state and report whether the working tree is clean. Do not edit files.
    ```

19. After the run starts or completes, verify goal state was written under the active state directory, usually `~/.smithersbot/goals/<run_id>/`.
20. Stop the gateway with `Ctrl-C`.
21. Start the gateway again:

    ```bash
    node scripts/run-node.mjs gateway
    ```

22. Confirm persistence after restart by sending `/goal_list` or `/goal_resume <runId>`.
