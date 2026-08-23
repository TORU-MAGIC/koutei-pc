@echo off
title Restore Bluetooth Absolute Volume

net session >nul 2>&1
if not "%errorlevel%"=="0" (
  echo This script must be run as administrator.
  echo Right-click this file and choose "Run as administrator".
  echo.
  pause
  exit /b 1
)

echo Restoring Windows default Bluetooth Absolute Volume behavior...
reg delete "HKLM\SYSTEM\CurrentControlSet\Control\Bluetooth\Audio\AVRCP\CT" /v DisableAbsoluteVolume /f

echo.
echo Done.
echo Turn Bluetooth off and on again, or restart Windows.
echo.
pause
