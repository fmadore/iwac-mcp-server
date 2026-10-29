# IWAC MCP Server

[![CI](https://github.com/fmadore/iwac-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/fmadore/iwac-mcp-server/actions/workflows/ci.yml)
[![Release build](https://github.com/fmadore/iwac-mcp-server/actions/workflows/docker-publish.yml/badge.svg?event=push)](https://github.com/fmadore/iwac-mcp-server/actions/workflows/docker-publish.yml)
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
| Windows (Intel/AMD or Snapdragon)  | [iwac-mcp-server-windows.mcpb](https://github.com/fmadore/iwac-mcp-server/releases/latest/download/iwac-mcp-server-windows.mcpb) |
| macOS (Apple Silicon or Intel)     | [iwac-mcp-server-macos.mcpb](https://github.com/fmadore/iwac-mcp-server/releases/latest/download/iwac-mcp-server-macos.mcpb)   |

1. Download the latest bundle for your OS using the links above.
2. Double-click the file. Claude Desktop shows an install dialog — click **Install**.
3. On first use the server downloads ~265 MB of parquet data from Hugging Face
   into `~/.iwac-mcp/cache/` (override in the extension settings).

The bundle contains the server and DuckDB binaries for your OS (x64 and arm64).
[Claude Desktop supplies the Node.js runtime](https://github.com/modelcontextprotocol/mcpb#language-choice-recommendation),
so no separate Node.js or Python installation is needed. We publish desktop
bundles for Windows and macOS.

#### Extension settings and updates

Open **Settings → Extensions → Islam West Africa Collection (IWAC)** in Claude
Desktop to configure these options:

| Feature | Credentials | Settings |
| --- | --- | --- |
| Public keyword search, filters, statistics, and item details | None | Default. |
| Semantic search | None | On by default (**Semantic search**). The first semantic search downloads the query model once (~350 MB); turn the setting off to skip it. |
| Private full text | Hugging Face token authorized to read the private dataset | Enable **Use private full dataset** and enter **Hugging Face token (private dataset only)**. |

Semantic search runs [EmbeddingGemma 2](https://huggingface.co/google/embeddinggemma-2),
the model the corpus vectors were made with, on your own machine: no API key,
and no query leaves your computer. It needs Windows (x64 or ARM64, with the
Microsoft Visual C++ 2015-2022 Redistributable that most PCs already have) or
an Apple-silicon Mac; on an Intel Mac the semantic tools report that they cannot
run, and everything else works. The shared hosted endpoint serves public data.

**Updating:** download and open the latest bundle for your OS to update the
extension. If the Hugging Face fields are missing, your installed extension may
predate **v3.6.0**. After updating, review the settings, save any changes, and
restart Claude Desktop.

#### Optional private full-text access

Public data remains the default and needs no token. In the desktop extension,
enable **Use private full dataset**, enter the **Hugging Face token (private dataset only)**,
save the settings, and restart. Use a fine-grained token with read access to
`fmadore/islam-west-africa-collection-full`. The token field is marked sensitive.
Never paste your token into a chat or commit it.

Other local launchers can set `IWAC_PRIVATE_DATASET=true` and provide
`IWAC_HF_TOKEN` (or `HF_TOKEN`). A token alone does not enable private mode;
public downloads do not send it. No new dependency or account system is needed.

Private files use a separate `private-full/` subdirectory of `IWAC_CACHE_DIR`
(default: `~/.iwac-mcp/cache`). Restart after changing modes. Missing tokens
and private HTTP 401/403/404 errors fail without cache fallback. Network outages
may use that mode's cache. Explicit `IWAC_OFFLINE=true` uses downloaded files
without authentication; removing a token does not erase private files.

Keep the shared hosted endpoint public. This setting applies to the whole instance:
everyone who can query a private instance can access its full text. HTTP mode
therefore refuses to start in private mode unless `IWAC_ALLOW_PRIVATE_HTTP=true`
is also set, and both transports log which dataset they serve at startup.

### 2. The research skill — `iwac-mcp-skill.zip` (strongly recommended)

The [`iwac-mcp` skill](.agents/skills/iwac-mcp/SKILL.md) wraps the raw tools in a
structured research workflow: a five-phase methodology, francophone search
strategy, source attribution with confidence grading, and bias/coverage caveats.
**It makes the server far more efficient to use** — Claude picks the right tool
and search terms on the first pass (fewer wasted queries), searches French
sources properly, and returns a cited synthesis instead of a raw tool dump. You
can run the tools without it, but you'll get more out of every query with it
installed.

Download the latest [iwac-mcp-skill.zip](https://github.com/fmadore/iwac-mcp-server/releases/latest/download/iwac-mcp-skill.zip), then:

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

#### The server also serves the skill (`skill://`)

Every build embeds the research skill, including the Docker image, and serves it
through the MCP SDK's implementation of the
[Skills extension](https://modelcontextprotocol.io/extensions/skills/overview)
(SEP-2640, `io.modelcontextprotocol/skills`). Clients supporting it discover the
skill through `skills/list` and `skills/get`, browse it with
`resources/directory/read`, and check every file they read against the
manifest's SHA-256 digests. Clients without the extension see every file in
`resources/list`, each with a title and a one-line summary, and read it with
ordinary `resources/read`:

| Resource | Content |
| --- | --- |
| `skill://iwac-mcp/SKILL.md` | Research workflow |
| `skill://iwac-mcp/references/…` | Four reference files, read on demand |
| `skill://iwac-mcp` | The skill's directory, for `resources/directory/read` |

The bare `skill://iwac-mcp` URI is a directory, no longer the JSON catalogue
that releases up to v4.1.0 served there; `skills/list` carries the same sizes
and digests. Skill
content is a build-time snapshot; editing the source requires a rebuild. The
release zip remains available for clients that install skills locally. Remote
clients can read the same workflow without downloading a release artifact.

## What it gives Claude

39 read-only tools across seven IWAC subsets, none of which needs an API key.
The 4 `semantic_search_*` tools can be turned off; they rank with EmbeddingGemma 2
run locally (see [mcpb/README.md](mcpb/README.md#semantic-search)). All keyword and filter matching is
accent- and case-insensitive. The unified `search`/`fetch` pair, the stats
tools, the aggregates, `list_periodicals`, and `get_sentiment_distribution` also
return MCP structured content (`outputSchema` + `structuredContent`), which the
ChatGPT connector contract requires.

The tool contract, as of v5.0.0:

- **One keyword rule.** Every search and aggregate requires every word of a
  keyword, in any order; a `"quoted phrase"` must occur as written, and
  `keyword_mode: "literal"` keeps the single-substring match of earlier
  releases. A one-word keyword is unchanged.
- **Strict arguments.** An unknown argument name is an error, never an
  unfiltered search; strings are bounded at 2,000 characters.
- **Coded errors.** Every error carries a stable `code` (`invalid_argument`,
  `not_found`, `unavailable`, `data_error`) beside its message.
- **Self-explaining empty results.** A filtered list that matches nothing says
  so (`hint`), and the article, publication and reference searches suggest close
  stored `subject` and `newspaper` values (`did_you_mean`). Pages stop early at
  ~40,000 characters (`response_limited`, with an exact `next_offset`).
- **Linked exports.** `explore_corpus` with `link: true` returns one
  `iwac://export/…` resource link holding a whole selection (up to 5,000 items)
  as a manifest, CSL-JSON or BibTeX file, instead of 50-item pages in the
  conversation.
- **Compact provenance.** The model reads the snapshot id, revision, access mode
  and subsets; file identities stay in `_meta` and `iwac://datasets/{subset}`.
- **Profiles.** `IWAC_TOOL_PROFILE=core|analysis|search` serves a smaller tool
  surface for hosts that pay for every definition on every turn; the
  instructions name only the tools a profile registers.

| Group        | Tools                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------- |
| Cross-subset | `search`, `fetch`, `explore_corpus`                                                                           |
| Articles     | `search_articles`, `get_article`, `semantic_search_articles`                                |
| Sentiment    | `search_by_sentiment`, `get_sentiment_distribution`                                         |
| Index        | `search_index`, `get_index_entry`, `list_subjects`, `list_locations`, `list_persons`        |
| Stats        | `get_collection_stats`, `get_newspaper_stats`, `get_country_comparison`, `get_temporal_distribution` |
| Aggregates   | `get_topic_distribution`, `get_field_distribution`, `get_cooccurrence`, `get_lexical_metrics`, `get_place_distribution`, `get_semantic_map`, `get_similar_items` |
| Publications | `search_publications`, `list_periodicals`, `get_publication_fulltext`, `semantic_search_publications` |
| References   | `search_references`, `get_reference`, `semantic_search_references`                          |
| Images       | `search_images`, `get_image`, `semantic_search_images`                                      |
| Other        | `search_documents`, `get_document`, `search_audiovisual`, `list_audiovisual`, `get_audiovisual` |

The **aggregates** answer questions about a whole set rather than returning its
items: how it spreads across the 30 precomputed LDA topics, which subjects,
places or bylines dominate it, what gets discussed alongside what, how its prose
reads, where on a map it points, how it lays out in embedding space, and what a
given item's nearest neighbours are. Fourteen tools in all (the stats family,
these aggregates, `list_periodicals`, `get_sentiment_distribution` and
`explore_corpus`) declare an MCP App view, so in Claude they render as
interactive charts rather than JSON.

`get_temporal_distribution` also reads the **Islamic calendar**. With
`granularity="lunar_month"` it pools every year into the twelve lunar months —
the one bucket a Gregorian axis structurally cannot produce, because the Hijri
year drifts ~11 days annually and so smears each observance across all twelve
Gregorian months. Over the 16,579 fully-dated articles the archive's rhythm is
plain: Ramadan +73%, Dhu al-Hijja +68% (hajj and Tabaski) and Shawwal +42%
(Korité) against an even split, while Rabi' I (Maouloud) sits flat. `search_articles`
and `search_publications` take `hijri_month` (1–12 or a name in either
transliteration) and `hijri_year` to read the items behind a peak. The lunar
dates are precomputed in the dataset pipeline with the Umm al-Qura tables, the
same converter the on-this-day block on islam.zmo.de uses, so the two never
disagree; items dated only to a year or month have no lunar date and are reported
in `imprecise_date_count` rather than plotted.

The four full-text tools (`get_article`, `get_document`,
`get_publication_fulltext` and `get_audiovisual`) optionally take a `keyword` to
return ~2000-char excerpts around each match, so Claude reads just the relevant
passages of a long article, archival document, periodical issue or transcription
instead of the whole text. When the whole text is what you want, they serve it in
25,000-character parts: each part says where the next one starts (`next_offset`),
and passing that back as `offset` reads on to the end.

Every result object includes a `url` field pointing at the canonical IWAC record,
e.g. `https://islam.zmo.de/s/afrique_ouest/item/28576`.

## About the collection

IWAC is a digital archive focused on Islam and Muslims in West Africa:

- **16,700+ newspaper articles** from Benin, Burkina Faso, Côte d'Ivoire, Niger,
  and Togo, 1961 to the present (mostly French), each with an AI abstract. The
  public dataset carries full OCR for the ~45% whose text is public on
  islam.zmo.de; `get_collection_stats` reports the live ratio.
- **AI sentiment analysis** (polarity / centrality / subjectivity) for the
  12,298 articles the enrichment pass has reached, scored independently by five
  models: `gpt-5-6-luna` (the one the inline columns report),
  `mistral-small-2603`, `deepseek-v4-flash-0731`, `gemma-4-31b-it` and
  `qwen3-8-27b`. The ~4,400 newest arrivals are not scored yet. All five agree
  on polarity for only ~32% of articles, so
  `get_sentiment_distribution(model="all")` is the honest way to quote a figure.
  They do not all cover the same articles either (`qwen3-8-27b` scores 12,098
  where the rest score 12,298), so each model reports its own `coverage`.
  `model="consensus"` returns the panel's precomputed majority (not a sixth
  model), and `search_by_sentiment(disputed=…)` reads the articles it split on
- **5,000+ authority records** (persons, organisations, places, events, subjects)
- **1,500+ Islamic publications** (periodical issues, books), most with full OCR
- **860+ academic references**, half with abstracts
- **1,800+ audiovisual items**: francophone web video from Burkina Faso, Togo
  and Benin (harvested from public channels, still growing, searchable by
  channel and reachable through a watch URL), plus 47 deposited Nigerian
  Hausa/Arabic recordings with files
- **26 archival documents** and **30 fieldwork photographs**

## Research workbench

`explore_corpus` connects selections to sources, keyword contexts, coverage
heatmaps, comparisons, publication-country/mentioned-place matrices, and pageable
manifest, CSL-JSON and BibTeX exports. `iwac://datasets/{subset}` resources expose
current columns, field availability and dataset provenance.
Temporal charts support normalized shares with explicit denominators. Sentiment
comparisons accept the same selection filters and a chosen pair of models, with
Cohen’s kappa and quadratic weighted kappa on explicitly reported populations. Exact
chart selections, source reading, Back navigation and provenance exports are
shared across the app. See [the workbench guide](docs/research-workbench.md) for
examples, interpretation limits, cache behavior and local embedding migration.

On supported MCP Apps hosts, **Fullscreen** expands the view, and a compact
summary of the current selection is shared automatically with the assistant.
**Ask about this selection** sends an explicit question with that selection's
snapshot; automatic updates do not start a conversation turn. The summary carries
bounded filters, counts, source IDs and provenance, with omissions marked; full
source text still requires retrieval. Controls depend on the host's advertised
capabilities. See [the interaction contract](docs/mcp-apps-roadmap.md#9-current-interaction-contract-october-2026).

## Architecture

- **Data**: parquet files from the
  [IWAC Hugging Face dataset](https://huggingface.co/datasets/fmadore/islam-west-africa-collection)
  are lazily downloaded per subset (articles, publications, documents,
  audiovisual, images, index, references) into a local cache and queried through DuckDB
  views. A long-running server re-checks each subset daily (`IWAC_REFRESH_HOURS`)
  and swaps in a newer revision without a restart. Each request pins its files;
  old generations are retained for other readers and reproducibility. All SQL is parameterised;
  matching is accent/case-insensitive.
- **Transports**: stdio (the default — what the Claude Desktop `.mcpb` uses),
  and a stateless Streamable-HTTP mode (`node server/index.js --http`) behind a
  bearer token, which the Docker image runs for the hosted
  `https://islam.zmo.de/mcp/` endpoint.
- **Docker**: every release publishes `ghcr.io/fmadore/iwac-mcp-server` for
  self-hosting the HTTP endpoint — see
  [`mcpb/README.md`](mcpb/README.md#remote-http--docker-deployment) for the
  required env vars and token setup.
- **Provenance**: from v5.0.0 the release workflow attests the build provenance
  (SLSA, through GitHub's Sigstore) of both desktop bundles, the skill zip,
  `server.json` and the image. Verify a download with
  `gh attestation verify iwac-mcp-server-windows.mcpb -R fmadore/iwac-mcp-server`,
  or the image with
  `gh attestation verify oci://ghcr.io/fmadore/iwac-mcp-server:5.0.0 -R fmadore/iwac-mcp-server`.

## Develop

This implementation requires **Node.js 24 or newer** for both the build and server
runtime. Node.js 20 is [end of life](https://nodejs.org/en/about/previous-releases).
Desktop hosts with an older embedded runtime must be upgraded before installing
the next bundle; the manifest rejects incompatible runtimes.

The bundle lives under [`mcpb/`](mcpb/). See [`mcpb/README.md`](mcpb/README.md)
for the build / pack workflow.

```bash
cd mcpb
npm ci
npm run install-bindings   # fetch the 4 macOS/Windows DuckDB binaries
npm run typecheck   # tsc --noEmit
npm run lint        # biome (linter only)
npm run build       # esbuild -> single server/index.js
npm test            # unit, fixture, app, skills, HTTP and token-budget tests
npm run test:browser # Chromium app behavior (install browser first)
npm run test:live   # full smoke test against the real HF dataset (~265 MB)
```

CI runs the version check, typecheck, lint, build, unit tests, and the offline
fixture + HTTP round-trip tests on every push to `main` and every pull request;
the live smoke test runs weekly (its pinned counts are the dataset-drift alarm).
Releases: push a `v*` tag — the release workflow re-runs the full test suite,
checks that the version is unpublished, packs and validates desktop bundles on
macOS/Windows, and smoke-tests the Docker image before publication. The publish
job uses those tested artifacts. Existing releases and registry versions cannot
be overwritten; use a new version for a new release.

## Roadmap

See [TODO.md](TODO.md). Near-term: submit to the Anthropic extension directory
and sign the bundle with a production code-signing cert.

## How to cite

Machine-readable metadata lives in [CITATION.cff](CITATION.cff) — GitHub's
**Cite this repository** button (sidebar) renders it as APA or BibTeX with the
current version filled in. In text:

> Madore, F. (2026). *IWAC MCP Server* (Version 5.0.0) [Computer software].
> Zenodo. https://doi.org/10.5281/zenodo.21805837

```bibtex
@software{madore_iwac_mcp_server,
  author    = {Madore, Frédérick},
  title     = {{IWAC MCP Server}},
  year      = {2026},
  version   = {5.0.0},
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
