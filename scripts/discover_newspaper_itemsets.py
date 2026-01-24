"""Discover newspaper item_set IDs from Omeka S API.

This script fetches all item_sets from the Omeka S API and maps them
to newspaper names from country_mapper.py.

Run this once to populate the NEWSPAPER_ITEMSETS mapping.

Usage:
    uv run python scripts/discover_newspaper_itemsets.py
"""

import asyncio
import json
import sys
from pathlib import Path

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from iwac_mcp.omeka_client import OmekaClient
from iwac_mcp.country_mapper import (
    BENIN_NEWSPAPERS,
    BURKINA_FASO_NEWSPAPERS,
    COTE_DIVOIRE_NEWSPAPERS,
    NIGER_NEWSPAPERS,
    TOGO_NEWSPAPERS,
)

import os
from dotenv import load_dotenv

load_dotenv()


async def discover_itemsets():
    """Discover all newspaper item_set IDs."""
    client = OmekaClient(
        os.getenv("OMEKA_BASE_URL", "https://islam.zmo.de/api"),
        os.getenv("OMEKA_KEY_IDENTITY", ""),
        os.getenv("OMEKA_KEY_CREDENTIAL", ""),
    )

    # Combine all newspapers
    all_newspapers = (
        BENIN_NEWSPAPERS
        + BURKINA_FASO_NEWSPAPERS
        + COTE_DIVOIRE_NEWSPAPERS
        + NIGER_NEWSPAPERS
        + TOGO_NEWSPAPERS
    )

    print(f"Looking for {len(all_newspapers)} newspapers in Omeka S...")
    print()

    # Fetch all item_sets (newspapers are stored as item_sets)
    print("Fetching item_sets from API...")
    result = await client._request("item_sets", params={"per_page": 1000})

    if not result or isinstance(result, dict) and "error" in result:
        print("Error fetching item_sets!")
        return

    print(f"Found {len(result)} item_sets total")
    print()

    # Map newspaper names to item_set IDs
    mapping = {}
    found_newspapers = []
    missing_newspapers = []

    for newspaper in all_newspapers:
        found = False
        for item_set in result:
            title = client.extract_value(item_set, "o:title")
            if title == newspaper:
                mapping[newspaper] = item_set.get("o:id")
                found_newspapers.append(newspaper)
                found = True
                break

        if not found:
            missing_newspapers.append(newspaper)

    # Print results
    print("=" * 70)
    print("FOUND NEWSPAPERS")
    print("=" * 70)

    # Group by country
    countries = {
        "Benin": BENIN_NEWSPAPERS,
        "Burkina Faso": BURKINA_FASO_NEWSPAPERS,
        "Côte d'Ivoire": COTE_DIVOIRE_NEWSPAPERS,
        "Niger": NIGER_NEWSPAPERS,
        "Togo": TOGO_NEWSPAPERS,
    }

    for country, newspapers in countries.items():
        country_found = [n for n in newspapers if n in found_newspapers]
        if country_found:
            print(f"\n{country} ({len(country_found)}/{len(newspapers)}):")
            for newspaper in country_found:
                print(f"  {mapping[newspaper]:5d} - {newspaper}")

    print()
    print("=" * 70)
    print("MISSING NEWSPAPERS")
    print("=" * 70)
    if missing_newspapers:
        for country, newspapers in countries.items():
            country_missing = [n for n in newspapers if n in missing_newspapers]
            if country_missing:
                print(f"\n{country} ({len(country_missing)} missing):")
                for newspaper in country_missing:
                    print(f"  - {newspaper}")
    else:
        print("None! All newspapers found.")

    print()
    print("=" * 70)
    print("PYTHON CODE OUTPUT")
    print("=" * 70)
    print()
    print("# Copy this to src/iwac_mcp/newspaper_itemsets.py:")
    print()
    print('"""Newspaper to item_set ID mapping."""')
    print()
    print("NEWSPAPER_ITEMSETS = {")

    for country, newspapers in countries.items():
        country_found = [n for n in newspapers if n in found_newspapers]
        if country_found:
            print(f"    # {country}")
            for newspaper in country_found:
                print(f'    "{newspaper}": {mapping[newspaper]},')
            print()

    print("}")
    print()
    print()
    print("def get_itemset_ids_for_country(country: str) -> list[int]:")
    print('    """Get item_set IDs for all newspapers in a country."""')
    print("    from .country_mapper import get_newspapers_by_country")
    print()
    print("    newspapers = get_newspapers_by_country(country)")
    print("    itemset_ids = []")
    print()
    print("    for newspaper in newspapers:")
    print("        if newspaper in NEWSPAPER_ITEMSETS:")
    print("            itemset_ids.append(NEWSPAPER_ITEMSETS[newspaper])")
    print()
    print("    return itemset_ids")

    print()
    print("=" * 70)
    print("STATISTICS")
    print("=" * 70)
    print(f"Total newspapers in mapping: {len(all_newspapers)}")
    print(f"Found in Omeka S: {len(found_newspapers)}")
    print(f"Missing: {len(missing_newspapers)}")
    print(f"Coverage: {len(found_newspapers)/len(all_newspapers)*100:.1f}%")


if __name__ == "__main__":
    asyncio.run(discover_itemsets())
