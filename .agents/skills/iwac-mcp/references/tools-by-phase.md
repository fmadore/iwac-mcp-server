# IWAC MCP Tools by Research Phase

37 possible tools (34 core + 3 optional semantic) organized by the workflow phase where they are most useful. Server **v0.8.0+**: **all keyword/filter matching is accent- and case-insensitive**; result rows use short English keys (`id`, `date`, `polarity`, `centrality`, `subjectivity`, `description_ai`, `url`) and omit empty fields. List/search tools return a pagination envelope — `count`, `total_matches`, `offset`, `limit` (applied), `has_more`, `next_offset`, plus `requested_limit` + `limit_warning` when you exceed a tool's max. Enumerated filters (`country`, `polarity`, `centrality`, `index_type`, and on the temporal tool `subset`, `granularity`, `group_by`) are **validated**: an invalid value returns `{error, valid_values}` (`isError`) instead of a silent zero-result. Server **v0.9.0+** adds `get_temporal_distribution` (counts per year/month — use it for any "how did coverage evolve" question instead of paging through searches).

## Cross-Collection Entry Points

### search
Cross-subset search for skill-less clients and quick discovery.
- `query` (required): one concept, name, or short phrase. Tokens are AND-ed across each subset's searchable fields; use French concepts for primary-source discovery, and French/English terms for references. A query whose every word is under 2 characters is **refused** (it would otherwise return an empty result indistinguishable from a real absence).
- `limit` (default 20, max 50)
- Returns `results` with namespaced ids (`articles:28576`, `references:11045`, `images:12237`), `title`, `url`, `category`, plus a `ranking` note and `deep_scan`. There is no numeric relevance score; for precise filters use the granular `search_*` tools.
- **Two passes.** Pass 1 matches curated metadata only (titles, subjects, AI abstracts in both languages, tables of contents) and answers in ~0.2 s; if that fills fewer than `limit` results, pass 2 also scans the full OCR (~2.5 s) and `deep_scan: true` says so. A common term therefore never pays for the OCR scan, and a rare one still finds everything — but treat `search` as discovery, not a census: for exhaustive counts use `search_*` or `get_temporal_distribution`.

### fetch
Fetch one item returned by `search`.
- `id` (required): namespaced id from `search`, e.g. `articles:28576`
- Returns `id`, `title`, `text`, `url`, `category`, and `metadata`. Long text may be capped; when that happens, `recommended_tool` points to the subset-specific full-text tool to call with a `keyword`.

## Phase 1: Scoping Tools

### get_collection_stats *(reports `fulltext_coverage` since v0.12.0)*
Overall collection statistics: subset record counts, articles by country, date range, newspaper count, and **`fulltext_coverage`** — how many items in each subset actually carry OCR in this public dataset (~61% of articles, ~86% of publications; the rest are masked per row by `OCR_is_public`). Read it before reporting any keyword total as a corpus-wide figure.
- No parameters. Use first to understand scale. (First call may trigger the parquet download.)

### get_country_comparison
Compare statistics across the 5 article countries (Nigeria has no press articles).
- No parameters
- Returns per-country article counts, newspaper counts, date ranges, and a per-country `polarity` breakdown with `polarity_model` naming the model that produced it (`gpt-5-6-luna`)

### get_newspaper_stats
Newspaper-level statistics.
- `country` (optional): exact name — Benin | Burkina Faso | Côte d'Ivoire | Niger | Togo
- Returns newspaper names, article counts, date ranges

### list_subjects
List the 214 curated subject terms sorted by frequency.
- `limit` (default 50, max 200), `offset`
- Returns id, title, description, frequency, url

