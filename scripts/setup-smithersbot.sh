#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/setup-smithersbot.sh [--config-dir DIR] [--state-dir DIR] [--no-build] [--backend codex|claude_code] [--instance default|stable|dev]

Sets up local SmithersBot Telegram configuration in ~/.smithersbot by default.
USAGE
}

info() {
  printf '%s\n' "$*"
}

SETUP_COLOR=0
if [[ -t 1 && -z "${NO_COLOR+x}" ]]; then
  SETUP_COLOR=1
fi

setup_color_enabled() {
  [[ "$SETUP_COLOR" == "1" ]]
}

style_text() {
  local code=$1
  shift
  if setup_color_enabled; then
    printf '\033[%sm%s\033[0m' "$code" "$*"
  else
    printf '%s' "$*"
  fi
}

bold() {
  style_text "1" "$*"
}

dim() {
  style_text "2" "$*"
}

green() {
  style_text "32" "$*"
}

yellow() {
  style_text "33" "$*"
}

red() {
  style_text "31" "$*"
}

cyan() {
  style_text "36" "$*"
}

success_marker() {
  green "✓"
}

warning_label() {
  yellow "Warning:"
}

error_marker() {
  red "✕"
}

fail() {
  printf '%s %s\n' "$(red "Error:")" "$*" >&2
  exit 1
}

print_separator() {
  info "$(dim "────────────────────────────────────────")"
}

print_step_header() {
  local number=$1
  local title=$2
  print_separator
  info "$(cyan "$(bold "Step $number of 6: $title")")"
  print_separator
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

select_gateway_instance() {
  local selection=${1:-default}
  case "${selection,,}" in
    ""|default|stable)
      gateway_instance_name="stable"
      gateway_state_dir_name=".smithersbot"
      gateway_managed_root_dir_name="smithersbot-home"
      gateway_service_unit="smithersbot-gateway.service"
      gateway_default_port="18789"
      gateway_legacy_managed_root_fallback=1
      ;;
    dev)
      gateway_instance_name="dev"
      gateway_state_dir_name=".smithersbot-dev"
      gateway_managed_root_dir_name="smithersbot-dev-home"
      gateway_service_unit="smithersbot-dev-gateway.service"
      gateway_default_port="18790"
      gateway_legacy_managed_root_fallback=0
      ;;
    *)
      fail "Unknown SmithersBot gateway instance \"$selection\". Allowed values: default, stable, dev."
      ;;
  esac
}

resolve_managed_root() {
  local override=${SMITHERSBOT_GOALS_ROOT:-}
  if [[ -n "$override" ]]; then
    expand_home "$override"
  else
    local default_root
    default_root=$(expand_home "~/$gateway_managed_root_dir_name")
    if [[ "$gateway_legacy_managed_root_fallback" == "1" ]]; then
      local legacy_root
      legacy_root=$(expand_home "~/smithersbot-goals")
      if [[ ! -d "$default_root" && -d "$legacy_root" ]]; then
        printf '%s\n' "$legacy_root"
        return 0
      fi
    fi
    printf '%s\n' "$default_root"
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

read_env_value_from_file() {
  local path=$1
  local key=$2
  ENV_FILE_PATH="$path" ENV_KEY="$key" node --input-type=module <<'NODE'
import fs from "node:fs";

const file = process.env.ENV_FILE_PATH;
const key = process.env.ENV_KEY;
if (!file || !key || !fs.existsSync(file)) process.exit(0);

let raw;
try {
  raw = fs.readFileSync(file, "utf8");
} catch {
  process.exit(2);
}

for (const line of raw.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const assignment = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
  const eq = assignment.indexOf("=");
  if (eq <= 0) continue;
  if (assignment.slice(0, eq).trim() !== key) continue;
  let value = assignment.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  process.stdout.write(value);
  process.exit(0);
}
NODE
}

block_dev_same_telegram_token() {
  local token=$1
  local stable_env_file
  local stable_token
  if [[ "$gateway_instance_name" != "dev" ]]; then
    return 0
  fi

  stable_env_file=$(expand_home "~/.smithersbot/.env")
  [[ -f "$stable_env_file" ]] || return 0
  if ! stable_token=$(read_env_value_from_file "$stable_env_file" "TELEGRAM_BOT_TOKEN"); then
    fail "could not read the stable Telegram bot token for the dev safety check"
  fi
  if [[ -n "$stable_token" && "$stable_token" == "$token" ]]; then
    fail "dev gateway Telegram bot token must differ from the stable gateway token; create a separate dev Telegram bot token"
  fi
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
  if [[ -n "$workspace_name" && -n "$workspace_repo" ]]; then
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
  else
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
      "identity": {
        "operatorHonorific": "$escaped_operator_honorific"
      }
    }
  },
  "goal": {}
}
JSON
  fi
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
  NODE_VERSION_FOUND=$version
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

print_system_requirements() {
  info "Checking system requirements..."
  info "$(success_marker) Node ${NODE_VERSION_FOUND#v} or newer"
  info "$(success_marker) pnpm"
  info "$(success_marker) git"
}

