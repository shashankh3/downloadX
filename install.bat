@echo off
setlocal
title downloadX setup
cd /d "%~dp0"
where powershell >nul 2>nul
if errorlevel 1 (
  echo Windows PowerShell is required but was not found.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\install.ps1" %*
if errorlevel 1 (
  echo.
  echo Setup failed. See the messages above.
  pause
  exit /b 1
)
