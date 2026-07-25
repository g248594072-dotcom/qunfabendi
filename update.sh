#!/usr/bin/env bash
# 一键更新（在服务器项目目录执行）：./update.sh
# 作用：拉取 GitHub 最新代码 → 重建并重启 Docker →（可选）重载 nginx
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "==> 目录: $ROOT"

if [[ ! -d .git ]]; then
  echo "错误：当前不是 git 仓库。请先用 git clone 部署本项目。"
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "==> 拉取更新 (branch: ${BRANCH})"
git fetch origin
git pull --ff-only origin "${BRANCH}"

if [[ ! -f .env ]]; then
  echo "警告：缺少 .env。请先: cp deploy/server.env.example .env 并填写密钥。"
fi

if command -v docker >/dev/null 2>&1; then
  echo "==> 重建并启动容器"
  docker compose up -d --build
  echo "==> 容器状态"
  docker compose ps
else
  echo "==> 未检测到 docker，改用 npm 重启（裸机）"
  npm install
  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files | grep -q fb-broadcast; then
    systemctl restart fb-broadcast
    systemctl status fb-broadcast --no-pager || true
  else
    echo "请手动重启: npm run ui"
  fi
fi

if [[ -f /etc/nginx/sites-enabled/fb-broadcast ]] || [[ -f /etc/nginx/sites-available/fb-broadcast ]]; then
  if [[ -f deploy/nginx-fb.conf ]]; then
    echo "==> 同步 nginx 配置"
    cp deploy/nginx-fb.conf /etc/nginx/sites-available/fb-broadcast
    ln -sfn /etc/nginx/sites-available/fb-broadcast /etc/nginx/sites-enabled/fb-broadcast
  fi
  if command -v nginx >/dev/null 2>&1; then
    nginx -t && systemctl reload nginx
    echo "==> nginx 已重载"
  fi
fi

echo ""
echo "✓ 更新完成"
echo "  控制台: http://107.175.246.246/"
echo "  登录助手: http://107.175.246.246/login.html"
