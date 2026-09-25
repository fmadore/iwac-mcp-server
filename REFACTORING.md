# Refactoring log

Scope: preserve public tool names, descriptions, schemas, response shapes, and
model/chart data separation while improving internal boundaries.

## Planned commits

- [x] Share embedding validation and normalization; test malformed vectors.
- [x] Extract cohesive modules from `tools/_shared.ts`.
- [x] Split aggregate tools into domain modules with shared filters.
- [x] Share chart payload types and view identifiers across both bundles.
- [x] Share offline integration-test connection and cleanup.

Each implementation commit records its checks below. No dependency changes are
planned. The existing fixture, app, HTTP, skill and token-budget suites remain
the public-contract regression checks.

## Validation and changes

- Baseline: typecheck, lint, and 108 unit tests passed before implementation.
- Embeddings: shared finite/dimension validation and overflow-safe normalization;
  the first valid vector establishes dimension. Invalid stored vectors are skipped,
  invalid query vectors fail explicitly, and zero vectors remain zero. Checks:
  typecheck, lint, 110 unit tests, build, and fixture suite passed. Live Gemini
  calls were not needed for this change and were not run.
- Shared helpers: extracted results, limits, vocabulary, sentiment, calendar,
  pagination, SQL filters, field projections, and text helpers. `_shared.ts` is
  now an 11-line compatibility barrel; extracted modules use direct imports.
  Checks: typecheck, lint, 110 unit tests, build, fixture and token-budget suites
  passed. Tool-definition footprint changed by zero tokens.
- Aggregates: split topics, field/co-occurrence distributions, places, semantic
  tools, and lexical metrics into five domain modules. Each owns its output
  schemas and domain constants; common filters remain shared. Registration order
  is unchanged. Checks: typecheck, lint, build, fixture, app, and token-budget
  suites passed; UI size and tool-definition token footprint are unchanged.
- Chart contracts: all 14 renderer payloads and view identifiers now live in the
  dependency-free `viewContract.ts`. Typed result builders check server writes;
  split summaries forbid chart-only fields. Browser dispatch checks view names,
  including rejection of inherited object keys. Runtime schemas remain unchanged.
  Added runtime and compile-time contract checks. Checks: typecheck, lint, build,
  and the full `npm test` suite passed (112 unit tests plus fixture, app, skills,
  HTTP, tokens). Tool footprint is unchanged; UI is 257.6 KB (300 KB limit).
- Test lifecycle: fixture, app, skills, and token suites now use one configurable
  offline connection scope. Cleanup runs on failure and supports explicit early
  close, preserving original test errors. Degraded/stress caches and modern
  protocol pinning remain configurable. Two lifecycle regression tests passed,
  alongside typecheck, lint, unit, fixture, app, skills, and token checks.
  Most test-file diff lines are indentation under the cleanup scope; use
  `git show --ignore-all-space` to review the substantive changes.
- Final review: finite-vector validation now also rejects sparse arrays, whose
  holes `Array.every()` would otherwise skip. Regression assertions cover both
  validation and normalization. Final verification on 2026-09-07: typecheck,
  lint, build, and the full `npm test` suite passed (112 unit tests, two lifecycle
  tests, fixture, app, skills, HTTP, and token-budget checks). Tool-definition
  footprint remains unchanged. Live dataset/Gemini tests were not run.

## Commit index

- `f023f32`: embedding validation and normalization.
- `1c56956`: shared helper modules.
- `4f4b705`: aggregate domain modules.
- `12c3738`: shared chart payload contracts.
- `cd9d1c6`: offline integration-test lifecycle.
- `c3985d7`: sparse-vector validation and final verification record.

## Release v3.5.2

- Integrated upstream commits `80563b5` and `275a2eb` without rewriting the
  refactoring commits, then synchronized package, lockfile, manifest, and citation
  metadata for v3.5.2 (2026-09-07).
- Refreshed `fast-uri` to 3.1.7 and `qs` to 6.16.0 within the existing dependency
  ranges, along with their compatible dependencies. npm audit reports zero
  vulnerabilities.
- Release checks passed: version consistency, typecheck, lint, build, all 112
  unit tests, two lifecycle tests, fixture, app, skills, HTTP, and token budgets.
  Release notes are in `docs/releases/v3.5.2.md`.

## Review 2026-09-25: efficiency and MCP SDK 2.1

Scope: the same as above. Public tool names, descriptions, schemas and response
shapes are unchanged. The one change on the wire is the capability block,
which now declares `listChanged: false`.

- SDK: `@modelcontextprotocol/server`, `node` and `client` moved to 2.1.0. The
  lockfile refresh cleared the hono advisory, and npm audit now reports 0
  vulnerabilities. ext-apps stays on 1.7.5, because 2.0.0 grows the chart UI
  to 336.6 kb, over the 300 kb gate (see TODO.md).
- DuckDB: each query now takes its own connection from a small pool, instead
  of every query queuing on one shared connection. Measured: `SELECT 1` behind
  a 4.6 s scan took 4.5 s on the shared connection and 5 ms on a second one.
  With the pool, `paginated()` runs COUNT and page together, and
  `get_sentiment_distribution(model="all")` fetches its model blocks together.
- Factory: registrations are recorded once and replayed onto each per-request
  server. JSON Schema conversions are memoized, and every call still returns a
  fresh copy. `createServer()` fell from 13.2 ms to 0.9 ms. Over HTTP,
  `tools/list` fell from 24.9 ms to 9.2 ms and `search` on the fixtures from
  73 ms to 27 ms. The handshake and all list outputs are byte-identical to the
  previous build, with semantic search both off and on.
