import { requestProgress, requestSignal, requestSnapshots, runSharedWork, waitForDataset, WorkQueue } from "./request.js";
import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from "@duckdb/node-api";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ensureSubset, onSubsetDownload, parquetList } from "./hf.js";
import { config, type Subset } from "./config.js";

let _instancePromise: Promise<DuckDBInstance> | null = null;
const _schemas: Map<Subset, Promise<Set<string>>> = new Map();

/** What a loaded subset's view reads, and when that was last checked. */
interface ViewState {
  files: string[];
  schema: Set<string>;
  provenance: Record<string, unknown>;
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
    _instancePromise = openSandboxed();
    // If the very first open fails, drop the cached promise so a later call can retry.
    _instancePromise.catch(() => {
      _instancePromise = null;
    });
  }
  return _instancePromise;
}

/** A SQL string literal. SET cannot take bound parameters. */
const sqlString = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** Where DuckDB spills when a query outgrows memory_limit. Its default is
 * `.tmp` under the working directory, which in the Docker image is root-owned
 * and read-only to the `node` user; /cache is the one writable volume there
 * (and /tmp a 128 MB tmpfs, too small to spill into). */
export function duckdbTempDir(): string {
  return path.join(config.cacheDir, "duckdb-tmp");
}

/** Directories beyond the cache and spill dirs; empty unless a test asked. */
let extraAllowedDirectories: readonly string[] = [];

/**
 * Test hook, not configuration: also allow `dirs` in the sandbox of the
 * instance this process has yet to open. In-process tests (hf-cache,
 * shared-work and the like) write parquet under several mkdtemp() dirs and
 * repoint config.cacheDir after the instance exists, which the locked sandbox
 * cannot follow; they call this with os.tmpdir() before their first query.
 * The server never calls it, and there is deliberately no environment
 * variable behind it, so a desktop install cannot be talked into exposing the
 * user's temp directory. Throws once the instance exists: the sandbox is
 * locked by then and a late call would silently do nothing.
 */
export function allowDirectoriesForTests(dirs: readonly string[]): void {
  if (_instancePromise) throw new Error("allowDirectoriesForTests must run before the first DuckDB query");
  extraAllowedDirectories = [...dirs];
}

/**
 * The statements that sandbox a fresh instance, in order. Every file this
 * server hands DuckDB is a parquet under the dataset cache (hf.ts ensureSubset;
 * IWAC_OFFLINE fixtures are found the same way, through IWAC_CACHE_DIR), and
 * nothing else touches the file system: withScope's id tables are in-memory,
 * and no COPY, EXPORT, ATTACH or INSTALL runs in the server. So external
 * access is turned off and only the cache dir and the spill dir inside it stay
 * reachable (plus `extraDirs`, which only tests pass, through
 * allowDirectoriesForTests). Autoloading is off so a query cannot pull an
 * extension (httpfs) that would reach the network, and the lock goes LAST so
 * no statement, whichever connection runs it, can loosen any of this later.
 *
 * Defence in depth: every user value is bound as a parameter, but a future
 * SQL-building bug should not be able to read /run/secrets, ~/.ssh or the
 * rest of the user's temp directory.
 */
export function sandboxStatements(
  cacheDir: string,
  tempDir: string,
  limits: { memoryLimit?: string; threads?: number } = {},
  extraDirs: readonly string[] = [],
): string[] {
  const allowed = [...new Set([cacheDir, tempDir, ...extraDirs].map((dir) => path.resolve(dir)))];
  return [
    `SET GLOBAL allowed_directories = [${allowed.map(sqlString).join(", ")}]`,
    `SET GLOBAL temp_directory = ${sqlString(path.resolve(tempDir))}`,
    // Both values are validated in config.ts (a strict pattern, a positive int).
    ...(limits.memoryLimit ? [`SET GLOBAL memory_limit = ${sqlString(limits.memoryLimit)}`] : []),
    ...(limits.threads ? [`SET GLOBAL threads = ${limits.threads}`] : []),
    "SET GLOBAL enable_external_access = false",
    "SET GLOBAL autoinstall_known_extensions = false",
    "SET GLOBAL autoload_known_extensions = false",
    "SET GLOBAL lock_configuration = true",
  ];
}

/** Create the shared instance and lock it down before any caller gets a
 * connection. Runs inside the memoized promise, so racing first callers all
 * wait for the same, already sandboxed, instance. */
