# IWAC Collection Biases and Limitations

Systematic biases and constraints to disclose when producing research outputs.

## 1. Francophone Bias

~96% of articles are in French. This reflects the collection's focus on francophone West African press, but creates systematic distortions:

- **Overrepresentation** of Western-educated Muslim perspectives, state-affiliated media, and mainstream press framing
- **Underrepresentation** of Arabic-language Islamic scholarship, Hausa-language media (especially Nigerian), vernacular-language religious discourse, and community-internal publications not mediated through French
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
- **Implication:** Apparent temporal trends (e.g., "rising coverage of X after 2010") may reflect increasing digitization rather than changing reality
- **Tip:** Use `date_from` and `date_to` parameters to filter by time period (e.g., `date_from="1970-01-01"`, `date_to="1979-12-31"` for the 1970s)

## 4. OCR Quality Variation

- **1960s-1980s newsprint:** Often poor OCR quality due to degraded print, low-resolution scans, mixed fonts. Keyword searches may miss relevant articles due to OCR errors
- **1990s-2000s:** Moderate quality, depends on print condition
- **2010s-present:** Generally good quality, especially for web-archived articles
- **Arabic script:** OCR on Arabic-script text within French-language articles is unreliable
- **Implication:** Word counts (`nb_mots`), lexical metrics (`Richesse_Lexicale_OCR`, `Lisibilite_OCR`), and keyword search completeness are all affected by OCR quality. Earlier periods are systematically disadvantaged in keyword searches.

## 5. AI Sentiment Analysis Caveats

Three AI models (Gemini Flash 3.0, ChatGPT GPT-5 mini, Mistral Ministral 14B) independently assessed each article on three dimensions:

### Known Issues
- **Cross-cultural framing:** Models trained primarily on English-language data may misread French-language West African press conventions
- **Polarity ambiguity:** Articles about Islamic festivals may be rated differently by different models (e.g., "Neutre" vs. "Positif") depending on whether the model interprets descriptive coverage as neutral or positive
- **Centrality vs. mention:** An article that mentions Islam incidentally may be rated "Marginal" by one model and "Secondaire" by another
- **Subjectivity scores:** The 1-5 scale is inherently subjective; models calibrate differently

### Interpreting Disagreement
- **All 3 models agree:** Higher confidence in the assessment
- **2 agree, 1 differs:** Moderate confidence; note the dissenting model
- **All 3 disagree:** Low confidence; the article likely has ambiguous framing. Treat as a signal to read the OCR text directly

## 6. Mainstream Press vs. Islamic Press

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

## 7. Index vs. Full Text

The 4,697 index entries (persons, organizations, places, events, subjects) represent curated authority records, not exhaustive extraction from the full-text corpus. A person may appear in many articles but have no index entry, or vice versa. The `frequency` field in index entries counts links from items, not text mentions.

## 8. Search Limitations

- **Keyword search** (`keyword` parameter) searches title and OCR text only. It does NOT search subject or spatial fields. To find articles by subject, use the `subject` parameter instead.
- **Country filter** requires exact accent matching. You must use `Côte d'Ivoire` (with circumflex ô), not `Cote d'Ivoire`. Other country names do not have accents.
- **All search terms must be in French.** Even if the research question is formulated in English, translate all search queries to French. The collection contains no English-language indexing.

## Disclosure Template

When producing research outputs, include a limitations paragraph adapted from:

> This analysis draws on the Islam West Africa Collection (IWAC), a curated digital archive of [N] documents focused on Muslim public life in francophone West Africa. Key limitations include: (1) ~96% French-language sources, which overrepresent mainstream press and Western-educated Muslim perspectives; (2) uneven geographic coverage, with Burkina Faso and Côte d'Ivoire dominating the corpus while Niger and especially Nigeria are dramatically underrepresented; (3) variable OCR quality, especially for pre-1990s materials; (4) AI-generated sentiment labels that reflect model-specific interpretive choices rather than ground truth. Absence of evidence in this collection should not be interpreted as evidence of absence.
