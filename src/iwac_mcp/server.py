"""IWAC MCP Server - Read-only access to Islam West Africa Collection via Omeka S API."""

import json
import os
from typing import Any

from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP

from .omeka_client import OmekaClient

# Load environment variables
load_dotenv()

# Initialize FastMCP server
mcp = FastMCP("iwac")

# Configuration
OMEKA_BASE_URL = os.getenv("OMEKA_BASE_URL", "https://islam.zmo.de/api")
OMEKA_KEY_IDENTITY = os.getenv("OMEKA_KEY_IDENTITY", "")
OMEKA_KEY_CREDENTIAL = os.getenv("OMEKA_KEY_CREDENTIAL", "")

# Initialize Omeka client
client = OmekaClient(OMEKA_BASE_URL, OMEKA_KEY_IDENTITY, OMEKA_KEY_CREDENTIAL)


@mcp.tool()
async def search_articles(
    subject: str | None = None,
    spatial: str | None = None,
    newspaper: str | None = None,
    country: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    keyword: str | None = None,
    limit: int = 20,
) -> str:
    """Search IWAC newspaper articles.

    Args:
        subject: Search by subject/person name (e.g., "Idriss Koudouss Koné")
        spatial: Search by geographic location (e.g., "Dakar")
        newspaper: Filter by newspaper name (e.g., "Fraternité Matin")
        country: Filter by country (e.g., "Côte d'Ivoire")
        date_from: Start date (YYYY-MM-DD format)
        date_to: End date (YYYY-MM-DD format)
        keyword: Full-text search in all fields including title and OCR
        limit: Maximum results to return (default 20, max 100)

    Returns:
        JSON array of matching articles with metadata and URLs
    """
    property_filters = []
    subject_ids = []
    spatial_ids = []

    # Step 1: If searching by subject, find the subject ID(s) first
    if subject:
        # Search the index for matching subjects/persons
        index_items = await client.get_items(
            fulltext_search=subject,
            per_page=10
        )
        if index_items:
            # Collect all matching index entry IDs
            subject_ids = [item.get("o:id") for item in index_items]

    # Step 2: If searching by spatial, find the location ID(s) first
    if spatial:
        # Search locations index
        location_items = await client.get_items(
            resource_class_id=client.RESOURCE_CLASSES["lieux"],
            fulltext_search=spatial,
            per_page=10
        )
        if location_items:
            spatial_ids = [item.get("o:id") for item in location_items]

    # Step 3: Build property filters for articles
    # Note: Using only the FIRST matching ID to avoid AND logic issues
    if subject_ids:
        # Use the first matching subject ID
        property_filters.append(
            {"property": "dcterms:subject", "type": "res", "id": subject_ids[0]}
        )

    if spatial_ids:
        # Use the first matching spatial ID
        property_filters.append(
            {"property": "dcterms:spatial", "type": "res", "id": spatial_ids[0]}
        )

    if newspaper:
        property_filters.append(
            {"property": "dcterms:publisher", "type": "in", "text": newspaper}
        )

    # Step 4: Fetch articles using either property filters or fulltext search
    if keyword:
        # Use full-text search for keyword (searches all fields)
        items = await client.get_items(
            resource_class_id=client.RESOURCE_CLASSES["articles"],
            fulltext_search=keyword,
            per_page=min(limit, 100),
        )
    elif property_filters:
        # Use property filters
        items = await client.get_items(
            resource_class_id=client.RESOURCE_CLASSES["articles"],
            per_page=min(limit * 2, 100),  # Get more to filter
            property_filters=property_filters,
        )
    else:
        # No filters - get recent articles
        items = await client.get_items(
            resource_class_id=client.RESOURCE_CLASSES["articles"],
            per_page=min(limit, 100),
        )

    if items is None:
        return json.dumps({"error": "Failed to fetch articles"})

    # Step 5: Map to simplified format and apply post-filters
    articles = []
    for item in items:
        article = {
            "id": item.get("o:id"),
            "title": client.extract_value(item, "dcterms:title"),
            "author": client.extract_value(item, "dcterms:creator"),
            "newspaper": client.extract_value(item, "dcterms:publisher"),
            "date": client.extract_value(item, "dcterms:date"),
            "subject": client.extract_value(item, "dcterms:subject"),
            "spatial": client.extract_value(item, "dcterms:spatial"),
            "language": client.extract_value(item, "dcterms:language"),
            "url": client.get_item_url(item.get("o:id")),
        }

        # Post-process filters
        if country and country.lower() not in article.get("spatial", "").lower():
            continue

        if date_from and article.get("date", "") < date_from:
            continue

        if date_to and article.get("date", "") > date_to:
            continue

        articles.append(article)

        if len(articles) >= limit:
            break

    # Build search info note
    search_info = []
    if subject_ids:
        search_info.append(f"subject_id={subject_ids[0]}")
    if spatial_ids:
        search_info.append(f"spatial_id={spatial_ids[0]}")
    if keyword:
        search_info.append("fulltext_search")

    return json.dumps(
        {
            "count": len(articles),
            "results": articles,
            "search_info": " | ".join(search_info) if search_info else "basic listing"
        },
        ensure_ascii=False,
        indent=2
    )


