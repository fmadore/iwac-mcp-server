---
type: project
project_type: DH
title: IWAC MCP server
status: planning
date_start: 2026
date_end:
collaborators: []
parent_project: "[[Islam West Africa Collection (IWAC)]]"
source:
tags:
  - MCP
  - Omeka-S
  - API
---
# IWAC MCP server

A read-only [[Model Context Protocol]] server that exposes the Islam West Africa Collection (IWAC) through the Omeka S API, enabling AI assistants like Claude to browse and search the collection programmatically.

## Project Overview

### Motivation

The [[IWAC Chatbot]] project demonstrated the value of making the IWAC accessible through natural language. This MCP server takes a different approach: instead of a RAG-based chatbot, it provides **structured access** to the collection's metadata through standardized tools that any MCP-compatible AI assistant can use.

### Goals

1. **Read-only access**: Query newspaper articles and index entries without modifying data
2. **Focused scope**: Start with articles and two key Dublin Core fields (`dcterms:spatial` and `dcterms:subject`)
3. **Index browsing**: Allow queries like "find information about Person X" by searching the subject index
4. **Transparency**: Return structured data with URLs to original Omeka S items

### Use Cases

- "What articles mention Cheikh Ibrahima Niass?"
- "Show me articles about Mecca pilgrimage in Togo"
- "List all subjects related to Islamic education"
- "Find articles published in Fraternité Matin about mosques"

---

## Architecture

### Technology Stack

| Component | Technology | Rationale |
|-----------|------------|-----------|
| MCP Framework | Python with FastMCP | Simple decorator-based tool definitions |
| HTTP Client | `aiohttp` or `httpx` | Async requests to Omeka S API |
| Configuration | Environment variables | Secure credential management |
| Caching | Optional disk cache | Reduce API load (see existing scripts) |

### System Diagram

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Claude/AI      │────▶│  IWAC MCP Server │────▶│  Omeka S API    │
│  Assistant      │◀────│  (FastMCP)       │◀────│  islam.zmo.de   │
└─────────────────┘     └──────────────────┘     └─────────────────┘
      │                         │
      │ MCP Protocol            │ REST/JSON-LD
      │ (JSON-RPC/stdio)        │
```

---

## Omeka S API Reference

### Base Configuration

```python
OMEKA_BASE_URL = "https://islam.zmo.de/api"
# Authentication via query parameters:
# ?key_identity=XXX&key_credential=YYY
```

### Key Endpoints

| Endpoint | Description | Example |
|----------|-------------|---------|
| `GET /items` | List/search items | `/items?resource_class_id=36&page=1&per_page=100` |
| `GET /items/:id` | Single item details | `/items/12345` |

### Resource Class IDs (from existing scripts)

| ID | Type | Description |
|----|------|-------------|
| 36 | Newspaper articles | Main content (11,500+ articles) |
| 9 | Lieux | Places (spatial index) |
| 94 | Personnes | People (subject index) |
| 96 | Organisations | Organizations |
| 54 | Événements | Events |
| 244 | Sujets/Notices d'autorité | Subjects (item_set 1) / Authority records (item_set 267) |

### Dublin Core Fields Mapping

Based on `upload_newspaper_hf.py`, the key fields for articles are:

| Omeka Field | Mapped Name | Description |
|-------------|-------------|-------------|
| `dcterms:title` | title | Article title |
| `dcterms:creator` | author | Article author(s) |
| `dcterms:publisher` | newspaper | Source newspaper |
| `dcterms:date` | pub_date | Publication date |
| `dcterms:subject` | subject | Subject terms (pipe-separated) |
| `dcterms:spatial` | spatial | Geographic coverage |
| `dcterms:language` | language | Article language |
| `bibo:content` | OCR | Full text (OCR) |
| `bibo:shortDescription` | descriptionAI | AI-generated summary |

### Index Fields Mapping

Based on `upload_index_hf.py`:

| Omeka Field | Mapped Name | Description |
|-------------|-------------|-------------|
| `o:title` | Titre | Index entry title |
| `dcterms:description` | Description | Entry description |
| `dcterms:spatial` | spatial | Related locations |
| `foaf:firstName` / `foaf:lastName` | Prénom/Nom | Person names |
| `dcterms:date` | date | Relevant dates |
| Computed | frequency | Mention count in articles |
| Computed | first_occurrence / last_occurrence | Date range |
| Computed | countries | Countries where mentioned |

---

## MCP Tools Design

### Phase 1: Core Read-Only Tools

#### 1. `search_articles`

Search newspaper articles by various criteria.

```python
@mcp.tool()
async def search_articles(
    subject: str | None = None,
    spatial: str | None = None,
    newspaper: str | None = None,
    country: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    keyword: str | None = None,
    limit: int = 20
) -> str:
    """Search IWAC newspaper articles.

    Args:
        subject: Filter by subject term (e.g., "Cheikh Ibrahima Niass")
        spatial: Filter by geographic location (e.g., "Dakar")
        newspaper: Filter by newspaper name (e.g., "Fraternité Matin")
        country: Filter by country (e.g., "Côte d'Ivoire")
        date_from: Start date (YYYY-MM-DD format)
        date_to: End date (YYYY-MM-DD format)
        keyword: Search in title and OCR text
        limit: Maximum results to return (default 20, max 100)

    Returns:
        JSON array of matching articles with metadata and URLs
    """
