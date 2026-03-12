"""IWAC MCP Server - Read-only access to Islam West Africa Collection via Hugging Face datasets."""

import json
import logging
from typing import Any

import pandas as pd
from mcp.server.fastmcp import FastMCP

from .config import settings
from .hf_client import client, semantic_engine

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize FastMCP server
mcp = FastMCP("iwac_mcp")

# Shared tool annotations — all tools are read-only
_TOOL_ANNOTATIONS = {
    "readOnlyHint": True,
    "destructiveHint": False,
    "idempotentHint": True,
    "openWorldHint": False,
}


def _to_json(data: Any, indent: int = 2) -> str:
    """Convert data to JSON string, handling pandas types."""
    if isinstance(data, pd.DataFrame):
        data = data.to_dict(orient="records")
    return json.dumps(data, ensure_ascii=False, indent=indent, default=str)


def _df_to_records(df: pd.DataFrame, columns: list[str] | None = None) -> list[dict]:
    """Convert DataFrame to list of dicts with selected columns."""
    if columns:
        columns = [c for c in columns if c in df.columns]
        df = df[columns]
    return df.to_dict(orient="records")


def _filter_by_country(df: pd.DataFrame, country: str | None, column: str = "country") -> pd.DataFrame:
    """Filter DataFrame by country using case-insensitive substring match."""
    if country:
        df = df[df[column].fillna("").str.contains(country, case=False, na=False)]
    return df


def _paginated_response(df: pd.DataFrame, results: list[dict], offset: int, limit: int, **extra: Any) -> dict:
    """Build standard pagination envelope."""
    total_matches = len(df)
    has_more = offset + limit < total_matches
    response: dict[str, Any] = {
        "count": len(results),
        "total_matches": total_matches,
        "offset": offset,
        "has_more": has_more,
        **extra,
    }
    if has_more:
        response["next_offset"] = offset + limit
    response["results"] = results
    return response


# =============================================================================
# ARTICLE SEARCH TOOLS (2 tools)
# =============================================================================


@mcp.tool(annotations=_TOOL_ANNOTATIONS)
def search_articles(
    keyword: str | None = None,
    country: str | None = None,
    newspaper: str | None = None,
    subject: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    limit: int = 20,
    offset: int = 0,
) -> str:
    """Search IWAC newspaper articles.

    Args:
        keyword: Full-text search in title and OCR content
        country: Filter by country (e.g., "Burkina Faso", "Benin")
        newspaper: Filter by newspaper name (e.g., "Fraternité Matin")
        subject: Filter by subject (searches subject field, pipe-separated)
        date_from: Start date (YYYY-MM-DD format)
        date_to: End date (YYYY-MM-DD format)
        limit: Maximum results to return (default 20, max 100)
        offset: Number of results to skip for pagination (default 0)

    Returns:
        JSON array of matching articles with metadata
    """
    limit = min(limit, 100)
    df = client.articles.copy()

    # Apply filters
    df = _filter_by_country(df, country)

    if newspaper:
        df = df[df["newspaper"].fillna("").str.contains(newspaper, case=False, na=False)]

    if subject:
        df = df[df["subject"].fillna("").str.contains(subject, case=False, na=False)]

    if keyword:
        mask = (
            df["title"].fillna("").str.contains(keyword, case=False, na=False)
            | df["OCR"].fillna("").str.contains(keyword, case=False, na=False)
        )
        df = df[mask]

    if date_from:
        df = df[df["pub_date"] >= pd.to_datetime(date_from, utc=True)]

    if date_to:
        df = df[df["pub_date"] <= pd.to_datetime(date_to, utc=True)]

    # Select output columns
    output_cols = [
        "o:id", "title", "author", "newspaper", "country", "pub_date",
        "subject", "spatial", "language",
        "gemini_polarite", "gemini_centralite_islam_musulmans",
        "gemini_subjectivite_score", "url",
    ]
    results = _df_to_records(df.iloc[offset:offset + limit], output_cols)

    return _to_json(_paginated_response(df, results, offset, limit))


