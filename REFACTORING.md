# Refactoring log

Scope: preserve public tool names, descriptions, schemas, response shapes, and
model/chart data separation while improving internal boundaries.

## Planned commits

- [x] Share embedding validation and normalization; test malformed vectors.
- [ ] Extract cohesive modules from `tools/_shared.ts`.
- [ ] Split aggregate tools into domain modules with shared filters.
- [ ] Share chart payload types and view identifiers across both bundles.
- [ ] Share offline integration-test connection and cleanup.

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
