// Cross-cutting helpers shared by every tool module: input capping, JSON result
// formatting, the pagination envelope, the generic list-query runner, reusable
// SELECT/ORDER-BY fragments, accent-insensitive matching, and text capping.
import {
  q,
  query,
  queryScalarSingle,
  selectList,
  viewName,
  type Row,
} from "../db.js";
import type { Subset } from "../config.js";

/** The McpServer type, aliased once so tool modules don't repeat the import path. */
export type Server = import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;

/** Maximum length of any single free-text field returned to the model. */
export const CHARACTER_LIMIT = 25000;

// -----------------------------------------------------------------------------
// Tool result / annotation helpers
// -----------------------------------------------------------------------------

export function annotate(title: string) {
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
}

/**
 * Standard registerTool metadata: a top-level `title` (what current clients
 * display) plus the read-only annotation set (which older clients read the
 * title from). Spread into every tool's config.
 */
export function toolMeta(title: string): { title: string; annotations: ReturnType<typeof annotate> } {
  return { title, annotations: annotate(title) };
}

function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  return value;
}

/**
 * Characters that must never reach the model: C0 control codes and DEL (except
 * tab/newline/carriage-return, which are legitimate in OCR text) plus every
 * Unicode Private-Use Area code point (BMP U+E000–U+F8FF and the two
 * supplementary planes). The dataset and this server's code are clean today, but
 * a stray private-use "sentinel" leaking into a field — e.g. `ite⟨U+E000⟩m` in a
 * `url` — silently breaks links, so the server scrubs its own output instead of
 * trusting every future dataset revision or upstream pipeline step.
 */
const STRIP_CHARS =
  /[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu;

function sanitizeString(s: string): string {
  return s.replace(STRIP_CHARS, "");
}

/**
 * Drop null/undefined and empty-string values recursively, and scrub stray
 * control/private-use characters from every string. The parquet encodes missing
 * values as "" rather than NULL, so result rows would otherwise carry dozens of
 * `"author": ""` entries — pure token waste for the model. BIGINTs (DuckDB
 * COUNT/aggregate results) become plain numbers so the compacted value is safe
 * to ship as `structuredContent` (the transport JSON.stringifies it without a
 * replacer).
 */
function compactValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(compactValue);
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined) continue;
      if (typeof v === "string" && v.trim().length === 0) continue;
      out[k] = compactValue(v);
    }
    return out;
  }
  return value;
}

/** Compact (un-indented, empty-stripped) JSON — models parse it fine and it
 * saves ~20% of the tokens of a pretty-printed envelope. */
export function textResult(payload: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(compactValue(payload), bigintReplacer) }],
  };
}

/**
 * Like `textResult`, but ALSO returns the compacted payload as
 * `structuredContent` (same value, so the text block mirrors it exactly, per
 * the MCP back-compat rule). Use ONLY on tools that declare an `outputSchema`:
 * once declared, the SDK REQUIRES structuredContent on every non-error result.
 * Kept opt-in rather than folded into textResult because the duplicate JSON
 * doubles the wire payload — acceptable for small structured envelopes
 * (search/fetch, stats), waste for 25k-char OCR responses.
 */
export function structuredResult(payload: unknown): {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
} {
  const compacted = compactValue(payload) as Record<string, unknown>;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(compacted, bigintReplacer) }],
    structuredContent: compacted,
  };
}

/**
 * Like `textResult`, but marks the result as a tool-level error (`isError: true`)
 * per MCP guidance, so the model recognises the failure and can self-correct
 * (e.g. a missing id, semantic search disabled) rather than treating the error
 * JSON as a successful result. Reserve this for genuine failures — an empty or
 * "no matches" result is a successful call and should use `textResult`.
 */
export function errorResult(payload: unknown): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  return { content: textResult(payload).content, isError: true };
}

// -----------------------------------------------------------------------------
// Input capping (lenient clamp, not rejection)
// -----------------------------------------------------------------------------

export function capLimit(v: number | undefined, def: number, max: number): number {
  return Math.max(1, Math.min(v ?? def, max));
}

export function capOffset(v: number | undefined): number {
  return Math.max(0, v ?? 0);
}

/**
 * A limit clamped to [1, max] that REMEMBERS the original request, so a tool can
 * surface a visible cap (`requested_limit` + `limit_warning`) instead of silently
 * truncating. A list that quietly returns 200 of the 500 rows asked for reads as
 * "that's all there is" — the opposite of what happened.
 */