@mcp.tool(annotations=_TOOL_ANNOTATIONS)
def get_article(article_id: int) -> str:
    """Get detailed information about a specific IWAC article.

    Includes full metadata, OCR text, and sentiment analysis.

    Args:
        article_id: The article ID (o:id field)

    Returns:
        JSON object with full article metadata including OCR text and sentiment
    """
    df = client.articles
    article = df[df["o:id"].astype(str) == str(article_id)]

    if article.empty:
        return _to_json({"error": f"Article {article_id} not found"})

    row = article.iloc[0]

    result = {
        "id": row.get("o:id"),
        "identifier": row.get("identifier"),
        "title": row.get("title"),
        "author": row.get("author"),
        "newspaper": row.get("newspaper"),
        "country": row.get("country"),
        "pub_date": row.get("pub_date"),
        "subject": row.get("subject"),
        "spatial": row.get("spatial"),
        "language": row.get("language"),
        "nb_pages": row.get("nb_pages"),
        "url": row.get("url"),
        # OCR and text analysis
        "ocr_text": row.get("OCR"),
        "word_count": row.get("nb_mots"),
        "lexical_richness": row.get("Richesse_Lexicale_OCR"),
        "readability": row.get("Lisibilite_OCR"),
        # DistilCamemBERT sentiment
        "sentiment_label": row.get("sentiment_label"),
        "sentiment_score": row.get("sentiment_score"),
        # AI sentiment (Gemini)
        "gemini_centrality": row.get("gemini_centralite_islam_musulmans"),
        "gemini_polarity": row.get("gemini_polarite"),
        "gemini_subjectivity": row.get("gemini_subjectivite_score"),
    }

    return _to_json(result)


# =============================================================================
# SEMANTIC SEARCH TOOLS (1 tool)
# =============================================================================


@mcp.tool(annotations=_TOOL_ANNOTATIONS)
def semantic_search_articles(
    query: str,
    country: str | None = None,
    newspaper: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    limit: int = 10,
) -> str:
    """Search articles by semantic similarity using AI embeddings.

    Unlike keyword search, this finds articles with similar *meaning*
    even when different words are used. Requires IWAC_LOAD_EMBEDDINGS=true
    and IWAC_SEMANTIC_SEARCH_ENABLED=true.

    Args:
        query: Natural language query (e.g., "Islamic education reform")
        country: Optional country filter applied after ranking
        newspaper: Optional newspaper filter applied after ranking
        date_from: Optional start date filter (YYYY-MM-DD)
        date_to: Optional end date filter (YYYY-MM-DD)
        limit: Number of results (default 10, max 50)

    Returns:
        JSON array of articles ranked by semantic similarity
    """
    if not settings.semantic_search_enabled or semantic_engine is None:
        return _to_json({
            "error": "Semantic search is not enabled. "
            "Set IWAC_LOAD_EMBEDDINGS=true and IWAC_SEMANTIC_SEARCH_ENABLED=true to enable it."
        })

    limit = min(limit, 50)
    df = client.articles

    # Over-fetch then post-filter for metadata constraints
    overfetch_k = limit * 5
    results_with_scores = semantic_engine.search(query, df, top_k=overfetch_k)

    # Build result set with post-filtering
    output_cols = [
        "o:id", "title", "author", "newspaper", "country", "pub_date",
        "subject", "spatial", "language",
        "gemini_polarite", "gemini_centralite_islam_musulmans",
        "gemini_subjectivite_score", "url",
    ]
    filtered_results = []
    for article_id, score in results_with_scores:
        row = df[df["o:id"] == article_id]
        if row.empty:
            continue

        record = row.iloc[0]

        # Apply post-filters
        if country and not str(record.get("country", "")).lower().__contains__(country.lower()):
            continue
        if newspaper and not str(record.get("newspaper", "")).lower().__contains__(
            newspaper.lower()
        ):
            continue
        if date_from and record.get("pub_date") is not None:
            if record["pub_date"] < pd.to_datetime(date_from, utc=True):
                continue
        if date_to and record.get("pub_date") is not None:
            if record["pub_date"] > pd.to_datetime(date_to, utc=True):
                continue

        result_dict = {
            col: record.get(col) for col in output_cols if col in row.columns
        }
        result_dict["similarity_score"] = round(score, 4)
        filtered_results.append(result_dict)

        if len(filtered_results) >= limit:
            break

    return _to_json({
        "query": query,
        "count": len(filtered_results),
        "filters": {
            "country": country,
            "newspaper": newspaper,
            "date_from": date_from,
            "date_to": date_to,
        },
        "results": filtered_results,
    })


