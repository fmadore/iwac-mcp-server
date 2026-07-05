# IWAC MCP Tools by Research Phase

27 possible tools (25 core + 2 optional semantic) organized by the workflow phase where they are most useful. Server **v0.8.0+**: **all keyword/filter matching is accent- and case-insensitive**; result rows use short English keys (`id`, `date`, `polarity`, `centrality`, `subjectivity`, `description_ai`, `url`) and omit empty fields. List/search tools return a pagination envelope — `count`, `total_matches`, `offset`, `limit` (applied), `has_more`, `next_offset`, plus `requested_limit` + `limit_warning` when you exceed a tool's max. Enumerated filters (`country`, `polarity`, `centrality`, `index_type`, and on the temporal tool `subset`, `granularity`, `group_by`) are **validated**: an invalid value returns `{error, valid_values}` (`isError`) instead of a silent zero-result. Server **v0.9.0+** adds `get_temporal_distribution` (counts per year/month — use it for any "how did coverage evolve" question instead of paging through searches).

## Cross-Collection Entry Points

### search
Cross-subset search for skill-less clients and quick discovery.
- `query` (required): one concept, name, or short phrase. Tokens are AND-ed across each subset's searchable fields; use French concepts for primary-source discovery, and French/English terms for references.
- `limit` (default 20, max 50)
- Returns `results` with namespaced ids (`articles:28576`, `references:11045`), `title`, `url`, `category`, plus a `ranking` note. There is no numeric relevance score; for precise filters use the granular `search_*` tools.

### fetch
Fetch one item returned by `search`.
- `id` (required): namespaced id from `search`, e.g. `articles:28576`
- Returns `id`, `title`, `text`, `url`, `category`, and `metadata`. Long text may be capped; when that happens, `recommended_tool` points to the subset-specific full-text tool to call with a `keyword`.

## Phase 1: Scoping Tools

### get_collection_stats
Overall collection statistics: subset record counts, articles by country, date range, newspaper count.
- No parameters. Use first to understand scale. (First call may trigger the parquet download.)

### get_country_comparison
Compare statistics across the 5 article countries (Nigeria has no press articles).
- No parameters
- Returns per-country article counts, newspaper counts, date ranges, Gemini polarity breakdowns

### get_newspaper_stats
Newspaper-level statistics.
- `country` (optional): exact name — Benin | Burkina Faso | Côte d'Ivoire | Niger | Togo
- Returns newspaper names, article counts, date ranges

### list_subjects
List the 214 curated subject terms sorted by frequency.
- `limit` (default 50, max 200), `offset`
- Returns id, title, description, frequency, url