async function openSandboxed(): Promise<DuckDBInstance> {
  if (config.invalidDuckdbMemoryLimit)
    console.error(
      `[iwac] warning: ignoring IWAC_DUCKDB_MEMORY_LIMIT=${config.invalidDuckdbMemoryLimit}; ` +
        "expected a size such as 1GB or 512MiB. DuckDB keeps its default.",
    );
  const tempDir = duckdbTempDir();
  // DuckDB creates the spill directory itself on the first spill (checked on
  // 2.0.0, sandbox on), but not its parent. Creating only the parent keeps an
  // unused `duckdb-tmp` out of caches that never spill, the test fixtures
  // among them, whose scripts treat every subdirectory as a subset. Best
  // effort: a read-only pre-seeded cache still answers every query that fits
  // in memory.
  await fs.mkdir(path.dirname(tempDir), { recursive: true }).catch((err: Error) => {
    console.error(`[iwac] warning: cannot create the DuckDB spill directory's parent for ${tempDir}: ${err.message}`);
  });
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  try {
    for (const statement of sandboxStatements(
      config.cacheDir,
      tempDir,
      { memoryLimit: config.duckdbMemoryLimit, threads: config.duckdbThreads },
      extraAllowedDirectories,
    ))
      await conn.run(statement);
  } catch (err) {
    // Never hand out a half-configured instance: the memoized promise
    // rejects, and the next caller retries from scratch.
    conn.closeSync();
    instance.closeSync();
    throw err;
  }
  conn.closeSync();
  return instance;
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
  const signal = requestSignal();
  const release = await queryQueue.acquire(signal);
  try {
    const conn = _idle.pop() ?? (await (await getInstance()).connect());
    // DuckDB clears a pending interrupt when a statement starts executing, so
    // one that lands while the statement is still being prepared or waiting
    // for a worker thread is dropped and the scan runs to completion (an abort
    // 0 ms after issue was lost every time; at 10 ms it usually landed). Keep
    // interrupting until fn settles; the timer is cleared before the
    // connection goes back to the pool, so it never reaches another caller.
    let reinterrupt: NodeJS.Timeout | undefined;
    const abort = () => {
      conn.interrupt();
      reinterrupt ??= setInterval(() => conn.interrupt(), 20);
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      return await fn(conn);
    } finally {
      signal?.removeEventListener("abort", abort);
      clearInterval(reinterrupt);
      if (_idle.length < MAX_IDLE_CONNECTIONS) _idle.push(conn);
      else conn.closeSync();
    }
  } finally {
    release();
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
const queryQueue = new WorkQueue(MAX_ACTIVE_QUERIES, 128);
export const activeQueries = (): number => queryQueue.active;
export const queuedQueries = (): number => queryQueue.queued;

/**
 * Safe SQL name for a subset's view. `index` and `references` are reserved words
 * in DuckDB, so they must be double-quoted; the rest are bare identifiers.
 * Single source of truth — used both when creating the view and when querying it.
 */
export function viewName(subset: Subset): string {
  const pinned = requestSnapshots()?.get(subset);
  if (pinned) return `read_parquet(${parquetList(pinned.files)})`;
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
export async function ensureView(subset: Subset): Promise<Set<string>> {
  const pinned = requestSnapshots()?.get(subset);
  if (pinned) return pinned.schema;
  let p = _schemas.get(subset);
  if (!p) {
    const build = runSharedWork(() => buildView(subset));
    build.catch(() => {
      if (_schemas.get(subset) === build) _schemas.delete(subset); // allow retry after a failed download
    });
    _schemas.set(subset, build);
    p = build;
  } else {
    maybeRefresh(subset);
  }
  // A caller that asked for progress hears about the download it is waiting
  // on, whichever call started it. The listener goes with this wait.
  const progress = requestProgress();
  const unsubscribe = progress
    ? onSubsetDownload(subset, (done, total) => progress(subset, done, total))
    : undefined;
  let loadedSchema: Set<string>;
  try {
    loadedSchema = await waitForDataset(subset, p);
  } finally {
    unsubscribe?.();
  }
  const state = _views.get(subset);
  // A refresh may finish while this waiter resumes. Keep schema and files
  // from the same committed generation.
  const schema = state?.schema ?? loadedSchema;
  if (state && !requestSnapshots()?.has(subset))
    requestSnapshots()?.set(subset, {
      files: [...state.files],
      generation: state.generation,
      schema,
      provenance: state.provenance,
    });
  return schema;
}

/** How many times this subset's view has been rebuilt over new files (0 before
 * it first loads). A cache built from the view's rows is stale once this moves. */
export function viewGeneration(subset: Subset): number {
  return requestSnapshots()?.get(subset)?.generation ?? _views.get(subset)?.generation ?? 0;
}

/** The background refresh in flight for a subset, if any. For tests. */
export function pendingRefresh(subset: Subset): Promise<void> | undefined {
  return _views.get(subset)?.refresh;
}

async function buildView(subset: Subset): Promise<Set<string>> {
  const { files, provenance } = await ensureSubset(subset);
  const schema = await createView(subset, files);
  _views.set(subset, { files, schema, provenance, checkedAt: Date.now(), generation: 1 });
  return schema;
}

/** Point the subset's view at exactly `files` and return its columns. One
 * CREATE OR REPLACE, so a query sees the old file list or the new one, never
 * a mix, and a query already running finishes on the files it started with. */
async function createView(subset: Subset, files: string[]): Promise<Set<string>> {
  const quoted = q(subset);
  return withConnection(async (conn) => {
    await conn.run(`CREATE OR REPLACE VIEW ${quoted} AS SELECT * FROM read_parquet(${parquetList(files)})`);
    const reader = await conn.runAndReadAll(`SELECT column_name FROM (DESCRIBE SELECT * FROM ${quoted} LIMIT 0)`);
    return new Set<string>(reader.getRowsJS().map((r) => String(r[0])));
  });
}

function maybeRefresh(subset: Subset): void {
  const state = _views.get(subset);
  const interval = config.refreshIntervalMs;
  if (!state || state.refresh || config.offline || interval <= 0) return;
  if (Date.now() - state.checkedAt < interval) return;
  state.refresh = runSharedWork(() => refreshView(subset, state))
    // A shutdown can reject the shared job before refreshView begins.
    .catch((err) => recordRefreshFailure(subset, state, err))
    .finally(() => {
      state.checkedAt = Date.now();
      state.refresh = undefined;
    });
}

/**
 * Re-check a loaded subset against the Hub and, if a newer revision was
 * downloaded, swap the view over to it. ensureSubset gives new revisions new
 * file names, so the files the old view reads are untouched while any process or request might still use them. Any failure keeps the data already loaded: a refresh
 * must never cost the server a subset it was serving.
 */
async function refreshView(subset: Subset, state: ViewState): Promise<void> {
  try {
    const { files, downloaded, provenance } = await ensureSubset(subset);
    const changed =
      downloaded || files.length !== state.files.length || files.some((file, i) => file !== state.files[i]);
    if (changed) {
      const schema = await createView(subset, files);
      _schemas.set(subset, Promise.resolve(schema));
      state.files = files;
      state.schema = schema;
      state.generation += 1;
      console.error(`[iwac] ${subset}: switched to the newer dataset revision`);
    }
    // Verification changes even when the corpus does not. Replace the object
    // so already-pinned requests retain their original provenance.
    state.provenance = {
      ...(!changed ? state.provenance : {}),
      ...provenance,
      ...(!changed ? { loaded_at: state.provenance.loaded_at } : {}),
    };
  } catch (err) {
    recordRefreshFailure(subset, state, err);
  }
}

function recordRefreshFailure(subset: Subset, state: ViewState, err: unknown): void {
  state.provenance = {
    ...state.provenance,
    freshness: "cached; refresh failed",
    last_checked_at: new Date().toISOString(),
  };
  console.error(
    `[iwac] warning: could not refresh ${subset}; still serving the data loaded earlier. ${String((err as Error)?.message ?? err)}`,
  );
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
export function selectList(schema: Set<string>, items: Array<string | [string, string, string[]?]>): string {
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

/**
 * Hand a large result to `onRows` one DuckDB data chunk (~2,048 rows) at a time,
 * yielding to the event loop after each. `query` converts a whole result to JS
 * in one synchronous call on the main thread: for the 16,668 article vectors
 * that alone held every other request for ~0.4 s.
 */
export async function queryInChunks(
  sql: string,
  params: Bindable[],
  onRows: (rows: Row[]) => void | Promise<void>,
): Promise<void> {
  await withConnection(async (conn) => {
    const result = await conn.stream(sql, params as DuckDBValue[]);
    for await (const rows of result.yieldRowObjectJs()) {
      await onRows(rows as Row[]);
      await yieldToEventLoop();
    }
  });
}

export async function queryOne(sql: string, params: Bindable[] = []): Promise<Row | null> {
  const rows = await query(sql, params);
  return rows[0] ?? null;
}

/**
 * Run a query and return a single scalar column as a flat array.
 */
export async function queryScalar<T = unknown>(sql: string, params: Bindable[] = []): Promise<T[]> {
  const rows = await withConnection(
    async (conn) => (await conn.runAndReadAll(sql, params as DuckDBValue[])).getRowsJS() as unknown[][],
  );
  return rows.map((r) => r[0] as T);
}

export async function queryScalarSingle<T = unknown>(sql: string, params: Bindable[] = []): Promise<T | null> {
  const values = await queryScalar<T>(sql, params);
  return values[0] ?? null;
}

/**
 * Canonical "fetch one row by o:id" lookup. Compares as VARCHAR so it works
 * whether the parquet stores `o:id` as an integer or a string. `cols` is a ready
 * SELECT list (e.g. from `selectList`, or `"*"`).
 */
export async function getById(subset: Subset, cols: string, id: string | number): Promise<Row | null> {
  return queryOne(`SELECT ${cols} FROM ${viewName(subset)} WHERE CAST("o:id" AS VARCHAR) = ?`, [String(id)]);
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
  return query(`SELECT ${cols} FROM ${viewName(subset)} WHERE ${where.join(" AND ")}`, [
    ...ids.map((v) => String(v)),
    ...extraParams,
  ]);
}
