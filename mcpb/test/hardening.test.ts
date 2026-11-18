// Hermetic checks for the server's hardening: the DuckDB sandbox, the
// first-run download versus the per-call deadline, and download progress.
// Runs under `npm run test:unit`; no network (fetch is replaced).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { config, parseAllowedOrigins, parseMemoryLimit } from "../src/config.js";
import { allowDirectoriesForTests, duckdbTempDir, ensureView, query, sandboxStatements } from "../src/db.js";
import { runSharedWork, waitForDataset, waitForSharedWork, withRequest } from "../src/request.js";
import { errorResult } from "../src/tools/_shared.js";
import { PROGRESS_INTERVAL_MS, progressReporter, wrapToolCallback } from "../src/tools/register.js";
import { at, must } from "./_must.js";

// The shared DuckDB instance is sandboxed to the cache dir it sees when it is
// first opened, so point the cache here before any query runs. This file
// deliberately does NOT call allowDirectoriesForTests: it checks the
// sandbox exactly as the server opens it.
const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "iwac-hardening-"));
const original = { ...config };
Object.assign(config, {
  cacheDir,
  datasetRepo: "example/iwac",
  datasetRevision: "main",
  offline: false,
  privateDataset: false,
  refreshIntervalMs: 0,
});
const originalFetch = globalThis.fetch;
after(async () => {
  Object.assign(config, original);
  globalThis.fetch = originalFetch;
  await fs.rm(cacheDir, { recursive: true, force: true });
});

const sqlPath = (p: string) => `'${p.replaceAll("\\", "/").replaceAll("'", "''")}'`;

/** One small parquet file's bytes, written and read back inside the sandbox. */
async function parquetBytes(sql = `SELECT 1 AS "o:id", 'x' AS title`): Promise<Buffer> {
  const file = path.join(cacheDir, `fixture-${Math.random().toString(36).slice(2)}.parquet`);
  await query(`COPY (${sql}) TO ${sqlPath(file)} (FORMAT parquet)`);
  const bytes = await fs.readFile(file);
  await fs.rm(file);
  return bytes;
}

type Extra = Parameters<ReturnType<typeof wrapToolCallback>>[1];
const fakeExtra = (
  signal: AbortSignal,
  meta?: Record<string, unknown>,
  notify: (n: { params: Record<string, unknown> }) => unknown = async () => {},
): Extra =>
  ({ mcpReq: { signal, _meta: meta, notify } }) as unknown as Extra;
const payload = (result: unknown) =>
  JSON.parse(at((result as { content: { text: string }[] }).content, 0).text) as Record<string, unknown>;

describe("DuckDB sandbox", () => {
  it("reads parquet under the cache dir and refuses files outside it", async () => {
    const file = path.join(cacheDir, "inside.parquet");
    await query(`COPY (SELECT 42 AS answer) TO ${sqlPath(file)} (FORMAT parquet)`);
    // Both separators: hf.ts hands DuckDB forward slashes on Windows.
    assert.deepEqual(await query(`SELECT answer FROM read_parquet([${sqlPath(file)}])`), [{ answer: 42 }]);
    assert.deepEqual(await query(`SELECT answer FROM read_parquet('${file.replace(/'/g, "''")}')`), [{ answer: 42 }]);
    // A file of this repository: outside the cache and the temp dir. Without
    // the sandbox this read succeeds.
    const outside = path.resolve("package.json");
    await assert.rejects(query(`SELECT content FROM read_text(${sqlPath(outside)})`), /Permission Error/);
    await assert.rejects(query(`SELECT * FROM read_parquet(${sqlPath(path.join(cacheDir, "..", "..", "x.parquet"))})`), /Permission Error/);
  });

  it("does not open the OS temp dir by default, only the cache inside it", async () => {
    // A sibling of the cache under os.tmpdir(): readable while the sandbox
    // allowed the whole temp dir for the tests' sake, refused now that only
    // tests that ask (allowDirectoriesForTests) get it.
    const outside = path.join(os.tmpdir(), `iwac-outside-${process.pid}-${Date.now()}.csv`);
    await fs.writeFile(outside, "answer\n42\n");
    try {
      await assert.rejects(query(`SELECT * FROM read_csv(${sqlPath(outside)})`), /Permission Error/);
      await assert.rejects(query(`SELECT content FROM read_text(${sqlPath(outside)})`), /Permission Error/);
    } finally {
      await fs.rm(outside, { force: true });
    }
    const statements = sandboxStatements(cacheDir, duckdbTempDir());
    const allowed = must(statements.find((s) => s.startsWith("SET GLOBAL allowed_directories")), "allowed_directories");
    // Exactly the cache dir and the spill dir in it, as resolved, native paths.
    const literal = (p: string) => `'${path.resolve(p).replaceAll("'", "''")}'`;
    assert.equal(allowed, `SET GLOBAL allowed_directories = [${literal(cacheDir)}, ${literal(duckdbTempDir())}]`);
    assert.throws(() => allowDirectoriesForTests([os.tmpdir()]), /before the first DuckDB query/, "too late once the instance is open");
  });

  it("is locked, so no later statement can loosen it", async () => {
    await assert.rejects(query("SET enable_external_access = true"), /locked/);
    await assert.rejects(query("SET threads = 1"), /locked/);
    await assert.rejects(query("INSTALL httpfs"), /Permission Error|disabled/);
    const row = at(await query("SELECT current_setting('temp_directory') AS t"), 0);
    assert.equal(path.resolve(String(row.t)), path.resolve(duckdbTempDir()));
    // DuckDB creates it on the first spill; its parent must exist for that.
    assert.ok((await fs.stat(path.dirname(duckdbTempDir()))).isDirectory());
  });

  it("applies resource caps before the lock, and only validated values", () => {
    const statements = sandboxStatements(cacheDir, duckdbTempDir(), { memoryLimit: "1GB", threads: 2 });
    assert.equal(statements.at(-1), "SET GLOBAL lock_configuration = true");
    const lock = statements.length - 1;
    for (const needle of ["memory_limit = '1GB'", "threads = 2", "enable_external_access = false", "autoload_known_extensions = false"]) {
      const i = statements.findIndex((s) => s.includes(needle));
      assert.ok(i >= 0 && i < lock, `${needle} is set before the lock`);
    }
    assert.ok(!sandboxStatements(cacheDir, duckdbTempDir()).some((s) => /memory_limit|threads/.test(s)), "unset keeps DuckDB's defaults");
    for (const ok of ["1GB", "512MiB", "1.5GB", "2gb", "100000B"]) assert.equal(parseMemoryLimit(ok), ok);
    for (const bad of [undefined, "", "1", "1 GB", "80%", "1GB'; SET x=1; --", "-1GB", "1PB"]) assert.equal(parseMemoryLimit(bad), undefined);
  });
});

