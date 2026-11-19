# Lumina: one image that serves the React app and the API from the same origin.
#
# Stage 1 builds the frontend into backend/public; stage 2 is the Node backend
# with only its runtime dependency (pg). Node 22.5+ is required for node:sqlite.
ARG NODE_BASE=node:22-alpine

FROM ${NODE_BASE} AS web
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM ${NODE_BASE}
# tini reaps the process, so `docker stop` never leaves Node holding the port.
RUN apk add --no-cache tini
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY backend/src ./src
COPY --from=web /app/backend/public ./public

# Must bind beyond loopback inside a container, or the reverse proxy cannot reach it.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    LUMINA_DB=/data/sentinel.db \
    LUMINA_FILES_DIR=/data/files

# The SQLite database and uploaded files must outlive a redeploy.
VOLUME ["/data"]
EXPOSE 8787
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
