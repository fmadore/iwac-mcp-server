"""Configuration settings for IWAC MCP Server."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Settings for IWAC MCP Server.

    All settings can be overridden via environment variables with IWAC_ prefix.
    """

    model_config = SettingsConfigDict(
        env_prefix="IWAC_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Dataset loading options
    lazy_load_subsets: bool = True
    """If True, load subsets on first access. If False, load all at startup."""

    preload_articles: bool = True
    """If True, preload articles subset at startup (most commonly used)."""

    load_embeddings: bool = False
    """If True, load embedding columns (increases memory usage significantly)."""

    semantic_search_enabled: bool = False
    """If True, enable semantic search tools (requires load_embeddings=True and a Google API key)."""

    embedding_model: str = "gemini-embedding-2-preview"
    """Gemini model for encoding queries. Must match the model used to generate the embedding_OCR column."""

    embedding_dimensionality: int = 768
    """Dimensionality of embedding vectors. Must match the dimensionality used when generating embeddings."""

    google_api_key: str | None = None
    """Google API key for Gemini embeddings. Falls back to GOOGLE_API_KEY or GEMINI_API_KEY env vars."""

    # Dataset configuration
    dataset_name: str = "fmadore/islam-west-africa-collection"
    """Hugging Face dataset name."""

    # Cache settings
    cache_dir: str | None = None
    """Directory for caching datasets. If None, uses HF default."""


# Global settings instance
settings = Settings()