# =============================================================================
# SENTIMENT TOOLS (2 tools)
# =============================================================================


@mcp.tool(annotations=_TOOL_ANNOTATIONS)
def search_by_sentiment(
    polarity: str | None = None,
    centrality: str | None = None,
    country: str | None = None,
    subject: str | None = None,
    limit: int = 20,
    offset: int = 0,
) -> str:
    """Search articles by Gemini AI sentiment analysis.

    Args:
        polarity: Filter by polarity (Très positif, Positif, Neutre, Négatif, Très négatif)
        centrality: Filter by centrality (Très central, Central, Secondaire, Marginal, Non abordé)
        country: Filter by country
        subject: Filter by subject (searches subject field, pipe-separated)
        limit: Maximum results to return (default 20, max 100)
        offset: Number of results to skip for pagination (default 0)

    Returns:
        JSON array of articles matching sentiment criteria
    """
    limit = min(limit, 100)
    df = client.articles.copy()

    polarity_col = "gemini_polarite"
    centrality_col = "gemini_centralite_islam_musulmans"

    # Normalize accent variants so unaccented input matches accented data
    _accent_map = {
        "tres positif": "Très positif",
        "tres negatif": "Très négatif",
        "negatif": "Négatif",
        "tres central": "Très central",
        "non aborde": "Non abordé",
    }

    if polarity:
        polarity = _accent_map.get(polarity.lower(), polarity)
    if centrality:
        centrality = _accent_map.get(centrality.lower(), centrality)

    # Apply filters
    if polarity and polarity_col in df.columns:
        df = df[df[polarity_col] == polarity]

    if centrality and centrality_col in df.columns:
        df = df[df[centrality_col] == centrality]

    df = _filter_by_country(df, country)

    if subject:
        df = df[df["subject"].fillna("").str.contains(subject, case=False, na=False)]

    # Select output columns
    output_cols = [
        "o:id", "title", "newspaper", "country", "pub_date",
        polarity_col, centrality_col, "gemini_subjectivite_score", "url",
    ]
    results = _df_to_records(df.iloc[offset:offset + limit], output_cols)

    return _to_json(_paginated_response(df, results, offset, limit))


@mcp.tool(annotations=_TOOL_ANNOTATIONS)
def get_sentiment_distribution(
    country: str | None = None,
    newspaper: str | None = None,
    subject: str | None = None,
) -> str:
    """Get aggregated Gemini sentiment statistics.

    Args:
        country: Filter by country (optional)
        newspaper: Filter by newspaper (optional)
        subject: Filter by subject (optional, searches subject field)

    Returns:
        JSON with polarity and centrality distribution counts
    """
    df = client.articles.copy()

    # Apply filters
    df = _filter_by_country(df, country)

    if newspaper:
        df = df[df["newspaper"].fillna("").str.contains(newspaper, case=False, na=False)]

    if subject:
        df = df[df["subject"].fillna("").str.contains(subject, case=False, na=False)]

    polarity_col = "gemini_polarite"
    centrality_col = "gemini_centralite_islam_musulmans"

    result: dict[str, Any] = {
        "model": "gemini",
        "total_articles": len(df),
        "filters": {
            "country": country,
            "newspaper": newspaper,
            "subject": subject,
        },
    }

    if polarity_col in df.columns:
        result["polarity_distribution"] = df[polarity_col].value_counts().to_dict()

    if centrality_col in df.columns:
        result["centrality_distribution"] = df[centrality_col].value_counts().to_dict()

    return _to_json(result)


