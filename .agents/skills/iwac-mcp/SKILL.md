---
name: iwac-mcp
description: |
  Structured academic research workflow for the Islam West Africa Collection (IWAC) MCP server.
  Use this skill when:
  - Conducting research queries through the IWAC MCP server (iwac-mcp-server tools)
  - Investigating questions about Islam and Muslims in West Africa using IWAC data
  - Performing systematic searches across IWAC articles, publications, index, references, or documents
  - Analyzing sentiment or temporal patterns in West African press coverage
  - Comparing coverage across countries, newspapers, or time periods
  - Building structured research outputs with source attribution and confidence grading
  This skill provides a five-phase research methodology, search strategy guidance for francophone sources, bias awareness, and documentation conventions. It complements the iwac-data skill (data schemas + Omeka S API).
---

# IWAC MCP Research Workflow

Structured methodology for academic research using the IWAC MCP server's 26 possible tools (24 core + 2 optional semantic). Adapted from ALA-compliant archival research practices. Applies to server **v0.8.0+** — all matching is accent- and case-insensitive; result objects use short English keys (`id`, `date`, `polarity`, `centrality`, `subjectivity`, `description_ai`, `url`); list/search tools return a pagination envelope (`count`, `total_matches`, `offset`, `limit`, `has_more`, `next_offset`); and enumerated filters are validated (see **Reading Results & Errors** below).

## Prerequisites

Load reference files **as needed**, not all upfront:

1. **references/tools-by-phase.md** — all 26 possible tools with parameters, defaults, and verified filter vocabularies. Read before the first search of a session.
2. **references/research-domains.md** — French search terms and transliteration variants by domain. Read when crafting search-term variants (Extended mode, or when a Brief search comes back thin).
3. **references/biases-and-limitations.md** — collection biases, coverage gaps, sentiment caveats. Read before writing the synthesis.
4. **references/capabilities-overview.md** — plain-language description of the collection and recommended ways into the data. Read when the user asks what you can do (see "Capability Questions" below).

For data schema and Omeka S API details, defer to the `iwac-data` skill.

## Capability Questions

When the user asks what you can do with IWAC ("what can you do?", "qu'est-ce que tu peux faire ?", "what's in this collection?", "how could I search this?"), do **not** launch the research workflow, present the depth choice, or enumerate the 26 tools. Read **references/capabilities-overview.md** and answer in plain language, in the user's language:

1. One short paragraph on what the collection is and covers.
2. The main ways into the data (keyword, curated themes, people/organizations, semantic, sentiment, periodicals, scholarship) — described as research moves, not tool names.
3. Three to five example research questions, tailored to anything the user has already mentioned.

Close by inviting a research question. Present the Brief/Extended choice only once an actual question is on the table.

## Response and Query Language

Mirror the user's question language in the report, synthesis, capability answer, and follow-up questions. If the user asks in English, write the final answer in English; if they ask in French, write it in French; if mixed, use the dominant language.

Always formulate keyword/substr search strings and concept keywords in French for press articles, publications, documents, and index searches, including when the user's question is in another language. Translate concepts before keyword searching (`pilgrimage` -> `pèlerinage`, `secularism` -> `laïcité`, `Islamic education` -> `enseignement islamique`). For academic references, run title/abstract keyword searches in French **and** English when relevant; metadata/filter labels such as `reference_type` and `language` use French values. This rule does **not** apply to `semantic_search_articles` or `semantic_search_publications`: semantic embedding queries may be written in any language. Keep proper names, quoted titles, and canonical filter values exact; do not translate item titles or citation text.

## Research Depth

**Before any research, present the user with an explicit choice:**

> How deep should I go?
> - [ ] **Brief** -- Quick overview: article counts, key titles, top actors, plus a close reading of 2-3 key articles.
> - [ ] **Extended** -- Full 5-phase analysis: multiple search variants, full-text reading, sentiment comparison, cross-subset triangulation, confidence grading. Takes considerably more time — and tokens — than Brief.

Do not attach time estimates to the options. Wait for the user to choose before proceeding.

