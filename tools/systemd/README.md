# Gateway Restart Helper

These user-level systemd units are an optional advanced/admin helper for the
Telegram `/gateway_restart` command. They are not required for a normal local
development setup or for running SmithersBot v0.

## Trigger File Pattern

`moltbot-gateway-restart.path` watches this directory:

```text
~/.smithersbot/gateway-restart-triggers
```

When the directory becomes non-empty, systemd starts
`moltbot-gateway-restart.service`. The service restarts the configured gateway
service and then removes trigger request files matching:

```text
~/.smithersbot/gateway-restart-triggers/*.req
```

The Telegram `/gateway_restart` command backs onto this trigger-file pattern:
the bot writes a request file, the path unit notices it, and the service handles
the restart outside the bot process.

## Service Name Assumption

The bundled service assumes the local gateway runs as:

```text
smithersbot-gateway.service
```

Operators with a different local service name should edit
`moltbot-gateway-restart.service` before installing or enabling the unit.

## Installer Behavior

`install-gateway-restart.sh` installs the helper for the current user by:

1. Creating `~/.config/systemd/user` if needed.
2. Linking the path and service units from this repository into that user unit
   directory.
3. Reloading the user systemd manager.
4. Enabling and starting `moltbot-gateway-restart.path`.

After installation, operators can test the trigger with a placeholder request
file such as:

```sh
mkdir -p ~/.smithersbot/gateway-restart-triggers
touch ~/.smithersbot/gateway-restart-triggers/restart-manual.req
```

Use the service and journal commands printed by the installer to inspect the
result for your local setup.
