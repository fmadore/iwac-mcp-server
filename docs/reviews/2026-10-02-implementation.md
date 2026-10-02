# October 2026 review implementation

This change implements the code, protocol, packaging and research improvements
identified in the repository review. No release, registry publication, image push
or deployment is performed by preparing this branch.

## Changes and regression coverage

| Area | Result | Verification |
| --- | --- | --- |
| Keyword safety | Blank/folded-empty terms cannot enter unbounded context loops; excerpt storage is bounded | Query and research regression tests |
| Shared selections | Full-date interval overlap across subsets; exact raw-country grouping; lunar filters survive aggregate handoff | Day/month/range, multi-country and Hijri fixtures |
| Temporal interpretation | Missing, invalid and imprecise dates are disclosed separately; month charts require month precision | Synthetic partial/invalid/range dates |
| Optional metadata | Missing readability columns no longer break other lexical metrics | Older-schema fixture |
| Projection efficiency | DuckDB counts valid/modal-dimension embeddings and limits the sample before JavaScript materialization | Invalid-vector and deterministic-sample fixtures |
| Lifecycle | Downloads, index builds, refreshes and identical embedding requests have shared ownership; individual callers can cancel their wait | First-waiter cancellation, refresh, retry and lock-cleanup tests |
| Provenance | Successful unchanged refresh checks update freshness; pinned requests retain their original snapshot; analysis version is `iwac-research-v2` | Freshness recovery and snapshot tests |
| HF tree traversal | Pagination is followed with path/origin/loop validation | Multi-page and malformed response fixtures |
| MCP | Final Skills manifest sizes/digests/cache metadata; modern and legacy transport coverage; current Apps border metadata | Raw modern HTTP and stdio contract tests |
| App | Successful actions recover, Back clears stale busy state, link fallback is visible, map areas are proportional, exports are complete SVG documents | DOM tests and Chromium iframe tests |
| Research | Bounded manifest/CSL-JSON/BibTeX pages, trustworthy KWIC contexts/offsets/hashes, live schema resources, common-denominator comparison timeline | Citation, schema, pagination and stress fixtures |
| Sentiment | Shared filters, explicit model/scale pair selection, common-scored pair population, Cohen's and quadratic weighted kappa, inline scorer identity | Formula tests, wire nulls, sparse-schema and selected-pair fixtures |
| Docker | Root build context embeds skill; glibc base matches DuckDB binary; authenticated skill and native SQL smoke | Smoke harness; actual image execution in CI |
| Releases | Immutable-version guard precedes publication; publisher/checksum and actions pinned; exact tested artifacts are published | 11 packaging tests, actionlint, native artifact CI |

## MCP Apps interaction follow-up

The migration to `@modelcontextprotocol/ext-apps` 2.0.3 was included in the
original review implementation. The follow-up adopts three existing Apps
capabilities; these are not new library features introduced in patch 2.0.3.

- Fullscreen follows the host's available modes and actual response. Newer
  host mode notifications supersede delayed responses, including an exit from
  fullscreen while a request is pending.
- Successful navigation, Back and local view changes share bounded selection
  context with supporting hosts. Updates are serialized, coalesced and
  deduplicated. Text-only and structured-only hosts receive the modalities they
  advertise. Source bodies, chart coordinates and export contents are excluded;
  abbreviated filters and source lists are explicitly flagged.
- **Ask about this selection** sends a question only on a user click. It includes
  the current compact snapshot even when automatic context is unsupported or
  rejected, so the assistant can retrieve and cite the selected source items.
- Host rejection of downloads, links and messages is surfaced. Cancellation
  retains the previous view, clears busy state and discards late tool responses;
  teardown stops pending context sharing. The app identity version comes from
  the package rather than a separate hardcoded version.

The bundled IWAC skill and user/developer documentation describe these
interactions, capability fallbacks, source retrieval and interpretation of
truncation/provenance. Regression coverage includes bounded context summaries,
concurrent update ordering and real Chromium iframe interactions under CSP.