# =============================================================================
# INDEX TOOLS (5 tools)
# =============================================================================


@mcp.tool(annotations=_TOOL_ANNOTATIONS)
def search_index(
    query: str,
    index_type: str | None = None,
    limit: int = 20,
    offset: int = 0,
) -> str:
    """Search the IWAC index for persons, places, organizations, or subjects.

    Args:
        query: Search term
        index_type: Filter by type (Personnes, Lieux, Organisations, Événements, Sujets)
        limit: Maximum results to return (default 20, max 100)
        offset: Number of results to skip for pagination (default 0)

    Returns:
        JSON array of matching index entries
    """
    limit = min(limit, 100)
    df = client.index.copy()

    # Search in title
    df = df[df["Titre"].fillna("").str.contains(query, case=False, na=False)]

    if index_type:
        df = df[df["Type"].fillna("").str.contains(index_type, case=False, na=False)]

    output_cols = [
        "o:id", "Titre", "Type", "Description", "frequency",
        "first_occurrence", "last_occurrence", "countries", "url",
    ]
    results = _df_to_records(df.iloc[offset:offset + limit], output_cols)

    return _to_json(_paginated_response(df, results, offset, limit))


@mcp.tool(annotations=_TOOL_ANNOTATIONS)
def get_index_entry(entry_id: int) -> str:
    """Get detailed information about an IWAC index entry.

    Args:
        entry_id: The entry ID (o:id field)

    Returns:
        JSON object with full entry details including frequency statistics
    """
    df = client.index
    entry = df[df["o:id"].astype(str) == str(entry_id)]

    if entry.empty:
        return _to_json({"error": f"Index entry {entry_id} not found"})

    row = entry.iloc[0]
    result = row.to_dict()

    return _to_json(result)


@mcp.tool(annotations=_TOOL_ANNOTATIONS)
def list_subjects(limit: int = 50, offset: int = 0) -> str:
    """List subject terms from the IWAC index.

    Args:
        limit: Maximum results to return (default 50, max 200)
        offset: Number of results to skip for pagination (default 0)

    Returns:
        JSON array of subjects sorted by frequency
    """
    limit = min(limit, 200)
    df = client.index.copy()

    # Filter to subjects only
    df = df[df["Type"] == "Sujets"]

    # Sort by frequency
    if "frequency" in df.columns:
        df = df.sort_values("frequency", ascending=False)

    output_cols = ["o:id", "Titre", "Description", "frequency", "url"]
    results = _df_to_records(df.iloc[offset:offset + limit], output_cols)

    return _to_json(_paginated_response(df, results, offset, limit))


@mcp.tool(annotations=_TOOL_ANNOTATIONS)
def list_locations(country: str | None = None, limit: int = 50, offset: int = 0) -> str:
    """List geographic locations from the IWAC index.

    Args:
        country: Filter by country (optional)
        limit: Maximum results to return (default 50, max 200)
        offset: Number of results to skip for pagination (default 0)

    Returns:
        JSON array of locations sorted by frequency
    """
    limit = min(limit, 200)
    df = client.index.copy()

    # Filter to locations only
    df = df[df["Type"] == "Lieux"]

    df = _filter_by_country(df, country, column="countries")

    # Sort by frequency
    if "frequency" in df.columns:
        df = df.sort_values("frequency", ascending=False)

    output_cols = ["o:id", "Titre", "Description", "frequency", "countries", "url"]
    results = _df_to_records(df.iloc[offset:offset + limit], output_cols)

    return _to_json(_paginated_response(df, results, offset, limit))