### Brief mode workflow
1. Run Phase 1 scoping (stats, country comparison, relevant subjects) in a single parallel batch — but only the calls the question actually needs. Corpus sizes, country lists, and filter vocabularies are already documented in this skill and tools-by-phase.md; don't spend calls rediscovering them.
2. Run Phase 2 with **one primary search per filter combination** (e.g., subject tag + country + date range). Skip keyword variants and supplementary searches. Use `limit=10` and `with_description=true` so each hit carries its AI abstract.
3. Run a **lightweight Phase 3**: pick the 2-3 most relevant articles (triage on `description_ai`) and call `get_article` to read their OCR text. Skip `get_sentiment_distribution`.
4. Skip Phase 4 (triangulation).
5. Produce a Phase 5 synthesis that draws on both metadata and the articles read. Keep it concise but substantive — and still open with the one-line evidence-base ledger (items read in full vs. triaged on AI abstracts vs. surveyed by count).

### Extended mode workflow
Follow the full five-phase workflow described below. Use multiple search term variants, read key articles in full, run topic-specific sentiment analysis, and produce a detailed synthesis with confidence grading.

If the user does not specify, **default to Brief mode** and mention that an extended analysis is available.

## Token Budget

Comprehensiveness has a token price — spend deliberately. The goal is a well-evidenced answer, not an exhaustive dump.

- **Brief** should stay around ≤25k tokens of tool output: one scoping batch, a handful of searches at the default limit (20 rows; drop to ≤10 when adding `with_description`), 2-3 full articles.
- **Extended** typically lands at 50-120k tokens of tool output. Past that, returns diminish — stop searching and synthesize what you have.
- **Stop rules:** when two consecutive search variants surface no new items, that dimension is saturated — move on. When `total_matches` exceeds ~50, analyze the metadata (counts, dates, newspapers, sentiment) instead of reading items; read only the triaged finalists.
- **Counting ≠ fetching.** `total_matches` and the stats/distribution tools answer "how much / when / what tone" without retrieving rows. Never page through a large result set, and never set limit=100 "just in case".
- **Full text is the expensive part** (`get_article` ≈ 1-7k tokens; `get_publication_fulltext` up to ~7k, plus ~1.6k when the issue has a TOC). Cap full reads at 2-3 (Brief) / 6-8 (Extended), always triaged on `description_ai` first. For a long item, pass a `keyword` to `get_article` / `get_document` / `get_publication_fulltext` to pull just the relevant ~2000-char windows instead of the whole capped OCR.
- If a question genuinely requires bulk reading (dozens of full articles), say what it will cost and confirm with the user before doing it.

## Critical Search Rules