### list_locations
List the 683 geographic locations from the index, ranked by frequency.
- `country` (optional, exact name) — selects places **mentioned in records from that country, not located there** (so Beninese sources surface La Mecque, Côte d'Ivoire, etc.); `frequency` is the entry's collection-wide total, not a per-country count. The response adds a `note` restating this. Nigeria returns nothing (index frequency derives from articles/publications/references).
- `limit` (default 50, max 200), `offset`

### list_persons
List the 2,833 persons from the index, ranked by frequency.
- `country` (optional, exact name) — selects persons **mentioned in records from that country** (same mentioned-in semantics as list_locations; `frequency` is collection-wide).
- `limit` (default 50, max 200), `offset`

### list_periodicals
The 25 Islamic periodical/series titles in the publications subset, with issue counts and year ranges (e.g. Islam Info 695 issues, An-Nasr Vendredi 318, Islam Hebdo 122).
- `country` (optional, exact name)
- Use the returned `newspaper` value as the `newspaper` filter on `search_publications`

---

## Phase 2: Systematic Search Tools

### search_articles
Primary search tool for the 12,287 newspaper articles.
- `keyword` (optional): substring match on **title + OCR + AI abstracts, French and English** (does NOT search subject/spatial — use the `subject` parameter for curated tags). An English term can therefore match a French article via its English summary
- `country` (optional): exact name — Benin | Burkina Faso | Côte d'Ivoire | Niger | Togo
- `newspaper` (optional): substring match
- `subject` (optional): substring match on the pipe-separated curated tags
- `date_from` / `date_to` (optional): `YYYY-MM-DD` or `YYYY` (day precision)
- `hijri_month` / `hijri_year` (optional) *(v1.3.0+)*: Islamic (Umm al-Qura) lunar date. `hijri_month` takes 1–12 or a name in either transliteration (`Ramadan`, `Chaabane`, `Chawwal`, `Dhou al-hijja`), accent- and case-folded; a misspelling errors with `valid_values`. Matches only articles with a complete `YYYY-MM-DD` (98.9%). This is how you read the items behind a `granularity="lunar_month"` peak — and it beats keyword-searching an observance name, which finds items *mentioning* it rather than items *published during* it.
- `with_description` (optional, boolean): include each article's ~500-char AI abstract (`description_ai`) — ~125 tokens/row, pair with limit ≤ 10
- `limit` (default 20, max 100 — 10 and 25 with `with_description`, since 100 rows carrying abstracts overrun the client's tool-result cap), `offset`
- Returns: id, title, author, newspaper, country, date, **hijri_date** (`1440-09-15`, v1.3.0+), subject, spatial, language, **polarity**, **centrality**, **subjectivity**, url

**Tip:** Sentiment comes inline — build topic-specific sentiment tables directly from search results. With `with_description=true` you can usually pick the 2-3 articles worth a full `get_article` without any intermediate calls.

### semantic_search_articles *(optional — requires semantic search enabled + Google API key)*
Semantic similarity over article OCR via Gemini embeddings. Coverage is effectively complete: 12,286/12,287 articles are embedded.
- `query`: natural language, **any language**
- `country` / `newspaper` / `date_from` / `date_to` (optional post-filters), `limit` (default 10, max 50)
- Returns article summaries ranked by `similarity_score`
- Complement to keyword search for conceptual queries ("Islamic education reform" finds madrasa modernization, Franco-Arabic schooling…). Not a replacement.

### search_index
Search the 4,697 authority records by name.
- `keyword`: matched against the entry title (accent-insensitive)
- `index_type` (optional): exact type, **validated** (accents optional) — Personnes | Lieux | Organisations | Événements | Sujets | Notices d'autorité; an unrecognised value errors with `valid_values`
- `limit` (default 20, max 100), `offset`
- Returns: id, title, type, description, frequency, first_occurrence, last_occurrence, countries, url

### search_by_sentiment
Filter articles by **`gpt-5-6-luna`** sentiment labels (exact match, accents optional). One model's reading, not a consensus — say so when reporting, and use `get_sentiment_distribution(model="all")` to see how far the other four agree.

- `disputed` (optional, validated) *(v3.5.0+)*: `polarite` | `centralite` | `subjectivite` — keep only the articles the panel **split on** for that field. French field names, as stored; the English spellings error with `valid_values`. This is how you read the contested cases rather than merely counting them: `disputed="polarite"` returns the 429 articles where no majority formed, which are exactly the ones a single model's label would misrepresent as settled. Combines with the country, subject and date filters.
- `polarity` (optional): Très positif | Positif | Neutre | Négatif | Très négatif | Non applicable
- `centrality` (optional): Très central | Central | Secondaire | Marginal | Non abordé
- `subjectivity` (optional): Très objectif | Plutôt objectif | Mixte | Plutôt subjectif | Très subjectif. Filterable since v2.0.0, when generation 2 turned this field from a 1-5 rating into a closed label vocabulary — a numeric value now errors. Unscored where the model answered `Non abordé`, so this filter excludes those rows too. It is the weakest of the three scales: use it to *find* articles to read, not to count them
- `country` (optional, exact name), `subject` (optional)
- `limit` (default 20, max 100), `offset`

### search_publications
Search the 1,501 Islamic publications (mostly complete periodical issues; OCR is 97% filled, median ~16k tokens/issue).
- `keyword` (optional): substring match on title + subject + **table of contents** + OCR
- `newspaper` (optional): periodical/series title — discover via `list_periodicals`
- `subject` (optional): ~87% of issues are tagged
- `country` (optional, exact name)
- `date_from` / `date_to` (optional): years (YYYY)
- `hijri_month` / `hijri_year` (optional) *(v1.3.0+)*: same semantics as on `search_articles`, but only ~83% of issues carry a complete date (many are `YYYY-MM` or a `1981-04/1981-06` range), so a lunar filter reaches a smaller share here — say so if the count carries an argument
- `limit` (default 20, max 100), `offset`
- Returns: id, title, newspaper, country, date, language, subject, nb_pages, url — plus `matching_toc_entries` when the keyword hits an issue's table of contents (325/1,501 issues have one; see `semantic_search_publications` below for series coverage)

### search_references
Search the 864 academic references. The records are multilingual: search title/abstract keywords in French and English when relevant. Metadata/filter values such as `reference_type` and `language` use French labels.
- `keyword` (optional): substring on title + abstract. **One term per call** ("pèlerinage Mecque" as one string misses results with only one word). Try French and English concept terms when searching abstracts.
- `author` (optional)
- `reference_type` (optional), substring match. Values: Article de revue (298) | Chapitre de livre (246) | Livre (101) | Mémoire de maitrise (62) | Rapport (49) | Thèse de doctorat (42) | Communication scientifique | Compte rendu de livre | Article d'encyclopédie | Mémoire de licence | Article de blog | Working paper. Use the full label — "Livre" alone also matches "Chapitre de livre" and "Compte rendu de livre".
- `subject` (optional): sparse, ~27% tagged
- `country` (optional, exact name; Nigeria valid here)
- `language` (optional): Français | Anglais
- `date_from` / `date_to` (optional): years
- `limit` (default 20, max 100), `offset`
- Returns summary + `abstract_snippet` (320 chars) + doi — full abstract via `get_reference`

### search_documents
Search the 26 archival documents (Islamic association reports, flyers, project documents — 19 Burkina Faso, 4 Togo, 2 Benin). All have OCR + AI description.
- `keyword` (optional): substring on title + OCR + AI description + subject
- `country` (optional, exact name), `limit` (default 15, max 50), `offset`
- Call with no arguments to list all 26.

### list_audiovisual
The 1,771 audiovisual items (August 2026 — the subset grew 38× from the 47 of July). Two very different populations:
- **1,724 harvested web videos** (YouTube), 1,715 of them in French: Burkina Faso 1,100, Togo 536, Benin 90. Mostly 2020-2026. Publishers are broadcasters and Muslim associations — RTB (639), AEEM Togo (532), CERFI (409). No `media_url` and no `creator`; the video lives at its source.
- **47 deposited recordings** (DVD/CD), 45 of them Nigerian in Hausa/Arabic — the original subset, with `creator`, `source` and `media_url`.

AI summaries are empty for all 1,771 and only 50 transcriptions ship publicly, so the item's own **`description`** (filled for 1,465 rows — the YouTube blurb, or a bilingual synopsis on the deposited recordings) is the real text surface here. Search rows carry a 320-character `description_snippet`; `get_audiovisual` returns it whole.

**Three links, three meanings** (since v3.2.0): `url` is the IWAC catalogue page — the one to cite; `external_url` is where a harvested video plays; `media_url` is a deposited file. A row carries one of the latter two, never both, and `source_type` (`youtube` | `deposited`) says which. Do not read a missing `media_url` as a broken record.
- `country` (optional — Burkina Faso | Togo | Benin | Nigeria; Niger and Côte d'Ivoire have no audiovisual items), `publisher` (optional substring on the channel), `source_type` (optional, validated), `limit` (default 20, max 50), `offset`
- Returns: id, title, creator, publisher, country, date, medium, duration_seconds, subject, spatial, language, description_snippet, source_type, external_url, media_url, url

### search_audiovisual
Search the audiovisual subset by title/metadata, **description** and **transcription**. Carrying the description roughly doubles keyword reach (measured 2026-08-17: "ramadan" 190 → 317 items, "imam" 230 → 358).
- `keyword` (optional): substring over title, creator, publisher, subject, spatial, language, source, the description (1,465/1,771 rows), the transcription (`OCR`, 50/1,771) and AI description where present
- `country` (optional), `language` (optional exact pipe value — Français 1,715, Haoussa ~43, Mooré 10, Arabe, Anglais), `medium` (Vidéo sur le web | DVD | CD — carrier media, validated, accents optional), `publisher` (optional substring: the channel or broadcaster — RTB 639, AEEM Togo 532, CERFI 409), `source_type` (`youtube` | `deposited`, validated), `subject` (optional exact tag, but only 27 rows carry one), `limit` (default 20, max 50), `offset`
- Returns the same summary fields as `list_audiovisual`
- **Prefer `publisher` over `subject` here.** 1,769 of 1,771 rows name a channel and only 27 carry a subject tag, so the channel is the one facet that actually partitions this subset — and it is a meaningful one: a state broadcaster (RTB) and a student association (AEEM Togo) are different kinds of source, not just different names

### search_images *(new July 2026)*
The 30 fieldwork photographs (mosques, radio stations, schools, signage, street scenes). Captions are almost absent (2/30), so prefer `subject`/`spatial` filters or `semantic_search_images` over keywords.
- `keyword` (optional): substring over title, creator, subject, spatial and the rare caption
- `country`, `subject` (exact pipe value), `spatial` (exact pipe value), `creator` (substring), `date_from`, `date_to`, `limit` (default 20, max 50), `offset`
- Returns: id, title, creator, date, country, spatial, coordinates (`"lat, lng"`), subject, image_url, url

### semantic_search_images *(optional — requires semantic search enabled + Google API key)*
**Cross-modal.** Ranks against `embedding_image`, a multimodal embedding of the photograph *itself* in the same 768-dim space as the text vectors — so describing what an image shows works even though 28 of 30 have no caption.
- `query` (describe the visual content, any language), `country` (optional), `limit` (default 10, max 30)

### semantic_search_publications *(optional — requires semantic search enabled + Google API key)*
Semantic similarity over publication **tables of contents** via Gemini embeddings. TOC coverage (verified June 2026): **325/1,501 issues (~22%)**, all embedded — **complete for 17 of the 25 series** (Le Rendez-Vous 78, Plume Libre 49, L'Appel 48, Alif 32, La Preuve 28, An-Nasr Trimestriel 16, Le CERFIste 13, Al-Azan 13, ASSALAM 11, Al Mawadda 11, Al Maoulid Info 7, Le Pacific 6, Al Maoulid Magazine 5, AJMCI Infos 4, Al Muwassat Info 2, Bulletin d'information du CNI 1, Les Échos de l'AEEMCI 1), but **zero for the three largest** (Islam Info 695, An-Nasr Vendredi 318, Islam Hebdo 122) and five other small series.
- `query` (natural language, any language), `country` (optional), `limit` (default 10, max 50)
- Good for conceptual discovery inside the covered magazines; for Islam Info / An-Nasr Vendredi / Islam Hebdo, fall back to `search_publications` keyword + subject.

---

## Phase 3: Deep Reading Tools

### get_article
Full article detail.
- `article_id` (int)
- `+ keyword` → ~2000-char excerpts around matches instead of full OCR: `context_chars` (default 2000, max 5000), `max_excerpts` (default 10, max 25); `match_count` / `excerpts_returned` as in get_publication_fulltext
- Returns: id, identifier, title, author, newspaper, country, date, subject, spatial, language, nb_pages, url, **description_ai** (~500-char AI abstract), polarity, centrality, subjectivity, word_count, lexical_richness, readability, ocr_text (capped at 25k chars; only 48 articles exceed it)

### get_reference
Full bibliographic record for one academic reference.
- `reference_id` (int)
- Returns the complete abstract (51% have one), subjects, DOI, external_url, host-work details (book_title, volume, issue, pages), language, country

### get_publication_fulltext
OCR text of one publication. Two modes:
- `publication_id` (int) alone → full text capped at 25k chars (`char_count` reports the true size — issues run up to ~1.1M chars)
- `+ keyword` → excerpts around matches: `context_chars` (default 2000, max 5000), `max_excerpts` (default 10, max 25). `match_count` = total matches; `excerpts_returned` = how many you got; a `truncation_message` appears when capped.
- When the issue has a table of contents, the response includes `tableOfContents` (avg ~6.4k chars ≈ 1.6k tokens) — often enough to locate an article without any keyword excerpts.

### get_document
Full archival-document detail (metadata, AI description, capped OCR).
- `document_id` (int)
- `+ keyword` → ~2000-char excerpts around matches instead of full OCR: `context_chars` (default 2000, max 5000), `max_excerpts` (default 10, max 25); `match_count` / `excerpts_returned`. Useful for the handful of documents over 25k chars (e.g. the COSIM statutes).

### get_audiovisual
Full audiovisual metadata.
- `audiovisual_id` (int)
- Returns id, identifier, title, creator, publisher, country, date, `source_type`, the item's links (`url` = IWAC page, `external_url` = watch URL, `media_url` = deposited file, `thumbnail`, `iiif_manifest`), medium, `type`, `rights`, `contributor`, both duration forms (`duration_seconds` and the ISO-8601 `extent`), subject, spatial, language, source, the full `description`, and `transcription` where one exists (50/1,771).

### get_image *(new July 2026)*
Full photograph record.
- `image_id` (int)
- Returns id, identifier, title, type, creator, date, country, spatial, coordinates, subject, caption (`description`, rarely present), rights, `iiif_manifest`, `thumbnail`, full-resolution `image_url`, and IWAC URL. URLs only — the server never returns image bytes.

### get_index_entry
Detailed index entry. **Raw dataset columns, French names** (Titre, Titre alternatif, Type, Description, Prénom, Nom, Coordonnées, frequency, first/last_occurrence, countries…).
- `entry_id` (int)

---

## Phase 4: Triangulation Tools

> **Aggregates (v0.13.0+).** The seven tools after `get_temporal_distribution` all describe a *set* rather than returning its items, and all take the same filter block (`keyword`, `country`, `newspaper`, `subject`, `date_from`, `date_to`). Reach for them when the question is "what is this material like?" rather than "what does this piece say?" — they answer in one call what paging never will, and several are also the fastest way to scope in Phase 1.

### get_temporal_distribution *(v0.9.0+)*
Counts of matching items per year (or month) — one call replaces paging through search results for any trend question. Also useful in Phase 1 to scope a topic's timeline before searching.
- `subset` (optional, validated): articles (default) | publications | references | documents | audiovisual | images
- `granularity` (optional, validated): year (default) | month | **lunar_month** *(v1.3.0+)* — items dated only to a year keep a bare-year key even at month granularity
- `calendar` (optional, validated) *(v1.3.0+)*: gregorian (default) | hijri
- `keyword` (optional): ONE substring over the subset's text fields (same semantics as the subset's search tool)
- `country` / `newspaper` / `subject` / `date_from` / `date_to` (optional): same semantics as the subset's search tool
- `group_by` (optional, validated): country | newspaper — returns `distribution_by_group` (one map per group) instead of `distribution`
- Returns `total_matches`, `dated_count`, `undated_count` (undated items are counted, never silently dropped), and the `distribution` map sorted by year
- **Tip:** `get_temporal_distribution(keyword="hadj", group_by="country")` charts six decades of hajj coverage per country in a single ~1k-token call.

#### The Islamic calendar *(v1.3.0+)*

**Reach for `granularity="lunar_month"` for any observance question.** It pools every year into the twelve lunar months, and it is the only bucket a Gregorian axis structurally cannot produce: the Hijri year drifts ~11 days annually, so across 1961–2025 each observance smears over all twelve Gregorian months and disappears. Measured over the 12,220 fully-dated articles, the archive's rhythm is unmistakable — **Ramadan +72 %, Dhu al-Hijja +70 %** (hajj and Tabaski), **Shawwal +44 %** (Korité, 1 Shawwal) against an even split, with the six ordinary months 24–35 % below it. **Rabi' I is flat (−5 %)**, so Maouloud is *not* treated as a news event the way the others are — a finding in its own right.

- `lunar_month` implies `calendar="hijri"`; you do not have to pass both (and `lunar_month` + `calendar="gregorian"` is refused as incoherent).
- `calendar="hijri"` with `granularity="year"` or `"month"` gives a Hijri *time series* instead (`1440`, `1440-09`).
- Keys are zero-padded month numbers (`"01"`…`"12"`) so they sort; `month_labels` maps them to names — use it rather than hard-coding a transliteration.
- **Precision.** Lunar dates need a complete `YYYY-MM-DD`. Items dated only to a year or month (or a `1981-04/1981-06` range) appear in `imprecise_date_count` and are **absent from the distribution, not zero** — 98.9 % of articles and 82.9 % of publications convert, so the gap is small but must be disclosed when a count carries an argument.
- **Not seasonality.** Pooling by lunar month deliberately mixes Gregorian seasons; a Ramadan peak is an observance effect, never a weather or school-year one.
- **Not available on `references`** — an academic imprint date has no meaningful lunar reading, so asking returns `{error, note}` naming the subsets that do carry lunar dates (articles, publications, documents, audiovisual, images).
- **Converter.** Umm al-Qura, precomputed in the dataset pipeline with `hijridate` — the same converter (and therefore the same buckets) as the on-this-day block on islam.zmo.de. This matters: ICU/`Intl` disagrees with it on **75 % of this collection's pre-2000 dates**, though on only 0.86 % of the *month* assignments, so month-level aggregates are robust while day-level labels are not.
- **Reading the peak:** `search_articles` / `search_publications` accept `hijri_month` (1–12 or a name — `Ramadan`, `Chaabane`, `Chawwal`, `Dhou al-hijja`, accent- and case-folded) and `hijri_year`. Rows come back with a `hijri_date` field (`1440-09-15`) alongside `date`. A misspelt month returns `{error, valid_values}`, never an empty result.
- **Tip:** `get_temporal_distribution(granularity="lunar_month", country="Burkina Faso")` asks whether one country's press follows the observance rhythm more closely than another's — then `search_articles(hijri_month="Ramadan", country="Burkina Faso")` reads the items behind it.

### get_sentiment_distribution *(`model` added v0.13.0; model-exact ids since the 2026-07-31 dataset rename)*
Aggregated AI sentiment counts.
- `country` (optional, exact name), `newspaper` (optional), `subject` (optional)
- `model` (optional, validated): `gpt-5-6-luna` (default) | `mistral-small-2603` | `deepseek-v4-flash-0731` | `gemma-4-31b-it` | `qwen3-8-27b` | **all** | **consensus**. Vendor shorthand (`chatgpt` / `mistral` / `deepseek` / `gemma` or `google` / `qwen` or `alibaba`) resolves to these ids, which is what the payload echoes back — quote the id, never the vendor. The generation-1 ids (`gemini-3-flash-preview`, `gpt-5-mini`, `ministral-14b-2512`) are **refused by name**, not substituted, and so is bare `gemini`: Google's generation-2 member is Gemma, a different model line (`qwen` resolves, by contrast, because the Qwen line did score generation 2)
- Returns `polarity_distribution`, `centrality_distribution` and `subjectivity` — a distribution over the five French labels plus `scored` / `unscored` and a `mean_rank` / `median_rank` derived by ranking the labels 1-5. That rank is a position on a five-point scale, never a percentage. The block also carries a `caveat`: quote it whenever you quote the number
- With `model="all"`: `by_model` (each model's distributions), `agreement` (how often they concur on polarity — ten pairwise counts and one unanimous count for five models) and `agreement_matrix` (where the first two part company)
- Every model block carries a `coverage` object, because the five do **not** score the same articles: `qwen3-8-27b` reaches 12,098 where the others reach 12,298. `agreement` is measured on the articles *all* of them scored, so its `scored_by_all` base — and every pairwise count in it, including pairs Qwen is not part of — is the smaller one, and `base_caveats` names why. Compare proportions, not raw counts, across models

### `model="consensus"` — what the panel concluded *(v3.5.0+)*

A precomputed majority, served as stored rather than derived at query time, and **not a sixth model**: no annotator produced it, so never attribute a consensus figure to one. It also rides along inside `model="all"` as a `consensus` block, so a comparison call answers both "how far do they agree" and "what did they conclude".

The majority threshold follows the votes **actually cast** (over half, minimum two). That is the reason to prefer it over `agreement`: `agreement` counts only articles *every* model scored, so the 200 Qwen skipped drop out of it entirely, while the consensus still decides them on the four remaining votes. The two are counted on different sets and their totals should not be reconciled.

The three fields do not behave alike, and this is the part to get right:

- `polarity_distribution` / `centrality_distribution` are **majority labels**. An empty value means **no majority formed** (429 and 465 articles), never "not computed". Those articles are absent from the distribution, so read `coverage` for the denominator.
- `subjectivity_median_rank` is a **float median on the 1-5 scale, not a label**. A median resolves whenever anyone voted, so it covers *more* articles (12,195) than either majority field. An even number of voters yields a **half-rank** (1.5, 2.5 …) matching no label at all — 117 articles have one. Never map it back onto the five labels, and never quote it as a percentage.
- `disputed` counts the fields the panel split on: polarité 429, centralité 465, subjectivité 3,184, any 3,778 (30.6% of the corpus). On the two label fields a dispute is *why* the consensus is empty; on subjectivité the median still resolved, so a disputed article still carries a value.

**Tip:** `get_sentiment_distribution(subject="Laïcité", country="Burkina Faso")` gives the polarity distribution for laïcité articles in BF specifically; compare against the unfiltered country baseline.

**Use `model="all"` before quoting any sentiment figure that carries an argument.** Corpus-wide the five models agree unanimously on polarity for only 3,929 of the 12,098 articles they all scored (**32%**). That number is the confidence floor: in a slice where they diverge further, a single model's polarity is a weak claim, and the disagreement is itself reportable. Four models reached 36% and the first three alone 43%, so a figure copied from an older draft will overstate the agreement.

**Coverage is near-total but not complete** (measured 2026-08-17): 12,298 of 12,349 articles carry sentiment from every model; the 51 missing are the non-French/English ones, skipped by design. Compare `scored_by_all` against `total_articles` rather than assuming they match.

**Reliability differs sharply by scale** (κ measured full-corpus, all six model pairs). Polarity (0.26–0.57) and centrality (0.46–0.72) are the solid ones; **subjectivity is not** (0.16–0.47, and `deepseek-v4-flash-0731` reproduces its own answer only 47% of the time on a re-run), so report it as weak evidence with that caveat, or not at all. On *centrality* specifically, `mistral-small-2603` is a systematic outlier (its pairs run 0.46–0.53 against 0.67–0.72 for the non-Mistral ones, `gemma-4-31b-it` included) — a 3-of-4 majority there is the others outvoting Mistral, not a panel consensus.

### get_topic_distribution *(v0.13.0)*
How a set spreads across the 30 precomputed LDA topics (12,234 of 12,287 articles are classified), each labelled by its top terms. Topics were assigned offline over the full text, so they describe what a piece is **about** rather than which words it contains — the fastest way to map an unfamiliar corpus without keyword guessing.
- `subset` (optional): articles (default) | references (references have their own 33-topic model)
- filter block; `min_prob` (0-1; mean assignment probability is 0.34, so 0.5 is already strong); `over_time` (adds the time dimension); `top_n` (bands in `over_time`, default 8)
- Returns `topics` (label, count, `avg_prob`) sorted by count, and `classified` vs `total_matches` — unclassified items are disclosed, not hidden
- `over_time` returns `trend_by_topic` (per band: `total`, `first`, `last`, `peak_year`, `peak_count`, `median_year`) plus the overall `span`. That is the trend **summarised**; the full per-year series goes to the chart, not to you. `median_year` is the year by which half the band's coverage had appeared, which is what separates a topic that faded from one that is new. For an actual year-by-year table, call `get_temporal_distribution` with a `subject` or `keyword` filter.

### get_field_distribution *(v0.13.0)*
Rank the values of one multi-valued field across a set. One tool for four questions: which places this coverage names, who signs it, what subjects dominate, what languages appear.
- `field` (required, validated): subject | spatial | author | language | newspaper | country
- `subset` (optional): articles (default) | publications | references; filter block; `top_n` (default 25, max 100)
- `over_time` (optional): adds `coverage_by_year` — the per-year **share** of items carrying any value
- Pipe-joined fields are split, so counts sum to more than the item count; the response says so

**Tip:** `get_field_distribution(field="author", over_time=true)` is the byline question. The finding is rarely who tops the list (9,664 of 12,287 articles are signed, across 2,463 names) — it is that the signed *share* climbs as the press professionalises after 1990.

### get_cooccurrence *(v0.13.0)*
How often the top values of a field appear on the **same** item — what X gets discussed alongside, straight from the tagging.
- `field` (optional, validated): subject (default) | spatial | author | language
- `subset` (optional); filter block; `top_n` (values per axis, default 15, max 30)
- Returns the top values, the full symmetric `matrix` (diagonal = each value's own count) and `top_pairs`
- Only pairs **within** the top-N are counted; anything outside that set is invisible, which the note repeats

### get_place_distribution *(v0.13.0)*
Places named by a set, joined to the index's authority records so each carries coordinates where the index has them. Use this rather than `get_field_distribution(field="spatial")` when the question is geographic.
- `subset` (optional); filter block; `top_n` (default 60, max 200)
- Returns `places` (with lat/lng), `items_by_country`, and `ungeocoded` — places named but never geocoded, listed with counts rather than dropped
- **Only `Lieux` index entries carry coordinates** (555 of 683). Persons, organisations and events never will.

### get_lexical_metrics *(v0.13.0)*
Readability, lexical richness and length of the press text, by year, newspaper or country.
- `group_by` (optional, validated): year (default) | newspaper | country; filter block; `top_n`
- `Lisibilite_OCR` is a **French** readability score (higher = easier), so non-French items are excluded from that metric and counted in `readability_excluded` — 9 articles corpus-wide — rather than reported as unreadable
- `Richesse_Lexicale_OCR` is MATTR, a moving-average type-token ratio that is **already length-robust**: do not normalise it by word count or bin it by length
- These columns exist only for items whose full text ships, so the averages describe that subset

### get_similar_items *(v0.13.0)*
The items nearest a given one in meaning, by cosine similarity over the stored embeddings — finds pieces on the same event that share no vocabulary. **Needs no API key** (unlike `semantic_search_*`): it reads the item's own stored vector.
- `id` (required), `subset` (optional), `limit` (default 12, max 50), `min_score`
- A neighbour at or above **~0.85** is usually the same story reprinted or lightly rewritten — the practical way to spot syndication in this corpus. 0.6-0.8 is "same subject, different piece".
- Per item and on demand; this is not a corpus-wide near-duplicate sweep

### get_semantic_map *(v0.13.0)*
A 2-D PCA scatter of a set, projected from the stored 768-dimension embeddings. **Needs no API key.**
- `subset` (optional); filter block; `color_by` (country | newspaper | subject | lda_topic_label | polarity — `gpt-5-6-luna`'s label); `limit` (default 300, max 2000)
- **Read `explained_variance` before concluding anything.** Two components carry ~18% of the variance for an unfiltered article set, ~25% for a filtered one — so items drawn close together are not necessarily similar. Report it as a rough spread, not as clusters.
- This is PCA, not UMAP: it preserves global spread rather than local neighbourhoods, and is not comparable to the semantic landscapes on islam.zmo.de.
- **You do not receive the point coordinates.** They are chart data, because a 2-D PCA position is an artefact of this projection rather than a fact about the item, so they go to the view and you get `projected`, `explained_variance` and, with `color_by`, per-group counts in `groups`. Never cite an item from this map; find it through `search` or `get_similar_items` instead.
- Because of that the payload no longer scales with `limit`, so a large `limit` is now cheap for you and only costs the chart. `get_similar_items` remains the tool for "what is near this item".

---

## Valid Filter Values (verified against the dataset)

**Validation (v0.8.0+):** `country`, `polarity`, `centrality`, and `index_type` are checked accent/case-insensitively; an invalid value returns `{error, valid_values}` (`isError`) — correct and retry. Free-text filters (`newspaper`, `subject`, `author`, `reference_type`, `language`) are **not** validated, so a typo there returns 0 rows silently — sanity-check them.

### Countries
Exact names: `Benin`, `Burkina Faso`, `Côte d'Ivoire`, `Niger`, `Togo`, `Nigeria` (all six are accepted everywhere; `Nigeria` simply yields 0 press articles — a real finding, not an error). Accents are optional (`Bénin` works); partial names (`Burkina`) are invalid and now error.

### Polarity scale (articles, `gpt-5-6-luna`)
Très positif (425) | Positif (6,146) | Neutre (5,017) | Négatif (375) | Très négatif (45) | Non applicable (290) — plus 51 unscored (counts verified 2026-08-17)

### Centrality scale (articles, `gpt-5-6-luna`)
Très central (8,210) | Central (1,561) | Marginal (1,122) | Secondaire (1,115) | Non abordé (290) — plus 51 unscored

### Subjectivity scale (articles, `gpt-5-6-luna`)
Très objectif (1,144) | Plutôt objectif (7,900) | Mixte (314) | Plutôt subjectif (1,914) | Très subjectif (736) — plus 341 unscored, which are exactly this model's `Non abordé` rows and the 51 unscanned ones. An ordinal **label**, not a number. The least reliable of the three scales — see the reliability note under `get_sentiment_distribution`.

The same three scales exist for `mistral-small-2603`, `deepseek-v4-flash-0731` and `gemma-4-31b-it`; reach them with `get_sentiment_distribution(model=…)`. They differ substantially — Mistral reads 2,087 articles as Très positif where Luna reads 425, and Gemma reads 7,275 as Neutre where Luna reads 5,017 — which is why a figure has to name its model. Gemma matches Luna's completeness (its 294 unscored subjectivity rows are exactly its own `Non abordé` ones plus the 51), so an unscored row is an abstention, not a gap.

### Index types
Personnes (2,833) | Lieux (683) | Organisations (413) | Notices d'autorité (312) | Événements (242) | Sujets (214)

### Reference types
See `search_references` above (12 values, with counts).

---

## Token Efficiency Tips

- Budget guide: a Brief run should stay around ≤25k tokens of tool output; an Extended run typically lands at 50-120k. Past that, stop searching and synthesize.
- Default limits are 20 for the main searches (15 for documents) — raise toward `max` only when you need breadth; `total_matches` + `has_more` tell you what's there without fetching it. Asking past a tool's `max` doesn't fail — the page is capped and `limit_warning` + `requested_limit` flag it — so there's no point requesting 500
- Stop rule: when two consecutive search variants surface no new items, the dimension is saturated — move on
- Triage with `with_description=true` (limit ≤ 10) instead of calling `get_article` on everything; read full OCR only for the 2-3 finalists (Brief) / 6-8 (Extended)
- A `search_articles` page of 20 ≈ 2.5k tokens; `get_article` ≈ 1-7k tokens; capped `get_publication_fulltext` ≤ ~7k tokens (+ ~1.6k when the issue has a TOC)
- Use stats/distribution tools for overviews before fetching individual items; when `total_matches` exceeds ~50, analyze metadata rather than reading items
- For "how did coverage evolve" questions, one `get_temporal_distribution` call (~1k tokens) replaces paging through result envelopes year by year
- Combine filters (country + subject/keyword + date range) to narrow before reading
- For temporal filtering: articles take `YYYY-MM-DD` or `YYYY`; publications/references take years
