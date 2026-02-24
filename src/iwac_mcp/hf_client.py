"""Hugging Face dataset client for IWAC collection."""

import logging
from functools import cached_property
from typing import Any

import pandas as pd
from datasets import load_dataset

from .config import settings

logger = logging.getLogger(__name__)


class HuggingFaceClient:
    """Client for loading and querying IWAC datasets from Hugging Face.

    Provides lazy loading with caching for all dataset subsets.
    """

    DATASET_NAME = settings.dataset_name

    # Subset names
    SUBSETS = ["articles", "publications", "documents", "audiovisual", "index", "references"]

    # Columns to exclude when not loading embeddings
    EMBEDDING_COLUMNS = ["embedding_descriptionAI"]

    def __init__(self):
        """Initialize the client."""
        self._cache: dict[str, pd.DataFrame] = {}
        self._load_kwargs = {
            "cache_dir": settings.cache_dir,
        }

    def _load_subset(self, subset_name: str) -> pd.DataFrame:
        """Load a dataset subset and convert to DataFrame.

        Args:
            subset_name: Name of the subset to load

        Returns:
            DataFrame with the subset data
        """
        if subset_name in self._cache:
            return self._cache[subset_name]

        logger.info(f"Loading {subset_name} subset from Hugging Face...")

        try:
            dataset = load_dataset(
                self.DATASET_NAME,
                name=subset_name,
                **self._load_kwargs,
            )

            # Convert to DataFrame
            df = dataset["train"].to_pandas()

            # Drop embedding columns if not needed
            if not settings.load_embeddings and subset_name == "articles":
                cols_to_drop = [c for c in self.EMBEDDING_COLUMNS if c in df.columns]
                if cols_to_drop:
                    df = df.drop(columns=cols_to_drop)
                    logger.info(f"Dropped embedding columns: {cols_to_drop}")

            # Convert date columns
            if "pub_date" in df.columns:
                df["pub_date"] = pd.to_datetime(df["pub_date"], errors="coerce", utc=True)

            self._cache[subset_name] = df
            logger.info(f"Loaded {len(df)} records from {subset_name}")

            return df

        except Exception as e:
            logger.error(f"Failed to load {subset_name}: {e}")
            raise

    @property
    def articles(self) -> pd.DataFrame:
        """Get articles subset (newspaper articles with OCR, sentiment, topics)."""
        return self._load_subset("articles")

    @property
    def publications(self) -> pd.DataFrame:
        """Get publications subset (Islamic publications, books, periodicals)."""
        return self._load_subset("publications")

    @property
    def documents(self) -> pd.DataFrame:
        """Get documents subset (archival materials)."""
        return self._load_subset("documents")

    @property
    def audiovisual(self) -> pd.DataFrame:
        """Get audiovisual subset (audio/video recordings)."""
        return self._load_subset("audiovisual")

    @property
    def index(self) -> pd.DataFrame:
        """Get index subset (authority records: persons, organizations, places, etc.)."""
        return self._load_subset("index")

    @property
    def references(self) -> pd.DataFrame:
        """Get references subset (academic references)."""
        return self._load_subset("references")

    def preload(self, subsets: list[str] | None = None) -> None:
        """Preload specified subsets into cache.

        Args:
            subsets: List of subset names to preload. If None, preloads based on settings.
        """
        if subsets is None:
            subsets = []
            if settings.preload_articles:
                subsets.append("articles")

        for subset in subsets:
            if subset in self.SUBSETS:
                self._load_subset(subset)

    def get_subset_stats(self) -> dict[str, int]:
        """Get record counts for all subsets.

        Returns:
            Dict mapping subset name to record count
        """
        stats = {}
        for subset in self.SUBSETS:
            try:
                df = self._load_subset(subset)
                stats[subset] = len(df)
            except Exception as e:
                logger.warning(f"Could not load {subset}: {e}")
                stats[subset] = 0
        return stats

    def search_dataframe(
        self,
        df: pd.DataFrame,
        filters: dict[str, Any] | None = None,
        text_search: dict[str, str] | None = None,
        limit: int = 20,
        offset: int = 0,
    ) -> pd.DataFrame:
        """Search a DataFrame with filters and text search.

        Args:
            df: DataFrame to search
            filters: Dict of column -> value for exact matches
            text_search: Dict of column -> search_term for case-insensitive contains
            limit: Maximum results to return
            offset: Number of results to skip

        Returns:
            Filtered DataFrame
        """
        result = df.copy()

        # Apply exact filters
        if filters:
            for col, value in filters.items():
                if col in result.columns and value is not None:
                    result = result[result[col] == value]

        # Apply text search
        if text_search:
            for col, term in text_search.items():
                if col in result.columns and term:
                    result = result[
                        result[col].fillna("").str.contains(term, case=False, na=False)
                    ]

        # Apply pagination
        return result.iloc[offset : offset + limit]


# Global client instance
client = HuggingFaceClient()
