FROM mcr.microsoft.com/playwright:v1.51.0-jammy

WORKDIR /app

# 远程登录用：虚拟显示器 + noVNC
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY deploy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
  && mkdir -p /app/data /app/storage

ENV UI_HOST=0.0.0.0 \
    UI_PORT=3789 \
    SERVER_MODE=1 \
    DISPLAY=:99 \
    NOVNC_PORT=6080 \
    NODE_ENV=production

EXPOSE 3789 6080

VOLUME ["/app/data", "/app/storage"]

ENTRYPOINT ["/entrypoint.sh"]
