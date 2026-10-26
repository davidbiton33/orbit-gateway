# Playwright version pinned to package.json's tested browser major/minor.
FROM mcr.microsoft.com/playwright:v1.56.1-noble
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb x11vnc novnc websockify dbus-x11 curl ca-certificates gnupg procps fonts-noto-core fonts-noto-color-emoji \
 && install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg \
 && echo 'deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main' > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY ./src ./src
COPY ./bin ./bin
COPY ./config ./config
COPY ./public ./public
COPY ./docker ./docker
RUN chmod +x /app/docker/*.sh && mkdir -p /app/data
ENV NODE_ENV=production DISPLAY=:99 GATEWAY_DATA_DIR=/app/data GATEWAY_BROWSER_CHANNEL=chrome BROWSER_HEADLESS=false CLAUDE_HEADLESS=false
EXPOSE 4984 4983 6080
CMD ["bash","/app/docker/entrypoint.sh"]