@mcp.tool(annotations=_TOOL_ANNOTATIONS)
def list_persons(country: str | None = None, limit: int = 50, offset: int = 0) -> str:
    """List persons from the IWAC index.

    Args:
        country: Filter by country (optional)
        limit: Maximum results to return (default 50, max 200)
        offset: Number of results to skip for pagination (default 0)

    Returns:
        JSON array of persons sorted by frequency
    """
    limit = min(limit, 200)
    df = client.index.copy()

    # Filter to persons only
    df = df[df["Type"] == "Personnes"]

    df = _filter_by_country(df, country, column="countries")

    # Sort by frequency
    if "frequency" in df.columns:
        df = df.sort_values("frequency", ascending=False)

    output_cols = ["o:id", "Titre", "Description", "frequency", "countries", "url"]
    results = _df_to_records(df.iloc[offset:offset + limit], output_cols)

    return _to_json(_paginated_response(df, results, offset, limit))


# =============================================================================
# STATS TOOLS (3 tools)
# =============================================================================


@mcp.tool(annotations=_TOOL_ANNOTATIONS)
def get_collection_stats() -> str:
    """Get statistics about the entire IWAC collection.

    Returns:
        JSON object with counts for all 6 subsets and summary statistics
    """
    subset_counts = client.get_subset_stats()

    # Get article-specific stats
    articles_df = client.articles

    # Country distribution
    country_counts = articles_df["country"].value_counts().to_dict()

    # Date range
    dates = articles_df["pub_date"].dropna()
    date_range = None
    if not dates.empty:
        date_range = {
            "earliest": str(dates.min().date()),
            "latest": str(dates.max().date()),
        }

    # Newspaper count
    newspaper_count = articles_df["newspaper"].nunique()

    return _to_json({
        "collection_name": "Islam West Africa Collection (IWAC)",
        "dataset_url": "https://huggingface.co/datasets/fmadore/islam-west-africa-collection",
        "subset_counts": subset_counts,
        "total_records": sum(subset_counts.values()),
        "articles_by_country": country_counts,
        "newspaper_count": newspaper_count,
        "date_range": date_range,
    })


@mcp.tool(annotations=_TOOL_ANNOTATIONS)
def get_newspaper_stats(country: str | None = None) -> str:
    """Get statistics about newspapers in the collection.

    Args:
        country: Filter by country (optional)

    Returns:
        JSON with newspaper counts and article distribution
    """
    df = client.articles.copy()

    df = _filter_by_country(df, country)

    newspaper_stats = (
        df.groupby(["newspaper", "country"])
        .agg(
            article_count=("o:id", "count"),
            earliest_date=("pub_date", "min"),
            latest_date=("pub_date", "max"),
        )
        .reset_index()
        .sort_values("article_count", ascending=False)
    )

    return _to_json({
        "country_filter": country,
        "total_newspapers": len(newspaper_stats),
        "total_articles": len(df),
        "newspapers": newspaper_stats.to_dict(orient="records"),
    })


@mcp.tool(annotations=_TOOL_ANNOTATIONS)
def get_country_comparison() -> str:
    """Compare statistics across countries.

    Returns:
        JSON with per-country article counts, date ranges, and sentiment summaries
    """
    df = client.articles

    country_stats = []
    for country in df["country"].dropna().unique():
        country_df = df[df["country"] == country]

        stats = {
            "country": country,
            "article_count": len(country_df),
            "newspaper_count": country_df["newspaper"].nunique(),
        }

        # Date range
        dates = country_df["pub_date"].dropna()
        if not dates.empty:
            stats["date_range"] = {
                "earliest": str(dates.min().date()),
                "latest": str(dates.max().date()),
            }

        # Polarity summary (Gemini)
        if "gemini_polarite" in country_df.columns:
            polarity = country_df["gemini_polarite"].value_counts().to_dict()
            stats["gemini_polarity"] = polarity

        country_stats.append(stats)

    # Sort by article count
    country_stats = sorted(country_stats, key=lambda x: x["article_count"], reverse=True)

    return _to_json({
        "total_countries": len(country_stats),
        "countries": country_stats,
    })


