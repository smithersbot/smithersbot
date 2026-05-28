#!/usr/bin/env bash
set -euo pipefail

# Installs a user-level systemd unit for the gateway. EnvironmentFile points at
# the same ~/.smithersbot/.env file that the gateway auto-loads in code.

usage() {
  cat <<'EOF'
Usage: bash scripts/install-smithersbot-user-service.sh [--dry-run]

Writes ~/.config/systemd/user/smithersbot-gateway.service for the current repo.
Use --dry-run to print the resolved unit without writing it.
EOF
}

dry_run=0

while (($#)); do
  case "$1" in
    --dry-run)
      dry_run=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! -f package.json ]]; then
  echo "Run this script from the SmithersBot repository root." >&2
  exit 1
fi

if ! grep -Eq '"name"[[:space:]]*:[[:space:]]*"smithersbot"' package.json; then
  echo "Run this script from the SmithersBot repository root (package.json name must be smithersbot)." >&2
  exit 1
fi

node_bin="$(command -v node || true)"
if [[ -z "$node_bin" ]]; then
  echo "node was not found on PATH." >&2
  exit 1
fi

repo_root="$(pwd -P)"
unit_dir="$HOME/.config/systemd/user"
unit_path="$unit_dir/smithersbot-gateway.service"

unit_content="$(cat <<EOF
[Unit]
Description=SmithersBot gateway

[Service]
Type=simple
EnvironmentFile=%h/.smithersbot/.env
WorkingDirectory=$repo_root
ExecStart=$node_bin scripts/run-node.mjs gateway
Restart=always
RestartSec=5
KillMode=mixed

[Install]
WantedBy=default.target
EOF
)"

if [[ "$dry_run" -eq 1 ]]; then
  echo "Dry run: would write $unit_path"
  printf '%s\n' "$unit_content"
else
  mkdir -p "$unit_dir"
  printf '%s\n' "$unit_content" >"$unit_path"
  echo "Wrote $unit_path"
fi

cat <<'EOF'

Next commands:
systemctl --user enable --now smithersbot-gateway.service
systemctl --user status smithersbot-gateway.service --no-pager
journalctl --user -u smithersbot-gateway.service -f
EOF
