# Decisions in force

The choices that govern the code and should not be undone without an argument
in review. Source comments cite them by number. Larger features are tracked as
[GitHub issues](https://github.com/fmadore/iwac-mcp-server/issues); smaller
items in [TODO.md](../TODO.md).

| # | Decision |
|---|---|
| D1 | **Read-only.** No tool writes to the archive or the dataset. |
| D2 | **Data from the Hugging Face dataset**, lazily downloaded per subset and queried through DuckDB views; the server never queries islam.zmo.de's Omeka S at request time. |
| D3 | **Every result carries its canonical `url`** on islam.zmo.de; citations use it. |
| D4 | **Public by default.** The private full mirror needs an explicit opt-in, and HTTP mode serves it only with a second flag (`IWAC_ALLOW_PRIVATE_HTTP`). |
| D5 | **HTTP mode refuses to start without a bearer token.** The public endpoint is open through nginx, which holds the token; the container is never reachable unauthenticated. |
| D6 | **Tool names are stable**: tools are added, not renamed. |
| D7 | **One keyword rule** (v5.0.0): every word must occur, a quoted phrase as written, `keyword_mode: "literal"` for one substring. |
| D8 | **Strict inputs** (v5.0.0): unknown argument names are errors. |
| D9 | **Instructions ≤ 2,048 characters**, citation rule and interpretive guardrails first; methods live in the skill. |
| D10 | **Token discipline is gated**: the always-on footprint against a committed baseline under a 16,000-token ceiling, and every tool's worst case under 20,000 tokens. |
| D11 | **Provenance on every success**: the full record in `_meta`, a compact summary in text, the snapshot id hashing the file identities. |
| D12 | **Registrations are recorded once and replayed** onto each per-request server; handlers hold no per-server state. |
| D13 | **Per-OS desktop bundles**, because DuckDB and onnxruntime are native. |
| D14 | **The Node major is coordinated by hand** across the Dockerfile, the workflows, `engines` and `@types/node`; Dependabot never moves it. |
| D15 | **Releases are immutable**: a version published on GitHub or the MCP Registry is never replaced; fix with a new version. The published bytes are the tested bytes. |
| D16 | **The skill has one source**, `.agents/skills/iwac-mcp/`, embedded at build time and served over SEP-2640. |
