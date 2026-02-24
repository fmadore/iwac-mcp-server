---
name: iwac-mcp
description: |
  Structured academic research workflow for the Islam West Africa Collection (IWAC) MCP server.
  Use this skill when:
  - Conducting research queries through the IWAC MCP server (iwac-mcp-server tools)
  - Investigating questions about Islam and Muslims in West Africa using IWAC data
  - Performing systematic searches across IWAC articles, publications, index, or references
  - Analyzing sentiment or temporal patterns in West African press coverage
  - Comparing coverage across countries, newspapers, or time periods
  - Building structured research outputs with source attribution and confidence grading
  This skill provides a five-phase research methodology, search strategy guidance for francophone sources, bias awareness, and documentation conventions. It complements the iwac-dataset skill (data schema) and iwac-api skill (Omeka S endpoints).
---

# IWAC MCP Research Workflow

Structured methodology for academic research using the IWAC MCP server's 16 tools. Adapted from ALA-compliant archival research practices.

## Prerequisites

Before beginning a research session, read the relevant reference files:

1. **references/tools-by-phase.md** -- all 16 MCP tools mapped to workflow phases with parameters
2. **references/research-domains.md** -- key research domains with French search terms and transliteration variants
3. **references/biases-and-limitations.md** -- collection biases, coverage gaps, and OCR quality considerations

For data schema details, defer to the `iwac-dataset` skill. For Omeka S API details, defer to the `iwac-api` skill.

## Research Depth

Before starting, ask the user which depth they prefer:

| Mode | Phases | What you get | Typical time |
|------|--------|-------------|-------------|
| **Brief** | Scoping + focused search | Collection stats, article counts, key article titles, top organizations/persons. No full-text reading or sentiment comparison. A concise summary with source links. | ~2-3 minutes |
| **Extended** | All five phases | Full systematic search across multiple term variants, deep reading of OCR text for key articles, AI sentiment comparison, cross-subset triangulation, and a detailed synthesis with confidence grading and limitations. | ~10-15 minutes |

### Brief mode workflow
1. Run Phase 1 scoping (stats, country comparison, relevant subjects) in a single parallel batch.
2. Run Phase 2 with **one primary search per filter combination** (e.g., subject tag + country + date range). Skip keyword variants and supplementary searches. Use limit=10.
3. Skip Phases 3-4 entirely. Do not call `get_article`, `compare_ai_sentiments`, or `get_sentiment_distribution`.
4. Produce a Phase 5 synthesis based on article metadata only (titles, dates, newspapers, subjects). Flag that no OCR text was examined and evidence strength is preliminary.

### Extended mode workflow
Follow the full five-phase workflow described below. Use multiple search term variants, read key articles in full, run sentiment comparisons, and produce a detailed synthesis with confidence grading.

If the user does not specify, **default to brief mode** and mention that an extended analysis is available.

## Critical Search Rules

1. **All search terms must be in French.** Even if the research question is in English, translate every query to French before searching. The collection has no English-language indexing.
2. **Use `Côte d'Ivoire` with the accent** (circumflex ô). Without the accent, the country filter returns 0 results.
3. **Niger and Nigeria are dramatically underrepresented.** Niger has ~1,100 articles but many lack subject tagging. Nigeria has ~50 items (audiovisual only, no press articles). Always disclose this when making cross-country comparisons.
4. **Keyword search covers title + OCR only.** It does NOT search subject or spatial fields. For known subjects, use the `subject` parameter instead.

## The Five-Phase Workflow

### Phase 1 -- Scoping

**Goal:** Establish what IWAC contains for the research question and identify coverage boundaries.

**Actions:**
1. Use `get_collection_stats` to understand overall scale (articles, publications, index entries)
2. Use `get_country_comparison` to assess geographic coverage relevant to the question
3. Use `get_newspaper_stats` with country filter to identify which newspapers cover the topic
4. Use `list_subjects` to discover relevant subject terms in the thematic index
5. Identify which subsets are relevant: articles (press), publications (Islamic media), references (scholarship), index (authority records)

**Constraint:** Keep `limit` low (10-25) during scoping to save tokens. Use brief queries first, then drill down.

### Phase 2 -- Systematic Search

**Goal:** Map the search space using structured queries, building a record of what exists and what is absent.

**Actions:**
1. Develop search terms in French (primary) with transliteration variants for Arabic/Islamic terminology
2. Search incrementally -- one term or filter combination at a time
3. Use `search_articles` with keyword, country, newspaper, subject, and date range filters
4. Use `search_index` to find persons, organizations, places, and events relevant to the question
5. Use `search_by_sentiment` to identify articles with specific polarity or centrality patterns
6. Use `search_publications` for Islamic community publications (note: most are entire issues with limited metadata, not individual articles)
7. Use `search_references` to find relevant academic literature in the collection (search terms must be in French)
8. **Record every search and its result count**, including zero-result searches -- null results constrain interpretation
9. Use `date_from` and `date_to` for temporal filtering (e.g., `date_from="1970-01-01"`, `date_to="1979-12-31"` for the 1970s)