run_captured_command() {
  local label=$1
  shift
  local log_file
  log_file=$(mktemp)
  if "$@" >"$log_file" 2>&1; then
    rm -f "$log_file"
    return 0
  fi

  info ""
  info "$label failed. Last log lines:"
  tail -n 80 "$log_file" >&2 || true
  rm -f "$log_file"
  return 1
}

warn_backend_availability() {
  if command -v codex >/dev/null 2>&1 || command -v claude >/dev/null 2>&1 || command -v claude_code >/dev/null 2>&1; then
    return 0
  fi
  info "$(warning_label) no supported agent backend command was found on PATH (codex or claude_code)."
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

  printf '%s Detected Telegram private chat ID:\n' "$(success_marker)" >&2
  printf '  %s\n' "$detected_id" >&2
  printf '\n' >&2
  printf 'Use this Telegram private chat ID for allowFrom? [Y/n]: ' >&2
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
    printf 'Open @%s in Telegram and press Start, or send any message. Then choose retry, or enter the private chat ID manually.\n' "$bot_username" >&2
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

  printf 'Open this bot in Telegram:\n' >&2
  printf '  @%s\n' "$bot_username" >&2
  printf '\n' >&2
  printf 'Press Start, or send any message.\n' >&2
  printf 'Do not use @BotFather here. BotFather has completed his part.\n' >&2
  printf '\n' >&2
  printf 'Waiting for your Telegram message...\n' >&2

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
  local normalized
  while true; do
    printf 'Which backend should repo chat use by default?\n' >&2
    printf '\n' >&2
    printf '1) Codex\n' >&2
    printf '2) Claude Code\n' >&2
    printf '\n' >&2
    printf 'Choose [ENTER for default: Codex]: ' >&2
    IFS= read -r answer
    normalized=${answer,,}
    normalized=${normalized/ /_}
    case "$normalized" in
      ""|1|codex)
        printf 'codex\n'
        return 0
        ;;
      2|claude_code)
        printf 'claude_code\n'
        return 0
        ;;
      *)
        printf 'Please choose 1/2, Codex, Claude Code, or claude_code.\n' >&2
        ;;
    esac
  done
}

discover_codex_native_binary() {
  local codex_path=$1
  CODEX_PATH_SETUP="$codex_path" node --input-type=module <<'NODE'
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const codexPath = process.env.CODEX_PATH_SETUP;
if (!codexPath) process.exit(1);

const candidate = path.resolve(
  path.dirname(codexPath),
  "..",
  "lib",
  "node_modules",
  "@openai",
  "codex",
  "node_modules",
  "@openai",
  "codex-linux-x64",
  "vendor",
  "x86_64-unknown-linux-musl",
  "bin",
  "codex",
);
if (fs.existsSync(candidate)) {
  console.log(candidate);
  process.exit(0);
}

const packageRoot = path.resolve(
  path.dirname(codexPath),
  "..",
  "lib",
  "node_modules",
  "@openai",
  "codex",
);
try {
  const result = execFileSync("find", [packageRoot, "-path", "*/bin/codex", "-type", "f"], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  })
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.includes("codex-linux"));
  if (result) {
    console.log(result);
    process.exit(0);
  }
} catch {}

process.exit(1);
NODE
}

print_codex_helper_missing() {
  info "$(error_marker) Codex is installed, but SmithersBot could not locate the Codex native sandbox helper."
  info ""
  info "Try:"
  info ""
  info "  sudo npm install -g @openai/codex@latest"
  info "  codex login"
  info '  codex "say only: codex works"'
  info ""
  info "Then run setup again."
}

print_claude_sandbox_dependencies_missing() {
  local marker=$1
  info "$marker Claude Code is installed, but its native sandbox dependencies are missing."
  info ""
  info "Install them with:"
  info ""
  info "  sudo apt install -y bubblewrap socat"
  info ""
  info "Then run:"
  info ""
  info '  claude -p "say only: claude works"'
  info ""
  info "Then run setup again."
}

claude_code_cli_path() {
  command -v claude 2>/dev/null || command -v claude_code 2>/dev/null || true
}

# Pinned tui-pilot version SmithersBot depends on. tui-pilot is an INSTALLED
# prerequisite (uv tool install), never vendored. Override the version/source via
# SMITHERSBOT_TUI_PILOT_VERSION / SMITHERSBOT_TUI_PILOT_SOURCE.
TUI_PILOT_PINNED_VERSION="${SMITHERSBOT_TUI_PILOT_VERSION:-0.8.61}"

# Provider credentials the tui-pilot-driven Claude session must NOT inherit. The
# driven session authenticates via the Max subscription OAuth token (HOME-relative
# ~/.claude/.credentials.json), so these keys are scrubbed at the claude spawn to
# keep a stray API key from silently switching billing away from the subscription.
# Mirrors src/goal/claude-code-env.ts AUTH_KEYS_TO_STRIP + CREDENTIAL_KEYS_TO_STRIP.
TUI_PILOT_PROVIDER_KEY_SCRUB=(
  ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY_OLD ANTHROPIC_BASE_URL
  OPENAI_API_KEY OPENAI_BASE_URL OPENROUTER_API_KEY GOOGLE_API_KEY GEMINI_API_KEY
  AZURE_OPENAI_API_KEY MISTRAL_API_KEY GROQ_API_KEY DEEPSEEK_API_KEY COHERE_API_KEY
  HF_TOKEN REPLICATE_API_TOKEN
)

