import { test } from "node:test";
import assert from "node:assert/strict";
import { project2d } from "../src/pca.js";
import { WorkQueue, withRequest } from "../src/request.js";
import { normalizeDateBound, validateDateBounds, dateRangeFilter } from "../src/tools/shared/filters.js";
import { aggregateFilters } from "../src/tools/aggregates/shared.js";
import { narrowSelection, selectionFrom } from "../src/selection.js";
import { query, type Bindable } from "../src/db.js";
import { validateEmbeddingContract } from "../src/embeddingContract.js";
import { config } from "../src/config.js";

// Analytic covariance: x has the farthest point but only 50/550 of the variance.
test("PCA finds dominant axes even when the farthest row is orthogonal", () => {
  const vectors = [
    [5, 0, 0],
    [-5, 0, 0],
  ];
  for (let i = 0; i < 10; i++) vectors.push([0, 4, 0], [0, -4, 0], [0, 0, 3], [0, 0, -3]);
  const result = project2d(vectors);
  assert.ok(Math.abs(result.explained[0] - 320 / 550) < 1e-8);
  assert.ok(Math.abs(result.explained[1] - 180 / 550) < 1e-8);
  assert.deepEqual(result, project2d(vectors));
  assert.deepEqual(
    project2d([
      [2, 2],
      [2, 2],
    ]).explained,
    [0, 0],
  );
  const tied = project2d([
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]);
  for (const fraction of tied.explained) assert.ok(Math.abs(fraction - 0.5) < 1e-8);
  assert.ok(
    Math.abs(
      project2d([
        [1, 2],
        [2, 4],
        [3, 6],
      ]).explained[0] - 1,
    ) < 1e-8,
  );
});

test("date bounds reject complete malformed inputs and overlap partial stored dates", async () => {
  for (const date of ["2024-02-31", "2023-02-29", "2024-03-01garbage", "2024-03-01T25:00:00Z", "0000", "2024-00"])
    assert.ok(validateDateBounds(date).err, date);
  assert.equal(normalizeDateBound("2024-02", "to"), "2024-02-29");
  assert.equal(normalizeDateBound("1900-02", "to"), "1900-02-28");
  assert.equal(normalizeDateBound("2024-03-01T12:30:00+01:00", "from"), "2024-03-01");
  assert.ok(validateDateBounds("2025", "2024").err);
  const where: string[] = [],
    params: Bindable[] = [];
  dateRangeFilter(new Set(["pub_date"]), where, params, "1995-06-10", "1995-06-20");
  const rows = await query(
    `SELECT pub_date FROM (VALUES ('1995'),('1995-06'),('1995-06-15'),('1995-06-01'),('1994'),('1995-02-31')) t(pub_date) WHERE ${where.join(" AND ")}`,
    params,
  );
  assert.deepEqual(
    rows.map((r) => r.pub_date),
    ["1995", "1995-06", "1995-06-15"],
  );
});

test("selections intersect exact facets, preserve modes, and reject unsupported filters", async () => {
  const selected = narrowSelection(
    selectionFrom({
      country: "Benin",
      keyword: "mosquée ramadan",
      keyword_mode: "all_terms",
      date_from: "2000",
      exact: { spatial: ["Cotonou"] },
    }),
    "spatial",
    "Lomé",
  );
  assert.deepEqual(selected.exact?.spatial, ["Cotonou", "Lomé"]);
  const filter = aggregateFilters("articles", new Set(["title", "country", "pub_date", "spatial"]), selected);
  assert.equal(filter.err, undefined);
  assert.ok(filter.params.includes("Cotonou"));
  assert.ok(filter.params.includes("Lomé"));
  assert.ok(aggregateFilters("references", new Set(["title"]), { exact: { topic_id: ["3"] } }).err);
  assert.ok(
    aggregateFilters("articles", new Set(["title"]), {
      keyword: "x",
      keyword_mode: "all_terms",
      keyword_aliases: ["y"],
    }).err,
  );
});

test("work queues bound load, cancel waiters, and release capacity", async () => {
  const queue = new WorkQueue(1, 1, 25),
    release = await queue.acquire();
  const controller = new AbortController(),
    waiting = queue.acquire(controller.signal);
  await assert.rejects(queue.acquire(), /full/);
  controller.abort();
  await assert.rejects(waiting, /cancelled/);
  assert.equal(queue.queued, 0);
  release();
  assert.equal(queue.active, 0);
  const hold = await queue.acquire();
  await assert.rejects(queue.acquire(), /deadline/);
  hold();
  const done = await queue.acquire();
  done();
  done();
  assert.equal(queue.active, 0);
  await withRequest(AbortSignal.abort(), async () => {
    await assert.rejects(queue.acquire(AbortSignal.abort()));
  });
});

test("equal embedding dimensions cannot bypass model identity", () => {
  const contract = {
    model: "different-model",
    revision: "v1",
    dimension: config.embeddingDimensionality,
    normalization: "unit-l2" as const,
    dataset_revision: config.datasetRevision,
    fields: { articles: "embedding_OCR" },
    query_prefix: "",
  };
  assert.throws(() => validateEmbeddingContract(contract, "articles", "embedding_OCR"), /does not match/);
  assert.throws(
    () =>
      validateEmbeddingContract(
        { ...contract, model: config.embeddingModel, fields: { articles: "wrong-field" } },
        "articles",
        "embedding_OCR",
      ),
    /does not match/,
  );
});

test("request cancellation interrupts active DuckDB work and returns its connection", async () => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10);
  try {
    await assert.rejects(
      withRequest(controller.signal, () => query("SELECT sum(sin(i)) FROM range(1000000000) t(i)")),
      /interrupt|abort/i,
    );
    assert.equal(Number((await query("SELECT 1 AS n"))[0].n), 1);
  } finally {
    clearTimeout(timeout);
  }
});
