import { q, selectList } from "../../db.js";
import { ALL_SUBSETS, type Subset } from "../../config.js";
import { DEFAULT_SENTIMENT_MODEL, sentimentCols } from "./sentiment.js";
import { HIJRI_COLS, HIJRI_DATE_EXPR } from "./calendar.js";

// -----------------------------------------------------------------------------
// Per-subset field descriptor — the ONE place that maps dataset columns to the
// stable output keys, for EVERY projection.
//
// Output keys are normalised to short English snake_case across all tools so the
// model sees ONE shape (`id`, `date`, `polarity`, …) instead of re-learning
// per-tool field names — and the long French dataset keys
// (gpt_5_6_luna_centralite_islam_musulmans × 20 rows) stop costing
// tokens.
//
// Each column is declared ONCE, with its SQL expression, output alias, schema
// dependencies, and the set of VIEWS it belongs to. Previously the same column
// was restated in up to four places — a detail table, a `*SummaryCols` function,
// an inline `selectList` in a tool module, and the TEXT_COLS search surface —
// which is how the detail lists had already drifted apart before they were
// consolidated. A dataset column rename is now a single-line change everywhere.
//
// Columns absent from the live schema are dropped by selectList, so a dataset
// revision degrades gracefully instead of throwing.
// -----------------------------------------------------------------------------

/**
 * The projections a field can belong to. Most are shared; a few are specific to
 * one subset's tools, which is fine — the field tables are per-subset anyway.
 *
 *   detail   every get_* tool: the full record
 *   fetch    the lean cross-subset `fetch` (OpenAI Deep Research contract);
 *            deliberately omits verbose/lexical fields to keep deep-research
 *            payloads small, and re-aliases the body column to `text`
 *   summary  the search_* result rows
 *   triage   articles only: summary + the AI abstract (`with_description`)
 *   withToc  publications only: summary + the table of contents (the text the
 *            TOC keyword match and the semantic ranking actually ran against)
 *   list     index only: the lean list_subjects/locations/persons rows
 *   listCountries  index only: list + `countries` (the country-filtered lists)
 *   sentiment      articles only: the search_by_sentiment rows
 */
export type FieldView =
  | "detail"
  | "fetch"
  | "summary"
  | "triage"
  | "withToc"
  | "list"
  | "listCountries"
  | "sentiment";

/** Views that are "base view + a few extra columns", so the shared columns are
 * declared once on the base rather than repeated on both. */
const VIEW_BASE: Partial<Record<FieldView, FieldView>> = {
  triage: "summary",
  withToc: "summary",
  listCountries: "list",
};

interface SubsetField {
  /** SQL expression — a bare column name, or a pre-quoted/complex expression. */
  expr: string;
  /** Output alias; bare columns without one keep their own name. */
  alias?: string;
  /** Columns that must exist in the live schema (defaults to the bare column). */
  requires?: string[];
  /** The projections this column appears in. */
  views: FieldView[];
  /** The subset's main text body; `fetch` re-aliases it to the contract key `text`. */
  body?: boolean;
  /** Part of the subset's keyword-search surface (derives TEXT_COLS). */
  searchable?: boolean;
  /**
   * A full-text blob rather than a metadata field: matching it means folding and
   * scanning hundreds of MB. Measured on the July 2026 dataset, one accent-folded
   * LIKE over `publications.OCR` costs ~1.8 s and over `articles.OCR` ~0.46 s,
   * versus ~30 ms for all the curated columns of a subset combined. Derives
   * FAST_TEXT_COLS, which the unified `search` tries first (see search.ts).
   */
  heavy?: boolean;
}

/** Every subset leads with its id and canonical IWAC URL. */
const ID_URL = (views: FieldView[]): SubsetField[] => [
  { expr: '"o:id"', alias: "id", requires: ["o:id"], views },
  { expr: "iwac_url", alias: "url", requires: ["iwac_url"], views },
];

/**
 * A free-text column truncated for SEARCH ROWS, the full value being carried by
 * the same subset's detail view. Paired as two field entries — the snippet under
 * its own alias in `summary`, the whole column in `detail`/`fetch` — so a page of
 * results stays cheap without the caller losing access to the rest.
 */
