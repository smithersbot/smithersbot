# Launch Onboarding Setup Flow Report

## Scope

This report covers the launch-ready SmithersBot setup/onboarding flow added as a
bounded extension of the existing shell setup wizard. No TUI was introduced.

## Setup Flow Before

Before this work, `scripts/setup-smithersbot.sh` primarily handled the local
gateway setup path:

1. Run from a SmithersBot checkout.
2. Check a Node 22 major version, git, and build prerequisites.
3. Configure Telegram through token validation and allowed-chat discovery.
4. Write gateway-private files under `~/.smithersbot`.
5. Optionally build and print basic next steps.

The setup script did not guide a new operator through selecting a managed agent
root, selecting an agent workspace repository, creating a per-workspace private
env file outside the workspace, configuring how SmithersBot addresses the
operator, or printing the launch smoke tests now expected for first use.

## Setup Flow After

The setup wizard now guides the launch flow:

1. Verify it is running from a SmithersBot checkout.
2. Require Node `>= 22.12.0`.
3. Require `pnpm` even when build is skipped.
4. Require `git`.
5. Warn when no supported backend command (`codex` or `claude_code`) is
   available, while continuing with install/login-later instructions.
6. Prompt for the managed root, defaulting to `~/smithersbot-goals`.
7. Create or verify the managed tree using the existing managed-path layout:
   `agent/workspaces`, `agent/history/{goals,repo-chats,index}`, `private/{env,config,auth,sessions}`,
   and `scratch`.
8. Prompt for the repository agents should work on: this checkout, another local
   path, or a clone URL.
9. Prompt for and validate a workspace name using the same safety rules as the
   runtime workspace slug validation.
10. Create `<managedRoot>/agent/workspaces/<workspaceName>/repo` as an isolated
    clone for git sources, or a copied fallback for a non-git local directory.
11. Create `<managedRoot>/private/env/<workspaceName>/.env` outside the
    workspace with mode `600` and placeholder-only content.
12. Prompt for how SmithersBot should address the operator, defaulting to `sir`.
13. Keep the Telegram token, `getMe`, and `getUpdates` allowed-chat flow.
14. Write gateway-private config under `~/.smithersbot`, including the selected
    workspace and operator honorific.
15. Offer the user systemd service install/start path when available, or print
    exact manual commands when unavailable or declined.
16. Print first smoke tests:
    `/gateway_status`, `/usage_status`, `/repo_chat say only: repo chat works`,
    and `/new_goal Inspect the repository state and report whether the working tree is clean. Do not edit files.`

## Files Changed

Main onboarding and config surfaces:

- `scripts/setup-smithersbot.sh`
- `test/setup-smithersbot.test.ts`
- `src/config/types.base.ts`
- `src/config/zod-schema.core.ts`
- `src/config/types.agent-defaults.ts`
- `src/config/zod-schema.agent-defaults.ts`
- `src/config/defaults.ts`
- `src/config/defaults.test.ts`
- `src/config/paths.test.ts`
- `src/telegram/goal-formatting.ts`
- `src/telegram/goal-formatting.test.ts`
- `src/telegram/goal-commands.ts`
- `src/telegram/goal-commands.test.ts`
- `src/telegram/command-fragments.test.ts`
- `README.md`
- `SETUP.md`

Files touched during the final verification sweep:

- `src/telegram/goal-formatting.ts`: replaced the honorific control-character
  regex with equivalent code-point filtering so `pnpm lint` passes.
- `src/goal/worker-context/AGENTS.md`
- `src/goal/worker-context/CLAUDE.md`
- `src/goal/worker-context/shared-worker-contract.md`
- `src/prompts/README.md`
- `src/prompts/scout/scout_prompt_template.md`
- `src/repo-chat/repo-chat-context/AGENTS.md`
- `src/repo-chat/repo-chat-context/CLAUDE.md`

The markdown files above were formatted with `oxfmt` after `pnpm format`
reported them.

## Config Fields Added

- `IdentityConfig.operatorHonorific?: string`
- `IdentitySchema.operatorHonorific`
- `AgentDefaultsConfig.identity?: IdentityConfig`
- `AgentDefaultsSchema.identity`

`agents.defaults.identity` now merges into each resolved agent config. Per-agent
`identity` values continue to override defaults. Existing configs without the new
field remain valid.

## Workspace And Private Env Behavior

The launch wizard creates the agent-editable repository at:

`<managedRoot>/agent/workspaces/<workspaceName>/repo`

For git sources, setup creates an isolated clone. For a local non-git directory,
setup copies the directory as a fallback and reports that fallback. Setup does
not symlink and does not point the managed workspace back at the operator's
runtime checkout.

