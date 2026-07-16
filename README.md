# IWAC MCP Server

A read-only [Model Context Protocol](https://modelcontextprotocol.io/) server for the
[Islam West Africa Collection (IWAC)](https://islam.zmo.de/s/westafrica/).
Ships as a one-click [Desktop Extension](https://github.com/modelcontextprotocol/mcpb)
(`.mcpb`) for Claude Desktop, backed by the
[IWAC Hugging Face dataset](https://huggingface.co/datasets/fmadore/islam-west-africa-collection).
Also available as a **hosted endpoint** at `https://islam.zmo.de/mcp/` for ChatGPT
and other MCP clients — see [docs/connecting.md](docs/connecting.md) for the
full connection walkthrough (Claude Desktop and ChatGPT).

## Install

Each [release](https://github.com/fmadore/iwac-mcp-server/releases) ships a
server bundle **for your operating system** plus a research-skill `.zip`. The
`.mcpb` gives Claude the data and tools; the `.zip` adds a research skill that
teaches Claude *how* to use them. Install the server first, then **install the
skill too — strongly recommended** for getting the most out of the tools: it
makes Claude search and synthesize far more efficiently, with fewer wasted
queries.

### 1. The MCP server — pick the bundle for your OS

| Your OS                            | Download                       |
| ---------------------------------- | ------------------------------ |
| Windows (Intel/AMD or Snapdragon)  | `iwac-mcp-server-windows.mcpb` |
| macOS (Apple Silicon or Intel)     | `iwac-mcp-server-macos.mcpb`   |

1. Download the bundle for your OS from
   [Releases](https://github.com/fmadore/iwac-mcp-server/releases).
2. Double-click the file. Claude Desktop shows an install dialog — click **Install**.
3. On first use the server downloads ~250 MB of parquet data from Hugging Face
   into `~/.iwac-mcp/cache/` (override in the extension settings).

No Python, no `uv`, no venv — the bundle ships a self-contained Node runtime and
the DuckDB binaries for your OS (x64 and arm64; Claude Desktop picks the right
one). Claude Desktop has no Linux build, so no Linux bundle is published.

### 2. The research skill — `iwac-mcp-skill.zip` (strongly recommended)

The [`iwac-mcp` skill](.agents/skills/iwac-mcp/SKILL.md) wraps the raw tools in a
structured research workflow: a five-phase methodology, francophone search
strategy, source attribution with confidence grading, and bias/coverage caveats.
**It makes the server far more efficient to use** — Claude picks the right tool
and search terms on the first pass (fewer wasted queries), searches French
sources properly, and returns a cited synthesis instead of a raw tool dump. You
can run the tools without it, but you'll get more out of every query with it
installed.

Download `iwac-mcp-skill.zip` from the same release, then:

- **Claude Desktop** — open **Customize → Skills → + → Create skill → Upload a
  skill** and select the zip. (Or unzip it into `~/.claude/skills/` and restart
  Claude Desktop.)
- **Claude Code** — unzip it into your skills directory; Claude Code discovers it
  live, no restart needed:

  ```bash
  # macOS / Linux
  unzip iwac-mcp-skill.zip -d ~/.claude/skills/
  ```

  ```powershell
  # Windows (PowerShell)
  Expand-Archive iwac-mcp-skill.zip -DestinationPath $HOME\.claude\skills\
  ```

  Both land the skill at `~/.claude/skills/iwac-mcp/`. The repository source of
  truth is `.agents/skills/iwac-mcp/`; keep project-local copies there rather
  than duplicating the same skill under `.claude/`.

## What it gives Claude

27 possible read-only tools across six IWAC subsets. **25 work out of the box**;
the 2 `semantic_search_*` tools are optional and require a free Google/Gemini API
key (disabled by default). All keyword and filter matching is accent- and
case-insensitive. The unified `search`/`fetch` pair, the stats tools,
`list_periodicals`, and `get_sentiment_distribution` also return MCP structured
content (`outputSchema` + `structuredContent`), which the ChatGPT connector
contract requires.

| Group        | Tools                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------- |
| Cross-subset | `search`, `fetch`                                                                           |
| Articles     | `search_articles`, `get_article`, `semantic_search_articles`                                |
| Sentiment    | `search_by_sentiment`, `get_sentiment_distribution`                                         |
| Index        | `search_index`, `get_index_entry`, `list_subjects`, `list_locations`, `list_persons`        |
| Stats        | `get_collection_stats`, `get_newspaper_stats`, `get_country_comparison`, `get_temporal_distribution` |
| Publications | `search_publications`, `list_periodicals`, `get_publication_fulltext`, `semantic_search_publications` |
| References   | `search_references`, `get_reference`                                                        |
| Other        | `search_documents`, `get_document`, `search_audiovisual`, `list_audiovisual`, `get_audiovisual` |

The three full-text tools — `get_article`, `get_document`, and
`get_publication_fulltext` — optionally take a `keyword` to return ~2000-char
excerpts around each match, so Claude reads just the relevant passages of a long
article, archival document, or periodical issue instead of the whole OCR.

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

## Architecture

- **Data**: parquet files from the
  [IWAC Hugging Face dataset](https://huggingface.co/datasets/fmadore/islam-west-africa-collection)
  are lazily downloaded per subset (articles, publications, documents,
  audiovisual, index, references) into a local cache and queried through DuckDB
  views. All SQL is parameterised; matching is accent/case-insensitive.
- **Transports**: stdio (the default — what the Claude Desktop `.mcpb` uses),
  and a stateless Streamable-HTTP mode (`node server/index.js --http`) behind a
  bearer token, which the Docker image runs for the hosted
  `https://islam.zmo.de/mcp/` endpoint.
- **Docker**: every release publishes `ghcr.io/fmadore/iwac-mcp-server` for
  self-hosting the HTTP endpoint — see
  [`mcpb/README.md`](mcpb/README.md#remote-http--docker-deployment) for the
  required env vars and token setup.

## Develop

The bundle lives under [`mcpb/`](mcpb/). See [`mcpb/README.md`](mcpb/README.md)
for the build / pack workflow.

```bash
cd mcpb
npm install
npm run install-bindings   # fetch the 4 macOS/Windows DuckDB binaries
npm run typecheck   # tsc --noEmit
npm run lint        # biome (linter only)
npm run build       # esbuild -> single server/index.js
npm test            # unit tests + offline fixture & HTTP MCP round-trips (no network)
npm run test:live   # full smoke test against the real HF dataset (~250 MB)
```

CI runs the version check, typecheck, lint, build, unit tests, and the offline
fixture + HTTP round-trip tests on every push to `main` and every pull request;
the live smoke test runs weekly (its pinned counts are the dataset-drift alarm).
Releases: push a `v*` tag — the release workflow re-runs the full test suite,
packs the per-OS `.mcpb` bundles and skill zip, smoke-tests and pushes the
Docker image, uploads the release assets, and publishes to the MCP Registry.

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
