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
