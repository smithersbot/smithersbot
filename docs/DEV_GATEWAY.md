# Dev Gateway

SmithersBot supports running a second, isolated **dev** gateway alongside the
normal **stable** gateway. The stable gateway is the trusted one you use day to
day; the dev gateway is where SmithersBot itself is developed, built, installed,
restarted, and tested without putting the stable gateway at risk.

This document describes the full stable-vs-dev workflow: layout, how an instance
is selected, the `--instance dev` setup/install flow, service names, config
directories, managed homes, ports, Telegram bot separation, the private dev
GitHub repo policy, the stable-edits-dev / dev-never-controls-stable rule, and
how to publish from the private dev repo to a public PR.

## Stable vs dev layout

| Aspect | Stable (default) | Dev |
| --- | --- | --- |
| Service unit | `smithersbot-gateway.service` | `smithersbot-dev-gateway.service` |
| Config/state dir | `~/.smithersbot` | `~/.smithersbot-dev` |
| Managed runtime home | `~/smithersbot-home` | `~/smithersbot-dev-home` |
| Gateway port | `18789` | `18790` |
| Telegram bot | stable/OG bot token | separate dev bot token |
| Managed workspaces | `~/smithersbot-home/agent/workspaces` | `~/smithersbot-dev-home/agent/workspaces` |

The dev gateway's runtime state, goal history, private env, config, and Telegram
settings are fully separated from stable. The dev gateway never shares
`~/.smithersbot` or `~/smithersbot-home` with stable.

The two SmithersBot checkouts under the stable gateway's managed workspaces are:

- **Stable checkout** — `~/smithersbot-home/agent/workspaces/smithersbot-stable`,
  which runs the trusted stable gateway.
- **Dev checkout** — `~/smithersbot-home/agent/workspaces/smithersbot-dev`,
  which is editable by the stable gateway and is where SmithersBot development
  happens. The dev checkout is the normal `WorkingDirectory` for the dev
  gateway.

## Instance selection is EXPLICIT

Runtime instance identity — config/state dir, managed home, port, service unit,
and which `.env` is loaded — is chosen **only by an explicit signal**. It is
never inferred from the checkout path or working directory.

A process resolves the **dev** instance only when one of these explicit signals
is present:

- `--instance dev` passed to the setup/install scripts, or
- `SMITHERSBOT_INSTANCE=dev` in the process environment, or
- the dev service's `EnvironmentFile=%h/.smithersbot-dev/.env` (which sets
  `SMITHERSBOT_INSTANCE=dev` for the running unit), or
- an explicit override env var such as `SMITHERSBOT_STATE_DIR`,
  `SMITHERSBOT_GOALS_ROOT`, or `SMITHERSBOT_GATEWAY_PORT`.

> **Important:** Simply editing or running code from the `smithersbot-dev`
> checkout does **not** make a process behave as dev. A no-arg / no-instance
> process always resolves stable/default (`smithersbot-gateway.service`,
> `~/.smithersbot`, `~/smithersbot-home`, `18789`) even when its code lives under
> `~/smithersbot-home/agent/workspaces/smithersbot-dev`.

Checkout / working-directory detection is used **only** for planner and worker
dev-gateway guidance (telling a worker it is operating in the dev workspace), and
never to flip runtime config.

Supported instance names for this first version are `default`, `stable`, and
`dev`. `default` and `stable` are aliases for current no-arg stable behavior.
Any other instance name is rejected with a clear error naming the offending
value and the allowed set.

### Canonical port variable

`SMITHERSBOT_GATEWAY_PORT` is the canonical port override and takes precedence
before the deprecated `MOLTBOT_GATEWAY_PORT` / `CLAWDBOT_GATEWAY_PORT` aliases,
then config, then the explicitly-selected instance default (`18789` stable /
`18790` dev).

## Setting up the dev gateway

The normal user setup flow is unchanged. With no arguments, setup and install
behave exactly as documented in [SETUP.md](../SETUP.md): stable service,
`~/.smithersbot`, `~/smithersbot-home`, port `18789`.

To set up the dev instance, run from the dev checkout:

```bash
bash scripts/setup-smithersbot.sh --instance dev
```

