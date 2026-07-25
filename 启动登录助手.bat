@echo off
cd /d "%~dp0"

echo ========================================
echo   Facebook Login Helper
echo ========================================
echo.
echo 1. Add account / set proxy IP
echo 2. Click Open Login, login in Chrome popup
echo 3. Click Confirm Logged In
echo 4. Click Export, send the file back
echo.
echo Open: http://127.0.0.1:3789/login.html
echo Stop: Ctrl+C in this window
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js 20+ then retry.
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

set HELPER_ONLY=1
echo Starting login helper...
start "" "http://127.0.0.1:3789/login.html"
call npx tsx src/server.ts

echo.
echo Server stopped.
pause
