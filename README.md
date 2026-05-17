# Maru Desktop

Offline desktop shell for Maru applets. Built with Tauri.

## License

**GNU General Public License v3.0 (GPL-3.0)** - See [LICENSE](LICENSE) for full text.

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.

## Building on Windows

### Install on Windows

If you just want the app, download the latest Windows release and run either:

- `Maru-Desktop-0.0.6-x64.exe`
- `Maru-Desktop-Setup-0.0.6-x64.msi`

You do not need to build the project yourself for that path.

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
npm run tauri -- build --bundles msi
```

This creates a Windows installer in `src-tauri/target/release/bundle/msi/`.

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

### Setup

```bash
git clone https://github.com/JmDemisana/maru-desktop.git
cd maru-desktop
npm install
```

Build the web assets in the main Maru website repo first, then copy `desktop-web-dist/` into this repo.

### Building for Linux

```bash
npm run tauri -- build --bundles deb,appimage
```

This creates Linux bundles in `src-tauri/target/release/bundle/`.

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

### Setup

```bash
git clone https://github.com/JmDemisana/maru-desktop.git
cd maru-desktop
npm install
```

Build the web assets in the main Maru website repo first, then copy `desktop-web-dist/` into this repo.

### Building for macOS

```bash
npm run tauri -- build --bundles dmg
```

This creates a macOS bundle in `src-tauri/target/release/bundle/dmg/`.

## Project Structure

- `src-tauri/` - Tauri host app
- `src/desktop/` - Desktop web app entry
- `desktop-web-dist/` - Built web assets copied from the main Maru repo
- `tauri-launcher.html` - Offline launcher shell

## Notes

- The desktop app runs the offline web applets in a native Tauri shell
- No internet required after initial setup
- Uses local storage for settings