const snippetExpr = (column: string, max = 320): string =>
  `CASE WHEN ${q(column)} IS NULL OR length(trim(${q(column)})) = 0 THEN NULL ` +
  `WHEN length(${q(column)}) <= ${max} THEN ${q(column)} ` +
  `ELSE substr(${q(column)}, 1, ${max}) || '…' END`;

/** Truncated abstract for reference search results (full text via get_reference). */
const ABSTRACT_SNIPPET_EXPR = snippetExpr("abstract");

const ALL_ARTICLE_VIEWS: FieldView[] = ["detail", "fetch", "summary", "sentiment"];

/**
 * The sentiment columns projected onto article rows. One model's, not a blend:
 * the panel disagrees often enough (unanimous on polarity for 32% of the corpus)
 * that averaging it here would invent a reading no annotator produced.
 * `requires` drops them on a revision that
 * predates the generation-2 columns rather than throwing. `subjectivity` is a
 * French label here, not a number — see SUBJECTIVITY_VALUES.
 */
const SENTIMENT = sentimentCols(DEFAULT_SENTIMENT_MODEL);

const SUBSET_FIELDS: Record<Subset, SubsetField[]> = {
  articles: [
    ...ID_URL(ALL_ARTICLE_VIEWS),
    { expr: "identifier", views: ["detail"] },
    { expr: "title", views: ALL_ARTICLE_VIEWS, searchable: true },
    { expr: "author", views: ["detail", "fetch", "summary"] },
    { expr: "newspaper", views: ALL_ARTICLE_VIEWS },
    { expr: "country", views: ALL_ARTICLE_VIEWS },
    { expr: "pub_date", alias: "date", requires: ["pub_date"], views: ALL_ARTICLE_VIEWS },
    // The lunar date, alongside the Gregorian one. Filtering by `hijri_month`
    // and getting back rows that show no lunar date leaves the caller unable to
    // see what matched. `requires` keeps it absent on dataset revisions from
    // before the pipeline wrote the columns, so it costs nothing until it can
    // say something.
    { expr: HIJRI_DATE_EXPR, alias: "hijri_date", requires: HIJRI_COLS, views: ALL_ARTICLE_VIEWS },
    { expr: "subject", views: ["detail", "fetch", "summary"] },
    { expr: "spatial", views: ["detail", "fetch", "summary"] },
    { expr: "language", views: ["detail", "fetch", "summary"] },
    { expr: "nb_pages", views: ["detail"] },
    // `triage` only, not `summary`: search_articles returns the ~500-char
    // abstract solely under with_description (it costs ~125 tokens/row).
    {
      expr: '"descriptionAI"',
      alias: "description_ai",
      requires: ["descriptionAI"],
      views: ["detail", "fetch", "triage"],
      searchable: true,
    },
    // The English half of the bilingual summary (the dataset splits the two
    // `@language` literals into `descriptionAI` + `descriptionAI_en` rather
    // than pipe-joining them).
    //
    // SEARCHED, NEVER RETURNED — `views: []` is deliberate, not an oversight.
    // Every response carries exactly ONE summary, the French one: the two say
    // the same thing about the same item, so returning both would roughly
    // double the ~125 tokens/row an abstract costs to tell the reader nothing
    // new. `searchable` is the load-bearing flag: without it the English text
    // sits on the Hub but is absent from TEXT_COLS, so an English query matches
    // nothing it contains — strictly worse for anglophone discovery than the
    // pipe-joined column this replaced. So: queries reach both languages,
    // payloads carry one. French is the returned one because it is the source
    // language and the only one present on every row (the 51 non-FR/EN articles
    // keep an untagged French summary and have no English counterpart).
    {
      expr: '"descriptionAI_en"',
      alias: "description_ai_en",
      requires: ["descriptionAI_en"],
      views: [],
      searchable: true,
    },
    { expr: SENTIMENT.polarity, alias: "polarity", requires: [SENTIMENT.polarity], views: ALL_ARTICLE_VIEWS },
    {
      expr: SENTIMENT.centrality,
      alias: "centrality",
      requires: [SENTIMENT.centrality],
      views: ALL_ARTICLE_VIEWS,
    },
    {
      expr: SENTIMENT.subjectivity,
      alias: "subjectivity",
      requires: [SENTIMENT.subjectivity],
      views: ["detail", "summary", "sentiment"],
    },
    { expr: "nb_mots", alias: "word_count", requires: ["nb_mots"], views: ["detail"] },
    { expr: '"Richesse_Lexicale_OCR"', alias: "lexical_richness", requires: ["Richesse_Lexicale_OCR"], views: ["detail"] },
    { expr: '"Lisibilite_OCR"', alias: "readability", requires: ["Lisibilite_OCR"], views: ["detail"] },
    { expr: '"OCR"', alias: "ocr_text", requires: ["OCR"], views: ["detail", "fetch"], body: true, searchable: true, heavy: true },
  ],

  publications: [
    ...ID_URL(["detail", "fetch", "summary"]),
    { expr: "title", views: ["detail", "fetch", "summary"], searchable: true },
    { expr: "newspaper", views: ["detail", "fetch", "summary"] },
    { expr: "country", views: ["detail", "fetch", "summary"] },
    { expr: "pub_date", alias: "date", requires: ["pub_date"], views: ["detail", "fetch", "summary"] },
    { expr: HIJRI_DATE_EXPR, alias: "hijri_date", requires: HIJRI_COLS, views: ["detail", "fetch", "summary"] },
    { expr: "subject", views: ["detail", "fetch", "summary"], searchable: true },
    { expr: "language", views: ["detail", "fetch", "summary"] },
    // Summary-only, matching the previous hand-written lists: the detail/fetch
    // projections never carried nb_pages for publications.
    { expr: "nb_pages", views: ["summary"] },
    {
      expr: '"tableOfContents"',
      alias: "table_of_contents",
      requires: ["tableOfContents"],
      views: ["detail", "fetch", "withToc"],
      searchable: true,
    },
    { expr: '"OCR"', alias: "ocr_text", requires: ["OCR"], views: ["detail", "fetch"], body: true, searchable: true, heavy: true },
  ],

  references: [
    ...ID_URL(["detail", "fetch", "summary"]),
    { expr: "identifier", views: ["detail"] },
    { expr: "title", views: ["detail", "fetch", "summary"], searchable: true },
    { expr: "author", views: ["detail", "fetch", "summary"] },
    { expr: "editor", views: ["detail", "fetch"] },
    { expr: "type", views: ["detail", "fetch", "summary"] },
    { expr: '"o:resource_class"', alias: "resource_class", requires: ["o:resource_class"], views: ["detail"] },
    { expr: "pub_date", alias: "date", requires: ["pub_date"], views: ["detail", "fetch", "summary"] },
    { expr: "publisher", views: ["detail", "fetch", "summary"] },
    { expr: "book_title", views: ["detail", "fetch"] },
    { expr: "chapter", views: ["detail"] },
    { expr: "volume", views: ["detail", "fetch"] },
    { expr: "issue", views: ["detail", "fetch"] },
    { expr: "page_start", views: ["detail", "fetch"] },
    { expr: "page_end", views: ["detail", "fetch"] },
    { expr: "nb_pages", views: ["detail"] },
    { expr: "edition", views: ["detail"] },
    { expr: "extent", views: ["detail"] },
    { expr: "subject", views: ["detail"] },
    { expr: "spatial", views: ["detail"] },
    { expr: "language", views: ["detail", "fetch", "summary"] },
    { expr: "country", views: ["detail", "fetch", "summary"] },
    { expr: "doi", views: ["detail", "fetch", "summary"] },
    { expr: '"URL"', alias: "external_url", requires: ["URL"], views: ["detail"] },
    { expr: "is_part_of", views: ["detail"] },
    { expr: "review_of", views: ["detail"] },
    { expr: "provenance", views: ["detail"] },
    { expr: ABSTRACT_SNIPPET_EXPR, alias: "abstract_snippet", requires: ["abstract"], views: ["summary"] },
    { expr: "abstract", alias: "abstract", requires: ["abstract"], views: ["detail", "fetch"], body: true, searchable: true },
  ],

  documents: [
    ...ID_URL(["detail", "fetch", "summary"]),
    { expr: "identifier", views: ["detail"] },
    { expr: "title", views: ["detail", "fetch", "summary"], searchable: true },
    { expr: "author", views: ["detail", "fetch", "summary"] },
    { expr: "country", views: ["detail", "fetch", "summary"] },
    { expr: "pub_date", alias: "date", requires: ["pub_date"], views: ["detail", "fetch", "summary"] },
    { expr: "type", views: ["detail", "fetch", "summary"] },
    { expr: "subject", views: ["detail", "fetch", "summary"], searchable: true },
    { expr: "spatial", views: ["detail"] },
    { expr: "language", views: ["detail", "fetch"] },
    { expr: "nb_pages", views: ["detail"] },
    { expr: "source", views: ["detail"] },
    { expr: "rights", views: ["detail"] },
    {
      expr: '"descriptionAI"',
      alias: "description_ai",
      requires: ["descriptionAI"],
      views: ["detail", "fetch", "summary"],
      searchable: true,
    },
    // English half of the bilingual summary — searched, never returned, so a
    // response carries one summary rather than two. See articles.descriptionAI_en.
    {
      expr: '"descriptionAI_en"',
      alias: "description_ai_en",
      requires: ["descriptionAI_en"],
      views: [],
      searchable: true,
    },
    { expr: "nb_mots", alias: "word_count", requires: ["nb_mots"], views: ["detail"] },
    { expr: '"OCR"', alias: "ocr_text", requires: ["OCR"], views: ["detail", "fetch"], body: true, searchable: true, heavy: true },
  ],

  index: [
    ...ID_URL(["detail", "fetch", "summary", "list"]),
    { expr: '"Titre"', alias: "title", requires: ["Titre"], views: ["detail", "fetch", "summary", "list"], searchable: true },
    // Pipe-separated aliases — the columns that make a search for "Dahomey"
    // resolve to "Bénin". Carried in search results only.
    {
      expr: '"Titre alternatif"',
      alias: "alternate_titles",
      requires: ["Titre alternatif"],
      views: ["summary"],
      searchable: true,
    },
    { expr: '"Type"', alias: "type", requires: ["Type"], views: ["detail", "fetch", "summary"] },
    { expr: "frequency", views: ["detail", "fetch", "summary", "list"] },
    { expr: "first_occurrence", views: ["detail", "fetch", "summary"] },
    { expr: "last_occurrence", views: ["detail", "fetch", "summary"] },
    // The uncountried lists (list_subjects) omit this; the country-filtered ones
    // return it so the caller can see WHY an entry matched.
    { expr: "countries", views: ["detail", "fetch", "summary", "listCountries"] },
    {
      expr: '"Description"',
      alias: "description",
      requires: ["Description"],
      views: ["detail", "fetch", "summary", "list"],
      body: true,
      searchable: true,
    },
  ],

  audiovisual: [
    ...ID_URL(["detail", "fetch", "summary"]),
    { expr: "identifier", views: ["detail"] },
    { expr: "added_date", views: ["detail"] },
    // A YouTube row has NO file: its media carries only a thumbnail derivative,
    // so `PDF` is empty and `iiif_manifest` would resolve to a 0-canvas
    // manifest. Both stay detail/fetch-only and, being empty, are dropped from
    // those rows by the result compaction rather than advertising a file that
    // is not there.
    { expr: "iiif_manifest", views: ["detail", "fetch"] },
    { expr: "PDF", alias: "media_url", requires: ["PDF"], views: ["detail", "fetch", "summary"] },
    { expr: "thumbnail", views: ["detail", "fetch"] },
    // Where the item can actually be watched — the canonical YouTube watch URL
    // for the 1,724 harvested rows, empty for the deposited ones (whose file
    // IS `media_url`). Carried in search rows as well as detail: `media_url` is
    // filled for 47 of 1,771 rows, so before this column a page of results
    // offered no way to reach the recording, and the caller had no way to tell
    // an item with no file from an item with no link. The two are named
    // differently on purpose — `external_url` is a page to open, `media_url` a
    // file to fetch — matching how references names its outbound link.
    { expr: '"URL"', alias: "external_url", requires: ["URL"], views: ["detail", "fetch", "summary"] },
    // Which of the two populations a row belongs to (`youtube` | `deposited`).
    // Two tokens that make every other absence on the row legible; without it,
    // "no media_url, no creator, no transcription" reads as a broken record
    // rather than as an embedded video.
    { expr: "source_type", views: ["detail", "fetch", "summary"] },
    { expr: "title", views: ["detail", "fetch", "summary"], searchable: true },
    { expr: "creator", views: ["detail", "fetch", "summary"], searchable: true },
    // For a harvested row this is the CHANNEL (RTB, AEEM Togo, CERFI…), which is
    // the strongest single facet the YouTube cohort has — 27 of 1,771 rows carry
    // a subject, but 1,769 carry a publisher. Hence the dedicated filter on
    // search_audiovisual rather than keyword-only reach.
    { expr: "publisher", views: ["detail", "fetch", "summary"], searchable: true },
    { expr: "country", views: ["detail", "fetch", "summary"] },
    { expr: "pub_date", alias: "date", requires: ["pub_date"], views: ["detail", "fetch", "summary"] },
    { expr: "volume", views: ["detail", "fetch"] },
    { expr: "issue", views: ["detail", "fetch"] },
    { expr: "is_part_of", views: ["detail", "fetch"] },
    // `extent` is an ISO-8601 duration ("PT6M51S"), not prose, so search rows
    // carry the integer seconds instead and the raw string stays on the detail
    // record. Both are filled for every row.
    { expr: "duration_seconds", views: ["detail", "fetch", "summary"] },
    { expr: "extent", views: ["detail", "fetch"] },
    { expr: "medium", views: ["detail", "fetch", "summary"] },
    { expr: "type", views: ["detail"] },
    { expr: "rights", views: ["detail"] },
    { expr: "contributor", views: ["detail"] },
    { expr: "subject", views: ["detail", "fetch", "summary"], searchable: true },
    { expr: "spatial", views: ["detail", "fetch", "summary"], searchable: true },
    { expr: "language", views: ["detail", "fetch", "summary"], searchable: true },
    // Searchable but not projected into search rows, matching the previous
    // hand-written list — `source` is a provenance note, not a triage field.
    { expr: "source", views: ["detail", "fetch"], searchable: true },
    {
      expr: '"descriptionAI"',
      alias: "description_ai",
      requires: ["descriptionAI"],
      views: ["detail", "fetch"],
      searchable: true,
    },
    // Empty corpus-wide today (0 of 1,771), like its French counterpart —
    // carried so that populating the summaries later is a data change, not a
    // schema change. Searched, never returned. See articles.descriptionAI_en.
    {
      expr: '"descriptionAI_en"',
      alias: "description_ai_en",
      requires: ["descriptionAI_en"],
      views: [],
      searchable: true,
    },
    // The item's own blurb — a YouTube video description for the harvested rows,
    // a bilingual synopsis for the deposited ones — and for most of this subset
    // the ONLY substantive text there is: `descriptionAI` is empty for all
    // 1,771 rows and the transcription ships for 50, while `description` is
    // filled for 1,465. It was carried by neither the search surface nor any
    // view until 2026-08-17, which left the great majority of the post-harvest
    // subset reachable by title and publisher alone. Deliberately NOT `heavy`
    // (median ~205 characters): it belongs in the fast pass, so the unified
    // `search` finds these videos without falling through to the OCR scan.
    { expr: snippetExpr("description"), alias: "description_snippet", requires: ["description"], views: ["summary"] },
    { expr: "description", views: ["detail", "fetch"], searchable: true },
    // The transcription column, added to the dataset in July 2026. It is the
    // ONLY real text this subset has: `descriptionAI` is still empty for all
    // 1,771 rows, so leaving it as the body made every `fetch` on an audiovisual
    // item answer "(no full text available)" while the transcriptions sat
    // unread. Public for 50 rows after the 2026-08-17 harvest (OCR_is_public).
    {
      expr: '"OCR"',
      alias: "transcription",
      requires: ["OCR"],
      views: ["detail", "fetch"],
      body: true,
      searchable: true,
      heavy: true,
    },
  ],

  // Photographs (July 2026). No OCR and no long text at all — `description` is
  // the body, filled for 2 of 30 rows — so every column here is cheap to match.
  // `embedding_image` is multimodal (the photo itself embedded into the same
  // 768-dim space as the text vectors), which is what lets a French text query
  // retrieve a photograph in semantic_search_images.
  images: [
    ...ID_URL(["detail", "fetch", "summary"]),
    { expr: "identifier", views: ["detail"] },
    { expr: "added_date", views: ["detail"] },
    { expr: "image_url", views: ["detail", "fetch", "summary"] },
    { expr: "thumbnail", views: ["detail", "fetch"] },
    { expr: "iiif_manifest", views: ["detail", "fetch"] },
    { expr: "title", views: ["detail", "fetch", "summary"], searchable: true },
    { expr: "type", views: ["detail"] },
    { expr: "creator", views: ["detail", "fetch", "summary"], searchable: true },
    { expr: "pub_date", alias: "date", requires: ["pub_date"], views: ["detail", "fetch", "summary"] },
    { expr: "country", views: ["detail", "fetch", "summary"] },
    { expr: "spatial", views: ["detail", "fetch", "summary"], searchable: true },
    { expr: "coordinates", views: ["detail", "fetch", "summary"] },
    { expr: "subject", views: ["detail", "fetch", "summary"], searchable: true },
    { expr: "rights", views: ["detail"] },
    { expr: "description", views: ["detail", "fetch"], body: true, searchable: true },
  ],
};