# tui-pilot is OPTIONAL — the direct `claude -p` path is the default/main path. Setup
# only installs + enables tui-pilot when the operator opts in.
tui_pilot_opt_in() {
  case "$(printf '%s' "${SMITHERSBOT_ENABLE_TUI_PILOT:-}" | tr '[:upper:]' '[:lower:]')" in
    1 | true | yes | on) return 0 ;;
    *) return 1 ;;
  esac
}

# When opted in, point goal.claudeDriver at tui-pilot (+ pin) in the freshly written
# config. Default (no opt-in) leaves goal.claudeDriver unset → the code default `direct`.
enable_tui_pilot_driver_in_config() {
  local config_file=$1
  [[ -f "$config_file" ]] || return 0
  if SMITHERSBOT_CONFIG_FILE="$config_file" TUI_PILOT_PIN="$TUI_PILOT_PINNED_VERSION" python3 - <<'PY'
import json, os
path = os.environ["SMITHERSBOT_CONFIG_FILE"]
pin = os.environ["TUI_PILOT_PIN"]
with open(path) as fh:
    cfg = json.load(fh)
goal = cfg.setdefault("goal", {})
goal["claudeDriver"] = "tui-pilot"
goal["tuiPilot"] = {"version": pin}
with open(path, "w") as fh:
    json.dump(cfg, fh, indent=2)
    fh.write("\n")
print(f"enabled tui-pilot driver in {path} (pin {pin})")
PY
  then
    chmod 600 "$config_file"
    info "$(success_marker) tui-pilot enabled in config (goal.claudeDriver=tui-pilot)"
  else
    info "$(warning_label) Could not enable tui-pilot in $config_file; leaving direct \`claude -p\` default."
  fi
}

# Resolve the tui-pilot install source: an explicit override, else the sibling
# local checkout (dev + single-host prod), mirroring resolveClaudeBinary's
# local-checkout-in-dev / installed-in-prod intent.
resolve_tui_pilot_source() {
  if [[ -n "${SMITHERSBOT_TUI_PILOT_SOURCE:-}" ]]; then
    printf '%s' "$SMITHERSBOT_TUI_PILOT_SOURCE"
    return 0
  fi
  local script_dir repo_root sibling
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  repo_root="$(cd "$script_dir/.." && pwd)"
  sibling="$(cd "$repo_root/.." 2>/dev/null && pwd)/tui-pilot"
  if [[ -f "$sibling/pyproject.toml" ]]; then
    printf '%s' "$sibling"
    return 0
  fi
  return 1
}

# Install the pinned tui-pilot via `uv tool install` and verify the version. The
# runtime preflight (src/goal/tui-pilot-driver.ts) is the fail-closed gate per run;
# setup is best-effort and reports status so an unbuilt local checkout doesn't block
# the rest of provisioning.
install_tui_pilot_dependency() {
  info "Installing tui-pilot prompt-run driver (pinned $TUI_PILOT_PINNED_VERSION)..."
  if ! command -v uv >/dev/null 2>&1; then
    info "$(warning_label) uv was not found on PATH; cannot install tui-pilot."
    info "  Install uv (https://docs.astral.sh/uv/) then re-run setup."
    return 0
  fi

  local source
  if ! source="$(resolve_tui_pilot_source)"; then
    info "$(warning_label) Could not resolve a tui-pilot install source."
    info "  Set SMITHERSBOT_TUI_PILOT_SOURCE to a local path or 'tui-pilot @ git+<url>@v$TUI_PILOT_PINNED_VERSION'."
    return 0
  fi

  if ! run_captured_command "Installing tui-pilot via uv tool install" \
    uv tool install --force "$source"; then
    info "$(warning_label) uv tool install of tui-pilot failed (source: $source)."
    return 0
  fi

  local installed
  installed="$(tui-pilot --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  if [[ -z "$installed" ]]; then
    info "$(warning_label) tui-pilot installed but 'tui-pilot --version' produced no version."
  elif [[ "$installed" == "$TUI_PILOT_PINNED_VERSION" ]]; then
    info "$(success_marker) tui-pilot $installed installed (matches pin $TUI_PILOT_PINNED_VERSION)"
  else
    info "$(warning_label) tui-pilot $installed installed but pin is $TUI_PILOT_PINNED_VERSION (runtime preflight will fail closed)."
  fi

  if ! command -v tui-pilot >/dev/null 2>&1; then
    info "$(warning_label) tui-pilot is not on PATH after install."
    info "  Ensure the uv tool bin dir (usually ~/.local/bin) is on the service PATH."
  fi
}

