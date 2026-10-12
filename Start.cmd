@echo off
cd /d "%~dp0"
if not exist ".env" (
  echo Run Setup.ps1 first to create your .env configuration.
  pause
  exit /b 1
)
if not exist "dist\index.js" (
  echo Run Setup.ps1 or npm run build first.
  pause
  exit /b 1
)
node dist\index.js
pause
