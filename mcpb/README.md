# IWAC MCP Server — Desktop Extension bundle

This directory contains the Node.js port of the IWAC MCP server packaged as an
Anthropic Desktop Extension (`.mcpb`) for one-click install in Claude Desktop.

## Install (end users)

Download `iwac-mcp-server.mcpb` from the [releases page](https://github.com/fmadore/iwac-mcp-server/releases)
and double-click it. Claude Desktop will show an install dialog; click **Install**.

On first use the server downloads ~250 MB of parquet data from Hugging Face
into `~/.iwac-mcp/cache/` (override via the extension settings). Subsequent
queries are served locally through DuckDB.

- **16 core tools** work without any API key (keyword search, filtering,
  statistics, item details).
- **2 optional semantic-search tools** require a free Google/Gemini API key and
  are disabled by default. Enable them in the extension settings.

## Develop / rebuild the bundle

```bash
cd mcpb
npm install
node scripts/install-duckdb-bindings.mjs   # pulls all 6 platform binaries
npm run build                              # tsc -> server/*.js
node smoke-test.mjs                        # spawn server, call each tool
```

Pack:

```bash
npm prune --omit=dev
node scripts/install-duckdb-bindings.mjs   # re-hydrate after prune
npx mcpb validate manifest.json
npx mcpb pack . iwac-mcp-server.mcpb
```

## Layout

| Path                         | Purpose                                         |
| ---------------------------- | ----------------------------------------------- |
| `manifest.json`              | MCPB manifest (version, tools, user_config)     |
| `src/`                       | TypeScript sources (excluded from the bundle)   |
| `server/`                    | Compiled JS entry point (bundled)               |
| `node_modules/`              | Runtime deps + all 6 DuckDB platform bindings   |
| `scripts/install-duckdb-bindings.mjs` | Force-install all platform bindings    |
| `smoke-test.mjs`             | Local MCP round-trip test                       |
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
The Python server remains in `../src/iwac_mcp/` for reference and for users who
want to run it from source.
