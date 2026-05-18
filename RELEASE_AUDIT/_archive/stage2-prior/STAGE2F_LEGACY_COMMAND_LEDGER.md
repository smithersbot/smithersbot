# Stage 2F Legacy Command And Hook Ledger

This ledger records every command, alias, or hook that Stage 2F hid, deferred,
or kept only for compatibility, so a later cleanup stage can delete the
underlying code safely. Nothing in this ledger has been deleted by Stage 2F;
handlers remain reachable unless explicitly stated.

The canonical public-menu source of truth is
[`src/telegram/public-menu.ts`](../src/telegram/public-menu.ts). Telegram's
`setMyCommands` payload is filtered through `buildPublicTelegramMenu` in
[`src/telegram/bot-native-commands.ts`](../src/telegram/bot-native-commands.ts);
`/help` and `/commands` render from the same module in
[`src/auto-reply/status.ts`](../src/auto-reply/status.ts).

## A. Hidden Legacy Commands

These commands continue to have grammy/native handlers but no longer appear in
the public Telegram menu and are not advertised by `/help` or `/commands`.

| Command       | Current handler path                                                        | Why hidden                                                | Handler remains | Tests that still cover it                              | Recommended future action |
| ------------- | --------------------------------------------------------------------------- | --------------------------------------------------------- | --------------- | ------------------------------------------------------ | ------------------------- |
| `/new`        | `src/auto-reply/commands-registry.data.ts` key `new`, native `new`          | Legacy session-reset surface, not the v0 goal flow        | Yes             | `src/auto-reply/commands-registry.test.ts`             | Investigate, then delete  |
| `/reset`      | `src/auto-reply/commands-registry.data.ts` key `reset`, native `reset`      | Duplicate of `/new`; not the v0 goal flow                 | Yes             | `src/auto-reply/commands-registry.test.ts`             | Investigate, then delete  |
| `/stop`       | `src/auto-reply/commands-registry.data.ts` key `stop`, native `stop`        | v0 operators must use `/goal_stop`                        | Yes             | `src/auto-reply/commands-registry.test.ts`             | Investigate, then delete  |
| `/status`     | `src/auto-reply/commands-registry.data.ts` key `status`, native `status`    | Legacy session status, not goal status                    | Yes             | `src/auto-reply/status.test.ts` for the renderer       | Keep internal             |
| `/skill`      | `src/auto-reply/commands-registry.data.ts` key `skill`, native `skill`      | Skill-handle internals, not v0 surface                    | Yes             | `src/auto-reply/skill-commands*.test.ts`               | Keep internal             |
| `/approve`    | `src/auto-reply/commands-registry.data.ts` key `approve`, native `approve`  | Legacy approve; goal uses `/goal_approve` and inline UX   | Yes             | `src/auto-reply/commands-registry.test.ts`             | Investigate, then delete  |
| `/context`    | `src/auto-reply/commands-registry.data.ts` key `context`, native `context`  | Legacy session context, not v0 surface                    | Yes             | `src/auto-reply/commands-registry.test.ts`             | Keep internal             |
| `/tts`        | `src/auto-reply/commands-registry.data.ts` key `tts`, native `tts`          | TTS toggle, not part of v0 operator surface               | Yes             | `src/tts/*.test.ts`                                    | Keep internal             |
| `/whoami`     | `src/auto-reply/commands-registry.data.ts` key `whoami`, native `whoami`    | Debug helper, not part of v0 menu                         | Yes             | `src/telegram/bot-native-commands.plugin-auth.test.ts` | Keep internal             |
| `/id`         | `src/auto-reply/commands-registry.data.ts` alias of `whoami`                | Same as `/whoami`                                         | Yes             | `src/auto-reply/commands-registry.test.ts`             | Keep internal             |
| `/subagents`  | `src/auto-reply/commands-registry.data.ts` key `subagents`                  | Subagent introspection, not v0 menu                       | Yes             | `src/auto-reply/commands-registry.test.ts`             | Keep internal             |
| `/config`     | `src/auto-reply/commands-registry.data.ts` key `config`                     | Settings probe, not v0 menu                               | Yes             | `src/auto-reply/commands-registry.test.ts`             | Keep internal             |
| `/debug`      | `src/auto-reply/commands-registry.data.ts` key `debug`                      | Diagnostics, not v0 menu                                  | Yes             | `src/auto-reply/commands-registry.test.ts`             | Keep internal             |
| `/usage`      | `src/auto-reply/commands-registry.data.ts` key `usage`                      | Token-usage introspection, not v0 menu                    | Yes             | `src/auto-reply/commands-registry.test.ts`             | Keep internal             |
| `/restart`    | `src/auto-reply/commands-registry.data.ts` key `restart`                    | Legacy session restart, not the gateway restart           | Yes             | `src/auto-reply/commands-registry.test.ts`             | Investigate, then delete  |
| `/activation` | `src/auto-reply/commands-registry.data.ts` key `activation`                 | Activation toggle, not v0 menu                            | Yes             | `src/auto-reply/commands-registry.test.ts`             | Keep internal             |
| `/send`       | `src/auto-reply/commands-registry.data.ts` key `send`                       | Manual outbound send, not v0 menu                         | Yes             | `src/auto-reply/commands-registry.test.ts`             | Keep internal             |
| `/compact`    | `src/auto-reply/commands-registry.data.ts` key `compact`                    | Conversation compaction, not v0 menu                      | Yes             | `src/auto-reply/commands-registry.test.ts`             | Keep internal             |
| `/think`      | `src/auto-reply/commands-registry.data.ts` key `think`, native `think`      | Thinking-level toggle, not v0 menu                        | Yes             | `src/auto-reply/commands-registry.test.ts`             | Keep internal             |
| `/thinking`   | `src/auto-reply/commands-registry.data.ts` alias of `think`                 | Same as `/think`                                          | Yes             | `src/auto-reply/commands-registry.test.ts`             | Keep internal             |
| `/t`          | `src/auto-reply/commands-registry.data.ts` alias of `think`                 | Same as `/think`                                          | Yes             | `src/auto-reply/commands-registry.test.ts`             | Keep internal             |
| `/verbose`    | `src/auto-reply/commands-registry.data.ts` key `verbose`                    | Verbosity toggle, not v0 menu                             | Yes             | `src/auto-reply/commands-registry.test.ts`             | Keep internal             |
| `/v`          | `src/auto-reply/commands-registry.data.ts` alias of `verbose`               | Same as `/verbose`                                        | Yes             | `src/auto-reply/commands-registry.test.ts`             | Keep internal             |
| `/reasoning`  | `src/auto-reply/commands-registry.data.ts` key `reasoning`                  | Reasoning-level toggle, not v0 menu                       | Yes             | `src/auto-reply/commands-registry.test.ts`             | Keep internal             |
| `/reason`     | `src/auto-reply/commands-registry.data.ts` alias of `reasoning`             | Same as `/reasoning`                                      | Yes             | `src/auto-reply/commands-registry.test.ts`             | Keep internal             |
| `/elevated`   | `src/auto-reply/commands-registry.data.ts` key `elevated`                   | Elevation toggle, not v0 menu                             | Yes             | `src/auto-reply/commands-registry.test.ts`             | Keep internal             |
| `/elev`       | `src/auto-reply/commands-registry.data.ts` alias of `elevated`              | Same as `/elevated`                                       | Yes             | `src/auto-reply/commands-registry.test.ts`             | Keep internal             |
| `/exec`       | `src/auto-reply/commands-registry.data.ts` key `exec`                       | Execution-mode toggle, not v0 menu                        | Yes             | `src/auto-reply/commands-registry.test.ts`             | Keep internal             |
| `/model`      | `src/auto-reply/commands-registry.data.ts` key `model`                      | Model selection, not v0 menu                              | Yes             | `src/auto-reply/commands-registry.test.ts`             | Keep internal             |
| `/models`     | `src/auto-reply/commands-registry.data.ts` key `models`                     | Model list, not v0 menu                                   | Yes             | `src/auto-reply/commands-registry.test.ts`             | Keep internal             |
| `/queue`      | `src/auto-reply/commands-registry.data.ts` key `queue`                      | Inbound queue diagnostics, not v0 menu                    | Yes             | `src/auto-reply/commands-registry.test.ts`             | Keep internal             |
| `/allowlist`  | `src/auto-reply/commands-registry.data.ts` key `allowlist`                  | Access-list probe, not v0 menu                            | Yes             | `src/auto-reply/commands-registry.test.ts`             | Keep internal             |
| `/bash`       | `src/auto-reply/commands-registry.data.ts` key `bash`                       | Host shell execution; sensitive surface, not v0 menu      | Yes             | `src/auto-reply/commands-registry.test.ts`             | Investigate, then delete  |
| `/create_repo`| `src/telegram/create-repo-command.ts`                                       | GitHub repo bootstrap; admin-only, not part of v0 menu    | Yes             | `src/telegram/create-repo-command*.test.ts`            | Keep internal             |
| Dock/plugin/skill text commands | `src/auto-reply/commands-registry.data.ts` and plugin/skill registries | Configurable per-deployment; not on the SmithersBot v0 public menu unless explicitly configured | Yes — plugin commands still register native handlers and render under a Plugins group when present; dock/skill text commands keep their text aliases | `src/plugins/commands.test.ts`, `src/auto-reply/skill-commands*.test.ts` | Keep internal               |

