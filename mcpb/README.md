# IWAC MCP Server — Desktop Extension bundle

This directory contains the Node.js port of the IWAC MCP server packaged as an
Anthropic Desktop Extension (`.mcpb`) for one-click install in Claude Desktop.

## Install (end users)

Download the bundle for **your operating system** from the
[releases page](https://github.com/fmadore/iwac-mcp-server/releases) and
double-click it. Claude Desktop will show an install dialog; click **Install**.

| Your OS                          | Download                          |
| -------------------------------- | --------------------------------- |
| Windows (Intel/AMD or Snapdragon)| `iwac-mcp-server-windows.mcpb`    |
| macOS (Apple Silicon or Intel)   | `iwac-mcp-server-macos.mcpb`      |

Each bundle ships only its own OS's native DuckDB binaries (Claude Desktop picks
the right CPU architecture automatically), which keeps the download small and
makes installation reliable. Claude Desktop has no Linux build, so no Linux
bundle is published.

On first use the server downloads ~250 MB of parquet data from Hugging Face
into `~/.iwac-mcp/cache/` (override via the extension settings). Subsequent
queries are served locally through DuckDB.

- **25 core tools** work without any API key (keyword search, filtering,
  statistics, coverage timelines, item details).
- **2 optional semantic-search tools** require a free Google/Gemini API key and
  are disabled by default. Enable them in the extension settings.

## Develop / rebuild the bundle

```bash
cd mcpb
npm install
npm run install-bindings                    # fetch the 4 macOS/Windows binaries
npm run typecheck                           # tsc --noEmit (type safety)
npm run lint                                # biome (linter only, no formatting)
npm run build                               # esbuild -> server/index.js (single file)
npm test                                    # unit + offline fixture + HTTP round-trips
npm run test:live                           # full smoke test against the real dataset
```

`npm test` is hermetic: `test/unit.test.ts` covers the pure helpers,
`test/fixture-server.test.mjs` spawns the built server over stdio against
synthetic parquet fixtures (`scripts/make-fixtures.mjs`) with `IWAC_OFFLINE=1`,
and `test/http-server.test.mjs` does the same over the `--http` transport
(bearer auth, /health, body cap, a real Streamable-HTTP MCP call) — no network,
runs in seconds. `npm run test:live` (smoke-test.mjs) exercises every tool
against the real Hugging Face dataset; its pinned counts double as a
dataset-drift alarm and run weekly in CI.

Pack the per-OS server bundles (one `.mcpb` per OS, each with only that OS's
DuckDB binaries):

```bash
npm run release        # prepack-mcpb + install-bindings + pack-platforms + pack-skill + make-server-json
# or just repackage without rebuilding server/index.js:
npm run pack-platforms # -> iwac-mcp-server-windows.mcpb + iwac-mcp-server-macos.mcpb
```

`pack-platforms` stashes the non-target binaries out of the pack tree per OS, so
it runs offline against whatever `install-bindings` has placed in `node_modules`.
`pack-mcpb` still exists for a quick host-only single bundle during development.

Pack the research skill (a separate release asset — zips the repo-root
`.agents/skills/iwac-mcp/` at `HEAD`, so commit skill changes before running it):

```bash
npm run pack-skill                         # -> ../iwac-mcp-skill.zip (repo root)
```

Upload **all three** assets to the release: `iwac-mcp-server-windows.mcpb`,
`iwac-mcp-server-macos.mcpb`, and `iwac-mcp-skill.zip`.

## Publish to the official MCP Registry

Pushing a version tag does this automatically: the release workflow packs the
bundles, uploads them as release assets, generates `server.json`
(`scripts/make-server-json.mjs` — embeds each artifact's `fileSha256`, so it
must run in the same job that packed them), then publishes
**`io.github.fmadore/iwac-mcp-server`** to
[registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io)
via GitHub OIDC (no secret needed). The entry lists the two `.mcpb` packages
plus the public remote at `https://islam.zmo.de/mcp/`.

Registry versions are **immutable** — to fix a published entry, bump the
version and tag again; re-running the workflow for the same tag fails at the
publish step by design.

Manual fallback from the repo root (after `npm run release`):

```bash
mcp-publisher login github   # interactive; OIDC is CI-only
mcp-publisher publish        # reads ./server.json
```

## Remote HTTP / Docker deployment

