# syntax=docker/dockerfile:1
# IWAC MCP server in remote HTTP mode (node server/index.js --http).
# Build target: linux/amd64 (the IWAC-docker host). Deployment — nginx `^~ /mcp`
# reverse proxy + compose service — is documented in docs/iwac-mcp-roadmap.md in
# the IWAC-docker repo. The Claude Desktop / stdio path is unaffected by this image.

# ---- build ----
FROM node:26-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run typecheck && npm run build

# ---- runtime ----
FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production \
    IWAC_CACHE_DIR=/cache \
    IWAC_SEMANTIC_SEARCH_ENABLED=false \
    PORT=8000
# Production deps only. The esbuild bundle inlines the MCP SDK + zod but keeps
# @duckdb/* (native) and @google/genai external, so they must be installed here.
# On linux this also resolves @duckdb/node-bindings-linux-x64 via @duckdb/node-api;
# a missing binding is a runtime crash, not a build error — the smoke check covers it.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/server ./server
# Pre-create the cache mountpoint owned by node, so a fresh named volume mounted
# at /cache is writable by the non-root user (Docker copies this directory's
# ownership onto an empty volume). Without it the first parquet write under a
# read-only rootfs fails with `EACCES: mkdir '/cache/...'`.
RUN mkdir -p /cache && chown node:node /cache
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8000/health || exit 1
USER node
CMD ["node", "server/index.js", "--http"]