# =============================================================================
# OTHER SUBSET TOOLS (3 tools)
# =============================================================================


def _extract_matching_toc_entries(toc: str, keyword: str) -> str:
    """Extract TOC entries matching a keyword.

    Each entry starts with 'p.' and is separated by blank lines.
    Returns only entries whose text contains the keyword (case-insensitive).
    """
    if not toc or not keyword:
        return ""
    keyword_lower = keyword.lower()
    # Split on blank lines to get individual entries
    entries = [e.strip() for e in toc.split("\n\n") if e.strip()]
    matching = [e for e in entries if keyword_lower in e.lower()]
    return "\n\n".join(matching)


@mcp.tool(annotations=_TOOL_ANNOTATIONS)
def search_publications(
    keyword: str | None = None,
    country: str | None = None,
    limit: int = 20,
    offset: int = 0,
) -> str:
    """Search Islamic publications (books, periodicals).

    Searches title, description, and table of contents. When a keyword matches
    in the table of contents, only the matching TOC entries are returned (with
    page numbers, titles, and summaries) to help identify relevant sections.

    Args:
        keyword: Search in title, description, and table of contents
        country: Filter by country
        limit: Maximum results to return (default 20, max 100)
        offset: Number of results to skip for pagination (default 0)

    Returns:
        JSON array of matching publications with matching TOC entries if applicable
    """
    limit = min(limit, 100)
    df = client.publications.copy()

    has_toc = "tableOfContents" in df.columns

    if keyword:
        mask = (
            df["title"].fillna("").str.contains(keyword, case=False, na=False)
            | df["description"].fillna("").str.contains(keyword, case=False, na=False)
        )
        if has_toc:
            mask = mask | df["tableOfContents"].fillna("").str.contains(
                keyword, case=False, na=False
            )
        df = df[mask]

    df = _filter_by_country(df, country)

    output_cols = ["o:id", "title", "description", "country", "date", "language", "url"]
    results = _df_to_records(df.iloc[offset:offset + limit], output_cols)

    # Attach matching TOC entries to each result
    if keyword and has_toc:
        page = df.iloc[offset:offset + limit]
        for i, (_, row) in enumerate(page.iterrows()):
            toc_text = row.get("tableOfContents", "") or ""
            matching_entries = _extract_matching_toc_entries(toc_text, keyword)
            if matching_entries:
                results[i]["matching_toc_entries"] = matching_entries

    return _to_json(_paginated_response(df, results, offset, limit))


