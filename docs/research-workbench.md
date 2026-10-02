# Research workbench (v3.8)

The workbench connects an analytical selection to its source records. It uses the
same DuckDB corpus and self-contained MCP App as the existing tools. There are
35 default tools and three optional semantic-query tools; `explore_corpus` is the
only new tool. No external chart service is required.

## Selections

`explore_corpus` accepts `subset`, `mode`, and a nested `selection`. It defaults
to article items, with 20 records per page. `limit` is 1–50; `offset` starts at 0.
Concordance applies a maximum of 20 records and echoes the applied `limit`;
advance by that returned size so no records are skipped.
The same filter fields are available directly on the aggregate tools and on
article/publication search.

```json
{
  "mode": "items",
  "subset": "articles",
  "selection": {
    "country": "Benin",
    "date_from": "1990",
    "date_to": "2010",
    "exact": { "spatial": ["Cotonou"], "topic_id": ["12"] }
  }
}
```

- `keyword` defaults to one accent-insensitive literal substring. Set
  `keyword_mode: "all_terms"` to require every whitespace-separated term
  (maximum 12) somewhere in the searchable text fields.
- `keyword_aliases: ["variant", "other variant"]` explicitly ORs alternatives
  with a literal keyword. It cannot be combined with `all_terms`.
- `subject` matches a complete pipe-separated subject tag. `newspaper` keeps its
  historical substring semantics. Use `exact.newspaper` for a complete title.
- `exact` intersects fields **and values within each field**. For example,
  `spatial: ["Cotonou", "Lomé"]` requires both tags. Supported fields are
  subject, spatial, author, language, country, country_raw, newspaper, topic_id and min_prob.
  `country_raw` matches a whole pipe-joined cell for coverage/comparison drilldowns;
  `country` requires individual pipe-separated country tags.
  Numeric topic/probability values are represented as strings in this map.
- `exact["polarity:<model>"]` selects an exact model label. Centrality and
  subjectivity accept the same syntax. `exact.scored_by` requires a polarity
  annotation from every listed model. Pairwise matrix navigation preserves the
  two selected model labels; the panel intersection remains separately reported.
- A filter absent from the chosen subset returns an error. No filter is silently
  ignored. Topic clicks use stable topic IDs, including when shortened labels
  collide. Place mentions and publication-country shading use separate keys.
- Date bounds must be complete, calendar-valid years, months, days or timestamps.
  Reversed bounds fail. Source dates with year/month precision denote intervals; shared workbench
  and aggregate filtering includes intervals that overlap the requested dates
  on every supported subset. Slash-separated source date ranges use the same rule. `hijri_month` and
  `hijri_year` use the corpus's precomputed calendar fields and reject unsupported
  subsets.

`mode: "aliases"` searches the authority index and returns its alternate titles.
It suggests variants; it does not automatically apply them. Read the authority
record and explicitly add chosen terms to `keyword_aliases`. Removing the list
restores the original literal query.

## Views and interpretation

| Mode / tool | Reading | Limits and denominator |
| --- | --- | --- |
| `items` | Paginated sources; click a title to read text and metadata | Stable stored-date/ID order; JSON/CSV describe the current page, not every match |
| `concordance` | Up to three body-text contexts per matched item | Requires a keyword; metadata-only matches may have no body-text context |
| `coverage` | Source × year heatmap: counts, body text, embeddings, annotations | Availability / archived records per cell; up to 400 populated cells, with omitted count |
| `compare` | Selection A and B on common category axes; source-reading buttons | Requires `comparison`; shares use each full base, including missing metadata; overlap is explicit; 40 combined categories |
| `attention` | Publication country × mentioned place | Articles/publications only; optional share of the origin's selected items; 200 populated pairs |
| `get_temporal_distribution` | Raw or normalized Gregorian/Hijri trends | `normalize_by: "scope"` uses archived items; `"searchable"` restricts numerator and denominator to available body text |
| `get_sentiment_distribution` | Shared filters, chosen pair/scale, clickable agreement cells | Pair and panel populations are explicit; AI labels are annotations |
| `manifest`, `csl_json`, `bibtex` | Pageable corpus/citation exports through `explore_corpus` | 1–50 items per page, selected IDs/URLs and source provenance; missing bibliographic fields are not invented |
| `get_similar_items` | Cosine ranking and candidate chronology | Source plus its returned neighbours; a similarity score is not proof of a reprint |

Coverage's annotation count means at least one model has a polarity label.
Nonempty embeddings and available OCR are availability measures, not quality
certificates. Missing columns are disclosed in `metrics`; a blank heatmap cell
is not a historical zero. The archive does not establish a newspaper's complete
publication lifetime. Cropped cells and absent metadata cannot establish that an
event or source was absent.

