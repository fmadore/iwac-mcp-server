// Cross-cutting helpers shared by every tool module: input capping, JSON result
// formatting, the pagination envelope, the generic list-query runner, reusable
// SELECT/ORDER-BY fragments, sentiment-label normalisation, and text capping.
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

export function textResult(payload: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, bigintReplacer, 2) }],
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
// WHERE-clause helpers
// -----------------------------------------------------------------------------

/** Append `col ILIKE %value%` to a WHERE list, only if the column exists. */
export function likeFilterIfExists(
  schema: Set<string>,
  where: string[],
  params: unknown[],
  column: string,
  value: string | undefined,
): void {
  if (!value || !schema.has(column)) return;
  where.push(`${q(column)} ILIKE ?`);
  params.push(`%${value}%`);
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
// Column lists (kept only for columns present in the current dataset revision)
// -----------------------------------------------------------------------------

export function articleSummaryCols(schema: Set<string>): string {
  return selectList(schema, [
    ['"o:id"', "o:id", ["o:id"]],
    "title",
    "author",
    "newspaper",
    "country",
    "pub_date",
    "subject",
    "spatial",
    "language",
    "gemini_polarite",
    "gemini_centralite_islam_musulmans",
    "gemini_subjectivite_score",
    ["iwac_url", "url", ["iwac_url"]],
  ]);
}

export function publicationSummaryCols(schema: Set<string>): string {
  return selectList(schema, [
    ['"o:id"', "o:id", ["o:id"]],
    "title",
    ['COALESCE("descriptionAI", NULL)', "description", ["descriptionAI"]],
    "country",
    ["pub_date", "date", ["pub_date"]],
    "language",
    ["iwac_url", "url", ["iwac_url"]],
  ]);
}

export function indexSummaryCols(schema: Set<string>): string {
  return selectList(schema, [
    ['"o:id"', "o:id", ["o:id"]],
    "Titre",
    "Type",
    "Description",
    "frequency",
    "first_occurrence",
    "last_occurrence",
    "countries",
    ["iwac_url", "url", ["iwac_url"]],
  ]);
}

// -----------------------------------------------------------------------------
// Sentiment label normalisation
// -----------------------------------------------------------------------------

// Accent-normalise Gemini sentiment labels typed without diacritics.
const ACCENT_MAP: Record<string, string> = {
  "tres positif": "Très positif",
  "tres negatif": "Très négatif",
  negatif: "Négatif",
  "tres central": "Très central",
  "non aborde": "Non abordé",
};

export function normaliseSentiment(v: string | undefined): string | undefined {
  if (!v) return undefined;
  return ACCENT_MAP[v.toLowerCase()] ?? v;
}

// -----------------------------------------------------------------------------
// Aggregation / text helpers
// -----------------------------------------------------------------------------

export function rowsToMap(rows: Record<string, unknown>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r.k == null) continue;
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

/** TOC entries (paragraph-separated) that contain `keyword`, re-joined. */
export function extractMatchingTocEntries(toc: string, keyword: string): string {
  if (!toc || !keyword) return "";
  const kw = keyword.toLowerCase();
  const entries = toc.split(/\n\n+/).map((s) => s.trim()).filter(Boolean);
  return entries.filter((e) => e.toLowerCase().includes(kw)).join("\n\n");
}
