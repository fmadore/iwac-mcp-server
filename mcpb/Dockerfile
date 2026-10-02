# syntax=docker/dockerfile:1
# Build from the REPOSITORY ROOT: docker build -f mcpb/Dockerfile .
# DuckDB's Linux binding requires glibc; Alpine/musl is not a supported host.
FROM node:24-bookworm-slim AS build
WORKDIR /app/mcpb
COPY mcpb/package*.json ./
RUN npm ci
COPY mcpb/ ./
COPY .agents/ /app/.agents/
RUN npm run typecheck && npm run build

FROM node:24-bookworm-slim
LABEL io.modelcontextprotocol.server.name="io.github.fmadore/iwac-mcp-server"
WORKDIR /app
ENV NODE_ENV=production \
    IWAC_CACHE_DIR=/cache \
    IWAC_SEMANTIC_SEARCH_ENABLED=false \
    PORT=8000
# Native DuckDB and Google SDK remain external to the server bundle.
COPY mcpb/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/mcpb/server ./server
RUN mkdir -p /cache && chown node:node /cache
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8000/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
CMD ["node", "server/index.js", "--http"]
