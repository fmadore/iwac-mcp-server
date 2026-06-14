# IWAC MCP Tools by Research Phase

22 tools (20 core + 2 optional semantic) organized by the workflow phase where they are most useful. Server v0.6.0+: **all keyword/filter matching is accent- and case-insensitive**; result rows use short English keys (`id`, `date`, `polarity`, `centrality`, `subjectivity`, `description_ai`, `url`) and omit empty fields.

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
List the 683 geographic locations from the index.
- `country` (optional, exact name), `limit` (default 50, max 200), `offset`

### list_persons
List the 2,833 persons from the index.
- `country` (optional, exact name), `limit` (default 50, max 200), `offset`

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
- `index_type` (optional): Personnes | Lieux | Organisations | Événements | Sujets | Notices d'autorité
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
Search the 864 academic references. **Bilingual** — search French AND English terms.
- `keyword` (optional): substring on title + abstract. **One term per call** ("pèlerinage Mecque" as one string misses results with only one word)
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

### semantic_search_publications *(optional — requires semantic search enabled + Google API key)*
Semantic similarity over publication **tables of contents** via Gemini embeddings. TOC coverage (verified June 2026): **325/1,501 issues (~22%)**, all embedded — **complete for 17 of the 25 series** (Le Rendez-Vous 78, Plume Libre 49, L'Appel 48, Alif 32, La Preuve 28, An-Nasr Trimestriel 16, Le CERFIste 13, Al-Azan 13, ASSALAM 11, Al Mawadda 11, Al Maoulid Info 7, Le Pacific 6, Al Maoulid Magazine 5, AJMCI Infos 4, Al Muwassat Info 2, Bulletin d'information du CNI 1, Les Échos de l'AEEMCI 1), but **zero for the three largest** (Islam Info 695, An-Nasr Vendredi 318, Islam Hebdo 122) and five other small series.
- `query` (any language), `country` (optional), `limit` (default 10, max 50)
- Good for conceptual discovery inside the covered magazines; for Islam Info / An-Nasr Vendredi / Islam Hebdo, fall back to `search_publications` keyword + subject.

---

## Phase 3: Deep Reading Tools

### get_article
Full article detail.
- `article_id` (int)
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

### get_index_entry
Detailed index entry. **Raw dataset columns, French names** (Titre, Titre alternatif, Type, Description, Prénom, Nom, Coordonnées, frequency, first/last_occurrence, countries…).
- `entry_id` (int)

---

## Phase 4: Triangulation Tools

### get_sentiment_distribution
Aggregated Gemini sentiment counts.
- `country` (optional, exact name), `newspaper` (optional), `subject` (optional)
- Returns `polarity_distribution` and `centrality_distribution` maps + `total_articles`

**Tip:** `get_sentiment_distribution(subject="Laïcité", country="Burkina Faso")` gives the polarity distribution for laïcité articles in BF specifically; compare against the unfiltered country baseline.

---

## Valid Filter Values (verified against the dataset)

### Countries
Exact names: `Benin`, `Burkina Faso`, `Côte d'Ivoire`, `Niger`, `Togo` — plus `Nigeria` in references, index and audiovisual only (no Nigerian press articles). Accents are optional (`Bénin` works); partial names (`Burkina`) do not.

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
- Default limits are 20 for the main searches (15 for documents) — raise toward `max` only when you need breadth; `total_matches` + `has_more` tell you what's there without fetching it
- Stop rule: when two consecutive search variants surface no new items, the dimension is saturated — move on
- Triage with `with_description=true` (limit ≤ 10) instead of calling `get_article` on everything; read full OCR only for the 2-3 finalists (Brief) / 6-8 (Extended)
- A `search_articles` page of 20 ≈ 2.5k tokens; `get_article` ≈ 1-7k tokens; capped `get_publication_fulltext` ≤ ~7k tokens (+ ~1.6k when the issue has a TOC)
- Use stats/distribution tools for overviews before fetching individual items; when `total_matches` exceeds ~50, analyze metadata rather than reading items
- Combine filters (country + subject/keyword + date range) to narrow before reading
- For temporal filtering: articles take `YYYY-MM-DD` or `YYYY`; publications/references take years
