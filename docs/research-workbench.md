# Research workbench (v3.8)

The workbench connects an analytical selection to its source records. It uses the
same DuckDB corpus and self-contained MCP App as the existing tools. There are
35 default tools and three optional semantic-query tools; `explore_corpus` is the
only new tool. No external chart service is required.

## Selections

`explore_corpus` accepts `subset`, `mode`, and a nested `selection`. It defaults
to article items, with 20 records per page. `limit` is 1–50; `offset` starts at 0.
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
  subject, spatial, author, language, country, newspaper, topic_id and min_prob.
  Numeric topic/probability values are represented as strings in this map.
- `exact["polarity:<model>"]` selects an exact model label. Centrality and
  subjectivity accept the same syntax. `exact.scored_by` requires a polarity
  annotation from every listed model; disagreement-cell navigation preserves
  the comparison's common scored base.
- A filter absent from the chosen subset returns an error. No filter is silently
  ignored. Topic clicks use stable topic IDs, including when shortened labels
  collide. Place mentions and publication-country shading use separate keys.
- Date bounds must be complete, calendar-valid years, months, days or timestamps.
  Reversed bounds fail. Article dates with year/month precision denote intervals;
  filtering includes intervals that overlap the requested dates. Other workbench
  subsets retain the existing year-level boundary semantics. `hijri_month` and
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
| `get_sentiment_distribution` | Existing model comparison with clickable disputed cells | Preserves both labels and the common scored base; AI labels are annotations |
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
those columns exist, plus text/embedding/scoring coverage. Pipe-joined country
strings remain one category in comparison distributions. Attention splits country
and spatial tags and counts each item once per pair; its cells may therefore sum
to more than the number of items. Reference subject-country tags are deliberately
not treated as publication origins.

## Navigation and exports

Interactive marks preserve the existing selection and intersect the clicked
category. Back restores the previous payload and view options. Loading and tool
errors retain the current view; a late response cannot replace a newer selection.
SVG marks support Enter/Space activation and visible focus. Coverage, comparison,
attention and temporal views provide data tables.

Hosts advertising downloads receive CSV, JSON, and standalone SVG export actions.
CSV/SVG exports include a companion provenance JSON file. SVG exports include
all chart panels and their styles; JSON includes the reconstructed view data,
filters and interpretation notes. Hosts without download support still receive
normal tool results. Actual MCP-host rendering and download dialogs remain a
release acceptance check; the repository tests exercise the host protocol and
real DOM selectors, not a native host installation.

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
limit; tool requests have a 120-second deadline. Cancellation removes queued work,
interrupts DuckDB calls and terminates a projection worker.

Authenticated `GET /metrics` reports active/queued database queries and p50/p95
latency over the last 256 tool calls, plus completed-call count. The existing
unauthenticated `/health` remains unchanged. Metrics describe the running process,
not an externally measured deployment latency guarantee.

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
