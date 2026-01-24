# IWAC MCP Server - Improvements & Future Enhancements

## Current Architecture (v0.2.0)

The server now uses **Hugging Face datasets** instead of the Omeka S API:
- In-memory DataFrame queries (fast after initial load)
- 6 subsets: articles, publications, documents, audiovisual, index, references
- 19 tools covering search, sentiment, topics, and statistics

---

## Potential Improvements

### 1. Output Optimization (HIGH PRIORITY) 📉

**Problem:** Returning 20+ articles with full metadata consumes many LLM tokens.

**Current behavior:**
- `search_articles` returns 20 articles by default with 10 fields each
- Full article response includes OCR text (can be thousands of words)

**Solutions:**

#### Option A: Reduce Default Limits
```python
# Current defaults → Proposed defaults
search_articles:     limit=20 → limit=10
search_by_sentiment: limit=20 → limit=10
search_by_topic:     limit=20 → limit=10
list_subjects:       limit=50 → limit=25
list_locations:      limit=50 → limit=25
list_persons:        limit=50 → limit=25
```

#### Option B: Brief Mode Parameter
```python
@mcp.tool()
def search_articles(
    ...,
    brief: bool = True,  # New parameter
) -> str:
    if brief:
        output_cols = ["o:id", "title", "newspaper", "pub_date", "url"]
    else:
        output_cols = ["o:id", "title", "author", "newspaper", "country",
                       "pub_date", "subject", "spatial", "language", "url"]
```

#### Option C: Configurable Output Fields
```python
@mcp.tool()
def search_articles(
    ...,
    fields: str | None = None,  # e.g., "title,newspaper,date"
) -> str:
    if fields:
        output_cols = ["o:id"] + fields.split(",")
```

#### Option D: Summary Statistics Instead of Full Results
```python
# For exploratory queries, return stats instead of full articles
{
    "total_matches": 150,
    "sample": [...],  # Just 3-5 examples
    "by_country": {"Burkina Faso": 80, "Benin": 70},
    "by_year": {"2020": 30, "2021": 45, ...},
    "top_newspapers": [...]
}
```

---

### 2. Semantic Search (MEDIUM PRIORITY) 🔍

**Problem:** Keyword search misses semantically related articles.

**Current:** Direct string matching on title/OCR
**Proposed:** Use pre-computed embeddings for similarity search

**Implementation:**
```python
# config.py
load_embeddings: bool = False  # Enable when needed
semantic_search_enabled: bool = False

# New tool
@mcp.tool()
def semantic_search(
    query: str,
    country: str | None = None,
    limit: int = 10,
) -> str:
    """Find articles semantically similar to a query.

    Uses multilingual embeddings (paraphrase-multilingual-mpnet-base-v2).
    """
    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer('paraphrase-multilingual-mpnet-base-v2')
    query_vec = model.encode(query)

    df = client.articles
    df['similarity'] = df['embedding_descriptionAI'].apply(
        lambda x: cosine_similarity(x, query_vec) if x is not None else 0
    )

    return df.nlargest(limit, 'similarity')[output_cols].to_json()
```

**Trade-offs:**
- Pros: Much better relevance for conceptual queries
- Cons: Requires loading embeddings (~500MB RAM), slower startup

---

### 3. Query Suggestions & Auto-Complete (LOW PRIORITY) 💡

**Problem:** Users may not know what subjects/topics exist in the collection.

**Solutions:**

#### Option A: Suggest Related Queries
```python
@mcp.tool()
def suggest_queries(partial: str, category: str = "all") -> str:
    """Suggest search queries based on partial input.

    Args:
        partial: Partial search term (e.g., "Ibra")
        category: Filter by 'persons', 'places', 'subjects', or 'all'
    """
    df = client.index
    matches = df[df['Titre'].str.contains(partial, case=False, na=False)]
    return matches[['Titre', 'Type', 'frequency']].head(10).to_json()
```

#### Option B: Popular/Trending Terms
```python
@mcp.tool()
def get_popular_terms(category: str = "subjects", limit: int = 20) -> str:
    """Get most frequently mentioned terms in the collection."""
    df = client.index
    df = df[df['Type'] == category]
    return df.nlargest(limit, 'frequency')[['Titre', 'frequency']].to_json()
```

---

### 4. Time-Series Analysis Tools (MEDIUM PRIORITY) 📈

**Problem:** Understanding temporal trends requires manual date filtering.

**Proposed Tools:**

```python
@mcp.tool()
def get_coverage_timeline(
    country: str | None = None,
    newspaper: str | None = None,
    granularity: str = "year",  # year, month, quarter
) -> str:
    """Get article count over time."""
    df = client.articles
    # Group by time period and count
    ...

@mcp.tool()
def get_sentiment_timeline(
    topic: str | None = None,
    country: str | None = None,
    model: str = "gemini",
) -> str:
    """Track sentiment changes over time for a topic/country."""
    ...

@mcp.tool()
def compare_periods(
    period1: str,  # e.g., "2010-2015"
    period2: str,  # e.g., "2016-2020"
    metric: str = "sentiment",  # sentiment, topics, volume
) -> str:
    """Compare two time periods."""
    ...
```