export interface ResolvedLimit {
  value: number;
  requested: number | undefined;
  capped: boolean;
  max: number;
}

export function resolveLimit(v: number | undefined, def: number, max: number): ResolvedLimit {
  const value = Math.max(1, Math.min(v ?? def, max));
  return { value, requested: v, capped: v !== undefined && v > max, max };
}

/** The visible-cap fields (`requested_limit` + `limit_warning`) for a capped
 * limit, or {} when nothing was capped. Single source of the warning wording. */
export function limitWarning(limit: ResolvedLimit): Record<string, unknown> {
  if (!limit.capped) return {};
  return {
    requested_limit: limit.requested,
    limit_warning: `Requested limit ${limit.requested} exceeds the maximum ${limit.max}; applied ${limit.value}.`,
  };
}

// -----------------------------------------------------------------------------
// Closed-vocabulary filter validation
// -----------------------------------------------------------------------------
//
// Enumerated filters (country, sentiment, index type) are validated up front so
// an invalid value returns an explicit, self-correctable error instead of a
// silent zero-result. Silent zero is genuinely dangerous for research: a typo'd
// `country=Atlantis` looks identical to a real historical absence. Open free-text
// filters (newspaper, subject, author, reference_type, language) are deliberately
// NOT validated here — reference_type is a substring match ("Livre" intentionally
// also matches "Chapitre de livre") and language is an open multi-value field, so
// rejecting "unknown" values there would reject legitimate queries.

/** Canonical country names (HF storage form). Accents/case optional on input. */
export const COUNTRIES = ["Benin", "Burkina Faso", "Côte d'Ivoire", "Niger", "Nigeria", "Togo"] as const;

/** Gemini polarity labels (articles). */
export const POLARITY_VALUES = ["Très positif", "Positif", "Neutre", "Négatif", "Très négatif", "Non applicable"] as const;

/** Gemini centrality labels (articles). */
export const CENTRALITY_VALUES = ["Très central", "Central", "Secondaire", "Marginal", "Non abordé"] as const;

/** Authority-index `Type` values. */
export const INDEX_TYPES = ["Personnes", "Organisations", "Lieux", "Événements", "Sujets", "Notices d'autorité"] as const;

export interface EnumValidation {
  /** Canonical spelling when the input matched (undefined when no value was given). */
  canonical?: string;
  /** An `{error, valid_values}` payload to wrap in errorResult when the input is invalid. */
  err?: { error: string; valid_values: string[] };
}

/**
 * Validate a closed-vocabulary filter accent/case-insensitively. Returns the
 * canonical spelling on a match (so the SQL filter uses the dataset's exact
 * value), an `{error, valid_values}` payload on a miss, or an empty object when
 * no value was supplied (the filter is simply skipped). Folding mirrors the
 * SQL-side strip_accents(lower()) via foldText, so `cote d'ivoire` ≡ `Côte d'Ivoire`.
 */
export function validateEnum(
  value: string | undefined,
  vocab: readonly string[],
  field: string,
): EnumValidation {
  if (value === undefined || value.trim() === "") return {};
  const folded = foldText(value).trim();
  const match = vocab.find((v) => foldText(v).trim() === folded);
  if (match) return { canonical: match };
  return { err: { error: `Invalid ${field}: ${value}`, valid_values: [...vocab] } };
}

// -----------------------------------------------------------------------------
// Pagination
// -----------------------------------------------------------------------------

export interface PaginationEnvelope<T> {
  count: number;
  total_matches: number;
  offset: number;
  limit: number;
  has_more: boolean;
  next_offset?: number;
  requested_limit?: number;
  limit_warning?: string;
  results: T[];
  [key: string]: unknown;
}

export async function paginated<T>(
  countSql: string,
  countParams: unknown[],
  pageSql: string,
  pageParams: unknown[],
  offset: number,
  limit: ResolvedLimit,
): Promise<PaginationEnvelope<T>> {
  const total = Number((await queryScalarSingle<number | bigint>(countSql, countParams)) ?? 0);
  const results = (await query(pageSql, pageParams)) as unknown as T[];
  const hasMore = offset + limit.value < total;
  const env: PaginationEnvelope<T> = {
    count: results.length,
    total_matches: total,
    offset,
    limit: limit.value,
    has_more: hasMore,
    results,
  };
  if (hasMore) env.next_offset = offset + limit.value;
  Object.assign(env, limitWarning(limit));
  return env;
}

