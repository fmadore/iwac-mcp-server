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
 * `"author": ""` entries — pure token waste for the model.
 */
function compactValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeString(value);
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

// -----------------------------------------------------------------------------
// Pagination
// -----------------------------------------------------------------------------

export interface PaginationEnvelope<T> {
  count: number;
  total_matches: number;
  offset: number;
  has_more: boolean;
  next_offset?: number;
  results: T[];
  [key: string]: unknown;
}

export async function paginated<T>(
  countSql: string,
  countParams: unknown[],
  pageSql: string,
  pageParams: unknown[],
  offset: number,
  limit: number,
): Promise<PaginationEnvelope<T>> {
  const total = Number((await queryScalarSingle<number | bigint>(countSql, countParams)) ?? 0);
  const results = (await query(pageSql, pageParams)) as unknown as T[];
  const hasMore = offset + limit < total;
  const env: PaginationEnvelope<T> = {
    count: results.length,
    total_matches: total,
    offset,
    has_more: hasMore,
    results,
  };
  if (hasMore) env.next_offset = offset + limit;
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
  limit: number;
  offset: number;
}): Promise<PaginationEnvelope<T>> {
  const { subset, where, params, cols, orderBy, limit, offset } = opts;
  const view = viewName(subset);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const countSql = `SELECT COUNT(*) FROM ${view} ${whereSql}`;
  const pageSql = `SELECT ${cols} FROM ${view} ${whereSql} ${orderBy} LIMIT ${limit} OFFSET ${offset}`;
  return paginated<T>(countSql, params, pageSql, params, offset, limit);
}

// -----------------------------------------------------------------------------
// WHERE-clause helpers (all matching is accent- and case-insensitive)
// -----------------------------------------------------------------------------

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
