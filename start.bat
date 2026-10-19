@echo off
title downloadX
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required but was not found. Install it from https://nodejs.org
  pause
  exit /b 1
)
set "DLX_OPEN=1"
echo Starting downloadX - the browser will open when the server is ready...
node server.js
pause