/** The bare column a field depends on (its schema key), for the derived maps. */
function baseColumn(field: SubsetField): string {
  return (field.requires ?? [field.expr])[0];
}

/**
 * Build a subset's SELECT list for one view. `fetch` re-aliases the body column
 * to the contract key `text`; every other view keeps the field's own alias.
 */
export function colsFor(subset: Subset, schema: Set<string>, view: FieldView): string {
  const chain = new Set<FieldView>([view]);
  for (let base = VIEW_BASE[view]; base; base = VIEW_BASE[base]) chain.add(base);

  const items: Array<string | [string, string, string[]?]> = [];
  for (const field of SUBSET_FIELDS[subset]) {
    if (!field.views.some((v) => chain.has(v))) continue;
    const alias = view === "fetch" && field.body ? "text" : field.alias;
    if (alias === undefined) items.push(field.expr);
    else items.push([field.expr, alias, field.requires ?? [field.expr]]);
  }
  return selectList(schema, items);
}

/**
 * The free-text columns each subset's keyword search matches against. Consumed
 * by the per-subset `keyword` filters, the unified `search` tool, and
 * get_temporal_distribution — so adding a column to a subset's searchable
 * surface is a single `searchable: true` above.
 */
export const TEXT_COLS: Record<Subset, string[]> = Object.fromEntries(
  ALL_SUBSETS.map((s) => [s, SUBSET_FIELDS[s].filter((f) => f.searchable).map(baseColumn)]),
) as Record<Subset, string[]>;