Every release also publishes a linux/amd64 image to
**`ghcr.io/fmadore/iwac-mcp-server`** that runs the server in stateless
Streamable-HTTP mode (`node server/index.js --http`) — this is what serves the
public `https://islam.zmo.de/mcp/` endpoint (TLS, rate limiting, and the `/mcp`
path mount are handled upstream by nginx). The server **refuses to start in
HTTP mode without a bearer token**; an unauthenticated `GET /health` is exposed
for container health checks.

```bash
docker run -d -p 8000:8000 \
  -e IWAC_MCP_BEARER_TOKEN=<your-secret-token> \
  -v iwac-cache:/cache \
  ghcr.io/fmadore/iwac-mcp-server:latest
```

Environment variables (all transports unless noted):

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `IWAC_CACHE_DIR` | `~/.iwac-mcp/cache` (`/cache` in Docker) | Where parquet data is cached (~250 MB) |
| `IWAC_OFFLINE` | `false` | Trust the cache as-is; never touch the network |
| `IWAC_SEMANTIC_SEARCH_ENABLED` | `false` | Register the two `semantic_search_*` tools |
| `IWAC_GOOGLE_API_KEY` (or `GOOGLE_API_KEY` / `GEMINI_API_KEY`) | — | Gemini key for semantic search |
| `IWAC_EMBEDDING_MODEL` | `gemini-embedding-2` | Query-embedding model (must match the dataset's) |
| `IWAC_EMBEDDING_DIMENSIONALITY` | `768` | Query-embedding dimensionality |
| `PORT` | `8000` | HTTP mode only: listen port |
| `IWAC_MCP_BEARER_TOKEN` | — | HTTP mode only: the bearer token clients must send |
| `IWAC_MCP_TOKEN_FILE` | `/run/secrets/iwac_mcp_token` | HTTP mode only: read the token from a mounted secret file instead |

## Layout

| Path                         | Purpose                                         |
| ---------------------------- | ----------------------------------------------- |
| `manifest.json`              | MCPB manifest (version, tools, user_config)     |
| `src/`                       | TypeScript sources, split into `tools/` modules |
| `src/http.ts`                | Remote Streamable-HTTP transport (`--http`)     |
| `server/index.js`            | Single esbuild bundle (server + MCP SDK + zod)  |
| `node_modules/`              | Runtime externals: `@duckdb/*` + `@google/genai`|
| `Dockerfile`                 | GHCR image for the remote HTTP deployment       |
| `biome.json`                 | Lint configuration (`npm run lint`)             |
| `scripts/bundle.mjs`         | esbuild config (single-file bundle)             |
| `scripts/duckdb-bindings.mjs`| Shared helper: fetch/extract platform bindings  |
| `scripts/install-duckdb-bindings.mjs` | Fetch the 4 macOS/Windows bindings     |
| `scripts/pack-platforms.mjs` | Build one `.mcpb` per OS (Windows, macOS)       |
| `scripts/make-fixtures.mjs`  | Generate synthetic parquet test fixtures        |
| `scripts/make-server-json.mjs` | Generate `server.json` for the MCP Registry   |
| `test/`                      | Unit tests + offline fixture/HTTP MCP tests     |
| `smoke-test.mjs`             | Live MCP round-trip test (real dataset)         |
| `.mcpbignore`                | Files excluded from the `.mcpb` archive         |

## How the server works

- Data: parquet files from `https://huggingface.co/datasets/fmadore/islam-west-africa-collection`
  are lazily downloaded per subset (articles, publications, documents,
  audiovisual, index, references) and registered as DuckDB views over the local cache.
- Queries: all tools use parameterised SQL against DuckDB. The query layer
  probes each subset's column list at view-creation time so fields that are
  missing from the current dataset revision (e.g. `sentiment_label`) are silently
  dropped rather than raising.
- Semantic search: loads the `embedding_OCR` / `embedding_tableOfContents`
  column into a normalised `Float32Array`, encodes the query via Gemini, then
  does a dot-product top-k in-process.

## Why Node rather than Python

Anthropic's MCPB guidance recommends Node because Claude Desktop ships with a
bundled Node runtime, which means zero installation friction for end users.

`npm run build` bundles the server, the MCP SDK, and zod into a single
`server/index.js` with [esbuild](scripts/bundle.mjs). The native `@duckdb/*`
bindings and the optional `@google/genai` client stay external (the former can't
be inlined; the latter is only needed when semantic search is enabled), so those
two trees are the only runtime `node_modules` the packed bundle relies on.
