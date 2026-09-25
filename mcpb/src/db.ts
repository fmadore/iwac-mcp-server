import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from "@duckdb/node-api";
import { ensureSubset, parquetList, pruneSubset } from "./hf.js";
import { config, type Subset } from "./config.js";

let _instancePromise: Promise<DuckDBInstance> | null = null;
const _schemas: Map<Subset, Promise<Set<string>>> = new Map();

/** What a loaded subset's view reads, and when that was last checked. */
interface ViewState {
  files: string[];
  checkedAt: number;
  /** Bumped each time the view is rebuilt over new files, so caches derived
   * from its rows (the embedding index) know to rebuild too. */
  generation: number;
  refresh?: Promise<void>;
}
const _views: Map<Subset, ViewState> = new Map();

/**
 * Lazily open the single shared in-memory DuckDB instance. The in-flight
 * PROMISE is memoized (not just the resolved instance) so that concurrent
 * first-callers share one `:memory:` database. get_collection_stats fans
 * ensureView() across all six subsets at once via Promise.all; if we only
 * cached the resolved instance, each racing caller would see it unset (the
 * first `await` yields before assignment) and create its OWN separate
 * in-memory database. Views created on one such database are invisible to
 * queries run on another, surfacing as "Table with name articles does not
 * exist" — intermittent, because it depends on which caller wins the race.
 */
function getInstance(): Promise<DuckDBInstance> {
  if (!_instancePromise) {
    _instancePromise = DuckDBInstance.create(":memory:");
    // If the very first open fails, drop the cached promise so a later call can retry.
    _instancePromise.catch(() => {
      _instancePromise = null;
    });
  }
  return _instancePromise;
}

/** Idle connections kept for reuse. More can be open at once under load; the
 * surplus is closed on release rather than parked. */
const MAX_IDLE_CONNECTIONS = 8;
const _idle: DuckDBConnection[] = [];

/**
 * Run `fn` on a connection no concurrent caller is using.
 *
 * A DuckDB connection executes ONE statement at a time, so a single shared
 * connection queued every query in the process behind whatever was already
 * running: measured, a `SELECT 1` issued behind a 4.6 s scan waited 4.5 s on
 * the same connection and 5 ms on a second one. That serialised the fan-outs
 * `search` and `get_collection_stats` run through Promise.all, and on the
 * shared HTTP endpoint it made every caller wait out any other caller's
 * full-text scan. Connections of one instance share its catalog, so the views
 * ensureView() creates are visible from all of them; opening one costs ~0.1 ms
 * and they carry no per-connection state here (no SET, no temp objects).
 */
async function withConnection<T>(fn: (conn: DuckDBConnection) => Promise<T>): Promise<T> {
  await acquireSlot();
  try {
    const conn = _idle.pop() ?? (await (await getInstance()).connect());
    try {
      return await fn(conn);
    } finally {
      if (_idle.length < MAX_IDLE_CONNECTIONS) _idle.push(conn);
      else conn.closeSync();
    }
  } finally {
    releaseSlot();
  }
}

/**
 * Queries allowed to run at once; later callers wait their turn in arrival
 * order. The single shared connection this replaced allowed one. Unbounded,
 * a burst on the shared endpoint could put every caller's full-text scan in
 * flight together and exhaust memory. DuckDB's thread pool divides the CPU
 * among the queries that are running, so a short lookup still overtakes a
 * long scan unless this many are already in flight.
 */
export const MAX_ACTIVE_QUERIES = 16;
let _active = 0;
const _waiting: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (_active < MAX_ACTIVE_QUERIES) {
    _active += 1;
    return;
  }
  // releaseSlot hands its slot straight to the next waiter, so _active is
  // not decremented and re-incremented in between.
  await new Promise<void>((resolve) => _waiting.push(resolve));
}

function releaseSlot(): void {
  const next = _waiting.shift();
  if (next) next();
  else _active -= 1;
}