## B. Hidden Fallback Goal Commands

These goal commands continue to register grammy handlers (still reachable from
the slash surface) but are intentionally absent from the public Telegram menu.
The primary UX is inline buttons, reply prompts, and callback handlers.

| Command          | Primary UX replacement                                                                                | Why handler remains                                                          | Future deletion risk |
| ---------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------- |
| `/goal_approve`  | Inline Approve button on the plan card; `/goal_resume` is also wired as an approve alias              | Slash fallback when buttons fail or operator copies a runId from `/goal_list`| Low                  |
| `/goal_reject`   | Inline Reject button on the plan card                                                                 | Slash fallback for explicit reject from a runId                              | Low                  |
| `/goal_edit`     | Inline Edit reply prompt; users typically reply to the bot's edit prompt rather than typing the slash | Slash fallback when reply prompt cannot be opened or for scripting           | Low                  |
| `/goal_answer`   | Inline reply prompt opened when a step asks a clarification question                                  | Slash fallback noted in the question card itself                             | Low                  |
| `/goal_feedback` | Inline reply prompt offered after a step or run completes                                             | Slash fallback for manual feedback when reply prompt is unavailable          | Low                  |
| `/goal_detail`   | Inline status/detail navigation from `/goal_list` and notifications                                   | Slash fallback for power users to inspect a specific runId                   | Low                  |

