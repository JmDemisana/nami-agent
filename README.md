# Maru Desktop

Native desktop shell for [Maru](https://maru-website.onrender.com) — the personal web platform. Built with Tauri (Rust + WebView).

## What is this?

Maru Desktop is a native window that wraps the Maru website's applets so they run offline-capable on your machine with direct access to your filesystem, without needing a browser tab.

The main feature is **Nami**, a local AI agent powered by the Google Gemini API. Nami lives in the sidebar and can:

- **Read and write files** on your machine via native Tauri bridges
- **Run shell commands** (PowerShell on Windows) and show you the output
- **Search the web** using Gemini's grounding API
- **Navigate to applets** — say "open the grade solver" and it launches the applet
- **Remember context** by reading a `memory.md` and `AGENTS.md` from your project folder on every session

Nami is not a cloud service. Your API key stays on your machine in a local encrypted file and is only sent directly to Google's Gemini API when you send a message.

### Why does it need a Gemini API key?

Nami uses the [Google Gemini API](https://aistudio.google.com/apikey) to understand natural language and decide which tools to use. Without a key, Nami won't respond. The free tier of Gemini 2.5 Flash works fine for normal use. You can paste multiple keys separated by commas and Nami will rotate through them if one hits a rate limit.

### What applets are included?

These applets from the Maru website run inside the shell:

| Applet | Description |
|---|---|
| **Apple Music Game** | Rhythm game built around your Apple Music library |
| **Wordel** | Word puzzle game |
| **Class Schedule Editor** | Visual class timetable builder |
| **Tiertrack** | Tier list and ranking tracker |
| **Lyrics Database** | Personal lyrics collection |
| **Photo Serve** | Photo layout and print workstation |
| **Dael or No Dael** | Single-player deal-or-no-deal game |
| **Cup Cupper Cuppers** | Shuffled-cup duel game |
| **TUP Grade Solver** | TUP-specific grade calculator |
| **Desktop Options** | Themes, fonts, and appearance settings |

Applets that need the Maru backend (Files, Elevation, account sync) require an internet connection to `maru-website.onrender.com`. The AI agent and purely local applets work offline.

---

## License

**GNU General Public License v3.0 (GPL-3.0)** — See [LICENSE](LICENSE) for full text.

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.

---

## Installing

If you just want to run the app, grab the latest Windows release and run either:

- `Maru-Desktop_0.0.9_x64-setup.exe`
- `Maru-Desktop_0.0.9_x64_en-US.msi`

You do not need to build the project yourself for that.

---

## Building on Windows

### Prerequisites

- Windows 10/11
- Node.js 20+
- Rust toolchain (`rustup`)
- Visual Studio 2022 Build Tools with MSVC C++ tools

### Setup

1. Clone the repo:
```bash
git clone https://github.com/JmDemisana/maru-desktop.git
cd maru-desktop
```

2. Install dependencies:
```bash
npm install
```

3. Build web assets from the main Maru website repo:
```bash
# In the main Maru website repo:
npm run build:desktop-web

# Copy the built folder into this repo:
cp -r desktop-web-dist/ C:\path\to\maru-desktop\
```

### Building for Windows

```bash
npm run tauri:build -- --bundles msi
```

This creates Windows release bundles in `src-tauri/target/release/bundle/`.

---

## Building on Linux

### Prerequisites

- Linux host or VM
- Node.js 20+
- Rust toolchain (`rustup`)
- `pkg-config`
- `libgtk-3-dev`
- `libayatana-appindicator3-dev`
- `librsvg2-dev`
- `patchelf`
- `libwebkit2gtk-4.1-dev`

Linux bundles must be built on Linux.

### One-line install

```bash
git clone https://github.com/JmDemisana/maru-desktop.git && cd maru-desktop && bash ./scripts/install-linux.sh
```

### Building for Linux

```bash
npm run tauri:build -- --bundles deb,appimage
```

This creates Linux bundles in `src-tauri/target/release/bundle/`.

---

## Building on macOS

### Prerequisites

- macOS 12 or later
- Node.js 20+
- Rust toolchain (`rustup`)
- Xcode Command Line Tools

macOS bundles must be built on macOS.

### One-line install

```bash
git clone https://github.com/JmDemisana/maru-desktop.git && cd maru-desktop && bash ./scripts/install-macos.sh
```

### Building for macOS

```bash
npm run tauri:build -- --bundles dmg
```

This creates a macOS bundle in `src-tauri/target/release/bundle/dmg/`.

---

## Project Structure

- `src-tauri/` — Tauri host app (Rust backend, native bridges)
- `src/desktop/` — Desktop web app entry point and components
  - `NamiAgent.tsx` — The AI agent sidebar
  - `UpdateChecker.tsx` — Auto-update notifier
  - `DesktopOptions.tsx` — Appearance and settings panel
- `desktop-web-dist/` — Built web assets copied from the main Maru repo
- `scripts/` — Platform install scripts and build helpers
- `tauri-launcher.html` — Offline launcher shell

## Notes

- The desktop app runs shared web applets inside a native Tauri shell.
- Files, Files Database, Elevation, and shared account sync still require the Maru backend online.
- The File Explorer structure mirror targets Windows first. macOS and Linux still need manual integration testing.
- Releases are built locally, not through CI. See [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) for the release flow.
