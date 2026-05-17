#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE_ROOT="$PROJECT_ROOT/src-tauri/target/release/bundle/dmg"

log() {
  printf '\n[maru-desktop] %s\n' "$1"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '[maru-desktop] Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

ensure_xcode_tools() {
  if xcode-select -p >/dev/null 2>&1; then
    return
  fi

  printf '[maru-desktop] Xcode Command Line Tools are required.\n' >&2
  printf '[maru-desktop] Run `xcode-select --install`, finish that install, then rerun this script.\n' >&2
  exit 1
}

ensure_homebrew() {
  if command -v brew >/dev/null 2>&1; then
    return
  fi

  printf '[maru-desktop] Homebrew is required to install Node.js on macOS.\n' >&2
  printf '[maru-desktop] Install Homebrew first, then rerun this script.\n' >&2
  exit 1
}

install_node_if_needed() {
  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    return
  fi

  log "Installing Node.js"
  brew install node
}

install_rust_if_needed() {
  if command -v rustup >/dev/null 2>&1; then
    return
  fi

  log "Installing rustup"
  require_command curl
  curl https://sh.rustup.rs -sSf | sh -s -- -y
}

load_rust_env() {
  if [ -f "$HOME/.cargo/env" ]; then
    # shellcheck disable=SC1090
    . "$HOME/.cargo/env"
  fi
}

install_app_from_dmg() {
  local dmg_path
  local mount_point
  local app_path

  dmg_path="$(find "$BUNDLE_ROOT" -type f -name '*.dmg' | sort | tail -n 1)"

  if [ -z "$dmg_path" ]; then
    printf '[maru-desktop] No .dmg bundle was produced.\n' >&2
    exit 1
  fi

  mount_point="$(mktemp -d /tmp/maru-desktop.XXXXXX)"
  log "Mounting $dmg_path"
  hdiutil attach "$dmg_path" -mountpoint "$mount_point" -nobrowse >/dev/null

  app_path="$(find "$mount_point" -maxdepth 1 -name '*.app' | head -n 1)"
  if [ -z "$app_path" ]; then
    hdiutil detach "$mount_point" >/dev/null || true
    printf '[maru-desktop] Could not find an app bundle inside the dmg.\n' >&2
    exit 1
  fi

  log "Installing to /Applications"
  rm -rf "/Applications/$(basename "$app_path")"
  cp -R "$app_path" /Applications/

  hdiutil detach "$mount_point" >/dev/null
  rm -rf "$mount_point"
}

main() {
  require_command bash
  require_command curl
  ensure_xcode_tools
  ensure_homebrew
  install_node_if_needed
  install_rust_if_needed
  load_rust_env
  require_command npm
  require_command cargo
  require_command rustc
  require_command hdiutil

  log "Installing JavaScript dependencies"
  (cd "$PROJECT_ROOT" && npm install)

  log "Building macOS bundle"
  (cd "$PROJECT_ROOT" && npm run tauri -- build --bundles dmg)

  install_app_from_dmg
  log "Done"
}

main "$@"
