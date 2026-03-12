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
    """If True, enable semantic search tools (requires load_embeddings=True)."""

    embedding_model: str = "paraphrase-multilingual-mpnet-base-v2"
    """Sentence-transformers model for encoding queries. Must match the model used to generate dataset embeddings."""

    # Dataset configuration
    dataset_name: str = "fmadore/islam-west-africa-collection"
    """Hugging Face dataset name."""

    # Cache settings
    cache_dir: str | None = None
    """Directory for caching datasets. If None, uses HF default."""


# Global settings instance
settings = Settings()