- Fixes: `foldText` maps U+0130 (İ) to I, restoring its offset stability for
  keyword excerpts. Tools, resources and prompts declare `listChanged: false`,
  since those lists never change.
- Checks: typecheck, lint, build and the full `npm test` passed on Node 24 and
  on the Node 20 runtime floor: 117 unit tests, 3 lifecycle tests, and the
  fixture, app, skills, HTTP and token-budget suites. The token footprint is
  +0. Each new test was confirmed to fail on the old code. The live smoke test
  could not run, because the review sandbox's network policy blocks
  huggingface.co.

### Follow-up (same review): refresh, overlap, determinism

- Refresh: a loaded subset is re-checked every `IWAC_REFRESH_HOURS` (default
  24) in the background, stale-while-revalidate. Downloads are named after a
  digest of their content identity, so a new revision never overwrites a file
  a live view reads. Views read an explicit file list, and one
  `CREATE OR REPLACE VIEW` swaps them. Pruning is a separate step after the
  swap. The embedding index is keyed by view generation. Verified on DuckDB
  that an in-flight query finishes on the old files even when the view is
  replaced and the old file deleted mid-query. Legacy caches keep their Hub
  names and are verified as before.
- Overlap: the stats tools run their independent queries together, and
  semantic search awaits the Gemini call, the index load and the SQL
  prefilter at once.
- Determinism, found while diffing outputs: the pre-review build returned 5
  different outputs in 5 identical runs, because tied or unordered GROUP BY
  results follow DuckDB's parallel aggregation. Every ranking now ends in a
  stable tie-break, and six runs over thirteen tool calls are byte-identical.
- Checks: the full `npm test` passed on Node 24 and Node 20 (120 unit tests).
  New tests cover content naming, legacy reuse, an end-to-end refresh with
  real parquet bytes (served stale first, then swapped, pruned, and a failed
  check tolerated), `IWAC_REFRESH_HOURS` parsing, and the tie-break order.
  Released as v3.7.0 (`docs/releases/v3.7.0.md`).

### Second pass (same review, before tagging v3.7.0)

- Downloads are hashed as they stream and checked against the Hub's size
  and LFS SHA-256 before the rename. A mismatch deletes the partial file and
  writes no manifest. `stream.pipeline` replaces the hand-written pump.
- Concurrency: the connection pool gained a FIFO cap of 16 queries in
  flight. Before the cap, going from one shared connection to the pool had
  also meant going from one query at a time to unbounded.
- Text cuts (`capText`, keyword excerpts, chart-title clipping) no longer
  split surrogate pairs. A reproduction had shown lone surrogates from both
  capText and an excerpt window over emoji-dense text.
- HTTP SIGTERM drains in-flight requests, for up to 8 s, before exiting.
  The old handler reset a request held open across the signal.
- The sentiment tallies within each model block, and the three scans of
  `get_lexical_metrics`, now run together. Output is byte-identical over
  seven calls.
- Considered and not changed: the Parquet metadata cache (no measurable gain
  on local files), UI escaping (audited: data reaches `innerHTML` only
  through `esc()` or as numbers), and rewrites of the `get_similar_items`
  SQL (timings within noise, and one variant still hit DuckDB's NULL-list
  error).
- Checks: every new test fails without its fix; the surrogate test was
  checked against a standalone reproduction instead, since it imports the new
  helper. The full `npm test` passed on Node 24 and Node 20.

### Release packaging (found while preparing the v3.7.0 tag)

- A local dry run of `npm run release` showed the bundles shipped the whole
  development toolchain. `mcpb clean`'s dependency walker stops at the first
  module `.mcpbignore` has already removed, then prunes nothing, and says so
  in its log. Biome's and TypeScript 7's Linux binaries were 33 MB of the
  112 MB macOS bundle, in macOS and Windows bundles alike.
- Worse, `.mcpbignore`'s unanchored `src/` also matched `build/src/` in
  `google-auth-library` and `gaxios`, so `@google/genai` could not be imported
  from a bundle. Confirmed on the published v3.6.0 Windows asset: importing
  it fails with "Cannot find package …/google-auth-library/build/src/index.js".
  Semantic search in Claude Desktop has been broken since the pattern landed
  (2026-07-30). The hosted endpoint builds from `npm ci`, not the bundle, and
  was unaffected.
- `pack-platforms.mjs` now stages each bundle in a temporary directory with
  the manifest, package.json, README, icon, `server/`, and only the runtime
  closure of the esbuild externals (`@duckdb/node-api`, `@google/genai`),
  resolved the way Node resolves them and following dependencies and
  optionalDependencies but not peers. Only the target OS's DuckDB bindings
  are included, and the working tree is never modified. `verifyBundle()`
  unpacks the archive, imports `@google/genai` from it, and checks the DuckDB
  entry and binaries. `.mcpbignore` now anchors root-only paths and serves
  only `npm run pack-mcpb`.
- Result: macOS 112.4 → 70.5 MB, Windows 69.3 → 29.4 MB, 2,961 → 650 files.
  Verified end to end: the unpacked macOS bundle, with this host's Linux
  binding swapped in, answers stats, search, get_article and temporal calls
  over MCP, and semantic search reaches Gemini (HTTP 400 for a dummy key).
  The v3.6.0 bundle fails the same import.
- The release workflow now publishes `docs/releases/<tag>.md` as the GitHub
  release body when that file exists, with the old one-liner as fallback.
  Checked with a stubbed `gh` for all three paths.