Temporal denominators retain country, newspaper, Gregorian bounds and lunar
filters, including exact country/newspaper predicates. They remove thematic
predicates (keywords, subjects, spatial tags, topic assignments and model labels).
The result returns raw numerator distributions, `denominators`,
`denominator_filters` and `normalize_by`; the view and CSV expose both counts and
percentages. Grouped shares use separate bars rather than stacking unrelated
percentages. Grouped lunar counts use one panel per group.

Comparisons currently show country, newspaper and topic distributions where
those columns exist, plus text/embedding/scoring coverage. Their temporal
comparison uses one common archived-corpus denominator over the union of the
two date windows; it returns raw counts, denominators, shares, and the disclosed
year cap. Missing, invalid and multiyear dates are labelled separately. Pipe-joined country
strings remain one category in comparison distributions. Attention splits country
and spatial tags and counts each item once per pair; its cells may therefore sum
to more than the number of items. Reference subject-country tags are deliberately
not treated as publication origins.

## Navigation and exports

Supporting hosts offer **Fullscreen / Exit fullscreen** for a larger research
view and **Ask about this selection** for an explicit follow-up question. The
question includes the view's current selection, so you can discuss an inspected
source or comparison directly. Fullscreen changes only the display.

When supported, navigation and view-option changes automatically share compact
filters, source IDs, counts, selected sentiment pair and provenance with the
assistant. A status below the view reports whether sharing succeeded. These
updates do not start a conversation turn. Shared context excludes source text
and dense chart data; abbreviated filters and source samples are marked. The
assistant must still retrieve and read sources before quoting them. The Ask
message includes its own snapshot when automatic sharing is unavailable or
fails. Host capabilities determine which controls appear.

Interactive marks preserve the existing selection and intersect the clicked
category. Back restores the previous payload and view options. Loading and tool
errors retain the current view; a late response cannot replace a newer selection.
SVG marks support Enter/Space activation and visible focus. Coverage, comparison,
attention and temporal views provide data tables.

Hosts advertising downloads receive CSV, JSON, and standalone SVG export actions.
CSV/SVG exports include a companion provenance JSON file. SVG exports include
all chart panels, legends, scope captions, caveats and their styles; JSON includes the reconstructed view data,
filters and interpretation notes. Hosts without download support still receive
normal tool results. Actual MCP-host rendering and download dialogs remain a
release acceptance check; the repository tests exercise the host protocol and
real DOM selectors and a narrow-viewport Chromium host harness, not a native host installation. Hosts
without open-link capability display a selectable canonical URL.

## Dataset provenance and cache behavior

Every successful tool response includes a separate provenance text block and
`_meta["islam.zmo.de/provenance"]`. The main `structuredContent` contract is
unchanged. Provenance includes:

- a SHA-256 snapshot identifier derived from repository, requested revision and
  the content identities of the files actually loaded;
- subset file identities, access mode, load time and freshness status;
- applied tool arguments and analysis-method version;
- the embedding contract for semantic-query tools.

`main` is a moving revision name, **not** a resolved commit. Exported file content
identities distinguish its snapshots. Set `IWAC_DATASET_REVISION` to a full Hub
commit SHA to request an immutable revision. Legacy offline files are hashed;
exports do not expose local cache paths or credentials.

Each tool request pins its subset files and schemas. Its counts, pages and
subqueries keep those files even if a background refresh replaces the shared
view. Separate tool calls, including successive pages, can still observe a newer
snapshot; compare their provenance or use a pinned revision for a multi-call
study.

Writers use an exclusive cache-directory lock, unique temporary files, verified
downloads, atomic manifest replacement and a complete previous-manifest backup.
An incomplete or damaged cache never falls back to globbing together content-named
shards from several generations. Plain pre-manifest caches remain supported.

**Old immutable generations are retained.** This prevents deletion beneath another
process or a pinned request and supports inspection of older exports. Disk use can
grow after refreshes. To reclaim space, stop every server using the directory,
archive any snapshots needed for reproducibility, then clear/rebuild that cache.
A crashed writer can leave `.iwac-write-lock`; remove it only after confirming its
owner has stopped. A live lock is never stolen merely because a download is slow.

Database concurrency is 16 active / 128 queued queries. PCA runs in worker threads
with two active / eight queued projections and an eight-entry generation-keyed
cache. Embedding requests allow four active / 16 queued calls and retain at most
128 completed query vectors in process memory. Queued waits have a 30-second
limit; tool requests have a 120-second deadline. Cancellation removes per-request queued work,
interrupts DuckDB calls and terminates a projection worker. Shared cache/index builds
and background refresh, including shared embedding provider requests, have a separate 15-minute deadline; cancelling one caller
stops its wait without cancelling work needed by other callers. Normal shutdown cancels
shared work and waits for lock/temporary-file cleanup; HTTP shutdown retains an
eight-second hard deadline. Freshness checks update
status even when the dataset content is unchanged. Identical in-flight embedding
queries share one provider request.

Authenticated `GET /metrics` reports active/queued database queries and p50/p95
latency over the last 256 tool calls, plus completed-call count. The existing
unauthenticated `/health` remains unchanged. Metrics describe the running process,
not an externally measured deployment latency guarantee.

