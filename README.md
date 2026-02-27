# IWAC MCP Server

A read-only [Model Context Protocol](https://modelcontextprotocol.io/) server that provides AI assistants with structured access to the [Islam West Africa Collection (IWAC)](https://islam.zmo.de/s/westafrica). Data is loaded from the [IWAC Hugging Face dataset](https://huggingface.co/datasets/fmadore/islam-west-africa-collection).

## Features

- **16 search and analysis tools** across articles, index entries, publications, references, and audiovisual materials
- **AI sentiment analysis** from three models (Gemini, ChatGPT, Mistral) with comparison tools
- **In-memory DataFrame queries** for fast, offline-capable searches after initial dataset load
- **No API credentials required** -- uses the public Hugging Face dataset

## Installation

### Prerequisites

- Python 3.10+
- [uv](https://docs.astral.sh/uv/) (recommended) or pip

### Setup

```bash
git clone https://github.com/fmadore/iwac-mcp-server.git
cd iwac-mcp-server
uv sync
```

Or with pip:

```bash
git clone https://github.com/fmadore/iwac-mcp-server.git
cd iwac-mcp-server
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -e .
```

## Configuration

The server works out of the box with default settings. Optional configuration via environment variables (all prefixed with `IWAC_`):

| Variable | Default | Description |
|----------|---------|-------------|
| `IWAC_DATASET_NAME` | `fmadore/islam-west-africa-collection` | Hugging Face dataset |
| `IWAC_CACHE_DIR` | HF default | Local cache directory |
| `IWAC_LAZY_LOAD_SUBSETS` | `true` | Load subsets on first access |
| `IWAC_PRELOAD_ARTICLES` | `true` | Preload articles at startup |
| `IWAC_LOAD_EMBEDDINGS` | `false` | Load embedding columns (high memory) |
| `IWAC_SEMANTIC_SEARCH_ENABLED` | `false` | Enable semantic search (requires `IWAC_LOAD_EMBEDDINGS=true`) |

See `.env.example` for a template.

## Usage

### With Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "iwac": {
      "command": "uv",
      "args": ["--directory", "/path/to/iwac-mcp-server", "run", "python", "-m", "iwac_mcp.server"]
    }
  }
}
```

### With Claude Desktop

Edit your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "iwac": {
      "command": "uv",
      "args": ["--directory", "/path/to/iwac-mcp-server", "run", "python", "-m", "iwac_mcp.server"]
    }
  }
}
```

## Available Tools (16)

### Article Search (2 tools)

| Tool | Description |
|------|-------------|
| `search_articles` | Search articles by keyword, country, newspaper, subject, and date range |
| `get_article` | Get full article details including OCR text and sentiment scores |

### Sentiment Analysis (3 tools)

| Tool | Description |
|------|-------------|
| `search_by_sentiment` | Find articles by polarity or centrality from Gemini, ChatGPT, or Mistral |
| `get_sentiment_distribution` | Aggregated polarity/centrality statistics with optional filters |
| `compare_ai_sentiments` | Side-by-side comparison of all three AI models for one article |

### Index (5 tools)

| Tool | Description |
|------|-------------|
| `search_index` | Search authority records (persons, places, organizations, events, subjects) |
| `get_index_entry` | Get detailed index entry with frequency and occurrence data |
| `list_subjects` | List subject terms sorted by frequency |
| `list_locations` | List geographic locations, optionally filtered by country |
| `list_persons` | List persons, optionally filtered by country |

### Collection Statistics (3 tools)

| Tool | Description |
|------|-------------|
| `get_collection_stats` | Overall collection statistics: subset counts, countries, date range |
| `get_newspaper_stats` | Per-newspaper article counts and date ranges |
| `get_country_comparison` | Cross-country comparison with sentiment summaries |

### Other Subsets (3 tools)

| Tool | Description |
|------|-------------|
| `search_publications` | Search Islamic publications (mostly entire issues, limited metadata) |
| `search_references` | Search academic references by keyword, author, or type |
| `list_audiovisual` | List audiovisual materials, optionally filtered by country |

## Development

### Running Tests

```bash
uv run pytest
uv run pytest -v  # verbose
```

### Code Formatting

```bash
uv run ruff check .
uv run ruff format .
```

## Project Structure

```
iwac-mcp-server/
├── src/iwac_mcp/
│   ├── __init__.py
│   ├── server.py        # MCP server with 16 tools
│   ├── hf_client.py     # Hugging Face dataset client
│   └── config.py        # Pydantic settings
├── tests/
│   └── test_tools.py    # Unit tests (21 tests)
├── .claude/
│   └── skills/
│       └── iwac-mcp/    # Research workflow skill for Claude
│           └── references/
├── .mcp.json            # MCP client configuration
├── pyproject.toml
├── LICENSE
└── .env.example
```

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Claude / AI    │────>│  IWAC MCP Server │────>│  Hugging Face   │
│  Assistant      │<────│  (FastMCP)       │<────│  Datasets       │
└─────────────────┘     └──────────────────┘     └─────────────────┘
      │                         │
      │ MCP Protocol            │ In-memory DataFrames
      │ (JSON-RPC/stdio)        │ (loaded once, then cached)
```

## About IWAC

The [Islam West Africa Collection](https://islam.zmo.de/s/westafrica) is a digital archive focused on Islam and Muslims in West Africa. It contains:

- **12,000+ newspaper articles** from Benin, Burkina Faso, Cote d'Ivoire, Niger, Togo, and Nigeria
- **4,600+ index entries** (persons, organizations, places, events, subjects)
- **AI sentiment analysis** from three models (Gemini, ChatGPT, Mistral) on polarity, centrality, and subjectivity
- **Academic references**, Islamic publications, and audiovisual materials
- Coverage from the 1960s to present, primarily in French

## License

MIT

## Related Projects

- [IWAC Hugging Face Dataset](https://huggingface.co/datasets/fmadore/islam-west-africa-collection)
- [IWAC Digital Archive](https://islam.zmo.de/s/westafrica)
