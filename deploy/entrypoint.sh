#!/usr/bin/env bash
set -euo pipefail

DISPLAY_NUM="${DISPLAY#:}"
DISPLAY_NUM="${DISPLAY_NUM:-99}"
export DISPLAY=":${DISPLAY_NUM}"
NOVNC_PORT="${NOVNC_PORT:-6080}"

echo "[entrypoint] 鍚姩铏氭嫙鏄剧ず鍣?DISPLAY=${DISPLAY}"
Xvfb "${DISPLAY}" -screen 0 1440x900x24 -ac +extension GLX +render -noreset &
sleep 1

echo "[entrypoint] 鍚姩 x11vnc"
x11vnc -display "${DISPLAY}" -forever -shared -rfbport 5900 -nopw -listen 0.0.0.0 >/tmp/x11vnc.log 2>&1 &

NOVNC_WEB=""
for candidate in /usr/share/novnc /usr/share/novnc/utils/.. ; do
  if [[ -d "${candidate}" ]]; then
    NOVNC_WEB="${candidate}"
    break
  fi
done
if [[ -z "${NOVNC_WEB}" ]]; then
  echo "[entrypoint] 鏈壘鍒?noVNC 闈欐€佺洰褰? >&2
  exit 1
fi

echo "[entrypoint] 鍚姩 noVNC :${NOVNC_PORT}"
websockify --web="${NOVNC_WEB}" "0.0.0.0:${NOVNC_PORT}" "localhost:5900" >/tmp/novnc.log 2>&1 &

if [[ -z "${NOVNC_URL:-}" ]]; then
  # 瀹瑰櫒鍐呮棤娉曠煡閬撳叕缃?IP锛岀暀缁?compose / .env 瑕嗙洊锛涜繖閲岀粰榛樿璺緞鎻愮ず
  export NOVNC_URL="http://127.0.0.1:${NOVNC_PORT}/vnc.html?autoconnect=1&resize=remote"
fi

echo "[entrypoint] 鍚姩鎺у埗鍙?UI_HOST=${UI_HOST:-0.0.0.0} UI_PORT=${UI_PORT:-3789}"
exec npx tsx src/server.ts