describe("IWAC_MCP_ALLOWED_ORIGINS wildcard", () => {
  it("accepts `*` only as the whole value", () => {
    assert.deepEqual(parseAllowedOrigins("*"), { allowed: new Set(), invalid: [], any: true });
    assert.deepEqual(parseAllowedOrigins(" * ").any, true);
    const mixed = parseAllowedOrigins("*, https://a.example");
    assert.equal(mixed.any, false);
    assert.deepEqual(mixed.invalid, ["*"]);
    assert.deepEqual(parseAllowedOrigins("https://*.example").invalid, ["https://*.example"]);
    assert.equal(parseAllowedOrigins("https://a.example").any, false);
  });
});

describe("a tool call that outlives its deadline", () => {
  it("says a first-run download is still going on, and the download finishes anyway", async () => {
    let release!: () => void;
    const download = runSharedWork(() => new Promise<string>((resolve) => (release = () => resolve("loaded"))));
    const handler = wrapToolCallback("t", async () => {
      await waitForDataset("articles", download);
      return { content: [] };
    }, { deadlineMs: 30 });
    // Before the mapping, this rejected with the bare abort reason, which the
    // SDK rendered as "The operation was aborted due to timeout".
    const result = await handler({}, fakeExtra(new AbortController().signal));
    assert.equal((result as { isError?: boolean }).isError, true);
    const body = payload(result);
    assert.equal(body.code, "unavailable");
    assert.match(String(body.error), /articles subset is still being downloaded in the background.*Retry/);
    assert.deepEqual(body.still_loading, ["articles"]);
    release();
    assert.equal(await download, "loaded");
  });

  it("maps a fan-out tool's own error result too, when a subset was still loading", async () => {
    const download = runSharedWork(() => new Promise<void>((resolve) => setTimeout(resolve, 300)));
    const handler = wrapToolCallback("t", async () => {
      // What search/get_collection_stats do: catch per subset, report an outage.
      try {
        await waitForDataset("images", download);
      } catch {
        /* degraded */
      }
      return errorResult({ error: "No IWAC subset could be loaded: Hugging Face could not be reached." });
    }, { deadlineMs: 30 });
    const body = payload(await handler({}, fakeExtra(new AbortController().signal)));
    assert.equal(body.code, "unavailable");
    assert.deepEqual(body.still_loading, ["images"]);
    await download;
  });

  it("calls a plain timeout a query timeout", async () => {
    const handler = wrapToolCallback("t", async () => {
      await waitForSharedWork(new Promise(() => {}));
      return { content: [] };
    }, { deadlineMs: 30 });
    const body = payload(await handler({}, fakeExtra(new AbortController().signal)));
    assert.equal(body.code, "invalid_argument");
    assert.match(String(body.error), /exceeded the .* time limit; narrow the selection/);
  });

  it("lets a client cancellation through as itself", async () => {
    const client = new AbortController();
    const handler = wrapToolCallback("t", async () => {
      await waitForSharedWork(new Promise(() => {}));
      return { content: [] };
    }, { deadlineMs: 5_000 });
    const pending = handler({}, fakeExtra(client.signal));
    client.abort(new Error("client cancelled"));
    await assert.rejects(pending, /client cancelled/);
  });

  it("keeps an error that already explains itself", async () => {
    const handler = wrapToolCallback("t", async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      throw new Error("The local query encoder is still being prepared. Retry in a minute.");
    }, { deadlineMs: 30 });
    await assert.rejects(handler({}, fakeExtra(new AbortController().signal)), /encoder is still being prepared/);
  });

  it("does it end to end: a slow subset download behind ensureView", async () => {
    const bytes = await parquetBytes();
    let releaseBody!: () => void;
    const bodyGate = new Promise<void>((resolve) => (releaseBody = resolve));
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).includes("/api/datasets/"))
        return Response.json([
          {
            type: "file",
            path: "documents/train.parquet",
            size: bytes.length,
            lfs: { oid: createHash("sha256").update(bytes).digest("hex") },
          },
        ]);
      await bodyGate;
      return new Response(new Uint8Array(bytes));
    }) as typeof fetch;
    try {
      const handler = wrapToolCallback("t", async () => {
        await ensureView("documents");
        return { content: [] };
      }, { deadlineMs: 50 });
      const body = payload(await handler({}, fakeExtra(new AbortController().signal)));
      assert.equal(body.code, "unavailable");
      assert.deepEqual(body.still_loading, ["documents"]);
      releaseBody();
      // The download was shared work: a later call finds it done.
      assert.ok((await withRequest(undefined, () => ensureView("documents"))).has("o:id"));
    } finally {
      releaseBody();
      globalThis.fetch = originalFetch;
    }
  });
});

