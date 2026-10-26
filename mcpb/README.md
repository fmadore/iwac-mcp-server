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

On first use the server downloads ~265 MB of parquet data from Hugging Face
into `~/.iwac-mcp/cache/` (override via the extension settings). Subsequent
queries are served locally through DuckDB. Online starts compare the Hub's LFS,
Xet, or Git content identity with a small cache sidecar, so a same-sized dataset
republish is refreshed; existing caches are verified once by SHA-256 when possible.

- No tool needs an API key: keyword search, filtering, statistics, coverage
  timelines and item details work from the cached data.
- The **4 semantic-search tools** run the corpus's own embedding model on your
  machine (see [Semantic search](#semantic-search)). The first semantic search
  downloads it once (~350 MB); turn **Semantic search** off in the extension
  settings to skip that.

## Develop / rebuild the bundle

```bash
cd mcpb
npm install
npm run install-bindings                    # fetch the 4 macOS/Windows binaries
npm run typecheck                           # tsc --noEmit (type safety)
npm run lint                                # biome (linter only, no formatting)
npm run build                               # esbuild -> server/index.js (single file)
npm test                                    # unit + fixture + app + skills + HTTP round-trips + token budget
npm run test:live                           # full smoke test against the real dataset
npm run test:tokens -- --update             # re-baseline the token budget after an intended change
```

`npm test` is hermetic: `test/unit.test.ts` covers the pure helpers,
`test/fixture-server.test.mjs` spawns the built server over stdio against
synthetic parquet fixtures (`scripts/make-fixtures.mjs`) with `IWAC_OFFLINE=1`,
`test/http-server.test.mjs` does the same over the `--http` transport
(bearer auth, /health, body cap, a real Streamable-HTTP MCP call),
`test/skills.test.mjs` reads every skill file back through the SDK's
`SkillsClient` (which verifies each digest) and compares it byte-for-byte
against the file on disk, and
`test/token-budget.test.mjs` gates what the server costs a model — no network,
runs in seconds. `npm run test:live` (smoke-test.mjs) exercises every tool
against the real Hugging Face dataset; its pinned counts double as a
dataset-drift alarm and run weekly in CI.

### Token budget

Two things are measured, in `o200k_base` tokens — not Claude's tokenizer, since
none is published, but the one the public MCP benchmarks use and close enough on
French prose for a gate about *movement*:

* **Always-on footprint**: the 39 default tool definitions (semantic search is on
  by default) plus the instructions block, which every client loads before the
  user has typed anything: **~16.0k tokens** today (15,968, of which the
  instructions are 827; zod's implicit safe-integer bounds are stripped from every
  integer field, ~20 tokens each). Compared
  against `test/token-baseline.json` on every PR; more than 5% growth fails, and
  clearing it means either trimming the schemas or re-baselining with
  `--update` in the same commit, where a reviewer can see the cost. A hard
  ceiling of 16k catches step changes the percentage would let through; the
  footprint now sits 32 tokens under it, so any new tool or longer description
  has to be paid for by trimming elsewhere.
* **Worst-case responses** — every tool called with the largest arguments it
  will honour, against inflated fixtures (`scripts/make-stress-fixtures.mjs`:
  the ordinary fixtures re-read with ≥130 rows per subset and text padded to the
  lengths the real corpus carries). The ceiling is 20k tokens, under the 25k cap
  Claude Code enforces on a tool result — past which the caller receives nothing
  at all, on exactly the query that was worth asking for 100 rows. Adding a tool
  without a `WORST_CASE` entry fails the test.

The aggregate tools are the gap this cannot close: their response size follows
the corpus's cardinality (distinct months, subjects, places), which no synthetic
fixture reproduces. The same 20k ceiling is therefore also applied in
`smoke-test.mjs`, which runs weekly against the live dataset and prints the
heaviest responses it saw.

Pack the per-OS server bundles (one `.mcpb` per OS, each with only that OS's
DuckDB binaries):

```bash
npm run release        # install-bindings + pack-platforms + pack-skill + make-server-json
# or rebuild and package only the desktop bundles:
npm run pack-platforms # -> iwac-mcp-server-windows.mcpb + iwac-mcp-server-macos.mcpb
```

`npm run pack-platforms` automatically cleans, typechecks, and rebuilds the server
before packaging. The build rejects differing package and manifest versions.
Run it again after changing versions or source; existing local archives are not
updated by the tag-triggered GitHub release workflow.

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
version and tag again; the workflow rejects existing versions before the
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
| `IWAC_CACHE_DIR` | `~/.iwac-mcp/cache` (`/cache` in Docker) | Where parquet data is cached (~265 MB public data, plus ~330 MB once semantic search fetches its model) |
| `IWAC_OFFLINE` | `false` | Trust the cache as-is; never touch the network |
| `IWAC_DATASET_REVISION` | `main` | Dataset revision; use an immutable Hub commit SHA for reproducible studies |
| `IWAC_EMBEDDING_PROVIDER` | `onnx` | `onnx` runs the query encoder in-process; `local` posts queries to an OpenAI-compatible endpoint serving the same model. `gemini` is refused (retired in v4.0.0) |
| `IWAC_EMBEDDING_DTYPE` | `q8` | In-process encoder weights: `q8` (314 MB) or `fp32` (1.08 GB, the exact graph the corpus was built with) |
| `IWAC_EMBEDDING_THREADS` | `1` | CPU threads per query encoding. More buy little: on q8, 2 threads cut latency by about a quarter for 1.5 times the CPU, 4 threads for 2 to 3 times |
| `IWAC_EMBEDDING_CONTRACT_FILE` | — | JSON declaration of another corpus's model, fields and pinned dataset revision (see [docs/research-workbench.md](../docs/research-workbench.md#embedding-contract)) |
| `IWAC_LOCAL_EMBEDDING_URL` | `http://127.0.0.1:8080/v1/embeddings` | `local` provider: the OpenAI-compatible embeddings endpoint |
| `IWAC_LOCAL_EMBEDDING_API_KEY` | — | `local` provider: optional bearer credential for that endpoint |
| `IWAC_REFRESH_HOURS` | `24` | Hours before a loaded subset is re-checked against Hugging Face. The check runs in the background on the next call that touches the subset, and a newer revision is swapped in without a restart. `0` disables it |
| `IWAC_SEMANTIC_SEARCH_ENABLED` | `true` | Register the four `semantic_search_*` tools. In HTTP mode the encoder is fetched at start-up |
| `IWAC_EMBEDDING_MODEL` | — | Optional assertion: semantic search refuses to run if it differs from the corpus model (`google/embeddinggemma-2`) |
| `IWAC_EMBEDDING_DIMENSIONALITY` | — | Optional assertion, as above, for the vector dimension (768) |
| `PORT` | `8000` | HTTP mode only: listen port |
| `IWAC_MCP_BEARER_TOKEN` | — | HTTP mode only: the bearer token clients must send |
| `IWAC_MCP_TOKEN_FILE` | `/run/secrets/iwac_mcp_token` | HTTP mode only: read the token from a mounted secret file instead |
| `IWAC_MCP_ALLOWED_ORIGINS` | — | HTTP mode only: comma-separated exact HTTP(S) origins permitted when a request carries `Origin`; origin-less server clients remain allowed |
| `IWAC_PRIVATE_DATASET` | `false` | Read the private full mirror instead of the public dataset (needs `IWAC_HF_TOKEN` or `HF_TOKEN`) |
| `IWAC_ALLOW_PRIVATE_HTTP` | `false` | HTTP mode only: permit serving the private mirror; without it, HTTP mode refuses to start in private mode |

## Layout

| Path                         | Purpose                                         |
| ---------------------------- | ----------------------------------------------- |
| `manifest.json`              | MCPB manifest (version, tools, user_config)     |
| `src/`                       | TypeScript sources, split into `tools/` modules |
| `src/http.ts`                | Remote Streamable-HTTP transport (`--http`)     |
| `server/index.js`            | Single esbuild bundle (server + MCP SDK + zod)  |
| `node_modules/`              | Runtime externals: `@duckdb/*` + `onnxruntime-node` |
| `Dockerfile`                 | GHCR image for the remote HTTP deployment       |
| `biome.json`                 | Lint configuration (`npm run lint`)             |
| `src/viewContract.ts`        | The one constant shared by the server and app bundles |
| `scripts/bundle.mjs`         | esbuild config (single-file bundle)             |
| `scripts/collect-skills.mjs` | Collect `.agents/skills/` for the SDK's Skills extension |
| `scripts/duckdb-bindings.mjs`| Shared helper: fetch/extract platform bindings  |
| `scripts/install-duckdb-bindings.mjs` | Fetch the 4 macOS/Windows bindings     |
| `scripts/pack-platforms.mjs` | Build one `.mcpb` per OS (Windows, macOS) from a staged runtime-only tree, then unpack and verify it |
| `scripts/make-fixtures.mjs`  | Generate synthetic parquet test fixtures        |
| `scripts/make-stress-fixtures.mjs` | Inflate those fixtures for the token budget |
| `scripts/make-server-json.mjs` | Generate `server.json` for the MCP Registry   |
| `test/`                      | Unit tests + offline fixture/HTTP MCP tests     |
| `test/token-baseline.json`   | Committed always-on token footprint baseline    |
| `smoke-test.mjs`             | Live MCP round-trip test (real dataset)         |
| `.mcpbignore`                | Files excluded by `npm run pack-mcpb` (the release packer stages its own tree) |

## How the server works

- Data: parquet files from `https://huggingface.co/datasets/fmadore/islam-west-africa-collection`
  are lazily downloaded per subset (articles, publications, documents,
  audiovisual, images, index, references) and registered as DuckDB views over the local cache.
- Full-text coverage: this is the **public** projection of the dataset, which
  masks OCR per row by `OCR_is_public` (~45% of articles, ~86% of publications
  carry full text at the October 2026 revision). Titles, subjects and AI
  abstracts are present for every article, but sentiment scoring lags
  ingestion: the newest ~4,400 articles carry no sentiment yet. Nothing is
  invisible, but a keyword count is a floor rather than a census.
  `get_collection_stats` reports the live ratio as `fulltext_coverage`, and the
  handshake instructions tell clients to disclose it.
- Queries: all tools use parameterised SQL against DuckDB. The query layer
  probes each subset's column list at view-creation time so fields that are
  missing from the current dataset revision (e.g. `sentiment_label`) are silently
  dropped rather than raising.
- Columns: every projection is generated from one per-subset descriptor
  (`SUBSET_FIELDS` in `src/tools/_shared.ts`). Each column is declared once — SQL
  expression, output alias, schema dependencies — and tagged with the *views* it
  belongs to (`detail`, `fetch`, `summary`, and a few tool-specific ones), plus
  `searchable` for the keyword-search surface. `colsFor(subset, schema, view)`
  builds the SELECT list; `TEXT_COLS` and `TITLE_COL` are derived from the same
  table, so a dataset column rename is a one-line change.
- Column types: the IWAC pipeline conforms every push to declared types.
  Counts, ids, pages and dates (`nb_pages`, `nb_mots`, `hijri_*`, `pub_year`,
  `lda_topic_id`, `frequency`, `duration_seconds`) are nullable `int64`, which
  DuckDB reads as `BIGINT` and hands to JS as a **`bigint`**, not a `number`.
  Embeddings are `list<float32>` (`FLOAT[]`), which arrive as a plain
  `number[]`. Revisions published before the canonical types stored several of
  those integers as `float64` (`DOUBLE`) and the embeddings as `list<float64>`,
  and a subset keeps the old types until its next push, so a revision can mix
  both. Code must therefore work with either: `Number()` a value before any JS
  arithmetic (mixing a `bigint` with a `number` throws), cast in SQL where a
  value becomes text (`hijriPart`: on `DOUBLE`, `CAST(3.0 AS VARCHAR)` is
  `'3.0'`), and let `compactValue` turn a `bigint` into a number on output. The
  fixtures carry both types on purpose (`HIJRI_LEGACY_DOUBLE` in
  `scripts/make-fixtures.mjs`). `consensus_subjectivite_score` stays a float:
  it is a median rank, and `.5` values are real.
- Two-phase `search`: full-text columns carry a `heavy` tag in the descriptor,
  because one accent-folded `LIKE` over `publications.OCR` costs ~1.8 s and over
  `articles.OCR` ~0.46 s, against ~30 ms for every curated column combined. The
  unified `search` therefore matches `FAST_TEXT_COLS` first and only runs the
  OCR scan when that under-fills the page — 3.1 s → 0.20 s for a common term,
  with the deep pass (and identical recall) still there for a rare one. The
  response says which happened in `deep_scan`, and `ranking` describes both
  passes. The per-subset `search_*` tools deliberately keep scanning everything:
  their callers explicitly asked for a full-text search.
- MCP Apps: fourteen tools declare `_meta.ui.resourceUri` (`src/tools/appUi.ts`),
  so hosts that support the
  [MCP Apps extension](https://modelcontextprotocol.io/extensions/apps/overview)
  — Claude and Claude Desktop — render their results as interactive charts in a
  sandboxed iframe instead of a wall of JSON, and the charts can call tools back
  to change granularity, grouping or drill-down. `_meta` is inert elsewhere:
  every other client gets byte-identical content and structuredContent, which is
  why this needed no second tool and no capability negotiation.

  All of them point at **one** resource, `ui://iwac/charts.html`. Each `ui://`
  resource is a standalone document that shares nothing with its siblings, so a
  resource per chart would carry its own ~190 kb copy of the MCP SDK and zod for
  a ~4 kb chart; pointing them all at one URI costs a single copy. The app
  dispatches on a `view` tag in the payload (`ontoolresult` gives it a bare
  CallToolResult with no tool name, and the app also makes its own follow-up
  calls, where no host notification exists at all). `src/app/` is split into a
  theme, an SVG kernel of hand-rolled primitives — no charting library survives
  the deny-by-default CSP — a page shell, and one pure function per view;
  `scripts/bundle.mjs` inlines the whole thing into one self-contained HTML
  string, because the `.mcpb` package expects a single-file server. The palette
  mirrors the [IwacVisualizations](https://github.com/fmadore/IwacVisualizations)
  Omeka module's sanctioned chart tokens, so the same breakdown is coloured the
  same way here as on islam.zmo.de.

  Supporting hosts also offer **Fullscreen / Exit fullscreen** and **Ask about
  this selection**. Fullscreen follows the host's granted display mode and
  gives tables and source readers more vertical space. The Ask button sends a
  question with the selection visible when clicked; it never sends messages
  automatically. Downloads, source links and messages show host refusal as an
  error, so a rejected operation cannot appear successful.

  When a host accepts model context updates, successful navigation, Back and
  local view options share a compact snapshot: filters, visible source IDs,
  selected comparisons, dataset provenance and caveats. The snapshot excludes
  source text, chart coordinates and export contents, has an explicit size
  bound, and replaces the previous selection. Updates are serialized and
  coalesced; failed or stale tool responses cannot replace the current
  selection. Theme and display changes do not resend identical context. Text
  and structured content are negotiated independently. A small status below
  the chart shows whether automatic sharing succeeded. The Ask message includes
  its own snapshot even when automatic sharing is unavailable.

  `scripts/make-basemap.mjs` regenerates `src/app/basemap.ts`, the simplified
  Natural Earth outline the place map draws on — vendored rather than fetched
  because the CSP forbids tiles and runtime GeoJSON alike.

  `test/app.test.mjs` reads the resource out of the BUILT server exactly as a
  host would, evaluates the bundle in a Node vm behind a DOM shim, and drives
  the real postMessage handshake, so the payload shapes, the CSP rules, the size
  budget and the interactive round trip are all covered without a browser.
  The plan this grew from is [`../docs/mcp-apps-roadmap.md`](../docs/mcp-apps-roadmap.md).
- Model/view payload split: a chart's data and a model's data are not the same
  data. MCP Apps hands the view the whole `CallToolResult`, `_meta` included,
  while the model reads only `content` and `structuredContent`, so data a chart
  needs but a model cannot use can ride in `_meta` instead of being billed to
  every conversation. `viewResult()` in `src/tools/_shared.ts` performs the
  split under the key in `src/viewContract.ts` (the only module both bundles
  import); `readPayload()` in `src/app/charts.ts` merges it back, so no view
  knows the difference. Measured on the real dataset,
  `get_semantic_map(color_by="country")` went from **13,490 to 172 tokens** and
  `get_topic_distribution(over_time, top_n=15)` from 5,983 to 2,218.

  The rule is that only data which is *redundant for reasoning* may move: a host
  without MCP Apps draws no chart, so anything in `_meta` is invisible to that
  user, and moving the answer there would be a silent regression rather than an
  optimisation. The model therefore gains a summary computed from what it lost
  (`trend_by_topic`, `groups`), and `test/fixture-server.test.mjs` asserts the
  summary matches the series it replaced. This is also why only two tools do it:
  `get_temporal_distribution` spends 99% of its payload on `distribution` and
  `get_field_distribution` 79% on `values`, but there the dense field *is* the
  answer. See [`../docs/mcp-apps-roadmap.md`](../docs/mcp-apps-roadmap.md) §2.4.
- Skills over MCP: `scripts/collect-skills.mjs` embeds `../.agents/skills/`
  at build time as a `{ path: text }` record plus a title, summary and MIME type
  per file. `src/tools/skills.ts` builds the entries with the SDK's
  `SkillsExtension.load(memorySkillFiles(...))`, which computes sizes and
  digests and checks frontmatter and limits, then serves them through a small
  `SkillSource` attached to every server the factory builds. The SDK serves
  `skills/list`, `skills/get`, `resources/directory/read` and the
  `skill://{+path}` template, and declares the capability (`directoryRead`
  included). The source exists for one reason: the SDK's own catalogue lists one
  `resources/list` entry per skill, and hosts without the extension find the
  reference files there. The bundler loads the same record under `strict`, so
  missing, empty or invalid skill sources fail the build. `attach()` is
  experimental, so the SDK is pinned to its minor (`~2.4.0`) and
  `test/skills.test.mjs` covers the contract through `SkillsClient`. Rebuild
  after changing skill sources. Docker builds use
  the repository root as context so the same skill ships on both transports.
- Prompts: `iwac_research` (brief/extended) and `iwac_overview` in
  `src/prompts.ts` carry the skill's workflow to clients that cannot install the
  skill (ChatGPT via the remote connector). They mirror
  `.agents/skills/iwac-mcp/SKILL.md` — update both together, as with the
  `INSTRUCTIONS` block.
- Semantic search: see [Semantic search](#semantic-search) below.

## Semantic search

Since dataset revision `d834ab71` (2026-10-13) every vector column in IWAC is
[EmbeddingGemma 2](https://huggingface.co/google/embeddinggemma-2), computed by
the [IWAC-Hugging-Face](https://github.com/fmadore/IWAC-Hugging-Face) pipeline
from the pinned fp32 ONNX export `onnx-community/embeddinggemma-2-ONNX@daa72c51`:

| Subset | Column | Embedded text | Used by |
| --- | --- | --- | --- |
| articles | `embedding_OCR` | title + full text (also for articles whose OCR is not public) | `semantic_search_articles`, `get_similar_items`, `get_semantic_map` |
| documents | `embedding_OCR` | title + full text | `get_similar_items`, `get_semantic_map` |
| publications | `embedding_tableOfContents` | title + table of contents (~40% of issues) | `semantic_search_publications`, `get_similar_items`, `get_semantic_map` |
| references | `embedding_abstract` | title + abstract (~half of references) | `semantic_search_references`, `get_similar_items`, `get_semantic_map` |
| images | `embedding_image` | the photograph itself | `semantic_search_images` |

A `semantic_search_*` call loads the column into a normalised `Float32Array`,
encodes the query, and ranks by dot product in-process. The query encoder is
the same export, run with `onnxruntime-node` and the model's own tokenizer
(`src/onnxEncoder.ts`): no API key, and query text never leaves the machine.
Its weights are fetched from the Hub on first use into
`<IWAC_CACHE_DIR>/models/` and checked against pinned sizes and SHA-256
digests; `q8` (314 MB) is the default, `fp32` (1.08 GB) is exact. Images are
never encoded at query time: `embedding_image` lives in the same 768-dim space
as the text vectors, so a text query finds photographs cross-modally.

**Mixing vector spaces is refused, not trusted.** Names cannot prove that two
vectors share a space, so `src/embeddingContract.ts` checks the vectors:

- **The encoder** must reproduce the Python reference vector of a probe query
  (cosine >= 0.999) before its first ranking. That catches a different model
  behind a `local` endpoint, tokenizer or runtime drift, and a dtype too coarse.
- **Each column** must agree with anchors: stored items whose cosine to the
  probe was measured when the contract was made. A strict majority must match
  within 0.001, so a corpus re-embedded with another model, or an older
  revision pinned with `IWAC_DATASET_REVISION`, fails closed while one edited
  anchor does not.

`scripts/make-embedding-reference.py` regenerates the probe, anchors and the
parity fixture from the Python reference; `npm run test:parity` checks that the
Node encoder tokenizes identically and reaches cosine >= 0.999 on 14 queries
(q8 measures 0.99994; add fp32 with `IWAC_PARITY_DTYPES=q8,fp32`).

**Load on the server.** The encoder runs in a worker thread, because
onnxruntime-node executes `session.run` synchronously on the calling thread.
On the main thread every encoding froze all other requests for its duration
(~0.5 s); in the worker, MCP pings sent during a warm semantic search answer in
under 10 ms. The worker uses one CPU thread by default (`IWAC_EMBEDDING_THREADS`)
and its thread pool sleeps between queries instead of spin-waiting. A column's
index is read from DuckDB one chunk at a time and normalised with regular
yields, so the first search of a subset (about 7 s for the 16,668 articles on
the development laptop) delays concurrent requests by about 0.1 s at most.
Measured with `--max-old-space-size=512`: about 75 MB resident idle, under
800 MB at peak with the encoder and all four semantic indexes loaded.

Platforms: Windows x64/ARM64 (with the Microsoft Visual C++ 2015-2022
Redistributable), Apple-silicon macOS and Linux. onnxruntime-node ships no
Intel-macOS build, so there the semantic tools report that they cannot run;
`get_similar_items` and `get_semantic_map` work everywhere, since they compare
stored vectors only.

Scores: cosines in this space run high. The median article's nearest neighbour
scores 0.906 and unrelated articles ~0.7. Upstream calibration puts likely
near-duplicates at **0.97** (94% lexically confirmed on held-out pairs) and the
reprint-screen prefilter at 0.91; thresholds from the earlier Gemini space do
not transfer.

Published neighbours: the dataset stores each article's and document's ten
nearest neighbours as `related_articles`, the list islam.zmo.de's "Similar
articles" panels show. `get_similar_items` returns that list first, in its
stored order and with its stored scores, so the server and the site agree by
construction rather than up to float noise on four-decimal ties. Beyond ten
(the default `limit` is 12) it continues with live-ranked neighbours, skipping
the listed ones, and reports the seam as `stored_count`. Publications,
references, a revision without the column and an item whose cell is empty are
ranked live. `neighbours_source` (`related_articles`, `related_articles+live`
or `live`) says which ranking a result came from.

## Why Node rather than Python

Anthropic's MCPB guidance recommends Node because Claude Desktop ships with a
bundled Node runtime, which means zero installation friction for end users.

`npm run build` bundles the server, the MCP SDK, and zod into a single
`server/index.js` with [esbuild](scripts/bundle.mjs). The native `@duckdb/*`
bindings and `onnxruntime-node` (the semantic-search query encoder) stay
external because neither native addon can be inlined, so those two trees are
the only runtime `node_modules` the packed bundle relies on. The model's
tokenizer (`@huggingface/tokenizers`) is pure JavaScript and is inlined.

## Optional private full-text access

Public data remains the default and needs no token. In the desktop extension,
enable **Use private full dataset**, enter the **Hugging Face token (private dataset only)**,
and restart. Use a fine-grained token with read access to
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

## Research workbench and operational changes

See [the workbench guide](../docs/research-workbench.md) for selection semantics,
normalized denominators, provenance exports, local embeddings and offline scripts.
Successful responses include a separate provenance content block and `_meta` entry;
the first content block and existing structured payload remain compatible.

Requests pin their loaded files across subqueries. Old immutable generations are
retained for other processes and older snapshots. Disk use can grow after refresh;
stop all users of the cache before archival/cleanup. Incomplete manifests recover
only from a complete backup, never from a glob of mixed generations. Writers hold
`.iwac-write-lock`; confirm its owner has stopped before clearing a crash leftover.

Authenticated `GET /metrics` exposes active/queued database work and a bounded
p50/p95 tool-latency window. `/health` remains unauthenticated. Query and projection
queues have limits, deadlines and cancellation; PCA executes in worker threads.

## October 2026 compatibility and build notes

Since v3.7.0 the server requires Node.js >=24.0.0 (build, Docker and desktop
runtime); the old Node 20 compatibility claim was dropped because that release
is end of life. Update desktop hosts carrying older embedded Node versions before
upgrading. The runtime-floor CI job tests the exact declared minimum.

MCP Apps 2 and Zod 4.6 retain their full protocol schemas. To stay within the 300 KB
resource budget, the self-contained UI carries gzip/base64 JavaScript decoded by
`DecompressionStream` and inserted as inline script under the host's existing
inline-script CSP. No eval, remote script, blob URL or network request is needed.
A visible loading failure is shown if decompression is unavailable. Tests measure
both resource bytes and decoded JavaScript (500 KB ceiling), and the Chromium
smoke executes the actual bootstrap.

Build the container from the repository root:

```sh
docker build -f mcpb/Dockerfile -t iwac-mcp-server .
```

The Debian/glibc runtime matches DuckDB's native Linux binary. The build context
must include `.agents/skills`; absent skill content fails packaging. Releases
validate the exact desktop archives on native macOS/Windows runners and execute
fixture SQL plus authenticated skill reads in the image before publication.
Existing GitHub or Registry versions are rejected before publication. A failed
partial release requires controlled recovery using its original verified bytes
or a new version; reruns never replace already uploaded release assets.
