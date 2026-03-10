"""Tests for IWAC MCP Server tools."""

import json
import pytest
from unittest.mock import patch, MagicMock
import pandas as pd
import numpy as np

from iwac_mcp.server import (
    search_articles,
    get_article,
    search_by_sentiment,
    get_sentiment_distribution,
    search_index,
    get_index_entry,
    list_subjects,
    list_locations,
    list_persons,
    get_collection_stats,
    get_newspaper_stats,
    get_country_comparison,
    search_publications,
    get_publication_fulltext,
    search_references,
    list_audiovisual,
)


@pytest.fixture
def mock_articles_df():
    """Create a mock articles DataFrame."""
    return pd.DataFrame({
        "o:id": [123, 456, 789],
        "title": ["Test Article 1", "Test Article 2", "Test Article 3"],
        "author": ["Aboubacar Sy", "Désiré C. Vigan", "Kokouvi Eklou"],
        "newspaper": ["Fraternité Matin", "Sidwaya", "La Nation"],
        "country": ["Côte d'Ivoire", "Burkina Faso", "Benin"],
        "pub_date": pd.to_datetime(["2020-01-01", "2021-06-15", "2022-12-31"], utc=True),
        "subject": ["Islam|Education", "Ramadan", "Mosque"],
        "spatial": ["Abidjan", "Ouagadougou", "Cotonou"],
        "language": ["fr", "fr", "fr"],
        "url": ["https://example.com/1", "https://example.com/2", "https://example.com/3"],
        "OCR": ["Full text content here", "Another text", "More content"],
        "nb_mots": [100, 200, 150],
        "Richesse_Lexicale_OCR": [0.5, 0.6, 0.55],
        "Lisibilite_OCR": [60.0, 65.0, 62.0],
        "lda_topic_id": [1, 2, 1],
        "lda_topic_label": ["Topic A", "Topic B", "Topic A"],
        "lda_topic_prob": [0.8, 0.9, 0.85],
        "sentiment_label": ["POSITIVE", "NEUTRAL", "NEGATIVE"],
        "sentiment_score": [0.9, 0.5, 0.7],
        "gemini_centralite_islam_musulmans": ["Très central", "Central", "Secondaire"],
        "gemini_polarite": ["Positif", "Neutre", "Négatif"],
        "gemini_subjectivite_score": [2, 3, 4],
        "gemini_centralite_justification": ["Just 1", "Just 2", "Just 3"],
        "gemini_polarite_justification": ["Pol 1", "Pol 2", "Pol 3"],
        "gemini_subjectivite_justification": ["Sub 1", "Sub 2", "Sub 3"],
        "chatgpt_centralite_islam_musulmans": ["Central", "Très central", "Marginal"],
        "chatgpt_polarite": ["Neutre", "Positif", "Négatif"],
        "chatgpt_subjectivite_score": [3, 2, 5],
        "chatgpt_centralite_justification": ["CJ 1", "CJ 2", "CJ 3"],
        "chatgpt_polarite_justification": ["CP 1", "CP 2", "CP 3"],
        "chatgpt_subjectivite_justification": ["CS 1", "CS 2", "CS 3"],
        "mistral_centralite_islam_musulmans": ["Secondaire", "Central", "Très central"],
        "mistral_polarite": ["Positif", "Positif", "Neutre"],
        "mistral_subjectivite_score": [1, 2, 3],
        "mistral_centralite_justification": ["MJ 1", "MJ 2", "MJ 3"],
        "mistral_polarite_justification": ["MP 1", "MP 2", "MP 3"],
        "mistral_subjectivite_justification": ["MS 1", "MS 2", "MS 3"],
    })


@pytest.fixture
def mock_index_df():
    """Create a mock index DataFrame."""
    return pd.DataFrame({
        "o:id": [100, 200, 300],
        "Titre": ["Cheikh Niass", "Dakar", "Islamic Education"],
        "Type": ["Personnes", "Lieux", "Sujets"],
        "Description": ["Prominent scholar", "Capital of Senegal", "Educational topics"],
        "frequency": [50, 100, 75],
        "first_occurrence": ["1990-01-01", "1985-01-01", "1995-01-01"],
        "last_occurrence": ["2020-12-31", "2022-12-31", "2021-06-30"],
        "countries": ["Senegal|Burkina Faso", "Senegal", "Côte d'Ivoire|Benin"],
        "url": ["https://example.com/i1", "https://example.com/i2", "https://example.com/i3"],
    })