describe("download progress", () => {
  it("reports a subset's bytes to a caller that sent a progress token", async () => {
    const bytes = await parquetBytes(`SELECT range AS "o:id", 'title ' || range AS title FROM range(5000)`);
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).includes("/api/datasets/"))
        return Response.json([
          {
            type: "file",
            path: "audiovisual/train.parquet",
            size: bytes.length,
            lfs: { oid: createHash("sha256").update(bytes).digest("hex") },
          },
        ]);
      // Several chunks, as a real download arrives.
      const chunks = [bytes.subarray(0, 100), bytes.subarray(100)];
      return new Response(new ReadableStream({ pull: (c) => (chunks.length ? c.enqueue(chunks.shift()) : c.close()) }));
    }) as typeof fetch;
    const seen: [string, number, number | undefined][] = [];
    try {
      await withRequest(undefined, () => ensureView("audiovisual"), {
        progress: (key, done, total) => seen.push([key, done, total]),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.ok(seen.length >= 2, "one report per chunk");
    assert.deepEqual(seen.at(-1), ["audiovisual", bytes.length, bytes.length]);
    // Loaded now: a second call downloads nothing and reports nothing.
    const again: unknown[] = [];
    await withRequest(undefined, () => ensureView("audiovisual"), { progress: (...a) => again.push(a) });
    assert.equal(again.length, 0);
  });

  it("sends throttled, increasing notifications that never throw", async () => {
    assert.equal(progressReporter(fakeExtra(new AbortController().signal)), undefined, "no token, no reporter");
    const sent: Record<string, unknown>[] = [];
    let clock = 0;
    const report = progressReporter(
      fakeExtra(new AbortController().signal, { progressToken: "tok" }, async (n: { params: Record<string, unknown> }) => {
        sent.push(n.params);
      }),
      () => clock,
    );
    assert.ok(report);
    report("articles", 10_000_000, 185_000_000);
    clock = PROGRESS_INTERVAL_MS / 2;
    report("articles", 20_000_000, 185_000_000); // throttled
    clock = PROGRESS_INTERVAL_MS + 1;
    report("index", 1_000_000, 5_000_000); // a second subset is summed in
    clock = 3 * PROGRESS_INTERVAL_MS;
    report("index", 1_000_000, 5_000_000); // no increase, not sent
    assert.equal(sent.length, 2);
    assert.deepEqual(
      sent.map((p) => [p.progressToken, p.progress, p.total]),
      [
        ["tok", 10_000_000, 185_000_000],
        ["tok", 21_000_000, 190_000_000],
      ],
    );
    assert.match(String(at(sent, 1).message), /articles, index.*21 of 190 MB/);

    let clock2 = 0;
    const throwing = progressReporter(
      fakeExtra(new AbortController().signal, { progressToken: 1 }, () => {
        throw new Error("stream closed");
      }),
      () => clock2,
    );
    const rejecting = progressReporter(
      fakeExtra(new AbortController().signal, { progressToken: 2 }, () => Promise.reject(new Error("stream closed"))),
      () => clock2,
    );
    assert.doesNotThrow(() => throwing?.("articles", 1, 2));
    assert.doesNotThrow(() => rejecting?.("articles", 1, 2));
    clock2 = 10 * PROGRESS_INTERVAL_MS;
    await new Promise((resolve) => setImmediate(resolve)); // an unhandled rejection would fail the run
  });
});
