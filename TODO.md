# TODO

> Larger features — remote transport, auth, zero-config semantic search, skill
> portability — are tracked as
> [GitHub issues](https://github.com/fmadore/iwac-mcp-server/issues). This file
> covers smaller items and project ops. Completed work lives in the git history
> (Track 1 plumbing shipped in v0.5.0; the data-alignment + token audit shipped
> in v0.6.0).

## Distribution & Roadmap

- [x] **MCP App visualizations** — Phases 0–3 of
  [`docs/mcp-apps-roadmap.md`](docs/mcp-apps-roadmap.md) are implemented. One
  chart became twelve on a single shared `ui://iwac/charts.html`, and the
  shipped UI resource is *smaller* than the one chart it replaced (390.1 →
  251.4 kb) because stubbing zod's non-English locales paid for the whole
  suite; `server/index.js` fell 1665.4 → 1191.3 kb with it. Seven new tools
  (`get_topic_distribution`, `get_field_distribution`, `get_cooccurrence`,
  `get_lexical_metrics`, `get_place_distribution`, `get_semantic_map`,
  `get_similar_items`) plus `model` on `get_sentiment_distribution`. §7 of that
  document lists what is still open (PNG export, a wordcloud primitive,
  region drill-down) and §8 records where the plan turned out to be wrong.
  Shipped in **v0.13.0**.

- [x] **Publish to the official MCP Registry** — automated since v0.9.0: the
  tag workflow generates `server.json` (`mcpb/scripts/make-server-json.mjs`)
  and publishes `io.github.fmadore/iwac-mcp-server` (2 `.mcpb` packages + the
  `islam.zmo.de/mcp` remote) via `mcp-publisher` GitHub OIDC. Versions are
  immutable — fixing an entry means bumping and re-tagging. The Anthropic
  directory below is a separate, manual submission.

- [ ] **Submit to the Anthropic extension directory**
  Fill out the interest form:
  <https://docs.google.com/forms/d/e/1FAIpQLScHtjkiCNjpqnWtFLIQStChXlvVcvX8NPXkMfjtYPDPymgang/viewform>
  Prereqs: public GitHub repo ✓, MIT licence ✓, Node.js ✓, valid `manifest.json`
  with `author` pointing at the GitHub profile ✓.
  See also Anthropic's Software Directory Policy:
  <https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy>

- [ ] **Code-sign the `.mcpb`** with a trusted code-signing cert
  (DigiCert / SSL.com, ~$100/yr) so Claude Desktop stops showing the generic
  "grants access to everything" warning. Self-signed certs don't help — Claude
  Desktop only trusts real CAs. Command:
  `mcpb sign iwac-mcp-server.mcpb --cert prod.pem --key prod.key`

- [ ] **Zero-config semantic search with a free local model** — see
  [#5](https://github.com/fmadore/iwac-mcp-server/issues/5). Requires
  re-embedding the HF corpus with the chosen model (corpus + query must use the
  same model). Candidates: `Qwen3-Embedding-0.6B/4B`, `BGE-M3`,
  `EmbeddingGemma-300M`, or the older `multilingual-e5-small` /
  `paraphrase-multilingual-MiniLM-L12-v2`.

- [x] **Remote transport / hosted deployments** — shipped. `--http` selects the
  Streamable-HTTP transport in `main()` (`mcpb/src/index.ts`), built on
  `createMcpHandler` so it answers both protocol eras; a bearer token gates every
  `/mcp` request (`IWAC_MCP_BEARER_TOKEN`, or a Docker secret located via
  `IWAC_MCP_TOKEN_FILE`). HTTP mode *refuses to start* without a token rather
  than warning and running open — deliberately stricter than
  [#3](https://github.com/fmadore/iwac-mcp-server/issues/3) asked for, because
  the endpoint is public. Live at `https://islam.zmo.de/mcp/`.
  [#1](https://github.com/fmadore/iwac-mcp-server/issues/1) is closed as
  delivered; #2 (Streamable-HTTP) was deleted from the tracker after it landed,
  which is why the "Depends on #2" line in #3 now dangles. #3 is now closed as
  delivered.

  - [x] **Upstream request limit confirmed** on the IWAC-docker host. Rate
    limiting was delegated to the front proxy by design (see the header comment
    in `mcpb/src/http.ts`), so nothing in this repo proves it exists — measured
    directly instead (2026-07-28): a burst of ~24 back-to-back requests
    succeeds, then every further request returns **HTTP 429** until the bucket
    refills (~6 req/s sustained). Note the 429 body is raw proxy HTML, **not** a
    JSON-RPC error, so an MCP client surfaces it as an opaque transport
    failure — any probe or test script against the live endpoint must pace
    itself and retry on 429, or its results are silently polluted.

- [ ] **Add `screenshots/`** showing a research query in Claude Desktop — the
  directory listing surfaces these.

- [ ] **Drop the `@hono/node-server` override once the SDK catches up** —
  `mcpb/package.json` forces `@hono/node-server` to `^2.0.12` via `overrides`
  because the entire 1.x line carries GHSA-frvp-7c67-39w9 (Windows
  `serve-static` path traversal) with no backport, while
  `@modelcontextprotocol/node@2.0.0` still declares `^1.19.9`. Running a
  transitive dep a major above what upstream asks for is safe *here* — the SDK
  imports exactly one symbol, `getRequestListener`, which v2 still exports, v2
  wants Node ≥20 against this project's ≥24, and it peers on `hono ^4` — and the
  advisory was never reachable anyway (`serveStatic` appears nowhere in the
  built bundle; `src/http.ts` drives Node's own `http.createServer` rather than
  hono's `serve()`). Once `@modelcontextprotocol/node` widens its own range,
  *remove* the override rather than bumping it, so the resolved version goes
  back to being upstream's problem.

- [x] **Migrate to MCP TypeScript SDK v2 / protocol 2026-07-28** — done
  2026-07-29. `@modelcontextprotocol/server` 2.0.0 went stable 2026-07-27, four
  weeks earlier than the ~late-Aug estimate this entry carried; v1 `sdk` topped
  out at 1.30.0 and never implements 2026-07-28.

  The codemod (`npx @modelcontextprotocol/codemod@latest v1-to-v2 .`) did the
  package split and import rewrites, but it is a *mechanical* tool and left the
  server in the 2025 era: it renames `StreamableHTTPServerTransport` →
  `NodeStreamableHTTPServerTransport` and keeps `server.connect(new
  StdioServerTransport())`, and per the SDK's era matrix those are precisely the
  legacy-era entry points. Speaking 2026-07-28 required hand-rewriting both
  entries to `serveStdio()` / `createMcpHandler()`, which own era negotiation.
  Both default to serving 2025 clients too, so the server is dual-era.

  Also done by hand: wrapping every `inputSchema` / `outputSchema` / `argsSchema`
  raw shape in `z.object()` (the codemod only wraps shapes it converts from
  `.tool()`, and this server already used `registerTool`; raw shapes are
  converted by the SDK's *bundled* zod, which drops `.describe()` text), and
  `cacheHints` for the new `CacheableResult` fields.

  **The flagged gap is closed:** `instructions` survives the loss of the
  `initialize` handshake — the SDK carries it on `server/discover`, byte-identical
  on both eras (asserted in `test/fixture-server.test.mjs`), and prompts still
  list. The remaining 2026-07-28 changes still need no action here, with one
  correction to the 2026-07-23 audit: it recorded "no resources", which stopped
  being true in v0.12.0 when the `ui://` chart resource landed. The error-code
  change is emitted by the SDK either way, so nothing to write.

## Data Enrichment (Track 2 — runs in the IWAC-Hugging-Face pipeline, not here)

> Governing rule: all AI enrichment is precomputed offline as HF columns and
> served as cheap column lookups. The MCP server never generates at request
> time. Whole-issue work is map-reduce (chunk → per-chunk extract → reduce) in
> monthly batches, so no single call is large. Verified fill rates that motivate
> this list (June 2026): references abstract 51% / subject 27%; publications TOC
> **325/1,501** (complete for 17/25 series; Islam Info, An-Nasr Vendredi and
> Islam Hebdo still have none), subject 87%, OCR 97% (median ~16k, max ~278k
> tokens/issue); audiovisual descriptionAI **0/45**.

### Islamic calendar

- [x] **Precompute `hijri_year` / `hijri_month` / `hijri_day`** —
  `post-processing/calculate_hijri_dates.py` in the pipeline repo converts
  `pub_date` with `hijridate` (Umm al-Qura), the same converter as
  IwacVisualizations' `generate_on_this_day.py`, so the website's buckets and
  the MCP server's counts cannot drift. Precomputing rather than converting per
  consumer is load-bearing: measured on the live `articles` subset, ICU/`Intl`
  disagrees with `hijridate` on **75% of pre-2000 dates** (2,365 of 3,152) and
  on none from 2000 on. Only 0.86% of articles change lunar *month*, so
  month-level aggregates are robust either way — day-level labels are not.
  Written for articles, publications, documents, audiovisual and images;
  deliberately **not** references (an academic imprint date has no meaningful
  lunar reading). Columns are allowlisted in `iwac_common/public_columns.json`.
  Server side: `calendar=hijri` + `granularity=lunar_month` on
  `get_temporal_distribution` (with the `lunar` MCP App chart), `hijri_month` /
  `hijri_year` filters on `search_articles` / `search_publications`, and a
  `hijri_date` field on article and publication rows. Every path degrades to a
  self-correctable error on a dataset revision that predates the columns.
  Shipped in **v1.3.0**.

  - [ ] **Run the pipeline script and re-publish.** The code is in place but
    the columns do not exist on the Hub yet — until
    `calculate_hijri_dates.py --config <subset>` runs against the private repo
    for each of the five subsets and `publish_public.py` projects it, the live
    server answers the lunar tools with "no Hijri date columns in this dataset
    revision".

### References (864 rows)

- [ ] **Auto-tag `subject`** from title+abstract (only 27% tagged today),
  aligned to the index `Sujets` controlled vocabulary. The
  `search_references(subject=…)` filter already exists — this raises its
  coverage from 27% toward the whole subset.
- [ ] **Backfill missing `abstract`** (51% present) from Crossref (DOI — 31%
  have one) and OpenAlex (title match). Fetch *real* abstracts; do not generate
  them from a bare title.
- [ ] **Compute `embedding_abstract`** (over title+abstract, same Gemini model /
  768-dim as articles) → enables a new `semantic_search_references` tool. Tiny
  corpus (864 rows), large payoff: connects secondary scholarship to the same
  semantic surface as the articles.

### Publications (1,501 rows)

- [ ] **Extract `tableOfContents` from OCR** — **mostly done (June 2026):**
  325/1,501 issues now have a TOC + `embedding_tableOfContents`, covering 17 of
  the 25 series completely (avg TOC ~6.4k chars). `semantic_search_publications`
  and the `matching_toc_entries` path now work for those series. Remaining: the
  three largest series — Islam Info (695 issues), An-Nasr Vendredi (318),
  Islam Hebdo (122) — plus 5 small series (~41 issues).
- [ ] **Per-issue `descriptionAI`** (2–4 sentences: themes, notable pieces).
  Publications have *no* summary surface at all today.
- [ ] (stretch) **Article-level publications index** — explode extracted TOCs
  into one row per article (issue_id, page, title, author) as a small new
  table/subset, so users can search *within* periodicals without loading a
  full (up to ~278k-token) OCR blob.

### Audiovisual (47 rows)

- [ ] **Populate `descriptionAI`** — the column exists but is empty for all
  47 rows (`length(trim(...)) = 0`; a bare `COUNT()` claims 47/47 because the
  parquet stores empty strings, not NULLs). Partly mitigated since July 2026:
  the subset gained an `OCR` transcription column, which the server now serves
  as the item body (`transcription` on `get_audiovisual`, `text` on `fetch`) and
  searches — but only **4 of 47** rows have one, so AI descriptions remain the
  browsable surface this subset needs.
- [ ] **Transcribe the remaining 43 recordings** — Hausa/Arabic audio; the 4
  existing transcriptions prove the column and the server path work end to end.

### Images (30 rows, new July 2026)

- [ ] **Populate `description`** — 2 of 30 photographs have a caption. Discovery
  currently leans on title/subject/place plus the multimodal `embedding_image`
  (`semantic_search_images`), which works without captions but cannot be quoted
  in a write-up.

### Server tools that light up once the columns land

- `semantic_search_references` — new tool, needs `embedding_abstract`.
- `semantic_search_publications` — ✅ now useful for the 17 TOC-covered series;
  corpus-wide once Islam Info / An-Nasr Vendredi / Islam Hebdo TOCs land.
- `search_publications` — returns AI summaries once `descriptionAI` is populated
  (add a `descriptionAI` field to `SUBSET_FIELDS.publications` in
  `src/tools/_shared.ts`, tagged `searchable` and in the `summary` view).

## Skill Improvements

- [ ] **Persona-based research framing** — branch research on *lens* (Islamic
  scholar / historian / media studies), informed by local scholars & imams, as
  a framing axis alongside the Brief/Extended depth choice. See
  [#6](https://github.com/fmadore/iwac-mcp-server/issues/6).

- [ ] **Enrich `research-domains.md` with actual IWAC frequency data**
  Use `list_subjects` (214 subjects), `list_persons`, and `list_locations` to
  replace manually curated search terms with data-grounded suggestions
  including actual frequencies.

- [ ] **Publish the `iwac-mcp` research skill to the Claude Skills repository**
  (it already ships as a standalone `iwac-mcp-skill.zip` release asset on every
  tag — this item is about the Skills library specifically). Source of truth is
  `.agents/skills/iwac-mcp/`. Related but distinct from
  [#4](https://github.com/fmadore/iwac-mcp-server/issues/4) (adapting the skill
  for non-Claude models). NB: the copy in the claude.ai Skills library
  (`anthropic-skills:iwac-mcp`) predates v0.5 — replace it with
  `.agents/skills/iwac-mcp/` or delete it.
