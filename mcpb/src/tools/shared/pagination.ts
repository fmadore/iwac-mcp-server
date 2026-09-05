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
  /** Optional semantics note a tool can attach (e.g. list_locations' mentioned-in caveat). */
  note?: string;
  results: T[];
}

export async function paginated<T>(
  countSql: string,
  countParams: Bindable[],
  pageSql: string,
  pageParams: Bindable[],
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
  return paginated<T>(countSql, params, pageSql, params, offset, limit);
}

