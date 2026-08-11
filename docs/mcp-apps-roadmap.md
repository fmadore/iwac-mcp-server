# MCP App visualizations — roadmap

Plan, and now record, for growing the IWAC MCP server's **MCP Apps** surface
from one chart to a visualization suite, taking design cues from the
[IwacVisualizations](https://github.com/fmadore/IwacVisualizations) Omeka S
module without inheriting its architecture.

**Status: Phases 0–3 are implemented.** One chart became twelve, on one shared
resource, and the shipped UI resource is *smaller* than the single chart it
replaced. §8 records what changed against the plan and what is deliberately
still not done.

Companion documents: [`../mcpb/README.md`](../mcpb/README.md) (server
architecture), [`../TODO.md`](../TODO.md) (everything else), and the
module's own `ROADMAP.md` for the Omeka side.

Every number in the "Constraints" and "Data inventory" sections below was
measured against the live cached parquet and the real esbuild bundle, not
estimated. Figures corrected during implementation are marked.

---

## 1. Where we started

One app shipped in v0.12.0: **`ui://iwac/coverage.html`**, declared by
`get_temporal_distribution`.

What it established — and what every later app reuses:

- **Hand-rolled SVG**, no charting library. Stacked bars, thinned ticks, a
  3-value y-axis, `<title>` tooltips, a legend.
- **Bidirectional**: buttons call `app.callServerTool()` and re-render. This is
  the whole reason to ship an app instead of a static image.
- **Palette mirrored** from the module's `asset/js/iwac-theme.js`, so a country
  breakdown is coloured the same in Claude and on islam.zmo.de.
- **Degrades to nothing**: hosts without MCP Apps ignore `_meta` and get
  identical `content` + `structuredContent`.

That contract was good. The problem was that it did not **scale to N apps**.

---

## 2. Constraints that govern every decision

### 2.1 Deny-by-default CSP

MCP App resources render in a sandboxed iframe where **no external script,
stylesheet, font, image, or fetch may load**. Consequences:

- **No CDN charting.** ECharts 6 and `echarts-wordcloud` — the module's entire
  visual vocabulary — are unavailable unless inlined (ECharts is ~1 MB
  minified, per app; see §2.2 for why that is fatal).
- **No map tiles.** MapLibre GL needs tile requests. A map is only possible
  with inlined, simplified GeoJSON and no basemap. (Done: §4, Phase 3.1.)
- **No web fonts.** Public Sans degrades to `system-ui`; already handled.

`test/app.test.mjs` guards this — it fails if the bundled HTML contains any
external `src`/`href`, an `@import`, or an `@font-face`, and it fails if any
rendered view emits an inline event handler.

### 2.2 Bundle economics — the binding constraint

Measured on the original `coverage.ts` bundle:

| Component | Size | Share |
|---|---:|---:|
| zod **locale catalogues** (ar, he, ja, … 50+) | 195.0 kb | 50% |
| zod core + classic | 131.0 kb | 34% |
| MCP SDK protocol layer | 28.2 kb | 7% |
| `@modelcontextprotocol/ext-apps` | 28.7 kb | 7% |
| **the actual chart** | **3.8 kb** | **1%** |
| **Total** | **387.6 kb** | |

Two things followed, and both were acted on:

1. **Half the payload was dead weight.** Hebrew and Japanese zod error-message
   catalogues cannot fire in a chart iframe. Stubbing every non-English locale
   at build time is a ~30-line esbuild plugin. (The filter must be broad,
   `/locales/`, matched against the RESOLVED path, with the `en`/`index`
   exclusion inside the callback; a specifier-based `onResolve` filter silently
   matches nothing.) Applied to the server bundle too, which ships in every
   `.mcpb` and Docker image.
2. **Per-app resources are expensive.** Each `ui://` resource is a standalone
   HTML document; nothing can be shared across them. Eight apps as eight entry
   points would have been **~3.1 MB**. This is the single most important
   architectural fact in this document, and it is why every chart-bearing tool
   points `_meta.ui.resourceUri` at the same `ui://iwac/charts.html`.

Measured outcome:

| | before | after |
|---|---:|---:|
| UI resource (1 chart → 12) | 390.1 kb | **251.4 kb** |
| `server/index.js` | 1665.4 kb | **1191.3 kb** |

### 2.3 The server is a live query engine, not a precompute pipeline

The module precomputes everything in Python against the **private** full mirror
and ships JSON next to the block. This server does the opposite: DuckDB over
public parquet, aggregates computed per request.

| | IwacVisualizations | iwac-mcp-server |
|---|---|---|
| Data path | Precomputed JSON committed to the module | Live DuckDB `SELECT` over cached parquet |
| Heavy layouts | UMAP, ForceAtlas2, near-duplicate pairs — all offline | Only what fits in a request |
| Freshness | Manual regeneration step | Follows the dataset revision automatically |
| Filters | Baked into the precomputed bundle | Arbitrary, at query time |

So: **any aggregate expressible as SQL is cheap here**. Anything needing an
offline layout over the whole corpus is not portable. Implementation narrowed
that line usefully — see §8.

---

## 3. Data inventory

Verified against the cached parquet (2026-07-27). Everything in this table is
now exposed.

| Signal | Coverage | Exposed by |
|---|---|---|
| `lda_topic_id/label/prob/topk` | **12,234 / 12,287** articles, 30 labels, 0 outliers | `get_topic_distribution` |
| `gpt_5_6_luna_*`, `mistral_small_2603_*`, `deepseek_v4_flash_0731_*` sentiment | **12,305 / 12,356** on polarity and centrality for all three (the ~51 non-francophone articles are unscored by design); subjectivity is thinner still — deepseek 11,816 | `get_sentiment_distribution(model=…)` |
| `Lisibilite_OCR`, `Richesse_Lexicale_OCR`, `nb_mots` | 12,286 | `get_lexical_metrics` |
| `author` (articles) | 9,664 signed, **2,463** distinct values | `get_field_distribution(field=author)` |
| `subject` (articles) | 10,580 tagged, avg ~7/article | `get_field_distribution`, `get_cooccurrence` |
| `spatial` (articles) | 10,634 (87%), 766 distinct | `get_field_distribution`, `get_place_distribution` |
| `index.Coordonnées` | **555 / 683 Lieux** geocoded (81%); 0 for persons/orgs | `get_place_distribution` |
| `embedding_OCR` / `_tableOfContents` | articles 12,286 · refs 423 · publications 473 (31%) | `get_semantic_map`, `get_similar_items` |
| Periodical runs | 25 periodicals | `list_periodicals` |
| Per-country counts + polarity | 5 countries | `get_country_comparison` |

Two gaps still worth stating: **publications embeddings cover only 31%** of
rows, so a publications scatter is sparse by construction; and **only `Lieux`
carry coordinates**, so a map can plot places but never persons or
organisations.

---

## 4. What shipped

### Phase 0 — Foundations ✅

| # | Item | Outcome |
|---|---|---|
| 0.1 | Stub non-English zod locales | 390.1 → 198.9 kb (UI), 1665.4 → 1191.3 kb (server). Applied to both bundles. |
| 0.2 | One shared UI resource | `ui://iwac/charts.html`, dispatched on a `view` tag in the payload. |
| 0.3 | An SVG chart kernel | `src/app/svg.ts`: `bar`, `stackedBar`, `columns` (grouped), `horizontalBar`, `gantt`, `donut`, `treemap` (squarified), `heatmapMatrix`, `gauge`, `bubbleMap`, `forceGraph`, `scatter`, `legend`. |
| 0.4 | Extend the app test layer | `test/app.test.mjs` boots the real bundle in a Node vm behind a DOM shim and drives the actual postMessage handshake. |

**Decision taken on the §6 open question:** one shared kernel, as recommended.
The monolith risk is answered by structure rather than by more resources —
`src/app/views/*.ts` are pure functions of a payload, and `charts.ts` is the
only module that knows more than one chart exists.

### Phase 1 — Free wins ✅ (no new server tools)

| # | App | Data source |
|---|---|---|
| 1.1 | **Periodical runs gantt** — thickness = issue count | `list_periodicals` |
| 1.2 | **Country comparison** — ranked volume + 100%-stacked polarity mix | `get_country_comparison` |
| 1.3 | **Newspaper ranking** — top 25, remainder disclosed | `get_newspaper_stats` |
| 1.4 | **Sentiment donuts** — polarity / centrality / subjectivity | `get_sentiment_distribution` |
| 1.5 | **Collection summary** — subset treemap + full-text gauges | `get_collection_stats` |
| 1.6 | **Coverage chart upgrades** — `group_by` cycle, CSV export | `get_temporal_distribution` |

### Phase 2 — New aggregate tools ✅

| # | Tool | Notes |
|---|---|---|
| 2.1 | `get_topic_distribution` | Treemap + optional stacked timeline; the residual band keeps the total honest. |
| 2.2 | `get_sentiment_distribution(model)` | `gpt-5-6-luna` \| `mistral-small-2603` \| `deepseek-v4-flash-0731` \| `all` (vendor shorthand resolves; generation-1 ids are refused by name). Three-model unanimity on polarity: **5,305 / 12,305 scored = 43%**. |
| 2.3 | `get_cooccurrence` | Symmetric matrix + strongest pairs; matrix or force-directed network. |
| 2.4 + 2.6 | `get_field_distribution` | **Merged.** See §8. |
| 2.5 | `get_lexical_metrics` | Readability / MATTR / length by year, newspaper or country. |

### Phase 3 — Harder, but reachable ✅

| # | App | Notes |
|---|---|---|
| 3.1 | **Place map** | `get_place_distribution` + a vendored 11.2 kb Natural Earth outline (`scripts/make-basemap.mjs`). Choropleth = where items were published; bubbles = where they look. |
| 3.2 | **Entity network** | In-browser force layout over the top-N co-occurrence values. Deterministic, and tested for actually clustering. |
| 3.3 | **Semantic neighbours** | `get_similar_items` — and it needs **no API key**. See §8. |
| 3.4 | **PCA scatter** | `get_semantic_map`, with the explained-variance share in the headline. Also **no API key**. |

### Explicit non-goals (unchanged)

- **UMAP semantic landscapes** — 2-D coordinates are not in the parquet. Would
  require new HF columns, pipeline work *and* a `public_columns.json` entry.
- **Corpus-wide near-duplicate detection** — an all-pairs comparison, offline by
  nature. `get_similar_items` answers it for one item at a time, which is a
  different and cheaper question.
- **Bar-chart race over 5,000 lemmas** — the module ships per-letter
  precomputed shards; live aggregation per frame is not viable.
- **Tile-based maps** of any kind — CSP.
- **Knowledge graph / topic network** — deliberate non-ports on the module side
  too; not resurrected here.

---

## 5. Cross-repo notes

- **Palette drift**: `src/app/theme.ts` hardcodes the module's resolved theme
  tokens. If `asset/js/iwac-theme.js` changes its palette, this copy goes stale
  silently. Worth a comment on the module side pointing here.
- **The module is still the better home for anything needing precompute.**
- **`OCR_is_public` applies to charts too.** Any keyword-derived count in an app
  inherits the ~61% full-text coverage caveat, and so do the lexical metrics and
  both embedding tools — an item is only embedded if its full text ships. Charts
  built on titles, subjects, AI abstracts, topics or sentiment are unaffected:
  those are complete for all rows. Every view that is affected says so.

---

## 6. Answers to the original open questions

1. **One shared UI resource, or one per chart family?** → **Shared.** Twelve
   charts cost 251.4 kb in total; one chart cost 390.1 kb before. The
   de-monolithing worry is real but is a code-structure problem, solved by pure
   per-view functions rather than by more resources.
2. **How much visual parity with islam.zmo.de is worth paying for?** → Palette
   and data, not interactions, exactly as the instinct in the original draft.
   No dataZoom, no brush, no rich tooltips; native `<title>` throughout.
3. **Should any app be gated off the public HTTP endpoint?** → **No, and the
   premise dissolved.** The two apps assumed to be key-gated are not (§8), and
   they were deliberately implemented without a resident index: `get_similar_items`
   scores in DuckDB, so the public endpoint gains no ~37 MB in-memory matrix.
4. **Do the new aggregate tools earn their token cost?** → Partly. Four named
   tools became two (§8), which is the concrete answer.

---

## 7. What is still open

- **PNG export.** CSV shipped (gated on the host advertising `downloadFile`).
  PNG needs an SVG → canvas round trip through a `data:` URI, and whether that
  survives the host CSP is unverified. Not shipped rather than shipped as a
  button that might silently fail.
- **A wordcloud primitive.** The module leans on `echarts-wordcloud`; a
  hand-rolled spiral placement is feasible but nothing in the suite needs it yet.
- **Bounded-region drill-down on the map.** Clicking a country filters; there is
  no lasso or box select, and adding one means real hit-testing.

---

## 8. Where implementation corrected the plan

Recorded because each of these was a measured finding, not a preference.

1. **`get_field_distribution` replaced two planned tools.** 2.4 (press bylines)
   and 2.6 (place ranking) are the same operation — rank the values of a
   multi-valued column — pointed at `author` and `spatial`. Merging them also
   made subject and language rankings free. The `over_time` option carries 2.4's
   real finding, which is not who tops the list but that the signed *share*
   climbs as the press professionalises.

2. **3.3 and 3.4 need no Gemini key.** The roadmap assumed both were gated
   behind `IWAC_SEMANTIC_SEARCH_ENABLED` and therefore "dark on the public HTTP
   endpoint". That requirement belongs to semantic *search*, which must embed a
   text query at request time. Projecting stored vectors (3.4) and finding what
   is near an existing item (3.3) both read a parquet column and nothing else.
   Both work everywhere the rest of the server works.

3. **The MIME type was stale.** The resource advertised `text/html+mcp`, which
   appears nowhere in `@modelcontextprotocol/ext-apps` 1.7.5 — the current
   constant is `text/html;profile=mcp-app`, and hosts advertise support by
   listing exactly that string. `test/app.test.mjs` now pins the server's copy
   to the SDK constant.

4. **Subjectivity is an integer 1–5 rating, not a 0–1 proportion.** A bare mean
   of 2.12 reads as "21% subjective" to anyone assuming normalisation, so the
   scale ships with the number and the per-level counts come along.

5. **The non-French readability caveat is 9 articles, not ~45.** The ~45
   Ewé/Kabiyè/Dendi figure covers the whole collection; the *articles* subset is
   12,273 Français, 7 Anglais, 2 Dendi. The caveat still applies and is
   implemented — but only to readability. MATTR is a type-token ratio, needs no
   lexicon, and stays valid for every language.

6. **PCA over 768 dimensions explains less than a scatter implies.** Two
   components carry ~18% of the variance for an unfiltered article set and ~25%
   for a keyword-filtered one. That made the explained share a headline rather
   than a footnote, and set the "distances are a weak signal" threshold at 25% —
   deliberately above the common case.

7. **`MATERIALIZED` is load-bearing in the neighbour query.** DuckDB otherwise
   evaluates `list_inner_product` before the `IS NOT NULL` filter, and the one
   article without a vector aborts the whole query. Separately, an unknown id
   made the target subquery NULL, which that function answers with NULL rather
   than an error — so every row scored 0 and the tool returned the entire subset
   as "neighbours" of a nonexistent item. Both are now closed and tested.