/**
 * Run the standard "filtered, ordered, paginated list" query shared by every
 * search/list tool: assemble the WHERE clause, run a COUNT and a page query
 * against the subset's view, and return a pagination envelope. `cols` and
 * `orderBy` are subset-specific and supplied by the caller.
 */
export async function runListQuery<T = Row>(opts: {
  subset: Subset;
  where: string[];
  params: unknown[];
  cols: string;
  orderBy: string;
  limit: ResolvedLimit;
  offset: number;
}): Promise<PaginationEnvelope<T>> {
  const { subset, where, params, cols, orderBy, limit, offset } = opts;
  const view = viewName(subset);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const countSql = `SELECT COUNT(*) FROM ${view} ${whereSql}`;
  const pageSql = `SELECT ${cols} FROM ${view} ${whereSql} ${orderBy} LIMIT ${limit.value} OFFSET ${offset}`;
  return paginated<T>(countSql, params, pageSql, params, offset, limit);
}

// -----------------------------------------------------------------------------
// WHERE-clause helpers (all matching is accent- and case-insensitive)
// -----------------------------------------------------------------------------

/**
 * The free-text columns each subset's keyword search matches against — the ONE
 * place this knowledge lives. Consumed by the per-subset `keyword` filters, the
 * unified `search` tool, and get_temporal_distribution, so adding a column to a
 * subset's searchable surface is a single-line change.
 */
export const TEXT_COLS: Record<Subset, string[]> = {
  articles: ["title", "OCR", "descriptionAI"],
  publications: ["title", "subject", "tableOfContents", "OCR"],
  references: ["title", "abstract"],
  documents: ["title", "OCR", "descriptionAI", "subject"],
  index: ["Titre", "Titre alternatif", "Description"],
  audiovisual: ["title", "creator", "publisher", "subject", "spatial", "language", "source", "descriptionAI"],
};

/**
 * Append the standard keyword predicate — ONE literal substring, OR-ed across
 * the subset's text columns (those present in this dataset revision), accent-
 * and case-insensitive. This is the single-substring semantics documented on
 * every search_* tool ("one term per call"); the unified `search` tokenizes
 * instead.
 */
export function keywordFilter(
  schema: Set<string>,
  where: string[],
  params: unknown[],
  cols: readonly string[],
  keyword: string | undefined,
): void {
  if (!keyword) return;
  const parts: string[] = [];
  for (const col of cols) {
    if (schema.has(col)) {
      parts.push(foldedLike(q(col)));
      params.push(`%${keyword}%`);
    }
  }
  if (parts.length) where.push(`(${parts.join(" OR ")})`);
}

/**
 * Accent/case-insensitive substring predicate. ILIKE alone is accent-SENSITIVE:
 * `pelerinage` matches 27 articles while `pèlerinage` matches 1,816, and the
 * dataset mixes conventions ("Benin" unaccented vs "Côte d'Ivoire" accented).
 * Folding both sides through strip_accents(lower()) removes that trap class.
 */
export function foldedLike(colExpr: string): string {
  return `strip_accents(lower(${colExpr})) LIKE strip_accents(lower(?))`;
}

/** Accent/case-insensitive equality predicate (whole-value match). */
export function foldedEquals(colExpr: string): string {
  return `strip_accents(lower(trim(${colExpr}))) = strip_accents(lower(trim(?)))`;
}

/** Append an accent-insensitive `col LIKE %value%` to a WHERE list, if the column exists. */
export function likeFilterIfExists(
  schema: Set<string>,
  where: string[],
  params: unknown[],
  column: string,
  value: string | undefined,
): void {
  if (!value || !schema.has(column)) return;
  where.push(foldedLike(q(column)));
  params.push(`%${value}%`);
}

/**
 * Country filter: exact match against pipe-split segments, accent/case-folded.
 * A substring filter would conflate Niger with Nigeria (references store
 * "Niger|Nigeria"; audiovisual is 100% Nigeria), so each `|`-separated value is
 * compared whole. Works identically for single-valued columns like
 * `articles.country`.
 */
export function countryFilterIfExists(
  schema: Set<string>,
  where: string[],
  params: unknown[],
  column: string,
  value: string | undefined,
): void {
  if (!value || !schema.has(column)) return;
  where.push(
    `list_contains(list_transform(str_split(coalesce(${q(column)}, ''), '|'), ` +
      `x -> strip_accents(lower(trim(x)))), strip_accents(lower(trim(?))))`,
  );
  params.push(value);
}

