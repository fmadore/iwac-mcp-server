# Security Policy

## Supported versions

Only the **latest release** is supported. Fixes ship in a new tagged release
rather than as patches to older tags — update to the newest `.mcpb` bundle or
pull the current `ghcr.io/fmadore/iwac-mcp-server` image.

| Version           | Supported |
| ----------------- | --------- |
| Latest release    | ✅        |
| Anything earlier  | ❌        |

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through
[GitHub Security Advisories](https://github.com/fmadore/iwac-mcp-server/security/advisories/new),
or by email to <frederick.madore@uni-bayreuth.de>.

Include what you need to make the problem reproducible: the version, how the
server was running (Claude Desktop `.mcpb`, `--http`, or Docker), and the
request or tool call that triggers it. Expect an acknowledgement within about a
week — this is a single-maintainer academic project, not a staffed product, so
please allow reasonable time before disclosing publicly.

## Scope

In scope:

- The server code under [`mcpb/src/`](mcpb/src/) — in particular the SQL layer.
  All queries are parameterised and identifiers are allow-listed; a way to reach
  arbitrary SQL, read files outside the cache directory, or make DuckDB touch the
  network is a vulnerability.
- The HTTP transport (`node server/index.js --http`): bearer-token
  authentication, `Origin` validation, session handling, and anything that lets a
  request bypass `IWAC_MCP_BEARER_TOKEN` / `IWAC_MCP_ALLOWED_ORIGINS`.
- The published artifacts: the per-OS `.mcpb` bundles, the GHCR image, and the
  release/publish workflows (supply-chain integrity, leaked secrets in CI).
- Leakage of a configured `IWAC_GOOGLE_API_KEY` into tool output, logs, or error
  messages.

Out of scope:

- The content of the archive itself. IWAC is published material, and the tools
  are read-only by design — the server has no write path to the dataset. Requests
  about the *content* (takedowns, corrections, rights) belong on
  [islam.zmo.de](https://islam.zmo.de/s/westafrica/), not here.
- Rate limiting on the public endpoint at `https://islam.zmo.de/mcp/`; it is a
  best-effort research service, and volumetric denial-of-service reports are not
  useful. Reports that a *single* cheap request can exhaust server memory or CPU
  **are** in scope.
- Findings in upstream dependencies with no exploitable path through this server.
  Dependabot already tracks those.

## What the server handles

Worth knowing when assessing impact:

- **No user data is stored.** The server keeps a local parquet cache
  (`IWAC_CACHE_DIR`, ~250 MB) downloaded from Hugging Face and answers queries
  from it. No accounts, no session persistence, no telemetry.
- **All tools are read-only.** There is no tool that writes, deletes, or mutates
  anything, locally or remotely.
- **Semantic search is opt-in and off by default.** When
  `IWAC_SEMANTIC_SEARCH_ENABLED=true`, query text is sent to the Google Gemini
  embedding API using the operator's own key; nothing else leaves the machine.
