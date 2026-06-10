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

Structured methodology for academic research using the IWAC MCP server's 22 tools (20 core + 2 optional semantic). Adapted from ALA-compliant archival research practices. Applies to server **v0.6.0+** — all matching is accent- and case-insensitive, and result objects use short English keys (`id`, `date`, `polarity`, `centrality`, `subjectivity`, `description_ai`, `url`).

## Prerequisites

Load reference files **as needed**, not all upfront:

1. **references/tools-by-phase.md** — all 22 tools with parameters, defaults, and verified filter vocabularies. Read before the first search of a session.
2. **references/research-domains.md** — French search terms and transliteration variants by domain. Read when crafting search-term variants (Extended mode, or when a Brief search comes back thin).
3. **references/biases-and-limitations.md** — collection biases, coverage gaps, sentiment caveats. Read before writing the synthesis.

For data schema and Omeka S API details, defer to the `iwac-data` skill.

## Research Depth

**Before any research, present the user with an explicit choice:**

> How deep should I go?
> - [ ] **Brief** -- Quick overview: article counts, key titles, top actors. ~2-3 min.
> - [ ] **Extended** -- Full 5-phase analysis: multiple search variants, full-text reading, sentiment comparison, cross-subset triangulation, confidence grading. ~5 min.

Wait for the user to choose before proceeding.

### Brief mode workflow
1. Run Phase 1 scoping (stats, country comparison, relevant subjects) in a single parallel batch.
2. Run Phase 2 with **one primary search per filter combination** (e.g., subject tag + country + date range). Skip keyword variants and supplementary searches. Use `limit=10` and `with_description=true` so each hit carries its AI abstract.
3. Run a **lightweight Phase 3**: pick the 2-3 most relevant articles (triage on `description_ai`) and call `get_article` to read their OCR text. Skip `get_sentiment_distribution`.
4. Skip Phase 4 (triangulation).
5. Produce a Phase 5 synthesis that draws on both metadata and the articles read. Keep it concise but substantive.

### Extended mode workflow
Follow the full five-phase workflow described below. Use multiple search term variants, read key articles in full, run topic-specific sentiment analysis, and produce a detailed synthesis with confidence grading.

If the user does not specify, **default to Brief mode** and mention that an extended analysis is available.

## Critical Search Rules

1. **Articles and publications are French-language sources** — develop keyword terms in French. **References are bilingual** (537 FR / 300 EN): always search them with French AND English terms. Semantic search tools accept queries in any language.
2. **Accents no longer matter for matching** (server ≥ 0.6.0 folds accents and case on both sides): `pelerinage` finds `pèlerinage`, `Bénin` finds `Benin`, `These` finds `Thèse de doctorat`. Still write proper French in outputs.
3. **Country filters take exact names** — `Benin`, `Burkina Faso`, `Côte d'Ivoire`, `Niger`, `Togo` (+ `Nigeria` in references/index/audiovisual only). Partial names ("Burkina") return nothing. Niger no longer over-matches Nigeria.
4. **Know each tool's keyword scope.** Articles: title + OCR + AI abstract. Publications: title + subject + OCR. References: title + abstract, **one term per call** (substring match — "pèlerinage Mecque" as one string misses everything). For curated themes, prefer the `subject` parameter over `keyword`.
5. **Publication discovery does NOT run on tables of contents** — only ~4/1,501 issues have one, so `semantic_search_publications` is near-dead until TOCs are enriched. Navigate via `list_periodicals` (25 series), `subject` (87% tagged), country, and year; use OCR `keyword` for content, and `get_publication_fulltext` (capped keyword excerpts) to read inside one long issue.
6. **Triage on AI abstracts before reading OCR.** `search_articles(with_description=true, limit≤10)` returns each article's ~500-char `description_ai` — usually enough to pick the 2-3 articles worth a full `get_article` (~1k tokens each).
7. **Niger and Nigeria are dramatically underrepresented.** Always disclose this in cross-country comparisons (see biases-and-limitations.md §2).

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
1. Develop search terms in French (primary) with transliteration variants for Arabic/Islamic terminology
2. Search incrementally -- one term or filter combination at a time
3. Use `search_articles` with keyword, country, newspaper, subject, and date range filters. Results include Gemini sentiment (`polarity`, `centrality`, `subjectivity`) inline; add `with_description=true` for AI abstracts.
4. Use `semantic_search_articles` (if enabled) for conceptual or thematic queries where exact keywords may miss relevant articles -- queries can be in any language. Use alongside keyword search, not as a replacement.
5. Use `search_index` to find persons, organizations, places, and events; note the canonical form, then search articles with it
6. Use `search_by_sentiment` for specific polarity/centrality patterns (supports `subject` for topic-specific slices)
7. Use `search_publications` (series/subject/country/year filters + OCR keyword) for Islamic community media
8. Use `search_references` for academic literature -- French AND English terms, one keyword per call; drill into promising hits with `get_reference` (full abstract, 51% have one)
9. Use `search_documents` when grassroots/association sources could matter (26 items, mostly Burkina Faso)
10. **Record every search and its result count**, including zero-result searches -- null results constrain interpretation
11. Use `date_from`/`date_to` for temporal filtering -- articles take `YYYY-MM-DD` or `YYYY` (day precision); publications and references take years

**Constraint:** Substring matching only -- no wildcards, fuzzy, or Boolean operators. Accent/case differences are handled by the server.

### Phase 3 -- Deep Reading

**Goal:** Examine individual items in detail for high-value hits.

**Actions:**
1. Use `get_article` for full article detail: metadata, `description_ai`, sentiment, OCR text (capped at 25k chars)
2. Use `get_reference` for the full scholarly abstract and host-work details
3. Use `get_publication_fulltext` with a `keyword` for capped excerpts inside a long issue (`match_count` tells you the total; `excerpts_returned` what you got)
4. Use `get_index_entry` / `get_document` for authority records and archival documents
5. Cross-reference article subjects and spatial fields with index entries
6. Note the IWAC URL for each item to enable verification against the original source

**Constraint:** Triage on `description_ai` first; request full OCR only for the finalists.

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
6. **Offer follow-up questions.** End every synthesis with 2-4 concrete follow-up research questions the user could explore next. These should branch naturally from the findings -- e.g., drilling into a specific actor, comparing with another country, examining a different time period, or exploring a related theme the data surfaced. Frame them as actionable prompts the user can pick up directly.

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
7. **Publications are mostly entire issues.** Individual articles within an issue are not separated; use `get_publication_fulltext` keyword excerpts to localise content inside an issue.