## C. Removed Or Hidden Aliases

| Alias  | Target command | Action taken                                                                                                                                  | Tests updated                                                            | Future action            |
| ------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------ |
| `/goal`| `/new_goal`    | Kept hidden. `bot.command(["new_goal", "goal"], ...)` in `src/telegram/goal-commands.ts` still registers both names; `/goal` is not in `PUBLIC_TELEGRAM_MENU` and is not rendered by `/help` or `/commands`. | `src/telegram/bot-native-commands.plugin-auth.test.ts` asserts the `/goal` handler remains reachable while the alias is absent from the public menu | Investigate, then delete |
| `/rc`  | `/repo_chat`   | Kept hidden. `bot.command(["repo_chat", "rc"], ...)` in `src/telegram/repo-chat-commands.ts` still registers both names; `/rc` is not in `PUBLIC_TELEGRAM_MENU` and is not rendered by `/help` or `/commands`. | `src/telegram/bot-native-commands.plugin-auth.test.ts` asserts the `/rc` handler remains reachable while the alias is absent from the public menu | Investigate, then delete |

Neither alias is documented publicly in README, AGENTS, `/help`, or
`/commands`. The grammy multi-name registration was left intact rather than
threading an alias-removal change through goal/repo-chat tests for Stage 2F.

## D. Hook Decisions

The hook loader, config resolver, workspace bootstrap, and bundled hook
directories were not touched. Documentation was updated in
[`src/hooks/bundled/README.md`](../src/hooks/bundled/README.md) to mark every
bundled hook as deferred/internal-only and to clarify that the bundled
`session-memory` hook is not the same surface as goal lessons.

| Hook            | Trigger                                  | Current status                                | Action taken in Stage 2F                                                              | Affects `/new_goal`? | Future action                                                                                  |
| --------------- | ---------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------- |
| `boot-md`       | `gateway:startup`                        | Deferred; ships disabled until opt-in         | README marked deferred/internal-only with a note that it is not part of the v0 story  | No                   | Investigate whether the gateway startup pipeline still needs this hook; otherwise delete       |
| `command-logger`| `command`                                | Deferred; ships disabled until opt-in         | README marked deferred/internal-only and called out as logging legacy command events   | No                   | Delete once legacy command surface is removed; the audit log targets `/new`/`/reset`/`/stop`   |
| `session-memory`| `command:new`                            | Deferred; ships disabled until opt-in         | README marked deferred/internal-only with an explicit "this is not goal lessons" note | No                   | Investigate whether anyone relies on the chat-session memory file; otherwise delete            |
| `soul-evil`     | `agent:bootstrap`                        | Deferred; ships disabled until opt-in         | README marked deferred/internal-only and called out as not part of the public package | No                   | Delete/quarantine in a later stage; not in scope for Stage 2F per the no-broad-deletion rule    |

## E. Dangerous Or Admin Commands

| Command           | Public or hidden | Risk                                                              | Guardrails                                                                                                                          | Future action                                                                                |
| ----------------- | ---------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `/goal_github_push`| Public (Goal diagnostics & tuning) | Can push branches and open pull requests on GitHub               | Telegram auth gate via `resolveTelegramCommandAuth`; `/help` and `/commands` both label it dangerous/admin; toggle is per-run     | Keep public for v0; revisit when GitHub push gains an organization-level allowlist            |
| `/gateway_restart`| Public (Advanced & admin)          | Restarts the gateway service                                     | Telegram auth gate; private-chat-only; cooldown enforced by `src/telegram/gateway-restart.ts`; `/help` labels it dangerous/admin   | Keep public for v0                                                                            |
| `/bash`           | Hidden            | Host shell execution                                              | Telegram auth gate; not in `PUBLIC_TELEGRAM_MENU`; not rendered by `/help` or `/commands`                                          | Investigate, then delete unless an operator scenario requires it                              |
| `/create_repo`    | Hidden            | Bootstraps a GitHub repo for a local directory                    | Telegram auth gate; not in `PUBLIC_TELEGRAM_MENU`; not rendered by `/help` or `/commands`                                          | Keep internal; consider folding into a Stage 3+ admin surface if reused                       |