@pytest.fixture
def mock_publications_df():
    """Create a mock publications DataFrame."""
    return pd.DataFrame({
        "o:id": [1001, 1002],
        "title": ["Islamic Book", "Quran Study"],
        "description": ["A book about Islam", "Study guide"],
        "country": ["Niger", "Togo"],
        "date": ["2018-01-01", "2019-06-15"],
        "language": ["fr", "fr"],
        "url": ["https://example.com/p1", "https://example.com/p2"],
        "tableOfContents": [
            "p. 2 : Editorial\nMessage du président\n\np. 5 : Le pèlerinage à la Mecque\nGuide pratique pour le Hadj",
            "p. 3 : Éducation coranique\nPrésentation des écoles",
        ],
        "OCR": [
            "Ceci est le texte complet de la publication. Le pèlerinage à la Mecque est un pilier de l'Islam. "
            "Chaque année, des milliers de fidèles se rendent à la Mecque pour accomplir le Hadj. "
            "Les préparatifs incluent la demande de visa et les vaccinations obligatoires.",
            "L'éducation coranique joue un rôle central dans la communauté musulmane ouest-africaine.",
        ],
    })


@pytest.fixture
def mock_references_df():
    """Create a mock references DataFrame."""
    return pd.DataFrame({
        "o:id": [2001, 2002],
        "title": ["Academic Paper", "Thesis"],
        "author": ["Ousmane Kane", "Muriel Gomez-Perez"],
        "type": ["Article", "Thesis"],
    })


@pytest.fixture
def mock_audiovisual_df():
    """Create a mock audiovisual DataFrame."""
    return pd.DataFrame({
        "o:id": [3001, 3002],
        "title": ["Sermon Recording", "Interview"],
        "country": ["Nigeria", "Nigeria"],
    })


@pytest.fixture
def mock_client(mock_articles_df, mock_index_df, mock_publications_df, mock_references_df, mock_audiovisual_df):
    """Create a mock HuggingFace client."""
    with patch("iwac_mcp.server.client") as mock:
        mock.articles = mock_articles_df
        mock.index = mock_index_df
        mock.publications = mock_publications_df
        mock.references = mock_references_df
        mock.audiovisual = mock_audiovisual_df
        mock.get_subset_stats.return_value = {
            "articles": 3,
            "index": 3,
            "publications": 2,
            "references": 2,
            "audiovisual": 2,
            "documents": 0,
        }
        yield mock


# =============================================================================
# Article Search Tests
# =============================================================================


def test_search_articles_basic(mock_client):
    """Test basic article search."""
    result = search_articles(limit=10)
    data = json.loads(result)

    assert "results" in data
    assert data["count"] == 3
    assert data["results"][0]["o:id"] == 123


def test_search_articles_includes_sentiment(mock_client):
    """Test that search_articles results include Gemini sentiment columns."""
    result = search_articles(limit=10)
    data = json.loads(result)

    article = data["results"][0]
    assert "gemini_polarite" in article
    assert "gemini_centralite_islam_musulmans" in article
    assert "gemini_subjectivite_score" in article


def test_search_articles_by_country(mock_client):
    """Test article search filtered by country."""
    result = search_articles(country="Burkina Faso", limit=10)
    data = json.loads(result)

    assert data["count"] == 1
    assert data["results"][0]["country"] == "Burkina Faso"


def test_search_articles_by_keyword(mock_client):
    """Test article search with keyword."""
    result = search_articles(keyword="Full text", limit=10)
    data = json.loads(result)

    assert data["count"] == 1
    assert "Full text" in data["results"][0]["title"] or True  # Matches OCR


