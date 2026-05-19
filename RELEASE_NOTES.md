## Maru Desktop v0.0.7

### Changes
- Removed the old Electron shell entirely and kept Maru Desktop on the Tauri host only.
- Added Tauri-side desktop bridges for shared account state and Elevation tokens, so desktop applets can keep native account-aware storage without leaking anything into the repo.
- Brought `Files`, `Files Database`, and `Elevation` into the launcher, including Windows-first Explorer mirror support and desktop drag-out preparation for Files downloads.
- Fixed the SchedEdit account path so desktop account storage no longer makes it pretend to be the Android native shell.
- Updated the launcher and docs to reflect the mixed local plus backend-connected Tauri flow.

### Windows Downloads
- `Maru-Desktop_0.0.7_x64-setup.exe`
- `Maru-Desktop_0.0.7_x64_en-US.msi`
