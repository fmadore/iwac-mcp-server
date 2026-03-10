# IWAC Collection Biases and Limitations

Systematic biases and constraints to disclose when producing research outputs.

## 1. Francophone Bias

~96% of articles are in French. This specifically reflects the perspective of **Western-educated Muslims** who followed French-speaking, secular, or Christian school curricula. The collection offers less direct access to *Arabisants* -- prominent Muslim leaders trained in madrasas and major Islamic universities who use Arabic or national languages (Moore, Dioula, Fulfulde, Hausa) to reach non-French-speaking audiences.

- **Overrepresentation** of Western-educated Muslim perspectives, state-affiliated media, and mainstream press framing
- **Underrepresentation** of Arabic-language Islamic scholarship, Hausa-language media (especially Nigerian), vernacular-language religious discourse, and community-internal publications not mediated through French
- **Partial mitigation:** The French-language press regularly gives voice to Arabic-speaking leaders (through interviews, reported speech, and coverage of their activities). The audiovisual subset also includes recordings in Hausa and Arabic.
- **Implication:** Research questions about Islamic intellectual life, internal community debates, or non-francophone Muslim communities require acknowledging that IWAC captures primarily the French-language public sphere

## 2. Geographic Coverage Imbalance

The collection has **deep coverage** for some countries and **very thin coverage** for others:

| Country | Approx. Articles | Coverage Depth |
|---------|-----------------|----------------|
| Burkina Faso | ~3,700 | Deep: multiple newspapers, Islamic + secular press |
| Côte d'Ivoire | ~4,000 | Deep: strong secular press, some Islamic media |
| Benin | ~2,000 | Moderate: mixed secular and Islamic press |
| Togo | ~1,600 | Moderate: several newspapers across decades |
| Niger | ~1,100 | Thin: limited outlets, many articles lack detailed subject tagging |
| Nigeria | ~50 | Minimal: audiovisual materials only, no press articles |

**IMPORTANT:** Niger and Nigeria are dramatically underrepresented compared to Benin, Burkina Faso, Côte d'Ivoire, and Togo. For Niger, many articles lack subject tagging (e.g., 0 articles tagged with "Hadj" despite Niger being a major hajj departure country). For Nigeria, there are virtually no press articles in the collection. Any cross-country comparison involving Niger or Nigeria must prominently disclose this gap. Patterns found in Niger data may reflect tagging gaps rather than genuine differences.

## 3. Temporal Coverage Gaps

- Coverage begins in the 1960s but is sparse before the 1990s
- Post-2000 coverage is significantly denser
- Some newspapers appear only for specific periods (e.g., ceased publication, or only recently digitized)
- **Thematic shift over time:** Before the late 1980s, mainstream press coverage of Islam was narrow, focusing mainly on major religious celebrations (Eid al-Adha, Eid al-Fitr), the pilgrimage to Mecca, mosque inaugurations, and the passing of religious leaders. From the late 1980s onward, political liberalization and the growth of Islamic associations prompted much broader coverage of community activities, internal debates, leadership dynamics, and Muslim public presence. An apparent "increase" in coverage of a topic after 1990 may partly reflect this broadening of press interest, not just changing reality.
- **Implication:** Apparent temporal trends (e.g., "rising coverage of X after 2010") may reflect increasing digitization or evolving press interests rather than changing reality
- **Tip:** Use `date_from` and `date_to` parameters to filter by time period (e.g., `date_from="1970-01-01"`, `date_to="1979-12-31"` for the 1970s)

## 4. AI Sentiment Analysis Caveats

The MCP server exposes Gemini (Flash 3.0) sentiment scores. The underlying dataset also contains ChatGPT and Mistral assessments, but the MCP tools use Gemini only for streamlined retrieval.

### Scale Definitions

All three dimensions evaluate the article's treatment of **Islam and/or Muslims** specifically.

- **Polarity** (emotional orientation): Très positif → Positif → Neutre → Négatif → Très négatif (+ Non applicable)
- **Centrality** (importance of Islam/Muslims): Très central → Central → Secondaire → Marginal → Non abordé
- **Subjectivity** (objectivity of representation): 1 (very objective, purely factual) → 3 (mixed facts and opinions) → 5 (very subjective, editorial style)