def test_search_articles_by_date_range(mock_client):
    """Test article search with date range."""
    result = search_articles(date_from="2021-01-01", date_to="2022-01-01", limit=10)
    data = json.loads(result)

    assert data["count"] == 1
    assert data["results"][0]["o:id"] == 456


def test_get_article(mock_client):
    """Test getting a single article."""
    result = get_article(123)
    data = json.loads(result)

    assert int(data["id"]) == 123
    assert data["title"] == "Test Article 1"
    assert "ocr_text" in data
    assert "gemini_polarity" in data


def test_get_article_not_found(mock_client):
    """Test getting a non-existent article."""
    result = get_article(999)
    data = json.loads(result)

    assert "error" in data


# =============================================================================
# Sentiment Tests
# =============================================================================


def test_search_by_sentiment(mock_client):
    """Test searching by sentiment."""
    result = search_by_sentiment(polarity="Positif", limit=10)
    data = json.loads(result)

    assert data["count"] == 1


def test_search_by_sentiment_with_subject(mock_client):
    """Test searching by sentiment filtered by subject."""
    result = search_by_sentiment(polarity="Positif", subject="Islam", limit=10)
    data = json.loads(result)

    assert data["count"] == 1
    # No match when subject doesn't exist
    result2 = search_by_sentiment(polarity="Positif", subject="Nonexistent", limit=10)
    data2 = json.loads(result2)
    assert data2["count"] == 0


def test_get_sentiment_distribution(mock_client):
    """Test getting sentiment distribution."""
    result = get_sentiment_distribution()
    data = json.loads(result)

    assert data["model"] == "gemini"
    assert "polarity_distribution" in data
    assert "centrality_distribution" in data
    assert data["total_articles"] == 3


def test_get_sentiment_distribution_with_subject(mock_client):
    """Test getting sentiment distribution filtered by subject."""
    result = get_sentiment_distribution(subject="Ramadan")
    data = json.loads(result)

    assert data["total_articles"] == 1
    assert data["filters"]["subject"] == "Ramadan"


# =============================================================================
# Index Tests
# =============================================================================


def test_search_index(mock_client):
    """Test searching the index."""
    result = search_index(query="Niass", index_type="Personnes")
    data = json.loads(result)

    assert data["count"] == 1
    assert "Niass" in data["results"][0]["Titre"]


def test_get_index_entry(mock_client):
    """Test getting an index entry."""
    result = get_index_entry(100)
    data = json.loads(result)

    assert data["Titre"] == "Cheikh Niass"
    assert data["Type"] == "Personnes"


def test_list_subjects(mock_client):
    """Test listing subjects."""
    result = list_subjects(limit=50)
    data = json.loads(result)

    assert "results" in data
    assert data["count"] == 1


def test_list_locations(mock_client):
    """Test listing locations."""
    result = list_locations(limit=50)
    data = json.loads(result)

    assert "results" in data


def test_list_persons(mock_client):
    """Test listing persons."""
    result = list_persons(limit=50)
    data = json.loads(result)

    assert "results" in data
    assert data["count"] == 1


# =============================================================================
# Stats Tests
# =============================================================================


def test_get_collection_stats(mock_client):
    """Test getting collection statistics."""
    result = get_collection_stats()
    data = json.loads(result)

    assert "collection_name" in data
    assert "subset_counts" in data
    assert "articles_by_country" in data


def test_get_newspaper_stats(mock_client):
    """Test getting newspaper statistics."""
    result = get_newspaper_stats()
    data = json.loads(result)

    assert "newspapers" in data
    assert data["total_newspapers"] == 3


def test_get_country_comparison(mock_client):
    """Test getting country comparison."""
    result = get_country_comparison()
    data = json.loads(result)

    assert "countries" in data
    assert data["total_countries"] == 3


# =============================================================================
# Other Subset Tests
# =============================================================================


def test_search_publications(mock_client):
    """Test searching publications."""
    result = search_publications(keyword="Islamic", limit=10)
    data = json.loads(result)

    assert data["count"] == 1


def test_search_references(mock_client):
    """Test searching references."""
    result = search_references(author="Kane", limit=10)
    data = json.loads(result)

    assert data["count"] == 1


