@echo off
title downloadX
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required but was not found. Install it from https://nodejs.org
  pause
  exit /b 1
)
start "" http://127.0.0.1:9765
node server.js
pause