1. **Keyword search terms must be French for primary-source subsets** — develop keyword terms in French for articles, publications, documents, and index searches. Academic references are multilingual: search titles/abstracts with French and English concept terms when relevant, while keeping metadata/filter values in French. Semantic embedding queries may be in any language.
2. **Accents no longer matter for matching** (server ≥ 0.6.0 folds accents and case on both sides): `pelerinage` finds `pèlerinage`, `Bénin` finds `Benin`, `These` finds `Thèse de doctorat`. Still write proper French in outputs.
3. **Enumerated filters are validated — an invalid value is a hard error, not a silent zero.** `country` (`Benin`, `Burkina Faso`, `Côte d'Ivoire`, `Niger`, `Nigeria`, `Togo`), `polarity`, `centrality`, and `index_type` are checked accent/case-insensitively; an unrecognised value returns `{error, valid_values}` (`isError`) — pick the right value and retry, never read it as a finding. A **valid** value that yields 0 rows (e.g. `country="Nigeria"` on `search_articles`) is a real finding. Partial names ("Burkina") are invalid. Free-text filters (`newspaper`, `subject`, `author`, `reference_type`, `language`) are **not** validated — a typo there still returns 0 silently, so sanity-check them.
4. **Know each tool's keyword scope.** Articles: title + OCR + AI abstract. Publications: title + subject + OCR. References: title + abstract, **one term per call** (substring match — "pèlerinage Mecque" as one string misses everything). For curated themes, prefer the `subject` parameter over `keyword`.
5. **Tables of contents now cover part of the publications corpus** (verified June 2026): 325/1,501 issues (~22%) have a TOC + embedding — complete for 17 of the 25 series (the smaller magazines: Le Rendez-Vous, Plume Libre, L'Appel, Alif, La Preuve, An-Nasr Trimestriel, Le CERFIste…), but absent for the three largest (Islam Info 695 issues, An-Nasr Vendredi 318, Islam Hebdo 122). `search_publications` keyword also matches TOCs and returns the matching entries as `matching_toc_entries`; `semantic_search_publications` is genuinely useful for the TOC-covered series. For the big three series, navigate via `list_periodicals`, `subject` (87% tagged), country, and year; use OCR `keyword` for content, and `get_publication_fulltext` (capped keyword excerpts) to read inside one long issue.
6. **Triage on AI abstracts before reading OCR.** `search_articles(with_description=true, limit≤10)` returns each article's ~500-char `description_ai` — usually enough to pick the 2-3 articles worth a full `get_article` (~1k tokens each).
7. **Niger and Nigeria are dramatically underrepresented.** Always disclose this in cross-country comparisons (see biases-and-limitations.md §2).

## Reading Results & Errors

- **Pagination envelope.** Every list/search tool returns `count` (rows in this page), `total_matches` (the full count — use it to gauge scale without paging), `offset`, `limit` (the applied limit), `has_more`, and `next_offset`. Read `total_matches` and decide; don't page blindly.
- **Limits are capped visibly, not silently.** Ask for more than a tool's max and the response still caps the page, but flags it: `limit` shows the applied value and `requested_limit` + `limit_warning` record what you asked for. There's no "limit=500 just in case" — you'll get the max with a warning, never the 500.
- **Validation errors self-correct.** An invalid `country` / `polarity` / `centrality` / `index_type` returns `{error, valid_values}` with `isError`. Choose from `valid_values` and retry; never report the error as a substantive result, and never read a validation error as "no coverage."
- **`list_locations` / `list_persons` country semantics.** The `country` filter means *mentioned in records from that country*, not *located there* — so `list_locations(country="Benin")` surfaces foreign places (La Mecque, Côte d'Ivoire) that Beninese sources discuss, and `frequency` is the entry's **collection-wide** total, not a per-country count. The response carries a `note` restating this. Nigeria returns nothing here because index frequency derives from articles/publications/references, which have no Nigerian items.
- **Cross-collection `search` / `fetch`** (mainly for skill-less clients, but available): `search` tags each hit with its `category` and adds a top-level `ranking` note — substring match, round-robin interleave across categories, frequency/recency tiebreak, **no relevance score**; prefer the granular `search_*` tools when you need filters. When `fetch` truncates long OCR it sets `text_truncated` and names a `recommended_tool` (`get_article` / `get_publication_fulltext` / `get_document`) to call with a `keyword` for focused excerpts.

## The Five-Phase Workflow

### Phase 1 -- Scoping

**Goal:** Establish what IWAC contains for the research question and identify coverage boundaries.

**Actions:**
1. Use `get_collection_stats` to understand overall scale (articles, publications, index entries)
2. Use `get_country_comparison` to assess geographic coverage relevant to the question
3. Use `get_newspaper_stats` with country filter to identify which newspapers cover the topic
4. Use `list_subjects` to discover relevant subject terms; `list_periodicals` if Islamic publications are in scope
5. Identify which subsets are relevant: articles (press), publications (Islamic media), references (scholarship), documents (association papers), index (authority records)

**Constraint:** Keep `limit` low (5-10) during scoping to save tokens. Use brief queries first, then drill down.

### Phase 2 -- Systematic Search

**Goal:** Map the search space using structured queries, building a record of what exists and what is absent.

**Actions:**
1. Develop search terms in French with transliteration variants for Arabic/Islamic terminology, even when the user asks the research question in another language
2. Search incrementally -- one term or filter combination at a time
3. Use `search_articles` with keyword, country, newspaper, subject, and date range filters. Results include Gemini sentiment (`polarity`, `centrality`, `subjectivity`) inline; add `with_description=true` for AI abstracts.
4. Use `semantic_search_articles` (if enabled) for conceptual or thematic queries where exact keywords may miss relevant articles -- semantic embedding queries may be in any language. Use alongside keyword search, not as a replacement.
5. Use `search_index` to find persons, organizations, places, and events; note the canonical form, then search articles with it
6. Use `search_by_sentiment` for specific polarity/centrality patterns (supports `subject` for topic-specific slices)
7. Use `search_publications` (series/subject/country/year filters; keyword matches title + subject + TOC + OCR, with TOC hits returned as `matching_toc_entries`) for Islamic community media; `semantic_search_publications` (if enabled) works for the 17 TOC-covered series
8. Use `search_references` for academic literature -- one keyword per call; search title/abstract keywords in French and English when relevant, while using French metadata/filter values; drill into promising hits with `get_reference` (full abstract, 51% have one)
9. Use `search_documents` when grassroots/association sources could matter (26 items, mostly Burkina Faso)
10. Use `search_audiovisual` / `list_audiovisual` when Nigerian Hausa/Arabic recordings are in scope (45 items; AI descriptions are currently empty)
11. **Record every search and its result count**, including zero-result searches -- null results constrain interpretation
12. Use `date_from`/`date_to` for temporal filtering -- articles take `YYYY-MM-DD` or `YYYY` (day precision); publications and references take years

**Constraint:** Substring matching only -- no wildcards, fuzzy, or Boolean operators. Accent/case differences are handled by the server.

### Phase 3 -- Deep Reading

**Goal:** Examine individual items in detail for high-value hits.

**Actions:**
1. Use `get_article` for full article detail: metadata, `description_ai`, sentiment, OCR text (capped at 25k chars). Pass a `keyword` to get focused ~2000-char excerpts around matches instead of the whole OCR — useful for long articles.
2. Use `get_reference` for the full scholarly abstract and host-work details
3. Use `get_publication_fulltext` with a `keyword` for capped excerpts inside a long issue (`match_count` tells you the total; `excerpts_returned` what you got)
4. Use `get_index_entry` for authority records, `get_document` for archival documents, and `get_audiovisual` for full audiovisual metadata — `get_document` also takes a `keyword` (with `context_chars` / `max_excerpts`) for excerpts inside a long document, the same windowing as `get_publication_fulltext`
5. Cross-reference article subjects and spatial fields with index entries
6. Note the IWAC URL for each item to enable verification against the original source

**Constraint:** Triage on `description_ai` first; request full OCR only for the finalists — and for a long item, prefer a `keyword` excerpt (`get_article` / `get_document` / `get_publication_fulltext`) over the whole OCR.

### Phase 4 -- Triangulation

**Goal:** Verify findings against multiple evidence types and identify gaps.

**Actions:**
1. Cross-reference MCP findings across subsets (articles vs. publications vs. references vs. documents vs. index)
2. Use `get_sentiment_distribution` with `subject` filter to compare topic-specific sentiment against the collection baseline (e.g., `subject="Laïcité", country="Burkina Faso"` vs. the whole BF corpus)
3. Use `search_articles` results (which include sentiment inline) to build topic-specific sentiment tables without extra calls
4. Flag coverage gaps: which countries, time periods, or languages are underrepresented for this question?

### Phase 5 -- Synthesis

**Goal:** Produce structured findings with explicit source attribution and confidence grading.

**Actions:**
1. Tag every claim with its **source type**: MCP article, MCP index, MCP publication, MCP reference, MCP document, MCP sentiment analysis, external source
2. Tag every claim with its **evidence strength** using the three-tier scale below
3. Document null results alongside positive findings
4. Separate primary evidence (articles, publications, documents) from secondary evidence (references, index metadata) from AI-derived evidence (sentiment, description_ai)
5. Note any limitations specific to the research question (see biases-and-limitations.md)
6. **State the evidence base explicitly.** Open the synthesis with a one-line ledger of what was actually read versus skimmed, so the reader can weigh the findings: how many items were **read in full** (`get_article` / `get_publication_fulltext` / `get_document` / `get_reference`), how many were **triaged on AI abstracts/snippets only** (`description_ai`, `abstract_snippet`, `matching_toc_entries`), and how many total matches were **surveyed by count** (`total_matches`, stats/distribution tools) without retrieval. Example: *"Evidence base: 4 articles read in full, 18 triaged on AI abstracts, ~1,900 keyword matches surveyed by count; plus 2 reference abstracts and 1 archival document read in full."* Never let an AI abstract or snippet stand in for — or read as if it were — the full OCR text.
7. **Offer follow-up questions.** End every synthesis with 2-4 concrete follow-up research questions the user could explore next. These should branch naturally from the findings -- e.g., drilling into a specific actor, comparing with another country, examining a different time period, or exploring a related theme the data surfaced. Frame them as actionable prompts the user can pick up directly.

## Confidence Grading

| Grade | Meaning | IWAC Example |
|-------|---------|-------------|
| **Strong** | Direct attestation in multiple primary sources | Article OCR text names a person/event, corroborated by index entry and other articles |
| **Moderate** | Supported by clear but indirect evidence | Sentiment trend across multiple articles suggests a pattern; single article attestation |
| **Weak** | Inferred from limited evidence or argument from silence | Subject absent from coverage (may reflect collection gaps, not historical absence) |

## Documentation Conventions

**For MCP article citations:** Item ID, title, newspaper, date, country, IWAC URL. Example: `#5736, "La communauté musulmane célèbre le Maouloud", Togo-Presse, 2005-04-23, Togo, https://islam.zmo.de/s/westafrica/item/5736`

**For MCP index citations:** Entry ID, title, type, frequency. Example: `Index #1234, "CERFI", Organisation, frequency: 45`

**For null results:** `Search for [term] in [tool] with [parameters] returned 0 results.`

**For AI sentiment findings:** All sentiment data uses Gemini; the result keys are `polarity`, `centrality`, `subjectivity`. When comparing topics or countries, use `get_sentiment_distribution` with `subject` filter for aggregate data, or tabulate the sentiment columns from `search_articles` results.

**For the evidence-base ledger (open every synthesis with one):** Report three tiers separately — items **read in full**, items **triaged on an AI abstract/snippet only**, and matches **surveyed by count only**. Example: `Evidence base: 4 articles + 1 document read in full; 18 articles triaged on description_ai; 1,909 keyword matches surveyed by count.` This keeps full-text evidence visibly distinct from AI-derived (abstract/snippet) evidence, which carries weaker evidential status.

## Arabic-Islamic Transliteration Variants

Account for French transliterations when searching:
- Mawlid = Maouloud, Maoulid, Mouloud
- Sharia = charia, chari'a
- Eid al-Adha = Tabaski, Aïd el-Kébir
- Eid al-Fitr = Aïd el-Fitr, Korité

See **references/research-domains.md** for comprehensive term lists by domain.

## Key Constraints

1. **Never present search results as exhaustive.** IWAC is a curated collection, not a complete archive. Absence of evidence is not evidence of absence.
2. **Always disclose the francophone bias.** ~96% French-language sources specifically reflect Western-educated Muslim perspectives (those who followed French-speaking, secular, or Christian school curricula). *Arabisants* -- leaders trained in madrasas who use Arabic or national languages -- are underrepresented as direct voices, though the French press regularly reports on their activities.
3. **Always disclose the Niger/Nigeria gap.** Niger has thin coverage (one newspaper, 2018+) with inconsistent subject tagging. Nigeria has no press articles at all (audiovisual only). These gaps must be stated in any cross-country analysis.
4. **Always distinguish source types.** MCP tool outputs, AI sentiment labels, AI abstracts (`description_ai`), and OCR text have different evidential status.
5. **AI sentiment is interpretive, not factual.** Gemini sentiment labels are analytical signals, not ground truth. Use topic-specific sentiment (via `subject` filter) rather than whole-corpus baselines when comparing themes.
6. **Search incrementally.** Keep limits low, search one dimension at a time, avoid retrieving full OCR text unless needed.
7. **Publications are mostly entire issues.** Individual articles within an issue are not separated; use the table of contents where one exists (17 of 25 series) and `get_publication_fulltext` keyword excerpts to localise content inside an issue.
8. **Mind the 1990-91 press-system break.** Pre-1991 articles (~11% of the corpus) come almost entirely from state or single-party organs; the private press only emerges with political liberalisation. Temporal comparisons crossing 1990 compare two different press systems (see biases-and-limitations.md §6).
