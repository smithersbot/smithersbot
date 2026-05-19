#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/setup-smithersbot.sh [--config-dir DIR] [--state-dir DIR] [--no-build] [--backend codex|claude_code]

Sets up local SmithersBot Telegram configuration in ~/.smithersbot by default.
USAGE
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

info() {
  printf '%s\n' "$*"
}

expand_home() {
  case "$1" in
    \~) printf '%s\n' "$HOME" ;;
    \~/*) printf '%s/%s\n' "$HOME" "${1#\~/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

json_escape() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}
  value=${value//$'\r'/\\r}
  value=${value//$'\t'/\\t}
  printf '%s' "$value"
}

confirm_overwrite() {
  local path=$1
  local answer

  if [[ ! -e "$path" ]]; then
    return 0
  fi

  printf '%s exists. Overwrite it? [y/N] ' "$path" >&2
  IFS= read -r answer
  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

write_env_file() {
  local path=$1
  local token=$2
  local tmp

  tmp=$(mktemp "${path}.tmp.XXXXXX")
  chmod 600 "$tmp"
  {
    printf '# SmithersBot local secrets. Do not commit this file.\n'
    printf 'TELEGRAM_BOT_TOKEN=%s\n' "$token"
  } >"$tmp"
  mv "$tmp" "$path"
  chmod 600 "$path"
}

write_config_file() {
  local path=$1
  local allowed_id=$2
  local backend=$3
  local tmp
  local escaped_allowed_id
  local escaped_backend

  escaped_allowed_id=$(json_escape "$allowed_id")
  escaped_backend=$(json_escape "$backend")
  tmp=$(mktemp "${path}.tmp.XXXXXX")
  chmod 600 "$tmp"
  cat >"$tmp" <<JSON
{
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "\${TELEGRAM_BOT_TOKEN}",
      "allowFrom": ["$escaped_allowed_id"],
      "dmPolicy": "allowlist",
      "repoChatBackend": "$escaped_backend"
    }
  }
}
JSON
  mv "$tmp" "$path"
  chmod 600 "$path"
}

require_repo_root() {
  [[ -f package.json ]] || fail "run this script from the SmithersBot repository root"
  grep -Eq '"name"[[:space:]]*:[[:space:]]*"smithersbot"' package.json \
    || fail "package.json name is not smithersbot; run this from the SmithersBot repository root"
}

require_node_22() {
  command -v node >/dev/null 2>&1 || fail "Node.js 22+ is required but node was not found"

  local version major
  version=$(node -v 2>/dev/null || true)
  major=${version#v}
  major=${major%%.*}
  [[ "$major" =~ ^[0-9]+$ ]] || fail "could not parse Node.js version: $version"
  (( major >= 22 )) || fail "Node.js 22+ is required; found $version"
}

require_git() {
  command -v git >/dev/null 2>&1 || fail "git is required but was not found"
}

activate_pnpm() {
  local package_manager pnpm_version

  command -v corepack >/dev/null 2>&1 || fail "Corepack is required. Install Node.js 22+ with Corepack, then rerun this script."
  package_manager=$(grep -E '"packageManager"[[:space:]]*:' package.json | sed -E 's/.*"packageManager"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' | head -n 1)
  [[ "$package_manager" == pnpm@* ]] || fail "package.json packageManager must be pnpm; found '$package_manager'"
  pnpm_version=${package_manager#pnpm@}

  if ! corepack enable >/dev/null 2>&1; then
    info "Corepack could not create pnpm shims in this environment."
    info "If pnpm is unavailable, run 'corepack enable' yourself with appropriate permissions, then rerun this script."
  fi
  if ! corepack prepare "pnpm@$pnpm_version" --activate >/dev/null 2>&1; then
    info "Corepack could not activate pnpm@$pnpm_version."
    info "If pnpm is unavailable or the wrong version, run 'corepack prepare pnpm@$pnpm_version --activate' yourself, then rerun this script."
  fi
  command -v pnpm >/dev/null 2>&1 || fail "pnpm is required but was not found"
}

prompt_backend() {
  local answer
  while true; do
    printf 'Repo-chat backend [codex/claude_code]: ' >&2
    IFS= read -r answer
    case "$answer" in
      codex|claude_code)
        printf '%s\n' "$answer"
        return 0
        ;;
      *)
        printf 'Please enter codex or claude_code.\n' >&2
        ;;
    esac
  done
}

config_dir="~/.smithersbot"
state_dir="~/.smithersbot"
run_build=1
backend=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config-dir)
      [[ $# -ge 2 ]] || fail "--config-dir requires a directory"
      config_dir=$2
      shift 2
      ;;
    --state-dir)
      [[ $# -ge 2 ]] || fail "--state-dir requires a directory"
      state_dir=$2
      shift 2
      ;;
    --no-build)
      run_build=0
      shift
      ;;
    --backend)
      [[ $# -ge 2 ]] || fail "--backend requires codex or claude_code"
      backend=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

case "$backend" in
  ""|codex|claude_code) ;;
  *) fail "--backend must be codex or claude_code" ;;
esac

require_repo_root
require_node_22
require_git
activate_pnpm

if [[ "$run_build" -eq 1 ]]; then
  pnpm install --frozen-lockfile
  pnpm build
else
  info "Skipping pnpm install and pnpm build because --no-build was provided."
fi

config_dir=$(expand_home "$config_dir")
state_dir=$(expand_home "$state_dir")
env_file="$config_dir/.env"
config_file="$config_dir/smithersbot.json"

mkdir -p "$config_dir" "$state_dir"

printf 'Telegram bot token: ' >&2
IFS= read -rs telegram_token
printf '\n' >&2
[[ -n "$telegram_token" ]] || fail "Telegram bot token cannot be empty"

printf 'Telegram allowed user/chat ID: ' >&2
IFS= read -r allowed_id
[[ -n "$allowed_id" ]] || fail "Telegram allowed user/chat ID cannot be empty"

if [[ -z "$backend" ]]; then
  backend=$(prompt_backend)
fi

if confirm_overwrite "$env_file"; then
  write_env_file "$env_file" "$telegram_token"
else
  chmod 600 "$env_file"
  info "Kept existing $env_file"
fi

if confirm_overwrite "$config_file"; then
  write_config_file "$config_file" "$allowed_id" "$backend"
else
  chmod 600 "$config_file"
  info "Kept existing $config_file"
fi

info ""
info "SmithersBot setup complete."
info "Config directory: $config_dir"
if [[ "$state_dir" != "$config_dir" ]]; then
  info "State directory: $state_dir"
  info "Set SMITHERSBOT_STATE_DIR=$state_dir before starting if you want to use this state directory."
fi
info ""
info "Start the gateway from the repository root:"
info "  node scripts/run-node.mjs gateway"
info ""
info "First Telegram smoke tests:"
info "  /help"
info "  /commands"
info "  /goal_list"
info "  /repo_chat say only: repo chat works"
info "  /new_goal Inspect the repository state and report whether the working tree is clean. Do not edit files."
