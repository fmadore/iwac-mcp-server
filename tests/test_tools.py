"""Tests for IWAC MCP Server tools."""

import json
import os
import pytest
from unittest.mock import AsyncMock, patch

from iwac_mcp.server import (
    search_articles,
    get_article,
    search_index,
    get_index_entry,
    list_subjects,
    list_locations,
    get_collection_stats,
)


@pytest.fixture
def mock_client():
    """Create a mock Omeka client."""
    with patch("iwac_mcp.server.client") as mock:
        yield mock


@pytest.mark.asyncio
async def test_search_articles_basic(mock_client):
    """Test basic article search."""
    # Mock response
    mock_client.get_items = AsyncMock(
        return_value=[
            {
                "o:id": 123,
                "dcterms:title": [{"@value": "Test Article"}],
                "dcterms:creator": [{"@value": "John Doe"}],
                "dcterms:publisher": [{"@value": "Test Newspaper"}],
                "dcterms:date": [{"@value": "2020-01-01"}],
                "dcterms:subject": [{"@value": "Islam"}],
                "dcterms:spatial": [{"@value": "Dakar"}],
                "dcterms:language": [{"@value": "fr"}],
            }
        ]
    )

    # Call the tool
    result = await search_articles(limit=10)

    # Parse JSON result
    data = json.loads(result)

    # Assertions
    assert "results" in data
    assert data["count"] == 1
    assert data["results"][0]["id"] == 123
    assert data["results"][0]["title"] == "Test Article"


@pytest.mark.asyncio
async def test_search_articles_with_filters(mock_client):
    """Test article search with filters."""
    mock_client.get_items = AsyncMock(return_value=[])

    result = await search_articles(
        subject="Cheikh Ibrahima Niass", spatial="Dakar", limit=20
    )

    # Verify the client was called with correct parameters
    mock_client.get_items.assert_called_once()
    call_args = mock_client.get_items.call_args

    # Check that property filters were applied
    assert call_args[1]["property_filters"] is not None


@pytest.mark.asyncio
async def test_get_article(mock_client):
    """Test getting a single article."""
    mock_client.get_item = AsyncMock(
        return_value={
            "o:id": 456,
            "dcterms:title": [{"@value": "Detailed Article"}],
            "dcterms:creator": [{"@value": "Jane Smith"}],
            "bibo:content": [{"@value": "Full OCR text here..."}],
        }
    )

    result = await get_article(456)
    data = json.loads(result)

    assert data["id"] == 456
    assert data["title"] == "Detailed Article"
    assert "ocr_text" in data


@pytest.mark.asyncio
async def test_get_article_not_found(mock_client):
    """Test getting a non-existent article."""
    mock_client.get_item = AsyncMock(return_value=None)

    result = await get_article(999)
    data = json.loads(result)

    assert "error" in data


@pytest.mark.asyncio
async def test_search_index(mock_client):
    """Test searching the index."""
    mock_client.get_items = AsyncMock(
        return_value=[
            {
                "o:id": 789,
                "dcterms:title": [{"@value": "Cheikh Ibrahima Niass"}],
                "dcterms:description": [{"@value": "Prominent Senegalese scholar"}],
                "o:resource_class": {"o:label": "Personnes"},
            }
        ]
    )

    result = await search_index(query="Niass", index_type="Personnes")
    data = json.loads(result)

    assert data["count"] == 1
    assert "Niass" in data["results"][0]["title"]


@pytest.mark.asyncio
async def test_list_subjects(mock_client):
    """Test listing subjects."""
    mock_client.get_items = AsyncMock(
        return_value=[
            {
                "o:id": 100,
                "dcterms:title": [{"@value": "Islamic Education"}],
                "dcterms:description": [{"@value": "Topics about education"}],
            }
        ]
    )

    result = await list_subjects(limit=50)
    data = json.loads(result)

    assert "results" in data
    assert isinstance(data["results"], list)


@pytest.mark.asyncio
async def test_list_locations(mock_client):
    """Test listing locations."""
    mock_client.get_items = AsyncMock(
        return_value=[
            {
                "o:id": 200,
                "dcterms:title": [{"@value": "Dakar"}],
                "dcterms:spatial": [{"@value": "Senegal"}],
            }
        ]
    )

    result = await list_locations(country="Senegal")
    data = json.loads(result)

    assert data["count"] >= 0
    assert "results" in data


@pytest.mark.asyncio
async def test_get_collection_stats(mock_client):
    """Test getting collection statistics."""
    # Mock multiple calls for different resource types
    mock_client.get_items = AsyncMock(return_value=[])

    result = await get_collection_stats()
    data = json.loads(result)

    assert "collection_name" in data
    assert "index_counts" in data
    assert "base_url" in data
