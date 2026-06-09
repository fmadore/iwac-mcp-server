# TODO

> Larger features — remote transport, auth, zero-config semantic search, skill
> portability — are tracked as
> [GitHub issues](https://github.com/fmadore/iwac-mcp-server/issues). This file
> covers smaller items and project ops.

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
> subject 87%, OCR 97% (median ~16k, max ~278k tokens/issue).

### References (864 rows)

- [ ] **Auto-tag `subject`** from title+abstract (only 27% tagged today),
  aligned to the index `Sujets` controlled vocabulary. The
  `search_references(subject=…)` filter already exists (Track 1) — this raises
  its coverage from 27% toward the whole subset.
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
  Publications have *no* summary surface at all today, yet the server already
  references a `descriptionAI` column that does not exist in the data.
- [ ] (stretch) **Article-level publications index** — explode extracted TOCs
  into one row per article (issue_id, page, title, author) as a small new
  table/subset, so users can search *within* periodicals without loading a
  full (up to ~278k-token) OCR blob.

### Server tools that light up once the columns land

- `semantic_search_references` — new tool, needs `embedding_abstract`.
- `semantic_search_publications` — becomes useful once real TOCs/embeddings exist.
- `search_publications` — returns AI summaries once `descriptionAI` is populated
  (revive `publicationSummaryCols`' description column).

## Skill Improvements

- [ ] **Enrich `research-domains.md` with actual IWAC frequency data**
  Use `list_subjects` (200 subjects), `list_persons`, and `list_locations` to
  replace manually curated search terms with data-grounded suggestions
  including actual frequencies.

- [x] ~~**Fix skill docs: references can be in English, not just French**~~

- [ ] **Improve `search_references` guidance** in skill docs. Document that
  `keyword` does a single substring match on title+abstract, so combined terms
  like "pelerinage Mecque" miss results with only one of the words. Call each
  term separately.

- [ ] **Correct the publications guidance.** The TOC is NOT a usable nav
  surface — only 4/1,501 issues have one. Document that discovery now runs on
  `newspaper`/series (use `list_periodicals`), `subject` (87% filled), country
  and year, with keyword search hitting OCR; reserve `get_publication_fulltext`
  (keyword excerpts) for reading inside a single long issue.

## MCP Server Features

### Done (Track 1 — plumbing, no AI, shipped)

- [x] **`get_reference`** — exposes the full abstract (51% of refs) plus DOI,
  subjects, and host-work detail (book/volume/issue/pages) that were previously
  unreadable through the server (there was no detail-fetch tool for references).
- [x] **`search_references` filters** — `subject`, `country`, `language`,
  `date_from`/`date_to`; results now carry an abstract snippet + DOI + country.
- [x] **`search_publications` filters** — `newspaper`, `subject`,
  `date_from`/`date_to`; keyword now matches OCR + subject (not the near-empty
  TOC); summaries carry newspaper/subject/nb_pages.
- [x] **`list_periodicals`** — the 25 periodical series with issue counts and
  year ranges.

### Backlog

- [ ] **Add search by AI-generated abstract for articles**
  Articles have AI-generated abstracts (`descriptionAI`) in the dataset. Let
  `search_articles` match against it (either as a new field or folded into the
  existing keyword search). Abstracts are more structured than raw OCR and
  would improve precision.

- [ ] **Publish the `iwac-mcp` research skill** separately (Claude Skills
  repository or as part of the bundle once skill packaging is supported).
  Currently lives under `.claude/skills/iwac-mcp/`. Related but distinct from
  [#4](https://github.com/fmadore/iwac-mcp-server/issues/4) (adapting the skill
  for non-Claude models).
