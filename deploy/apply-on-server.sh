#!/usr/bin/env bash
# 在服务器项目目录执行：bash deploy/apply-on-server.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  cp deploy/server.env.example .env
  echo "已生成 .env，请先编辑填入 SaleSmartly 密钥和 UI_PASSWORD，然后重新运行本脚本。"
  exit 1
fi

echo "==> 启动 Docker 服务"
docker compose up -d --build

echo "==> 安装 nginx 站点"
if [[ -d /etc/nginx/sites-available ]]; then
  cp deploy/nginx-fb.conf /etc/nginx/sites-available/fb-broadcast
  ln -sfn /etc/nginx/sites-available/fb-broadcast /etc/nginx/sites-enabled/fb-broadcast
  # 避免默认站抢占 80
  if [[ -L /etc/nginx/sites-enabled/default ]]; then
    rm -f /etc/nginx/sites-enabled/default
  fi
  nginx -t
  systemctl reload nginx
else
  echo "未检测到 nginx sites-available，请手动把 deploy/nginx-fb.conf 配进你的 nginx。"
fi

echo ""
echo "完成。访问："
echo "  控制台:     http://107.175.246.246/"
echo "  登录助手:   http://107.175.246.246/login.html"
echo "  远程浏览器: http://107.175.246.246/novnc/vnc.html?autoconnect=1&resize=remote&path=websockify"
echo ""
echo "有域名时：改 nginx server_name + .env 里 NOVNC_URL，再 certbot 上 HTTPS。"
