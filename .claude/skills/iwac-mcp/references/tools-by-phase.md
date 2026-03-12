# IWAC MCP Tools by Research Phase

15 tools organized by the workflow phase where they are most useful.

## Phase 1: Scoping Tools

### get_collection_stats
Overall collection statistics: subset record counts, articles by country, date range, newspaper count.
- No parameters
- Use first to understand scale

### get_country_comparison
Compare statistics across all 6 countries.
- No parameters
- Returns per-country article counts, newspaper counts, sentiment summaries

### get_newspaper_stats
Newspaper-level statistics.
- `country` (optional): filter by country
- Returns newspaper names, article counts, date ranges

### list_subjects
List subject terms sorted by frequency.
- `limit` (default 50, max 200)
- Returns subject names with descriptions

### list_locations
List geographic locations from index.
- `country` (optional): filter
- `limit` (default 50)

### list_persons
List persons from index.
- `country` (optional): filter
- `limit` (default 50)

---

## Phase 2: Systematic Search Tools

### semantic_search_articles
Semantic similarity search using Gemini embeddings of full article text (OCR).
- `query`: Natural language query in **any language** (multilingual Gemini model handles translation)
- `country` (optional): post-filter by country
- `newspaper` (optional): post-filter by newspaper
- `date_from` (optional): post-filter YYYY-MM-DD
- `date_to` (optional): post-filter YYYY-MM-DD
- `limit` (default 10, max 50)
- Returns: articles ranked by semantic similarity with `similarity_score`

**When to use:** For conceptual or thematic queries where exact keyword matching is insufficient. For example, "Islamic education reform" will find articles about madrasa modernization, Franco-Arabic schooling, and curriculum debates even if those exact words are not used. Unlike `search_articles`, queries can be in any language (English, French, Arabic, etc.). Requires `IWAC_SEMANTIC_SEARCH_ENABLED=true` and a Google API key.

**Tip:** Use semantic search as a complement to keyword search, not a replacement. Keyword search (`search_articles`) is precise and deterministic; semantic search surfaces conceptually related articles that keyword search may miss.

### search_articles
Primary search tool for newspaper articles.
- `keyword` (optional): searches title and OCR text **only** (does NOT search subject or spatial fields)
- `country` (optional): country name (see accent note below)
- `newspaper` (optional): newspaper name
- `subject` (optional): searches subject field (pipe-separated values, case-insensitive contains)
- `date_from` (optional): YYYY-MM-DD
- `date_to` (optional): YYYY-MM-DD
- `limit` (default 20, max 100)
- Returns: o:id, title, author, newspaper, country, pub_date, subject, spatial, language, **gemini_polarite**, **gemini_centralite_islam_musulmans**, **gemini_subjectivite_score**, url

**Tip:** Results include Gemini sentiment scores inline. This enables topic-specific sentiment analysis directly from search results — no need to call `get_article` on each result just to get sentiment data. To find articles about a known subject, prefer the `subject` parameter over `keyword`.

### search_index
Search authority records (persons, places, organizations, subjects, events).
- `query`: search term (matches Titre field)
- `index_type` (optional): "Personnes", "Lieux", "Organisations", "Evenements", "Sujets"
- `limit` (default 20)
- Returns: o:id, Titre, Type, Description, frequency, countries

### search_by_sentiment
Search articles by Gemini AI sentiment analysis.
- `polarity` (optional): "Très positif", "Positif", "Neutre", "Négatif", "Très négatif" (unaccented variants also accepted)
- `centrality` (optional): "Très central", "Central", "Secondaire", "Marginal", "Non abordé" (unaccented variants also accepted)
- `country` (optional): filter
- `subject` (optional): filter by subject (enables topic-specific sentiment searches)
- `limit` (default 20)

### search_publications
Search Islamic publications subset. Note: most publications are entire issues (not individual articles) with limited metadata.
- `keyword` (optional): search term
- `country` (optional): filter
- `limit` (default 20)

### search_references
Search academic references subset.
- `keyword` (optional): search term (searches title + abstract). Abstracts are multilingual -- search both French and English terms. One term per call (substring match, not Boolean).
- `author` (optional): author name
- `reference_type` (optional): e.g., "Article de revue", "Chapitre", "These", "Livre"
- `limit` (default 20)

### list_audiovisual
List audiovisual materials.
- `country` (optional): filter
- `limit` (default 20)

---

## Phase 3: Deep Reading Tools

### get_article
Full article details including OCR text.
- `article_id` (int): Omeka item ID
- Returns all fields including full OCR text, sentiment scores

### get_index_entry
Detailed index entry.
- `entry_id` (int): Omeka item ID
- Returns full metadata, frequency, first/last occurrence, countries

---

## Phase 4: Triangulation Tools

### get_sentiment_distribution
Aggregated Gemini sentiment statistics across the collection.
- `country` (optional): filter
- `newspaper` (optional): filter
- `subject` (optional): filter by subject (enables topic-specific sentiment distributions)
- Returns polarity and centrality distribution counts

**Tip:** Use `subject` to get sentiment breakdowns for specific topics. For example, `get_sentiment_distribution(subject="Laïcité", country="Burkina Faso")` gives the polarity distribution for laïcité articles in BF specifically, rather than the whole corpus.

---

## Valid Filter Values

### Countries
**IMPORTANT:** Côte d'Ivoire requires the accent on the "ô". Use `Côte d'Ivoire`, not `Cote d'Ivoire`. Other country names: Benin, Burkina Faso, Niger, Togo, Nigeria.

### Polarity Scale
Très positif, Positif, Neutre, Négatif, Très négatif (unaccented variants also accepted)

### Centrality Scale
Très central, Central, Secondaire, Marginal, Non abordé (unaccented variants also accepted)

### Index Types
Personnes, Lieux, Organisations, Evenements, Sujets

### Reference Types
Article de revue, Chapitre, These, Livre, Rapport, Compte rendu, Ouvrage collectif, Entree encyclopedique

---

## Token Efficiency Tips

- Use `limit=5` or `limit=10` for exploratory queries
- Use `search_articles` (returns metadata + Gemini sentiment) before `get_article` (returns full OCR text). You can build sentiment tables directly from search results.
- Use stats and distribution tools for overview before searching for individual items
- Combine filters (country + keyword + date range) to narrow results before reading
- For temporal filtering, use `date_from` and `date_to` with YYYY-MM-DD format (e.g., `date_from="1970-01-01"`, `date_to="1979-12-31"` for the 1970s)
