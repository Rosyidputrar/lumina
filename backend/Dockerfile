# LuminaVantage backend.
#
# The project has no runtime dependencies, so the image needs no install step
# and no build stage. Node 22+ is required: `node:sqlite` is still experimental
# and older releases either lack it or disagree about its API.
# The base tag is overridden by deploy/build-image.sh, which resolves the exact
# Node version. `node:sqlite` only exists from 22.5, and a floating tag can
# resolve to an older patch on a host with a stale cache — the image builds and
# the server starts, then every query throws.
ARG NODE_BASE=node:22-alpine
FROM ${NODE_BASE}

# tini reaps the child process. Without an init, `docker stop` can leave Node
# holding the port and Coolify reports a failed shutdown.
RUN apk add --no-cache tini curl

WORKDIR /app

# Install runtime dependencies in the image. In particular, pg must not be
# installed interactively inside a running container: redeploys replace it.
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts
COPY src ./src
COPY public ./public

# Must bind beyond loopback: inside a container, 127.0.0.1 is unreachable from
# the reverse proxy, which is the single most common Coolify "unhealthy" cause.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    LUMINA_DB=/data/sentinel.db \
    LUMINA_FILES_DIR=/data/files

# One volume for everything that must outlive a redeploy: the SQLite database
# and the uploaded blobs.
VOLUME ["/data"]

EXPOSE 8787

# Coolify reads this. It hits the public health route, so a booted container
# that cannot reach its database is reported unhealthy rather than "running".
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