/**
 * The CHEAP half of each subset's search surface: titles, subjects, AI abstracts,
 * tables of contents — everything except the full-text blobs tagged `heavy`.
 * The unified `search` matches these first and only falls back to the OCR scan
 * when the fast pass under-fills the page, which is the difference between a
 * ~150 ms and a ~3 s response on the tool that skill-less clients call most.
 * The per-subset `keyword` filters deliberately keep using the full TEXT_COLS —
 * they are the "search the full text" tools and their callers asked for that.
 */
export const FAST_TEXT_COLS: Record<Subset, string[]> = Object.fromEntries(
  ALL_SUBSETS.map((s) => [s, SUBSET_FIELDS[s].filter((f) => f.searchable && !f.heavy).map(baseColumn)]),
) as Record<Subset, string[]>;

/** Subsets whose search surface has a `heavy` column worth a second pass. */
export const HAS_HEAVY_TEXT: Record<Subset, boolean> = Object.fromEntries(
  ALL_SUBSETS.map((s) => [s, SUBSET_FIELDS[s].some((f) => f.searchable && f.heavy)]),
) as Record<Subset, boolean>;

/**
 * The canonical IWAC item page for an `o:id`. Every subset resolves under the
 * same path, and `iwac_url` stores exactly this. Used as a FALLBACK when the
 * stored value is blank: ChatGPT builds citation metadata only when `url` is a
 * non-empty string, and the result compaction drops empty strings, so an item
 * with an unfilled `iwac_url` would otherwise come back uncitable.
 */
export function itemUrl(id: string | number): string {
  return `https://islam.zmo.de/s/afrique_ouest/item/${id}`;
}

/**
 * The column holding each subset's display title (the index subset uses the
 * French "Titre"). Derived from the field tagged with the `title` output key, so
 * it cannot disagree with what the projections actually select.
 */
export const TITLE_COL: Record<Subset, string> = Object.fromEntries(
  ALL_SUBSETS.map((s) => {
    const field = SUBSET_FIELDS[s].find((f) => (f.alias ?? f.expr) === "title");
    if (!field) throw new Error(`SUBSET_FIELDS.${s} declares no field aliased to 'title'`);
    return [s, baseColumn(field)];
  }),
) as Record<Subset, string>;

