#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
UNIT_DIR="${HOME}/.config/systemd/user"
PATH_UNIT="moltbot-gateway-restart.path"
SERVICE_UNIT="moltbot-gateway-restart.service"

mkdir -p "${UNIT_DIR}"

ln -sfn "${SCRIPT_DIR}/${PATH_UNIT}" "${UNIT_DIR}/${PATH_UNIT}"
ln -sfn "${SCRIPT_DIR}/${SERVICE_UNIT}" "${UNIT_DIR}/${SERVICE_UNIT}"

systemctl --user daemon-reload
systemctl --user enable --now "${PATH_UNIT}"

cat <<'CHECKLIST'
Gateway restart trigger units installed.

Manual verification checklist:
1. Confirm the path unit is active:
   systemctl --user status moltbot-gateway-restart.path --no-pager
2. Trigger a manual restart request:
   mkdir -p ~/.smithersbot/gateway-restart-triggers
   touch ~/.smithersbot/gateway-restart-triggers/restart-manual.req
3. Confirm the dev gateway restarted:
   journalctl --user -u smithersbot-gateway.service -n 50 --no-pager
4. Confirm trigger request files were cleaned up:
   ls -la ~/.smithersbot/gateway-restart-triggers
CHECKLIST