/**
 * Pipe-separated field filter: exact match against one `|`-split segment,
 * accent/case-folded. Use for controlled multi-value fields such as subject,
 * spatial, language, countries, and `Titre alternatif`. A substring predicate
 * would make `Mosquée` match `Construction mosquée`, or `state` match
 * `Islamic State in the Greater Sahara`, which turns curated filters into
 * noisy keyword searches.
 */
export function pipeValueFilterIfExists(
  schema: Set<string>,
  where: string[],
  params: unknown[],
  column: string,
  value: string | undefined,
): void {
  if (!value || !schema.has(column)) return;
  where.push(pipeValueEquals(q(column)));
  params.push(value);
}

export function pipeValueEquals(colExpr: string): string {
  return (
    `list_contains(list_transform(str_split(coalesce(${colExpr}, ''), '|'), ` +
    `x -> strip_accents(lower(trim(x)))), strip_accents(lower(trim(?))))`
  );
}

/** First 4-digit run of a date-ish string ("2015", "2015-06-01") as a year int. */
function parseYear(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const m = v.trim().match(/\d{4}/);
  return m ? Number(m[0]) : undefined;
}

/**
 * Year-granularity date range on a VARCHAR `pub_date` column (references &
 * publications store it as a string, often a bare year like "1912"). Compares the
 * leading 4-digit year numerically, so it works for both "YYYY" and "YYYY-MM-DD"
 * and ignores empty/garbage values.
 */
export function yearRangeFilter(
  schema: Set<string>,
  where: string[],
  params: unknown[],
  dateFrom: string | undefined,
  dateTo: string | undefined,
  column = "pub_date",
): void {
  if (!schema.has(column)) return;
  const yearExpr = `TRY_CAST(substr(${q(column)}, 1, 4) AS INTEGER)`;
  const fy = parseYear(dateFrom);
  const ty = parseYear(dateTo);
  if (fy !== undefined) {
    where.push(`${yearExpr} >= ?`);
    params.push(fy);
  }
  if (ty !== undefined) {
    where.push(`${yearExpr} <= ?`);
    params.push(ty);
  }
}

/** Pad a partial date bound ("1995", "1995-06") to a full YYYY-MM-DD day. */
function normalizeDateBound(v: string | undefined, kind: "from" | "to"): string | undefined {
  if (!v) return undefined;
  const m = v.trim().match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
  if (!m) return undefined;
  const pad = (s: string) => s.padStart(2, "0");
  const mo = m[2] ? pad(m[2]) : kind === "from" ? "01" : "12";
  const d = m[3] ? pad(m[3]) : kind === "from" ? "01" : "31";
  return `${m[1]}-${mo}-${d}`;
}

/**
 * Day-granularity date range for `articles.pub_date`. The column's *type* has
 * changed across dataset revisions (TIMESTAMPTZ → VARCHAR), and a bare
 * `pub_date >= CAST(? AS TIMESTAMPTZ)` throws a Binder Error on the VARCHAR
 * revision. Casting the column to VARCHAR and comparing the ISO YYYY-MM-DD
 * prefix lexicographically works for both revisions and tolerates partial
 * ("1995-06") and empty values.
 */
export function dateRangeFilter(
  schema: Set<string>,
  where: string[],
  params: unknown[],
  dateFrom: string | undefined,
  dateTo: string | undefined,
  column = "pub_date",
): void {
  if (!schema.has(column)) return;
  const dayExpr = `NULLIF(substr(CAST(${q(column)} AS VARCHAR), 1, 10), '')`;
  const from = normalizeDateBound(dateFrom, "from");
  const to = normalizeDateBound(dateTo, "to");
  if (from) {
    where.push(`${dayExpr} >= ?`);
    params.push(from);
  }
  if (to) {
    where.push(`${dayExpr} <= ?`);
    params.push(to);
  }
}

// -----------------------------------------------------------------------------
// Reusable ORDER BY fragments
// -----------------------------------------------------------------------------

/** Newest-first ordering used by every date-bearing subset (empty if no pub_date). */
export function pubDateOrder(schema: Set<string>): string {
  return schema.has("pub_date") ? `ORDER BY pub_date DESC NULLS LAST, "o:id"` : "";
}

/** Frequency-first ordering used by the index list/search tools. */
export function indexFreqOrder(schema: Set<string>): string {
  return schema.has("frequency")
    ? `ORDER BY frequency DESC NULLS LAST, ${q("Titre")}`
    : `ORDER BY ${q("Titre")}`;
}

