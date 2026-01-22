"""Test the updated search implementation."""

import asyncio
import json
import sys
from dotenv import load_dotenv

# Fix Windows encoding
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding='utf-8')

load_dotenv()

from iwac_mcp.server import search_articles


async def test_searches():
    print("=" * 70)
    print("Testing Updated Search Implementation")
    print("=" * 70)

    # Test 1: Search by subject (person name)
    print("\n📝 Test 1: Search for articles about 'Idriss Koudouss Koné'")
    result = await search_articles(subject="Idriss Koudouss Koné", limit=5)
    data = json.loads(result)
    print(f"Found: {data.get('count')} articles")
    if data.get('count', 0) > 0:
        print(f"Sample: {data['results'][0]['title'][:80]}")
        print(f"Subject: {data['results'][0]['subject'][:100]}")
    print(f"Note: {data.get('note', '')}")

    # Test 2: Keyword search (full-text)
    print("\n🔍 Test 2: Keyword search for 'mosquée'")
    result = await search_articles(keyword="mosquée", limit=5)
    data = json.loads(result)
    print(f"Found: {data.get('count')} articles")
    if data.get('count', 0) > 0:
        print(f"Sample: {data['results'][0]['title'][:80]}")

    # Test 3: Search by location
    print("\n📍 Test 3: Search for articles about 'Dakar'")
    result = await search_articles(spatial="Dakar", limit=5)
    data = json.loads(result)
    print(f"Found: {data.get('count')} articles")
    if data.get('count', 0) > 0:
        print(f"Sample: {data['results'][0]['title'][:80]}")
        print(f"Location: {data['results'][0]['spatial'][:100]}")

    # Test 4: Search by newspaper
    print("\n📰 Test 4: Search for articles in 'Fraternité Matin'")
    result = await search_articles(newspaper="Fraternité Matin", limit=3)
    data = json.loads(result)
    print(f"Found: {data.get('count')} articles")
    if data.get('count', 0) > 0:
        print(f"Sample: {data['results'][0]['title'][:80]}")
        print(f"Newspaper: {data['results'][0]['newspaper']}")

    print("\n" + "=" * 70)
    print("✅ Test complete!")
    print("=" * 70)


if __name__ == "__main__":
    asyncio.run(test_searches())