**Constraint:** IWAC uses keyword matching, not Solr syntax. Searches are case-insensitive string contains operations on title and OCR fields. No wildcards, fuzzy, or Boolean operators.

### Phase 3 -- Deep Reading

**Goal:** Examine individual items in detail for high-value hits.

**Actions:**
1. Use `get_article` to retrieve full article details including OCR text
2. Use `get_index_entry` to retrieve detailed authority records for key persons, organizations, or places
3. Use `compare_ai_sentiments` to examine how three AI models assessed a specific article
4. Cross-reference article subjects and spatial fields with index entries
5. Note the IWAC URL for each item to enable verification against the original source

**Constraint:** Full article responses include OCR text (often thousands of words). Request specific articles by ID rather than retrieving large result sets with full text.

### Phase 4 -- Triangulation

**Goal:** Verify findings against multiple evidence types and identify gaps.

**Actions:**
1. Cross-reference MCP findings across subsets (articles vs. publications vs. references vs. index)
2. Use `get_sentiment_distribution` to contextualize individual article sentiments against the collection baseline
3. Compare AI sentiment across models (Gemini, ChatGPT, Mistral) -- agreement strengthens confidence, disagreement flags ambiguity
4. Flag coverage gaps: which countries, time periods, or languages are underrepresented for this question?

### Phase 5 -- Synthesis

**Goal:** Produce structured findings with explicit source attribution and confidence grading.

**Actions:**
1. Tag every claim with its **source type**: MCP article, MCP index, MCP publication, MCP reference, MCP sentiment analysis, external source
2. Tag every claim with its **evidence strength** using the three-tier scale below
3. Document null results alongside positive findings
4. Separate primary evidence (articles, publications) from secondary evidence (references, index metadata) from AI-derived evidence (sentiment)
5. Note any limitations specific to the research question (see biases-and-limitations.md)

## Confidence Grading

| Grade | Meaning | IWAC Example |
|-------|---------|-------------|
| **Strong** | Direct attestation in multiple primary sources | Article OCR text names a person/event, corroborated by index entry and other articles |
| **Moderate** | Supported by clear but indirect evidence | Sentiment trend across multiple articles suggests a pattern; single article attestation |
| **Weak** | Inferred from limited evidence or argument from silence | Subject absent from coverage (may reflect collection gaps, not historical absence) |

## Documentation Conventions

**For MCP article citations:** Item ID, title, newspaper, date, country, IWAC URL. Example: `#5736, "La communaute musulmane celebre le Maouloud", Togo-Presse, 2005-04-23, Togo, https://islam.zmo.de/s/westafrica/item/5736`

**For MCP index citations:** Entry ID, title, type, frequency. Example: `Index #1234, "CERFI", Organisation, frequency: 45`

**For null results:** `Search for [term] in [tool] with [parameters] returned 0 results.`

**For AI sentiment findings:** Always specify which model(s) and note agreement/disagreement across models.

## Language and Search Strategy

- **French is primary** (~96% of articles). All search terms must be in French -- never use English terms even if the user's question is in English.
- **Arabic-Islamic terms** appear in French transliteration. Account for variants:
  - Mawlid = Maouloud, Maoulid, Mouloud
  - Sharia = charia, chari'a
  - Eid al-Adha = Tabaski, Aid el-Kebir
  - Eid al-Fitr = Aid el-Fitr, Korite
- **Subjects and spatial fields** are pipe-separated multi-value strings. Use the `subject` parameter (not `keyword`) to search these.
- **Country accent:** Always use `Côte d'Ivoire` (with ô), never `Cote d'Ivoire`.
- See **references/research-domains.md** for comprehensive term lists by domain.

## Key Constraints

1. **Never present search results as exhaustive.** IWAC is a curated collection, not a complete archive. Absence of evidence is not evidence of absence.
2. **Always disclose the francophone bias.** ~96% French-language sources specifically reflect Western-educated Muslim perspectives (those who followed French-speaking, secular, or Christian school curricula). *Arabisants* -- leaders trained in madrasas who use Arabic or national languages -- are underrepresented as direct voices, though the French press regularly reports on their activities.
3. **Always disclose the Niger/Nigeria gap.** Niger has thin coverage with inconsistent subject tagging. Nigeria has virtually no press coverage (audiovisual only). These gaps must be stated in any cross-country analysis.
4. **Always distinguish source types.** MCP tool outputs, AI sentiment labels, and OCR text have different evidential status.
5. **OCR quality varies.** 1960s-1980s newspaper scans may have poor OCR. Do not treat OCR text as authoritative without noting this caveat.
6. **AI sentiment is interpretive, not factual.** Three models sometimes disagree. Treat sentiment labels as analytical signals, not ground truth.
7. **Search incrementally.** Keep limits low, search one dimension at a time, avoid retrieving full OCR text unless needed.
8. **Publications are mostly entire issues.** The `search_publications` tool covers Islamic community publications, but most items are complete issues rather than individual articles, with limited metadata.