# Write ~/.tui-pilot/config.toml so the tui-pilot-driven Claude session scrubs
# provider API keys (env_scrub_extra) while keeping HOME/OAuth intact. Merge-
# preserving: existing sandbox_root / seed_config_dir / env_scrub_extra are kept.
write_tui_pilot_operator_config() {
  local cfg="$HOME/.tui-pilot/config.toml"
  mkdir -p "$(dirname "$cfg")"
  if ! TUI_PILOT_CONFIG_PATH="$cfg" \
    TUI_PILOT_SCRUB_KEYS="${TUI_PILOT_PROVIDER_KEY_SCRUB[*]}" \
    python3 - <<'PY'
# tomllib is 3.11+; setup may run under an older system python, so parse the simple
# flat config.toml (only sandbox_root / seed_config_dir / env_scrub_extra) by regex.
import os, re

path = os.environ["TUI_PILOT_CONFIG_PATH"]
scrub = os.environ["TUI_PILOT_SCRUB_KEYS"].split()

text = ""
if os.path.isfile(path):
    with open(path, "r", encoding="utf-8") as fh:
        text = fh.read()


def read_str(key):
    m = re.search(rf'^\s*{re.escape(key)}\s*=\s*"([^"]*)"', text, re.MULTILINE)
    return m.group(1) if m else None


def read_array(key):
    m = re.search(rf'^\s*{re.escape(key)}\s*=\s*\[(.*?)\]', text, re.MULTILINE | re.DOTALL)
    if not m:
        return []
    return re.findall(r'"([^"]*)"', m.group(1))


sandbox_root = read_str("sandbox_root")
seed_config_dir = read_str("seed_config_dir")
merged = list(dict.fromkeys([*read_array("env_scrub_extra"), *scrub]))

lines = [
    "# Managed by setup-smithersbot.sh. env_scrub_extra scrubs provider API keys\n",
    "# from tui-pilot-driven Claude sessions so they authenticate via the Max\n",
    "# subscription OAuth token (HOME / ~/.claude/.credentials.json), not an API key.\n",
]
if sandbox_root:
    lines.append(f'sandbox_root = "{sandbox_root}"\n')
if seed_config_dir:
    lines.append(f'seed_config_dir = "{seed_config_dir}"\n')
arr = ", ".join(f'"{name}"' for name in merged)
lines.append(f"env_scrub_extra = [{arr}]\n")

with open(path, "w", encoding="utf-8") as fh:
    fh.writelines(lines)
print(f"wrote {path} ({len(merged)} scrubbed names)")
PY
  then
    info "$(warning_label) Could not write $cfg (provider-key scrub for tui-pilot)."
    return 0
  fi
  info "$(success_marker) tui-pilot provider-key scrub configured ($cfg)"
}

check_claude_sandbox_dependencies() {
  local active_backend=$1
  local claude_path missing=()

  claude_path=$(claude_code_cli_path)
  if [[ "$active_backend" != "1" && -z "$claude_path" ]]; then
    return 0
  fi

  command -v bwrap >/dev/null 2>&1 || missing+=("bwrap")
  command -v socat >/dev/null 2>&1 || missing+=("socat")
  if [[ "${#missing[@]}" -eq 0 ]]; then
    return 0
  fi

  if [[ "$active_backend" == "1" ]]; then
    print_claude_sandbox_dependencies_missing "$(error_marker)"
    exit 1
  fi

  print_claude_sandbox_dependencies_missing "$(warning_label)"
}

check_codex_backend() {
  local codex_path

  info "Checking Codex backend..."
  if codex_path=$(command -v codex 2>/dev/null); then
    info "$(success_marker) Codex CLI found"
    if ! discover_codex_native_binary "$codex_path" >/dev/null; then
      print_codex_helper_missing
      exit 1
    fi
  else
    info "$(warning_label) Codex CLI was not found on PATH."
  fi
}

check_claude_code_backend() {
  local claude_path

  info "Checking Claude Code backend..."
  claude_path=$(claude_code_cli_path)
  if [[ -n "$claude_path" ]]; then
    info "$(success_marker) Claude Code CLI found"
  else
    info "$(warning_label) Claude Code CLI was not found on PATH."
  fi
  check_claude_sandbox_dependencies 1
  # The direct `claude -p` path is the default. tui-pilot is an OPTIONAL prompt-run
  # driver: provision it (install + provider-key scrub) only when the operator opts in
  # with SMITHERSBOT_ENABLE_TUI_PILOT=1. A host without tui-pilot runs entirely on
  # `claude -p` (the runtime never invokes tui-pilot unless goal.claudeDriver is set).
  if tui_pilot_opt_in; then
    install_tui_pilot_dependency
    write_tui_pilot_operator_config
  else
    info "tui-pilot driver: not enabled (default is direct \`claude -p\`). Set SMITHERSBOT_ENABLE_TUI_PILOT=1 to install + enable it."
  fi
}

check_repo_backend() {
  local selected_backend=$1

  case "$selected_backend" in
    claude_code)
      check_claude_code_backend
      ;;
    *)
      check_codex_backend
      check_claude_sandbox_dependencies 0
      ;;
  esac
}

