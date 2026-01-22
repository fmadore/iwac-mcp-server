# IWAC MCP Server

A read-only [Model Context Protocol](https://modelcontextprotocol.io/) server that exposes the [Islam West Africa Collection (IWAC)](https://islam.zmo.de) through the Omeka S API, enabling AI assistants like Claude to browse and search the collection programmatically.

## Features

- **Read-only access**: Query 11,500+ newspaper articles and index entries without modifying data
- **Comprehensive search**: Search by subject, location, newspaper, date range, and keywords
- **Index browsing**: Query persons, places, organizations, events, and subjects
- **Structured data**: Returns JSON with metadata and URLs to original Omeka S items
- **Fast & async**: Built with FastMCP and httpx for optimal performance

## Installation

### Prerequisites

- Python 3.10 or higher
- [uv](https://github.com/astral-sh/uv) (recommended) or pip
- Omeka S API credentials for islam.zmo.de

### Using uv (recommended)

```bash
# Clone the repository
git clone https://github.com/yourusername/iwac-mcp-server.git
cd iwac-mcp-server

# Install dependencies
uv sync
```

### Using pip

```bash
# Clone the repository
git clone https://github.com/yourusername/iwac-mcp-server.git
cd iwac-mcp-server

# Create virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -e .
```

## Configuration

1. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` and add your Omeka S API credentials:
   ```bash
   OMEKA_BASE_URL=https://islam.zmo.de/api
   OMEKA_KEY_IDENTITY=your_key_identity
   OMEKA_KEY_CREDENTIAL=your_key_credential
   ```

## Usage with Claude Desktop

### macOS/Linux

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `~/.config/Claude/claude_desktop_config.json` (Linux):

```json
{
  "mcpServers": {
    "iwac": {
      "command": "uv",
      "args": [
        "--directory",
        "/absolute/path/to/iwac-mcp-server",
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
        "C:\\absolute\\path\\to\\iwac-mcp-server",
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

After configuration, restart Claude Desktop. You should see the IWAC tools available in the MCP menu.

## Available Tools

### 1. `search_articles`

Search newspaper articles by various criteria.

**Parameters:**
- `subject` (optional): Filter by subject term (e.g., "Cheikh Ibrahima Niass")
- `spatial` (optional): Filter by geographic location (e.g., "Dakar")
- `newspaper` (optional): Filter by newspaper name (e.g., "Fraternité Matin")
- `country` (optional): Filter by country (e.g., "Côte d'Ivoire")
- `date_from` (optional): Start date (YYYY-MM-DD format)
- `date_to` (optional): End date (YYYY-MM-DD format)
- `keyword` (optional): Search in title and OCR text
- `limit` (optional): Maximum results (default 20, max 100)

**Example queries:**
- "What articles mention Cheikh Ibrahima Niass?"
- "Show me articles about Mecca pilgrimage in Togo"
- "Find articles published in Fraternité Matin about mosques"

### 2. `get_article`

Get detailed information about a specific article including full OCR text.

**Parameters:**
- `article_id` (required): The Omeka S item ID

### 3. `search_index`

Search the index for persons, places, organizations, events, or subjects.

**Parameters:**
- `query` (required): Search term
- `index_type` (optional): Filter by type ("Personnes", "Lieux", "Organisations", "Événements", "Sujets")
- `limit` (optional): Maximum results (default 20, max 100)

**Example queries:**
- "Find information about Person X"
- "List all subjects related to Islamic education"

### 4. `get_index_entry`

Get detailed information about an index entry.

**Parameters:**
- `entry_id` (required): The Omeka S item ID

### 5. `list_subjects`

List subject terms from the IWAC index, sorted by frequency.

**Parameters:**
- `min_frequency` (optional): Minimum number of article mentions (default 1)
- `limit` (optional): Maximum results (default 50, max 200)

### 6. `list_locations`

List geographic locations from the IWAC index.

**Parameters:**
- `country` (optional): Filter by country
- `min_frequency` (optional): Minimum number of article mentions (default 1)
- `limit` (optional): Maximum results (default 50, max 200)

### 7. `get_collection_stats`

Get overview statistics about the collection.

**Returns:** Counts of articles, newspapers, countries, date range coverage, and index entry counts by type.

## Development

### Running Tests

```bash
# Using uv
uv run pytest

# Using pip
pytest
```

### Code Formatting

```bash
# Using uv
uv run ruff check .
uv run ruff format .

# Using pip
ruff check .
ruff format .
```

## Project Structure

```
iwac-mcp-server/
├── pyproject.toml          # Project configuration
├── .env.example            # Environment variables template
├── README.md               # This file
├── src/
│   └── iwac_mcp/
│       ├── __init__.py
│       ├── server.py       # Main MCP server with FastMCP
│       └── omeka_client.py # Omeka S API client (async)
└── tests/
    └── test_tools.py       # Tool unit tests
```

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Claude/AI      │────▶│  IWAC MCP Server │────▶│  Omeka S API    │
│  Assistant      │◀────│  (FastMCP)       │◀────│  islam.zmo.de   │
└─────────────────┘     └──────────────────┘     └─────────────────┘
      │                         │
      │ MCP Protocol            │ REST/JSON-LD
      │ (JSON-RPC/stdio)        │
```

## About IWAC

The Islam West Africa Collection (IWAC) is a digital archive of newspaper articles about Islam and Muslims in francophone West Africa. It contains:

- 11,500+ newspaper articles from 6 countries
- Coverage from 1960s to present
- Comprehensive subject, person, place, and organization indexes
- OCR text and AI-generated summaries

Learn more at [https://islam.zmo.de](https://islam.zmo.de)

## License

[Add your license here]

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## Related Projects

- [IWAC Chatbot](https://github.com/yourusername/iwac-chatbot) - RAG-based chatbot for IWAC
- [IWAC Hugging Face Dataset](https://huggingface.co/datasets/fmadore/islam-west-africa-collection)
- [Omeka S MCP Sample](https://github.com/nakamura196/omeka-s-mcp-sample)

## Contact

For questions about the IWAC collection, please contact [collection maintainer].

For questions about this MCP server, please open an issue on GitHub.