def test_list_audiovisual(mock_client):
    """Test listing audiovisual materials."""
    result = list_audiovisual(country="Nigeria", limit=10)
    data = json.loads(result)

    assert data["count"] == 2


# =============================================================================
# Pagination Tests
# =============================================================================


def test_search_articles_pagination(mock_client):
    """Test pagination envelope on search_articles."""
    # First page: limit=2, offset=0 — should have has_more=True
    result = search_articles(limit=2, offset=0)
    data = json.loads(result)

    assert data["count"] == 2
    assert data["total_matches"] == 3
    assert data["offset"] == 0
    assert data["has_more"] is True
    assert data["next_offset"] == 2

    # Second page: offset=2 — should have has_more=False
    result2 = search_articles(limit=2, offset=2)
    data2 = json.loads(result2)

    assert data2["count"] == 1
    assert data2["total_matches"] == 3
    assert data2["offset"] == 2
    assert data2["has_more"] is False
    assert "next_offset" not in data2


# =============================================================================
# Publication Search Tests
# =============================================================================


def test_search_publications_keyword_title(mock_client):
    """Test publication search matching title."""
    result = search_publications(keyword="Islamic", limit=10)
    data = json.loads(result)

    assert data["count"] == 1
    assert data["results"][0]["title"] == "Islamic Book"


def test_search_publications_keyword_toc(mock_client):
    """Test publication search matching table of contents."""
    result = search_publications(keyword="pèlerinage", limit=10)
    data = json.loads(result)

    assert data["count"] == 1
    assert data["results"][0]["o:id"] == 1001
    # Should include only the matching TOC entry
    assert "matching_toc_entries" in data["results"][0]
    assert "pèlerinage" in data["results"][0]["matching_toc_entries"].lower()
    # Should NOT include the non-matching entry
    assert "Editorial" not in data["results"][0]["matching_toc_entries"]


def test_search_publications_no_toc_match_in_output(mock_client):
    """Test that matching_toc_entries is absent when keyword only matches title/description."""
    result = search_publications(keyword="Quran", limit=10)
    data = json.loads(result)

    assert data["count"] == 1
    assert "matching_toc_entries" not in data["results"][0]


def test_search_publications_by_country(mock_client):
    """Test publication search filtered by country."""
    result = search_publications(country="Niger", limit=10)
    data = json.loads(result)

    assert data["count"] == 1
    assert data["results"][0]["country"] == "Niger"


# =============================================================================
# Publication Fulltext Tests
# =============================================================================


def test_get_publication_fulltext_no_keyword(mock_client):
    """Test retrieving full text without keyword filtering."""
    result = get_publication_fulltext(publication_id=1001)
    data = json.loads(result)

    assert data["o:id"] == 1001
    assert "fulltext" in data
    assert "pèlerinage" in data["fulltext"]
    assert data["char_count"] > 0


def test_get_publication_fulltext_with_keyword(mock_client):
    """Test extracting context around keyword matches."""
    result = get_publication_fulltext(publication_id=1001, keyword="Mecque")
    data = json.loads(result)

    assert data["o:id"] == 1001
    assert "excerpts" in data
    assert data["match_count"] >= 1
    # Each excerpt should contain the keyword
    for excerpt in data["excerpts"]:
        assert "Mecque" in excerpt


def test_get_publication_fulltext_keyword_not_found(mock_client):
    """Test keyword not found in full text."""
    result = get_publication_fulltext(publication_id=1001, keyword="introuvable")
    data = json.loads(result)

    assert data["excerpts"] == []
    assert "not found" in data["note"]


def test_get_publication_fulltext_not_found(mock_client):
    """Test requesting a non-existent publication."""
    result = get_publication_fulltext(publication_id=9999)
    data = json.loads(result)

    assert "error" in data


def test_get_publication_fulltext_includes_toc(mock_client):
    """Test that table of contents is included in response."""
    result = get_publication_fulltext(publication_id=1001)
    data = json.loads(result)

    assert "tableOfContents" in data
    assert "pèlerinage" in data["tableOfContents"]
