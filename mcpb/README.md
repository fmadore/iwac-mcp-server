# IWAC MCP Server — Desktop Extension bundle

This directory contains the Node.js port of the IWAC MCP server packaged as an
Anthropic Desktop Extension (`.mcpb`) for one-click install in Claude Desktop.

## Install (end users)

Download `iwac-mcp-server.mcpb` from the [releases page](https://github.com/fmadore/iwac-mcp-server/releases)
and double-click it. Claude Desktop will show an install dialog; click **Install**.

On first use the server downloads ~250 MB of parquet data from Hugging Face
into `~/.iwac-mcp/cache/` (override via the extension settings). Subsequent
queries are served locally through DuckDB.

- **20 core tools** work without any API key (keyword search, filtering,
  statistics, item details).
- **2 optional semantic-search tools** require a free Google/Gemini API key and
  are disabled by default. Enable them in the extension settings.

## Develop / rebuild the bundle

```bash
cd mcpb
npm install
node scripts/install-duckdb-bindings.mjs   # pulls all 6 platform binaries
npm run typecheck                          # tsc --noEmit (type safety)
npm run build                              # esbuild -> server/index.js (single file)
node smoke-test.mjs                        # spawn server, call each tool
```

Pack the server bundle:

```bash
npm prune --omit=dev
node scripts/install-duckdb-bindings.mjs   # re-hydrate after prune
npx mcpb validate manifest.json
npx mcpb pack . iwac-mcp-server.mcpb
```

Pack the research skill (a separate release asset — zips the repo-root
`.claude/skills/iwac-mcp/` at `HEAD`, so commit skill changes before running it):

```bash
npm run pack-skill                         # -> ../iwac-mcp-skill.zip (repo root)
```

Upload **both** `iwac-mcp-server.mcpb` and `iwac-mcp-skill.zip` to the release.

## Layout

| Path                         | Purpose                                         |
| ---------------------------- | ----------------------------------------------- |
| `manifest.json`              | MCPB manifest (version, tools, user_config)     |
| `src/`                       | TypeScript sources, split into `tools/` modules |
| `server/index.js`            | Single esbuild bundle (server + MCP SDK + zod)  |
| `node_modules/`              | Runtime externals: `@duckdb/*` + `@google/genai`|
| `scripts/bundle.mjs`         | esbuild config (single-file bundle)             |
| `scripts/install-duckdb-bindings.mjs` | Force-install all 6 platform bindings  |
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

`npm run build` bundles the server, the MCP SDK, and zod into a single
`server/index.js` with [esbuild](scripts/bundle.mjs). The native `@duckdb/*`
bindings and the optional `@google/genai` client stay external (the former can't
be inlined; the latter is only needed when semantic search is enabled), so those
two trees are the only runtime `node_modules` the packed bundle relies on.
