import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { ensureSubset, subsetGlob } from "./hf.js";
import type { Subset } from "./config.js";

let _conn: DuckDBConnection | null = null;
const _schemas: Map<Subset, Promise<Set<string>>> = new Map();

async function getConn(): Promise<DuckDBConnection> {
  if (_conn) return _conn;
  const instance = await DuckDBInstance.create(":memory:");
  _conn = await instance.connect();
  return _conn;
}

/**
 * Safe SQL name for a subset's view. `index` and `references` are reserved words
 * in DuckDB, so they must be double-quoted; the rest are bare identifiers.
 * Single source of truth — used both when creating the view and when querying it.
 */
export function viewName(subset: Subset): string {
  return subset === "index" || subset === "references" ? `"${subset}"` : subset;
}

/**
 * Ensure a subset's parquet files are downloaded and registered as a DuckDB view,
 * and cache its column list. The in-flight promise is cached (not just the
 * result) so two concurrent tool calls on the same subset share one download
 * instead of racing on the same `.partial` temp file.
 */
export function ensureView(subset: Subset): Promise<Set<string>> {
  let p = _schemas.get(subset);
  if (!p) {
    p = buildView(subset);
    p.catch(() => _schemas.delete(subset)); // allow retry after a failed download
    _schemas.set(subset, p);
  }
  return p;
}

async function buildView(subset: Subset): Promise<Set<string>> {
  const conn = await getConn();
  const localDir = await ensureSubset(subset);
  const glob = subsetGlob(localDir);
  const quoted = viewName(subset);
  await conn.run(
    `CREATE OR REPLACE VIEW ${quoted} AS SELECT * FROM read_parquet('${glob.replace(/'/g, "''")}')`,
  );
  const reader = await conn.runAndReadAll(
    `SELECT column_name FROM (DESCRIBE SELECT * FROM ${quoted} LIMIT 0)`,
  );
  return new Set<string>(reader.getRowsJS().map((r) => String(r[0])));
}

export async function schemaFor(subset: Subset): Promise<Set<string>> {
  return ensureView(subset);
}

/** Quote an identifier for SQL. */
export function q(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

/**
 * Build a SELECT list, keeping only columns that exist in `schema`.
 * Each entry is either a column name (in which case the identifier is quoted)
 * or a tuple [sqlExpression, alias].
 */
export function selectList(
  schema: Set<string>,
  items: Array<string | [string, string, string[]?]>,
): string {
  const parts: string[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      if (schema.has(item)) parts.push(q(item));
    } else {
      const [expr, alias, requires] = item;
      const deps = requires ?? [];
      if (deps.every((d) => schema.has(d))) parts.push(`${expr} AS ${q(alias)}`);
    }
  }
  return parts.join(", ");
}

export type Row = Record<string, unknown>;

/**
 * Run a SQL query with positional parameters and return plain JS objects.
 * DuckDB's `runAndReadAll` accepts a DuckDBValue[] for bindings; primitive
 * JS values (string, number, boolean, null) are accepted directly.
 */
export async function query(sql: string, params: unknown[] = []): Promise<Row[]> {
  const conn = await getConn();
  const reader = await conn.runAndReadAll(sql, params as any);
  return reader.getRowObjectsJS() as Row[];
}

export async function queryOne(
  sql: string,
  params: unknown[] = [],
): Promise<Row | null> {
  const rows = await query(sql, params);
  return rows[0] ?? null;
}

/**
 * Run a query and return a single scalar column as a flat array.
 */
export async function queryScalar<T = unknown>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const conn = await getConn();
  const reader = await conn.runAndReadAll(sql, params as any);
  const rows = reader.getRowsJS() as unknown[][];
  return rows.map((r) => r[0] as T);
}

export async function queryScalarSingle<T = unknown>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const values = await queryScalar<T>(sql, params);
  return values[0] ?? null;
}

/**
 * Canonical "fetch one row by o:id" lookup. Compares as VARCHAR so it works
 * whether the parquet stores `o:id` as an integer or a string. `cols` is a ready
 * SELECT list (e.g. from `selectList`, or `"*"`).
 */
export async function getById(
  subset: Subset,
  cols: string,
  id: string | number,
): Promise<Row | null> {
  return queryOne(
    `SELECT ${cols} FROM ${viewName(subset)} WHERE CAST("o:id" AS VARCHAR) = ?`,
    [String(id)],
  );
}

/**
 * Fetch many rows by o:id in a single query (avoids N+1 round-trips). Optional
 * `extraWhere`/`extraParams` are AND-ed onto the id filter so callers can push
 * additional predicates (country, date range) into SQL. Result order is
 * unspecified — callers that need a particular order must re-sort.
 */
export async function getManyByIds(
  subset: Subset,
  cols: string,
  ids: Array<string | number>,
  extraWhere: string[] = [],
  extraParams: unknown[] = [],
): Promise<Row[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const where = [`CAST("o:id" AS VARCHAR) IN (${placeholders})`, ...extraWhere];
  return query(
    `SELECT ${cols} FROM ${viewName(subset)} WHERE ${where.join(" AND ")}`,
    [...ids.map((v) => String(v)), ...extraParams],
  );
}

/**
 * Escape a single-quoted SQL string literal (doubles single quotes).
 */
export function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
