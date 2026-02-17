#!/usr/bin/env bash
set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

ONBOARD_COMMAND='claude login && moltbot onboard --non-interactive --accept-risk --auth-choice skip --install-daemon --skip-skills --flow quickstart'
SUDO_CMD=()

print_section() {
    echo
    echo -e "${YELLOW}=== $1 ===${NC}"
}

print_info() {
    echo -e "${YELLOW}$1${NC}"
}

print_success() {
    echo -e "${GREEN}$1${NC}"
}

die() {
    echo -e "${RED}Error: $1${NC}" >&2
    exit 1
}

run_as_root() {
    if [ "${#SUDO_CMD[@]}" -eq 0 ]; then
        "$@"
    else
        "${SUDO_CMD[@]}" "$@"
    fi
}

check_os_support() {
    print_section "Checking OS support"

    if [ ! -r /etc/os-release ]; then
        die "Cannot read /etc/os-release. This script supports Ubuntu 22.04+."
    fi

    # shellcheck disable=SC1091
    . /etc/os-release

    local distro="${ID:-}"
    local version_id="${VERSION_ID:-0}"
    local major_version="${version_id%%.*}"

    if [ "$distro" != "ubuntu" ]; then
        die "Unsupported distro: ${distro:-unknown}. Please use Ubuntu 22.04+."
    fi

    if ! [[ "$major_version" =~ ^[0-9]+$ ]]; then
        die "Unable to parse Ubuntu version: ${version_id}."
    fi

    if [ "$major_version" -lt 22 ]; then
        die "Ubuntu ${version_id} detected. Ubuntu 22.04+ is required."
    fi

    print_success "Detected Ubuntu ${version_id}."
}

configure_privilege_escalation() {
    print_section "Checking privilege escalation"

    if [ "$EUID" -eq 0 ]; then
        print_info "Running as root."
        return
    fi

    if ! command -v sudo >/dev/null 2>&1; then
        die "sudo is required when not running as root."
    fi

    if ! sudo -n true 2>/dev/null; then
        die "Passwordless sudo is required. Re-run as root or configure sudo -n."
    fi

    SUDO_CMD=(sudo -n)
    print_success "Passwordless sudo is available."
}

install_apt_prerequisites() {
    print_section "Installing apt prerequisites"
    run_as_root env DEBIAN_FRONTEND=noninteractive apt-get -y update
    run_as_root env DEBIAN_FRONTEND=noninteractive apt-get -y install ca-certificates curl gnupg
    print_success "Apt prerequisites are installed."
}

install_nodejs_22() {
    print_section "Installing Node.js 22 via NodeSource"

    if [ "${#SUDO_CMD[@]}" -eq 0 ]; then
        curl -fsSL https://deb.nodesource.com/setup_22.x | env DEBIAN_FRONTEND=noninteractive bash -
    else
        curl -fsSL https://deb.nodesource.com/setup_22.x | "${SUDO_CMD[@]}" env DEBIAN_FRONTEND=noninteractive bash -
    fi

    run_as_root env DEBIAN_FRONTEND=noninteractive apt-get -y install nodejs

    if ! command -v node >/dev/null 2>&1; then
        die "Node.js installation completed but 'node' is not on PATH."
    fi

    local node_major
    node_major="$(node -p "process.versions.node.split('.')[0]")"
    if ! [[ "$node_major" =~ ^[0-9]+$ ]]; then
        die "Could not parse Node.js version."
    fi
    if [ "$node_major" -lt 22 ]; then
        die "Node.js $(node --version) installed, but 22+ is required."
    fi

    print_success "Node.js $(node --version) is installed."
}

install_npm_global() {
    local package_name="$1"
    local binary_name="$2"
    local label="$3"

    print_section "Installing ${label}"
    run_as_root npm install -g "${package_name}"

    if ! command -v "${binary_name}" >/dev/null 2>&1; then
        die "${label} install completed but '${binary_name}' is not on PATH."
    fi

    print_success "${label} is installed."
}

ensure_state_directory() {
    print_section "Ensuring state directory exists"
    mkdir -p "${HOME}/.moltbot"
    print_success "State directory ready: ${HOME}/.moltbot"
}

binary_version() {
    local binary_name="$1"

    case "$binary_name" in
        node)
            node --version 2>&1 | head -n 1
            ;;
        pnpm)
            pnpm --version 2>&1 | head -n 1
            ;;
        moltbot)
            moltbot --version 2>&1 | head -n 1
            ;;
        claude)
            claude --version 2>&1 | head -n 1
            ;;
        *)
            return 1
            ;;
    esac
}

verify_binaries() {
    print_section "Verifying installed binaries"

    local missing=0
    local binary_name
    for binary_name in node pnpm moltbot claude; do
        if command -v "${binary_name}" >/dev/null 2>&1; then
            local version
            version="$(binary_version "${binary_name}")"
            echo -e "${GREEN}[OK]${NC} ${binary_name} ${version}"
        else
            echo -e "${RED}[MISSING]${NC} ${binary_name}"
            missing=1
        fi
    done

    if [ "$missing" -ne 0 ]; then
        die "One or more required binaries are missing from PATH."
    fi
}

print_next_steps() {
    print_section "Ready for onboarding"
    print_success "Done. Now run: ${ONBOARD_COMMAND}"
}

main() {
    print_section "Customer VPS bootstrap"
    echo "This script prepares Ubuntu 22.04+ for Moltbot customer onboarding."

    check_os_support
    configure_privilege_escalation
    install_apt_prerequisites
    install_nodejs_22
    install_npm_global "pnpm" "pnpm" "pnpm"
    install_npm_global "moltbot" "moltbot" "moltbot"
    install_npm_global "@anthropic-ai/claude-code" "claude" "Claude Code CLI"
    ensure_state_directory
    verify_binaries
    print_next_steps
}

main "$@"
