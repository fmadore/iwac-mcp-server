import { query, queryScalarSingle, viewName, type Bindable, type Row } from "../../db.js";
import type { Subset } from "../../config.js";
import { type ResolvedLimit, limitWarning } from "./limits.js";

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
  /** True when the page stopped short of `limit` to stay within PAGE_CHAR_BUDGET. */
  response_limited?: boolean;
  /** Optional semantics note a tool can attach (e.g. list_locations' mentioned-in caveat). */
  note?: string;
  /** Set on a filtered list that matched nothing (see EMPTY_FILTER_HINT). */
  hint?: string;
  results: T[];
}

/**
 * Serialized size budget for the rows of one page. Hosts move large tool
 * results out of the conversation (Claude Code stores any text result over
 * 50,000 characters in a file) and the token gate's worst cases are set by
 * rows, not by the envelope. The budget holds for any future dataset revision,
 * however long a row's fields grow; the AMIRA server pages the same way.
 */
export const PAGE_CHAR_BUDGET = 40_000;

/** The hint a filtered list that matched nothing carries: a bare empty list
 * reads as "the archive holds nothing", when one filter may exclude all. */
export const EMPTY_FILTER_HINT =
  "No record matches all these filters. Drop or broaden them one at a time to find the one that excludes everything.";

function rowChars(row: unknown): number {
  return JSON.stringify(row, (_key, value) => (typeof value === "bigint" ? Number(value) : value)).length + 1;
}

export async function paginated<T>(
  countSql: string,
  countParams: Bindable[],
  pageSql: string,
  pageParams: Bindable[],
  offset: number,
  limit: ResolvedLimit,
): Promise<PaginationEnvelope<T>> {
  // Independent scans of the same view: run them side by side (db.ts gives
  // each its own connection) rather than paying for both in turn.
  const [rawTotal, rows] = await Promise.all([
    queryScalarSingle<number | bigint>(countSql, countParams),
    query(pageSql, pageParams),
  ]);
  const total = Number(rawTotal ?? 0);
  // Keep rows until the next would pass the budget; the first row always
  // stays, so a page can never come back empty while matches remain.
  const results: T[] = [];
  let chars = 0;
  for (const row of rows as unknown as T[]) {
    const size = rowChars(row);
    if (results.length && chars + size > PAGE_CHAR_BUDGET) break;
    results.push(row);
    chars += size;
  }
  const limited = results.length < rows.length;
  const hasMore = offset + results.length < total;
  const env: PaginationEnvelope<T> = {
    count: results.length,
    total_matches: total,
    offset,
    limit: limit.value,
    has_more: hasMore,
    results,
  };
  if (hasMore) env.next_offset = offset + results.length;
  if (limited) env.response_limited = true;
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
  params: Bindable[];
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
  const env = await paginated<T>(countSql, params, pageSql, params, offset, limit);
  if (env.total_matches === 0 && where.length) env.hint = EMPTY_FILTER_HINT;
  return env;
}

/**
 * Up to five stored values of `column` close to `value` (Jaro-Winkler ≥ 0.85
 * on folded text), for a filter that matched nothing: "Tidjaniya" → the
 * archive's "Tijaniyya". Pipe-joined columns are exploded first. Empty when
 * the column is absent or nothing is close.
 */
export async function nearMissValues(
  subset: Subset,
  schema: Set<string>,
  column: string,
  value: string | undefined,
  pipeJoined: boolean,
): Promise<string[]> {
  if (!value?.trim() || !schema.has(column)) return [];
  const col = `"${column.replaceAll('"', '""')}"`;
  const values = pipeJoined
    ? `SELECT DISTINCT trim(unnest(str_split(coalesce(${col}, ''), '|'))) AS value FROM ${viewName(subset)}`
    : `SELECT DISTINCT trim(${col}) AS value FROM ${viewName(subset)}`;
  const score = "jaro_winkler_similarity(strip_accents(lower(value)), strip_accents(lower(?)))";
  const rows = await query(
    `SELECT value FROM (${values}) WHERE value <> '' AND ${score} >= 0.85 ORDER BY ${score} DESC, value LIMIT 5`,
    [value.trim(), value.trim()],
  );
  return rows.map((row) => String(row.value));
}

/** `{ did_you_mean }` for the free-text filters of a search that matched
 * nothing, or `{}` when no stored value is close to any of them. */
export async function didYouMean(
  subset: Subset,
  schema: Set<string>,
  filters: { subject?: string; newspaper?: string },
): Promise<{ did_you_mean?: Record<string, string[]> }> {
  const [subject, newspaper] = await Promise.all([
    nearMissValues(subset, schema, "subject", filters.subject, true),
    nearMissValues(subset, schema, "newspaper", filters.newspaper, false),
  ]);
  const found = Object.fromEntries(
    Object.entries({ subject, newspaper }).filter(([, values]) => values.length),
  );
  return Object.keys(found).length ? { did_you_mean: found } : {};
}
