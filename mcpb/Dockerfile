# syntax=docker/dockerfile:1
# Build from the REPOSITORY ROOT: docker build -f mcpb/Dockerfile .
# DuckDB's Linux binding requires glibc; Alpine/musl is not a supported host.
#
# Both stages pin the multi-arch index digest of node:24-bookworm-slim; the tag
# stays for readability. Dependabot's `docker` ecosystem keeps the digest
# current (base-image security fixes) and never moves the Node major, which is
# coordinated by hand with ci.yml, the workflows and `engines`.
FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
WORKDIR /app/mcpb
# onnxruntime-node's postinstall would fetch CUDA provider libraries on
# linux/x64; the query encoder runs on the CPU provider the package ships.
ENV ONNXRUNTIME_NODE_INSTALL=skip
COPY mcpb/package*.json ./
RUN npm ci
COPY mcpb/ ./
COPY .agents/ /app/.agents/
RUN npm run typecheck && npm run build

FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
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
# Native DuckDB and onnxruntime remain external to the server bundle, so they
# are the only runtime packages kept: the MCP SDK (with the hono server it
# brings), zod and the tokenizer are inlined into server/index.js
# (scripts/bundle.mjs), and nothing external depends on them. Of onnxruntime's binaries only the target's Linux build
# stays (TARGETARCH is set by BuildKit: amd64 -> x64, arm64 -> arm64).
ARG TARGETARCH
COPY mcpb/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force \
    && rm -rf node_modules/@modelcontextprotocol node_modules/zod node_modules/@huggingface/tokenizers \
       node_modules/hono node_modules/@hono \
    && ort_arch="$([ "$TARGETARCH" = "arm64" ] && echo arm64 || echo x64)" \
    && find node_modules/onnxruntime-node/bin/napi-v6 -mindepth 1 -maxdepth 1 ! -name linux -exec rm -rf {} + \
    && find node_modules/onnxruntime-node/bin/napi-v6/linux -mindepth 1 -maxdepth 1 ! -name "$ort_arch" -exec rm -rf {} +
COPY --from=build /app/mcpb/server ./server
RUN mkdir -p /cache && chown node:node /cache
EXPOSE 8000
# PORT is configurable at run time, so the probe reads it rather than assuming
# 8000 (a container started with -e PORT=9000 would otherwise report unhealthy).
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
CMD ["node", "server/index.js", "--http"]