You can also install just the dev user service directly:

```bash
bash scripts/install-smithersbot-user-service.sh --instance dev
```

`--instance dev` creates/uses:

- service `smithersbot-dev-gateway.service` with
  `EnvironmentFile=%h/.smithersbot-dev/.env` and `SMITHERSBOT_INSTANCE=dev`
- config/state `~/.smithersbot-dev`
- runtime home `~/smithersbot-dev-home`
- port `18790`
- a separate dev Telegram bot token/config

Dev setup must not overwrite `~/.smithersbot` or `smithersbot-gateway.service`,
and stable setup must not overwrite `~/.smithersbot-dev` or
`smithersbot-dev-gateway.service`.

### Separate Telegram bots — identical tokens are blocked

The dev gateway must use a **separate** Telegram bot from stable. Two pollers on
the same bot token conflict, so if `--instance dev` is configured with the same
Telegram bot token as stable, setup **fails with a clear error** — it does not
merely warn. Token values are never printed or logged during this check.

Create a second bot with `@BotFather` (see [SETUP.md](../SETUP.md) step 6) and
use that token for the dev instance.

## Daily dev commands

Restart the dev gateway:

```bash
systemctl --user restart smithersbot-dev-gateway.service
```

Check dev status:

```bash
systemctl --user status smithersbot-dev-gateway.service --no-pager
```

View dev logs:

```bash
journalctl --user -u smithersbot-dev-gateway.service -n 80 --no-pager
```

`/gateway_status` reports the unit, cwd, port, version, and systemd state for the
instance the running process is configured as: stable reports
`smithersbot-gateway.service` / `18789`, dev reports
`smithersbot-dev-gateway.service` / `18790`.

Stable and dev services can exist and run at the same time. Restarting the dev
gateway does not restart the stable gateway.

## Stable edits dev; dev never controls stable

The stable gateway can edit, build, install, restart, and test the dev gateway.
The reverse is forbidden:

- Workers running in the `smithersbot-dev` workspace are told they are working in
  the SmithersBot dev workspace.
- Those workers may restart and inspect **only**
  `smithersbot-dev-gateway.service`.
- They must **never** restart, reinstall, or modify the stable service
  `smithersbot-gateway.service`, and must never mutate `~/.smithersbot` during
  dev work.
- After changing SmithersBot code or behavior that could affect the running
  gateway (setup, Telegram, goal execution, worker prompts, config, service
  install, sandbox, or status behavior), dev workers should rebuild, restart the
  dev gateway, and smoke-test the changed behavior before reporting completion.
  Docs-only or tests-only changes do not force a gateway restart unless a restart
  is needed to verify the requested behavior.

This split is enforced by policy (hard-deny), not by prompt text alone.
Default/stable workers continue to deny all gateway restarts.

## Private dev GitHub repo policy

The dev checkout has two git remotes:

- `origin` → the private dev repo `https://github.com/smithersbot/smithersbot-dev.git`
- `public` → the public repo `https://github.com/smithersbot/smithersbot.git`,
  with **push disabled**

Rules:

- **Push only to `origin`** (the private dev repo).
- **Never push to `public`.**
- **Never change `public`'s disabled push URL.**
- Do not push automatically before verification passes.

### Publishing from the private dev repo to a public PR

Because `public` push is disabled, you do not push directly to the public repo.
To get reviewed dev work into the public project, open a pull request from a fork
or branch you control:

1. Land and verify the change on `origin` (the private dev repo) first.
2. Fetch the public repo's latest default branch so your PR is based on current
   `public/main`:

   ```bash
   git fetch public
   ```

3. Create a publish branch off the public base:

   ```bash
   git checkout -b publish/<topic> public/main
   ```

4. Cherry-pick or merge the verified commits from the dev branch onto the publish
   branch, keeping secrets and private paths out of the diff.
5. Push the publish branch to a repo you can push to (your fork, not the
   push-disabled `public` remote) and open a PR against
   `smithersbot/smithersbot`:

   ```bash
   gh pr create --repo smithersbot/smithersbot --base main --head <your-fork>:publish/<topic>
   ```

Never alter `public`'s disabled push URL to work around this; the disabled push
URL is an intentional safety policy.