prompt_managed_root() {
  local default_root=$1
  local answer
  printf 'Where should SmithersBot store workspaces, redacted history, and private project env files?\n' >&2
  printf '[ENTER for default: %s]: ' "$default_root" >&2
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

package_workspace_name() {
  local source=$1
  [[ -f "$source/package.json" ]] || return 1
  PACKAGE_JSON_PATH="$source/package.json" node --input-type=module <<'NODE'
import fs from "node:fs";
const pkg = JSON.parse(fs.readFileSync(process.env.PACKAGE_JSON_PATH, "utf8"));
const raw = typeof pkg.name === "string" ? pkg.name : "";
const name = raw.startsWith("@") ? raw.split("/").pop() : raw;
if (name) console.log(name);
NODE
}

default_workspace_name_from_source() {
  local source=$1
  local base
  if [[ -d "$source" ]]; then
    base=$(package_workspace_name "$source" 2>/dev/null || true)
    if [[ -n "$base" ]] && validate_workspace_name "$base"; then
      printf '%s\n' "$base"
      return 0
    fi
  fi
  base=$(basename "${source%/}")
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
    printf 'Is there a repo you would like SmithersBot to work on first?\n' >&2
    printf '\n' >&2
    printf '1) This SmithersBot checkout\n' >&2
    printf '%s\n' "$(dim "   Copy this checkout into a new agent-editable workspace.")" >&2
    printf '\n' >&2
    printf '2) Another local repo path\n' >&2
    printf '%s\n' "$(dim "   Copy or clone an existing local repo into a new agent-editable workspace.")" >&2
    printf '%s\n' "$(dim "   Example: ~/smithersbot")" >&2
    printf '\n' >&2
    printf '3) Clone a repo URL\n' >&2
    printf '%s\n' "$(dim "   Clone a GitHub or Git repo URL into a new agent-editable workspace.")" >&2
    printf '\n' >&2
    printf '4) No thanks\n' >&2
    printf '%s\n' "$(dim "   I will add workspaces myself later.")" >&2
    printf '\n' >&2
    printf 'Choose [1/2/3/4]: ' >&2
    IFS= read -r choice
    case "$choice" in
      ""|1)
        printf 'local:%s\n' "$(pwd)"
        return 0
        ;;
      2)
        source=$(prompt_local_repo_path)
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
      4)
        printf 'none:\n'
        return 0
        ;;
      *)
        printf 'Please choose 1, 2, 3, or 4.\n' >&2
        ;;
    esac
  done
}

prompt_local_repo_path() {
  local source expanded
  printf 'Local repo path:\n' >&2
  printf '%s\n' "$(dim "Example: ~/smithersbot")" >&2
  while true; do
    printf '\n' >&2
    printf 'Local repo path: ' >&2
    IFS= read -r source
    if [[ -n "$source" ]]; then
      expanded=$(expand_home "$source")
      if [[ -d "$expanded" ]]; then
        printf '%s\n' "$expanded"
        return 0
      fi
    fi
    printf '%s That path does not exist:\n' "$(error_marker)" >&2
    printf '  %s\n' "$source" >&2
    printf '\n' >&2
    printf 'Enter a local repo path, or press Ctrl-C to cancel.\n' >&2
    printf '%s\n' "$(dim "Example: ~/smithersbot")" >&2
  done
}

prompt_workspace_name() {
  local default_name=$1
  local answer
  while true; do
    printf 'Workspace name [ENTER for default: %s]: ' "$default_name" >&2
    IFS= read -r answer
    [[ -n "$answer" ]] || answer=$default_name
    if validate_workspace_name "$answer"; then
      printf '%s\n' "$answer"
      return 0
    fi
    printf 'Workspace name must be a single safe path segment using letters, numbers, dot, underscore, or dash.\n' >&2
  done
}

dir_is_nonempty() {
  [[ -d "$1" ]] && [[ -n "$(find "$1" -mindepth 1 -maxdepth 1 -print -quit)" ]]
}

resolve_workspace_repo() {
  local managed_root=$1
  local default_name=$2
  local workspace_name answer target legacy_repo
  while true; do
    workspace_name=$(prompt_workspace_name "$default_name")
    target="$managed_root/agent/workspaces/$workspace_name"
    legacy_repo="$target/repo"

    if dir_is_nonempty "$target"; then
      if [[ -d "$legacy_repo" ]]; then
        printf 'A legacy workspace already exists:\n' >&2
        printf '  %s\n' "$legacy_repo" >&2
        printf '\n' >&2
        printf 'Use this existing legacy workspace, choose another name, or cancel?\n' >&2
        printf '\n' >&2
        printf '1) Use existing legacy workspace\n' >&2
      else
        printf 'A workspace named %s already exists:\n' "$workspace_name" >&2
        printf '  %s\n' "$target" >&2
        printf '\n' >&2
        printf 'Use this existing workspace, choose another name, or cancel?\n' >&2
        printf '\n' >&2
        printf '1) Use existing workspace\n' >&2
      fi
      printf '2) Choose another workspace name\n' >&2
      printf '3) Cancel setup\n' >&2
      printf '\n' >&2
      printf 'Choose [1/2/3]: ' >&2
      IFS= read -r answer
      case "$answer" in
        1)
          if [[ -d "$legacy_repo" ]]; then
            printf '%s|%s|legacy\n' "$workspace_name" "$legacy_repo"
          else
            printf '%s|%s|existing\n' "$workspace_name" "$target"
          fi
          return 0
          ;;
        2)
          continue
          ;;
        3)
          exit 0
          ;;
        *)
          printf 'Please choose 1, 2, or 3.\n' >&2
          continue
          ;;
      esac
    fi

    printf '%s|%s|new\n' "$workspace_name" "$target"
    return 0
  done
}