/** Queries running now, for tests. */
export function activeQueries(): number {
  return _active;
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
 *
 * Once loaded, a subset is re-checked against the Hub every
 * `config.refreshIntervalMs`, stale-while-revalidate: the call that notices
 * the interval has passed is answered from the current view at once, and the
 * check runs in the background (see refreshView).
 */
export function ensureView(subset: Subset): Promise<Set<string>> {
  let p = _schemas.get(subset);
  if (!p) {
    const build = buildView(subset);
    build.catch(() => {
      if (_schemas.get(subset) === build) _schemas.delete(subset); // allow retry after a failed download
    });
    _schemas.set(subset, build);
    p = build;
  } else {
    maybeRefresh(subset);
  }
  return p;
}

/** How many times this subset's view has been rebuilt over new files (0 before
 * it first loads). A cache built from the view's rows is stale once this moves. */
export function viewGeneration(subset: Subset): number {
  return _views.get(subset)?.generation ?? 0;
}

/** The background refresh in flight for a subset, if any. For tests. */
export function pendingRefresh(subset: Subset): Promise<void> | undefined {
  return _views.get(subset)?.refresh;
}

async function buildView(subset: Subset): Promise<Set<string>> {
  const { files } = await ensureSubset(subset);
  const schema = await createView(subset, files);
  _views.set(subset, { files, checkedAt: Date.now(), generation: 1 });
  await pruneSubset(subset, files);
  return schema;
}

/** Point the subset's view at exactly `files` and return its columns. One
 * CREATE OR REPLACE, so a query sees the old file list or the new one, never
 * a mix, and a query already running finishes on the files it started with. */
async function createView(subset: Subset, files: string[]): Promise<Set<string>> {
  const quoted = viewName(subset);
  return withConnection(async (conn) => {
    await conn.run(`CREATE OR REPLACE VIEW ${quoted} AS SELECT * FROM read_parquet(${parquetList(files)})`);
    const reader = await conn.runAndReadAll(
      `SELECT column_name FROM (DESCRIBE SELECT * FROM ${quoted} LIMIT 0)`,
    );
    return new Set<string>(reader.getRowsJS().map((r) => String(r[0])));
  });
}

function maybeRefresh(subset: Subset): void {
  const state = _views.get(subset);
  const interval = config.refreshIntervalMs;
  if (!state || state.refresh || config.offline || interval <= 0) return;
  if (Date.now() - state.checkedAt < interval) return;
  state.refresh = refreshView(subset, state).finally(() => {
    state.checkedAt = Date.now();
    state.refresh = undefined;
  });
}

/**
 * Re-check a loaded subset against the Hub and, if a newer revision was
 * downloaded, swap the view over to it. ensureSubset gives new revisions new
 * file names, so the files the old view reads are untouched until pruneSubset
 * runs after the swap. Any failure keeps the data already loaded: a refresh
 * must never cost the server a subset it was serving.
 */
async function refreshView(subset: Subset, state: ViewState): Promise<void> {
  try {
    const { files, downloaded } = await ensureSubset(subset);
    const changed =
      downloaded || files.length !== state.files.length || files.some((file, i) => file !== state.files[i]);
    if (changed) {
      const schema = await createView(subset, files);
      _schemas.set(subset, Promise.resolve(schema));
      state.files = files;
      state.generation += 1;
      console.error(`[iwac] ${subset}: switched to the newer dataset revision`);
    }
    await pruneSubset(subset, state.files);
  } catch (err) {
    console.error(
      `[iwac] warning: could not refresh ${subset}; still serving the data loaded earlier. ${(err as Error).message}`,
    );
  }
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
 * The only value types this server ever binds as SQL parameters. Typing the
 * boundary this narrowly (instead of `unknown[]` + a cast) makes accidentally
 * pushing a non-primitive (e.g. a ResolvedLimit object) a compile error at the
 * push site rather than a runtime DuckDB error.
 */
export type Bindable = string | number | boolean | null;

/**
 * Run a SQL query with positional parameters and return plain JS objects.
 * DuckDB's `runAndReadAll` accepts a DuckDBValue[] for bindings; primitive
 * JS values (string, number, boolean, null) are accepted directly.
 */
export async function query(sql: string, params: Bindable[] = []): Promise<Row[]> {
  return withConnection(
    async (conn) => (await conn.runAndReadAll(sql, params as DuckDBValue[])).getRowObjectsJS() as Row[],
  );
}

export async function queryOne(
  sql: string,
  params: Bindable[] = [],
): Promise<Row | null> {
  const rows = await query(sql, params);
  return rows[0] ?? null;
}

/**
 * Run a query and return a single scalar column as a flat array.
 */
export async function queryScalar<T = unknown>(
  sql: string,
  params: Bindable[] = [],
): Promise<T[]> {
  const rows = await withConnection(
    async (conn) => (await conn.runAndReadAll(sql, params as DuckDBValue[])).getRowsJS() as unknown[][],
  );
  return rows.map((r) => r[0] as T);
}

export async function queryScalarSingle<T = unknown>(
  sql: string,
  params: Bindable[] = [],
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
  extraParams: Bindable[] = [],
): Promise<Row[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const where = [`CAST("o:id" AS VARCHAR) IN (${placeholders})`, ...extraWhere];
  return query(
    `SELECT ${cols} FROM ${viewName(subset)} WHERE ${where.join(" AND ")}`,
    [...ids.map((v) => String(v)), ...extraParams],
  );
}
