@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ========================================
echo   One-click: Git + Node + Login Helper
echo ========================================
echo.
echo This will:
echo   1) Install Git ^(if missing^)
echo   2) Install Node.js LTS ^(if missing^)
echo   3) Download project from GitHub
echo   4) npm install
echo   5) Start login helper
echo.
echo Target folder: %USERPROFILE%\Desktop\qunfabendi
echo.
pause

set "REPO_URL=https://github.com/g248594072-dotcom/qunfabendi.git"
set "DEST=%USERPROFILE%\Desktop\qunfabendi"

call :refresh_path

where winget >nul 2>&1
if errorlevel 1 (
  echo [WARN] winget not found. Will try direct download installers.
  set "USE_WINGET=0"
) else (
  set "USE_WINGET=1"
)

REM ---------- Git ----------
where git >nul 2>&1
if errorlevel 1 (
  echo.
  echo [1/5] Installing Git...
  if "%USE_WINGET%"=="1" (
    winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
  ) else (
    call :install_git_msi
  )
  call :refresh_path
) else (
  echo [1/5] Git already installed.
)

where git >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Git still not found. Install manually: https://git-scm.com
  pause
  exit /b 1
)

REM ---------- Node ----------
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo [2/5] Installing Node.js LTS...
  if "%USE_WINGET%"=="1" (
    winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
  ) else (
    call :install_node_msi
  )
  call :refresh_path
) else (
  echo [2/5] Node.js already installed.
)

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js still not found. Install manually: https://nodejs.org
  pause
  exit /b 1
)

echo.
echo Git:
git --version
echo Node:
node -v
echo npm:
npm -v

REM ---------- Clone ----------
echo.
echo [3/5] Download project...
if exist "%DEST%\.git\" (
  echo Folder exists, pulling latest...
  pushd "%DEST%"
  git pull --ff-only
  popd
) else (
  if exist "%DEST%\" (
    echo [WARN] Folder exists but is not a git repo. Using it as-is.
  ) else (
    git clone "%REPO_URL%" "%DEST%"
    if errorlevel 1 (
      echo [ERROR] git clone failed.
      pause
      exit /b 1
    )
  )
)

REM ---------- npm install ----------
echo.
echo [4/5] npm install...
pushd "%DEST%"
call npm install
if errorlevel 1 (
  echo [ERROR] npm install failed.
  popd
  pause
  exit /b 1
)

REM ---------- Start helper ----------
echo.
echo [5/5] Starting login helper...
echo Open: http://127.0.0.1:3789/login.html
echo Stop: Ctrl+C in this window
echo.

for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":3789" ^| findstr "LISTENING"') do (
  taskkill /F /PID %%a >nul 2>&1
)

set HELPER_ONLY=1
start "" "http://127.0.0.1:3789/login.html"
call npx tsx src/server.ts

echo.
echo Server stopped.
popd
pause
exit /b 0

REM ========== helpers ==========
:refresh_path
set "PATH=%SystemRoot%\System32;%SystemRoot%;%SystemRoot%\System32\Wbem;%SystemRoot%\System32\WindowsPowerShell\v1.0\"
for /f "tokens=2*" %%a in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "PATH=%%b;%PATH%"
for /f "tokens=2*" %%a in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "PATH=%%b;%PATH%"
if exist "%ProgramFiles%\Git\cmd\git.exe" set "PATH=%ProgramFiles%\Git\cmd;%PATH%"
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%LocalAppData%\Programs\Git\cmd\git.exe" set "PATH=%LocalAppData%\Programs\Git\cmd;%PATH%"
exit /b 0

:install_git_msi
set "GIT_MSI=%TEMP%\Git-64-bit.exe"
echo Downloading Git installer...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri 'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/Git-2.47.1-64-bit.exe' -OutFile '%GIT_MSI%'"
if not exist "%GIT_MSI%" (
  echo [ERROR] Download Git failed.
  exit /b 1
)
echo Installing Git silently...
"%GIT_MSI%" /VERYSILENT /NORESTART /NOCANCEL /SP-
exit /b 0

:install_node_msi
set "NODE_MSI=%TEMP%\node-lts.msi"
echo Downloading Node.js LTS installer...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi' -OutFile '%NODE_MSI%'"
if not exist "%NODE_MSI%" (
  echo [ERROR] Download Node failed.
  exit /b 1
)
echo Installing Node.js silently...
msiexec /i "%NODE_MSI%" /qn /norestart
exit /b 0
