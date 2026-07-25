@echo off
cd /d "%~dp0"

echo ========================================
echo   FB Page Broadcast Console
echo ========================================
echo.
echo Dir: %cd%
echo Open: http://127.0.0.1:3789
echo Stop: Ctrl+C in this window
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js then retry.
  pause
  exit /b 1
)

echo Free port 3789 if busy...
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":3789" ^| findstr "LISTENING"') do (
  echo Kill PID=%%a
  taskkill /F /PID %%a >nul 2>&1
)

if not exist "node_modules\" (
  echo First run: npm install...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed
    pause
    exit /b 1
  )
)

echo Starting server...
start "" "http://127.0.0.1:3789"
call npm run ui

echo.
echo Server stopped.
pause
