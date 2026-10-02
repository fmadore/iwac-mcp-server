import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { config, type Subset } from "../src/config.js";
import { withCacheLock } from "../src/cacheLock.js";
import {
  ensureView,
  pendingRefresh,
  query,
  viewGeneration,
} from "../src/db.js";
import { semanticSearch } from "../src/embeddings.js";
import {
  requestSignal,
  requestSnapshots,
  runSharedWork,
  stopSharedWork,
  waitForSharedWork,
  withRequest,
} from "../src/request.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

async function fixture(
  directory: string,
  sql = 'SELECT 1 AS "o:id"',
): Promise<Buffer> {
  const file = path.join(directory, "source.parquet");
  await query(
    `COPY (${sql}) TO '${file.replaceAll("\\", "/").replaceAll("'", "''")}' (FORMAT parquet)`,
  );
  return fs.readFile(file);
}
function tree(subset: Subset, bytes: Buffer): Response {
  return Response.json([
    {
      type: "file",
      path: `${subset}/train.parquet`,
      size: bytes.length,
      lfs: { oid: sha256(bytes) },
    },
  ]);
}
async function provenance(subset: Subset) {
  return withRequest(undefined, async () => {
    await ensureView(subset);
    const snapshot = requestSnapshots()?.get(subset);
    assert.ok(snapshot);
    return snapshot.provenance;
  });
}

