@echo off
setlocal
title Magic Show Cue - Smartphone Sound Pad
cd /d "%~dp0"

echo Starting the Magic Show Cue smartphone sound pad...
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0mobile-server.ps1" -Port 8080

if errorlevel 1 (
  echo.
  echo Startup failed. Check the error message above.
  pause
)

endlocal
