#!/usr/bin/env bash
set -euo pipefail

UNIT_BASENAME="moltbot-gateway-restart-trigger"
UNIT_FILES=("${UNIT_BASENAME}.service" "${UNIT_BASENAME}.path")
SYSTEMD_SERVICE_NAME="moltbot-gateway-dev.service"
INSTALL_MODE="copy"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-systemctl}"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

usage() {
  cat <<'EOF'
Install Moltbot Telegram gateway restart trigger units (user systemd).

Usage:
  scripts/systemd/install-moltbot-gateway-restart-trigger.sh [--copy|--symlink] [--help]

Options:
  --copy       Copy unit files into ~/.config/systemd/user (default)
  --symlink    Symlink unit files into ~/.config/systemd/user
  --help       Show this help text
EOF
}

for arg in "$@"; do
  case "$arg" in
    --copy)
      INSTALL_MODE="copy"
      ;;
    --symlink|--link)
      INSTALL_MODE="symlink"
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      usage >&2
      exit 1
      ;;
  esac
done

mkdir -p "$SYSTEMD_USER_DIR"

for unit_file in "${UNIT_FILES[@]}"; do
  source_path="${SCRIPT_DIR}/${unit_file}"
  target_path="${SYSTEMD_USER_DIR}/${unit_file}"

  if [[ ! -f "$source_path" ]]; then
    echo "Missing unit file: $source_path" >&2
    exit 1
  fi

  if [[ "$INSTALL_MODE" == "symlink" ]]; then
    ln -sfn "$source_path" "$target_path"
    echo "linked: $target_path -> $source_path"
  else
    cp "$source_path" "$target_path"
    echo "copied: $source_path -> $target_path"
  fi
done

"$SYSTEMCTL_BIN" --user daemon-reload
"$SYSTEMCTL_BIN" --user enable --now "${UNIT_BASENAME}.path"

cat <<EOF

Installed and enabled: ${UNIT_BASENAME}.path

Manual verification checklist:
1. Confirm the units are loaded and the path watcher is active:
   systemctl --user status ${UNIT_BASENAME}.path --no-pager
   systemctl --user status ${UNIT_BASENAME}.service --no-pager

2. Confirm the dev gateway service exists and is running:
   systemctl --user status ${SYSTEMD_SERVICE_NAME} --no-pager

3. Tail logs before triggering:
   journalctl --user -u ${UNIT_BASENAME}.path -u ${UNIT_BASENAME}.service -u ${SYSTEMD_SERVICE_NAME} -f

4. From Telegram, send /gateway_restart in a private chat as the allowlisted admin user.
   Expect an immediate bot ack: "Accepted: restart request queued."

5. Observe the restart in logs and service state:
   systemctl --user show ${SYSTEMD_SERVICE_NAME} --property=ActiveEnterTimestamp

6. Confirm request files were consumed after successful restart:
   find "\$HOME/.moltbot/telegram/gateway-restart/requests" "\$HOME/.clawdbot/telegram/gateway-restart/requests" -maxdepth 1 -type f -name '*.req' 2>/dev/null
EOF
