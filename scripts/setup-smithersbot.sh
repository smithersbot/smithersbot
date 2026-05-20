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
  local gateway_token=$4
  local tmp
  local escaped_allowed_id
  local escaped_backend
  local escaped_gateway_token

  escaped_allowed_id=$(json_escape "$allowed_id")
  escaped_backend=$(json_escape "$backend")
  escaped_gateway_token=$(json_escape "$gateway_token")
  tmp=$(mktemp "${path}.tmp.XXXXXX")
  chmod 600 "$tmp"
  cat >"$tmp" <<JSON
{
  "gateway": {
    "mode": "local",
    "auth": {
      "token": "$escaped_gateway_token"
    }
  },
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

generate_gateway_token() {
  node --input-type=module -e 'import { randomBytes } from "node:crypto"; console.log(randomBytes(32).toString("base64url"));'
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

telegram_api() {
  local method=$1
  local api_base=${SMITHERSBOT_TELEGRAM_API_BASE:-https://api.telegram.org}

  TELEGRAM_API_BASE="$api_base" TELEGRAM_API_METHOD="$method" TELEGRAM_BOT_TOKEN_SETUP="$telegram_token" node --input-type=module <<'NODE'
const base = process.env.TELEGRAM_API_BASE ?? "https://api.telegram.org";
const token = process.env.TELEGRAM_BOT_TOKEN_SETUP;
const method = process.env.TELEGRAM_API_METHOD;
try {
  const response = await fetch(`${base.replace(/\/+$/, "")}/bot${token}/${method}`);
  const text = await response.text();
  if (text.trim().length === 0) {
    console.log(JSON.stringify({ ok: false, error_code: response.status, description: "Telegram API returned an empty response" }));
  } else {
    console.log(text);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ ok: false, description: `Telegram API request failed: ${message}` }));
}
NODE
}

json_field() {
  local json=$1
  local field=$2
  JSON_INPUT="$json" JSON_FIELD="$field" node --input-type=module <<'NODE'
const data = JSON.parse(process.env.JSON_INPUT ?? "{}");
const path = (process.env.JSON_FIELD ?? "").split(".");
let value = data;
for (const part of path) value = value?.[part];
if (value !== undefined && value !== null) console.log(String(value));
NODE
}

json_ok() {
  local json=$1
  [[ "$(json_field "$json" ok)" == "true" ]]
}

extract_newest_private_update() {
  local json=$1
  JSON_INPUT="$json" node --input-type=module <<'NODE'
const data = JSON.parse(process.env.JSON_INPUT ?? "{}");
const updates = Array.isArray(data.result) ? data.result : [];
const privateMessages = updates
  .filter((update) => update && typeof update === "object")
  .filter((update) => update.message && update.message.chat?.type === "private")
  .sort((a, b) => Number(b.update_id ?? -1) - Number(a.update_id ?? -1));
const newest = privateMessages[0];
if (!newest) process.exit(1);
const message = newest.message;
const result = {
  updateId: newest.update_id,
  chatId: message.chat.id,
  fromId: message.from?.id ?? null,
  text: typeof message.text === "string" ? message.text : "",
};
console.log(JSON.stringify(result));
NODE
}

extract_detected_id_field() {
  local json=$1
  local field=$2
  JSON_INPUT="$json" DETECTED_FIELD="$field" node --input-type=module <<'NODE'
const data = JSON.parse(process.env.JSON_INPUT ?? "{}");
const value = data[process.env.DETECTED_FIELD ?? ""];
if (value !== undefined && value !== null) console.log(String(value));
NODE
}

verify_telegram_token() {
  local response username description
  response=$(telegram_api getMe)
  if ! json_ok "$response"; then
    description=$(json_field "$response" description)
    [[ -n "$description" ]] || description="Telegram rejected the bot token"
    fail "invalid Telegram bot token: $description"
  fi

  username=$(json_field "$response" result.username)
  [[ -n "$username" ]] || fail "Telegram getMe succeeded but did not return a bot username"
  printf '%s\n' "$username"
}

choose_differing_telegram_id() {
  local chat_id=$1
  local from_id=$2
  local answer

  while true; do
    printf 'Telegram private chat ID: %s\n' "$chat_id" >&2
    printf 'Telegram from/user ID: %s\n' "$from_id" >&2
    printf 'chat.id and from.id differ. Use [c]hat ID or [u]ser ID? [c/u] ' >&2
    IFS= read -r answer
    case "$answer" in
      ""|c|C|chat|CHAT)
        printf '%s\n' "$chat_id"
        return 0
        ;;
      u|U|user|USER)
        printf '%s\n' "$from_id"
        return 0
        ;;
      *)
        printf 'Please enter c or u.\n' >&2
        ;;
    esac
  done
}

