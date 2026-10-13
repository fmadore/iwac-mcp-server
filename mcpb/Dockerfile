# syntax=docker/dockerfile:1
# Build from the REPOSITORY ROOT: docker build -f mcpb/Dockerfile .
# DuckDB's Linux binding requires glibc; Alpine/musl is not a supported host.
FROM node:24-bookworm-slim AS build
WORKDIR /app/mcpb
# onnxruntime-node's postinstall would fetch CUDA provider libraries on
# linux/x64; the query encoder runs on the CPU provider the package ships.
ENV ONNXRUNTIME_NODE_INSTALL=skip
COPY mcpb/package*.json ./
RUN npm ci
COPY mcpb/ ./
COPY .agents/ /app/.agents/
RUN npm run typecheck && npm run build

FROM node:24-bookworm-slim
LABEL io.modelcontextprotocol.server.name="io.github.fmadore/iwac-mcp-server"
WORKDIR /app
# Semantic search runs EmbeddingGemma 2 in-process (no API key). The HTTP
# server fetches its weights (~350 MB) into /cache/models at start-up, so keep
# /cache on a volume to download them once.
ENV NODE_ENV=production \
    IWAC_CACHE_DIR=/cache \
    IWAC_SEMANTIC_SEARCH_ENABLED=true \
    ONNXRUNTIME_NODE_INSTALL=skip \
    PORT=8000
# Native DuckDB and onnxruntime remain external to the server bundle; only
# onnxruntime's Linux binaries are kept.
COPY mcpb/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force \
    && find node_modules/onnxruntime-node/bin/napi-v6 -mindepth 1 -maxdepth 1 ! -name linux -exec rm -rf {} +
COPY --from=build /app/mcpb/server ./server
RUN mkdir -p /cache && chown node:node /cache
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8000/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
CMD ["node", "server/index.js", "--http"]
