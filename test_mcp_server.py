"""Test script to verify the IWAC MCP server works."""

import asyncio
import json
import sys
from dotenv import load_dotenv

# Fix Windows encoding issues
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding='utf-8')

# Load environment variables
load_dotenv()

# Import the server module
from iwac_mcp.server import (
    get_collection_stats,
    search_articles,
    search_index,
    client,
)


async def test_omeka_connection():
    """Test basic connection to Omeka S API."""
    print("🔌 Testing Omeka S API connection...")

    items = await client.get_items(
        resource_class_id=client.RESOURCE_CLASSES["articles"],
        per_page=1
    )

    if items and len(items) > 0:
        print("✅ Connected to Omeka S API successfully!")
        print(f"   Found articles in the collection")
        return True
    else:
        print("❌ Failed to connect to Omeka S API")
        return False


async def test_collection_stats():
    """Test get_collection_stats tool."""
    print("\n📊 Testing get_collection_stats tool...")

    result = await get_collection_stats()
    data = json.loads(result)

    print("✅ Collection stats retrieved:")
    print(f"   Collection: {data.get('collection_name')}")
    print(f"   Articles (sample): {data.get('articles_sample_count')}")
    print(f"   Index counts: {data.get('index_counts')}")

    return True


async def test_search_articles():
    """Test search_articles tool."""
    print("\n🔍 Testing search_articles tool...")

    result = await search_articles(limit=5)
    data = json.loads(result)

    if "results" in data and len(data["results"]) > 0:
        print(f"✅ Found {data['count']} articles")
        print(f"   Sample article: {data['results'][0].get('title')[:60]}...")
        print(f"   Newspaper: {data['results'][0].get('newspaper')}")
        print(f"   Date: {data['results'][0].get('date')}")
        return True
    else:
        print("❌ No articles found")
        return False


async def test_search_index():
    """Test search_index tool."""
    print("\n📇 Testing search_index tool...")

    # Search for a common term
    result = await search_index(query="Islam", limit=3)
    data = json.loads(result)

    if "results" in data:
        print(f"✅ Found {data['count']} index entries for 'Islam'")
        if data['count'] > 0:
            print(f"   Sample entry: {data['results'][0].get('title')}")
            print(f"   Type: {data['results'][0].get('type')}")
        return True
    else:
        print("❌ Search failed")
        return False


async def main():
    """Run all tests."""
    print("=" * 60)
    print("🧪 IWAC MCP Server Test Suite")
    print("=" * 60)

    tests = [
        test_omeka_connection,
        test_collection_stats,
        test_search_articles,
        test_search_index,
    ]

    results = []
    for test in tests:
        try:
            result = await test()
            results.append(result)
        except Exception as e:
            print(f"❌ Test failed with error: {e}")
            results.append(False)

    print("\n" + "=" * 60)
    print(f"📈 Test Results: {sum(results)}/{len(results)} passed")
    print("=" * 60)

    if all(results):
        print("✅ All tests passed! The MCP server is working correctly.")
    else:
        print("⚠️  Some tests failed. Check the errors above.")


if __name__ == "__main__":
    asyncio.run(main())
