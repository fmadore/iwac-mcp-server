# IWAC MCP Tools by Research Phase

16 tools organized by the workflow phase where they are most useful.

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

### search_articles
Primary search tool for newspaper articles.
- `keyword` (optional): searches title and OCR text **only** (does NOT search subject or spatial fields)
- `country` (optional): country name (see accent note below)
- `newspaper` (optional): newspaper name
- `subject` (optional): searches subject field (pipe-separated values, case-insensitive contains)
- `date_from` (optional): YYYY-MM-DD
- `date_to` (optional): YYYY-MM-DD
- `limit` (default 20, max 100)
- Returns: o:id, title, author, newspaper, country, pub_date, subject, spatial, language, url

**Tip:** To find articles about a known subject, prefer the `subject` parameter over `keyword`. To find articles about a known index entry, first get its ID via `search_index`, then use the subject's exact title with the `subject` parameter.

### search_index
Search authority records (persons, places, organizations, subjects, events).
- `query`: search term (matches Titre field)
- `index_type` (optional): "Personnes", "Lieux", "Organisations", "Evenements", "Sujets"
- `limit` (default 20)
- Returns: o:id, Titre, Type, Description, frequency, countries

### search_by_sentiment
Search articles by AI sentiment analysis.
- `polarity` (optional): "Très positif", "Positif", "Neutre", "Négatif", "Très négatif" (unaccented variants also accepted)
- `centrality` (optional): "Très central", "Central", "Secondaire", "Marginal", "Non abordé" (unaccented variants also accepted)
- `model` (default "gemini"): "gemini", "chatgpt", "mistral"
- `country` (optional): filter
- `limit` (default 20)

### search_publications
Search Islamic publications subset. Note: most publications are entire issues (not individual articles) with limited metadata.
- `keyword` (optional): search term
- `country` (optional): filter
- `limit` (default 20)

### search_references
Search academic references subset.
- `keyword` (optional): search term (must be in French -- the collection has no English-language indexing)
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

### compare_ai_sentiments
Side-by-side comparison of Gemini, ChatGPT, and Mistral sentiment for one article.
- `article_id` (int): Omeka item ID
- Returns polarity, centrality, subjectivity, and justifications from all 3 models

---

## Phase 4: Triangulation Tools

### get_sentiment_distribution
Aggregated sentiment statistics across the collection.
- `country` (optional): filter
- `newspaper` (optional): filter
- `model` (default "gemini"): "gemini", "chatgpt", "mistral"
- Returns polarity and centrality distribution counts

---

## Valid Filter Values

### Countries
**IMPORTANT:** Côte d'Ivoire requires the accent on the "ô". Use `Côte d'Ivoire`, not `Cote d'Ivoire`. Other country names: Benin, Burkina Faso, Niger, Togo, Nigeria.

### Polarity Scale
Très positif, Positif, Neutre, Négatif, Très négatif (unaccented variants also accepted)

### Centrality Scale
Très central, Central, Secondaire, Marginal, Non abordé (unaccented variants also accepted)

### Sentiment Models
gemini, chatgpt, mistral

### Index Types
Personnes, Lieux, Organisations, Evenements, Sujets

### Reference Types
Article de revue, Chapitre, These, Livre, Rapport, Compte rendu, Ouvrage collectif, Entree encyclopedique

---

## Token Efficiency Tips

- Use `limit=5` or `limit=10` for exploratory queries
- Use `search_articles` (returns metadata only) before `get_article` (returns full OCR text)
- Use stats and distribution tools for overview before searching for individual items
- Combine filters (country + keyword + date range) to narrow results before reading
- For temporal filtering, use `date_from` and `date_to` with YYYY-MM-DD format (e.g., `date_from="1970-01-01"`, `date_to="1979-12-31"` for the 1970s)