confirm_detected_telegram_id() {
  local detected_id=$1
  local answer manual_id

  printf 'Detected Telegram private chat ID: %s\n' "$detected_id" >&2
  printf 'Use this Telegram private chat ID for allowFrom? [Y/n] ' >&2
  IFS= read -r answer
  case "$answer" in
    ""|y|Y|yes|YES)
      printf '%s\n' "$detected_id"
      ;;
    n|N|no|NO)
      printf 'Telegram private chat ID for allowFrom: ' >&2
      IFS= read -r manual_id
      [[ -n "$manual_id" ]] || fail "Telegram private chat ID cannot be empty"
      printf '%s\n' "$manual_id"
      ;;
    *)
      printf 'Please answer Y or n.\n' >&2
      confirm_detected_telegram_id "$detected_id"
      ;;
  esac
}

manual_or_retry_telegram_id() {
  local bot_username=$1
  local answer manual_id

  while true; do
    printf 'No private Telegram message was detected before the setup timeout.\n' >&2
    printf 'Open @%s (your new bot, NOT @BotFather) in Telegram and press Start, or send any message. Then choose retry, or enter the private chat ID manually.\n' "$bot_username" >&2
    printf 'Retry detection or enter ID manually? [r/m] ' >&2
    IFS= read -r answer
    case "$answer" in
      r|R|retry|RETRY)
        return 1
        ;;
      m|M|manual|MANUAL)
        printf 'Telegram private chat ID for allowFrom: ' >&2
        IFS= read -r manual_id
        [[ -n "$manual_id" ]] || fail "Telegram private chat ID cannot be empty"
        printf '%s\n' "$manual_id"
        return 0
        ;;
      *)
        printf 'Please enter r or m.\n' >&2
        ;;
    esac
  done
}

detect_telegram_allowed_id() {
  local bot_username=$1
  local poll_seconds=${SMITHERSBOT_SETUP_POLL_SECONDS:-60}
  local poll_interval=${SMITHERSBOT_SETUP_POLL_INTERVAL:-2}
  local start now deadline response description detected chat_id from_id selected_id

  printf 'Open @%s (your new bot, NOT @BotFather) in Telegram and press Start, or send any message.\n' "$bot_username" >&2

  while true; do
    start=$(date +%s)
    deadline=$((start + poll_seconds))
    while true; do
      response=$(telegram_api getUpdates)
      if ! json_ok "$response"; then
        description=$(json_field "$response" description)
        if [[ "$(json_field "$response" error_code)" == "409" ]]; then
          printf 'Telegram getUpdates is blocked because a webhook is active for this bot.\n' >&2
          printf 'Disable the webhook, then rerun setup:\n' >&2
          printf '  curl -sS "%s/bot<YOUR_BOT_TOKEN>/deleteWebhook"\n' "${SMITHERSBOT_TELEGRAM_API_BASE:-https://api.telegram.org}" >&2
          printf 'Telegram API said: %s\n' "$description" >&2
          exit 1
        fi
        [[ -n "$description" ]] || description="Telegram getUpdates failed"
        fail "$description"
      fi

      if detected=$(extract_newest_private_update "$response" 2>/dev/null); then
        chat_id=$(extract_detected_id_field "$detected" chatId)
        from_id=$(extract_detected_id_field "$detected" fromId)
        if [[ -n "$from_id" && "$chat_id" != "$from_id" ]]; then
          selected_id=$(choose_differing_telegram_id "$chat_id" "$from_id")
        else
          if [[ -n "$from_id" ]]; then
            printf 'Telegram from/user ID: %s\n' "$from_id" >&2
          fi
          selected_id=$chat_id
        fi
        confirm_detected_telegram_id "$selected_id"
        return 0
      fi

      now=$(date +%s)
      (( now >= deadline )) && break
      sleep "$poll_interval"
    done

    if manual_or_retry_telegram_id "$bot_username"; then
      return 0
    fi
  done
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

if [[ "$run_build" -eq 1 ]]; then
  activate_pnpm
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

bot_username=$(verify_telegram_token)
info "Telegram bot verified: @$bot_username"
allowed_id=$(detect_telegram_allowed_id "$bot_username")
[[ -n "$allowed_id" ]] || fail "Telegram private chat ID cannot be empty"

if [[ -z "$backend" ]]; then
  backend=$(prompt_backend)
fi

gateway_token=$(generate_gateway_token)

if confirm_overwrite "$env_file"; then
  write_env_file "$env_file" "$telegram_token"
else
  chmod 600 "$env_file"
  info "Kept existing $env_file"
fi

if confirm_overwrite "$config_file"; then
  write_config_file "$config_file" "$allowed_id" "$backend" "$gateway_token"
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