@mcp.tool()
async def get_article(article_id: int) -> str:
    """Get detailed information about a specific IWAC article.

    Args:
        article_id: The Omeka S item ID (o:id) of the article

    Returns:
        JSON object with full article metadata including OCR text
    """
    item = await client.get_item(article_id)

    if item is None:
        return json.dumps({"error": f"Article {article_id} not found"})

    article = {
        "id": item.get("o:id"),
        "title": client.extract_value(item, "dcterms:title"),
        "author": client.extract_value(item, "dcterms:creator"),
        "newspaper": client.extract_value(item, "dcterms:publisher"),
        "date": client.extract_value(item, "dcterms:date"),
        "subject": client.extract_value(item, "dcterms:subject"),
        "spatial": client.extract_value(item, "dcterms:spatial"),
        "language": client.extract_value(item, "dcterms:language"),
        "ocr_text": client.extract_value(item, "bibo:content"),
        "description": client.extract_value(item, "bibo:shortDescription"),
        "url": client.get_item_url(item.get("o:id")),
    }

    return json.dumps(article, ensure_ascii=False, indent=2)


@mcp.tool()
async def search_index(
    query: str, index_type: str | None = None, limit: int = 20
) -> str:
    """Search the IWAC index for persons, places, organizations, or subjects.

    Args:
        query: Search term
        index_type: Filter by type: "Personnes", "Lieux", "Organisations",
                    "Événements", "Sujets" (optional, searches all if not specified)
        limit: Maximum results to return (default 20, max 100)

    Returns:
        JSON array of matching index entries with frequency statistics
    """
    # Map index types to resource class IDs
    type_mapping = {
        "personnes": client.RESOURCE_CLASSES["personnes"],
        "lieux": client.RESOURCE_CLASSES["lieux"],
        "organisations": client.RESOURCE_CLASSES["organisations"],
        "événements": client.RESOURCE_CLASSES["evenements"],
        "sujets": client.RESOURCE_CLASSES["sujets"],
    }

    resource_class_id = None
    if index_type:
        resource_class_id = type_mapping.get(index_type.lower())
        if resource_class_id is None:
            return json.dumps(
                {
                    "error": f"Invalid index_type. Must be one of: {', '.join(type_mapping.keys())}"
                }
            )

    # Search using title property
    property_filters = [{"property": "dcterms:title", "type": "in", "text": query}]

    items = await client.get_items(
        resource_class_id=resource_class_id,
        per_page=min(limit, 100),
        property_filters=property_filters,
    )

    if items is None:
        return json.dumps({"error": "Failed to fetch index entries"})

    # Map to simplified format
    entries = []
    for item in items:
        entry = {
            "id": item.get("o:id"),
            "title": client.extract_value(item, "dcterms:title")
            or client.extract_value(item, "o:title"),
            "type": _get_resource_class_name(item),
            "description": client.extract_value(item, "dcterms:description"),
            "spatial": client.extract_value(item, "dcterms:spatial"),
            "date": client.extract_value(item, "dcterms:date"),
            "url": client.get_item_url(item.get("o:id")),
        }

        # Add person-specific fields if available
        first_name = client.extract_value(item, "foaf:firstName")
        last_name = client.extract_value(item, "foaf:lastName")
        if first_name or last_name:
            entry["first_name"] = first_name
            entry["last_name"] = last_name

        entries.append(entry)

    return json.dumps(
        {"count": len(entries), "results": entries}, ensure_ascii=False, indent=2
    )


@mcp.tool()
async def get_index_entry(entry_id: int) -> str:
    """Get detailed information about an IWAC index entry.

    Args:
        entry_id: The Omeka S item ID of the index entry

    Returns:
        JSON object with entry details including related articles count
    """
    item = await client.get_item(entry_id)

    if item is None:
        return json.dumps({"error": f"Index entry {entry_id} not found"})

    entry = {
        "id": item.get("o:id"),
        "title": client.extract_value(item, "dcterms:title")
        or client.extract_value(item, "o:title"),
        "type": _get_resource_class_name(item),
        "description": client.extract_value(item, "dcterms:description"),
        "spatial": client.extract_value(item, "dcterms:spatial"),
        "date": client.extract_value(item, "dcterms:date"),
        "url": client.get_item_url(item.get("o:id")),
    }

    # Add person-specific fields if available
    first_name = client.extract_value(item, "foaf:firstName")
    last_name = client.extract_value(item, "foaf:lastName")
    if first_name or last_name:
        entry["first_name"] = first_name
        entry["last_name"] = last_name

    return json.dumps(entry, ensure_ascii=False, indent=2)