materialize_workspace_repo() {
  local source_kind=$1
  local source_value=$2
  local workspace_repo=$3
  local workspace_parent
  workspace_parent=$(dirname "$workspace_repo")
  mkdir -p "$workspace_parent"
  info "Preparing the workspace..."

  if [[ "$source_kind" == "url" ]]; then
    run_captured_command "Preparing the workspace" git clone -- "$source_value" "$workspace_repo"
    info "$(success_marker) Workspace ready:"
    info "  $workspace_repo"
    return 0
  fi

  if is_git_repo "$source_value"; then
    run_captured_command "Preparing the workspace" git clone -- "$source_value" "$workspace_repo"
    info "$(success_marker) Workspace ready:"
    info "  $workspace_repo"
    return 0
  fi

  mkdir -p "$workspace_repo"
  run_captured_command "Preparing the workspace" cp -a "$source_value"/. "$workspace_repo"/
  info "$(success_marker) Workspace ready:"
  info "  $workspace_repo"
}

install_new_workspace_dependencies() {
  local workspace_repo=$1

  if [[ ! -f "$workspace_repo/pnpm-lock.yaml" ]]; then
    return 0
  fi

  info "Installing workspace dependencies..."
  if (cd "$workspace_repo" && run_captured_command "Installing workspace dependencies" pnpm install --frozen-lockfile); then
    info "$(success_marker) Workspace dependencies installed"
    return 0
  fi

  info "Workspace was created, but dependency installation failed."
  info "Run this in the workspace before starting goals that use build/test gates:"
  info "cd $workspace_repo && pnpm install --frozen-lockfile"
}

print_existing_workspace_dependency_hint() {
  local workspace_repo=$1

  if [[ -f "$workspace_repo/pnpm-lock.yaml" ]]; then
    info "This workspace has a pnpm lockfile. Dependencies may need to be installed before goals that use build/test gates:"
    info "cd $workspace_repo && pnpm install --frozen-lockfile"
  fi
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

print_workspace_private_pointers() {
  local managed_root=$1
  local workspace_name=$2
  local workspace_repo=$3
  info ""
  info "Make sure to put all files you want SmithersBot to read and edit in that workspace."
  info ""
  info "Private .env for this repo that SmithersBot cannot read:"
  info "  $managed_root/private/env/$workspace_name/.env"
  info ""
  info "All private env/config/auth should stay under:"
  info "  $managed_root/private"
}

print_no_first_workspace() {
  local managed_root=$1
  info "$(success_marker) No first workspace created."
  info ""
  info "To add a workspace later:"
  info ""
  info "1. Copy or clone your project into:"
  info "   $managed_root/agent/workspaces/<workspace-name>"
  info ""
  info "2. Put real project secrets in:"
  info "   $managed_root/private/env/<workspace-name>/.env"
  info ""
  info "3. Keep a redacted .env.example in the workspace."
  info "   Agents can see which variables the project expects without seeing real secrets."
  info ""
  info "Anything under agent/workspaces can be read and edited by SmithersBot agents."
  info ""
  info "Private env/config/auth should stay under:"
  info "  $managed_root/private"
  info ""
  info "Very good. The workspace can be arranged later."
}

prompt_operator_honorific() {
  local answer
  printf "How should SmithersBot address you? (sir, ma'am, your name, etc.)\n" >&2
  printf '[ENTER for default: sir]: ' >&2
  IFS= read -r answer
  if [[ -z "$answer" ]]; then
    printf 'sir\n'
  else
    printf '%s\n' "$answer"
  fi
}

gateway_manual_command() {
  if [[ "$gateway_instance_name" == "dev" ]]; then
    printf 'SMITHERSBOT_INSTANCE=dev node scripts/run-node.mjs gateway\n'
  else
    printf 'node scripts/run-node.mjs gateway\n'
  fi
}

print_systemd_commands() {
  info "You can start SmithersBot manually from this checkout:"
  info ""
  info "  $(gateway_manual_command)"
  info ""
  info "SmithersBot must be running before Telegram commands will work."
}

print_service_start_failed() {
  print_separator
  info "SmithersBot did not start"
  print_separator
  info ""
  info "The setup files were written, but the background service did not start."
  info ""
  info "Check status:"
  info ""
  info "  systemctl --user status $gateway_service_unit --no-pager"
  info ""
  info "View logs:"
  info ""
  info "  journalctl --user -u $gateway_service_unit -n 120 --no-pager"
  info ""
  info "You can also start SmithersBot manually from this checkout:"
  info ""
  info "  $(gateway_manual_command)"
}

wait_for_gateway_service() {
  local deadline now wait_seconds
  wait_seconds=${SMITHERSBOT_SETUP_SERVICE_WAIT_SECONDS:-10}
  deadline=$(($(date +%s) + wait_seconds))
  while true; do
    if systemctl --user is-active "$gateway_service_unit" >/dev/null 2>&1; then
      return 0
    fi
    now=$(date +%s)
    (( now >= deadline )) && break
    sleep 1
  done
  return 1
}

offer_systemd() {
  local answer service_path install_log
  SETUP_RUN_MODE="manual"
  printf 'Do you want SmithersBot to run in the background and keep working after you close this terminal?\n' >&2
  printf 'This installs and starts the user service: %s\n' "$gateway_service_unit" >&2
  printf '[Y/n]: ' >&2
  IFS= read -r answer
  case "$answer" in
    ""|y|Y|yes|YES)
      if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user --version >/dev/null 2>&1; then
        info "$(warning_label) systemctl --user is not available in this environment."
        print_systemd_commands
        return 0
      fi
      info "Installing user service..."
      install_log=$(mktemp)
      local install_args=()
      if [[ "$gateway_instance_name" == "dev" ]]; then
        install_args=(--instance dev)
      fi
      if ! scripts/install-smithersbot-user-service.sh "${install_args[@]}" >"$install_log" 2>&1; then
        info "Installing user service failed. Last log lines:"
        tail -n 80 "$install_log" >&2 || true
        rm -f "$install_log"
        SETUP_RUN_MODE="failed"
        print_service_start_failed
        return 0
      fi
      rm -f "$install_log"
      service_path="$HOME/.config/systemd/user/$gateway_service_unit"
      info "$(success_marker) Wrote user service:"
      info "  $service_path"
      info ""
      if ! run_captured_command "Reloading user service manager" systemctl --user daemon-reload; then
        SETUP_RUN_MODE="failed"
        print_service_start_failed
        return 0
      fi
      info "Starting SmithersBot..."
      if ! run_captured_command "Starting SmithersBot" systemctl --user enable --now "$gateway_service_unit"; then
        SETUP_RUN_MODE="failed"
        print_service_start_failed
        return 0
      fi
      if ! wait_for_gateway_service; then
        SETUP_RUN_MODE="failed"
        print_service_start_failed
        return 0
      fi
      SETUP_RUN_MODE="service"
      info "$(success_marker) SmithersBot is now standing by in the background."
      info ""
      info "SmithersBot may take 1-2 minutes to answer the first Telegram message."
      ;;
    *)
      print_systemd_commands
      ;;
  esac
}

