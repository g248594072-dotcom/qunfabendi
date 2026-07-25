#!/usr/bin/env bash
# Ubuntu 22.04+ 瑁告満瀹夎锛堟帹鑽愭洿鐪佷簨鐢?Docker锛氳 README锛?set -euo pipefail

APP_DIR="${APP_DIR:-/opt/fb-broadcast}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> 瀹夎 Node.js 20锛堣嫢灏氭湭瀹夎锛?
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> 鍚屾椤圭洰鍒?${APP_DIR}"
mkdir -p "${APP_DIR}"
rsync -a --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude storage/browser-profile \
  --exclude storage/profiles \
  "${REPO_DIR}/" "${APP_DIR}/"

cd "${APP_DIR}"
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "宸茬敓鎴?.env锛岃缂栬緫濉叆 SaleSmartly 瀵嗛挜銆乁I_PASSWORD銆乁I_HOST=0.0.0.0"
fi

echo "==> npm install + Playwright Chromium"
npm install
npx playwright install --with-deps chromium

echo "==> 瀹夎 systemd 鏈嶅姟"
cp deploy/fb-broadcast.service /etc/systemd/system/fb-broadcast.service
systemctl daemon-reload
systemctl enable fb-broadcast

echo ""
echo "瀹屾垚銆傝缂栬緫 ${APP_DIR}/.env 鍚庢墽琛岋細"
echo "  systemctl start fb-broadcast"
echo "  systemctl status fb-broadcast"
echo ""
echo "鎺у埗鍙? http://鏈嶅姟鍣↖P:3789/"
echo "鐧诲綍鍔╂墜: http://鏈嶅姟鍣↖P:3789/login.html"
echo "鏃犲浘褰㈢晫闈㈡椂锛氭湰鏈虹櫥褰曞悗鐢ㄣ€屽鍑?瀵煎叆璧勬枡鍖呫€嶅悓姝ョ櫥褰曟€侊紱鎴栨敼鐢?docker compose锛堝惈 noVNC锛夈€?
