@echo off
title Magic Show Cue Remote Helper
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0remote-volume-helper.ps1"
echo.
echo Remote helper stopped. Press any key to close.
pause >nul
