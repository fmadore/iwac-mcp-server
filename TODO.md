# TODO

> Larger features — remote transport, auth, zero-config semantic search, skill
> portability — are tracked as
> [GitHub issues](https://github.com/fmadore/iwac-mcp-server/issues). This file
> covers smaller items and project ops. Completed work lives in the git history
> (Track 1 plumbing shipped in v0.5.0; the data-alignment + token audit shipped
> in v0.6.0).

## Distribution & Roadmap

- [x] **Publish to the official MCP Registry** — automated since v0.9.0: the
  tag workflow generates `server.json` (`mcpb/scripts/make-server-json.mjs`)
  and publishes `io.github.fmadore/iwac-mcp-server` (2 `.mcpb` packages + the
  `islam.zmo.de/mcp` remote) via `mcp-publisher` GitHub OIDC. Versions are
  immutable — fixing an entry means bumping and re-tagging. The Anthropic
  directory below is a separate, manual submission.

- [ ] **Submit to the Anthropic extension directory**
  Fill out the interest form:
  <https://docs.google.com/forms/d/e/1FAIpQLScHtjkiCNjpqnWtFLIQStChXlvVcvX8NPXkMfjtYPDPymgang/viewform>
  Prereqs: public GitHub repo ✓, MIT licence ✓, Node.js ✓, valid `manifest.json`
  with `author` pointing at the GitHub profile ✓.
  See also Anthropic's Software Directory Policy:
  <https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy>

- [ ] **Code-sign the `.mcpb`** with a trusted code-signing cert
  (DigiCert / SSL.com, ~$100/yr) so Claude Desktop stops showing the generic
  "grants access to everything" warning. Self-signed certs don't help — Claude
  Desktop only trusts real CAs. Command:
  `mcpb sign iwac-mcp-server.mcpb --cert prod.pem --key prod.key`

- [ ] **Zero-config semantic search with a free local model** — see
  [#5](https://github.com/fmadore/iwac-mcp-server/issues/5). Requires
  re-embedding the HF corpus with the chosen model (corpus + query must use the
  same model). Candidates: `Qwen3-Embedding-0.6B/4B`, `BGE-M3`,
  `EmbeddingGemma-300M`, or the older `multilingual-e5-small` /
  `paraphrase-multilingual-MiniLM-L12-v2`.

- [ ] **Remote transport / hosted deployments** — see
  [#1](https://github.com/fmadore/iwac-mcp-server/issues/1) (transport-agnostic
  refactor), [#2](https://github.com/fmadore/iwac-mcp-server/issues/2)
  (Streamable-HTTP), [#3](https://github.com/fmadore/iwac-mcp-server/issues/3)
  (auth + rate limiting).

- [ ] **Add `screenshots/`** showing a research query in Claude Desktop — the
  directory listing surfaces these.

- [ ] **Migrate to MCP TypeScript SDK v2** (after its stable release alongside
  the 2026-07-28 spec — verified July 2026: `2.0.0-beta.2` current, v1.x is
  maintenance-only). Breaking for this server: scoped packages
  (`@modelcontextprotocol/server`), raw Zod shapes replaced by Standard Schema
  objects (`z.object(...)`), `serveStdio()` / `createMcpHandler()` replacing the
  v1 stdio + StreamableHTTP transports (stateless core). Start with the official
  codemod (`npx @modelcontextprotocol/codemod@beta v1-to-v2 .`), then re-run the
  fixture + live test suites. Re-check the final 2026-07-28 changelog first —
  details were RC-stage when noted.

## Data Enrichment (Track 2 — runs in the IWAC-Hugging-Face pipeline, not here)

> Governing rule: all AI enrichment is precomputed offline as HF columns and
> served as cheap column lookups. The MCP server never generates at request
> time. Whole-issue work is map-reduce (chunk → per-chunk extract → reduce) in
> monthly batches, so no single call is large. Verified fill rates that motivate
> this list (June 2026): references abstract 51% / subject 27%; publications TOC
> **325/1,501** (complete for 17/25 series; Islam Info, An-Nasr Vendredi and
> Islam Hebdo still have none), subject 87%, OCR 97% (median ~16k, max ~278k
> tokens/issue); audiovisual descriptionAI **0/45**.

### References (864 rows)

- [ ] **Auto-tag `subject`** from title+abstract (only 27% tagged today),
  aligned to the index `Sujets` controlled vocabulary. The
  `search_references(subject=…)` filter already exists — this raises its
  coverage from 27% toward the whole subset.
- [ ] **Backfill missing `abstract`** (51% present) from Crossref (DOI — 31%
  have one) and OpenAlex (title match). Fetch *real* abstracts; do not generate
  them from a bare title.
- [ ] **Compute `embedding_abstract`** (over title+abstract, same Gemini model /
  768-dim as articles) → enables a new `semantic_search_references` tool. Tiny
  corpus (864 rows), large payoff: connects secondary scholarship to the same
  semantic surface as the articles.

### Publications (1,501 rows)

- [ ] **Extract `tableOfContents` from OCR** — **mostly done (June 2026):**
  325/1,501 issues now have a TOC + `embedding_tableOfContents`, covering 17 of
  the 25 series completely (avg TOC ~6.4k chars). `semantic_search_publications`
  and the `matching_toc_entries` path now work for those series. Remaining: the
  three largest series — Islam Info (695 issues), An-Nasr Vendredi (318),
  Islam Hebdo (122) — plus 5 small series (~41 issues).
- [ ] **Per-issue `descriptionAI`** (2–4 sentences: themes, notable pieces).
  Publications have *no* summary surface at all today.
- [ ] (stretch) **Article-level publications index** — explode extracted TOCs
  into one row per article (issue_id, page, title, author) as a small new
  table/subset, so users can search *within* periodicals without loading a
  full (up to ~278k-token) OCR blob.

### Audiovisual (45 rows)

- [ ] **Populate `descriptionAI`** — the column exists but is empty for all
  45 rows (`length(trim(...)) = 0`; a bare `COUNT()` claims 45/45 because the
  parquet stores empty strings, not NULLs). The recordings are Hausa/Arabic
  content, so per-item AI descriptions are the only browsable surface.

### Server tools that light up once the columns land

- `semantic_search_references` — new tool, needs `embedding_abstract`.
- `semantic_search_publications` — ✅ now useful for the 17 TOC-covered series;
  corpus-wide once Islam Info / An-Nasr Vendredi / Islam Hebdo TOCs land.
- `search_publications` — returns AI summaries once `descriptionAI` is populated
  (add a description column to `publicationSummaryCols`).

## Skill Improvements

- [ ] **Persona-based research framing** — branch research on *lens* (Islamic
  scholar / historian / media studies), informed by local scholars & imams, as
  a framing axis alongside the Brief/Extended depth choice. See
  [#6](https://github.com/fmadore/iwac-mcp-server/issues/6).

- [ ] **Enrich `research-domains.md` with actual IWAC frequency data**
  Use `list_subjects` (214 subjects), `list_persons`, and `list_locations` to
  replace manually curated search terms with data-grounded suggestions
  including actual frequencies.

- [ ] **Publish the `iwac-mcp` research skill to the Claude Skills repository**
  (it already ships as a standalone `iwac-mcp-skill.zip` release asset on every
  tag — this item is about the Skills library specifically). Source of truth is
  `.agents/skills/iwac-mcp/`. Related but distinct from
  [#4](https://github.com/fmadore/iwac-mcp-server/issues/4) (adapting the skill
  for non-Claude models). NB: the copy in the claude.ai Skills library
  (`anthropic-skills:iwac-mcp`) predates v0.5 — replace it with
  `.agents/skills/iwac-mcp/` or delete it.