### list_locations
List the 683 geographic locations from the index, ranked by frequency.
- `country` (optional, exact name) — selects places **mentioned in records from that country, not located there** (so Beninese sources surface La Mecque, Côte d'Ivoire, etc.); `frequency` is the entry's collection-wide total, not a per-country count. The response adds a `note` restating this. Nigeria returns nothing (index frequency derives from articles/publications/references).
- `limit` (default 50, max 200), `offset`

### list_persons
List the 2,833 persons from the index, ranked by frequency.
- `country` (optional, exact name) — selects persons **mentioned in records from that country** (same mentioned-in semantics as list_locations; `frequency` is collection-wide).
- `limit` (default 50, max 200), `offset`

### list_periodicals
The 25 Islamic periodical/series titles in the publications subset, with issue counts and year ranges (e.g. Islam Info 695 issues, An-Nasr Vendredi 318, Islam Hebdo 122).
- `country` (optional, exact name)
- Use the returned `newspaper` value as the `newspaper` filter on `search_publications`

---

## Phase 2: Systematic Search Tools

### search_articles
Primary search tool for the 12,287 newspaper articles.
- `keyword` (optional): substring match on **title + OCR + AI abstract** (does NOT search subject/spatial — use the `subject` parameter for curated tags)
- `country` (optional): exact name — Benin | Burkina Faso | Côte d'Ivoire | Niger | Togo
- `newspaper` (optional): substring match
- `subject` (optional): substring match on the pipe-separated curated tags
- `date_from` / `date_to` (optional): `YYYY-MM-DD` or `YYYY` (day precision)
- `with_description` (optional, boolean): include each article's ~500-char AI abstract (`description_ai`) — ~125 tokens/row, pair with limit ≤ 10
- `limit` (default 20, max 100), `offset`
- Returns: id, title, author, newspaper, country, date, subject, spatial, language, **polarity**, **centrality**, **subjectivity**, url

**Tip:** Sentiment comes inline — build topic-specific sentiment tables directly from search results. With `with_description=true` you can usually pick the 2-3 articles worth a full `get_article` without any intermediate calls.

### semantic_search_articles *(optional — requires semantic search enabled + Google API key)*
Semantic similarity over article OCR via Gemini embeddings. Coverage is effectively complete: 12,286/12,287 articles are embedded.
- `query`: natural language, **any language**
- `country` / `newspaper` / `date_from` / `date_to` (optional post-filters), `limit` (default 10, max 50)
- Returns article summaries ranked by `similarity_score`
- Complement to keyword search for conceptual queries ("Islamic education reform" finds madrasa modernization, Franco-Arabic schooling…). Not a replacement.

### search_index
Search the 4,697 authority records by name.
- `keyword`: matched against the entry title (accent-insensitive)
- `index_type` (optional): exact type, **validated** (accents optional) — Personnes | Lieux | Organisations | Événements | Sujets | Notices d'autorité; an unrecognised value errors with `valid_values`
- `limit` (default 20, max 100), `offset`
- Returns: id, title, type, description, frequency, first_occurrence, last_occurrence, countries, url

### search_by_sentiment
Filter articles by Gemini sentiment labels (exact match, accents optional).
- `polarity` (optional): Très positif | Positif | Neutre | Négatif | Très négatif | Non applicable
- `centrality` (optional): Très central | Central | Secondaire | Marginal | Non abordé
- `country` (optional, exact name), `subject` (optional)
- `limit` (default 20, max 100), `offset`

### search_publications
Search the 1,501 Islamic publications (mostly complete periodical issues; OCR is 97% filled, median ~16k tokens/issue).
- `keyword` (optional): substring match on title + subject + **table of contents** + OCR
- `newspaper` (optional): periodical/series title — discover via `list_periodicals`
- `subject` (optional): ~87% of issues are tagged
- `country` (optional, exact name)
- `date_from` / `date_to` (optional): years (YYYY)
- `limit` (default 20, max 100), `offset`
- Returns: id, title, newspaper, country, date, language, subject, nb_pages, url — plus `matching_toc_entries` when the keyword hits an issue's table of contents (325/1,501 issues have one; see `semantic_search_publications` below for series coverage)

### search_references
Search the 864 academic references. The records are multilingual: search title/abstract keywords in French and English when relevant. Metadata/filter values such as `reference_type` and `language` use French labels.
- `keyword` (optional): substring on title + abstract. **One term per call** ("pèlerinage Mecque" as one string misses results with only one word). Try French and English concept terms when searching abstracts.
- `author` (optional)
- `reference_type` (optional), substring match. Values: Article de revue (298) | Chapitre de livre (246) | Livre (101) | Mémoire de maitrise (62) | Rapport (49) | Thèse de doctorat (42) | Communication scientifique | Compte rendu de livre | Article d'encyclopédie | Mémoire de licence | Article de blog | Working paper. Use the full label — "Livre" alone also matches "Chapitre de livre" and "Compte rendu de livre".
- `subject` (optional): sparse, ~27% tagged
- `country` (optional, exact name; Nigeria valid here)
- `language` (optional): Français | Anglais
- `date_from` / `date_to` (optional): years
- `limit` (default 20, max 100), `offset`
- Returns summary + `abstract_snippet` (320 chars) + doi — full abstract via `get_reference`

### search_documents
Search the 26 archival documents (Islamic association reports, flyers, project documents — 19 Burkina Faso, 4 Togo, 2 Benin). All have OCR + AI description.
- `keyword` (optional): substring on title + OCR + AI description + subject
- `country` (optional, exact name), `limit` (default 15, max 50), `offset`
- Call with no arguments to list all 26.

### list_audiovisual
The 45 audiovisual items — all Nigeria, incl. Hausa/Arabic recordings. (AI descriptions not yet populated in the dataset.)
- `country` (optional), `limit` (default 20, max 50), `offset`
- Returns: id, title, creator, publisher, country, date, medium, extent, subject, spatial, language, media_url, url

### search_audiovisual
Search the audiovisual subset by title/metadata. Useful because AI descriptions are currently empty.
- `keyword` (optional): substring over title, creator, publisher, subject, spatial, language, source, and AI description where present
- `country` (optional), `language` (optional exact pipe value), `medium` (audio | video), `subject` (optional exact tag), `limit` (default 20, max 50), `offset`
- Returns the same summary fields as `list_audiovisual`

### semantic_search_publications *(optional — requires semantic search enabled + Google API key)*
Semantic similarity over publication **tables of contents** via Gemini embeddings. TOC coverage (verified June 2026): **325/1,501 issues (~22%)**, all embedded — **complete for 17 of the 25 series** (Le Rendez-Vous 78, Plume Libre 49, L'Appel 48, Alif 32, La Preuve 28, An-Nasr Trimestriel 16, Le CERFIste 13, Al-Azan 13, ASSALAM 11, Al Mawadda 11, Al Maoulid Info 7, Le Pacific 6, Al Maoulid Magazine 5, AJMCI Infos 4, Al Muwassat Info 2, Bulletin d'information du CNI 1, Les Échos de l'AEEMCI 1), but **zero for the three largest** (Islam Info 695, An-Nasr Vendredi 318, Islam Hebdo 122) and five other small series.
- `query` (natural language, any language), `country` (optional), `limit` (default 10, max 50)
- Good for conceptual discovery inside the covered magazines; for Islam Info / An-Nasr Vendredi / Islam Hebdo, fall back to `search_publications` keyword + subject.

---

## Phase 3: Deep Reading Tools

### get_article
Full article detail.
- `article_id` (int)
- `+ keyword` → ~2000-char excerpts around matches instead of full OCR: `context_chars` (default 2000, max 5000), `max_excerpts` (default 10, max 25); `match_count` / `excerpts_returned` as in get_publication_fulltext
- Returns: id, identifier, title, author, newspaper, country, date, subject, spatial, language, nb_pages, url, **description_ai** (~500-char AI abstract), polarity, centrality, subjectivity, word_count, lexical_richness, readability, ocr_text (capped at 25k chars; only 48 articles exceed it)

### get_reference
Full bibliographic record for one academic reference.
- `reference_id` (int)
- Returns the complete abstract (51% have one), subjects, DOI, external_url, host-work details (book_title, volume, issue, pages), language, country

### get_publication_fulltext
OCR text of one publication. Two modes:
- `publication_id` (int) alone → full text capped at 25k chars (`char_count` reports the true size — issues run up to ~1.1M chars)
- `+ keyword` → excerpts around matches: `context_chars` (default 2000, max 5000), `max_excerpts` (default 10, max 25). `match_count` = total matches; `excerpts_returned` = how many you got; a `truncation_message` appears when capped.
- When the issue has a table of contents, the response includes `tableOfContents` (avg ~6.4k chars ≈ 1.6k tokens) — often enough to locate an article without any keyword excerpts.

### get_document
Full archival-document detail (metadata, AI description, capped OCR).
- `document_id` (int)
- `+ keyword` → ~2000-char excerpts around matches instead of full OCR: `context_chars` (default 2000, max 5000), `max_excerpts` (default 10, max 25); `match_count` / `excerpts_returned`. Useful for the handful of documents over 25k chars (e.g. the COSIM statutes).

### get_audiovisual
Full audiovisual metadata.
- `audiovisual_id` (int)
- Returns id, identifier, title, creator, publisher, country, date, media_url, medium, duration (`extent`), subject, spatial, language, source, and IWAC URL.

### get_index_entry
Detailed index entry. **Raw dataset columns, French names** (Titre, Titre alternatif, Type, Description, Prénom, Nom, Coordonnées, frequency, first/last_occurrence, countries…).
- `entry_id` (int)

---

## Phase 4: Triangulation Tools

### get_temporal_distribution *(v0.9.0+)*
Counts of matching items per year (or month) — one call replaces paging through search results for any trend question. Also useful in Phase 1 to scope a topic's timeline before searching.
- `subset` (optional, validated): articles (default) | publications | references | documents | audiovisual
- `granularity` (optional, validated): year (default) | month — items dated only to a year keep a bare-year key even at month granularity
- `keyword` (optional): ONE substring over the subset's text fields (same semantics as the subset's search tool)
- `country` / `newspaper` / `subject` / `date_from` / `date_to` (optional): same semantics as the subset's search tool
- `group_by` (optional, validated): country | newspaper — returns `distribution_by_group` (one map per group) instead of `distribution`
- Returns `total_matches`, `dated_count`, `undated_count` (undated items are counted, never silently dropped), and the `distribution` map sorted by year
- **Tip:** `get_temporal_distribution(keyword="hadj", group_by="country")` charts six decades of hajj coverage per country in a single ~1k-token call.

### get_sentiment_distribution
Aggregated Gemini sentiment counts.
- `country` (optional, exact name), `newspaper` (optional), `subject` (optional)
- Returns `polarity_distribution` and `centrality_distribution` maps + `total_articles`

**Tip:** `get_sentiment_distribution(subject="Laïcité", country="Burkina Faso")` gives the polarity distribution for laïcité articles in BF specifically; compare against the unfiltered country baseline.

---

## Valid Filter Values (verified against the dataset)

**Validation (v0.8.0+):** `country`, `polarity`, `centrality`, and `index_type` are checked accent/case-insensitively; an invalid value returns `{error, valid_values}` (`isError`) — correct and retry. Free-text filters (`newspaper`, `subject`, `author`, `reference_type`, `language`) are **not** validated, so a typo there returns 0 rows silently — sanity-check them.

### Countries
Exact names: `Benin`, `Burkina Faso`, `Côte d'Ivoire`, `Niger`, `Togo`, `Nigeria` (all six are accepted everywhere; `Nigeria` simply yields 0 press articles — a real finding, not an error). Accents are optional (`Bénin` works); partial names (`Burkina`) are invalid and now error.

### Polarity scale (articles, Gemini)
Très positif (1,400) | Positif (5,984) | Neutre (3,999) | Négatif (569) | Très négatif (24) | Non applicable (311)

### Centrality scale (articles, Gemini)
Très central (8,130) | Central (1,538) | Secondaire (942) | Marginal (1,366) | Non abordé (311)

### Subjectivity (articles, Gemini)
Score 1 (very objective) → 5 (very subjective)

### Index types
Personnes (2,833) | Lieux (683) | Organisations (413) | Notices d'autorité (312) | Événements (242) | Sujets (214)

### Reference types
See `search_references` above (12 values, with counts).

---

## Token Efficiency Tips

- Budget guide: a Brief run should stay around ≤25k tokens of tool output; an Extended run typically lands at 50-120k. Past that, stop searching and synthesize.
- Default limits are 20 for the main searches (15 for documents) — raise toward `max` only when you need breadth; `total_matches` + `has_more` tell you what's there without fetching it. Asking past a tool's `max` doesn't fail — the page is capped and `limit_warning` + `requested_limit` flag it — so there's no point requesting 500
- Stop rule: when two consecutive search variants surface no new items, the dimension is saturated — move on
- Triage with `with_description=true` (limit ≤ 10) instead of calling `get_article` on everything; read full OCR only for the 2-3 finalists (Brief) / 6-8 (Extended)
- A `search_articles` page of 20 ≈ 2.5k tokens; `get_article` ≈ 1-7k tokens; capped `get_publication_fulltext` ≤ ~7k tokens (+ ~1.6k when the issue has a TOC)
- Use stats/distribution tools for overviews before fetching individual items; when `total_matches` exceeds ~50, analyze metadata rather than reading items
- For "how did coverage evolve" questions, one `get_temporal_distribution` call (~1k tokens) replaces paging through result envelopes year by year
- Combine filters (country + subject/keyword + date range) to narrow before reading
- For temporal filtering: articles take `YYYY-MM-DD` or `YYYY`; publications/references take years
