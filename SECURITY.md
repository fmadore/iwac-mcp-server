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
- Leakage of a configured secret (`IWAC_HF_TOKEN` / `HF_TOKEN`,
  `IWAC_MCP_BEARER_TOKEN`, `IWAC_LOCAL_EMBEDDING_API_KEY`) into tool output,
  logs, or error messages, and any way for a private-mode instance to serve
  masked full text over HTTP without `IWAC_ALLOW_PRIVATE_HTTP=true`.

Out of scope:

- The content of the collection itself. IWAC is published material, and the tools
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
  (`IWAC_CACHE_DIR`, ~265 MB) downloaded from Hugging Face and answers queries
  from it. No accounts, no session persistence, no telemetry.
- **All tools are read-only.** There is no tool that writes, deletes, or mutates
  anything, locally or remotely.
- **Semantic search keeps queries local.** The `semantic_search_*` tools encode
  query text in-process with EmbeddingGemma 2; nothing is sent to an external
  API. The model weights are downloaded once from Hugging Face at a pinned
  revision and checked against pinned SHA-256 digests before use. An operator
  may instead set `IWAC_EMBEDDING_PROVIDER=local`, which sends query text to the
  OpenAI-compatible endpoint they configure; its credential stays server-side.
  `IWAC_SEMANTIC_SEARCH_ENABLED=false` removes the tools entirely.

## Dependency exception reviewed 2026-11-25

`@anthropic-ai/mcpb@2.1.2`, the development-only packaging and signing
toolchain, nests its own `zod@3` (it requires `^3.25.67`), which is affected by
[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)
(memory exhaustion while validating oversized constrained collections). 2.1.2 is
the latest mcpb release, so no fix is available through it. The nested copy never
ships: the server bundle inlines the top-level `zod@4.6.7`, which is not
affected, and the runtime container installs neither. CI therefore audits the
runtime tree only (`npm audit --omit=dev`), which is clean. Packaging must use
repository-controlled inputs. Recheck on each mcpb update and remove this
exception when it moves to a fixed zod. Do not force an unrelated major upgrade
or suppress all audit findings to hide this one.

The earlier `node-forge` exception (GHSA-86w9-cpqp-85rv, reviewed 2026-10-02) is
lifted: the lockfile now resolves `node-forge@1.4.4`, which no advisory affects.
