# Nami Agent Deployment Guide

This repo packages the desktop app as a Tauri shell around the shared web bundle that is built in the main `maru-website` repo.

## Repos

- `maru-website`: owns the shared frontend bundle and desktop applet routes.
- `nami-agent`: owns the native Tauri shell, packaging, and desktop-only bridge code.
- `maru-mobile`: owns the Android-native app work.

## Local Release Flow

Nami Agent releases are built locally, not through GitHub Actions.

1. Build the desktop web bundle in `maru-website`.

```bash
cd C:\Users\jmdem\Maru
npm run build:desktop-web
```

2. Copy the built `desktop-web-dist/` folder into this repo root.

3. Build the Tauri release here.

```bash
cd C:\Users\jmdem\nami-agent
npm install
npm run tauri:build
```

## Artifacts

Tauri release artifacts land under:

- `src-tauri/target/release/bundle/msi/`
- `src-tauri/target/release/bundle/nsis/`
- `src-tauri/target/release/bundle/deb/`
- `src-tauri/target/release/bundle/appimage/`

Exact outputs depend on the host OS. Windows bundles should be built on Windows. Linux and macOS bundles still need to be built on their own platforms.

## Desktop Notes

- The desktop shell is Tauri-only. No legacy runtime files are part of this repo.
- `Files`, `Files Database`, `Elevation`, and shared desktop account storage now rely on the Tauri bridge in `src-tauri/src/main.rs`.
- The Windows-first File Explorer mirror is intentionally conservative: it mirrors folders plus placeholder file names, and it defaults to read-only behavior unless Elevation is active.
- macOS and Linux can still run the app, but File Explorer style integration has not been fully validated there yet.
