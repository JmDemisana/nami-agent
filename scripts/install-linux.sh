#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE_ROOT="$PROJECT_ROOT/src-tauri/target/release/bundle"

log() {
  printf '\n[maru-desktop] %s\n' "$1"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '[maru-desktop] Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

install_rust() {
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

install_apt_deps() {
  log "Installing Linux build dependencies"
  sudo apt-get update
  sudo apt-get install -y \
    curl \
    file \
    build-essential \
    pkg-config \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    patchelf \
    libwebkit2gtk-4.1-dev
}

install_deb_bundle() {
  local deb_path
  deb_path="$(find "$BUNDLE_ROOT" -type f -name '*.deb' | sort | tail -n 1)"

  if [ -z "$deb_path" ]; then
    printf '[maru-desktop] No .deb bundle was produced.\n' >&2
    exit 1
  fi

  log "Installing $deb_path"
  sudo apt-get install -y "$deb_path"
}

install_appimage_bundle() {
  local appimage_path
  local install_dir="$HOME/.local/bin"
  local target_path="$install_dir/Maru-Desktop.AppImage"

  appimage_path="$(find "$BUNDLE_ROOT" -type f -name '*.AppImage' | sort | tail -n 1)"

  if [ -z "$appimage_path" ]; then
    printf '[maru-desktop] No AppImage bundle was produced.\n' >&2
    exit 1
  fi

  mkdir -p "$install_dir"
  cp "$appimage_path" "$target_path"
  chmod +x "$target_path"
  log "Installed AppImage to $target_path"
}

main() {
  require_command bash
  require_command npm

  if command -v apt-get >/dev/null 2>&1; then
    install_apt_deps
  else
    printf '[maru-desktop] Automatic dependency install is only wired for Debian/Ubuntu right now.\n' >&2
    printf '[maru-desktop] Install the Tauri Linux prerequisites first, then rerun this script.\n' >&2
    exit 1
  fi

  install_rust
  load_rust_env
  require_command cargo
  require_command rustc

  log "Installing JavaScript dependencies"
  (cd "$PROJECT_ROOT" && npm install)

  log "Building Linux bundles"
  (cd "$PROJECT_ROOT" && npm run tauri -- build --bundles deb,appimage)

  if command -v apt-get >/dev/null 2>&1; then
    install_deb_bundle
  else
    install_appimage_bundle
  fi

  log "Done"
}

main "$@"
