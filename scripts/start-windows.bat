@echo off
title AlgoDesk India
cd /d "%~dp0.."
if not exist ".next\BUILD_ID" (
  echo  App is not built yet - running first-time setup...
  call "%~dp0setup-windows.bat"
  exit /b
)
echo.
echo  AlgoDesk India is starting on http://localhost:3000
echo  Keep this window open. Close it to stop the app.
echo.
start "" /min cmd /c "timeout /t 6 /nobreak >nul & start http://localhost:3000"
call npm start
pause
