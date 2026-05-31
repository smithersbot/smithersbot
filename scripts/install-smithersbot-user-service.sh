#!/usr/bin/env bash
set -euo pipefail

# Installs a user-level systemd unit for the gateway. EnvironmentFile points at
# the same instance-specific .env file that the gateway auto-loads in code.

usage() {
  cat <<'EOF'
Usage: bash scripts/install-smithersbot-user-service.sh [--dry-run] [--instance default|stable|dev]

Writes the selected SmithersBot gateway user service for the current repo.
Use --dry-run to print the resolved unit without writing it.
EOF
}

dry_run=0
instance_selection="default"

select_instance() {
  local selection=${1:-default}
  case "${selection,,}" in
    ""|default|stable)
      service_unit="smithersbot-gateway.service"
      env_file="%h/.smithersbot/.env"
      extra_environment_lines=""
      ;;
    dev)
      service_unit="smithersbot-dev-gateway.service"
      env_file="%h/.smithersbot-dev/.env"
      extra_environment_lines=$'Environment=SMITHERSBOT_INSTANCE=dev\nEnvironment=SMITHERSBOT_GATEWAY_PORT=18790'
      ;;
    *)
      echo "Unknown SmithersBot gateway instance \"$selection\". Allowed values: default, stable, dev." >&2
      exit 2
      ;;
  esac
}

while (($#)); do
  case "$1" in
    --dry-run)
      dry_run=1
      shift
      ;;
    --instance)
      if [[ $# -lt 2 ]]; then
        echo "--instance requires default, stable, or dev" >&2
        exit 2
      fi
      instance_selection=$2
      shift 2
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

select_instance "$instance_selection"

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
unit_path="$unit_dir/$service_unit"

if [[ -n "$extra_environment_lines" ]]; then
  unit_content="$(cat <<EOF
[Unit]
Description=SmithersBot gateway

[Service]
Type=simple
EnvironmentFile=$env_file
$extra_environment_lines
WorkingDirectory=$repo_root
ExecStart=$node_bin scripts/run-node.mjs gateway
Restart=always
RestartSec=5
KillMode=mixed

[Install]
WantedBy=default.target
EOF
)"
else
  unit_content="$(cat <<EOF
[Unit]
Description=SmithersBot gateway

[Service]
Type=simple
EnvironmentFile=$env_file
WorkingDirectory=$repo_root
ExecStart=$node_bin scripts/run-node.mjs gateway
Restart=always
RestartSec=5
KillMode=mixed

[Install]
WantedBy=default.target
EOF
)"
fi

if [[ "$dry_run" -eq 1 ]]; then
  echo "Dry run: would write $unit_path"
  printf '%s\n' "$unit_content"
else
  mkdir -p "$unit_dir"
  printf '%s\n' "$unit_content" >"$unit_path"
  echo "Wrote $unit_path"
fi

cat <<EOF

Next commands:
systemctl --user enable --now $service_unit
systemctl --user status $service_unit --no-pager
journalctl --user -u $service_unit -f
EOF
