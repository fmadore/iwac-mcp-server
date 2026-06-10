# TODO

> Larger features — remote transport, auth, zero-config semantic search, skill
> portability — are tracked as
> [GitHub issues](https://github.com/fmadore/iwac-mcp-server/issues). This file
> covers smaller items and project ops. Completed work lives in the git history
> (Track 1 plumbing shipped in v0.5.0; the data-alignment + token audit shipped
> in v0.6.0).

## Distribution & Roadmap

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

## Data Enrichment (Track 2 — runs in the IWAC-Hugging-Face pipeline, not here)

> Governing rule: all AI enrichment is precomputed offline as HF columns and
> served as cheap column lookups. The MCP server never generates at request
> time. Whole-issue work is map-reduce (chunk → per-chunk extract → reduce) in
> monthly batches, so no single call is large. Verified fill rates that motivate
> this list: references abstract 51% / subject 27%; publications TOC **4/1,501**,
> subject 87%, OCR 97% (median ~16k, max ~278k tokens/issue); audiovisual
> descriptionAI **0/45**.

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

- [ ] **Extract `tableOfContents` from OCR** — only 4/1,501 issues have a TOC
  today, which is why `semantic_search_publications` and the TOC-match path are
  near-dead. Map-reduce over OCR to extract article-level entries (page, title,
  author); store as `tableOfContents` and recompute `embedding_tableOfContents`.
  Revives both TOC tools corpus-wide.
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
- `semantic_search_publications` — becomes useful once real TOCs/embeddings exist.
- `search_publications` — returns AI summaries once `descriptionAI` is populated
  (add a description column to `publicationSummaryCols`).

## Skill Improvements

- [ ] **Enrich `research-domains.md` with actual IWAC frequency data**
  Use `list_subjects` (200 subjects), `list_persons`, and `list_locations` to
  replace manually curated search terms with data-grounded suggestions
  including actual frequencies.

- [ ] **Publish the `iwac-mcp` research skill** separately (Claude Skills
  repository or as part of the bundle once skill packaging is supported).
  Currently lives under `.claude/skills/iwac-mcp/`. Related but distinct from
  [#4](https://github.com/fmadore/iwac-mcp-server/issues/4) (adapting the skill
  for non-Claude models). NB: the copy in the claude.ai Skills library
  (`anthropic-skills:iwac-mcp`) predates v0.5 — replace it with
  `.claude/skills/iwac-mcp/` or delete it.
