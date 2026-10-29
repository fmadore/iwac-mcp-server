# Contributing

Bug reports, tool-behaviour observations and pull requests are welcome. This
is research infrastructure for the Islam West Africa Collection, so the bar is
"does this stay correct, reproducible and citable", not "does it compile".

## Before you file anything about the *data*

The server serves what the
[IWAC Hugging Face dataset](https://huggingface.co/datasets/fmadore/islam-west-africa-collection)
publishes, which mirrors [islam.zmo.de](https://islam.zmo.de/s/westafrica/). If
a record is wrong, missing or duplicated there, that is a curation matter, not a
bug here. If the dataset holds the right value and a tool returns another, that
*is* a bug here.

## Setup

```bash
cd mcpb
npm ci
npm run install-bindings   # the four macOS/Windows DuckDB binaries, for packing
```

`server/`, `test/fixtures/` and `test/fixtures-stress/` are generated and
git-ignored. The offline suites build synthetic parquet fixtures themselves;
only `npm run test:live` downloads the real dataset (~265 MB) and the query
encoder (~350 MB).

## The loop

```bash
npm run typecheck && npm run lint && npm run build && npm test
```

`npm test` runs the unit, fixture, app, skills, HTTP, token-budget and packaging
suites against the **built** bundle, and refuses a stale build. CI also runs the
real-browser app tests (`npm run test:browser`), the built bundle on the
declared Node floor and on Node 26, the MCP conformance suite, and packs and
executes both desktop bundles on their native platforms.

## Things that will be asked in review

- **Token budget.** The always-on footprint (tool definitions plus
  instructions) sits close to its 16,000-token ceiling, and every tool's worst
  case must stay under 20,000 tokens (`npm run test:tokens`). Prefer a parameter
  on an existing tool, a prompt or a resource to a new tool. A deliberate change
  re-baselines with `node test/token-budget.test.mjs --update`; commit the diff.
- **Instructions stay under 2,048 characters** in every mode
  (`test/instructions.test.ts`). Rules that must survive a host's cut come first;
  methods belong in the skill (`.agents/skills/iwac-mcp/`).
- **Inputs are strict.** Every input schema is a `z.strictObject`, so a
  misspelt argument is an error, never an unfiltered search.
- **Errors carry a stable `code`.** Return failures through `errorResult`; pass
  the code explicitly when the message alone does not imply it.
- **One keyword rule.** Every search and aggregate requires every word, keeps a
  quoted phrase whole, and offers `keyword_mode: "literal"` where the selection
  contract applies (`keywordTerms` in `src/tools/shared/filters.ts`).
- **Every result keeps its canonical `url`.** A result a user cannot cite back
  to islam.zmo.de is a regression.
- **Read-only stays read-only.** No tool writes to the archive.
- **`manifest.json` and the tool surface stay in sync.** The fixture tests
  derive the expected tool list from the manifest.

## Versioning and releases

`npm run set-version -- X.Y.Z` sets the version in `package.json`,
`package-lock.json`, `manifest.json`, `CITATION.cff` and the README citation;
CI checks that they agree. Add a `CHANGELOG.md` entry and release notes in
`docs/releases/vX.Y.Z.md` (the release body) in the same commit. Pushing the
`vX.Y.Z` tag validates, packs, smoke-tests and attests the bundles and the
image, then publishes them. Published versions are immutable: the release guard
refuses a version that exists on GitHub or the MCP Registry, so fix a release
with a new version.

## Commit style

Short imperative subject; say what changed in behaviour rather than which files
moved.