// -----------------------------------------------------------------------------
// Column lists (kept only for columns present in the current dataset revision).
// Output keys are normalised to short English snake_case across all tools so
// the model sees ONE shape (`id`, `date`, `polarity`, …) instead of re-learning
// per-tool field names — and the long French dataset keys
// (gemini_centralite_islam_musulmans × 20 rows) stop costing tokens.
// -----------------------------------------------------------------------------

export function articleSummaryCols(schema: Set<string>): string {
  return selectList(schema, [
    ['"o:id"', "id", ["o:id"]],
    "title",
    "author",
    "newspaper",
    "country",
    ["pub_date", "date", ["pub_date"]],
    "subject",
    "spatial",
    "language",
    ["gemini_polarite", "polarity", ["gemini_polarite"]],
    ["gemini_centralite_islam_musulmans", "centrality", ["gemini_centralite_islam_musulmans"]],
    ["gemini_subjectivite_score", "subjectivity", ["gemini_subjectivite_score"]],
    ["iwac_url", "url", ["iwac_url"]],
  ]);
}

export function publicationSummaryCols(schema: Set<string>): string {
  return selectList(schema, [
    ['"o:id"', "id", ["o:id"]],
    "title",
    "newspaper",
    "country",
    ["pub_date", "date", ["pub_date"]],
    "language",
    "subject",
    "nb_pages",
    ["iwac_url", "url", ["iwac_url"]],
  ]);
}

/** Truncated abstract for reference search results (full text via get_reference). */
const ABSTRACT_SNIPPET_EXPR =
  `CASE WHEN "abstract" IS NULL OR length(trim("abstract")) = 0 THEN NULL ` +
  `WHEN length("abstract") <= 320 THEN "abstract" ` +
  `ELSE substr("abstract", 1, 320) || '…' END`;

export function referenceSummaryCols(schema: Set<string>): string {
  return selectList(schema, [
    ['"o:id"', "id", ["o:id"]],
    "title",
    "author",
    "type",
    ["pub_date", "date", ["pub_date"]],
    "publisher",
    "country",
    "language",
    "doi",
    [ABSTRACT_SNIPPET_EXPR, "abstract_snippet", ["abstract"]],
    ["iwac_url", "url", ["iwac_url"]],
  ]);
}

export function indexSummaryCols(schema: Set<string>): string {
  return selectList(schema, [
    ['"o:id"', "id", ["o:id"]],
    [q("Titre"), "title", ["Titre"]],
    [q("Titre alternatif"), "alternate_titles", ["Titre alternatif"]],
    [q("Type"), "type", ["Type"]],
    [q("Description"), "description", ["Description"]],
    "frequency",
    "first_occurrence",
    "last_occurrence",
    "countries",
    ["iwac_url", "url", ["iwac_url"]],
  ]);
}

export function documentSummaryCols(schema: Set<string>): string {
  return selectList(schema, [
    ['"o:id"', "id", ["o:id"]],
    "title",
    "author",
    "country",
    ["pub_date", "date", ["pub_date"]],
    "type",
    "subject",
    ['"descriptionAI"', "description_ai", ["descriptionAI"]],
    ["iwac_url", "url", ["iwac_url"]],
  ]);
}

// -----------------------------------------------------------------------------
// Aggregation / text helpers
// -----------------------------------------------------------------------------

export function rowsToMap(rows: Record<string, unknown>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r.k == null || String(r.k).trim() === "") continue;
    out[String(r.k)] = Number(r.c);
  }
  return out;
}

export interface CappedText {
  text: string;
  truncated: boolean;
  truncation_message?: string;
}

/**
 * Cap a free-text field at `CHARACTER_LIMIT` so a single OCR blob can't flood the
 * model's context. When truncated, returns a message; `suggestKeyword` tailors it
 * toward the keyword-excerpt path on full-text tools.
 */
export function capText(
  text: string,
  opts: { suggestKeyword?: boolean; limit?: number } = {},
): CappedText {
  const limit = opts.limit ?? CHARACTER_LIMIT;
  if (text.length <= limit) return { text, truncated: false };
  const hint = opts.suggestKeyword
    ? " Pass a `keyword` to retrieve focused excerpts around matches instead."
    : " Narrow the request to see the rest.";
  return {
    text: text.slice(0, limit),
    truncated: true,
    truncation_message: `Text truncated from ${text.length} to ${limit} characters.${hint}`,
  };
}

/**
 * Accent/case-fold a string for in-JS matching, index-stable (each UTF-16 unit
 * maps to exactly one unit, so offsets into the folded string remain valid in
 * the original). Mirrors the SQL-side strip_accents(lower()) so keyword-excerpt
 * extraction agrees with what the SQL search matched.
 */