test("cancelling the first cold-load waiter leaves the shared download available to another caller", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "iwac-shared-cold-"),
  );
  const original = { ...config },
    originalFetch = globalThis.fetch;
  const downloadStarted = deferred(),
    releaseDownload = deferred();
  let signal: AbortSignal | undefined,
    downloads = 0;
  try {
    const bytes = await fixture(directory);
    Object.assign(config, {
      cacheDir: directory,
      offline: false,
      privateDataset: false,
      refreshIntervalMs: 0,
    });
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes("/api/datasets/"))
        return tree("articles", bytes);
      downloads++;
      signal = init?.signal ?? undefined;
      downloadStarted.resolve();
      await releaseDownload.promise;
      signal?.throwIfAborted();
      return new Response(new Uint8Array(bytes));
    }) as typeof fetch;
    const owner = new AbortController(),
      other = new AbortController();
    const first = withRequest(owner.signal, () => ensureView("articles"));
    const rejected = assert.rejects(first, /first waiter cancelled/);
    await downloadStarted.promise;
    const second = withRequest(other.signal, () => ensureView("articles"));
    owner.abort(new Error("first waiter cancelled"));
    await rejected;
    assert.equal(signal?.aborted, false);
    assert.equal(other.signal.aborted, false);
    releaseDownload.resolve();
    assert.ok((await second).has("o:id"));
    assert.equal(downloads, 1);
    assert.ok((await ensureView("articles")).has("o:id"));
  } finally {
    releaseDownload.resolve();
    Object.assign(config, original);
    globalThis.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("background refresh survives its caller and updates freshness without changing the pinned generation", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "iwac-shared-refresh-"),
  );
  const original = { ...config },
    originalFetch = globalThis.fetch;
  const refreshStarted = deferred(),
    releaseRefresh = deferred();
  let mode: "ready" | "failed" | "slow" = "ready",
    signal: AbortSignal | undefined;
  try {
    const bytes = await fixture(directory);
    Object.assign(config, {
      cacheDir: directory,
      offline: false,
      privateDataset: false,
      refreshIntervalMs: 0,
    });
    globalThis.fetch = (async (input, init) => {
      if (mode === "failed") throw new Error("mock Hub unavailable");
      if (String(input).includes("/api/datasets/")) {
        if (mode === "slow") {
          signal = init?.signal ?? undefined;
          refreshStarted.resolve();
          await releaseRefresh.promise;
          signal?.throwIfAborted();
        }
        return tree("publications", bytes);
      }
      return new Response(new Uint8Array(bytes));
    }) as typeof fetch;
    const initial = await provenance("publications");
    assert.equal(initial.freshness, "verified against Hub file identities");
    mode = "failed";
    await new Promise((resolve) => setTimeout(resolve, 5));
    config.refreshIntervalMs = 1;
    await ensureView("publications");
    await pendingRefresh("publications");
    config.refreshIntervalMs = 0;
    const failed = await provenance("publications");
    assert.equal(failed.freshness, "cached; refresh failed");
    assert.equal(failed.last_verified_at, initial.last_verified_at);
    assert.equal(
      initial.freshness,
      "verified against Hub file identities",
      "pinned provenance is immutable",
    );
    assert.equal(viewGeneration("publications"), 1);

    mode = "slow";
    await new Promise((resolve) => setTimeout(resolve, 5));
    config.refreshIntervalMs = 1;
    const owner = new AbortController();
    await withRequest(owner.signal, () => ensureView("publications"));
    await refreshStarted.promise;
    owner.abort();
    assert.equal(signal?.aborted, false);
    releaseRefresh.resolve();
    await pendingRefresh("publications");
    config.refreshIntervalMs = 0;
    const recovered = await provenance("publications");
    assert.equal(recovered.freshness, "verified against Hub file identities");
    assert.notEqual(recovered.last_verified_at, initial.last_verified_at);
    assert.equal(recovered.loaded_at, initial.loaded_at);
    assert.equal(failed.freshness, "cached; refresh failed");
    assert.equal(viewGeneration("publications"), 1);
  } finally {
    releaseRefresh.resolve();
    await pendingRefresh("publications");
    Object.assign(config, original);
    globalThis.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("identical concurrent embeddings share one provider call while cancellation and failed retries stay isolated", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "iwac-shared-embedding-"),
  );
  const original = { ...config },
    originalFetch = globalThis.fetch;
  const oldContract = process.env.IWAC_EMBEDDING_CONTRACT_FILE;
  const providerStarted = deferred(),
    releaseProvider = deferred();
  let calls = 0,
    fail = false,
    signal: AbortSignal | undefined;
  try {
    const bytes = await fixture(
      directory,
      'SELECT 1 AS "o:id", [1.0, 0.0] AS embedding_image',
    );
    await fs.mkdir(path.join(directory, "images"));
    await fs.writeFile(path.join(directory, "images", "train.parquet"), bytes);
    const revision = "1".repeat(40),
      contract = path.join(directory, "contract.json");
    await fs.writeFile(
      contract,
      JSON.stringify({
        model: "test-model",
        revision: "test-v1",
        dimension: 2,
        normalization: "unit-l2",
        dataset_revision: revision,
        fields: { images: "embedding_image" },
        query_prefix: "query: ",
      }),
    );
    process.env.IWAC_EMBEDDING_CONTRACT_FILE = contract;
    Object.assign(config, {
      cacheDir: directory,
      offline: true,
      refreshIntervalMs: 0,
      semanticSearchEnabled: true,
      embeddingProvider: "local",
      embeddingModel: "test-model",
      embeddingDimensionality: 2,
      datasetRevision: revision,
      localEmbeddingUrl: "http://127.0.0.1:8080/v1/embeddings",
    });
    globalThis.fetch = (async (_input, init) => {
      calls++;
      signal = init?.signal ?? undefined;
      providerStarted.resolve();
      await releaseProvider.promise;
      signal?.throwIfAborted();
      return fail
        ? new Response(null, { status: 429 })
        : Response.json({ data: [{ embedding: [1, 0] }] });
    }) as typeof fetch;
    const search = (text: string) =>
      semanticSearch({
        subset: "images",
        embeddingColumn: "embedding_image",
        query: text,
        limit: 1,
      });
    const owner = new AbortController();
    const first = withRequest(owner.signal, () => search("shared"));
    const rejected = assert.rejects(first, /cancelled/);
    await providerStarted.promise;
    const second = withRequest(undefined, () => search("shared"));
    owner.abort(new Error("cancelled"));
    await rejected;
    assert.equal(signal?.aborted, false);
    releaseProvider.resolve();
    assert.deepEqual(await second, [{ id: "1", score: 1 }]);
    assert.equal(calls, 1);
    await withRequest(undefined, () => search("shared"));
    assert.equal(calls, 1, "completed vectors are cached");
    fail = true;
    await assert.rejects(
      withRequest(undefined, () => search("retry")),
      /HTTP 429/,
    );
    fail = false;
    assert.deepEqual(await withRequest(undefined, () => search("retry")), [
      { id: "1", score: 1 },
    ]);
    assert.equal(
      calls,
      3,
      "a failed embedding does not poison the single-flight cache",
    );
  } finally {
    releaseProvider.resolve();
    if (oldContract === undefined)
      delete process.env.IWAC_EMBEDDING_CONTRACT_FILE;
    else process.env.IWAC_EMBEDDING_CONTRACT_FILE = oldContract;
    Object.assign(config, original);
    globalThis.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// Keep shutdown last: it ends the process-wide shared-work lifecycle.
test("shutdown cancels detached work and waits for cache-lock cleanup", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "iwac-shared-shutdown-"));
  const started = deferred();
  const job = runSharedWork(() => withCacheLock(directory, () =>
      new Promise<void>((_resolve, reject) => {
        const signal = requestSignal();
        assert.ok(signal);
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        started.resolve();
      }),
  ));
  const rejected = assert.rejects(waitForSharedWork(job), {
    name: "AbortError",
  });
  try {
    await started.promise;
    await stopSharedWork();
    await rejected;
    assert.deepEqual(await fs.readdir(directory), []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
