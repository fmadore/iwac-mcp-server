import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { ensureSubset, subsetGlob } from "./hf.js";
import type { Subset } from "./config.js";

let _conn: DuckDBConnection | null = null;
const _schemas: Map<Subset, Set<string>> = new Map();

async function getConn(): Promise<DuckDBConnection> {
  if (_conn) return _conn;
  const instance = await DuckDBInstance.create(":memory:");
  _conn = await instance.connect();
  return _conn;
}

/**
 * Ensure a subset's parquet files are downloaded and registered as a DuckDB view,
 * and cache its column list.
 */
export async function ensureView(subset: Subset): Promise<Set<string>> {
  const existing = _schemas.get(subset);
  if (existing) return existing;
  const conn = await getConn();
  const localDir = await ensureSubset(subset);
  const glob = subsetGlob(localDir);
  const quoted = subset === "index" || subset === "references" ? `"${subset}"` : subset;
  await conn.run(
    `CREATE OR REPLACE VIEW ${quoted} AS SELECT * FROM read_parquet('${glob.replace(/'/g, "''")}')`,
  );
  const reader = await conn.runAndReadAll(
    `SELECT column_name FROM (DESCRIBE SELECT * FROM ${quoted} LIMIT 0)`,
  );
  const cols = new Set<string>(reader.getRowsJS().map((r) => String(r[0])));
  _schemas.set(subset, cols);
  return cols;
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
 * Escape a single-quoted SQL string literal (doubles single quotes).
 */
export function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
