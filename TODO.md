# TODO

## October 2026 review implementation

- [x] Bound keyword contexts and reject empty folded search terms.
- [x] Apply interval dates consistently in shared selections; distinguish missing,
  invalid and imprecise dates in temporal output.
- [x] Isolate shared cache/index work from individual request cancellation;
  record successful unchanged freshness checks and coalesce embedding requests.
- [x] Add typed research views, reliable export/back actions, visible link
  fallbacks, proportional maps and self-contained SVG exports.
- [x] Add corpus manifests, CSL-JSON/BibTeX pages, live dataset resources,
  sentiment pair selection and agreement statistics with explicit denominators.
- [x] Validate platform bindings, skills and actual SQL in packaged artifacts;
  reject published release versions before privileged publication.
- [x] Expand regression, protocol and browser coverage; upgrade compatible
  runtime/development dependencies and document the packaging-only audit exception.


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

- [ ] **Submit `https://islam.zmo.de/mcp` to the Connectors Directory as a
  remote connector.** The old plan (the extension-directory interest form for
  the `.mcpb`) is dead: Anthropic's submission page now says desktop extension
  listings are deprecated and the directory no longer accepts local servers
  packaged as MCPB (a local server can only ship inside a plugin). What is
  listable is the hosted endpoint, and since it renders charts it is an
  **MCP App** submission, made through the developer portal
  (<https://claude.ai/directory/manage>, "MCP connector"). Sources, checked
  2026-11-18: <https://claude.com/docs/connectors/building/submission.md> and
  <https://claude.com/docs/connectors/building/review-criteria.md>.
  Prerequisites, and where the repo stands:
  - [x] Remote over HTTPS, and authentication fits: "no authentication for
    public data" is an accepted mode, and nginx injects the bearer the app
    requires, so the public endpoint needs no client auth. The `*.zmo.de`
    certificate is valid again (checked 2026-11-18 with a schannel client:
    issued 2026-08-05, expires 2027-02-20; it had been revoked/superseded in
    late July 2026).
  - [x] Every tool has a top-level `title` and `readOnlyHint: true` /
    `destructiveHint: false` (`toolMeta()` in `mcpb/src/tools/shared/results.ts`,
    used by all 39 tools).
  - [x] Tool names are at most 64 characters (the longest,
    `semantic_search_publications`, is 28).
  - [x] Support contact (GitHub issues, already `support` in the manifest) and
    icon (`mcpb/icon.png`; check the portal's size requirement).
  - [ ] Documentation URL: the README works, but a short page aimed at
    researchers (what the connector reads, example prompts) would serve the
    listing better. Public docs are required by the publish date.
  - [ ] Privacy policy URL. The manifest's `privacy_policies` points at Hugging
    Face's policy, which covers the dataset host, not this server. The hosted
    endpoint needs its own: what the proxy logs, retention, no conversation data
    kept, contact. (The page's README-section rule applies to local
    connectors; the URL is required for every listing.)
  - [ ] **3 to 5 carousel screenshots**: PNG, at least 1000 px wide, cropped
    to the app response without the prompt, each with its prompt text supplied
    separately; no GIF or video. `mcpb/scripts/capture-charts.mjs` already
    captures real chart payloads for a browser harness to render. This replaces
    the old "add `screenshots/`" item.
  - [x] Descriptions must not instruct Claude's behaviour (see the next item).
  - [ ] Test every tool as a custom connector in Claude and in MCP Inspector
    (the portal's Test & launch step asks for it).
  - [ ] Optional: declare allowed link URIs (`https://islam.zmo.de`) if the
    chart UI opens links through `ui/open-link`, so users are not asked to
    confirm each one.

- [x] **Review tool descriptions against the directory's "describe what the
  tool does, don't tell Claude how to behave" criterion.** Done 2026-11-18:
  all 39 tools, their parameters, the prompts and the instructions audited.
  Eight sentences in seven tools rephrased as data facts (the French-keyword
  line in search, search_articles, search_publications and search_documents
  now says the sources are French and English terms match only the English
  AI text; get_collection_stats, search_by_sentiment,
  get_sentiment_distribution and get_lexical_metrics state how the output
  reads instead of what the model must do). Kept: pointers to sibling tools
  and parameter usage notes ("use search_references for the rest", "follow
  `next_offset`"), which the criteria allow as "when to invoke". The
  steering itself stays in the server instructions (LANGUAGE: query press in
  French) and the skill. Prompts are user-invoked, so their directives stand.
  Footprint 15,717 to 15,708 tokens, baseline updated. Original note:
  `search_articles`, `search_documents` and `search_publications` say "Use
  French concept keywords regardless of the user's report language", which is
  an instruction to the model rather than a description (a factual rewording:
  "the corpus is French; queries match French text"). Audit every description
  and the server `instructions` the same way. Changing descriptions moves the
  gated token baseline (`test/token-baseline.json`) and is a public-contract
  change for every connected host, so this is a deliberate, versioned
  decision, not a drive-by edit.

- [x] **MCP Server Card** (SEP-2127, Final, an optional Extensions Track
  extension). Done 2026-11-18 (unreleased; the deployed 6.0.0 image predates
  it): `GET /mcp/server-card` in `src/http.ts`, built once per process by
  `src/serverCard.ts` against the v1 schema of
  `modelcontextprotocol/ext-server-card` (renamed from
  `experimental-ext-server-card`, commit 526201bb). Registry name and identity
  as in `server.json`, title/description/website from `manifest.json`, version
  from `__IWAC_VERSION__`, and one `streamable-http` remote only when the new
  `IWAC_MCP_PUBLIC_URL` is set (the schema allows absolute URLs only), listing
  2026-07-28 plus the SDK's `SUPPORTED_PROTOCOL_VERSIONS`. The modern list is
  internal to SDK 2.4, so `test/http-server.test.mjs` checks it against the
  live `server/discover`. Served without the bearer and for every `Origin`
  (`*`, as the spec requires), `Cache-Control: public, max-age=3600`, ETag and
  304; unit tests in `test/server-card.test.ts`. IWAC-docker: `ETag` added to
  the `/mcp` exposed headers and a nginx-served `/.well-known/ai-catalog.json`
  linking the card. Still to do on deploy: bump the image and set
  `IWAC_MCP_PUBLIC_URL=https://islam.zmo.de/mcp` on the `iwac-mcp` service.
  Open point: the handshake `serverInfo.name` is `iwac-mcp-server`, which the
  card cannot use (its `name` needs a namespace slash); the spec says the two
  SHOULD NOT contradict, so consider aligning `serverInfo.name` in a major.

- [ ] **Get ready for MCP TypeScript SDK 2.5.** Pending `.changeset/` entries on
  `modelcontextprotocol/typescript-sdk` main (checked 2026-11-18; latest
  release still v2.4.0):
  - `registerTool` will type-check a callback's successful result against its
    `outputSchema`: `structuredContent` must match, a result typed as plain
    `CallToolResult` (or a helper returning one) stops compiling, and values
    built from a wider type than the schema (a `string` for an enum) fail.
    Expect work in the tools that declare `outputSchema`.
  - `@opentelemetry/api` (`^1.9.0`) becomes a **required peer dependency** of
    `@modelcontextprotocol/server` and `client`: the SDK emits spans and
    duration histograms (a no-op without an OpenTelemetry SDK; `openTelemetry:
    false` turns it off). The esbuild bundle inlines the SDK, so the import
    must resolve at bundle time (add it as a dependency, inline it or mark it
    external deliberately), and `pack-platforms.mjs`'s `runtimeClosure()` does
    not follow peers, so an external copy would not ship unless declared.
  - An experimental `extensions` option on `McpServer` (`{ id, setup(ctx) }`)
    may change how the Skills extension attaches; `SkillsExtension.attach` is
    what `src/tools/skills.ts` uses today.
  - A result with `structuredContent` and no `content` gets an automatic text
    block holding the serialized JSON. Check that no tool returns
    `structuredContent` without `content`: one that did would start paying
    for its payload twice in tokens.
  - A `logger` option on `McpServer` / `createMcpHandler` can route SDK
    diagnostics through the server's own stderr logging instead of `console`.

- [ ] **Code-sign the `.mcpb`** with a trusted code-signing cert
  (DigiCert / SSL.com, ~$100/yr) so Claude Desktop stops showing the generic
  "grants access to everything" warning. Self-signed certs don't help — Claude
  Desktop only trusts real CAs. Command:
  `mcpb sign iwac-mcp-server.mcpb --cert prod.pem --key prod.key`.
  Since v5.0.0 every release file and the image carry a free SLSA
  build-provenance attestation (`gh attestation verify`), which proves where the
  bytes were built but does not silence the desktop warning. The AMIRA server
  dropped `mcpb sign` over the node-forge advisory; recheck it before signing.

- [x] **Zero-config semantic search with a free local model**: shipped in
  v4.0.0 ([#5](https://github.com/fmadore/iwac-mcp-server/issues/5),
  [#48](https://github.com/fmadore/iwac-mcp-server/issues/48)). The corpus was
  re-embedded upstream with EmbeddingGemma 2 (dataset revision `d834ab71`); the
  server runs the same pinned ONNX export in-process, checks its own output
  against the Python reference and each column against corpus anchors, and
  turns semantic search on by default. v4.1.0
  ([#49](https://github.com/fmadore/iwac-mcp-server/issues/49)) closed the last
  piece: `get_similar_items` reads the precomputed `related_articles` neighbours
  for articles and documents. Document → article neighbours wait for an
  upstream column.

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

- [x] **Drop the `@hono/node-server` override once the SDK catches up**:
  done with SDK 2.4.0 ([#54](https://github.com/fmadore/iwac-mcp-server/issues/54)).
  `@modelcontextprotocol/node` 2.1.2 declares `^1.19.9 || ^2.1.3`, so the
  override is gone and npm resolves 2.1.3 on its own: the version is back to
  being upstream's problem. The 1.x line still carries GHSA-frvp-7c67-39w9
  (Windows `serve-static` path traversal), unreachable here because
  `serveStatic` appears nowhere in the built bundle.

- [x] **Move the chart UI to `@modelcontextprotocol/ext-apps` 2.x** — upgraded
  to 2.0.3 with Zod 4.6.5. A self-contained gzip inline bundle keeps the resource
  below 300 KB without dropping SDK protocol features. Browser tests execute the
  actual decompression bootstrap; a separate 500 KB decoded-JavaScript cap makes
  expanded code growth visible.

- [x] **ext-apps 2.1.0**: upgraded from 2.0.4 on 2026-11-18, before npm
  `latest` moved: the tag lags only because the 2026-11-10 release's publish run
  awaits approval, and the published 2.1.0 carries the same SDK source as the
  `v2.1.0` tag. Resource 191.4 → 193.2 KB, decoded script 487.8 → 492.3 KB (gate
  500 KB, about 7.7 KB left). The WebMCP bridge is off (`webMcpBridge: false`):
  (at the time the view registered no app-side tools; v6.2.0 added the four view
  tools, which use the Apps channel rather than WebMCP). See docs/mcp-apps-roadmap.md §7.

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
  on both eras (asserted in `test/fixture-server/protocol.mjs`), and prompts still
  list. The remaining 2026-07-28 changes still need no action here, with one
  correction to the 2026-07-23 audit: it recorded "no resources", which stopped
  being true in v0.12.0 when the `ui://` chart resource landed. The error-code
  change is emitted by the SDK either way, so nothing to write.

- [x] **Token budget in CI** — the server's cost to a model is now measured
  rather than assumed. `npm run test:tokens` gates two things on every PR:
  the **always-on footprint** (34 tool definitions + instructions = 14 091
  tokens, checked against the committed `test/token-baseline.json` at 5% drift
  and a 16k hard ceiling) and the **worst-case response** of every tool called
  at its maximum arguments against inflated fixtures
  (`scripts/make-stress-fixtures.mjs`), ceiling 20k — under the 25k cap Claude
  Code applies to a tool result. The same ceiling runs weekly in
  `smoke-test.mjs`, which is the only place the aggregate tools' real
  cardinality shows up. The gate earned itself on the first run:
  `search_articles(limit=100, with_description=true)` was **27 533 tokens**, so
  a caller asking for 100 abstracts received nothing at all; `with_description`
  now caps the page at 25 with a `limit_warning` that says why.

  Still open, in rough order of payoff:

  - `outputSchema` is **2 402 tokens, 19% of the footprint**, and is attached to
    only 13 of 34 tools. It buys `structuredContent` validation (asserted in
    `test/fixture-server/`); worth deciding per tool rather than by
    habit, and worth re-checking once clients report whether they read it.
  - The 9 aggregate tools are **5 600 tokens, 44% of the footprint** for tools a
    given session may never call. On hosts supporting Tool Search, `register.ts`
    now marks only `search`, `fetch` and `get_collection_stats` with
    `anthropic/alwaysLoad: true`, so the other 36 tools (including all 9
    aggregates) are deferred automatically (~1.7k tokens upfront instead of
    ~15.7k); `instructions.ts` carries a compact map of deferred capabilities,
    and `test/token-budget.test.mjs` prints both footprints.
  - `search_index` (16 770) and `search_references` (15 867) sit closest to the
    response ceiling at `limit=100`. Neither is wrong — the caller asked — but
    they are the two that a wider row would push over.

- [x] **Split chart data from model data** (done). A tool that draws a chart
  answers two audiences, and MCP Apps forwards `_meta` to the view while the
  model reads only `content` / `structuredContent`, so the series can ride in
  `_meta`. `get_semantic_map(color_by)` fell from **13 490 to 172 tokens** and
  `get_topic_distribution(over_time, top_n=15)` from 5 983 to 2 218, for +171
  always-on. Only data that is *redundant for reasoning* moves: the model gains
  a summary computed from what it lost, asserted against the series in
  `test/fixture-server/aggregates.mjs`. Deliberately **not** applied to
  `get_temporal_distribution` or `get_field_distribution`, whose dense field is
  the answer: density is not the criterion, redundancy is. See
  `docs/mcp-apps-roadmap.md` §2.4.

- [x] **Align Skills over MCP with the finalized extension** — manifest byte
  sizes, typed result/cache contracts and modern/legacy transport tests now
  match SEP-2640. Docker includes the same embedded skill as desktop builds.
  Optional directory reads remain unadvertised; ordinary resource access and
  installable zip delivery remain available.

- [x] **Serve the skill through the SDK's Skills extension** in v4.2.0, on SDK 2.4.0
  ([#54](https://github.com/fmadore/iwac-mcp-server/issues/54)).
  `src/tools/skills.ts` builds the entries with
  `SkillsExtension.load(memorySkillFiles(...))` and attaches the extension
  instead of hand-registering resources and `skills/*` handlers. Two decisions:
  `directoryRead` is now advertised and the bare `skill://iwac-mcp` URI is the
  skill's directory, retiring the JSON catalogue document (`skills/list` carries
  the same manifest); and every file stays in `resources/list` with its title
  and summary, through a small `SkillSource` whose `listResources()` lists them,
  because the SDK's catalogue lists only SKILL.md and hosts without the
  extension find the references there. The SDK is pinned to `~2.4.0` because
  `attach()` is experimental; `test/skills.test.mjs` verifies through
  `SkillsClient`. SEP-2640 itself is Final (extension id
  `io.modelcontextprotocol/skills`, checked 2026-11-18), so the pin guards the
  SDK's wiring, not a moving protocol.

## Data Enrichment (Track 2 — runs in the IWAC-Hugging-Face pipeline, not here)

> Governing rule: all AI enrichment is precomputed offline as HF columns and
> served as cheap column lookups. The MCP server never generates at request
> time. Whole-issue work is map-reduce (chunk → per-chunk extract → reduce) in
> monthly batches, so no single call is large. Verified fill rates that motivate
> this list (June 2026): references abstract 51% / subject 27%; publications TOC
> **325/1,501** (complete for 17/25 series; Islam Info, An-Nasr Vendredi and
> Islam Hebdo still have none), subject 87%, OCR 97% (median ~16k, max ~278k
> tokens/issue); audiovisual descriptionAI **0/1,771** (August 2026, after the
> YouTube harvest — `description` covers 1,465 of those rows instead).

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
- [x] **Compute `embedding_abstract`**: done upstream with EmbeddingGemma 2
  over title+abstract (442 of 867 references, those with an abstract);
  `semantic_search_references` shipped in v4.0.0. Backfilling abstracts (below)
  raises its coverage.

### Publications (1,501 rows)

- [ ] **Extract `tableOfContents` from OCR**: **mostly done (October 2026):**
  603/1,501 issues now have a TOC + `embedding_tableOfContents`, including all
  of Islam Hebdo. `semantic_search_publications` and the `matching_toc_entries`
  path work for those issues. Remaining: An-Nasr Vendredi (318 issues), the
  other 565 Islam Info issues, and Al Minbar, Al Maoulid Magazine (arabe) and
  Allahou Akbar (15 issues).
- [ ] **Per-issue `descriptionAI`** (2–4 sentences: themes, notable pieces).
  Publications have *no* summary surface at all today.
- [ ] (stretch) **Article-level publications index** — explode extracted TOCs
  into one row per article (issue_id, page, title, author) as a small new
  table/subset, so users can search *within* periodicals without loading a
  full (up to ~278k-token) OCR blob.

### Audiovisual (1,771 rows and growing — 47 deposited, the rest harvested)

- [ ] **Populate `descriptionAI`** — the column exists but is empty for all
  1,771 rows (`length(trim(...)) = 0`; a bare `COUNT()` claims full coverage
  because the parquet stores empty strings, not NULLs). Mitigated twice over:
  the subset gained an `OCR` transcription column in July 2026, and the harvest
  brought each video's own `description` (1,465 rows), which the server searches
  and serves as the body when no transcription exists. AI summaries would still
  add the one thing neither gives — a consistent, quotable synopsis across both
  cohorts.
- [ ] **Transcribe the rest** — 50 of 1,771 rows carry a transcription. The
  deposited Hausa/Arabic recordings are the hard ones; the francophone YouTube
  cohort is now the larger prize and the easier transcription target, and it is
  what would let `search_audiovisual` reach what was actually *said* rather than
  what the channel wrote in its blurb.
- [x] **Serve the harvested cohort honestly** — `source_type`, `external_url`,
  `duration_seconds`, `rights`/`contributor`, a `publisher` (channel) filter and
  two-cohort fixtures shipped in **v3.2.0**, closing
  [#20](https://github.com/fmadore/iwac-mcp-server/issues/20).

### Images (30 rows, new July 2026)

- [ ] **Populate `description`** — 2 of 30 photographs have a caption. Discovery
  currently leans on title/subject/place plus the multimodal `embedding_image`
  (`semantic_search_images`), which works without captions but cannot be quoted
  in a write-up.

### Server tools that light up once the columns land

- `semantic_search_publications` becomes corpus-wide once the An-Nasr Vendredi
  and remaining Islam Info TOCs land.
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

- [ ] **Clean up the stale copy in `anthropic-skills` (`anthropic-skills:iwac-mcp`)**
  — it predates v0.5 and drifts from `.agents/skills/iwac-mcp/`. Now that Claude
  and Claude Code consume Skills over MCP (`io.modelcontextprotocol/skills`)
  natively from both the hosted endpoint and the `.mcpb`, maintaining a separate
  copy in the Skills repository is superseded; delete the old copy so users do
  not load an outdated workflow. (The standalone `iwac-mcp-skill.zip` release
  asset remains as a fallback; [#4](https://github.com/fmadore/iwac-mcp-server/issues/4)
  tracks adapting the skill for non-Claude models.)
