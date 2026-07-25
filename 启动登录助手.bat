@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================
echo   Facebook 登录助手（给协助登录的人用）
echo ========================================
echo.
echo 1. 添加账号 / 设置代理 IP
echo 2. 打开登录，在弹出的浏览器里登 Facebook
echo 3. 点「确认已登录」
echo 4. 点「导出给主控」，把下载的文件发回负责人
echo.

if not exist "node_modules\" (
  echo 首次使用，正在安装依赖…
  call npm install
  if errorlevel 1 (
    echo 安装失败，请先安装 Node.js 20+
    pause
    exit /b 1
  )
)

set HELPER_ONLY=1
start "" "http://127.0.0.1:3789/login.html"
call npx tsx src/server.ts
pause
