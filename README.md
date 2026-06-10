# IWAC MCP Server

A read-only [Model Context Protocol](https://modelcontextprotocol.io/) server for the
[Islam West Africa Collection (IWAC)](https://islam.zmo.de/s/westafrica/).
Ships as a one-click [Desktop Extension](https://github.com/modelcontextprotocol/mcpb)
(`.mcpb`) for Claude Desktop, backed by the
[IWAC Hugging Face dataset](https://huggingface.co/datasets/fmadore/islam-west-africa-collection).

## Install

1. Download the latest `iwac-mcp-server.mcpb` from
   [Releases](https://github.com/fmadore/iwac-mcp-server/releases).
2. Double-click the file. Claude Desktop shows an install dialog — click **Install**.
3. On first use the server downloads ~250 MB of parquet data from Hugging Face
   into `~/.iwac-mcp/cache/` (override in the extension settings).

No Python, no `uv`, no venv — the bundle ships a self-contained Node runtime and
DuckDB bindings for macOS, Windows, and Linux (x64 and arm64).

## What it gives Claude

22 read-only tools across six IWAC subsets. **20 work out of the box**; the 2
`semantic_search_*` tools are optional and require a free Google/Gemini API key
(disabled by default). All keyword and filter matching is accent- and
case-insensitive.

| Group        | Tools                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------- |
| Articles     | `search_articles`, `get_article`, `semantic_search_articles`                                |
| Sentiment    | `search_by_sentiment`, `get_sentiment_distribution`                                         |
| Index        | `search_index`, `get_index_entry`, `list_subjects`, `list_locations`, `list_persons`        |
| Stats        | `get_collection_stats`, `get_newspaper_stats`, `get_country_comparison`                     |
| Publications | `search_publications`, `list_periodicals`, `get_publication_fulltext`, `semantic_search_publications` |
| References   | `search_references`, `get_reference`                                                        |
| Other        | `search_documents`, `get_document`, `list_audiovisual`                                      |

Every result object includes a `url` field pointing at the canonical IWAC record,
e.g. `https://islam.zmo.de/s/afrique_ouest/item/28576`.

## About the collection

IWAC is a digital archive focused on Islam and Muslims in West Africa:

- **12,000+ newspaper articles** from Benin, Burkina Faso, Côte d'Ivoire, Niger,
  and Togo, 1960s–present (mostly French), each with an AI abstract and Gemini
  sentiment analysis (polarity / centrality / subjectivity)
- **4,700+ authority records** (persons, organisations, places, events, subjects)
- **1,500+ Islamic publications** (periodical issues, books) with full OCR
- **860+ academic references**, half with abstracts
- Archival documents and Nigerian audiovisual materials

## Develop

The bundle lives under [`mcpb/`](mcpb/). See [`mcpb/README.md`](mcpb/README.md)
for the build / pack workflow.

```bash
cd mcpb
npm install
node scripts/install-duckdb-bindings.mjs
npm run typecheck   # tsc --noEmit
npm run build       # esbuild -> single server/index.js
node smoke-test.mjs
```

## Roadmap

See [TODO.md](TODO.md) — near-term: submit to the Anthropic extension directory,
sign the bundle with a production code-signing cert, and replace Gemini
semantic-search with a free local model.

## License

[MIT](LICENSE)

## Related

- [IWAC Hugging Face Dataset](https://huggingface.co/datasets/fmadore/islam-west-africa-collection)
- [IWAC Digital Archive](https://islam.zmo.de/s/westafrica/)
- [Desktop Extensions spec (MCPB)](https://github.com/modelcontextprotocol/mcpb)