@mcp.tool(annotations=_TOOL_ANNOTATIONS)
def get_publication_fulltext(
    publication_id: int,
    keyword: str | None = None,
    context_chars: int = 2000,
) -> str:
    """Get full text (OCR) of a publication, optionally searching for keyword context.

    Use this after search_publications to drill into the actual content of a
    publication. When a keyword is provided, returns text excerpts (~2000 chars
    each) around every match instead of the entire text.

    Args:
        publication_id: The o:id of the publication
        keyword: Optional keyword to extract context around (case-insensitive)
        context_chars: Characters of context around each keyword match (default 2000)

    Returns:
        JSON with publication metadata, table of contents, and full text or excerpts
    """
    df = client.publications
    row = df[df["o:id"] == publication_id]

    if row.empty:
        return _to_json({"error": f"Publication {publication_id} not found"})

    record = row.iloc[0]
    result: dict[str, Any] = {
        "o:id": publication_id,
        "title": record.get("title", ""),
    }

    # Include table of contents if available
    toc = record.get("tableOfContents", "") or ""
    if toc:
        result["tableOfContents"] = toc

    # Get OCR text
    ocr_text = record.get("OCR", "") or ""
    if not ocr_text:
        result["fulltext"] = None
        result["note"] = "No OCR text available for this publication"
        return _to_json(result)

    if not keyword:
        result["fulltext"] = ocr_text
        result["char_count"] = len(ocr_text)
        return _to_json(result)

    # Extract context windows around keyword matches
    context_chars = min(context_chars, 5000)
    half = context_chars // 2
    text_lower = ocr_text.lower()
    keyword_lower = keyword.lower()
    excerpts = []
    pos = 0

    while True:
        idx = text_lower.find(keyword_lower, pos)
        if idx == -1:
            break
        start = max(0, idx - half)
        end = min(len(ocr_text), idx + len(keyword) + half)
        excerpt = ocr_text[start:end]
        # Add ellipsis markers for truncation
        if start > 0:
            excerpt = "..." + excerpt
        if end < len(ocr_text):
            excerpt = excerpt + "..."
        excerpts.append(excerpt)
        pos = idx + len(keyword)

    if not excerpts:
        result["excerpts"] = []
        result["note"] = f"Keyword '{keyword}' not found in full text"
    else:
        result["excerpts"] = excerpts
        result["match_count"] = len(excerpts)

    return _to_json(result)


@mcp.tool(annotations=_TOOL_ANNOTATIONS)
def search_references(
    keyword: str | None = None,
    author: str | None = None,
    reference_type: str | None = None,
    limit: int = 20,
    offset: int = 0,
) -> str:
    """Search academic references (journal articles, books, theses).

    Args:
        keyword: Search in title and abstract
        author: Filter by author name
        reference_type: Filter by type (e.g., "Article", "Book", "Thesis")
        limit: Maximum results to return (default 20, max 100)
        offset: Number of results to skip for pagination (default 0)

    Returns:
        JSON array of matching references
    """
    limit = min(limit, 100)
    df = client.references.copy()

    if keyword:
        mask = (
            df["title"].fillna("").str.contains(keyword, case=False, na=False)
            | df["abstract"].fillna("").str.contains(keyword, case=False, na=False)
        )
        df = df[mask]

    if author:
        df = df[df["author"].fillna("").str.contains(author, case=False, na=False)]

    if reference_type:
        # Check common column names for type
        for col in ["type", "Type", "resource_type"]:
            if col in df.columns:
                df = df[df[col].fillna("").str.contains(reference_type, case=False, na=False)]
                break

    output_cols = ["o:id", "title", "author", "type", "date", "publisher", "url"]
    results = _df_to_records(df.iloc[offset:offset + limit], output_cols)

    return _to_json(_paginated_response(df, results, offset, limit))


@mcp.tool(annotations=_TOOL_ANNOTATIONS)
def list_audiovisual(country: str | None = None, limit: int = 20, offset: int = 0) -> str:
    """List audiovisual materials (audio/video recordings).

    Args:
        country: Filter by country
        limit: Maximum results to return (default 20, max 50)
        offset: Number of results to skip for pagination (default 0)

    Returns:
        JSON array of audiovisual materials
    """
    limit = min(limit, 50)
    df = client.audiovisual.copy()

    df = _filter_by_country(df, country)

    output_cols = ["o:id", "title", "country", "date", "description", "language", "url"]
    results = _df_to_records(df.iloc[offset:offset + limit], output_cols)

    return _to_json(_paginated_response(df, results, offset, limit))


def main():
    """Run the IWAC MCP server."""
    logger.info("Starting IWAC MCP Server...")
    logger.info(f"Dataset: {settings.dataset_name}")
    logger.info(f"Lazy loading: {settings.lazy_load_subsets}")
    logger.info(f"Preload articles: {settings.preload_articles}")

    # Preload datasets if configured
    if settings.preload_articles:
        logger.info("Preloading articles subset...")
        client.preload()

    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