The semantic-map benchmark on synthetic 10,000 × 768 vectors transferred 230,400
values for a 300-point display instead of 7,680,000 (97% fewer). Observed runtime
and heap improvements are environment-dependent; bounded materialization is the
reliable improvement.

## Dependencies and compatibility

| Dependency | Resolved version |
| --- | --- |
| MCP server / client | 2.2.0 |
| MCP Node adapter | 2.1.0 (latest compatible release) |
| MCP Apps | 2.0.3 |
| DuckDB API and platform bindings | 1.5.6-r.1 |
| Google GenAI | 2.26.0 |
| Zod | 4.6.5 |
| Biome | 2.5.15 |
| tsx | 4.23.15 |
| Node types | 24.19.1 |
| Hono Node adapter override | 2.1.3 |
| brace-expansion | 5.0.12 |
| Playwright (new browser tests) | 1.63.0 |

The next release requires Node >=24.0.0. Node 20 is end of life; older desktop
hosts must update their embedded runtime. The exact Node 24.0.0 floor passed the
built fixture suite. The release version is intentionally unchanged on this
implementation branch; choose a new version and document the runtime compatibility
change before tagging a release.

MCP Apps 2 retains its runtime validators. A self-contained gzip/base64 bootstrap
keeps the wire resource at approximately 161KB (300 KB ceiling); decoded JavaScript
is approximately 412KB (separate 500 KB ceiling). Chromium tests exercise the real
bootstrap under a no-network inline-script CSP and its unsupported-host fallback.

`npm audit --omit=dev` reports zero vulnerabilities. The full audit retains one
unpatched advisory in `node-forge@1.4.0` via development-only `@anthropic-ai/mcpb`
(two affected package entries). See SECURITY.md for scope and recheck conditions;
the runtime container and packaged server exclude that tooling.

## Validation

A clean `npm ci` followed by typecheck, lint, build and `npm test` passed:

- 148 unit tests, 14 integration tests and 11 packaging tests.
- Existing fixture-server assertions, app DOM checks, byte-for-byte Skills
  resources and modern/legacy HTTP/stdio checks.
- Catalogue/instructions: 15,721 / 16,000 tokens (baseline 15,884).
- Largest stress response: 18,162 / 20,000 tokens, including 12-alias KWIC pages.
- Browser smoke: 390 px iframe, repeated downloads, pending navigation/Back,
  focus, standalone SVG parsing/legends/scope, capability fallbacks and gzip boot.
- Workflow actionlint and whitespace checks.
- Both platform archives built and were inspected for exact binding versions,
  both architectures, shared libraries and exclusion of development tooling.

Docker and native macOS/Windows execution cannot run in this Linux workspace;
the PR's reusable artifact workflow performs those checks before publication.
The browser CDN returned truncated archives locally, so local browser validation
used an isolated npm-distributed Chromium 153; CI uses Playwright's standard
Chromium install. No live-dataset or paid-provider smoke was needed for the
synthetic regression suite; the scheduled live smoke remains the dataset-drift gate.

## Primary references

- [MCP 2026-07-28 specification](https://modelcontextprotocol.io/specification/2026-07-28)
- [TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/)
- [SDK v2.2.0 release](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/v2.2.0)
- [Final Skills extension](https://modelcontextprotocol.io/extensions/skills/overview)
- [MCP Apps releases](https://github.com/modelcontextprotocol/ext-apps/releases)
- [Node.js release status](https://nodejs.org/en/about/previous-releases)
- [Unpatched forge advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv)

The first native CI run passed on macOS and in Docker. The Windows artifact
check exposed checkout CRLF conversion of skill sources against the Linux-built
archive's LF bytes. `.gitattributes` now fixes skill source line endings to LF
across platforms, preserving strict byte-for-byte assertions and reproducible
skill digests rather than weakening the test.
The subsequent CI run passed all six active jobs, including both native desktop
platforms and the authenticated container query. Bundled research guidance also
now reflects 35 core/38 possible tools, workbench/export modes and pair-specific
agreement denominators; obsolete confidence-score wording was removed.