The per-workspace private env file is created at:

`<managedRoot>/private/env/<workspaceName>/.env`

That file is outside the agent workspace, uses mode `600`, and contains only safe
placeholder/header content. The setup output makes the product rule explicit:
agent-readable or agent-editable files must live under the workspace repo, while
private env/config/auth remain outside the workspace and are not agent-visible.

## Honorific Behavior

Setup asks: "How should SmithersBot address you?" The default is `sir`. The
generated config persists the value at:

`agents.defaults.identity.operatorHonorific`

Telegram goal prefaces are built at render time from the routed agent identity,
falling back through `agents.defaults.identity.operatorHonorific`, then to `sir`
when unset. Supported behavior:

- unset/default: `Right away, sir.`
- `boss`: `Right away, boss.`
- first name such as `Matthew`: `Right away, Matthew.`
- empty string: `Right away.`

Outbound honorific text is trimmed, stripped of control and Telegram-markup
dangerous characters, whitespace-normalized, and capped to 48 characters.

## Systemd Behavior

Systemd is recommended but optional. The wizard can offer to run
`scripts/install-smithersbot-user-service.sh` and start the user service when
`systemctl --user` is available. If systemd is unavailable or declined, setup
prints exact manual commands instead of hard-failing non-systemd users.

## Tests Added Or Updated

Setup wizard coverage now includes stdin-driven prompts and regressions for:

- Node `>= 22.12.0` gate.
- `pnpm` required even with `--no-build`.
- managed-root prompt/default.
- local git repo clone into the managed workspace repo.
- local clone URL fixture.
- non-git copy fallback.
- unsafe workspace-name rejection.
- private env file location, mode `600`, and outside-workspace placement.
- generated config including `operatorHonorific` defaulting to `sir`.
- smoke-test output including `/gateway_status` and `/usage_status`.

Config and Telegram coverage now includes:

- `operatorHonorific` validation on defaults and per-agent identity.
- propagation of `agents.defaults.identity` into resolved agent config.
- per-agent identity overriding defaults.
- configs without the new field staying valid.
- honorific preface builders for `sir`, `boss`, first-name, and empty cases.
- honorific sanitization and length cap.
- existing Telegram command tests updated for generated prefaces.

## Docs Updated

`README.md` and `SETUP.md` now document:

- the app checkout can live anywhere.
- the managed root defaults to `~/smithersbot-goals`.
- the agent-editable workspace path is
  `<managedRoot>/agent/workspaces/<workspaceName>/repo`.
- the per-workspace private env path is
  `<managedRoot>/private/env/<workspaceName>/.env`.
- private env/config/auth are not agent-visible.
- setup is a shell wizard for launch, not a TUI.
- systemd is recommended but optional.
- the operator honorific prompt and default.
- the first smoke tests after setup.

`AGENTS.md` and `CLAUDE.md` did not require onboarding-specific edits in this
task.

## Verification Results

Passed:

- `pnpm exec vitest run test/setup-smithersbot.test.ts src/config src/telegram/goal-commands.test.ts src/telegram/command-fragments.test.ts`
  - Result: passed, 50 test files, 581 tests passed, 1 skipped.
- `pnpm exec vitest run src/telegram/goal-formatting.test.ts`
  - Result: passed, 1 test file, 8 tests passed.
- `pnpm exec tsc -p tsconfig.json`
  - Result: passed.
- `pnpm build`
  - Result: passed.
- `pnpm lint`
  - Initial result: failed on `src/telegram/goal-formatting.ts` because
    `eslint(no-control-regex)` rejected a control-character regex used by the new
    sanitizer.
  - Fix: replaced the regex with equivalent code-point filtering.
  - Final result: passed, 0 warnings and 0 errors.
- `pnpm format`
  - Initial result: failed on seven markdown files under `src/`.
  - Fix: ran `oxfmt --write` on only the files reported by the formatter.
  - Final result: passed.
- `pnpm test`
  - Result: passed, 1 test file, 20 tests passed.

No gateway restart, deployment, publishing, or privileged command was run.

## Remaining Risks And Deferred Improvements

- Backend availability is warned during setup, but actual backend login and
  subscription readiness still depend on operator action after setup.
- Systemd remains optional; non-systemd users must use the printed manual
  commands and manage process lifecycle themselves.
- The non-git local-directory path is a copy fallback. Operators must rerun or
  manually sync if they expect later source-directory edits to appear in the
  managed workspace.
- Telegram setup still depends on live Bot API behavior for real launches; tests
  use stubs and local fixtures for deterministic coverage.
