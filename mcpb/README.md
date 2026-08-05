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
queries are served locally through DuckDB. Online starts compare the Hub's LFS,
Xet, or Git content identity with a small cache sidecar, so a same-sized dataset
republish is refreshed; existing caches are verified once by SHA-256 when possible.

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
npm test                                    # unit + offline fixture + HTTP round-trips + token budget
npm run test:live                           # full smoke test against the real dataset
npm run test:tokens -- --update             # re-baseline the token budget after an intended change
```

> **Windows on ARM:** `npm run lint` dies with an access violation
> (`0xC0000005`; exit 139 under Git Bash) on `win32-arm64`. It is a Biome
> platform-binary regression, not a config problem: it reproduces on a two-line
> file with no config at all, while `biome --version` and `biome rage` still
> work. Bisected to **2.5.2** — 2.4.16, 2.5.0 and 2.5.1 are fine, every release
> from 2.5.2 to 2.5.7 crashes. Reported upstream as
> [biomejs/biome#11242](https://github.com/biomejs/biome/issues/11242).
> CI lints on `ubuntu-latest` and is unaffected. To lint locally before a commit,
> run the x64 binary under emulation — keep the version in step with
> `package.json`:
>
> ```bash
> npm i --no-save --force --cpu=x64 --os=win32 --prefix /tmp/biome-x64 @biomejs/cli-win32-x64@2.5.6
> /tmp/biome-x64/node_modules/@biomejs/cli-win32-x64/biome.exe lint .
> ```

`npm test` is hermetic: `test/unit.test.ts` covers the pure helpers,
`test/fixture-server.test.mjs` spawns the built server over stdio against
synthetic parquet fixtures (`scripts/make-fixtures.mjs`) with `IWAC_OFFLINE=1`,
`test/http-server.test.mjs` does the same over the `--http` transport
(bearer auth, /health, body cap, a real Streamable-HTTP MCP call), and
`test/token-budget.test.mjs` gates what the server costs a model — no network,
runs in seconds. `npm run test:live` (smoke-test.mjs) exercises every tool
against the real Hugging Face dataset; its pinned counts double as a
dataset-drift alarm and run weekly in CI.

### Token budget

Two things are measured, in `o200k_base` tokens — not Claude's tokenizer, since
none is published, but the one the public MCP benchmarks use and close enough on
French prose for a gate about *movement*:

* **Always-on footprint** — the 34 tool definitions plus the instructions block,
  which every client loads before the user has typed anything: **~14.1k tokens**
  today (`inputSchema` 5.5k, `outputSchema` 2.4k, descriptions 2.7k). Compared
  against `test/token-baseline.json` on every PR; more than 5% growth fails, and
  clearing it means either trimming the schemas or re-baselining with
  `--update` in the same commit, where a reviewer can see the cost. A hard
  ceiling of 16k catches step changes the percentage would let through.
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
| `IWAC_SEMANTIC_SEARCH_ENABLED` | `false` | Register the three `semantic_search_*` tools |
| `IWAC_GOOGLE_API_KEY` (or `GOOGLE_API_KEY` / `GEMINI_API_KEY`) | — | Gemini key for semantic search |
| `IWAC_EMBEDDING_MODEL` | `gemini-embedding-2` | Query-embedding model (must match the dataset's) |
| `IWAC_EMBEDDING_DIMENSIONALITY` | `768` | Query-embedding dimensionality |
| `PORT` | `8000` | HTTP mode only: listen port |
| `IWAC_MCP_BEARER_TOKEN` | — | HTTP mode only: the bearer token clients must send |
| `IWAC_MCP_TOKEN_FILE` | `/run/secrets/iwac_mcp_token` | HTTP mode only: read the token from a mounted secret file instead |
| `IWAC_MCP_ALLOWED_ORIGINS` | — | HTTP mode only: comma-separated exact HTTP(S) origins permitted when a request carries `Origin`; origin-less server clients remain allowed |

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
| `scripts/make-stress-fixtures.mjs` | Inflate those fixtures for the token budget |
| `scripts/make-server-json.mjs` | Generate `server.json` for the MCP Registry   |
| `test/`                      | Unit tests + offline fixture/HTTP MCP tests     |
| `test/token-baseline.json`   | Committed always-on token footprint baseline    |
| `smoke-test.mjs`             | Live MCP round-trip test (real dataset)         |
| `.mcpbignore`                | Files excluded from the `.mcpb` archive         |

## How the server works

- Data: parquet files from `https://huggingface.co/datasets/fmadore/islam-west-africa-collection`
  are lazily downloaded per subset (articles, publications, documents,
  audiovisual, images, index, references) and registered as DuckDB views over the local cache.
- Full-text coverage: this is the **public** projection of the dataset, which
  masks OCR per row by `OCR_is_public` (~61% of articles, ~86% of publications).
  Titles, subjects and AI abstracts are present for every item, so nothing is
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
- Two-phase `search`: full-text columns carry a `heavy` tag in the descriptor,
  because one accent-folded `LIKE` over `publications.OCR` costs ~1.8 s and over
  `articles.OCR` ~0.46 s, against ~30 ms for every curated column combined. The
  unified `search` therefore matches `FAST_TEXT_COLS` first and only runs the
  OCR scan when that under-fills the page — 3.1 s → 0.20 s for a common term,
  with the deep pass (and identical recall) still there for a rare one. The
  response says which happened in `deep_scan`, and `ranking` describes both
  passes. The per-subset `search_*` tools deliberately keep scanning everything:
  their callers explicitly asked for a full-text search.
- MCP Apps: eleven tools declare `_meta.ui.resourceUri` (`src/tools/appUi.ts`),
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

  `scripts/make-basemap.mjs` regenerates `src/app/basemap.ts`, the simplified
  Natural Earth outline the place map draws on — vendored rather than fetched
  because the CSP forbids tiles and runtime GeoJSON alike.

  `test/app.test.mjs` reads the resource out of the BUILT server exactly as a
  host would, evaluates the bundle in a Node vm behind a DOM shim, and drives
  the real postMessage handshake, so the payload shapes, the CSP rules, the size
  budget and the interactive round trip are all covered without a browser.
  The plan this grew from is [`../docs/mcp-apps-roadmap.md`](../docs/mcp-apps-roadmap.md).
- Prompts: `iwac_research` (brief/extended) and `iwac_overview` in
  `src/prompts.ts` carry the skill's workflow to clients that cannot install the
  skill (ChatGPT via the remote connector). They mirror
  `.agents/skills/iwac-mcp/SKILL.md` — update both together, as with the
  `INSTRUCTIONS` block.
- Semantic search: loads the `embedding_OCR` / `embedding_tableOfContents` /
  `embedding_image` column into a normalised `Float32Array`, encodes the query
  via Gemini, then does a dot-product top-k in-process. `embedding_image` is
  multimodal — the photograph itself lives in the same 768-dim space as the text
  vectors, so `semantic_search_images` answers a text query cross-modally, which
  is the only real handle on a subset where 28 of 30 items have no caption.

## Why Node rather than Python

Anthropic's MCPB guidance recommends Node because Claude Desktop ships with a
bundled Node runtime, which means zero installation friction for end users.

`npm run build` bundles the server, the MCP SDK, and zod into a single
`server/index.js` with [esbuild](scripts/bundle.mjs). The native `@duckdb/*`
bindings and the optional `@google/genai` client stay external (the former can't
be inlined; the latter is only needed when semantic search is enabled), so those
two trees are the only runtime `node_modules` the packed bundle relies on.
