FROM node:24-bookworm-slim
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates xvfb xauth tar \
    && python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir yt-dlp \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm install --global npm@11.16.0 --ignore-scripts && npm ci --omit=dev --ignore-scripts && npx --no-install playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*
COPY src ./src
COPY web ./web
COPY scripts/doctor.js scripts/setup-dashboard-password.js scripts/cloud-data.js scripts/cloud-smoke.js ./scripts/
COPY deploy/entrypoint.sh ./deploy/entrypoint.sh
COPY autodownload/watcher.js ./autodownload/watcher.js
COPY .env.example ./
RUN mkdir -p /data && chown -R node:node /data /app /opt/playwright
ENV AUTOSOCIAL_DATA_DIR=/data AUTOSOCIAL_ENV_FILE=/data/settings.env \
    YT_DLP_PATH=/opt/yt-dlp/bin/yt-dlp HEADLESS=true DASHBOARD_HOST=0.0.0.0 \
    DASHBOARD_ALLOW_REMOTE=true DASHBOARD_TRUST_PROXY=true DASHBOARD_PORT=3000
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "/app/deploy/entrypoint.sh"]
