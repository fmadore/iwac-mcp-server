"""IWAC MCP Server - Read-only access to Islam West Africa Collection via Hugging Face datasets."""

import json
import logging
from typing import Any

import pandas as pd
from mcp.server.fastmcp import FastMCP

from .config import settings
from .hf_client import client

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize FastMCP server
mcp = FastMCP("iwac")


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


# =============================================================================
# ARTICLE SEARCH TOOLS (2 tools)
# =============================================================================


@mcp.tool()
def search_articles(
    keyword: str | None = None,
    country: str | None = None,
    newspaper: str | None = None,
    subject: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    limit: int = 20,
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

    Returns:
        JSON array of matching articles with metadata
    """
    limit = min(limit, 100)
    df = client.articles.copy()

    # Apply filters
    if country:
        df = df[df["country"].fillna("").str.contains(country, case=False, na=False)]

    if newspaper:
        df = df[df["newspaper"].fillna("").str.contains(newspaper, case=False, na=False)]

    if subject:
        df = df[df["subject"].fillna("").str.contains(subject, case=False, na=False)]

    if keyword:
        # Search in title and OCR
        mask = (
            df["title"].fillna("").str.contains(keyword, case=False, na=False)
            | df["OCR"].fillna("").str.contains(keyword, case=False, na=False)
        )
        df = df[mask]

    if date_from:
        df = df[df["pub_date"] >= pd.to_datetime(date_from)]

    if date_to:
        df = df[df["pub_date"] <= pd.to_datetime(date_to)]

    # Select output columns
    output_cols = [
        "o:id", "title", "author", "newspaper", "country", "pub_date",
        "subject", "spatial", "language", "url",
    ]
    results = _df_to_records(df.head(limit), output_cols)

    return _to_json({
        "count": len(results),
        "total_matches": len(df),
        "results": results,
    })


@mcp.tool()
def get_article(article_id: int) -> str:
    """Get detailed information about a specific IWAC article.

    Includes full metadata, OCR text, sentiment analysis, and topic information.

    Args:
        article_id: The article ID (o:id field)

    Returns:
        JSON object with full article metadata including OCR text, topics, and sentiment
    """
    df = client.articles
    # o:id is stored as string in the dataset
    article = df[df["o:id"] == str(article_id)]

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
        # Topic modeling
        "topic_id": row.get("topic_id"),
        "topic_label": row.get("topic_label"),
        "topic_probability": row.get("topic_prob"),
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
# SENTIMENT TOOLS (3 tools)
# =============================================================================


@mcp.tool()
def search_by_sentiment(
    polarity: str | None = None,
    centrality: str | None = None,
    model: str = "gemini",
    country: str | None = None,
    limit: int = 20,
) -> str:
    """Search articles by AI sentiment analysis.

    Args:
        polarity: Filter by polarity (Très positif, Positif, Neutre, Négatif, Très négatif)
        centrality: Filter by centrality (Très central, Central, Secondaire, Marginal, Non abordé)
        model: AI model to use (gemini, chatgpt, or mistral). Default: gemini
        country: Filter by country
        limit: Maximum results to return (default 20, max 100)

    Returns:
        JSON array of articles matching sentiment criteria
    """
    limit = min(limit, 100)
    df = client.articles.copy()

    # Validate model
    model = model.lower()
    if model not in ["gemini", "chatgpt", "mistral"]:
        return _to_json({"error": "Invalid model. Use: gemini, chatgpt, or mistral"})

    # Build column names based on model
    polarity_col = f"{model}_polarite"
    centrality_col = f"{model}_centralite_islam_musulmans"

    # Apply filters
    if polarity and polarity_col in df.columns:
        df = df[df[polarity_col] == polarity]

    if centrality and centrality_col in df.columns:
        df = df[df[centrality_col] == centrality]

    if country:
        df = df[df["country"].fillna("").str.contains(country, case=False, na=False)]

    # Select output columns
    output_cols = [
        "o:id", "title", "newspaper", "country", "pub_date",
        polarity_col, centrality_col, f"{model}_subjectivite_score", "url",
    ]
    results = _df_to_records(df.head(limit), output_cols)

    return _to_json({
        "count": len(results),
        "total_matches": len(df),
        "model": model,
        "results": results,
    })


@mcp.tool()
def get_sentiment_distribution(
    country: str | None = None,
    newspaper: str | None = None,
    model: str = "gemini",
) -> str:
    """Get aggregated sentiment statistics.

    Args:
        country: Filter by country (optional)
        newspaper: Filter by newspaper (optional)
        model: AI model to use (gemini, chatgpt, or mistral). Default: gemini

    Returns:
        JSON with polarity and centrality distribution counts
    """
    df = client.articles.copy()

    # Validate model
    model = model.lower()
    if model not in ["gemini", "chatgpt", "mistral"]:
        return _to_json({"error": "Invalid model. Use: gemini, chatgpt, or mistral"})

    # Apply filters
    if country:
        df = df[df["country"].fillna("").str.contains(country, case=False, na=False)]

    if newspaper:
        df = df[df["newspaper"].fillna("").str.contains(newspaper, case=False, na=False)]

    polarity_col = f"{model}_polarite"
    centrality_col = f"{model}_centralite_islam_musulmans"

    result = {
        "model": model,
        "total_articles": len(df),
        "filters": {
            "country": country,
            "newspaper": newspaper,
        },
    }

    if polarity_col in df.columns:
        result["polarity_distribution"] = df[polarity_col].value_counts().to_dict()

    if centrality_col in df.columns:
        result["centrality_distribution"] = df[centrality_col].value_counts().to_dict()

    return _to_json(result)


@mcp.tool()
def compare_ai_sentiments(article_id: int) -> str:
    """Compare sentiment analysis from all three AI models for an article.

    Args:
        article_id: The article ID (o:id field)

    Returns:
        JSON comparing Gemini, ChatGPT, and Mistral analyses side-by-side
    """
    df = client.articles
    # o:id is stored as string in the dataset
    article = df[df["o:id"] == str(article_id)]

    if article.empty:
        return _to_json({"error": f"Article {article_id} not found"})

    row = article.iloc[0]

    result = {
        "article_id": article_id,
        "title": row.get("title"),
        "comparison": {},
    }

    for model in ["gemini", "chatgpt", "mistral"]:
        result["comparison"][model] = {
            "centrality": row.get(f"{model}_centralite_islam_musulmans"),
            "centrality_justification": row.get(f"{model}_centralite_justification"),
            "polarity": row.get(f"{model}_polarite"),
            "polarity_justification": row.get(f"{model}_polarite_justification"),
            "subjectivity_score": row.get(f"{model}_subjectivite_score"),
            "subjectivity_justification": row.get(f"{model}_subjectivite_justification"),
        }

    return _to_json(result)


# =============================================================================
# TOPIC TOOLS (3 tools)
# =============================================================================


@mcp.tool()
def search_by_topic(
    topic_id: int | None = None,
    topic_label: str | None = None,
    country: str | None = None,
    limit: int = 20,
) -> str:
    """Search articles by BERTopic topic assignment.

    Args:
        topic_id: Filter by topic ID (use list_topics to see available IDs)
        topic_label: Filter by topic label (partial match)
        country: Filter by country
        limit: Maximum results to return (default 20, max 100)

    Returns:
        JSON array of articles in the specified topic
    """
    limit = min(limit, 100)
    df = client.articles.copy()

    if topic_id is not None:
        df = df[df["topic_id"] == topic_id]

    if topic_label:
        df = df[df["topic_label"].fillna("").str.contains(topic_label, case=False, na=False)]

    if country:
        df = df[df["country"].fillna("").str.contains(country, case=False, na=False)]

    output_cols = [
        "o:id", "title", "newspaper", "country", "pub_date",
        "topic_id", "topic_label", "topic_prob", "url",
    ]
    results = _df_to_records(df.head(limit), output_cols)

    return _to_json({
        "count": len(results),
        "total_matches": len(df),
        "results": results,
    })


@mcp.tool()
def get_topic_distribution(country: str | None = None) -> str:
    """Get topic distribution statistics.

    Args:
        country: Filter by country (optional)

    Returns:
        JSON with topic counts and labels
    """
    df = client.articles.copy()

    if country:
        df = df[df["country"].fillna("").str.contains(country, case=False, na=False)]

    # Group by topic
    topic_stats = (
        df.groupby(["topic_id", "topic_label"])
        .size()
        .reset_index(name="count")
        .sort_values("count", ascending=False)
    )

    return _to_json({
        "country": country,
        "total_articles": len(df),
        "unique_topics": len(topic_stats),
        "topics": topic_stats.to_dict(orient="records"),
    })


@mcp.tool()
def list_topics() -> str:
    """List all BERTopic topics with article counts.

    Returns:
        JSON array of topics with IDs, labels, and counts
    """
    df = client.articles

    # Group by topic, get counts and sample titles
    topic_stats = (
        df.groupby(["topic_id", "topic_label"])
        .agg(
            count=("o:id", "count"),
            avg_probability=("topic_prob", "mean"),
        )
        .reset_index()
        .sort_values("count", ascending=False)
    )

    # Filter out outliers (topic_id = -1)
    main_topics = topic_stats[topic_stats["topic_id"] != -1]
    outliers = topic_stats[topic_stats["topic_id"] == -1]

    return _to_json({
        "total_topics": len(main_topics),
        "outlier_count": int(outliers["count"].sum()) if not outliers.empty else 0,
        "topics": main_topics.to_dict(orient="records"),
    })


# =============================================================================
# INDEX TOOLS (5 tools)
# =============================================================================


@mcp.tool()
def search_index(
    query: str,
    index_type: str | None = None,
    limit: int = 20,
) -> str:
    """Search the IWAC index for persons, places, organizations, or subjects.

    Args:
        query: Search term
        index_type: Filter by type (Personnes, Lieux, Organisations, Événements, Sujets)
        limit: Maximum results to return (default 20, max 100)

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
    results = _df_to_records(df.head(limit), output_cols)

    return _to_json({
        "count": len(results),
        "total_matches": len(df),
        "results": results,
    })


@mcp.tool()
def get_index_entry(entry_id: int) -> str:
    """Get detailed information about an IWAC index entry.

    Args:
        entry_id: The entry ID (o:id field)

    Returns:
        JSON object with full entry details including frequency statistics
    """
    df = client.index
    # o:id is stored as string in the dataset
    entry = df[df["o:id"] == str(entry_id)]

    if entry.empty:
        return _to_json({"error": f"Index entry {entry_id} not found"})

    row = entry.iloc[0]
    result = row.to_dict()

    return _to_json(result)


@mcp.tool()
def list_subjects(limit: int = 50) -> str:
    """List subject terms from the IWAC index.

    Args:
        limit: Maximum results to return (default 50, max 200)

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
    results = _df_to_records(df.head(limit), output_cols)

    return _to_json({
        "count": len(results),
        "results": results,
    })


@mcp.tool()
def list_locations(country: str | None = None, limit: int = 50) -> str:
    """List geographic locations from the IWAC index.

    Args:
        country: Filter by country (optional)
        limit: Maximum results to return (default 50, max 200)

    Returns:
        JSON array of locations sorted by frequency
    """
    limit = min(limit, 200)
    df = client.index.copy()

    # Filter to locations only
    df = df[df["Type"] == "Lieux"]

    if country:
        df = df[df["countries"].fillna("").str.contains(country, case=False, na=False)]

    # Sort by frequency
    if "frequency" in df.columns:
        df = df.sort_values("frequency", ascending=False)

    output_cols = ["o:id", "Titre", "Description", "frequency", "countries", "url"]
    results = _df_to_records(df.head(limit), output_cols)

    return _to_json({
        "count": len(results),
        "results": results,
    })


@mcp.tool()
def list_persons(country: str | None = None, limit: int = 50) -> str:
    """List persons from the IWAC index.

    Args:
        country: Filter by country (optional)
        limit: Maximum results to return (default 50, max 200)

    Returns:
        JSON array of persons sorted by frequency
    """
    limit = min(limit, 200)
    df = client.index.copy()

    # Filter to persons only
    df = df[df["Type"] == "Personnes"]

    if country:
        df = df[df["countries"].fillna("").str.contains(country, case=False, na=False)]

    # Sort by frequency
    if "frequency" in df.columns:
        df = df.sort_values("frequency", ascending=False)

    output_cols = ["o:id", "Titre", "Description", "frequency", "countries", "url"]
    results = _df_to_records(df.head(limit), output_cols)

    return _to_json({
        "count": len(results),
        "results": results,
    })


# =============================================================================
# STATS TOOLS (3 tools)
# =============================================================================


@mcp.tool()
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


@mcp.tool()
def get_newspaper_stats(country: str | None = None) -> str:
    """Get statistics about newspapers in the collection.

    Args:
        country: Filter by country (optional)

    Returns:
        JSON with newspaper counts and article distribution
    """
    df = client.articles.copy()

    if country:
        df = df[df["country"].fillna("").str.contains(country, case=False, na=False)]

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


@mcp.tool()
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


@mcp.tool()
def search_publications(
    keyword: str | None = None,
    country: str | None = None,
    limit: int = 20,
) -> str:
    """Search Islamic publications (books, periodicals).

    Args:
        keyword: Search in title and description
        country: Filter by country
        limit: Maximum results to return (default 20, max 100)

    Returns:
        JSON array of matching publications
    """
    limit = min(limit, 100)
    df = client.publications.copy()

    if keyword:
        mask = (
            df["title"].fillna("").str.contains(keyword, case=False, na=False)
            | df["description"].fillna("").str.contains(keyword, case=False, na=False)
        )
        df = df[mask]

    if country:
        df = df[df["country"].fillna("").str.contains(country, case=False, na=False)]

    return _to_json({
        "count": len(df.head(limit)),
        "total_matches": len(df),
        "results": df.head(limit).to_dict(orient="records"),
    })


@mcp.tool()
def search_references(
    keyword: str | None = None,
    author: str | None = None,
    reference_type: str | None = None,
    limit: int = 20,
) -> str:
    """Search academic references (journal articles, books, theses).

    Args:
        keyword: Search in title
        author: Filter by author name
        reference_type: Filter by type (e.g., "Article", "Book", "Thesis")
        limit: Maximum results to return (default 20, max 100)

    Returns:
        JSON array of matching references
    """
    limit = min(limit, 100)
    df = client.references.copy()

    if keyword:
        df = df[df["title"].fillna("").str.contains(keyword, case=False, na=False)]

    if author:
        df = df[df["author"].fillna("").str.contains(author, case=False, na=False)]

    if reference_type:
        # Check common column names for type
        for col in ["type", "Type", "resource_type"]:
            if col in df.columns:
                df = df[df[col].fillna("").str.contains(reference_type, case=False, na=False)]
                break

    return _to_json({
        "count": len(df.head(limit)),
        "total_matches": len(df),
        "results": df.head(limit).to_dict(orient="records"),
    })


@mcp.tool()
def list_audiovisual(country: str | None = None, limit: int = 20) -> str:
    """List audiovisual materials (audio/video recordings).

    Args:
        country: Filter by country
        limit: Maximum results to return (default 20, max 50)

    Returns:
        JSON array of audiovisual materials
    """
    limit = min(limit, 50)
    df = client.audiovisual.copy()

    if country:
        df = df[df["country"].fillna("").str.contains(country, case=False, na=False)]

    return _to_json({
        "count": len(df.head(limit)),
        "total_matches": len(df),
        "results": df.head(limit).to_dict(orient="records"),
    })


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
