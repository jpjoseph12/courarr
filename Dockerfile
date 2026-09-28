FROM node:24-alpine

RUN apk add --no-cache su-exec tzdata

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production \
    CONFIG_DIR=/config \
    PORT=6161 \
    PUID=99 \
    PGID=100 \
    UMASK=002 \
    TZ=Etc/UTC

EXPOSE 6161
VOLUME /config

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

LABEL org.opencontainers.image.title="Courarr" \
      org.opencontainers.image.description="Seasonal anime lists from AniList as Custom Lists for Sonarr and Radarr" \
      org.opencontainers.image.source="https://github.com/jpjoseph12/courarr" \
      org.opencontainers.image.licenses="MIT"

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