export function foldText(s: string): string {
  return s.toLowerCase().replace(/[À-ɏ]/g, (c) => c.normalize("NFD")[0] ?? c);
}

/** TOC entries (paragraph-separated) that contain `keyword`, accent-insensitively. */
export function extractMatchingTocEntries(toc: string, keyword: string): string {
  if (!toc || !keyword) return "";
  const kw = foldText(keyword);
  const entries = toc.split(/\n\n+/).map((s) => s.trim()).filter(Boolean);
  return entries.filter((e) => foldText(e).includes(kw)).join("\n\n");
}

export interface ExcerptResult {
  excerpts: string[];
  excerpts_returned: number;
  match_count: number;
  note?: string;
  truncated?: boolean;
  truncation_message?: string;
}

/**
 * Keyword-in-context retrieval for a long OCR blob: find every accent-insensitive
 * match and return a window of `context_chars` (half each side) around each, up to
 * `max_excerpts` / CHARACTER_LIMIT total. Lets the model read just the relevant
 * passages of a long document/issue instead of the whole (capped) OCR. Shared by
 * get_publication_fulltext, get_document, and get_article.
 *
 * Accent/case-folding is index-stable (foldText maps each UTF-16 unit to exactly
 * one unit), so match offsets stay valid in the original text and excerpt
 * extraction agrees with the accent-insensitive SQL search that found the item.
 */
export function keywordExcerpts(
  ocr: string,
  keyword: string,
  opts: { contextChars?: number; maxExcerpts?: number } = {},
): ExcerptResult {
  const contextChars = Math.max(200, Math.min(opts.contextChars ?? 2000, 5000));
  const maxExcerpts = capLimit(opts.maxExcerpts, 10, 25);
  const half = Math.floor(contextChars / 2);
  const haystack = foldText(ocr);
  const needle = foldText(keyword);

  // All match positions first (cheap), then excerpts up to the caps. A common
  // keyword in a 1M-char issue can match hundreds of times — uncapped, that once
  // produced a single ~150k-char (~38k-token) response.
  const positions: number[] = [];
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    positions.push(idx);
    pos = idx + Math.max(1, needle.length);
  }
  if (positions.length === 0) {
    return { excerpts: [], excerpts_returned: 0, match_count: 0, note: `Keyword '${keyword}' not found in full text` };
  }

  const excerpts: string[] = [];
  let coveredUntil = -1; // skip matches already visible in the previous excerpt
  let totalChars = 0;
  let capped = false;
  for (const idx of positions) {
    if (idx < coveredUntil) continue;
    if (excerpts.length >= maxExcerpts || totalChars >= CHARACTER_LIMIT) {
      capped = true;
      break;
    }
    const start = Math.max(0, idx - half);
    const end = Math.min(ocr.length, idx + needle.length + half);
    let ex = ocr.slice(start, end);
    if (start > 0) ex = "..." + ex;
    if (end < ocr.length) ex += "...";
    excerpts.push(ex);
    totalChars += ex.length;
    coveredUntil = end;
  }

  const result: ExcerptResult = {
    excerpts,
    excerpts_returned: excerpts.length,
    match_count: positions.length,
  };
  if (capped) {
    result.truncated = true;
    result.truncation_message =
      `Showing ${excerpts.length} excerpts for ${positions.length} matches. ` +
      `Use a more specific keyword, or raise max_excerpts (max 25).`;
  }
  return result;
}

/**
 * Attach a long OCR body to a detail row: with a keyword, replace the raw text
 * with keyword-in-context excerpts; without one, cap it and flag truncation.
 * Shared by get_article and get_document (get_publication_fulltext keeps its
 * own flow — different response keys: fulltext, char_count, tableOfContents).
 */
export function attachOcrOrExcerpts(
  row: Record<string, unknown>,
  ocrKey: string,
  keyword: string | undefined,
  opts: { contextChars?: number; maxExcerpts?: number } = {},
): void {
  const ocr = typeof row[ocrKey] === "string" ? (row[ocrKey] as string) : "";
  if (keyword && ocr.trim()) {
    delete row[ocrKey];
    Object.assign(row, keywordExcerpts(ocr, keyword, opts));
  } else if (ocr) {
    const capped = capText(ocr, { suggestKeyword: true });
    row[ocrKey] = capped.text;
    if (capped.truncated) {
      row.truncated = true;
      row.truncation_message = capped.truncation_message;
    }
  }
}
