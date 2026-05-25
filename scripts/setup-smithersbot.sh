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

# Stage 2S managed root layout. Keep this list in sync with the resolvers in
# src/config/managed-paths.ts; src/config/paths.test.ts verifies the match.
# Subdirs are listed relative to the managed root. Anything under "private"
# also gets chmod 700.
MANAGED_ROOT_SUBDIRS=(
  "agent/workspaces"
  "agent/history/goals"
  "agent/history/repo-chats"
  "agent/history/index"
  "private/env"
  "private/config"
  "private/auth"
  "private/sessions"
  "scratch"
)

resolve_managed_root() {
  local override=${SMITHERSBOT_GOALS_ROOT:-}
  if [[ -n "$override" ]]; then
    expand_home "$override"
  else
    expand_home "~/smithersbot-goals"
  fi
}

create_managed_tree() {
  local managed_root=$1
  local subdir

  mkdir -p "$managed_root"
  # chmod the managed root itself when practical (best effort; tolerate
  # restricted environments).
  chmod 700 "$managed_root" 2>/dev/null || true

  for subdir in "${MANAGED_ROOT_SUBDIRS[@]}"; do
    mkdir -p "$managed_root/$subdir"
  done

  # Tighten permissions on the private/* tree so secrets are not world-readable.
  chmod 700 "$managed_root/private" 2>/dev/null || true
  for subdir in "${MANAGED_ROOT_SUBDIRS[@]}"; do
    case "$subdir" in
      private/*)
        chmod 700 "$managed_root/$subdir" 2>/dev/null || true
        ;;
    esac
  done
}

print_managed_root_pointer() {
  local managed_root=$1
  local cwd
  cwd=$(pwd)
  # Only print the pointer when the caller is running outside the managed root.
  if [[ "$cwd" != "$managed_root"* ]]; then
    local repo_name
    repo_name=$(basename "$cwd")
    info "Recommended workspace path: $managed_root/agent/workspaces/$repo_name"
  fi
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
  local workspace_name=$5
  local workspace_repo=$6
  local operator_honorific=$7
  local tmp
  local escaped_allowed_id
  local escaped_backend
  local escaped_gateway_token
  local escaped_workspace_name
  local escaped_workspace_repo
  local escaped_operator_honorific

  escaped_allowed_id=$(json_escape "$allowed_id")
  escaped_backend=$(json_escape "$backend")
  escaped_gateway_token=$(json_escape "$gateway_token")
  escaped_workspace_name=$(json_escape "$workspace_name")
  escaped_workspace_repo=$(json_escape "$workspace_repo")
  escaped_operator_honorific=$(json_escape "$operator_honorific")
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
  },
  "agents": {
    "defaults": {
      "workspace": "$escaped_workspace_repo",
      "identity": {
        "operatorHonorific": "$escaped_operator_honorific"
      }
    }
  },
  "goal": {
    "defaultWorkspaceName": "$escaped_workspace_name"
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

  local version raw major minor patch
  version=$(node -v 2>/dev/null || true)
  raw=${version#v}
  IFS=. read -r major minor patch _ <<<"$raw"
  patch=${patch%%[^0-9]*}
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ && "$patch" =~ ^[0-9]+$ ]] \
    || fail "could not parse Node.js version: $version"
  if (( major < 22 || (major == 22 && minor < 12) || (major == 22 && minor == 12 && patch < 0) )); then
    fail "Node.js >= 22.12.0 is required; found $version"
  fi
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

require_pnpm() {
  command -v pnpm >/dev/null 2>&1 || fail "pnpm is required but was not found"
}

warn_backend_availability() {
  if command -v codex >/dev/null 2>&1 || command -v claude >/dev/null 2>&1 || command -v claude_code >/dev/null 2>&1; then
    return 0
  fi
  info "Warning: no supported agent backend command was found on PATH (codex or claude_code)."
  info "Setup will continue, but install and log in to Codex or Claude Code before running repo chat or goals."
}

telegram_api() {
  local method=$1
  local api_base=${SMITHERSBOT_TELEGRAM_API_BASE:-https://api.telegram.org}

  if [[ -n "${SMITHERSBOT_TELEGRAM_API_STUB_DIR:-}" ]]; then
    TELEGRAM_API_METHOD="$method" TELEGRAM_API_STUB_DIR="$SMITHERSBOT_TELEGRAM_API_STUB_DIR" node --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";
const dir = process.env.TELEGRAM_API_STUB_DIR;
const method = process.env.TELEGRAM_API_METHOD;
const counterPath = path.join(dir, `${method}.count`);
let count = 0;
try {
  count = Number.parseInt(fs.readFileSync(counterPath, "utf8"), 10) || 0;
} catch {}
count += 1;
fs.writeFileSync(counterPath, String(count), { mode: 0o600 });
const numbered = path.join(dir, `${method}.${count}.json`);
const fallback = path.join(dir, `${method}.json`);
process.stdout.write(fs.readFileSync(fs.existsSync(numbered) ? numbered : fallback, "utf8"));
NODE
    return 0
  fi

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

prompt_managed_root() {
  local default_root=$1
  local answer
  printf 'Managed agent root [%s]: ' "$default_root" >&2
  IFS= read -r answer
  if [[ -z "$answer" ]]; then
    printf '%s\n' "$default_root"
  else
    expand_home "$answer"
  fi
}

is_git_repo() {
  [[ -e "$1/.git" ]] || return 1
  git -C "$1" rev-parse --is-inside-work-tree >/dev/null 2>&1
}

default_workspace_name_from_source() {
  local source=$1
  local base
  base=$(basename "$source")
  base=${base%.git}
  [[ -n "$base" ]] || base="smithersbot"
  printf '%s\n' "$base"
}

validate_workspace_name() {
  local name=$1
  [[ -n "$name" ]] || return 1
  [[ ${#name} -le 64 ]] || return 1
  [[ "$name" != *".."* ]] || return 1
  [[ "$name" != /* && "$name" != \\* ]] || return 1
  [[ "$name" != *"/"* && "$name" != *"\\"* ]] || return 1
  [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || return 1
  [[ "$name" != "." && "$name" != ".." ]] || return 1
  return 0
}

prompt_repo_source() {
  local choice source
  while true; do
    printf 'What repo should agents work on?\n' >&2
    printf '  1) this SmithersBot checkout\n' >&2
    printf '  2) another local repo path\n' >&2
    printf '  3) clone a repo URL\n' >&2
    printf 'Choose [1/2/3]: ' >&2
    IFS= read -r choice
    case "$choice" in
      ""|1)
        printf 'local:%s\n' "$(pwd)"
        return 0
        ;;
      2)
        printf 'Local repo path: ' >&2
        IFS= read -r source
        [[ -n "$source" ]] || fail "local repo path cannot be empty"
        source=$(expand_home "$source")
        [[ -d "$source" ]] || fail "local repo path does not exist: $source"
        printf 'local:%s\n' "$source"
        return 0
        ;;
      3)
        printf 'Git repo URL: ' >&2
        IFS= read -r source
        [[ -n "$source" ]] || fail "git repo URL cannot be empty"
        printf 'url:%s\n' "$source"
        return 0
        ;;
      *)
        printf 'Please choose 1, 2, or 3.\n' >&2
        ;;
    esac
  done
}

prompt_workspace_name() {
  local default_name=$1
  local answer
  while true; do
    printf 'Workspace name [%s]: ' "$default_name" >&2
    IFS= read -r answer
    [[ -n "$answer" ]] || answer=$default_name
    if validate_workspace_name "$answer"; then
      printf '%s\n' "$answer"
      return 0
    fi
    printf 'Workspace name must be a single safe path segment using letters, numbers, dot, underscore, or dash.\n' >&2
  done
}

ensure_empty_or_absent_dir() {
  local dir=$1
  if [[ -d "$dir" ]] && [[ -n "$(find "$dir" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    fail "workspace repo already exists and is not empty: $dir"
  fi
}

materialize_workspace_repo() {
  local source_kind=$1
  local source_value=$2
  local workspace_repo=$3
  local workspace_parent
  workspace_parent=$(dirname "$workspace_repo")
  mkdir -p "$workspace_parent"
  ensure_empty_or_absent_dir "$workspace_repo"

  if [[ "$source_kind" == "url" ]]; then
    git clone -- "$source_value" "$workspace_repo"
    info "Cloned repo URL into isolated agent workspace: $workspace_repo"
    return 0
  fi

  if is_git_repo "$source_value"; then
    git clone -- "$source_value" "$workspace_repo"
    info "Cloned local git repo into isolated agent workspace: $workspace_repo"
    return 0
  fi

  mkdir -p "$workspace_repo"
  cp -a "$source_value"/. "$workspace_repo"/
  info "Local source is not a git repo; copied it into isolated agent workspace: $workspace_repo"
}

create_private_workspace_env() {
  local managed_root=$1
  local workspace_name=$2
  local env_dir="$managed_root/private/env/$workspace_name"
  local env_file="$env_dir/.env"
  local tmp
  mkdir -p "$env_dir"
  chmod 700 "$env_dir" 2>/dev/null || true
  if [[ ! -e "$env_file" ]]; then
    tmp=$(mktemp "$env_file.tmp.XXXXXX")
    chmod 600 "$tmp"
    {
      printf '# SmithersBot per-workspace private environment.\n'
      printf '# Add real secrets here on the host only; this file is outside the agent workspace.\n'
      printf '# EXAMPLE_API_KEY=replace-me\n'
    } >"$tmp"
    mv "$tmp" "$env_file"
  fi
  chmod 600 "$env_file"
}

prompt_operator_honorific() {
  local answer
  printf 'How should SmithersBot address you? [sir] ' >&2
  IFS= read -r answer
  if [[ -z "$answer" ]]; then
    printf 'sir\n'
  else
    printf '%s\n' "$answer"
  fi
}

print_systemd_commands() {
  info "To install and start the optional user service later, run:"
  info "  scripts/install-smithersbot-user-service.sh"
  info "  systemctl --user start smithersbot.service"
}

offer_systemd() {
  local answer
  printf 'Install and start the optional systemd user service now? [y/N] ' >&2
  IFS= read -r answer
  case "$answer" in
    y|Y|yes|YES)
      if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user --version >/dev/null 2>&1; then
        info "Warning: systemctl --user is not available in this environment."
        print_systemd_commands
        return 0
      fi
      scripts/install-smithersbot-user-service.sh
      systemctl --user start smithersbot.service
      info "Started smithersbot.service."
      ;;
    *)
      print_systemd_commands
      ;;
  esac
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
require_pnpm
warn_backend_availability

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

managed_root_default=$(resolve_managed_root)
managed_root=$(prompt_managed_root "$managed_root_default")
create_managed_tree "$managed_root"
info "Managed root: $managed_root"

repo_source=$(prompt_repo_source)
repo_source_kind=${repo_source%%:*}
repo_source_value=${repo_source#*:}
workspace_default=$(default_workspace_name_from_source "$repo_source_value")
workspace_name=$(prompt_workspace_name "$workspace_default")
workspace_repo="$managed_root/agent/workspaces/$workspace_name"
materialize_workspace_repo "$repo_source_kind" "$repo_source_value" "$workspace_repo"
create_private_workspace_env "$managed_root" "$workspace_name"
info "Agent-editable workspace repo: $workspace_repo"
info "Per-workspace private env: $managed_root/private/env/$workspace_name/.env"
info "Anything agents should read or edit must live inside $workspace_repo."
info "Private env/config/auth stay under $managed_root/private and are not agent-visible."

operator_honorific=$(prompt_operator_honorific)

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
  write_config_file "$config_file" "$allowed_id" "$backend" "$gateway_token" "$workspace_name" "$workspace_repo" "$operator_honorific"
else
  chmod 600 "$config_file"
  info "Kept existing $config_file"
fi

offer_systemd

info ""
info "SmithersBot setup complete."
info "Config directory: $config_dir"
info "Managed root: $managed_root (agent area + private host-only area)"
info "  Workspace repo: $workspace_repo"
info "  Real env files live in $managed_root/private/env/<name>/.env (not agent-visible)"
if [[ "$state_dir" != "$config_dir" ]]; then
  info "State directory: $state_dir"
  info "Set SMITHERSBOT_STATE_DIR=$state_dir before starting if you want to use this state directory."
fi
info ""
info "Start the gateway from the repository root:"
info "  node scripts/run-node.mjs gateway"
info ""
info "First Telegram smoke tests:"
info "  /gateway_status"
info "  /usage_status"
info "  /repo_chat say only: repo chat works"
info "  /new_goal Inspect the repository state and report whether the working tree is clean. Do not edit files."
