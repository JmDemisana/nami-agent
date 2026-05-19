@echo off
cd /d "%~dp0"
Start "" cmd /k npm run tauri:dev