backend_label() {
  case "$1" in
    claude_code) printf 'Claude Code\n' ;;
    *) printf 'Codex\n' ;;
  esac
}

print_setup_complete() {
  local managed_root=$1
  local bot_username=$2
  local allowed_id=$3
  local run_mode=$4
  print_separator
  info "Setup complete"
  print_separator
  info ""
  info "Setup complete. The house is in order."
  info ""
  info "$(success_marker) SmithersBot home:"
  info "  $managed_root"
  info ""
  info "$(success_marker) Telegram bot:"
  info "  @$bot_username"
  info ""
  info "$(success_marker) Authorized Telegram chat ID:"
  info "  $allowed_id"
  info ""
  if [[ "$run_mode" == "service" ]]; then
    info "$(success_marker) SmithersBot is running:"
    info "  $gateway_service_unit"
    info ""
    info "SmithersBot may take 1-2 minutes to answer the first Telegram message."
    info ""
    info "Open Telegram and send:"
  else
    info "Start SmithersBot from this checkout:"
    info ""
    info "  $(gateway_manual_command)"
    info ""
    info "After it starts, open Telegram and send:"
  fi
  info ""
  info "  /help"
  info "  /commands"
  info "  /gateway_status"
  info "  /usage_status"
  info "  /goal_list"
  info "  /repo_chat say only: repo chat works"
  info ""
  info "Optional tiny goal test:"
  info ""
  info "  /new_goal Inspect the repository state and report whether the working tree is clean. Do not edit files."
  if [[ "$run_mode" == "service" ]]; then
    info ""
    info "View logs:"
    info ""
    info "  journalctl --user -u $gateway_service_unit -f"
  fi
}

instance_selection="default"
config_dir=""
state_dir=""
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
    --instance)
      [[ $# -ge 2 ]] || fail "--instance requires default, stable, or dev"
      instance_selection=$2
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

select_gateway_instance "$instance_selection"
if [[ -z "$config_dir" ]]; then
  config_dir="~/$gateway_state_dir_name"
fi
if [[ -z "$state_dir" ]]; then
  state_dir="~/$gateway_state_dir_name"
fi

case "$backend" in
  ""|codex|claude_code) ;;
  *) fail "--backend must be codex or claude_code" ;;
esac

info "$(bold "Welcome to SmithersBot installation.")"
info ""
info "This installer will prepare the workspace, configure Telegram, and start the gateway so you can leave agents running without giving up control."
info ""
info "Very good. Let us begin."
info ""

