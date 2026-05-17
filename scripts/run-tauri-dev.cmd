@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat" -arch=x64
set "PATH=C:\Users\jmdem\.cargo\bin;%PATH%"
npm run tauri:dev
