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
