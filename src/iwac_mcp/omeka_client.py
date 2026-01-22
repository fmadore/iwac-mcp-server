"""Async client for the Omeka S API."""

from typing import Any
import httpx
from urllib.parse import urljoin


class OmekaClient:
    """Async HTTP client for Omeka S REST API."""

    # Resource class IDs from the project spec
    RESOURCE_CLASSES = {
        "articles": 36,
        "lieux": 9,
        "personnes": 94,
        "organisations": 96,
        "evenements": 54,
        "sujets": 244,
    }

    def __init__(self, base_url: str, key_identity: str, key_credential: str):
        """Initialize the Omeka S client.

        Args:
            base_url: Base URL for Omeka S API (e.g., https://islam.zmo.de/api)
            key_identity: API key identity for authentication
            key_credential: API key credential for authentication
        """
        self.base_url = base_url.rstrip("/")
        self.key_identity = key_identity
        self.key_credential = key_credential
        self.timeout = 30.0

    async def _request(
        self, endpoint: str, params: dict[str, Any] | None = None
    ) -> dict | list | None:
        """Make authenticated request to Omeka S API.

        Args:
            endpoint: API endpoint (e.g., "items", "items/123")
            params: Query parameters

        Returns:
            JSON response as dict or list, or None on error
        """
        params = params or {}
        params.update(
            {
                "key_identity": self.key_identity,
                "key_credential": self.key_credential,
            }
        )

        url = urljoin(self.base_url + "/", endpoint)

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            try:
                response = await client.get(url, params=params)
                response.raise_for_status()
                return response.json()
            except httpx.HTTPStatusError as e:
                return {"error": f"HTTP {e.response.status_code}: {e.response.text}"}
            except Exception as e:
                return {"error": str(e)}

    async def get_items(
        self,
        resource_class_id: int | None = None,
        page: int = 1,
        per_page: int = 20,
        property_filters: list[dict[str, str]] | None = None,
        fulltext_search: str | None = None,
        resource_id: int | None = None,
    ) -> list[dict] | None:
        """Get items from Omeka S.

        Args:
            resource_class_id: Filter by resource class ID
            page: Page number (1-indexed)
            per_page: Items per page (max 100)
            property_filters: List of property filter dicts with keys:
                - property: Property term (e.g., "dcterms:subject")
                - type: Filter type (eq, neq, in, nin, ex, nex, res)
                - text: Search text (for text filters)
                - id: Resource ID (for res type filters)
            fulltext_search: Full-text search across all fields
            resource_id: Filter by resource ID for linked resources

        Returns:
            List of item dicts or None on error
        """
        params: dict[str, Any] = {
            "page": page,
            "per_page": min(per_page, 100),
        }

        if resource_class_id is not None:
            params["resource_class_id"] = resource_class_id

        if fulltext_search:
            params["fulltext_search"] = fulltext_search

        if resource_id is not None:
            params["id"] = resource_id

        # Add property filters
        # Omeka S format: property[0][property]=dcterms:subject&property[0][type]=eq&...
        if property_filters:
            for idx, pf in enumerate(property_filters):
                params[f"property[{idx}][property]"] = pf.get("property", "")
                params[f"property[{idx}][type]"] = pf.get("type", "eq")

                # For resource filters (type='res'), use 'id' parameter
                if pf.get("type") == "res" and "id" in pf:
                    params[f"property[{idx}][id]"] = pf.get("id")
                else:
                    params[f"property[{idx}][text]"] = pf.get("text", "")

        result = await self._request("items", params)

        if isinstance(result, dict) and "error" in result:
            return None

        if isinstance(result, list):
            return result

        return None

    async def get_item(self, item_id: int) -> dict | None:
        """Get a single item by ID.

        Args:
            item_id: Omeka S item ID (o:id)

        Returns:
            Item dict or None on error
        """
        result = await self._request(f"items/{item_id}")

        if isinstance(result, dict) and "error" not in result:
            return result

        return None

    @staticmethod
    def extract_value(item: dict, field: str) -> str:
        """Extract value from Omeka S JSON-LD field.

        Args:
            item: Omeka S item dict
            field: Field name (e.g., "dcterms:title")

        Returns:
            Extracted string value, pipe-separated if multiple values
        """
        if field not in item or item[field] is None:
            return ""

        val = item[field]

        # Handle list of values
        if isinstance(val, list):
            parts = [
                str(v.get("display_title") or v.get("@value") or v.get("@id", ""))
                for v in val
            ]
            return "|".join(filter(None, parts))

        # Handle single dict value
        if isinstance(val, dict):
            return val.get("display_title", "") or val.get("@value", "")

        # Handle primitive value
        return str(val)

    @staticmethod
    def get_item_url(item_id: int, site: str = "afrique_ouest") -> str:
        """Get the public URL for an item.

        Args:
            item_id: Omeka S item ID
            site: Site slug (default: afrique_ouest)

        Returns:
            Full URL to item page
        """
        return f"https://islam.zmo.de/s/{site}/item/{item_id}"
