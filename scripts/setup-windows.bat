@echo off
setlocal EnableExtensions
title AlgoDesk India - Setup
cd /d "%~dp0.."

echo.
echo  ==================================================
echo     AlgoDesk India - Windows Setup
echo  ==================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  [X] Node.js not found.
  echo      Install Node.js 22 LTS from https://nodejs.org and run this file again.
  start "" https://nodejs.org/en/download
  pause
  exit /b 1
)
for /f "tokens=1 delims=v." %%a in ('node -v') do set NODE_MAJOR=%%a
if %NODE_MAJOR% LSS 20 (
  echo  [X] Node.js v%NODE_MAJOR% found - version 20.9 or newer is required, 22 LTS recommended.
  pause
  exit /b 1
)
for /f %%v in ('node -v') do echo  [OK] Node.js %%v

if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  echo  [OK] Created .env from .env.example
) else (
  echo  [OK] Using existing .env
)
call node scripts\admin-cli.mjs init-env
echo.
echo  NOTE: PostgreSQL must be installed and running.
echo        Default: user postgres / password postgres / port 5432.
echo        Different password? Edit .env now, then press a key.
echo        Database app_db and all tables are created automatically.
echo        FIRST START: copy the SETUP CODE printed below, open /login
echo        and create your ADMIN username + password.
echo.
pause

echo.
echo  [1/3] Installing packages - first time takes a few minutes...
call npm install
if errorlevel 1 goto fail

echo.
echo  [2/3] Building the app...
call npm run build
if errorlevel 1 goto fail

echo.
echo  [3/3] Starting AlgoDesk on http://localhost:3000
echo        Keep this window open. Close it to stop the app.
echo        Next time just run scripts\start-windows.bat
echo.
start "" /min cmd /c "timeout /t 8 /nobreak >nul & start http://localhost:3000"
call npm start
goto end

:fail
echo.
echo  [X] Setup failed - read the messages above.
echo      Help: README.md - Troubleshooting section
pause
exit /b 1

:end
endlocal