@mcp.tool()
async def list_subjects(min_frequency: int = 1, limit: int = 50) -> str:
    """List subject terms from the IWAC index, sorted by frequency.

    Args:
        min_frequency: Minimum number of article mentions (default 1)
        limit: Maximum results to return (default 50, max 200)

    Returns:
        JSON array of subjects with frequency counts and date ranges
    """
    items = await client.get_items(
        resource_class_id=client.RESOURCE_CLASSES["sujets"],
        per_page=min(limit, 200),
    )

    if items is None:
        return json.dumps({"error": "Failed to fetch subjects"})

    subjects = []
    for item in items:
        subject = {
            "id": item.get("o:id"),
            "title": client.extract_value(item, "dcterms:title")
            or client.extract_value(item, "o:title"),
            "description": client.extract_value(item, "dcterms:description"),
            "url": client.get_item_url(item.get("o:id")),
        }
        subjects.append(subject)

    return json.dumps(
        {"count": len(subjects), "results": subjects}, ensure_ascii=False, indent=2
    )


@mcp.tool()
async def list_locations(
    country: str | None = None, min_frequency: int = 1, limit: int = 50
) -> str:
    """List geographic locations from the IWAC index.

    Args:
        country: Filter by country (optional)
        min_frequency: Minimum number of article mentions (default 1)
        limit: Maximum results to return (default 50, max 200)

    Returns:
        JSON array of locations with frequency counts
    """
    items = await client.get_items(
        resource_class_id=client.RESOURCE_CLASSES["lieux"], per_page=min(limit, 200)
    )

    if items is None:
        return json.dumps({"error": "Failed to fetch locations"})

    locations = []
    for item in items:
        location = {
            "id": item.get("o:id"),
            "title": client.extract_value(item, "dcterms:title")
            or client.extract_value(item, "o:title"),
            "description": client.extract_value(item, "dcterms:description"),
            "spatial": client.extract_value(item, "dcterms:spatial"),
            "url": client.get_item_url(item.get("o:id")),
        }

        # Filter by country if specified
        if country and country.lower() not in location.get("spatial", "").lower():
            continue

        locations.append(location)

    return json.dumps(
        {"count": len(locations), "results": locations}, ensure_ascii=False, indent=2
    )


@mcp.tool()
async def get_collection_stats() -> str:
    """Get statistics about the IWAC collection.

    Returns:
        JSON object with counts of articles, newspapers, countries,
        date range coverage, and index entry counts by type
    """
    # Fetch a small sample of articles to get metadata
    articles = await client.get_items(
        resource_class_id=client.RESOURCE_CLASSES["articles"], per_page=100
    )

    # Get counts for each index type
    persons = await client.get_items(
        resource_class_id=client.RESOURCE_CLASSES["personnes"], per_page=1
    )
    places = await client.get_items(
        resource_class_id=client.RESOURCE_CLASSES["lieux"], per_page=1
    )
    orgs = await client.get_items(
        resource_class_id=client.RESOURCE_CLASSES["organisations"], per_page=1
    )
    events = await client.get_items(
        resource_class_id=client.RESOURCE_CLASSES["evenements"], per_page=1
    )
    subjects = await client.get_items(
        resource_class_id=client.RESOURCE_CLASSES["sujets"], per_page=1
    )

    stats = {
        "collection_name": "Islam West Africa Collection (IWAC)",
        "base_url": "https://islam.zmo.de",
        "articles_sample_count": len(articles) if articles else 0,
        "index_counts": {
            "persons": len(persons) if persons else 0,
            "places": len(places) if places else 0,
            "organizations": len(orgs) if orgs else 0,
            "events": len(events) if events else 0,
            "subjects": len(subjects) if subjects else 0,
        },
        "note": "Article count is based on sample; actual collection contains 11,500+ articles",
    }

    # Extract unique newspapers and countries from sample
    if articles:
        newspapers = set()
        countries = set()
        dates = []

        for item in articles:
            newspaper = client.extract_value(item, "dcterms:publisher")
            if newspaper:
                newspapers.add(newspaper)

            spatial = client.extract_value(item, "dcterms:spatial")
            if spatial:
                for loc in spatial.split("|"):
                    countries.add(loc.strip())

            date = client.extract_value(item, "dcterms:date")
            if date:
                dates.append(date)

        stats["sample_newspapers_count"] = len(newspapers)
        stats["sample_locations_count"] = len(countries)

        if dates:
            dates.sort()
            stats["sample_date_range"] = {"earliest": dates[0], "latest": dates[-1]}

    return json.dumps(stats, ensure_ascii=False, indent=2)


def _get_resource_class_name(item: dict) -> str:
    """Extract resource class name from Omeka S item."""
    resource_class = item.get("o:resource_class", {})
    if isinstance(resource_class, dict):
        return resource_class.get("o:label", "Unknown")
    return "Unknown"


def main():
    """Run the IWAC MCP server."""
    import asyncio

    # Verify configuration
    if not OMEKA_KEY_IDENTITY or not OMEKA_KEY_CREDENTIAL:
        print("WARNING: Omeka S credentials not configured!")
        print("Please set OMEKA_KEY_IDENTITY and OMEKA_KEY_CREDENTIAL in .env file")

    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
