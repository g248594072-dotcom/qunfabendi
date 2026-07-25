#!/usr/bin/env bash
set -euo pipefail

DISPLAY_NUM="${DISPLAY#:}"
DISPLAY_NUM="${DISPLAY_NUM:-99}"
export DISPLAY=":${DISPLAY_NUM}"
NOVNC_PORT="${NOVNC_PORT:-6080}"

# Clear stale Xvfb lock from previous crash/restart
rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}" || true

echo "[entrypoint] start Xvfb DISPLAY=${DISPLAY}"
Xvfb "${DISPLAY}" -screen 0 1440x900x24 -ac +extension GLX +render -noreset &
sleep 1

echo "[entrypoint] start x11vnc"
x11vnc -display "${DISPLAY}" -forever -shared -rfbport 5900 -nopw -listen 0.0.0.0 >/tmp/x11vnc.log 2>&1 &

NOVNC_WEB=""
for candidate in /usr/share/novnc /usr/share/novnc/utils/..; do
  if [[ -d "${candidate}" ]]; then
    NOVNC_WEB="${candidate}"
    break
  fi
done
if [[ -z "${NOVNC_WEB}" ]]; then
  echo "[entrypoint] noVNC web dir not found" >&2
  exit 1
fi

echo "[entrypoint] start noVNC :${NOVNC_PORT}"
websockify --web="${NOVNC_WEB}" "0.0.0.0:${NOVNC_PORT}" "localhost:5900" >/tmp/novnc.log 2>&1 &

if [[ -z "${NOVNC_URL:-}" ]]; then
  export NOVNC_URL="/novnc/vnc.html?autoconnect=1&resize=remote&path=websockify"
fi

echo "[entrypoint] start UI UI_HOST=${UI_HOST:-0.0.0.0} UI_PORT=${UI_PORT:-3789}"
exec npx tsx src/server.ts