---

### 5. Cross-Subset Linking (LOW PRIORITY) 🔗

**Problem:** Related items across subsets aren't easily discoverable.

**Examples:**
- Find academic references about a person mentioned in articles
- Link publications to articles that cite them
- Connect audiovisual content to related articles

```python
@mcp.tool()
def find_related(
    item_id: int,
    source_subset: str,  # articles, publications, etc.
    target_subset: str | None = None,  # None = all subsets
) -> str:
    """Find related items across subsets."""
    # Use shared subjects, spatial references, or text similarity
    ...
```

---

### 6. Batch Operations (MEDIUM PRIORITY) ⚡

**Problem:** Getting details for multiple articles requires multiple calls.

```python
@mcp.tool()
def get_articles_batch(article_ids: str) -> str:
    """Get multiple articles by ID.

    Args:
        article_ids: Comma-separated IDs (e.g., "5736,5737,5738")
    """
    ids = [int(x.strip()) for x in article_ids.split(",")]
    df = client.articles
    results = df[df["o:id"].isin([str(i) for i in ids])]
    return results.to_json()
```

---

### 7. Export Tools (LOW PRIORITY) 📤

**Problem:** Users may want to export query results for external analysis.

```python
@mcp.tool()
def export_query_results(
    query_type: str,  # "articles", "sentiment", "topics"
    format: str = "csv",  # csv, json, bibtex
    **query_params
) -> str:
    """Export query results in various formats."""
    ...
```

---

### 8. Caching & Performance (MEDIUM PRIORITY) 💾

**Current:** Dataset loaded fresh each server start (~10-30 seconds)

**Improvements:**

#### Option A: Persistent Cache
```python
# Save processed DataFrames to local parquet files
CACHE_DIR = Path(".cache/iwac")

def load_with_cache(subset: str) -> pd.DataFrame:
    cache_file = CACHE_DIR / f"{subset}.parquet"
    if cache_file.exists():
        return pd.read_parquet(cache_file)

    df = load_from_huggingface(subset)
    df.to_parquet(cache_file)
    return df
```

#### Option B: Background Preloading
```python
# In server.py main()
async def preload_in_background():
    """Preload less-used subsets after server starts."""
    for subset in ["publications", "references", "audiovisual"]:
        client._load_subset(subset)

# Start preloading after main subset is ready
asyncio.create_task(preload_in_background())
```

---

### 9. Error Handling & Validation (HIGH PRIORITY) ⚠️

**Current Issues:**
- Invalid country names silently return empty results
- Date format errors not caught
- Topic IDs not validated

**Improvements:**
```python
VALID_COUNTRIES = ["Benin", "Burkina Faso", "Côte d'Ivoire", "Niger", "Togo", "Nigeria"]
VALID_POLARITIES = ["Très positif", "Positif", "Neutre", "Négatif", "Très négatif"]

def validate_country(country: str) -> str | None:
    """Validate and normalize country name."""
    if not country:
        return None

    # Fuzzy match
    for valid in VALID_COUNTRIES:
        if country.lower() in valid.lower() or valid.lower() in country.lower():
            return valid

    raise ValueError(f"Unknown country: {country}. Valid: {VALID_COUNTRIES}")
```

---

### 10. Documentation Tools (LOW PRIORITY) 📚

```python
@mcp.tool()
def get_dataset_info() -> str:
    """Get information about the IWAC dataset structure and fields."""
    return {
        "subsets": {...},
        "article_fields": [...],
        "sentiment_scales": {...},
        "topic_count": ...,
    }

@mcp.tool()
def get_field_values(field: str, subset: str = "articles") -> str:
    """Get unique values for a categorical field."""
    # Useful for discovering valid filter values
    ...
```

---

## Implementation Priority

### Phase 1: Quick Wins (1-2 hours)
1. ✅ Fix ID type mismatch (DONE)
2. ⏳ Reduce default limits
3. ⏳ Add brief mode parameter
4. ⏳ Input validation for countries/sentiment values

### Phase 2: Enhanced Queries (2-4 hours)
1. ⏳ Batch article retrieval
2. ⏳ Time-series analysis tools
3. ⏳ Query suggestions

### Phase 3: Advanced Features (4-8 hours)
1. ⏳ Semantic search (requires embedding loading)
2. ⏳ Cross-subset linking
3. ⏳ Export functionality

### Phase 4: Production Polish
1. ⏳ Persistent caching
2. ⏳ Comprehensive error handling
3. ⏳ Performance monitoring

---

## Notes

- Dataset has **12,287 articles** (as of Jan 2026)
- Embeddings are 768-dimensional (paraphrase-multilingual-mpnet-base-v2)
- Three AI models for sentiment: Gemini, ChatGPT, Mistral
- Consider memory usage when loading embeddings (~500MB+)

---

Last updated: 2026-01-24