### Known Issues
- **Cross-cultural framing:** Gemini, trained primarily on English-language data, may misread French-language West African press conventions
- **Polarity ambiguity:** Articles about Islamic festivals may be rated "Neutre" or "Positif" depending on whether descriptive coverage is interpreted as neutral or positive
- **Centrality vs. mention:** An article that mentions Islam incidentally may be rated "Marginal" or "Secondaire" — the boundary is subjective

### Using Topic-Specific Sentiment
- Use `get_sentiment_distribution(subject="...", country="...")` to get sentiment breakdowns for a specific topic rather than the whole corpus
- `search_articles` results include Gemini polarity, centrality, and subjectivity inline — use these to build topic-specific sentiment tables directly from search results
- Always compare topic-specific sentiment against the corpus baseline to contextualize findings

## 5. Mainstream Press vs. Islamic Press

IWAC contains two structurally different source types:

| Dimension | Mainstream Press | Islamic Press |
|-----------|-----------------|---------------|
| Examples | Sidwaya, Fraternite Matin, Le Pays | An-Nasr Vendredi, Islam Info, La Preuve |
| Perspective | External observer of Muslim communities | Internal community voice |
| Framing | Often event-driven (festivals, conflicts) | Doctrinal, pedagogical, organizational |
| Sentiment | Variable; may frame Islam as "other" | Generally positive toward Islamic practice |
| Coverage | Broader but shallower on Islamic affairs | Narrower but deeper on community life |

**Implication:** Aggregate sentiment statistics mix these structurally different perspectives. A "Neutre" rating on a mainstream press article means something different than on an Islamic publication. Filter by newspaper to separate these sources.

**Note on publications subset:** Most Islamic publications in IWAC are stored as entire issues (not individual articles), with limited metadata. The individual articles within each issue are not separated. This limits searchability of Islamic press content through the `search_publications` tool.

## 6. Editorial and Political Bias

Mainstream newspapers are not neutral observers. Pro-government outlets grant privileged visibility to Muslim groups and leaders close to political power, while marginalizing movements and individuals suspected of opposition sympathies. Opposition press may do the reverse. This editorial framing affects:

- **Who appears:** Which Muslim leaders, associations, and movements receive coverage
- **How they are framed:** Sympathetic vs. critical treatment of the same events or actors
- **What is omitted:** Activities or perspectives that do not align with editorial interests

**Example:** In Burkina Faso, young Francophone "Muslim intellectuals" eclipsed traditional community spokespersons in press coverage during the transition period following the fall of President Blaise Compaore in October 2014. The press reveals who gains media visibility -- and who is marginalized.

**Implication:** When analyzing how a person, organization, or movement appears in coverage, consider which newspaper is reporting and its political orientation. Filter by newspaper to compare framing across outlets.

## 7. Index vs. Full Text

The 4,697 index entries (persons, organizations, places, events, subjects) represent curated authority records, not exhaustive extraction from the full-text corpus. A person may appear in many articles but have no index entry, or vice versa. The `frequency` field in index entries counts links from items, not text mentions.

## 8. Search Limitations

- **Keyword search** (`keyword` parameter) searches title and OCR text only. It does NOT search subject or spatial fields. To find articles by subject, use the `subject` parameter instead.
- **Country filter** requires exact accent matching. You must use `Côte d'Ivoire` (with circumflex ô), not `Cote d'Ivoire`. Other country names do not have accents.
- **All search terms must be in French.** Even if the research question is formulated in English, translate all search queries to French. The collection contains no English-language indexing.

## Disclosure Template

When producing research outputs, include a limitations paragraph adapted from:

> This analysis draws on the Islam West Africa Collection (IWAC), a curated digital archive of [N] documents focused on Muslim public life in francophone West Africa. Key limitations include: (1) ~96% French-language sources, which overrepresent mainstream press and Western-educated Muslim perspectives; (2) uneven geographic coverage, with Burkina Faso and Côte d'Ivoire dominating the corpus while Niger and especially Nigeria are dramatically underrepresented; (3) Gemini sentiment labels that reflect model-specific interpretive choices rather than ground truth. Absence of evidence in this collection should not be interpreted as evidence of absence.