## Precise dates, agreement and exports

Monthly Gregorian series exclude records without month precision. `dated_count`,
`imprecise_date_count`, `invalid_date_count` and `undated_count` disclose the
population instead of mixing bare years into month keys. Read counts and notes
before interpreting a sparse month as an absence.

`get_sentiment_distribution` accepts keyword, dates and exact selection filters.
With `model:"all"`, set `compare_models:["luna","qwen"]` and
`agreement_field:"polarity"|"centrality"|"subjectivity"`. The panel summary keeps
its all-model polarity intersection; the selected pair matrix includes only
articles with recognized labels from both models. Cohen's kappa includes the
non-ordinal `Non applicable` category; quadratic weighted kappa excludes it and
reports a separate `weighted_n`. Empty or degenerate marginal distributions have
undefined kappa. Agreement measures consistency, not accuracy or confidence.
Inline article labels carry `sentiment_model` so their scorer stays identifiable.

`mode:"concordance"` returns separate left/match/right contexts and body-field
provenance. Original character offsets are included only when normalization has
not changed source positions. Metadata-only matches are identified. JSON/CSV
exports retain these contexts; a context cap is not a count of all occurrences.

For exports, call `explore_corpus` with `mode:"manifest"`, `"csl_json"` or
`"bibtex"` and the same selection/limit/offset. Each bounded page includes record
IDs, canonical URLs, pagination and source provenance. Iterate explicitly and
compare snapshots; a single page is not the whole selected corpus. Bibliographic
exports use stored facts, leave unknown fields absent, and preserve uncertain
source dates rather than assigning invented precision.

`resources/read` on `iwac://datasets` lists subsets. The templated resource
`iwac://datasets/{subset}` returns the current schema, availability and provenance;
its cache TTL is zero because a live dataset can refresh independently of a build.

## Local embedding migration

The default provider remains Gemini. Changing only a query model is unsafe even
when dimensions agree. The server now checks model, dimension, vector column and
corpus revision against an embedding contract and normalizes query/index vectors.
Item-to-item retrieval computes cosine similarity explicitly.

A self-hosted OpenAI-compatible embeddings endpoint is supported by configuration:

```sh
IWAC_SEMANTIC_SEARCH_ENABLED=true
IWAC_EMBEDDING_PROVIDER=local
IWAC_LOCAL_EMBEDDING_URL=http://127.0.0.1:8080/v1/embeddings
IWAC_EMBEDDING_MODEL=your-corpus-model
IWAC_EMBEDDING_DIMENSIONALITY=768
IWAC_DATASET_REVISION=<40-character-commit-sha>
IWAC_EMBEDDING_CONTRACT_FILE=/path/to/embedding-contract.json
```

Set `IWAC_LOCAL_EMBEDDING_API_KEY` only if that endpoint requires it. The contract
is an operator declaration produced with the corpus embedding pipeline:

```json
{
  "model": "your-corpus-model",
  "revision": "pinned-model-revision",
  "dimension": 768,
  "normalization": "unit-l2",
  "dataset_revision": "0000000000000000000000000000000000000000",
  "fields": { "articles": "embedding_OCR" },
  "query_prefix": "query: "
}
```

Replace the example revision with the actual corpus commit. The endpoint must
serve the declared model revision; the compatibility API cannot independently
attest its weights. `query_prefix` supports models requiring retrieval prefixes.
The public corpus's built-in Gemini contract names a provider-managed revision;
it does not claim immutable vendor weights.

**The corpus must be regenerated with the matching model before enabling this.**
This change adds an adapter and evaluation harness; it does not regenerate IWAC
embeddings or establish retrieval quality for a new model. Evaluate with held-out,
researcher-authored French/English, transliteration, sparse-coverage and difficult
name queries:

```sh
node scripts/evaluate-retrieval.mjs --judgments judgments.json --output evaluation.json --k 10
```

Judgments have shape `[{"query":"...","subset":"articles","relevant_ids":["101"]}]`.
The harness records recall, precision, nDCG, latency and provenance under the
configured provider. It calls that provider; select and provision it deliberately.
Compare providers on the same judgments and matching corpus versions before
migration. No community research lens is fabricated here; consultation remains a
separate scholarly task.

## Offline similarity candidates

```sh
node scripts/reprint-candidates.mjs --input scoped-articles.parquet --output candidates.json \
  --threshold 0.85 --max-items 2000 --max-pairs 10000
```

This script normalizes valid vectors, computes exact cosine pairs, retains every
source in the resulting connected components, and exports chronological metadata,
pair scores and the input file hash. It refuses inputs above its work limit and
refuses to write a misleading partial result when the pair cap is exceeded.
Use a scoped shard with id/title/date/newspaper and the requested embedding column.
Connected components are candidates for close reading; transitive membership and
threshold scores do not establish copying or a transmission direction.
