@echo off
title Disable Bluetooth Absolute Volume

net session >nul 2>&1
if not "%errorlevel%"=="0" (
  echo This script must be run as administrator.
  echo Right-click this file and choose "Run as administrator".
  echo.
  pause
  exit /b 1
)

echo Disabling Bluetooth Absolute Volume...
reg add "HKLM\SYSTEM\CurrentControlSet\Control\Bluetooth\Audio\AVRCP\CT" /v DisableAbsoluteVolume /t REG_DWORD /d 1 /f

echo.
echo Done.
echo Turn Bluetooth off and on again, or restart Windows.
echo Then start start-remote-helper.cmd before the show.
echo.
pause
