# IWAC MCP Server

[![CI](https://github.com/fmadore/iwac-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/fmadore/iwac-mcp-server/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/fmadore/iwac-mcp-server?label=release)](https://github.com/fmadore/iwac-mcp-server/releases/latest)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-io.github.fmadore%2Fiwac--mcp--server-0a7ea4)](https://registry.modelcontextprotocol.io/?search=iwac)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![DOI](https://img.shields.io/badge/DOI-10.5281%2Fzenodo.21805837-blue)](https://doi.org/10.5281/zenodo.21805837)

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

  Installing it this way is still worth doing: an installed skill is matched
  against your question automatically, before any tool is called.

#### The server also serves the skill (`skill://`, prototype)

> **Prototype.** This is an experiment tracking a draft spec, not a supported
> interface. The URIs and the catalogue shape may change or be withdrawn
> without a major version bump. Installing the skill from the `.zip` above is
> still the supported path on Claude Desktop and Claude Code. Do not rely on
> `skill://` in anything you build.

Every build also embeds the skill and exposes it as MCP resources, so a client
that has not installed it can still read it:

| Resource | What it is |
| --- | --- |
| `skill://iwac-mcp` | Catalogue: every file with its size and SHA-256 digest |
| `skill://iwac-mcp/SKILL.md` | The workflow itself |
| `skill://iwac-mcp/references/…` | The four reference files, read on demand |

A host that implements the draft extension can instead discover the same
catalogue through `skills/list` and `skills/get`, which the server declares via
the `io.modelcontextprotocol/skills` capability. Both routes read one catalogue,
so they cannot disagree.

This matters most for the remote HTTP endpoint, where there is no release
artifact to download: add the connector and the manual comes with it. The
server's handshake instructions point at `skill://iwac-mcp/SKILL.md`, and
nothing is pushed into the context until something asks for it.

The shape follows [SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640)
("Skills over MCP"), **an open draft PR against the MCP spec: not accepted, and
subject to change**. Two routes reach the same catalogue: the `resources/*` one
above, which every current client already speaks, and the extension's own
`skills/list` / `skills/get`, for hosts that implement the draft. The SEP's one
optional method, `resources/directory/read`, is **not** served — the bare
`skill://iwac-mcp` is this server's catalogue document and cannot also be a
directory resource — so the capability is declared without `directoryRead`.
If the SEP changes shape or is rejected, all of this moves with it.

## What it gives Claude

37 possible read-only tools across seven IWAC subsets. **34 work out of the
box**; the 3 `semantic_search_*` tools are optional and require a free
Google/Gemini API key (disabled by default). All keyword and filter matching is
accent- and case-insensitive. The unified `search`/`fetch` pair, the stats
tools, the aggregates, `list_periodicals`, and `get_sentiment_distribution` also
return MCP structured content (`outputSchema` + `structuredContent`), which the
ChatGPT connector contract requires.

| Group        | Tools                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------- |
| Cross-subset | `search`, `fetch`                                                                           |
| Articles     | `search_articles`, `get_article`, `semantic_search_articles`                                |
| Sentiment    | `search_by_sentiment`, `get_sentiment_distribution`                                         |
| Index        | `search_index`, `get_index_entry`, `list_subjects`, `list_locations`, `list_persons`        |
| Stats        | `get_collection_stats`, `get_newspaper_stats`, `get_country_comparison`, `get_temporal_distribution` |
| Aggregates   | `get_topic_distribution`, `get_field_distribution`, `get_cooccurrence`, `get_lexical_metrics`, `get_place_distribution`, `get_semantic_map`, `get_similar_items` |
| Publications | `search_publications`, `list_periodicals`, `get_publication_fulltext`, `semantic_search_publications` |
| References   | `search_references`, `get_reference`                                                        |
| Images       | `search_images`, `get_image`, `semantic_search_images`                                      |
| Other        | `search_documents`, `get_document`, `search_audiovisual`, `list_audiovisual`, `get_audiovisual` |

The **aggregates** answer questions about a whole set rather than returning its
items: how it spreads across the 30 precomputed LDA topics, which subjects,
places or bylines dominate it, what gets discussed alongside what, how its prose
reads, where on a map it points, how it lays out in embedding space, and what a
given item's nearest neighbours are. Eleven tools in all — the stats family plus
these — declare an MCP App view, so in Claude they render as interactive charts
rather than JSON.

`get_temporal_distribution` also reads the **Islamic calendar**. With
`granularity="lunar_month"` it pools every year into the twelve lunar months —
the one bucket a Gregorian axis structurally cannot produce, because the Hijri
year drifts ~11 days annually and so smears each observance across all twelve
Gregorian months. Over the 12,220 fully-dated articles the archive's rhythm is
plain: Ramadan +72%, Dhu al-Hijja +70% (hajj and Tabaski) and Shawwal +44%
(Korité) against an even split, while Rabi' I — Maouloud — sits flat. `search_articles`
and `search_publications` take `hijri_month` (1–12 or a name in either
transliteration) and `hijri_year` to read the items behind a peak. The lunar
dates are precomputed in the dataset pipeline with the Umm al-Qura tables, the
same converter the on-this-day block on islam.zmo.de uses, so the two never
disagree; items dated only to a year or month have no lunar date and are reported
in `imprecise_date_count` rather than plotted.

The three full-text tools — `get_article`, `get_document`, and
`get_publication_fulltext` — optionally take a `keyword` to return ~2000-char
excerpts around each match, so Claude reads just the relevant passages of a long
article, archival document, or periodical issue instead of the whole OCR.

Every result object includes a `url` field pointing at the canonical IWAC record,
e.g. `https://islam.zmo.de/s/afrique_ouest/item/28576`.

## About the collection

IWAC is a digital archive focused on Islam and Muslims in West Africa:

- **12,000+ newspaper articles** from Benin, Burkina Faso, Côte d'Ivoire, Niger,
  and Togo, 1960s–present (mostly French), each with an AI abstract and AI
  sentiment analysis (polarity / centrality / subjectivity), scored
  independently by four models — `gpt-5-6-luna` (the one the inline columns
  report), `mistral-small-2603`, `deepseek-v4-flash-0731` and `gemma-4-31b-it`.
  All four agree on polarity for only ~36% of articles, so
  `get_sentiment_distribution(model="all")` is the honest way to quote a figure
- **4,700+ authority records** (persons, organisations, places, events, subjects)
- **1,500+ Islamic publications** (periodical issues, books) with full OCR
- **860+ academic references**, half with abstracts
- **1,700+ audiovisual items** — francophone web video from Burkina Faso, Togo
  and Benin (harvested from public channels, still growing, searchable by
  channel and reachable through a watch URL), plus 47 deposited Nigerian
  Hausa/Arabic recordings with files — and archival documents

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

## How to cite

Machine-readable metadata lives in [CITATION.cff](CITATION.cff) — GitHub's
**Cite this repository** button (sidebar) renders it as APA or BibTeX with the
current version filled in. In text:

> Madore, F. (2026). *IWAC MCP Server* (Version 3.2.0) [Computer software].
> Zenodo. https://doi.org/10.5281/zenodo.21805837

```bibtex
@software{madore_iwac_mcp_server,
  author    = {Madore, Frédérick},
  title     = {{IWAC MCP Server}},
  year      = {2026},
  version   = {3.2.0},
  publisher = {Zenodo},
  doi       = {10.5281/zenodo.21805837},
  url       = {https://github.com/fmadore/iwac-mcp-server},
  license   = {MIT}
}
```

That DOI is the **concept DOI** — it always resolves to the newest release, so it
stays correct as versions come and go. If you need to cite the exact version you
ran, take the per-version DOI from the
[Zenodo record](https://doi.org/10.5281/zenodo.21805837).

If the software helped you reach a finding, please cite the
[collection itself](https://islam.zmo.de/s/westafrica/) as well — that is where
the archival work lives.

## License

[MIT](LICENSE)

## Related

- [IWAC Hugging Face Dataset](https://huggingface.co/datasets/fmadore/islam-west-africa-collection)
- [IWAC Digital Archive](https://islam.zmo.de/s/westafrica/)
- [Desktop Extensions spec (MCPB)](https://github.com/modelcontextprotocol/mcpb)