require_repo_root
require_node_22
require_git
require_pnpm
print_system_requirements
warn_backend_availability

if [[ "$run_build" -eq 1 ]]; then
  activate_pnpm
  info "Installing dependencies..."
  if ! run_captured_command "Installing dependencies" pnpm install --frozen-lockfile; then
    exit 1
  fi
  info "$(success_marker) Dependencies installed"
  info "Building SmithersBot..."
  if ! run_captured_command "Building SmithersBot" pnpm build; then
    exit 1
  fi
  info "$(success_marker) Build completed"
else
  info "Skipping pnpm install and pnpm build because --no-build was provided."
fi

config_dir=$(expand_home "$config_dir")
state_dir=$(expand_home "$state_dir")
env_file="$config_dir/.env"
config_file="$config_dir/smithersbot.json"

mkdir -p "$config_dir" "$state_dir"

managed_root_default=$(resolve_managed_root)
print_step_header 1 "SmithersBot home"
managed_root=$(prompt_managed_root "$managed_root_default")
create_managed_tree "$managed_root"
info "$(success_marker) Very good. SmithersBot home is set:"
info "  $managed_root"

print_step_header 2 "How SmithersBot addresses you"
operator_honorific=$(prompt_operator_honorific)
info "Nice to meet you, $operator_honorific."
info "I'll address you as $operator_honorific from now on."

print_step_header 3 "First workspace"
repo_source=$(prompt_repo_source)
repo_source_kind=${repo_source%%:*}
repo_source_value=${repo_source#*:}
workspace_name=""
workspace_repo=""
workspace_status="none"
if [[ "$repo_source_kind" == "none" ]]; then
  print_no_first_workspace "$managed_root"
else
  workspace_default=$(default_workspace_name_from_source "$repo_source_value")
  workspace_selection=$(resolve_workspace_repo "$managed_root" "$workspace_default")
  workspace_name=${workspace_selection%%|*}
  workspace_rest=${workspace_selection#*|}
  workspace_repo=${workspace_rest%%|*}
  workspace_status=${workspace_rest#*|}
  if [[ "$workspace_status" == "new" ]]; then
    materialize_workspace_repo "$repo_source_kind" "$repo_source_value" "$workspace_repo"
    install_new_workspace_dependencies "$workspace_repo"
  else
    if [[ "$workspace_status" == "legacy" ]]; then
      info "$(success_marker) Using existing legacy workspace:"
    else
      info "$(success_marker) Using existing agent workspace:"
    fi
    info "  $workspace_repo"
    print_existing_workspace_dependency_hint "$workspace_repo"
  fi
  create_private_workspace_env "$managed_root" "$workspace_name"
  print_workspace_private_pointers "$managed_root" "$workspace_name" "$workspace_repo"
fi

print_step_header 4 "Telegram bot"
info ""
info "Paste your Telegram bot token."
info "You can get this from @BotFather."
info ""
info "Need help?"
info "  https://github.com/smithersbot/smithersbot/blob/main/SETUP.md#7-create-a-telegram-bot"
info ""
printf 'Telegram bot token: ' >&2
IFS= read -rs telegram_token
printf '\n' >&2
[[ -n "$telegram_token" ]] || fail "Telegram bot token cannot be empty"
block_dev_same_telegram_token "$telegram_token"

info "Verifying Telegram bot..."
bot_username=$(verify_telegram_token)
info "$(success_marker) Telegram bot verified:"
info "  @$bot_username"
info ""
allowed_id=$(detect_telegram_allowed_id "$bot_username")
[[ -n "$allowed_id" ]] || fail "Telegram private chat ID cannot be empty"

print_step_header 5 "Repo chat backend"
info ""
if [[ -z "$backend" ]]; then
  backend=$(prompt_backend)
fi
check_repo_backend "$backend"
info "$(success_marker) Repo chat backend:"
info "  $(backend_label "$backend")"

gateway_token=$(generate_gateway_token)

if confirm_overwrite "$env_file"; then
  write_env_file "$env_file" "$telegram_token"
else
  chmod 600 "$env_file"
  info "Kept existing $env_file"
fi

if confirm_overwrite "$config_file"; then
  write_config_file "$config_file" "$allowed_id" "$backend" "$gateway_token" "$workspace_name" "$workspace_repo" "$operator_honorific"
  # Default config leaves goal.claudeDriver unset → direct `claude -p`. Only opt-in
  # flips it to the (optional) tui-pilot driver.
  if tui_pilot_opt_in; then
    enable_tui_pilot_driver_in_config "$config_file"
  fi
else
  chmod 600 "$config_file"
  info "Kept existing $config_file"
fi

print_step_header 6 "Run SmithersBot"
info ""
offer_systemd
if [[ "${SETUP_RUN_MODE:-manual}" == "failed" ]]; then
  exit 1
fi
if [[ "$state_dir" != "$config_dir" ]]; then
  info "State directory: $state_dir"
  info "Set SMITHERSBOT_STATE_DIR=$state_dir before starting if you want to use this state directory."
fi
print_setup_complete "$managed_root" "$bot_username" "$allowed_id" "${SETUP_RUN_MODE:-manual}"