```

#### 2. `get_article`

Retrieve detailed information about a specific article.

```python
@mcp.tool()
async def get_article(article_id: int) -> str:
    """Get detailed information about a specific IWAC article.

    Args:
        article_id: The Omeka S item ID (o:id) of the article

    Returns:
        JSON object with full article metadata including OCR text
    """
```

#### 3. `search_index`

Search the index (persons, places, organizations, subjects).

```python
@mcp.tool()
async def search_index(
    query: str,
    index_type: str | None = None,
    limit: int = 20
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
```

#### 4. `get_index_entry`

Get detailed information about an index entry.

```python
@mcp.tool()
async def get_index_entry(entry_id: int) -> str:
    """Get detailed information about an IWAC index entry.

    Args:
        entry_id: The Omeka S item ID of the index entry

    Returns:
        JSON object with entry details including related articles count
    """
```

#### 5. `list_subjects`

List available subject terms with frequency counts.

```python
@mcp.tool()
async def list_subjects(
    min_frequency: int = 1,
    limit: int = 50
) -> str:
    """List subject terms from the IWAC index, sorted by frequency.

    Args:
        min_frequency: Minimum number of article mentions (default 1)
        limit: Maximum results to return (default 50, max 200)

    Returns:
        JSON array of subjects with frequency counts and date ranges
    """
```

#### 6. `list_locations`

List geographic locations with frequency counts.

```python
@mcp.tool()
async def list_locations(
    country: str | None = None,
    min_frequency: int = 1,
    limit: int = 50
) -> str:
    """List geographic locations from the IWAC index.

    Args:
        country: Filter by country (optional)
        min_frequency: Minimum number of article mentions (default 1)
        limit: Maximum results to return (default 50, max 200)

    Returns:
        JSON array of locations with frequency counts
    """
```

#### 7. `get_collection_stats`

Get overview statistics about the collection.

```python
@mcp.tool()
async def get_collection_stats() -> str:
    """Get statistics about the IWAC collection.

    Returns:
        JSON object with counts of articles, newspapers, countries,
        date range coverage, and index entry counts by type
    """
```

---

## Implementation Plan

### Project Structure

```
iwac-mcp-server/
├── pyproject.toml          # Project configuration (uv/pip)
├── .env.example            # Environment variables template
├── README.md               # Usage documentation
├── src/
│   └── iwac_mcp/
│       ├── __init__.py
│       ├── server.py       # Main MCP server with FastMCP
│       ├── omeka_client.py # Omeka S API client (async)
│       ├── cache.py        # Optional caching layer
│       └── models.py       # Data models/types
└── tests/
    └── test_tools.py       # Tool unit tests
```

### Dependencies

```toml
# pyproject.toml
[project]
name = "iwac-mcp-server"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = [
    "mcp[cli]>=1.2.0",
    "httpx>=0.27.0",       # or aiohttp
    "python-dotenv>=1.0.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0.0",
    "pytest-asyncio>=0.23.0",
    "ruff>=0.4.0",
]
```

### Environment Variables

```bash
# .env
OMEKA_BASE_URL=https://islam.zmo.de/api
OMEKA_KEY_IDENTITY=your_key_identity
OMEKA_KEY_CREDENTIAL=your_key_credential

# Optional: Enable caching
IWAC_CACHE_ENABLED=true
IWAC_CACHE_DIR=.cache
IWAC_CACHE_HOURS=24
```

### Server Implementation Skeleton

```python
# src/iwac_mcp/server.py
from typing import Any
import os
import httpx
from mcp.server.fastmcp import FastMCP
from dotenv import load_dotenv

load_dotenv()

# Initialize FastMCP server
mcp = FastMCP("iwac")

# Configuration
OMEKA_BASE_URL = os.getenv("OMEKA_BASE_URL", "https://islam.zmo.de/api")
OMEKA_KEY_IDENTITY = os.getenv("OMEKA_KEY_IDENTITY", "")
OMEKA_KEY_CREDENTIAL = os.getenv("OMEKA_KEY_CREDENTIAL", "")


async def omeka_request(endpoint: str, params: dict[str, Any] = None) -> dict | None:
    """Make authenticated request to Omeka S API."""
    params = params or {}
    params.update({
        "key_identity": OMEKA_KEY_IDENTITY,
        "key_credential": OMEKA_KEY_CREDENTIAL,
    })

    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            response = await client.get(
                f"{OMEKA_BASE_URL}/{endpoint}",
                params=params
            )
            response.raise_for_status()
            return response.json()
        except Exception as e:
            return {"error": str(e)}


@mcp.tool()
async def search_articles(
    subject: str | None = None,
    spatial: str | None = None,
    newspaper: str | None = None,
    limit: int = 20
) -> str:
    """Search IWAC newspaper articles.

    Args:
        subject: Filter by subject term (e.g., "Cheikh Ibrahima Niass")
        spatial: Filter by geographic location (e.g., "Dakar")
        newspaper: Filter by newspaper name
        limit: Maximum results (default 20, max 100)
    """
    import json

    params = {
        "resource_class_id": 36,  # Newspaper articles
        "per_page": min(limit, 100),
    }

    # Add property filters as needed
    # Note: Omeka S property filtering syntax:
    # property[0][property]=dcterms:subject
    # property[0][type]=eq
    # property[0][text]=search_term

    result = await omeka_request("items", params)

    if not result or "error" in result:
        return json.dumps({"error": "Failed to fetch articles"})

    # Map to simplified format
    articles = []
    for item in result:
        articles.append({
            "id": item.get("o:id"),
            "title": _extract_value(item, "dcterms:title"),
            "author": _extract_value(item, "dcterms:creator"),
            "newspaper": _extract_value(item, "dcterms:publisher"),
            "date": _extract_value(item, "dcterms:date"),
            "subject": _extract_value(item, "dcterms:subject"),
            "spatial": _extract_value(item, "dcterms:spatial"),
            "url": f"https://islam.zmo.de/s/afrique_ouest/item/{item.get('o:id')}"
        })

    return json.dumps(articles, ensure_ascii=False, indent=2)


def _extract_value(item: dict, field: str) -> str:
    """Extract value from Omeka S JSON-LD field."""
    if field not in item or item[field] is None:
        return ""
    val = item[field]
    if isinstance(val, list):
        parts = [
            str(v.get("display_title") or v.get("@value") or v.get("@id", ""))
            for v in val
        ]
        return "|".join(filter(None, parts))
    if isinstance(val, dict):
        return val.get("display_title", "") or val.get("@value", "")
    return str(val)


def main():
    """Run the IWAC MCP server."""
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
```

---

## Claude Desktop Configuration

### macOS/Linux

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `~/.config/Claude/claude_desktop_config.json` (Linux):

```json
{
  "mcpServers": {
    "iwac": {
      "command": "uv",
      "args": [
        "--directory",
        "/path/to/iwac-mcp-server",
        "run",
        "python",
        "-m",
        "iwac_mcp.server"
      ],
      "env": {
        "OMEKA_KEY_IDENTITY": "your_key_identity",
        "OMEKA_KEY_CREDENTIAL": "your_key_credential"
      }
    }
  }
}
```

### Windows

Edit `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "iwac": {
      "command": "uv",
      "args": [
        "--directory",
        "C:\\path\\to\\iwac-mcp-server",
        "run",
        "python",
        "-m",
        "iwac_mcp.server"
      ],
      "env": {
        "OMEKA_KEY_IDENTITY": "your_key_identity",
        "OMEKA_KEY_CREDENTIAL": "your_key_credential"
      }
    }
  }
}
```

---

## Reference Resources

### Existing Code

- **Field mapping logic**: `C:\Users\frede\GitHub\IWAC-Hugging-Face\upload_newspaper_hf.py`
- **Index field mapping**: `C:\Users\frede\GitHub\IWAC-Hugging-Face\index\upload_index_hf.py`
- **Country mapping**: `C:\Users\frede\GitHub\IWAC-Hugging-Face\country_mapper.py`

### External References

- **Omeka S MCP sample**: https://github.com/nakamura196/omeka-s-mcp-sample
- **MCP Documentation**: https://modelcontextprotocol.io/
- **MCP Python SDK**: https://github.com/modelcontextprotocol/python-sdk
- **MCP Servers repository**: https://github.com/modelcontextprotocol/servers
- **Omeka S REST API**: https://omeka.org/s/docs/developer/api/rest_api/

---

## Future Enhancements (Phase 2+)

1. **Resources**: Expose articles as MCP resources with URIs like `iwac://article/12345`
2. **Full-text search**: Add Elasticsearch or similar for OCR content searching
3. **Semantic search**: Integrate embeddings from the Hugging Face dataset
4. **Other subsets**: Audiovisual materials, publications, documents
5. **Caching layer**: Redis or disk cache for frequently accessed data
6. **Rate limiting**: Protect Omeka S API from excessive requests

---

## Development Roadmap

### Milestone 1: MVP
- [ ] Set up project structure with uv
- [ ] Implement `OmekaClient` with authentication
- [ ] Implement `search_articles` tool
- [ ] Implement `get_article` tool
- [ ] Test with Claude Desktop

### Milestone 2: Index Support
- [ ] Implement `search_index` tool
- [ ] Implement `get_index_entry` tool
- [ ] Implement `list_subjects` and `list_locations` tools

### Milestone 3: Polish
- [ ] Add caching layer
- [ ] Implement `get_collection_stats` tool
- [ ] Write documentation
- [ ] Publish to GitHub

---

## Notes

- The server is **read-only** by design to prevent accidental data modification
- All tools return JSON strings (MCP requirement) with proper Unicode handling
- Error handling should be robust - return error messages rather than raising exceptions
- Consider pagination for large result sets
- The existing Python scripts in `IWAC-Hugging-Face` provide tested field extraction logic

