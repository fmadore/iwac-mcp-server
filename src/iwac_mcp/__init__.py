"""IWAC MCP Server - Islam West Africa Collection via Hugging Face datasets."""

from .config import settings
from .hf_client import client, HuggingFaceClient
from .server import main

__version__ = "0.2.0"
__all__ = ["settings", "client", "HuggingFaceClient", "main"]
