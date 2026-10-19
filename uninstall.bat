@echo off
setlocal
title downloadX uninstaller
if not exist "%~dp0installer\uninstall.ps1" (
  echo Uninstaller not found next to this file.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\uninstall.ps1" %*
if errorlevel 1 (
  echo.
  echo Uninstall failed. See the messages above.
  pause
  exit /b 1
)
