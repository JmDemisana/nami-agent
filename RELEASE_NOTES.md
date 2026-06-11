## Maru Desktop v0.0.9

### Changes
- Added update checker: the app now checks GitHub releases on startup and shows a dismissible banner when a newer version is available.
- Post-build cleanup: the `desktop-web-dist` folder no longer bundles the `downloads/` and `nanami-dump/` asset folders, reducing installer size significantly.
- Improved Apple Music playback reliability.

### Windows Downloads
- `Maru-Desktop_0.0.9_x64-setup.exe`
- `Maru-Desktop_0.0.9_x64_en-US.msi`

---

## Maru Desktop v0.0.8

### Changes
- Hotfix: improved Apple Music playback reliability.

### Windows Downloads
- `Maru-Desktop_0.0.8_x64-setup.exe`
- `Maru-Desktop_0.0.8_x64_en-US.msi`

---

## Maru Desktop v0.0.7

### Changes
- Migrated the desktop shell to Tauri entirely.
- Added Tauri-side desktop bridges for shared account state and Elevation tokens, so desktop applets can keep native account-aware storage without leaking anything into the repo.
- Brought `Files`, `Files Database`, and `Elevation` into the launcher, including Windows-first Explorer mirror support and desktop drag-out preparation for Files downloads.
- Fixed the SchedEdit account path so desktop account storage no longer makes it pretend to be the Android native shell.
- Updated the launcher and docs to reflect the mixed local plus backend-connected Tauri flow.

### Windows Downloads
- `Maru-Desktop_0.0.7_x64-setup.exe`
- `Maru-Desktop_0.0.7_x64_en-US.msi`
